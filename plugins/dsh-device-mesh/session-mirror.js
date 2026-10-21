/**
 * dsh-device-mesh — 会话历史镜像（session history mirror）。
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────────────────
 * 会话跑在**会话端**（有 agent 的那台），工作树却可能在**执行端**（按路径路由
 * 执行命令的那台）。两边分开之后，执行端只有文件、没有「这些文件是怎么来的」，
 * 会话端只有历史、没有文件 —— 任何一边单独存在都不完整。
 *
 * 本模块把会话端每条会话的**完整事件历史**实时推到执行端。执行端**只落盘存储**：
 * 不创建会话、不跑 agent、不把镜像写进自己的 `workspaceRegistry` —— 所以执行端的
 * 会话列表不会被镜像污染（这一点是刻意的，见下「为什么不用 DSH 自己的 sessions/」）。
 *
 * ── 执行端能看见什么（进度 + 接管 + 自动同步）────────────────────────────────
 * 只落盘不显示会让执行端变成瞎子：会话在别处跑，这台机器上什么也看不到。所以镜像
 * 额外承担三件事，**都不改变上面的边界**（镜像自己仍然不是会话）：
 *   · **进度**：索引里多记会话头与「最近一条有信息量的事件」摘要，由 host 的
 *     `/replica-progress` 只读下发 —— 执行端因此能显示「第 3 轮 / 调用工具 bash /
 *     12 秒前」这类实时进度，而会话列表里依旧没有这条会话（它还不是本机的会话）。
 *   · **同步**：索引里记「本机的上下文落到哪了」（`syncedAt/syncedSeq`）。每收一批
 *     带 `turn/end` 的镜像事件，host 的同步工人就把这份历史重压落地到本机
 *     `sessions/`（`buildSessionLogBytes`）—— 于是**每次运行结束，控制端的上下文都
 *     留在执行端本地**，本机离线时它还在，要接手时不用等对端。这一段是 host 的动作，
 *     本模块只负责把 `syncWanted` 信号与结果字段带出去。
 *   · **接管**：用户显式点击时把镜像（或对端在线时的原字节）落进本机 `sessions/`，
 *     覆盖前先备份。落盘之后它才成为本机会话：可打开、可续跑、命令在本机执行。
 *
 * ── 为什么落在网格数据目录，而不是 DSH 的 sessions/ ─────────────────────────
 * 写进 `$DSH_HOME/sessions/` 会让执行端把它们当成**自己的会话**：出现在侧边栏、
 * 被 sessionQuery 统计、被 workspace 账目认领。那是一种「看起来像会话、其实没有
 * agent、也没人维护」的假状态。所以镜像写在
 * `$DSH_HOME/device-mesh/session-replica/<源设备>/` 下，由本插件自己管索引；
 * 要拿它做恢复/导入是显式动作，不是副作用。
 *
 * ── 协议（一跳，签名与 /api/exec 同源）──────────────────────────────────────
 *   POST /dsh-device-mesh/api/session-mirror
 *   { sessionId, workspacePath, workspaceTitle, header, events[], fromSeq, toSeq, reset? }
 *   · `reset: true` 是该会话镜像的**第一批**（接收端清空重写）；
 *   · 之后都是追加批；seq 单调由发送端保证，接收端只 append、不重排、不去重。
 *   门与 exec/fs 同源：必须 join 过 → 授权（allowRemoteExec + execTrust）→
 *   工作区路径必须是**接收端自己的**工作区路径（镜像只能落进自己的工作区）。
 *
 * ── 实时性从哪来 ────────────────────────────────────────────────────────────
 * 发送端 `ctx.on('session/event', …)`：每一次**已提交**的会话事件都会到达这里，
 * 所以推送的是实时流；每会话首次出现时先做一次**回填**（读本地
 * `session.v3/v4.jsonl.zstd`，zstd 解压后逐行取事件），保证镜像里的历史是完整的，
 * 而不是「从挂上这个功能那一刻开始」的半截。
 *
 * 游标（每会话已推 seq）落在 `<meshDir>/session-mirror.json`，重启不重复回填。
 *
 * @module dsh-device-mesh/session-mirror
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { randomHex } from './protocol.js?v=mesh-31'
import { STORE_SCHEMA, readJson, writeJsonAtomic } from './store.js?v=mesh-31'

/** 事件类型白名单：`a` 或 `a/b` 或 `a/b/c`，小写。 */
const EVENT_TYPE = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*$/
/** 设备 / 会话标识的合法字符（同时挡住路径穿越）。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/

/** 单条事件的序列化上限（大 assistant 消息实测可到 460 KB）。 */
export const MAX_EVENT_BYTES = 4 * 1024 * 1024
/** 单批推送的字节预算（入站 body 上限 16 MB，留一半余量）。 */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024

/**
 * 会话头（日志第一行的物理头）保留的字段。
 *
 * 头行是出厂格式的一部分，接管落地时必须原样写回去 —— 但**整份头对象**不进索引：
 * 索引是每轮 `/tree` 都要读的小文件，对端可控的巨串会变成每轮 IO。
 *
 * 这份名单就是出厂读取器 `isHeaderLine` 的**允许键全集**（`HEADER_KEYS`：
 * 必填 `type/version/id/createdAt/isSeeded/delegationDepth` + 可选
 * `cwd/parentSession/origin/agentPreset`）。多一个键（例如会话对象上常见的
 * `title`）就会被判成「第一行不是会话头」，整条会话打不开 —— 所以白名单不是
 * 「精简」，是**正确性**要求。
 */
const HEADER_FIELDS = ['type', 'version', 'id', 'createdAt', 'cwd', 'parentSession', 'origin', 'isSeeded', 'delegationDepth', 'agentPreset']
/** 摘要给人看的长度上限（侧边栏一行放得下）。 */
const MAX_SUMMARY = 160
/** 摘要在索引里的长度上限（比 UI 长一截，留给别的消费者）。 */
const MAX_INDEX_SUMMARY = 240

/**
 * 只有这些类型的事件会**更新**摘要。
 *
 * 为什么不是「最后一条事件」：`step/start`、`step/end` 这类高频事件会把摘要刷成
 * 「步骤结束」，看不出这条会话在干什么。噪声类型保留上一条有信息量的摘要。
 */
const SUMMARY_TYPES = new Set([
  'turn/start', 'turn/end', 'user/message', 'assistant/message',
  'tool/call', 'tool/result', 'command/run', 'command/done', 'session/title',
])

