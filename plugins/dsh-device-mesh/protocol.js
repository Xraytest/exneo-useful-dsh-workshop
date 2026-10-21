/**
 * dsh-device-mesh — 线协议（纯函数，零 I/O，可单测）。
 *
 * 这一层是**双向对称**的：同一个 `signRequest` 既被出站连接器（本机 → 远端接入点）
 * 用来签名，也被入站路由（远端节点 → 本机）用来验签。两侧必须逐字节一致，
 * 所以规范串的拼法与编码都只在这里定义一次。
 *
 * ── 认证模型 ────────────────────────────────────────────────────────────────
 * 对称密钥（token secret），请求级 HMAC 签名 + 时间窗 + nonce 防重放：
 *
 *   canonical = method \n path \n timestamp \n nonce \n sha256hex(body)
 *   signature = base64url(HMAC-SHA256(secret, canonical))
 *
 * 为什么不是「Bearer 明文 token」：明文 token 一旦被沿途日志/代理记下来就能无限
 * 重放；HMAC 让每次请求的签名都不同，配合 `requestSkewMs` 时间窗与 nonce 缓存，
 * 截获单个请求不足以冒充节点。
 *
 * 签名覆盖 `path`（含 query）而不只是路由：不同路由之间不能互相搬运签名。
 *
 * ── 为什么 secret 是明文存的 ────────────────────────────────────────────────
 * HMAC 是对称的：验签方必须持有密钥本身，只存哈希就验不了签（存哈希的方案只能退化成
 * 「明文 token 比对」）。因此接入点的 token 表以 0600 权限存 secret，撤销 = 删条目。
 * 若要「接入点也不知道密钥」，得换成非对称签名（节点持私钥），那是另一个协议版本。
 *
 * @module dsh-device-mesh/protocol
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 线协议版本：不匹配时接入点直接拒绝，避免半懂的新旧节点互相写坏数据。 */
export const PROTOCOL_VERSION = 1

/** 本实现的版本号（`/status` 回读它来判断「跑的是哪一版」）。 */
export const MESH_VERSION = 1

/** 入站 API 前缀（远端节点 → 本机）。 */
export const API_BASE = '/dsh-device-mesh/api'

/** 浏览器侧前缀（本机页面 → 本机）。 */
export const UI_BASE = '/dsh-device-mesh'

