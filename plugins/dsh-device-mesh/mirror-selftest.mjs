/**
 * 会话历史镜像自测：纯 node、无外部副作用（临时目录用完即删）。
 *
 * 覆盖三层：
 *   1. shapeEvent —— 白名单与上限（坏事件必须被丢掉，而不是写进镜像）；
 *   2. SessionReplicaStore —— 重置/追加/重投去重/路径穿越/单会话上限；
 *   3. SessionMirrorSender —— 回填（读本地 zstd 日志）→ 实时批 → 游标落盘 →
 *      失败重试；本机执行的目标不推；
 *   4. 进度与接管 —— 会话头/摘要进索引、两代命名都能查到、镜像重压成出厂可读日志。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  SessionMirrorSender, SessionReplicaStore, buildSessionLogBytes, decodeZstdLog,
  inferFormatVersion, sanitizeSessionHeader, sessionsDirNameOf, shapeEvent, summarizeEvent,
} from './session-mirror.js'

let n = 0
const ok = (label, fn) => {
  fn()
  n += 1
  console.log('  ok  ' + label)
}
const aok = async (label, fn) => {
  await fn()
  n += 1
  console.log('  ok  ' + label)
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-mirror-'))

// ── 1. shapeEvent ─────────────────────────────────────────────────────────
ok('shapeEvent：合法事件 → 紧凑 JSON 行（只留 type/seq/time/data）', () => {
  const shaped = shapeEvent({ type: 'turn/start', seq: 3, time: 1791000000000, data: { turn: 1 }, surface: 'x' }, 4096)
  assert.equal(shaped.ok, true)
  const parsed = JSON.parse(shaped.line)
  assert.deepEqual(Object.keys(parsed).sort(), ['data', 'seq', 'time', 'type'])
  assert.equal(parsed.seq, 3)
})

ok('shapeEvent：坏类型 / 坏 seq / 非对象 / 超限 一律拒绝', () => {
  assert.equal(shapeEvent({ type: 'Bad Type', seq: 1 }, 4096).ok, false)
  assert.equal(shapeEvent({ type: 'a/b', seq: -1 }, 4096).ok, false)
  assert.equal(shapeEvent({ type: 'a', seq: 1.5 }, 4096).ok, false)
  assert.equal(shapeEvent(null, 4096).ok, false)
  assert.equal(shapeEvent({ type: 'a', seq: 1, data: 'x'.repeat(100) }, 16).ok, false)
})

ok('sessionsDirNameOf 与 DSH 的会话目录命名一致', () => {
  assert.equal(sessionsDirNameOf('/root/DSHpluginWorkSpace'), '--root-DSHpluginWorkSpace--')
  assert.equal(sessionsDirNameOf('/root/code/app'), '--root-code-app--')
  assert.equal(sessionsDirNameOf('relative'), null)
})

// ── 2. SessionReplicaStore ────────────────────────────────────────────────
await aok('ReplicaStore：reset 建文件 + 索引；追加批续写；重投同 seq 段被跳过', async () => {
  const dir = tmp()
  const problems = []
  const store = new SessionReplicaStore(dir, problems, { maxSessionBytes: 1024 * 1024, maxEventBytes: 4096 })
  const sessionId = 'session-aaaa'
  const first = store.append({
    deviceId: 'dev-source',
    sessionId,
    workspacePath: '/root/ws',
    header: { id: sessionId, cwd: '/root/ws', title: '镜像测试' },
    events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'turn/end', seq: 1, time: 2, data: {} }],
    fromSeq: 0,
    toSeq: 1,
    reset: true,
  })
  assert.equal(first.stored, 2)
  const file = store.fileFor('dev-source', sessionId)
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2)

  // 重投同一段（网络重试）：不应产生重复行
  const replay = store.append({
    deviceId: 'dev-source', sessionId,
    events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, { type: 'turn/end', seq: 1, time: 2, data: {} }],
    fromSeq: 0, toSeq: 1,
  })
  assert.equal(replay.stored, 0)
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2)

  const next = store.append({
    deviceId: 'dev-source', sessionId,
    events: [{ type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } }],
    fromSeq: 2, toSeq: 2,
  })
  assert.equal(next.stored, 1)
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3)

  const status = store.status()
  assert.equal(status.totalSessions, 1)
  assert.equal(status.devices[0].sessions, 1)
  assert.equal(status.recent[0].lastSeq, 2)
  assert.equal(status.recent[0].title, '镜像测试')
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('ReplicaStore：非法 id（路径穿越）被拒；坏事件被丢并计数', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxSessionBytes: 1024 * 1024, maxEventBytes: 4096 })
  assert.throws(() => store.append({ deviceId: '../etc', sessionId: 'x', events: [] }), /非法设备/)
  assert.throws(() => store.append({ deviceId: 'dev', sessionId: '../../passwd', events: [] }), /非法设备/)
  const result = store.append({
    deviceId: 'dev', sessionId: 'session-b',
    events: [{ type: 'ok/type', seq: 0 }, { type: 'BAD TYPE', seq: 1 }, null, { type: 'ok/type', seq: 'x' }],
    fromSeq: 0, toSeq: 0, reset: true,
  })
  assert.equal(result.stored, 1)
  assert.equal(result.dropped, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('ReplicaStore：单会话上限到顶后停止追加并标 truncated', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxSessionBytes: 200, maxEventBytes: 4096 })
  const payload = Array.from({ length: 10 }, (_, i) => ({ type: 'step/start', seq: i, time: i, data: { pad: 'x'.repeat(40) } }))
  const first = store.append({ deviceId: 'dev', sessionId: 'session-c', events: payload, fromSeq: 0, toSeq: 9, reset: true })
  assert.equal(first.truncated, true)
  const again = store.append({ deviceId: 'dev', sessionId: 'session-c', events: [{ type: 'step/start', seq: 10 }], fromSeq: 10, toSeq: 10 })
  assert.equal(again.stored, 0)
  assert.equal(again.truncated, true)
  assert.equal(store.status().devices[0].truncated, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('scanZstdFrames/decodeZstdLog：多帧容器逐帧解，残帧不致命', () => {
  const frames = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from('{"a":1}\n', 'utf8')),
    zlib.zstdCompressSync(Buffer.from('{"b":2}\n', 'utf8')),
  ])
  const decoded = decodeZstdLog(frames)
  assert.equal(decoded.frames, 2)
  assert.equal(decoded.text, '{"a":1}\n{"b":2}\n')
  // 尾巴上塞一帧写坏的：已完整的帧照常解出来
  const torn = Buffer.concat([frames, Buffer.from('\x28\xb5\x2f\xfd\x00\x01', 'binary')])
  const partial = decodeZstdLog(torn)
  assert.equal(partial.frames, 2)
  assert.equal(partial.torn, true)
  assert.equal(partial.text.includes('"b":2'), true)
})

// ── 3. SessionMirrorSender ────────────────────────────────────────────────
/** 造一份「本机会话日志」夹具：v3 zstd 文件 + v4 zstd 文件（事件分两段）。 */
function fixture(sessionsRoot, cwd, sessionId) {
  const dir = path.join(sessionsRoot, sessionsDirNameOf(cwd), sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 4, id: sessionId, createdAt: 1, cwd }
  const v3 = [
    JSON.stringify(header),
    JSON.stringify({ type: 'user/message', seq: 0, time: 10, data: { text: 'hi' } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: 11, data: { text: 'yo' } }),
  ].join('\n') + '\n'
  // v4 是**整份日志的新代**（含 v3 已覆盖的 seq），所以夹具让 v4 从 seq 0 重写：
  // 回填只能读它一代，两个都读就会把 0..1 叠一遍。
  const v4 = [
    JSON.stringify({ type: 'user/message', seq: 0, time: 10, data: { text: 'hi' } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: 11, data: { text: 'yo' } }),
    JSON.stringify({ type: 'turn/start', seq: 2, time: 12, data: { turn: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 3, time: 13, data: { turn: 1 } }),
  ].join('\n') + '\n'
  // DSH 的日志是「独立帧拼接」容器：夹具必须逐行压成独立帧，否则测不出
  // 「一次性解压只解第一帧」这个坑（第一版就是被它骗过去的）。
  const frames = (text) => Buffer.concat(text.split('\n').filter((l) => l.trim() !== '').map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8'))))
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), frames(v3))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frames(v4))
  return dir
}