const text = (value, limit, fallback = '') => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed.slice(0, limit)
}

const int = (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null)

/** zstd 帧魔数（小端读出）。 */
const ZSTD_MAGIC = 4247762216

/**
 * 出厂日志行的顶层 `surfaceOp`：字符串 `'append'`，或替换语义的
 * `{op:'replace', startSeq, endSeq}`（实测本机一份日志里 2017 条 append、18 条 replace）。
 * 形状不对就返回 undefined（宁可不写，也不写一个出厂读不出来的值）。
 * @param {unknown} value 原始值。
 * @returns {string|object|undefined} 规整后的值。
 */
function shapeSurfaceOp(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.op === 'string') {
    const out = { op: value.op }
    for (const key of ['startSeq', 'endSeq']) {
      const number = int(value[key])
      if (number !== null) out[key] = number
    }
    return out
  }
  return undefined
}

/**
 * 扫描「独立 zstd 帧拼接容器」的帧边界。
 *
 * DSH 的 `session.v*.jsonl.zstd` **不是**一个 zstd 流，而是一串**各自独立、带校验**
 * 的帧（一次 append 一帧），所以 `zlib.zstdDecompressSync(整个文件)` 只会解出第一帧
 * —— 这正是本模块第一版回填只拿到一个事件的原因。这里按帧头 + 块头把边界走出来，
 * 与 `dsh-session-persistence-jsonl` 的 `scanZstdFrames` 同一套规则。
 *
 * 末尾不完整的帧（会话正在写）不算失败：返回已完整的帧即可。
 * @param {Buffer} buffer 文件字节。
 * @returns {{frames: {start: number, end: number}[], torn: boolean}} 帧范围与是否有残帧。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, torn: true }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, torn: true }
    offset += 4
    if (offset === buffer.length) return { frames, torn: true }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, torn: true }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, torn: true }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, torn: true }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, torn: true }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: true }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, torn: false }
}

/**
 * 解出整份日志的文本（逐帧解压再拼）。
 *
 * 单帧坏了只丢那一帧并计入 `problems`：读历史是尽力而为的事，不该因为文件尾巴上
 * 一帧写坏就让整条会话的历史读不出来。
 * @param {Buffer} buffer 文件字节。
 * @param {string[]} [problems] 问题收集器。
 * @returns {{text: string, frames: number, torn: boolean, failed: number}} 结果。
 */
export function decodeZstdLog(buffer, problems) {
  const { frames, torn } = scanZstdFrames(buffer)
  const parts = []
  let failed = 0
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    } catch (error) {
      failed += 1
      problems?.push(`session-mirror: 第 ${frames.indexOf(frame)} 帧解压失败：${String(error)}`)
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, torn, failed }
}

/**
 * 把一条会话事件裁成镜像里保存的形状。
 *
 * 留 `type / seq / time / data`：surface 元数据（转发给浏览器的展示字段）不在历史里，
 * 留着只会让镜像文件和「日志」的定义产生分歧。
 *
 * 但**出厂日志行自己的顶层字段要留**：`surfaceOp`（`replace` 与 `append` 是两种语义）
 * 与 `sourceEventSeqs`（分叉会话的继承前缀）都是日志的一部分 —— 裁掉它们，接管落地
 * 出来的历史就与原件不等价（实测本机一份 5263 行的日志里 2035 行带 surfaceOp、
 * 1020 行带 sourceEventSeqs）。这两个字段照实带上，其余顶层键照旧丢弃。
 * @param {unknown} event 原始事件。
 * @param {number} maxLineBytes 单条事件的序列化上限。
 * @returns {{ok: true, line: string, seq: number}|{ok: false, reason: string}} 结果。
 */
export function shapeEvent(event, maxLineBytes) {
  if (event === null || typeof event !== 'object') return { ok: false, reason: 'not-an-object' }
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === '' || type.length > 80 || !EVENT_TYPE.test(type)) return { ok: false, reason: `bad-type:${type.slice(0, 40)}` }
  const seq = int(event.seq)
  if (seq === null || seq < 0) return { ok: false, reason: 'bad-seq' }
  const time = int(event.time)
  const shaped = { seq, time: time ?? null, type, data: event.data ?? null }
  const surfaceOp = shapeSurfaceOp(event.surfaceOp)
  if (surfaceOp !== undefined) shaped.surfaceOp = surfaceOp
  if (Array.isArray(event.sourceEventSeqs)) {
    const seqs = event.sourceEventSeqs.map((value) => int(value)).filter((value) => value !== null && value >= 0)
    if (seqs.length === event.sourceEventSeqs.length && seqs.length > 0) shaped.sourceEventSeqs = seqs
  }
  let line
  try {
    line = JSON.stringify(shaped)
  } catch {
    return { ok: false, reason: 'unserializable' }
  }
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, line, seq }
}

/**
 * 会话头白名单化（见 `HEADER_FIELDS`）。
 * @param {unknown} value 原始头对象。
 * @returns {object|null} 只含白名单字段的头；没有可用字段时返回 null。
 */