/** 入站 API 路径表。两侧（发起方 / 受理方）都从这里取，避免字符串漂移。 */
export const API = {
  hello: `${API_BASE}/hello`,
  join: `${API_BASE}/join`,
  report: `${API_BASE}/report`,
  heartbeat: `${API_BASE}/heartbeat`,
  leave: `${API_BASE}/leave`,
  /** 取本接入点的一跳总览（供对端做镜像）。 */
  tree: `${API_BASE}/tree`,
  /** 取本接入点的工作区「多工作路径」账目（供对端解析远端路径）。 */
  paths: `${API_BASE}/paths`,
  /** 列一个被导出的目录（跨设备路径导航用）。 */
  list: `${API_BASE}/fs/list`,
  /**
   * 改**本机某条已加载会话**的权限（会话端受理）。
   *
   * 语义就是出厂 `setSandboxMode(session, mode)`：往那条会话追加一条 `sandbox/mode`
   * 事件。会话端是权限的**权威**（见 `/session-mode` 浏览器路由的说明），所以这个动作
   * 只由「会话真正所在的那台」受理；找不到已加载的会话就 404。
   */
  sessionMode: `${API_BASE}/session-mode`,
  /** 在指定路径上执行命令（跨设备执行）。 */
  exec: `${API_BASE}/exec`,
  /**
   * 中止一条正在执行的远端命令。
   *
   * 为什么需要它：执行是**一次性请求/响应**，本机在命令跑完前无法把 id 告知对端，
   * 所以 id 由**发起方**生成并随执行请求带来，取消时再点名。没有它的话，一条跑飞的
   * 远端命令在发起方中止后仍会在对端跑满自己的超时。
   */
  execCancel: `${API_BASE}/exec/cancel`,
  /**
   * ── 远端文件系统原语（供路由型 ctx.fs 使用）─────────────────────────────
   * 只开这几条**原语**，而不是「远端 fs 的每个方法各一条路由」：主机侧 13 个抽象
   * 方法里有几个（processPath / fileUrl / contains / 目标铸造）根本不需要往返，
   * 真正要过网的只有下面这几条。
   *
   * 一律由**对端自己的 ctx.fs** 落地执行——这样 realpath、符号链接、沙箱策略
   * 都是对端的事实，主机不代为解释。
   */
  /** 观察路径元数据（跟随符号链接）。 */
  fsStat: `${API_BASE}/fs/stat`,
  /** 观察路径本身（不跟随符号链接）。 */
  fsLstat: `${API_BASE}/fs/lstat`,
  /** 读文件：文本，或带窗口的字节（base64 回传）。 */
  fsRead: `${API_BASE}/fs/read`,
  /** 列目录的直接子项。 */
  fsListDir: `${API_BASE}/fs/listdir`,
  /** 写文件（可带版本守卫）。 */
  fsWrite: `${API_BASE}/fs/write`,
  /** 字面量替换（服务端读-改-写，可带版本守卫）。 */
  fsEdit: `${API_BASE}/fs/edit`,
  /**
   * 会话历史镜像：会话端把一条会话的事件历史实时推到执行端，执行端**只存储**
   * （见 session-mirror.js）。门与 exec/fs 同源，外加「工作区路径必须是接收端
   * 自己的工作区」这一条。
   */
  sessionMirror: `${API_BASE}/session-mirror`,
  // ── 会话状态权威（P2）：设备 API（传输层强制 令牌+签名+nonce）────────────
  sessionStateAction: `${API_BASE}/session-state/action`,
  sessionStateFetch: `${API_BASE}/session-state`,
}