await aok('Sender：首次 observe 触发回填（v3+v4 全量，reset 打头），之后接实时批', async () => {
  const meshDir = tmp()
  const sessionsRoot = tmp()
  const cwd = '/root/ws'
  const sessionId = 'session-mirror-1'
  fixture(sessionsRoot, cwd, sessionId)
  const sent = []
  const sender = new SessionMirrorSender({
    meshDir,
    selfDeviceId: 'dev-self',
    sessionsRoot,
    flushMs: 5,
    batchEvents: 2,
    resolveTarget: () => 'dev-exec',
    send: async (deviceId, body) => { sent.push({ deviceId, body }); return { ok: true } },
  })
  const session = { id: sessionId, header: { id: sessionId, cwd } }
  sender.observe(session, { type: 'step/start', seq: 4, time: 14, data: { turn: 1, step: 1 } })
  await sender.flush()

  const resets = sent.filter((b) => b.body.reset === true)
  assert.equal(resets.length >= 1, true, '回填的第一批必须带 reset')
  const backfillSeqs = sent.flatMap((b) => b.body.events.map((e) => e.seq))
  assert.deepEqual(backfillSeqs.slice(0, 4), [0, 1, 2, 3], '回填必须是完整历史且保持顺序')
  assert.equal(new Set(backfillSeqs).size, backfillSeqs.length, 'v3/v4 重叠时不得重复推送（择代）')
  assert.equal(backfillSeqs.includes(4), true, '实时事件必须跟在回填之后')
  assert.equal(sent.every((b) => b.deviceId === 'dev-exec'), true)

  // reset 必须带全量：从 seq 0 起的每一条都要在回填里
  const backfillBatch = sent.find((b) => b.body.reset === true)
  assert.equal(backfillBatch.body.events[0].seq, 0, 'reset 批必须从 seq 0 开始')
  assert.equal(Math.max(...sent.flatMap((b) => b.body.events.map((e) => e.seq))), 4, '回填+实时必须覆盖到最后一条')

  // 游标落盘：重建 sender 后不再回填
  const cursorFile = path.join(meshDir, 'session-mirror.json')
  assert.equal(fs.existsSync(cursorFile), true)
  const stored = JSON.parse(fs.readFileSync(cursorFile, 'utf8'))
  assert.equal(stored.cursors[0].sessionId, sessionId)
  assert.equal(stored.cursors[0].cursorSeq, 4)
  assert.equal(stored.cursors[0].backfilled, true)

  const sent2 = []
  const reborn = new SessionMirrorSender({
    meshDir, selfDeviceId: 'dev-self', sessionsRoot, flushMs: 5, batchEvents: 2,
    resolveTarget: () => 'dev-exec',
    send: async (deviceId, body) => { sent2.push(body); return { ok: true } },
  })
  reborn.observe(session, { type: 'step/end', seq: 5, time: 15, data: {} })
  await reborn.flush()
  assert.equal(sent2.length, 1)
  assert.equal(sent2[0].reset, false)
  assert.deepEqual(sent2[0].events.map((e) => e.seq), [5], '已回填过的会话只推新事件')

  sender.stop()
  reborn.stop()
  fs.rmSync(meshDir, { recursive: true, force: true })
  fs.rmSync(sessionsRoot, { recursive: true, force: true })
})