export function sanitizeSessionHeader(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  for (const key of HEADER_FIELDS) {
    const raw = value[key]
    if (typeof raw === 'string') {
      const trimmed = text(raw, 1024)
      if (trimmed !== '') out[key] = trimmed
    } else if (typeof raw === 'boolean' || (typeof raw === 'number' && Number.isSafeInteger(raw))) {
      out[key] = raw
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 从出厂消息的 content 块里取第一段人话。
 *
 * `assistant/message` 的 content 常常只有 reasoning 块（这一版没有正文），那时
 * 摘要说「推理中」比留空有用 —— 用户问的是「它在干什么」，不是「有没有正文」。
 * @param {unknown} content 内容块数组（也可能是字符串）。
 * @param {number} limit 长度上限。
 * @returns {{text: string, kind: 'text'|'reasoning'|''}} 摘取结果。
 */
function firstText(content, limit) {
  if (typeof content === 'string') return { text: text(content, limit), kind: 'text' }
  if (!Array.isArray(content)) return { text: '', kind: '' }
  let reasoning = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text !== 'string') continue
    if (block.type === 'text') return { text: text(block.text, limit), kind: 'text' }
    if (block.type === 'reasoning' && reasoning === '') reasoning = text(block.text, limit)
  }
  return reasoning === '' ? { text: '', kind: '' } : { text: reasoning, kind: 'reasoning' }
}

/**
 * 一条事件 → 进度摘要（只对 `SUMMARY_TYPES` 里的事件产出，其余返回 null）。
 *
 * 接收端只存 `{seq, time, type, data}`，没有 surface 元数据；摘要就从这几个字段里取。
 * 取不到人话时不编造：宁可让 UI 显示上一条摘要，也不显示「步骤结束」这种噪声。
 * @param {unknown} event 镜像事件。
 * @returns {{type: string, time: number|null, summary: string}|null} 摘要。
 */
export function summarizeEvent(event) {
  if (event === null || typeof event !== 'object') return null
  const type = typeof event.type === 'string' ? event.type : ''
  if (!SUMMARY_TYPES.has(type)) return null
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const message = data.message !== null && typeof data.message === 'object' ? data.message : null
  const turn = int(data.turn)
  let summary = ''
  switch (type) {
    case 'turn/start':
      summary = turn === null ? '新一轮开始' : `第 ${turn} 轮开始`
      break
    case 'turn/end': {
      const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : ''
      summary = kind === '' ? '本轮结束' : `本轮结束（${kind}）`
      break
    }
    case 'user/message': {
      const got = firstText(data.content, MAX_SUMMARY)
      summary = got.text === '' ? '收到用户消息' : `收到用户消息：${got.text}`
      break
    }
    case 'assistant/message': {
      const got = firstText(message?.content, MAX_SUMMARY)
      summary = got.text === '' ? '助手回复' : (got.kind === 'reasoning' ? `助手思考中：${got.text}` : `助手：${got.text}`)
      break
    }
    case 'tool/call': {
      const name = text(typeof data.name === 'string' ? data.name : '', 60)
      summary = name === '' ? '调用工具' : `调用工具 ${name}`
      break
    }
    case 'tool/result':
      summary = '工具返回'
      break
    case 'command/run': {
      const name = text(typeof data.name === 'string' ? data.name : '', 40)
      summary = name === '' ? '执行命令' : `执行命令 /${name}`
      break
    }
    case 'command/done':
      summary = '命令结束'
      break
    case 'session/title': {
      const title = text(typeof data.title === 'string' ? data.title : '', 80)
      summary = title === '' ? '' : `标题：${title}`
      break
    }
    default:
      summary = ''
  }
  if (summary === '') return null
  return { type, time: int(event.time), summary: summary.slice(0, MAX_INDEX_SUMMARY) }
}

/**
 * 从事件形状推断会话日志的格式世代。
 *
 * 为什么需要推断：镜像里的事件来自**对端当前那一代**日志（对端 0.2.0 读的是 v4），
 * 落地时的文件名与头行版本必须与事件形状一致 —— 把 v4 的事件写成 `session.v3.jsonl`
 * 会让出厂迁移器按 v3 解析，直接拒绝（`must not contain a released tool-result wrapper`
 * 之类的报错方向正好相反）。正常路径下版本来自对端随镜像送来的会话头（权威），
 * 这里只是**没有头时的兜底**，且两种标记同时出现（会话跨代）时返回 null 让人去查，
 * 不猜。
 * @param {object[]} events 事件列表。
 * @returns {4|3|null} 推断出的版本；判不出来返回 null。
 */
export function inferFormatVersion(events) {
  const list = Array.isArray(events) ? events : []
  let v4 = false
  let v3 = false
  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    const message = data.message !== null && typeof data.message === 'object' ? data.message : null
    // v4：工具结果已经是独立的 `role:"tool"` 消息（带 toolCallId）。
    if (message !== null && (message.role === 'tool' || typeof message.toolCallId === 'string')) v4 = true
    for (const content of [data.content, message?.content]) {
      if (!Array.isArray(content)) continue
      // v3：工具结果是**包装块** `{type:"tool-result"}`（v4 里已退休）。
      if (content.some((block) => block !== null && typeof block === 'object' && block.type === 'tool-result')) v3 = true
    }
  }
  if (v4 && !v3) return 4
  if (v3 && !v4) return 3
  return null
}

/**
 * 绝对路径判据（与出厂读取器的 `isAbsolute` 同义：POSIX 或盘符路径）。
 * @param {unknown} value 候选值。
 * @returns {boolean} 是否绝对路径。
 */
export function isAbsolutePath(value) {
  return typeof value === 'string' && (/^\/[^/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value))
}

/**
 * 把镜像事件拼成一份**出厂可读**的会话日志字节。
 *
 * 形状与 DSH 自己写的一致：第一行是物理头，其后每行一条事件；每一行压成一个**独立**
 * zstd 帧（DSH 一次 append 一帧，所以「多帧拼接」就是它的原生容器形状，尾帧写坏只丢
 * 那一行）。事件按 seq 升序去重，`seq` 不连续也照写 —— 出厂读取按行解析，不要求稠密。
 *
 * 头行按出厂读取器的契约补齐（必填字段缺了会被判成「第一行不是会话头」）：
 * `createdAt/isSeeded/delegationDepth` 给安全缺省，`cwd` 必须是绝对路径，`origin`
 * 只认 `subagent`。
 *
 * **分叉（isSeeded）会话照常落地**：曾经这里直接拒绝，理由是「出厂的种子头还要一个继承
 * 事件数才算完整，镜像里没有它」。那是把**写**路径（`toHeaderLine` 需要 cut 参数）当成了
 * **读**路径的约束 —— 实测（设备上拿一条真分叉会话的镜像喂出厂恢复器）带
 * `isSeeded: true` + `parentSession` 的头**出厂读取器照收**，那个「继承事件数」根本不在
 * 物理头里（`isHeaderLine` 的允许键集里没有它）。所以现在只保留 `parentSession`，
 * 不再拒绝。
 *
 * @param {object} header 会话头（至少要 `id` 与 `cwd`；`version` 缺省时按事件形状推断）。
 * @param {object[]} events 事件列表。
 * @returns {{ok: true, bytes: Buffer, version: number, lines: number}|{ok: false, reason: string}} 结果。
 */