/** 浏览器侧路径表。 */
export const UI = {
  tree: `${UI_BASE}/tree`,
  status: `${UI_BASE}/status`,
  config: `${UI_BASE}/config`,
  links: `${UI_BASE}/links`,
  linkTest: `${UI_BASE}/links/test`,
  linkSync: `${UI_BASE}/links/sync`,
  tokens: `${UI_BASE}/tokens`,
  nodes: `${UI_BASE}/nodes`,
  /** 工作区多工作路径：GET 列出 / POST 增删。 */
  paths: `${UI_BASE}/paths`,
  /** 会话历史镜像概况（本机作为执行端收到了什么）。 */
  mirror: `${UI_BASE}/mirror`,
  /**
   * 远端会话驱动检测：哪些工作区的**会话在远端执行**、有没有真的把命令发到本机。
   *
   * 与 `/tree` 里内嵌的那份 `drivers` 是同一个判定结果，单独一条路由是为了：
   * ① 用 curl 就能核对判定（不必在 700 KB 的 /tree 里翻）；② 客户端需要按需重取时
   * 不必重拉整棵树。两者同源，不会出现「两个路由两个结论」。
   */
  drivers: `${UI_BASE}/drivers`,
  /** 主动把已有历史回填给执行端（一次性动作，需要显式触发）。 */
  mirrorBackfill: `${UI_BASE}/mirror/backfill`,
  /** 路由干跑：给一条路径，回答「它会在哪台设备上执行、凭什么」（排查用，不执行任何东西）。 */
  route: `${UI_BASE}/route`,
  /** 浏览器侧「远端执行」控制台。 */
  exec: `${UI_BASE}/exec`,
  /** 列出某设备某目录（给路径选择器用）。 */
  browse: `${UI_BASE}/browse`,
  /** 跨设备执行审计日志。 */
  audit: `${UI_BASE}/audit`,
  /**
   * 把**对端设备上**某会话的完整历史拉回本机（填本机那份空桩）。
   *
   * 为什么需要：会话属于它所在的设备 —— 日志、附件、agent 都在那边。本机若只有一个
   * 空桩（只有 session 头、没有任何事件），出厂 composer 的「上下文占用」按钮就永远
   * 不渲染：它要的 `request/context`（容量）与 assistant 的 usage（用量）都在日志里。
   * 这个路由按字节把对端的 `session.v*.jsonl.zstd` 抄过来，本机会话从此完整、可打开。
   */
  sessionPull: `${UI_BASE}/session-pull`,
  /**
   * 改一条会话的权限（**哪边改都行**）。
   *
   * 会话权限的权威在**会话所在这台**（出厂 `sandbox-policy` 的会话覆盖就是那条
   * `sandbox/mode` 事件）。所以这条浏览器路由是「本地优先 + 一跳转发」：
   *   1. 会话就在本机（已加载）→ 就地追加事件，立刻生效；
   *   2. 会话在直连的对端 → 用 `caller` 转发到那台的 `POST /api/session-mode`（只走一跳）；
   *   3. 都不成立 → 404，并把原因说清（会话不在已知设备上 / 那台未加载它）。
   * 「改权限」是权限变更，两侧都写审计。
   */
  sessionMode: `${UI_BASE}/session-mode`,
  /**
   * 执行端的**进度面**：镜像里每条会话最近在干什么（只读）。
   *
   * 与 `/mirror`（概况：收了多少）不同，这条是**逐会话**的进度（最后事件类型/摘要/
   * seq/时间/对端 agent 是否在跑），给「远程工作区」那段渲染进度行用。
   */
  replicaProgress: `${UI_BASE}/replica-progress`,
  /**
   * **接管**：把一条在别处执行的会话变成本机会话（显式动作，会写本机 `sessions/`）。
   *
   * 在线时从源设备按字节拉回；源设备不可达时用本机镜像重压落地。覆盖本机已有历史前
   * 会先备份到 `<meshDir>/session-takeover-backups/`。
   */
  takeover: `${UI_BASE}/takeover`,
  sessionState: `${UI_BASE}/session-state`,
}

/** 签名头名（全部小写：Node 的 `req.headers` 就是小写键）。 */
export const HEADERS = {
  device: 'x-dsh-mesh-device',
  token: 'x-dsh-mesh-token',
  timestamp: 'x-dsh-mesh-timestamp',
  nonce: 'x-dsh-mesh-nonce',
  signature: 'x-dsh-mesh-signature',
  protocol: 'x-dsh-mesh-protocol',
}

/**
 * 机器可读的失败码。
 *
 * 出站连接器要**按码决定动作**（例如 `unknown-node` 就地重新 join，而
 * `unauthenticated` 只能等人去换令牌），所以错误不能只有人可读的 message。
 * 这些码同时出现在入站 API 的 JSON 响应与 UI 的 `/status` 里。
 */