await aok('大事件不被丢：460 KB 的 assistant 消息照常入镜像', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], {})
  const big = { type: 'assistant/message', seq: 0, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(460 * 1024) }] } } }
  const stored = store.append({ deviceId: 'dev', sessionId: 'session-big', events: [big], fromSeq: 0, toSeq: 0, reset: true })
  assert.equal(stored.stored, 1, '460 KB 的事件必须被存下来（上限 4 MB）')
  assert.equal(stored.dropped, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('Sender：本机执行的目标不推；重复 seq 不重复入队', async () => {
  const meshDir = tmp()
  const sessionsRoot = tmp()
  const sent = []
  const sender = new SessionMirrorSender({
    meshDir, selfDeviceId: 'dev-self', sessionsRoot, flushMs: 5,
    resolveTarget: () => null,
    send: async (deviceId, body) => { sent.push(body); return { ok: true } },
  })
  sender.observe({ id: 'session-local', header: { id: 'session-local', cwd: '/root/local' } }, { type: 'a/b', seq: 0 })
  await sender.flush()
  assert.equal(sent.length, 0)
  assert.equal(sender.status().counters.skipped, 1)

  const remote = new SessionMirrorSender({
    meshDir, selfDeviceId: 'dev-self', sessionsRoot, flushMs: 5,
    resolveTarget: () => 'dev-exec',
    send: async (deviceId, body) => { sent.push(body); return { ok: true } },
  })
  const session = { id: 'session-remote', header: { id: 'session-remote', cwd: '/root/remote' } }
  remote.observe(session, { type: 'a/b', seq: 0 })
  remote.observe(session, { type: 'a/b', seq: 0 })
  remote.observe(session, { type: 'a/b', seq: 1 })
  await remote.flush()
  const events = sent.flatMap((b) => b.events.map((e) => e.seq))
  assert.deepEqual(events, [0, 1])
  remote.stop()
  sender.stop()
  fs.rmSync(meshDir, { recursive: true, force: true })
  fs.rmSync(sessionsRoot, { recursive: true, force: true })
})

await aok('Sender：发送失败时批不丢、计数 +1；恢复后重发成功', async () => {
  const meshDir = tmp()
  const sessionsRoot = tmp()
  let failNext = true
  const sent = []
  const sender = new SessionMirrorSender({
    meshDir, selfDeviceId: 'dev-self', sessionsRoot, flushMs: 5,
    resolveTarget: () => 'dev-exec',
    send: async (deviceId, body) => {
      if (failNext) throw new Error('link down')
      sent.push(body)
      return { ok: true }
    },
  })
  const session = { id: 'session-retry', header: { id: 'session-retry', cwd: '/root/remote' } }
  sender.observe(session, { type: 'a/b', seq: 0 })
  await sender.flush()
  assert.equal(sender.status().counters.failed, 1)
  assert.equal(sender.status().pending, 1)
  failNext = false
  await sender.flush()
  assert.equal(sender.status().pending, 0)
  assert.deepEqual(sent.flatMap((b) => b.events.map((e) => e.seq)), [0])
  sender.stop()
  fs.rmSync(meshDir, { recursive: true, force: true })
  fs.rmSync(sessionsRoot, { recursive: true, force: true })
})

// ── 4. 进度与接管（执行端能看见什么、能不能接手）────────────────────────────
ok('summarizeEvent：有信息量的类型给人话，噪声类型不覆盖', () => {
  assert.equal(summarizeEvent({ type: 'turn/start', seq: 0, time: 5, data: { turn: 3 } }).summary, '第 3 轮开始')
  assert.equal(summarizeEvent({ type: 'turn/end', seq: 1, time: 6, data: { turn: 3, reason: { kind: 'completed' } } }).summary, '本轮结束（completed）')
  assert.equal(summarizeEvent({ type: 'tool/call', seq: 2, time: 7, data: { name: 'bash' } }).summary, '调用工具 bash')
  assert.equal(summarizeEvent({ type: 'user/message', seq: 3, time: 8, data: { content: [{ type: 'text', text: '跑一下' }] } }).summary, '收到用户消息：跑一下')
  assert.equal(summarizeEvent({ type: 'assistant/message', seq: 4, time: 9, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } } }).summary, '助手：好')
  // 只有 reasoning 的一轮：说「思考中」比留空有用
  assert.equal(summarizeEvent({ type: 'assistant/message', seq: 5, time: 10, data: { message: { content: [{ type: 'reasoning', text: '想' }] } } }).summary, '助手思考中：想')
  // 噪声类型：返回 null，调用方保留上一条摘要
  assert.equal(summarizeEvent({ type: 'step/end', seq: 6, time: 11, data: { turn: 1, step: 2 } }), null)
  assert.equal(summarizeEvent(null), null)
})