export function buildSessionLogBytes(header, events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((event) => event !== null && typeof event === 'object' && int(event.seq) !== null)
    .sort((left, right) => int(left.seq) - int(right.seq))
  const version = int(header?.version) ?? inferFormatVersion(list)
  if (version !== 3 && version !== 4) return { ok: false, reason: 'unknown-format-version' }
  const head = { ...(sanitizeSessionHeader(header) ?? {}), type: 'session', version }
  if (typeof head.id !== 'string' || head.id === '') return { ok: false, reason: 'header-missing-id' }
  if (!isAbsolutePath(head.cwd)) return { ok: false, reason: 'header-missing-absolute-cwd' }
  if (typeof head.isSeeded !== 'boolean') head.isSeeded = false
  if (!Number.isSafeInteger(head.createdAt) || head.createdAt < 0) head.createdAt = 0
  if (!Number.isSafeInteger(head.delegationDepth) || head.delegationDepth < 0) head.delegationDepth = 0
  if (head.origin !== undefined && head.origin !== 'subagent') delete head.origin
  const rows = [head]
  let previous = null
  for (const event of list) {
    const seq = int(event.seq)
    if (previous !== null && seq <= previous) continue
    previous = seq
    const row = { type: event.type, seq, time: int(event.time), data: event.data ?? null }
    // 出厂日志行的顶层字段照原样写回（见 shapeEvent 的说明）。
    const surfaceOp = shapeSurfaceOp(event.surfaceOp)
    if (surfaceOp !== undefined) row.surfaceOp = surfaceOp
    if (Array.isArray(event.sourceEventSeqs)) row.sourceEventSeqs = event.sourceEventSeqs
    rows.push(row)
  }
  const frames = []
  let lines = 0
  for (const row of rows) {
    let encoded
    try {
      encoded = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, 'utf8'))
    } catch (error) {
      return { ok: false, reason: `zstd-encode-failed:${String(error)}` }
    }
    frames.push(encoded)
    lines += 1
  }
  return { ok: true, bytes: Buffer.concat(frames), version, lines }
}

/**
 * 执行端（接收端）的镜像存储。
 *
 * 只做三件事：白名单化、有界追加、索引。**不**读回来当会话用。
 */
export class SessionReplicaStore {
  /**
   * @param {string} meshDir 网格数据目录。
   * @param {string[]} problems 问题收集器。
   * @param {{maxSessionBytes?: number, maxEventBytes?: number, maxBatchEvents?: number}} [limits] 上限。
   */
  constructor(meshDir, problems, limits = {}) {
    this.root = path.join(meshDir, 'session-replica')
    this.problems = problems
    this.maxSessionBytes = limits.maxSessionBytes ?? 128 * 1024 * 1024
    this.maxEventBytes = limits.maxEventBytes ?? MAX_EVENT_BYTES
    this.maxBatchBytes = limits.maxBatchBytes ?? MAX_BATCH_BYTES
    this.maxBatchEvents = limits.maxBatchEvents ?? 512
    /** @type {Map<string, object>} `${deviceId}\u0000${sessionId}` → 索引项 */
    this.index = new Map()
    this.lastError = null
    this.received = 0
    this.dropped = 0
    this.#loadIndex()
  }