export const CODE = {
  /** 令牌不存在 / 已撤销 / 已过期。 */
  unauthenticated: 'unauthenticated',
  /** 签名、时间戳或 nonce 不通过。 */
  badSignature: 'bad-signature',
  /** 协议版本不一致。 */
  protocolMismatch: 'protocol-mismatch',
  /** 本机没有开启入站接入。 */
  inboundDisabled: 'inbound-disabled',
  /** 节点记录不存在（被 forget 或本机换过数据目录）——对端应当重新 join。 */
  unknownNode: 'unknown-node',
  /** 该设备被本机拉黑。 */
  deviceDenied: 'device-denied',
  /** 节点数已达上限。 */
  tooManyNodes: 'too-many-nodes',
  /** 请求体不是合法 JSON 或结构不对。 */
  badRequest: 'bad-request',
  /** 请求体超过上限。 */
  payloadTooLarge: 'payload-too-large',
  /** 未知路由 / 方法。 */
  notFound: 'not-found',
  /** 本机内部错误。 */
  internal: 'internal',
  /**
   * 远端文件系统操作失败。对端的 FsError 码原样带回来，主机侧重建成同码的
   * FsError——上层（工具 / 权限层）靠 code 分支，不能靠解析文案。
   */
  fsError: 'fs-error',
  /** 本机未开启跨设备执行（`allowRemoteExec=false`）。 */
  execDisabled: 'exec-disabled',
  /** 该节点没有被授予执行权限（`trust` 不是 `exec`）。 */
  execDenied: 'exec-denied',
  /** 目标路径不在本机导出的范围内 —— 本机不会为一台远端设备打开任意路径。 */
  pathNotExported: 'path-not-exported',
  /** 目标路径不存在或不是目录。 */
  pathMissing: 'path-missing',
  /**
   * 要中止的命令没有登记在册。**多数是正常竞态**：命令恰好在 cancel 到达之前自己
   * 跑完、登记已摘牌。所以它必须是一个可区分、可忽略的码，而不是一个笼统的失败。
   */
  unknownJob: 'unknown-job',
  /** 这条命令是**别的**设备发起的，这台设备无权中止它（即使猜到了 id）。 */
  notYours: 'not-yours',
  /** 本机同时在跑的执行数已达上限。 */
  execBusy: 'exec-busy',
  /** 目标设备不可达（本机没有指向它的接入点）。 */
  unreachable: 'unreachable',
  /** 目标正在被使用（如本机该会话是活会话，不能覆盖它的日志）。 */
  busy: 'busy',
  /** 与既有状态冲突（如本机已有该会话的历史，拒绝覆盖）。 */
  conflict: 'conflict',
  /** 对端读失败（拉会话历史时对端定位/读取日志出错）。 */
  upstream: 'upstream',
}

/** nonce 与 id 的字符集：hex，方便按长度和正则校验。 */
const HEX = /^[0-9a-f]+$/

/**
 * 生成十六进制随机 id。
 * @param {number} bytes 随机字节数。
 * @returns {string} 2*bytes 个小写十六进制字符。
 */
export function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

/**
 * 生成 URL 安全的随机密钥（token secret）。
 * @param {number} bytes 随机字节数。
 * @returns {string} base64url 编码。
 */
export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * 字符串/字节的 sha256 十六进制摘要。
 * @param {string | Buffer | Uint8Array} input 输入。
 * @returns {string} 64 位小写十六进制。
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** 空体的摘要，GET / 无体 POST 两侧共用同一个常量。 */
export const EMPTY_BODY_HASH = sha256Hex('')

/**
 * 请求体的摘要。字符串按 UTF-8 编码后取 sha256 —— 签名覆盖的是**线上的字节**，
 * 所以两侧必须传同一份字节（出站侧传实际发出的 body 字符串，入站侧传读到的原始 body）。
 * @param {string | Buffer | Uint8Array | null | undefined} body 请求体。
 * @returns {string} 64 位小写十六进制摘要。
 */
export function bodyHash(body) {
  if (body === null || body === undefined || body === '') return EMPTY_BODY_HASH
  return sha256Hex(body)
}

/**
 * 组装规范串。字段之间用 `\n` 分隔，字段内不允许出现 `\n`（由 {@link assertNoNewline} 保证）。
 * @param {{method: string, path: string, timestamp: number|string, nonce: string, hash: string}} parts 五个字段。
 * @returns {string} 规范串。
 */
export function canonicalRequest(parts) {
  const method = String(parts.method ?? '').toUpperCase()
  const path = String(parts.path ?? '')
  const timestamp = String(parts.timestamp ?? '')
  const nonce = String(parts.nonce ?? '')
  const hash = String(parts.hash ?? '')
  assertNoNewline(method, 'method')
  assertNoNewline(path, 'path')
  assertNoNewline(timestamp, 'timestamp')
  assertNoNewline(nonce, 'nonce')
  assertNoNewline(hash, 'hash')
  return [method, path, timestamp, nonce, hash].join('\n')
}