ok('sanitizeSessionHeader：只留白名单字段，巨串与异物丢弃', () => {
  const head = sanitizeSessionHeader({
    type: 'session', version: 4, id: 'session-x', createdAt: 7, cwd: '/root/ws',
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    junk: 'x'.repeat(5000), nested: { a: 1 }, id2: 5,
  })
  assert.deepEqual(Object.keys(head).sort(), ['agentPreset', 'createdAt', 'cwd', 'delegationDepth', 'id', 'isSeeded', 'type', 'version'])
  assert.equal(sanitizeSessionHeader(null), null)
  assert.equal(sanitizeSessionHeader('x'), null)
  assert.equal(sanitizeSessionHeader({ junk: 1 }), null)
})

ok('inferFormatVersion：v4 独立 tool 消息 / v3 tool-result 包装 / 两代混杂不猜', () => {
  const v4Events = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/result', seq: 1, data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const v3Events = [
    { type: 'tool/result', seq: 1, data: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } },
  ]
  assert.equal(inferFormatVersion(v4Events), 4)
  assert.equal(inferFormatVersion(v3Events), 3)
  assert.equal(inferFormatVersion([{ type: 'turn/start', seq: 0, data: { turn: 1 } }]), null)
  assert.equal(inferFormatVersion([...v3Events, ...v4Events]), null)
})