  #indexFile() {
    return path.join(this.root, 'index.json')
  }

  #loadIndex() {
    const stored = readJson(this.#indexFile(), null, this.problems)
    const rows = stored !== null && typeof stored === 'object' && Array.isArray(stored.sessions) ? stored.sessions : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const deviceId = text(row.deviceId, 160)
      const sessionId = text(row.sessionId, 160)
      if (deviceId === '' || sessionId === '' || !SAFE_ID.test(deviceId) || !SAFE_ID.test(sessionId)) continue
      this.index.set(`${deviceId}\u0000${sessionId}`, {
        deviceId,
        sessionId,
        cwd: text(row.cwd, 1024),
        title: text(row.title, 300),
        workspacePath: text(row.workspacePath, 1024),
        sourceDeviceName: text(row.sourceDeviceName, 120),
        firstSeq: int(row.firstSeq) ?? 0,
        lastSeq: int(row.lastSeq) ?? -1,
        events: int(row.events) ?? 0,
        bytes: int(row.bytes) ?? 0,
        truncated: row.truncated === true,
        dropped: int(row.dropped) ?? 0,
        createdAt: text(row.createdAt, 40) || null,
        updatedAt: text(row.updatedAt, 40) || null,
        // 进度与接管备料（旧索引没有这些字段 → null，由后续批自然补齐）。
        header: sanitizeSessionHeader(row.header),
        lastEventType: text(row.lastEventType, 80) || null,
        lastEventTime: int(row.lastEventTime),
        lastSummary: text(row.lastSummary, MAX_INDEX_SUMMARY) || null,
        // 同步状态（执行端把上下文落到本机会话目录的结果）。
        syncedAt: text(row.syncedAt, 40) || null,
        syncedSeq: int(row.syncedSeq),
        syncedBytes: int(row.syncedBytes) ?? 0,
        syncedVersion: text(row.syncedVersion, 8) || null,
        syncAttemptAt: text(row.syncAttemptAt, 40) || null,
        syncError: text(row.syncError, 300) || null,
        syncSkipped: text(row.syncSkipped, 120) || null,
      })
    }
  }

  #saveIndex() {
    const result = writeJsonAtomic(this.#indexFile(), {
      schema: STORE_SCHEMA,
      sessions: [...this.index.values()],
    })
    this.lastError = result.ok ? null : result.error
  }

  /** 会话镜像文件路径（同时把非法 id 挡在目录遍历之外）。 */
  fileFor(deviceId, sessionId) {
    if (!SAFE_ID.test(deviceId) || !SAFE_ID.test(sessionId)) return null
    return path.join(this.root, deviceId, `${sessionId}.jsonl`)
  }

  /**
   * 按会话 id 找一条镜像。
   *
   * 为什么两种写法都要认：`session-<uuid>` 与 `<uuid>` 在本项目的镜像目录里**同时存在**
   * （早期版本按去掉前缀的 id 命名文件，现在按出厂 id 命名）。判定与接管都从这里走，
   * 两代命名不会各查到一半。
   * @param {string} sessionId 会话 id（带或不带 `session-` 前缀）。
   * @returns {object|null} 索引项；没有返回 null。
   */
  find(sessionId) {
    const wanted = text(sessionId, 160)
    if (wanted === '') return null
    const bare = wanted.startsWith('session-') ? wanted.slice('session-'.length) : wanted
    for (const entry of this.index.values()) {
      if (entry.sessionId === wanted) return entry
      if (bare === '') continue
      const entryBare = entry.sessionId.startsWith('session-') ? entry.sessionId.slice('session-'.length) : entry.sessionId
      if (entryBare === bare) return entry
    }
    return null
  }

  /**
   * 读出某条镜像的**全部事件**（接管落地时用）。
   *
   * 镜像文件是明文 JSONL（每条 `{seq,time,type,data}`），不是 zstd —— 压缩发生在
   * 落地那一步（见 `buildSessionLogBytes`）。
   * @param {object} entry 索引项。
   * @returns {object[]} 事件列表（坏行跳过）。
   */
  readEvents(entry) {
    const file = this.fileFor(entry?.deviceId, entry?.sessionId)
    if (file === null || !fs.existsSync(file)) return []
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const events = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') events.push(parsed)
      } catch {
        // 坏行跳过：读历史是尽力而为的事，不该因为一行坏掉就整条读不出来。
      }
    }
    return events
  }

  /**
   * 每条镜像的**进度**（给执行端 UI 用）。
   *
   * `live` 是**镜像的**活跃判据：最近还在收到事件。会话静置（等用户输入）时它会转
   * false —— 「agent 是否正在跑」要看对端清单的 live，由 host 在路由里合并，不在这里猜。
   * @param {{now?: number, liveWindowMs?: number}} [options] 参数。
   * @returns {object[]} 按最近更新倒序的进度行。
   */
  progress(options = {}) {
    const now = Number(options.now) || Date.now()
    const liveWindowMs = Math.max(1000, Number(options.liveWindowMs) || 120000)
    const rows = []
    for (const entry of this.index.values()) {
      const updated = entry.updatedAt !== null ? Date.parse(entry.updatedAt) : Number.NaN
      const idleMs = Number.isFinite(updated) ? Math.max(0, now - updated) : null
      rows.push({
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
        sourceDeviceName: entry.sourceDeviceName,
        title: entry.title,
        cwd: entry.cwd,
        workspacePath: entry.workspacePath,
        firstSeq: entry.firstSeq,
        lastSeq: entry.lastSeq,
        events: entry.events,
        bytes: entry.bytes,
        truncated: entry.truncated === true,
        dropped: entry.dropped,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        idleMs,
        live: idleMs !== null && idleMs <= liveWindowMs,
        lastEventType: entry.lastEventType ?? null,
        lastEventTime: entry.lastEventTime ?? null,
        summary: entry.lastSummary ?? null,
        headerVersion: int(entry.header?.version),
        hasHeader: entry.header !== null && entry.header !== undefined,
        // 「本机的上下文」：最后一次同步的时间/追到第几条，以及这次的跳过原因或错误。
        // `synced` 的判据是「最后落盘的那份已经追平镜像的最后一条事件」——落后于镜像时
        // 本机那份仍是可用的历史，只是还没跟上最近一轮。
        syncedAt: entry.syncedAt ?? null,
        syncedSeq: entry.syncedSeq ?? null,
        syncedBytes: entry.syncedBytes ?? 0,
        syncedVersion: entry.syncedVersion ?? null,
        synced: entry.syncedSeq !== null && entry.syncedSeq >= entry.lastSeq,
        syncAttemptAt: entry.syncAttemptAt ?? null,
        syncError: entry.syncError ?? null,
        syncSkipped: entry.syncSkipped ?? null,
      })
    }
    rows.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    return rows
  }

  /**
   * 收一批镜像事件。
   *
   * @param {object} body 请求体（已通过门校验）。
   * @returns {{ok: true, stored: number, dropped: number, truncated: boolean, bytes: number, syncWanted: boolean, lastSeq: number}} 结果。
   */
  append(body) {
    const deviceId = text(body.deviceId, 160)
    const sessionId = text(body.sessionId, 160)
    if (!SAFE_ID.test(deviceId) || !SAFE_ID.test(sessionId)) throw new Error('非法设备/会话标识')
    const file = this.fileFor(deviceId, sessionId)
    const key = `${deviceId}\u0000${sessionId}`
    const incoming = Array.isArray(body.events) ? body.events : []
    if (incoming.length > this.maxBatchEvents) throw new Error(`单批事件数超过 ${this.maxBatchEvents}`)
    // 字节预算也必须查：单批 256 条 × 4 MB 的事件能撑爆入站 body 上限。
    const incomingBytes = (() => {
      try {
        return Buffer.byteLength(JSON.stringify(incoming), 'utf8')
      } catch {
        return 0
      }
    })()
    if (incomingBytes > this.maxBatchBytes) throw new Error(`单批字节数超过 ${this.maxBatchBytes}`)
    const reset = body.reset === true

    let entry = this.index.get(key)
    if (entry === undefined) {
      entry = {
        deviceId, sessionId,
        cwd: text(body.header?.cwd, 1024),
        title: text(body.header?.title, 300),
        workspacePath: text(body.workspacePath, 1024),
        sourceDeviceName: text(body.sourceDeviceName, 120),
        firstSeq: 0, lastSeq: -1, events: 0, bytes: 0,
        truncated: false, dropped: 0,
        createdAt: new Date().toISOString(), updatedAt: null,
        header: null, lastEventType: null, lastEventTime: null, lastSummary: null,
        syncedAt: null, syncedSeq: null, syncedBytes: 0, syncedVersion: null,
        syncAttemptAt: null, syncError: null, syncSkipped: null,
      }
      this.index.set(key, entry)
    }
    // 会话头随每一批都送（发送端从会话日志第一行读出）；收到就更新，收不到保留旧的。
    // 它决定接管落地时的文件名世代（`session.v<version>.jsonl.zstd`）与头行内容。
    const header = sanitizeSessionHeader(body.header)
    if (header !== null) entry.header = { ...(entry.header ?? {}), ...header }
    if (reset) {
      // 重来一次：清空文件与计数。回填会重新把完整历史推一遍，对账以发送端为准。
      fs.rmSync(file, { force: true })
      entry.firstSeq = 0
      entry.lastSeq = -1
      entry.events = 0
      entry.bytes = 0
      entry.truncated = false
      entry.dropped = 0
      entry.lastEventType = null
      entry.lastEventTime = null
      entry.lastSummary = null
    }
    if (entry.truncated) return { ok: true, stored: 0, dropped: incoming.length, truncated: true, bytes: entry.bytes }

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // 逐条按 seq 去重：追加批允许重复投递（网络重试、回填与实时重叠），而这条流
    // 是 append-only 且 seq 单调的 —— 凡是 `seq <= lastSeq` 的都已经在文件里了。
    const skipBelow = reset === true ? -1 : entry.lastSeq
    const lines = []
    // 被接受（不是重复、不是坏行）的原始事件留着算进度摘要：摘要是**给人看的**，
    // 要基于这一批真正落盘的内容，而不是发送端声称发过什么。
    const accepted = []
    let dropped = 0
    for (const raw of incoming) {
      const shaped = shapeEvent(raw, this.maxEventBytes)
      if (!shaped.ok) { dropped += 1; continue }
      if (shaped.seq <= skipBelow) continue
      lines.push(shaped.line)
      accepted.push(raw)
    }
    const payload = lines.length === 0 ? '' : `${lines.join('\n')}\n`
    const bytes = Buffer.byteLength(payload, 'utf8')
    if (entry.bytes + bytes > this.maxSessionBytes) {
      entry.truncated = true
      this.#saveIndex()
      return { ok: true, stored: 0, dropped: incoming.length, truncated: true, bytes: entry.bytes }
    }
    if (bytes > 0) {
      const fd = fs.openSync(file, 'a', 0o600)
      try {
        fs.writeSync(fd, payload)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
    const seqs = incoming.map((e) => int(e?.seq)).filter((s) => s !== null)
    const last = seqs.length > 0 ? Math.max(...seqs) : entry.lastSeq
    if (entry.events === 0 && seqs.length > 0) entry.firstSeq = Math.min(...seqs)
    entry.lastSeq = Math.max(entry.lastSeq, last)
    entry.events += lines.length
    entry.bytes += bytes
    entry.dropped += dropped
    // 进度：本批被接受事件里 seq 最大的一条。类型照实记（回答「最近发生了什么」），
    // 摘要只在有信息量的类型上覆盖（噪声类型不该把摘要刷成「步骤结束」）。
    let newest = null
    for (const raw of accepted) {
      const seq = int(raw?.seq)
      if (seq === null) continue
      if (newest === null || seq > int(newest.seq)) newest = raw
    }
    if (newest !== null) {
      entry.lastEventType = typeof newest.type === 'string' ? newest.type.slice(0, 80) : entry.lastEventType
      entry.lastEventTime = int(newest.time) ?? entry.lastEventTime
      const summary = summarizeEvent(newest)
      if (summary !== null) entry.lastSummary = summary.summary
    }
    entry.updatedAt = new Date().toISOString()
    this.received += lines.length
    this.dropped += dropped
    this.#saveIndex()
    // 「这一批里有没有一次运行结束」—— 执行端据此把上下文同步到本地（见 host 的同步工人）。
    // 判据是 `turn/end`（一次运行结束）而不是「收到任何事件」：跑到一半同步过去只会得到
    // 一份半截历史，而它下一批就会变。重复投递的 turn/end 不算（那些没进 accepted）。
    const endedTurn = accepted.some((raw) => raw !== null && typeof raw === 'object' && raw.type === 'turn/end')
    return {
      ok: true,
      stored: lines.length,
      dropped,
      truncated: entry.truncated,
      bytes: entry.bytes,
      lastSeq: entry.lastSeq,
      syncWanted: endedTurn,
    }
  }

  /**
   * 记一次同步结果（执行端把上下文落到本机会话目录之后）。
   *
   * 成功与「跳过/失败」分开记：跳过／失败**不**清掉上一次成功的 syncedAt —— UI 要能同时
   * 回答「本机那份最后一次是什么时候落的」和「这次为什么没落」。
   * @param {string} sessionId 会话 id（两代命名都认）。
   * @param {{at?: string, seq?: number|null, bytes?: number, version?: string|null, error?: string|null, skipped?: string|null}} [result] 结果。
   * @returns {boolean} 是否记上（找不到这条镜像返回 false）。
   */
  recordSync(sessionId, result = {}) {
    const entry = this.find(sessionId)
    if (entry === null) return false
    entry.syncAttemptAt = new Date().toISOString()
    const error = typeof result.error === 'string' && result.error !== '' ? result.error : null
    const skipped = typeof result.skipped === 'string' && result.skipped !== '' ? result.skipped : null
    entry.syncError = error === null ? null : error.slice(0, 300)
    entry.syncSkipped = skipped === null ? null : skipped.slice(0, 120)
    if (error === null && skipped === null) {
      entry.syncedAt = typeof result.at === 'string' && result.at !== '' ? result.at : new Date().toISOString()
      entry.syncedSeq = int(result.seq)
      entry.syncedBytes = int(result.bytes) ?? 0
      entry.syncedVersion = typeof result.version === 'string' && result.version !== '' ? result.version.slice(0, 8) : null
    }
    this.#saveIndex()
    return true
  }

  /** 一份给人看的镜像概况（按源设备分组）。 */
  status() {
    const byDevice = new Map()
    for (const entry of this.index.values()) {
      let bucket = byDevice.get(entry.deviceId)
      if (bucket === undefined) {
        bucket = { deviceId: entry.deviceId, deviceName: entry.sourceDeviceName || '', sessions: 0, events: 0, bytes: 0, truncated: 0, lastAt: null }
        byDevice.set(entry.deviceId, bucket)
      }
      bucket.sessions += 1
      bucket.events += entry.events
      bucket.bytes += entry.bytes
      if (entry.truncated) bucket.truncated += 1
      if (entry.updatedAt !== null && (bucket.lastAt === null || entry.updatedAt > bucket.lastAt)) bucket.lastAt = entry.updatedAt
    }
    return {
      root: this.root,
      totalSessions: this.index.size,
      received: this.received,
      dropped: this.dropped,
      lastError: this.lastError,
      devices: [...byDevice.values()].sort((a, b) => b.sessions - a.sessions),
      recent: [...this.index.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 20),
    }
  }
}

/**
 * 会话端（发送端）的镜像推送器。
 *
 * 每个会话一份状态：目标设备、已推 seq、待发批、是否已回填。回填与实时批共用
 * 同一条发送队列，保证顺序（先历史、后实时）。
 */
export class SessionMirrorSender {
  /**
   * @param {object} options 依赖。
   * @param {string} options.meshDir 网格数据目录。
   * @param {string} options.selfDeviceId 本机设备标识。
   * @param {string} options.sessionsRoot 会话日志根目录（`$DSH_HOME/sessions`）。
   * @param {(session: object) => string|null} options.resolveTarget 会话 → 执行端设备 id。
   * @param {(deviceId: string, body: object) => Promise<object>} options.send 发送一批。
   * @param {(session: object, event: object) => Promise<void>} [options.onPushed] 推送成功回调（测试/诊断用）。
   * @param {object} [options.logger] 日志。
   * @param {string[]} [options.problems] 问题收集器。
   * @param {number} [options.flushMs] 攒批间隔。
   * @param {number} [options.batchEvents] 单批事件上限。
   */
  constructor(options) {
    this.meshDir = options.meshDir
    this.selfDeviceId = options.selfDeviceId
    this.sessionsRoot = options.sessionsRoot
    this.resolveTarget = options.resolveTarget
    this.send = options.send
    this.onPushed = options.onPushed
    this.logger = options.logger
    this.problems = options.problems ?? []
    this.flushMs = options.flushMs ?? 300
    this.batchEvents = options.batchEvents ?? 256
    this.stateFile = path.join(this.meshDir, 'session-mirror.json')
    /** @type {Map<string, object>} sessionId → 状态 */
    this.sessions = new Map()
    this.timer = null
    this.sending = false
    this.counters = { batches: 0, events: 0, failed: 0, sessions: 0, backfills: 0, skipped: 0 }
    this.lastError = null
    this.#loadCursors()
  }

  #loadCursors() {
    const stored = readJson(this.stateFile, null, this.problems)
    const rows = stored !== null && typeof stored === 'object' && Array.isArray(stored.cursors) ? stored.cursors : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const sessionId = text(row.sessionId, 160)
      if (sessionId === '' || !SAFE_ID.test(sessionId)) continue
      this.sessions.set(sessionId, {
        deviceId: text(row.deviceId, 160),
        cursorSeq: int(row.cursorSeq) ?? -1,
        queuedSeq: -1,
        backfilled: row.backfilled === true,
        header: null,
        workspacePath: text(row.workspacePath, 1024),
        workspaceTitle: text(row.workspaceTitle, 300),
        pending: [],
        flushing: false,
      })
    }
  }

  #saveCursors() {
    const cursors = []
    for (const [sessionId, state] of this.sessions) {
      if (state.deviceId === '' || state.cursorSeq < 0) continue
      cursors.push({
        sessionId,
        deviceId: state.deviceId,
        cursorSeq: state.cursorSeq,
        backfilled: state.backfilled === true,
        workspacePath: state.workspacePath,
        workspaceTitle: state.workspaceTitle,
      })
    }
    const result = writeJsonAtomic(this.stateFile, { schema: STORE_SCHEMA, cursors })
    return result.ok
  }

  /** 会话的镜像状态（不存在则按需建）。 */
  stateFor(session, deviceId) {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '' || !SAFE_ID.test(sessionId)) return null
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        deviceId,
        cursorSeq: -1,
        queuedSeq: -1,
        backfilled: false,
        header: null,
        workspacePath: '',
        workspaceTitle: '',
        pending: [],
        flushing: false,
      }
      this.sessions.set(sessionId, state)
      this.counters.sessions = this.sessions.size
    }
    if (state.deviceId === '' && deviceId !== '') state.deviceId = deviceId
    return state
  }

  /**
   * 一条实时事件。
   *
   * 目标不是别的设备就什么都不做（本机执行的会话不需要镜像）。
   * @param {object} session 会话（带 header）。
   * @param {object} event 已提交事件。
   * @returns {void}
   */
  observe(session, event) {
    let deviceId = null
    try {
      deviceId = this.resolveTarget(session)
    } catch (error) {
      this.logger?.warn?.(`dsh-device-mesh: 解析镜像目标失败：${String(error)}`)
      return
    }
    if (typeof deviceId !== 'string' || deviceId === '' || deviceId === this.selfDeviceId) {
      this.counters.skipped += 1
      return
    }
    const state = this.stateFor(session, deviceId)
    if (state === null) return
    state.header = session.header ?? state.header
    state.workspacePath = text(session.header?.cwd, 1024) || state.workspacePath
    const seq = int(event?.seq)
    if (seq === null) return
    // 去重必须同时看「已发出的」与「已入队但还没发出去的」：游标只在发送成功后
    // 前进，只看游标会让同一批里重复的 seq 进两次（自测钉住过这一条）。
    if (seq <= Math.max(state.cursorSeq, state.queuedSeq)) return
    // 空洞自愈：本机日志的 seq 是稠密的，出现跳跃意味着上一次推送与这次之间漏了
    // 事件（崩溃/断链）。重做一次回填（reset + 全量）比留一个看不见的洞好。
    if (state.backfilled && seq > state.cursorSeq + 1) state.backfilled = false
    state.pending.push(event)
    state.queuedSeq = seq
    this.#schedule()
  }

  #schedule() {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * 把待发批推出去。
   *
   * 顺序：先补回填（如果还没做过），再发实时批 —— 镜像里的历史必须是完整的，
   * 所以**不能**让实时批越过回填先落地（那会让文件的 seq 范围出现空洞）。
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.sending) { this.#schedule(); return }
    this.sending = true
    try {
      for (const [sessionId, state] of this.sessions) {
        if (state.deviceId === '' || state.deviceId === this.selfDeviceId) continue
        if (!state.backfilled) {
          const ok = await this.#backfill(sessionId, state)
          if (!ok) continue
        }
        if (state.pending.length === 0) continue
        // 攒批同时受「条数」与「字节」约束：一条 4 MB 的事件不该把 256 条的批
        // 撑成 1 GB（那会直接被入站 body 上限拒掉，整批重试到永远）。
        const batch = []
        let batchBytes = 0
        while (state.pending.length > 0 && batch.length < this.batchEvents) {
          const candidate = state.pending[0]
          let size = 0
          try {
            size = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
          } catch {
            size = 0
          }
          if (batch.length > 0 && batchBytes + size > MAX_BATCH_BYTES) break
          batch.push(state.pending.shift())
          batchBytes += size
        }
        const fromSeq = int(batch[0]?.seq) ?? 0
        const toSeq = int(batch[batch.length - 1]?.seq) ?? fromSeq
        try {
          await this.send(state.deviceId, {
            sessionId,
            deviceId: this.selfDeviceId,
            sourceDeviceName: '',
            workspacePath: state.workspacePath,
            workspaceTitle: state.workspaceTitle,
            header: state.header ?? {},
            events: batch,
            fromSeq,
            toSeq,
            reset: false,
          })
          state.cursorSeq = Math.max(state.cursorSeq, toSeq)
          state.queuedSeq = Math.max(state.queuedSeq, toSeq)
          this.counters.batches += 1
          this.counters.events += batch.length
          this.lastError = null
        } catch (error) {
          state.pending.unshift(...batch)
          this.counters.failed += 1
          this.lastError = error instanceof Error ? error.message : String(error)
          break
        }
      }
      this.#saveCursors()
    } finally {
      this.sending = false
      const more = [...this.sessions.values()].some((s) => s.pending.length > 0)
      if (more) this.#schedule()
    }
  }

  /** 找一条会话在本机的日志文件（v3 / v4 都要，v3 在前）。 */
  logFilesFor(sessionId) {
    const found = []
    let dirs = []
    try {
      dirs = fs.readdirSync(this.sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return found
    }
    for (const dir of dirs) {
      const base = path.join(this.sessionsRoot, dir, sessionId)
      let stats
      try {
        stats = fs.statSync(base)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      // **择代**：v4 是迁移后的当前代，且把整份历史都写进去了（v3 是被取代的原文）。
      // 同时存在时只读 v4 —— 两个都读会把 0..N 的历史叠一遍（实测：354+399 行、
      // 唯一 seq 只有 398 条）。没有 v4 才回落到 v3。
      for (const generation of [['session.v4.jsonl.zstd', 'session.v4.jsonl'], ['session.v3.jsonl.zstd', 'session.v3.jsonl']]) {
        const hit = generation.map((name) => path.join(base, name)).find((file) => fs.existsSync(file))
        if (hit !== undefined) {
          found.push(hit)
          break
        }
      }
      break
    }
    return found
  }

  /** 读一个（可能被 zstd 压缩、也可能是明文）日志文件，逐行给事件。 */
  *readLogFile(file) {
    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      return
    }
    if (file.endsWith('.zstd')) {
      // 逐帧解（见 scanZstdFrames 的说明）：一次性解压只会拿到第一帧。
      const decoded = decodeZstdLog(buffer, this.problems)
      buffer = Buffer.from(decoded.text, 'utf8')
    }
    for (const line of buffer.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (parsed !== null && typeof parsed === 'object') yield parsed
    }
  }

  /**
   * 回填一条会话的完整历史。
   * @param {string} sessionId 会话标识。
   * @param {object} state 会话状态。
   * @returns {Promise<boolean>} 是否完成（false = 本批失败，下轮重试）。
   */
  async #backfill(sessionId, state) {
    const files = this.logFilesFor(sessionId)
    if (files.length === 0) {
      // 还没有日志（会话刚建）：标成已回填，等实时事件。等日志出现后由下一次
      // observe 触发的 backfill=false 状态自然纠正 —— 这里不猜。
      state.backfilled = true
      return true
    }
    let batch = []
    let reset = true
    let firstSeq = null
    let lastSeq = -1
    const flushBatch = async () => {
      if (batch.length === 0) return true
      try {
        await this.send(state.deviceId, {
          sessionId,
          deviceId: this.selfDeviceId,
          sourceDeviceName: '',
          workspacePath: state.workspacePath,
          workspaceTitle: state.workspaceTitle,
          header: state.header ?? {},
          events: batch,
          fromSeq: firstSeq ?? 0,
          toSeq: lastSeq,
          reset,
        })
      } catch (error) {
        this.counters.failed += 1
        this.lastError = error instanceof Error ? error.message : String(error)
        return false
      }
      reset = false
      // 每批落地就推进游标：回填中途换文件/重试时，已发过的 seq 不会再发一遍。
      state.cursorSeq = Math.max(state.cursorSeq, lastSeq)
      state.queuedSeq = Math.max(state.queuedSeq, lastSeq)
      batch = []
      return true
    }
    for (const file of files) {
      for (const record of this.readLogFile(file)) {
        if (record.type === 'session') {
          state.header = { ...(state.header ?? {}), ...record }
          continue
        }
        const seq = int(record.seq)
        if (seq === null) continue
        // 回填**不按游标跳过**：第一批带 reset，接收端会把文件清空重写，所以必须
        // 发全量；按游标只补尾巴会让接收端剩下一段尾部（实测就是 409 行的日志只
        // 落 10 行）。游标在这里的用途是「已经全量发过就不要再来一次」，由
        // state.backfilled 承担。
        if (firstSeq === null) firstSeq = seq
        batch.push(record)
        lastSeq = seq
        if (batch.length >= this.batchEvents) {
          if (!(await flushBatch())) return false
          firstSeq = null
        }
      }
    }
    if (!(await flushBatch())) return false
    state.backfilled = true
    if (lastSeq >= 0) {
      state.cursorSeq = Math.max(state.cursorSeq, lastSeq)
      state.queuedSeq = Math.max(state.queuedSeq, lastSeq)
    }
    this.counters.backfills += 1
    this.#saveCursors()
    return true
  }

  /** 主动回填一批会话（用于把**已有历史**一次性补齐）。 */
  async backfillSessions(entries) {
    let done = 0
    for (const entry of entries) {
      const session = { id: entry.sessionId, header: entry.header ?? { id: entry.sessionId, cwd: entry.cwd } }
      const state = this.stateFor(session, entry.deviceId)
      if (state === null) continue
      state.header = session.header
      state.workspacePath = entry.cwd ?? state.workspacePath
      state.workspaceTitle = entry.workspaceTitle ?? state.workspaceTitle
      const ok = await this.#backfill(entry.sessionId, state)
      if (ok) done += 1
    }
    return done
  }

  status() {
    return {
      sessions: this.sessions.size,
      counters: { ...this.counters },
      lastError: this.lastError,
      pending: [...this.sessions.values()].reduce((sum, s) => sum + s.pending.length, 0),
      targets: [...new Set([...this.sessions.values()].map((s) => s.deviceId).filter((d) => d !== ''))],
    }
  }

  stop() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.#saveCursors()
  }
}

/** 给镜像文件挑一个稳定的会话目录名（诊断用；与 DSH 的编码规则一致）。 */
export function sessionsDirNameOf(cwd) {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : ''
  if (trimmed === '' || !trimmed.startsWith('/')) return null
  return `--${trimmed.replace(/^\/+/u, '').replace(/[\\/]+/gu, '-')}--`
}

/** 无依赖的随机 id（store 的 index 用）。 */
export { randomHex }