/**
 * 字段里出现换行会让规范串产生歧义（`a\nb` 与两个字段拼出来一样），从而可能伪造签名。
 * 所有字段都来自我们自己的代码或可校验的输入（method 枚举、非负整数、hex），
 * 这里做一次硬断言，把「将来有人塞进自由文本」变成显式失败而不是静默漏洞。
 * @param {string} value 字段值。
 * @param {string} label 字段名（错误信息用）。
 * @returns {void}
 * @throws {Error} 含换行或回车时。
 */
function assertNoNewline(value, label) {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`dsh-device-mesh: 规范串字段 ${label} 不能含换行`)
  }
}

/**
 * 计算请求签名。
 * @param {string} secret 对称密钥。
 * @param {{method: string, path: string, timestamp: number|string, nonce: string, hash: string}} parts 规范串字段。
 * @returns {string} base64url(HMAC-SHA256)。
 */
export function signRequest(secret, parts) {
  return createHmac('sha256', secret).update(canonicalRequest(parts)).digest('base64url')
}

/**
 * 定长恒定时间比较（长度不同直接 false，不泄漏内容）。
 * @param {string} a 期望值。
 * @param {string} b 实际值。
 * @returns {boolean} 是否相等。
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * 校验并归一化一个签名头集合。
 *
 * 时间戳只接受十进制非负整数（不接受浮点、正负号、空白），nonce 只接受 8–64 位 hex：
 * 两者都参与规范串，收紧字符集让「同一逻辑请求的两种拼法」不可能同时通过验签。
 * @param {Record<string, unknown>} headers 请求头（小写键）。
 * @returns {{deviceId: string, tokenId: string, timestamp: number, nonce: string, signature: string, protocol: number}} 归一化后的签名材料。
 * @throws {Error} 任一字段缺失或格式非法。
 */