ok('buildSessionLogBytes：头行在前、逐行独立帧、版本写进文件名与头行', () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'tool/result', seq: 1, time: 2, data: { message: { role: 'tool', toolCallId: 'c1', content: [] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const built = buildSessionLogBytes({ id: 'session-t', cwd: '/root/ws', createdAt: 9 }, events)
  assert.equal(built.ok, true)
  assert.equal(built.version, 4, '没有头版本时按事件形状推断')
  assert.equal(built.lines, 4, '头行 + 3 条事件')
  const decoded = decodeZstdLog(built.bytes)
  assert.equal(decoded.frames, 4, '每行一个独立帧（DSH 的原生容器形状）')
  assert.equal(decoded.failed, 0)
  const rows = decoded.text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  // 头行必须**只有**出厂允许的键：多一个（如会话对象上的 title）会让出厂读取器
  // 判成「第一行不是会话头」，整条会话打不开。
  assert.deepEqual(rows[0], {
    type: 'session', version: 4, id: 'session-t', cwd: '/root/ws',
    createdAt: 9, isSeeded: false, delegationDepth: 0,
  })
  assert.deepEqual(rows.slice(1).map((row) => row.seq), [0, 1, 2])
  // 头里多带的字段（title）被丢掉，而不是写进物理头
  const withTitle = buildSessionLogBytes({ id: 'session-t', cwd: '/root/ws', createdAt: 9, version: 4, title: '不该出现' }, [])
  assert.equal(Object.hasOwn(JSON.parse(decodeZstdLog(withTitle.bytes).text.trim()), 'title'), false)
  // 版本写在头里时以头为准（权威），且必须与文件名一致
  const asV3 = buildSessionLogBytes({ id: 'session-t', cwd: '/root/ws', version: 3 }, [])
  assert.equal(asV3.version, 3)
  assert.equal(JSON.parse(decodeZstdLog(asV3.bytes).text.trim()).version, 3)
  // 判不出世代、缺 id、cwd 非绝对：拒绝，而不是写一份读不出来的日志
  assert.equal(buildSessionLogBytes({ id: 'session-t', cwd: '/root/ws' }, [{ type: 'turn/start', seq: 0 }]).ok, false)
  assert.equal(buildSessionLogBytes({ cwd: '/root/ws', version: 4 }, []).ok, false)
  assert.equal(buildSessionLogBytes({ id: 'session-t', version: 4 }, []).ok, false)
  assert.equal(buildSessionLogBytes({ id: 'session-t', cwd: 'relative/ws', version: 4 }, []).ok, false)
})

ok('buildSessionLogBytes：分叉会话照常落地（isSeeded + parentSession 原样写回）', () => {
  // 设备上实测过：带 isSeeded/parentSession 的头，出厂恢复器照收 —— 那个「继承事件数」
  // 不在物理头里（isHeaderLine 的允许键集里没有它），所以这里不再拒绝。
  const header = {
    type: 'session', version: 4, id: 'session-seed', createdAt: 11, cwd: '/root/nas/ArkTower',
    parentSession: 'session-parent-1', isSeeded: true, delegationDepth: 0, agentPreset: 'cordis',
  }
  const built = buildSessionLogBytes(header, [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
  assert.equal(built.ok, true)
  const head = JSON.parse(decodeZstdLog(built.bytes).text.split('\n')[0])
  assert.equal(head.isSeeded, true)
  assert.equal(head.parentSession, 'session-parent-1')
  assert.equal(head.agentPreset, 'cordis')
  assert.equal(head.version, 4)
})

await aok('ReplicaStore：会话头与进度摘要进索引；reset 清摘要；find 认两代命名', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxEventBytes: 4096 })
  const header = { type: 'session', version: 4, id: 'session-prog', createdAt: 5, cwd: '/root/ws', title: '进度' }
  store.append({
    deviceId: 'dev-src', sessionId: 'session-prog', workspacePath: '/root/ws', header,
    events: [
      { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 1, time: 2, data: { name: 'bash' } },
    ],
    fromSeq: 0, toSeq: 1, reset: true,
  })
  const entry = store.find('session-prog')
  assert.notEqual(entry, null)
  assert.equal(entry.header.version, 4)
  assert.equal(entry.header.id, 'session-prog')
  // 物理头里没有 title（出厂头不允许这个键），索引层的 title 另有其字段
  assert.equal(Object.hasOwn(entry.header, 'title'), false)
  assert.equal(entry.title, '进度')
  assert.equal(entry.lastEventType, 'tool/call')
  assert.equal(entry.lastSummary, '调用工具 bash')
  // 噪声事件刷新「最近事件」但不覆盖摘要
  store.append({ deviceId: 'dev-src', sessionId: 'session-prog', events: [{ type: 'step/end', seq: 2, time: 3, data: { turn: 1, step: 1 } }], fromSeq: 2, toSeq: 2 })
  assert.equal(store.find('session-prog').lastEventType, 'step/end')
  assert.equal(store.find('session-prog').lastSummary, '调用工具 bash')
  // 去掉前缀也能查到（镜像目录里两代命名并存）
  assert.equal(store.find('prog'), store.find('session-prog'))
  const rows = store.progress({ now: Date.now(), liveWindowMs: 60000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].live, true)
  assert.equal(rows[0].headerVersion, 4)
  assert.equal(rows[0].hasHeader, true)
  assert.equal(rows[0].lastSeq, 2)
  // reset 之后摘要清空（对端会重推全量）
  store.append({ deviceId: 'dev-src', sessionId: 'session-prog', header, events: [{ type: 'turn/start', seq: 0, time: 4, data: { turn: 1 } }], fromSeq: 0, toSeq: 0, reset: true })
  assert.equal(store.find('session-prog').lastEventType, 'turn/start')
  assert.equal(store.find('session-prog').lastSummary, '第 1 轮开始')
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('接管落地：镜像事件重压 → 出厂可读日志（头行版本与事件形状一致）', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxEventBytes: 4096 })
  const header = { type: 'session', version: 4, id: 'session-take', createdAt: 11, cwd: '/root/DSHpluginWorkSpace' }
  store.append({
    deviceId: 'dev-src', sessionId: 'session-take', workspacePath: '/root/DSHpluginWorkSpace', header,
    events: [
      { type: 'user/message', seq: 0, time: 100, data: { content: [{ type: 'text', text: '继续' }] } },
      { type: 'tool/result', seq: 1, time: 101, data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] } } },
    ],
    fromSeq: 0, toSeq: 1, reset: true,
  })
  const entry = store.find('session-take')
  const built = buildSessionLogBytes(entry.header, store.readEvents(entry))
  assert.equal(built.ok, true)
  assert.equal(built.version, 4)
  const rows = decodeZstdLog(built.bytes).text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(rows.length, 3)
  assert.equal(rows[0].type, 'session')
  assert.equal(rows[0].version, 4)
  assert.equal(rows[0].id, 'session-take')
  // 事件逐条保留（seq/type/data 一个不少）——落地的是历史，不是摘要
  assert.deepEqual(rows.slice(1).map((row) => row.seq), [0, 1])
  assert.equal(rows[2].data.message.toolCallId, 'c1')
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('同步信号：只有「新接受的 turn/end」才算一次运行结束', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxEventBytes: 4096 })
  const sessionId = 'session-sync'
  // 跑到一半（step/end）不算：那时同步过去只会得到半截历史。
  const mid = store.append({
    deviceId: 'dev-src', sessionId, reset: true,
    events: [{ type: 'step/end', seq: 0, time: 1, data: { turn: 1, step: 1 } }],
    fromSeq: 0, toSeq: 0,
  })
  assert.equal(mid.syncWanted, false)
  assert.equal(mid.lastSeq, 0)
  const ended = store.append({
    deviceId: 'dev-src', sessionId,
    events: [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }],
    fromSeq: 1, toSeq: 1,
  })
  assert.equal(ended.syncWanted, true, 'turn/end 到了就要同步')
  // 重投同一批（网络重试）不算新的运行结束
  const replay = store.append({
    deviceId: 'dev-src', sessionId,
    events: [{ type: 'turn/end', seq: 1, time: 2, data: { turn: 1 } }],
    fromSeq: 1, toSeq: 1,
  })
  assert.equal(replay.stored, 0)
  assert.equal(replay.syncWanted, false, '重复投递的 turn/end 不该再触发一次同步')
  fs.rmSync(dir, { recursive: true, force: true })
})