export function readSignatureHeaders(headers) {
  const pick = (key) => {
    const value = headers[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const deviceId = pick(HEADERS.device)
  const tokenId = pick(HEADERS.token)
  const timestampRaw = pick(HEADERS.timestamp)
  const nonce = pick(HEADERS.nonce)
  const signature = pick(HEADERS.signature)
  const protocolRaw = pick(HEADERS.protocol)

  if (!/^[0-9a-f]{8,128}$/.test(deviceId)) throw new Error('缺少或非法的设备标识头')
  if (!/^[0-9a-f]{8,64}$/.test(tokenId)) throw new Error('缺少或非法的令牌标识头')
  if (!/^[0-9]{1,17}$/.test(timestampRaw)) throw new Error('缺少或非法的时间戳头')
  if (!HEX.test(nonce) || nonce.length < 8 || nonce.length > 64) throw new Error('缺少或非法的 nonce 头')
  if (signature === '' || signature.length > 256) throw new Error('缺少签名头')

  const timestamp = Number(timestampRaw)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('时间戳超出安全整数范围')

  const protocol = protocolRaw === '' ? PROTOCOL_VERSION : Number(protocolRaw)
  if (!Number.isSafeInteger(protocol) || protocol < 1) throw new Error('缺少或非法的协议版本头')

  return { deviceId, tokenId, timestamp, nonce, signature, protocol }
}

/**
 * 生成出站请求要带的签名头。
 * @param {{deviceId: string, tokenId: string, secret: string, method: string, path: string, body?: string|Buffer|null, now?: number, nonce?: string}} options 出站签名材料。
 * @returns {Record<string, string>} 完整请求头（含 content-type 之外的签名头）。
 */
export function buildSignatureHeaders(options) {
  const timestamp = options.now ?? Date.now()
  const nonce = options.nonce ?? randomHex(16)
  const hash = bodyHash(options.body)
  const signature = signRequest(options.secret, {
    method: options.method,
    path: options.path,
    timestamp,
    nonce,
    hash,
  })
  return {
    [HEADERS.device]: options.deviceId,
    [HEADERS.token]: options.tokenId,
    [HEADERS.timestamp]: String(timestamp),
    [HEADERS.nonce]: nonce,
    [HEADERS.signature]: signature,
    [HEADERS.protocol]: String(PROTOCOL_VERSION),
  }
}

/**
 * 校验入站请求的签名。时间窗与 nonce 重放由调用方用 {@link ReplayGuard} 负责
 * （那两件事是有状态/带策略的，不属于纯函数层）。
 * @param {{secret: string, method: string, path: string, body?: string|Buffer|null, headers: Record<string, unknown>, now?: number, skewMs: number}} options 验签材料。
 * @returns {{ok: true, deviceId: string, tokenId: string, protocol: number, nonce: string, timestamp: number}} 通过时的签名材料。
 * @throws {Error} 任一项不通过，message 是可直接回给调用方的中文原因。
 */
export function verifyRequestSignature(options) {
  const material = readSignatureHeaders(options.headers)
  const now = options.now ?? Date.now()
  const skew = Math.abs(now - material.timestamp)
  if (skew > options.skewMs) {
    throw new Error(`请求时间戳超出允许窗口（偏差 ${Math.round(skew / 1000)} 秒）`)
  }
  if (material.protocol !== PROTOCOL_VERSION) {
    throw new Error(`协议版本不匹配：本机 ${PROTOCOL_VERSION}，对端 ${material.protocol}`)
  }
  const expected = signRequest(options.secret, {
    method: options.method,
    path: options.path,
    timestamp: material.timestamp,
    nonce: material.nonce,
    hash: bodyHash(options.body),
  })
  if (!timingSafeEqualStr(expected, material.signature)) {
    throw new Error('签名校验失败')
  }
  return {
    ok: true,
    deviceId: material.deviceId,
    tokenId: material.tokenId,
    protocol: material.protocol,
    nonce: material.nonce,
    timestamp: material.timestamp,
  }
}

/**
 * 有状态的 nonce 缓存：同一 (tokenId, nonce) 在时间窗内只能成功通过一次。
 *
 * 容量上限是硬闸：条目超过 `maxEntries` 时按插入序淘汰最老的（Map 保证插入序），
 * 并同步提升 `evictions` 计数供 `/status` 观察。淘汰**只会**放宽防重放强度、
 * 不会拒绝正常请求，所以这里选择「宁可淘汰也不拒绝服务」。
 */
export class ReplayGuard {
  /**
   * @param {{windowMs: number, maxEntries?: number}} options 时间窗与容量。
   */
  constructor(options) {
    this.windowMs = options.windowMs
    this.maxEntries = options.maxEntries ?? 8192
    /** @type {Map<string, number>} key → 过期时刻。 */
    this.seen = new Map()
    /** 累计淘汰数与命中数，供诊断。 */
    this.evictions = 0
    this.replays = 0
  }

  /**
   * 记录一个 nonce。
   * @param {string} tokenId 令牌标识。
   * @param {string} nonce 请求 nonce。
   * @param {number} now 当前时刻（毫秒）。
   * @returns {boolean} true = 首次见到（放行）；false = 重放（拒绝）。
   */
  accept(tokenId, nonce, now) {
    this.sweep(now)
    const key = `${tokenId}:${nonce}`
    if (this.seen.has(key)) {
      this.replays += 1
      return false
    }
    this.seen.set(key, now + this.windowMs)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
      this.evictions += 1
    }
    return true
  }

  /**
   * 清掉已过期的条目。
   * @param {number} now 当前时刻（毫秒）。
   * @returns {void}
   */
  sweep(now) {
    // 全表扫描而不是「遇到未过期就 break」：Map 的插入序只在 now 单调时才等于过期序，
    // 系统时钟被回拨/校正后 break 会把陈旧条目永久留在表里（那些条目会让一个从未用过的
    // nonce 被误判为重放）。表上界 8192，全扫是微秒级，不值得为它换正确性。
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
    }
  }

  /** 诊断快照。 */
  stats() {
    return { size: this.seen.size, maxEntries: this.maxEntries, evictions: this.evictions, replays: this.replays }
  }
}