await aok('同步记账：synced 只在追平镜像时为真；跳过/失败不清掉上一次成功', async () => {
  const dir = tmp()
  const store = new SessionReplicaStore(dir, [], { maxEventBytes: 4096 })
  const sessionId = 'session-sync2'
  store.append({
    deviceId: 'dev-src', sessionId, reset: true,
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1 } },
    ],
    fromSeq: 0, toSeq: 1,
  })
  assert.equal(store.progress()[0].synced, false, '还没同步过 → synced 为假')
  assert.equal(store.recordSync(sessionId, { at: '2026-10-15T00:00:00.000Z', seq: 1, bytes: 123, version: 'v4' }), true)
  let row = store.progress()[0]
  assert.equal(row.synced, true, '追平镜像 → synced 为真')
  assert.equal(row.syncedBytes, 123)
  assert.equal(row.syncedVersion, 'v4')
  // 又来了一批 → 本机那份落后了
  store.append({
    deviceId: 'dev-src', sessionId,
    events: [{ type: 'turn/start', seq: 2, time: 3, data: { turn: 2 } }],
    fromSeq: 2, toSeq: 2,
  })
  assert.equal(store.progress()[0].synced, false, '镜像又前进了 → 本机那份落后')
  // 跳过（例如本机正在跑）不该把上一次成功的记录抹掉
  store.recordSync(sessionId, { skipped: '本机正在跑这条会话' })
  row = store.progress()[0]
  assert.equal(row.syncSkipped, '本机正在跑这条会话')
  assert.equal(row.syncedAt, '2026-10-15T00:00:00.000Z', '跳过不清掉上一次成功时间')
  assert.equal(row.syncedSeq, 1)
  assert.equal(row.synced, false, '跳过之后仍然落后')
  // 失败同理，且错误可见
  store.recordSync(sessionId, { error: '镜像不足以落地：unknown-format-version' })
  row = store.progress()[0]
  assert.equal(row.syncError, '镜像不足以落地：unknown-format-version')
  assert.equal(row.syncedAt, '2026-10-15T00:00:00.000Z')
  assert.equal(store.recordSync('session-不存在', { seq: 1 }), false, '没有这条镜像时记账返回 false')
  // 同步状态落盘（重启后仍在）
  const reopened = new SessionReplicaStore(dir, [], {})
  const restored = reopened.find(sessionId)
  assert.equal(restored.syncedSeq, 1)
  assert.equal(restored.syncError, '镜像不足以落地：unknown-format-version')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n  MIRROR SELFTEST PASS (${n} checks)`)