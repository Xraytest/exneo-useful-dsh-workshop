#!/usr/bin/env node
/**
 * tests/tui_host_selftest.mjs —— v2.6.1：dsh-TUI 宿主半边（src/tui-host.ts，契约 v2.3 增补 §S6）
 *
 * 不需要 Blender，也不需要 dsh-TUI：宿主接缝全用假的，后端用一个假 HTTP 服务 + 一个真 runtime/server.mjs。
 *   A 草稿文本与 Web 客户端（lib/client.js）**逐字一致**（两份实现，靠这里对拍防漂移）
 *   B chip 标题
 *   C 选中桥的 CAS 语义：挂上才 consume(ok)；挂不上重试、第 3 次 consume(ok:false)；空选中直接 consume(ok:false)
 *   D 页脚字段：每种通道状态 → 文本 / tone / 悬停说明
 *   E @ 提及条目（模型文本与 Web codec 同口径）
 *   F /blender status|jobs|doctor|未知子命令
 *   G 接线：宿主没有接缝时零注册；有接缝时各块注册、卸载时清掉
 *   H 真后端 GET /host/state（零 Blender 往返）
 *
 * 用法：node tests/tui_host_selftest.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')
const T = await import('../lib/tui-host.js')

let pass = 0, fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : (' — ' + String(detail).slice(0, 300)))) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('== dsh-TUI 宿主半边自检（v2.6.1）==')

// ── A：与 Web 客户端逐字一致
let client = null
try {
  let mod = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (def) => { mod = def } },
      fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve(null) }),
      setTimeout: () => 0, clearTimeout: () => undefined,
      localStorage: { getItem: () => null, setItem: () => undefined },
    },
    console, Promise, JSON, Math, Date,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(PKG, 'lib', 'client.js'), 'utf8'), sandbox, { timeout: 10000 })
  client = mod.factory(() => ({ createElement: () => null, useEffect: () => undefined, useRef: (v) => ({ current: v }) })).__selftest
} catch (e) { client = null }
ok('lib/client.js 的 __selftest 可取到', !!(client && typeof client.selectionMessageText === 'function'))

const many = Array.from({ length: 30 }, (_, i) => 'Part_' + String(i))
const FIXTURES = [
  { selection: { names: ['Cube'], count: 1, active: 'Cube', mode: 'OBJECT' } },
  { selection: { names: ['Wheel_FL', 'Wheel_FR', 'Axle'], count: 3, active: 'Axle', mode: 'OBJECT',
    collections: [{ name: 'Chassis', count: 2 }, { name: 'Wheels', count: 9 }] } },
  { selection: { names: many, count: 412, truncated: true, active: 'Part_0', mode: 'OBJECT' } },
  { selection: { count: 3, names: ['a', 'b'], truncated: true } },
  { selection: { kind: 'collection', collection: 'Engine', count: 57, names: many, truncated: true } },
  { selection: { kind: 'collection', collection: 'Empty', count: 0, names: [] } },
  { selection: { kind: 'collection', names: ['x'] } },
  { selection: { names: ['Body'], count: 1, sub: { type: 'MESH', object: 'Body', counts: { vertices: 20, edges: 3, faces: 1 },
    indices: { vertices: Array.from({ length: 20 }, (_, i) => i), edges: [1, 2, 3], faces: [7] } } } },
  { selection: { names: ['Rig'], sub: { type: 'ARMATURE', object: 'Rig', mode: 'POSE', bones: ['spine', 'neck'], counts: { bones: 2 } } } },
  { selection: { names: ['Rig'], sub: { type: 'ARMATURE', object: 'Rig', mode: 'EDIT', bones: many, truncated: true } } },
  { selection: { names: ['Path'], sub: { type: 'CURVE', object: 'Path', mode: 'EDIT_CURVE', points: [[0, 1], [0, 2], [1, 0]], counts: { points: 3 } } } },
  { selection: { names: ['Lat'], sub: { type: 'LATTICE', object: 'Lat', mode: 'EDIT_LATTICE', points: [4, 5] } } },
  { selection: { names: ['Txt'], sub: { type: 'OTHER', object: 'Txt', mode: 'EDIT_TEXT', note: '文本编辑模式不展开字符' } } },
  { selection: { names: [] } },
  { selection: null },
  {},
]
if (client) {
  const diffs = FIXTURES.map((f, i) => [i, T.selectionMessageText(f), client.selectionMessageText(f)]).filter(([, a, b]) => a !== b)
  ok('16 组选中 payload 的草稿文本与 Web 客户端逐字一致', diffs.length === 0, JSON.stringify(diffs[0]))
}
ok('空选中 → null', T.selectionMessageText({ selection: { names: [] } }) === null)

// ── B：chip 标题
ok('单个对象：标题带名字', T.selectionChipTitle({ names: ['Cube'], count: 1 }) === 'Blender 选中 · Cube')
ok('多个对象：标题带件数', T.selectionChipTitle({ names: ['a', 'b'], count: 412 }) === 'Blender 选中 · 412 件')
ok('集合：名字 + 件数', T.selectionChipTitle({ kind: 'collection', collection: 'Engine', count: 57 }) === 'Blender 集合 · Engine（57 件）')
ok('子元素：对象名', T.selectionChipTitle({ names: ['Body'], sub: { type: 'MESH', object: 'Body' } }) === 'Blender 子元素 · Body')
ok('超长名字截断', T.selectionChipTitle({ names: ['x'.repeat(80)], count: 1 }).length <= 40)

// ── 假后端（selection / state / jobs / doctor / scene-items）
const fake = { latest: null, consumed: [], state: null, jobs: null, doctor: null, items: null, lastQuery: null, itemFetches: 0, itemDelayMs: 0 }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method === 'POST' && u.pathname === '/host/selection/consume') {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      const b = JSON.parse(raw || '{}')
      fake.consumed.push(b)
      if (fake.latest && b.seq >= fake.latest.seq) fake.latest = Object.assign({}, fake.latest, { unconsumed: false })
      send(200, { ok: true, consumed_seq: b.seq })
    })
    return
  }
  if (u.pathname === '/host/selection/latest') return send(200, fake.latest || { ok: true, seq: 0, unconsumed: false })
  if (u.pathname === '/host/state') return fake.state ? send(200, fake.state) : (res.destroy(), undefined)
  if (u.pathname === '/host/jobs') return send(200, fake.jobs || { ok: true, jobs: [], running: 0, total: 0 })
  if (u.pathname === '/doctor') return send(200, fake.doctor || { ok: false, addon: { kind: 'blender-unreachable' } })
  if (u.pathname === '/host/scene-items') {
    fake.lastQuery = u.searchParams.get('q'); fake.itemFetches++
    setTimeout(() => send(200, fake.items || { ok: true, objects: [], materials: [], collections: [] }), fake.itemDelayMs)
    return
  }
  send(404, { ok: false })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const FPORT = srv.address().port

// ── C：选中桥
const sel3 = { names: ['Wheel_FL', 'Wheel_FR', 'Axle'], count: 3, active: 'Axle', mode: 'OBJECT' }
const attaches = []
const toasts = []
let attachResult = true
const chips = { attachContext: (x) => { attaches.push(x); return attachResult } }
const notify = (text, color) => { toasts.push([text, color]) }
const state = { lastSeq: 0, fails: 0 }
const tick = () => T.selectionTick({ port: FPORT, chips, notify, state })

fake.latest = { ok: true, seq: 1, unconsumed: true, selection: sel3 }
await tick()
ok('挂上 chip：key=selection、标题带件数、内容是草稿文本', attaches.length === 1 && attaches[0].key === 'selection'
  && attaches[0].title === 'Blender 选中 · 3 件' && attaches[0].content === T.selectionMessageText({ selection: sel3 }), JSON.stringify(attaches))
ok('挂上后 consume(ok:true, how:tui-chip)', fake.consumed.length === 1 && fake.consumed[0].seq === 1 && fake.consumed[0].ok === true
  && fake.consumed[0].how === 'tui-chip', JSON.stringify(fake.consumed))
ok('toast 提示「未发送」', toasts.length === 1 && /未发送/.test(toasts[0][0]) && toasts[0][1] === 'success', JSON.stringify(toasts))
await tick()
ok('同一 seq 不重复挂', attaches.length === 1 && fake.consumed.length === 1)

attachResult = false
fake.latest = { ok: true, seq: 2, unconsumed: true, selection: sel3 }
await tick(); await tick()
ok('挂不上：前两次不 consume、只提示一次', fake.consumed.length === 1 && attaches.length === 3 && toasts.length === 2 && toasts[1][1] === 'warning', JSON.stringify([fake.consumed, toasts]))
await tick()
ok('第 3 次挂不上 → consume(ok:false, reason)', fake.consumed.length === 2 && fake.consumed[1].seq === 2 && fake.consumed[1].ok === false
  && /没挂上/.test(fake.consumed[1].reason), JSON.stringify(fake.consumed[1]))

attachResult = true
fake.latest = { ok: true, seq: 3, unconsumed: true, selection: { names: [] } }
await tick()
ok('空选中不挂 chip、直接 consume(ok:false)', attaches.length === 4 && fake.consumed.length === 3 && fake.consumed[2].ok === false
  && /空选中/.test(fake.consumed[2].reason), JSON.stringify(fake.consumed[2]))

let threw = null
try { await T.selectionTick({ port: FPORT, chips: { attachContext: () => { throw new Error('boom') } }, state: { lastSeq: 0, fails: 0 } }) } catch (e) { threw = e }
fake.latest = { ok: true, seq: 4, unconsumed: true, selection: sel3 }
try { await T.selectionTick({ port: FPORT, chips: { attachContext: () => { throw new Error('boom') } }, state: { lastSeq: 0, fails: 0 } }) } catch (e) { threw = e }
try { await T.selectionTick({ port: 1, chips, state: { lastSeq: 0, fails: 0 } }) } catch (e) { threw = e }
ok('attachContext 抛错 / 后端不可达都不抛', threw === null, threw && threw.stack)

// ── D：页脚字段
const HOLDER = 'plugin-pid-1'
const okState = (over) => Object.assign({ ok: true, channel: { lastOkAgeMs: 800, diagnosis: null, aiPaused: false }, lease: { active: false },
  render: { busy: false }, jobs: { running: 0 } }, over || {})
const F = (s) => T.footerField(s, HOLDER, 9877)
ok('后端不可达 → Blender ○ / dim', F(null).text === 'Blender ○' && F(null).tone === 'dim' && /9877/.test(F(null).detail))
ok('一切正常 → Blender ● / success', F(okState()).text === 'Blender ●' && F(okState()).tone === 'success')
ok('作业在跑 → 文本带作业数', F(okState({ jobs: { running: 2 } })).text === 'Blender ● · 作业 2')
ok('AI 暂停优先', F(okState({ channel: { lastOkAgeMs: 1, aiPaused: true }, render: { busy: true } })).text === 'Blender ⏸ AI 暂停'
  && F(okState({ channel: { lastOkAgeMs: 1, aiPaused: true } })).tone === 'warning')
ok('渲染中', F(okState({ render: { busy: true, ageMs: 12000 } })).text === 'Blender ● 渲染中' && /12 s/.test(F(okState({ render: { busy: true, ageMs: 12000 } })).detail))
ok('主线程忙', F(okState({ channel: { lastOkAgeMs: 1, diagnosis: 'main-thread-busy' } })).text === 'Blender ● 忙')
ok('从没连上 → 未连接', F(okState({ channel: { lastOkAgeMs: null } })).text === 'Blender ○ 未连接')
ok('blender-unreachable → 未连接', F(okState({ channel: { lastOkAgeMs: 5, diagnosis: 'blender-unreachable' } })).text === 'Blender ○ 未连接')
ok('别的会话持有租约 → 他人租约', F(okState({ lease: { active: true, holder: 'plugin-pid-2' } })).text === 'Blender ● 他人租约')
ok('本会话持有租约 → 正常且悬停说明里写明', F(okState({ lease: { active: true, holder: HOLDER } })).text === 'Blender ●'
  && /本会话持有写租约/.test(F(okState({ lease: { active: true, holder: HOLDER } })).detail))
const allTexts = [null, okState(), okState({ jobs: { running: 99 } }), okState({ channel: { aiPaused: true } }), okState({ render: { busy: true }, jobs: { running: 3 } })]
  .map((s) => F(s).text)
ok('页脚文本都 ≤ 24 个字符', allTexts.every((t) => t.length <= 24), JSON.stringify(allTexts))

// ── E：@ 提及
const items = T.mentionItems({ ok: true, objects: [{ name: 'Cube', type: 'MESH' }, { name: 'Lamp' }], materials: [{ name: 'Red' }], collections: [{ name: 'Engine' }] })
ok('对象 / 材质 / 集合都映射成条目', items.length === 4 && items[0].label === 'Cube' && items[0].detail === 'MESH' && items[1].detail === 'OBJECT'
  && items[2].detail === '材质' && items[3].detail === '集合', JSON.stringify(items))
ok('插入文本与 Web codec 同口径', items[0].insertText === '<blender-object>Cube</blender-object>' && items[2].insertText === '<blender-material>Red</blender-material>'
  && items[3].insertText === '<blender-collection>Engine</blender-collection>')
ok('插入文本不以 @ 开头（不会被当成文件提及）', items.every((it) => !it.insertText.startsWith('@')))
ok('最多 50 条', T.mentionItems({ ok: true, objects: Array.from({ length: 80 }, (_, i) => ({ name: 'o' + String(i) })) }).length === 50)
ok('坏响应 → []', T.mentionItems(null).length === 0 && T.mentionItems({ ok: false }).length === 0)
ok('本地过滤：不分大小写、空 query 给前 50 条', T.filterMentionItems(items, 'cU').length === 1 && T.filterMentionItems(items, '').length === 4
  && T.filterMentionItems(Array.from({ length: 80 }, (_, i) => ({ label: 'o' + String(i) })), '').length === 50)
{
  // 冷启动超时：宿主 300 ms 就 abort；这次回空，但缓存在后台填上，下一次立即有结果
  fake.items = { ok: true, objects: [{ name: 'Wheel_FL', type: 'MESH' }], materials: [], collections: [] }
  fake.itemDelayMs = 600
  fake.itemFetches = 0
  const src = T.createSceneMentionSource(FPORT)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const t0 = Date.now()
  const cold = await src('whe', ac.signal)
  ok('冷启动：宿主 abort 时立刻回空（不拖住输入）', cold.length === 0 && Date.now() - t0 < 500, String(Date.now() - t0))
  await sleep(500)
  const warm = await src('whe', new AbortController().signal)
  ok('冷启动之后：缓存已填上，立即有结果、没有第二次拉取', warm.length === 1 && fake.itemFetches === 1, JSON.stringify([warm, fake.itemFetches]))
  fake.itemDelayMs = 0
}

// ── F：/blender 命令
const opts = { port: FPORT, holder: HOLDER }
fake.state = okState({ jobs: { running: 1 }, channel: { lastOkAgeMs: 2000, lastCmd: 'execute_code', inflight: 0, lastError: 'boom', lastErrorAgeMs: 61000 } })
const st = await T.blenderCommand('', opts)
ok('/blender（默认 status）列出通道 / 租约 / 渲染 / 作业 / 最近错误', st.kind === 'success' && /通道：上次成功 2 s 前/.test(st.text) && /租约：空闲/.test(st.text)
  && /作业：1 个在跑/.test(st.text) && /最近错误（1 min 前）：boom/.test(st.text), st.text)
fake.jobs = { ok: true, running: 1, total: 2, jobs: [{ id: 'job-1', status: 'running', ms: 42000, script: '/tmp/a/bake.py' }, { id: 'job-0', status: 'done', ms: 1000 }] }
const jb = await T.blenderCommand('jobs', opts)
ok('/blender jobs 列出作业', jb.kind === 'success' && /job-1 · running · 42 s · bake\.py/.test(jb.text) && /job-0 · done/.test(jb.text), jb.text)
fake.doctor = { ok: true, addon: { kind: 'ok', summary: '通道健康', fix: '无需处理' } }
const dr = await T.blenderCommand('doctor', opts)
ok('/blender doctor 给诊断 / 结论 / 修法', dr.kind === 'success' && /诊断：ok/.test(dr.text) && /结论：通道健康/.test(dr.text), dr.text)
ok('未知子命令 → error 并列出可用的', (await T.blenderCommand('nope', opts)).kind === 'error')
const down = await T.blenderCommand('status', { port: 1, holder: HOLDER })
ok('后端不可达时 status 也能回话（不抛）', down.kind === 'success' && /后端未运行/.test(down.text), down.text)

// ── G：接线
function fakeCtx(services) {
  const effects = []
  const regs = []
  const mk = () => ({
    effect(fn, label) { const d = fn(); effects.push([label, d]); return d },
    get(name) { return services[name] },
  })
  const ctx = Object.assign(mk(), {
    inject(names, cb) { if (names.every((n) => services[n])) { const c = mk(); for (const n of names) c[n] = services[n]; cb(c) } },
  })
  return { ctx, effects, regs }
}
{
  const { ctx, effects } = fakeCtx({})
  T.registerTuiHost(ctx, opts)
  ok('宿主没有任何接缝 → 零注册、零轮询', effects.length === 0)
}
{
  const fields = []
  const reg = { commands: [], mentions: [], trees: [] }
  const services = {
    tuiStatus: { setField: (k, t, o) => { fields.push([k, t, o]); return () => fields.push([k, '<cleared>']) } },
    tuiMentions: { register: (p) => { reg.mentions.push(p); return () => reg.mentions.push('<disposed>') } },
    commands: { register: (d) => { reg.commands.push(d); return () => reg.commands.push('<disposed>') } },
    tuiCommandTrees: { register: (p) => { reg.trees.push(p); return () => reg.trees.push('<disposed>') } },
  }
  fake.state = okState()
  const { ctx, effects } = fakeCtx(services)
  T.registerTuiHost(ctx, opts)
  await sleep(300)
  ok('页脚字段写在 right-head、带悬停说明', fields.length >= 1 && fields[0][0] === 'blender' && fields[0][1] === 'Blender ●'
    && fields[0][2].slot === 'right-head' && fields[0][2].tone === 'success' && !!fields[0][2].detail, JSON.stringify(fields))
  ok('/blender 命令注册（带输入提示）', reg.commands.length === 1 && reg.commands[0].name === 'blender' && typeof reg.commands[0].handler === 'function'
    && /status/.test(reg.commands[0].input.hint))
  ok('子命令补全：/blender 下列 status/doctor/jobs', reg.trees.length === 1 && reg.trees[0].root === 'blender'
    && reg.trees[0].children(['blender']).map((n) => n.name).join(',') === 'status,doctor,jobs' && reg.trees[0].children(['blender', 'status']).length === 0)
  ok('@ 提及提供方注册（id=blender）', reg.mentions.length === 1 && reg.mentions[0].id === 'blender' && reg.mentions[0].title === 'Blender')
  fake.items = { ok: true, objects: [{ name: 'Wheel_FL', type: 'MESH' }, { name: 'Body', type: 'MESH' }], materials: [], collections: [] }
  fake.itemFetches = 0
  const got = await reg.mentions[0].complete('whe', new AbortController().signal)
  ok('提及：首查拉全量（q 为空）再本地过滤', fake.lastQuery === '' && got.length === 1 && got[0].insertText === '<blender-object>Wheel_FL</blender-object>', JSON.stringify([fake.lastQuery, got]))
  const again = await reg.mentions[0].complete('bo', new AbortController().signal)
  ok('提及：5 s 内再查走缓存（不再碰后端）', fake.itemFetches === 1 && again.length === 1 && again[0].label === 'Body', JSON.stringify([fake.itemFetches, again]))
  ok('命令 handler 走 rawInput', /诊断/.test((await reg.commands[0].handler({ rawInput: ' doctor', signal: new AbortController().signal })).text))
  ok('doctor 摘要列出接上的接缝', /页脚 ✅/.test(T.tuiHostSummary()) && /\/blender ✅/.test(T.tuiHostSummary()), T.tuiHostSummary())
  for (const [, d] of effects.reverse()) if (typeof d === 'function') d()
  ok('卸载：页脚清掉、提及 / 命令 / 补全都注销', fields[fields.length - 1][1] === '<cleared>' && reg.mentions.includes('<disposed>')
    && reg.commands.includes('<disposed>') && reg.trees.includes('<disposed>'), JSON.stringify(fields.slice(-1)))
}
{
  const { ctx, effects } = fakeCtx({ tuiStatus: { set: () => () => {} } })
  T.registerTuiHost(ctx, opts)
  ok('旧版 tuiStatus（没有 setField）→ 不注册页脚', effects.length === 0)
}
{
  const { ctx } = fakeCtx({ tuiMentions: { register: () => { throw new TypeError('duplicate provider') } } })
  let threw = null
  try { T.registerTuiHost(ctx, opts) } catch (e) { threw = e }
  ok('tuiMentions.register 抛错（重复 / 超额）→ 不往外抛、doctor 里显示未接上', threw === null && !/@ 提及 ✅/.test(T.tuiHostSummary()), threw && threw.message)
}
{
  // toast 必须在 tuiToast 自己的 inject 里调（dsh-TUI 按异步上下文认调用方）：选中桥只排队，由 toast 那块的定时器发
  const shown = []
  const staged = []
  const services = {
    tuiContextChips: { attachContext: (x) => { staged.push(x); return true } },
    tuiToast: { show: (text, o) => { shown.push([text, o && o.color]); return true } },
  }
  fake.latest = { ok: true, seq: 99, unconsumed: true, selection: sel3 }
  const { ctx, effects } = fakeCtx(services)
  T.registerTuiHost(ctx, opts)
  await sleep(700)
  ok('接线：选中桥挂 chip，toast 经由 tuiToast 那块的队列发出', staged.length === 1 && shown.length === 1 && shown[0][1] === 'success', JSON.stringify([staged.length, shown]))
  for (const [, d] of effects.reverse()) if (typeof d === 'function') d()
}
srv.close()

// ── H：真后端 /host/state（addon 端口上挂一个假 addon：扁平协议，可切「AI 暂停」）
const fakeAddon = { paused: false }
const addonSrv = net.createServer((sock) => {
  let buf = ''
  sock.on('data', (d) => {
    buf += d.toString('utf8')
    let msg
    try { msg = JSON.parse(buf) } catch (e) { return }
    buf = ''
    const reply = msg.type !== 'ping' && fakeAddon.paused
      ? { status: 'error', error: 'AI_PAUSED', message: 'AI 操作已暂停：请在 Blender N 面板「活动状态」里点「继续 AI 操作」' }
      : { status: 'success', result: msg.type === 'ping' ? { pong: true } : {} }
    sock.write(JSON.stringify(reply))
  })
  sock.on('error', () => {})
})
// 先只占一个空闲端口号：前半段要验「没有 Blender」，假 addon 等到后半段才开始监听
const ADDON_PORT = await new Promise((r) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)) }) })
const PORT = Number(process.env.DSH_SELFTEST_TUI_HOST_PORT || 9893)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-host-selftest-'))
const backend = spawn(process.execPath, [path.join(PKG, 'runtime', 'server.mjs'), '--port', String(PORT)], {
  env: Object.assign({}, process.env, { DSH_BLENDER_WORKDIR: TMP, DSH_BLENDER_HTTP_PORT: String(PORT), DSH_BLENDER_ADDON_PORT: String(ADDON_PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let blog = ''
backend.stdout.on('data', (d) => { blog += d.toString('utf8') })
backend.stderr.on('data', (d) => { blog += d.toString('utf8') })
process.on('exit', () => { try { backend.kill('SIGKILL') } catch (e) {} })
let hs = null
for (let i = 0; i < 40 && !hs; i++) {
  try { hs = await (await fetch('http://127.0.0.1:' + String(PORT) + '/host/state')).json() } catch (e) { await sleep(300) }
}
ok('真后端 /host/state 可读（无 Blender）', !!(hs && hs.ok === true), blog.slice(-300))
if (hs) {
  ok('形状：channel / lease / render / jobs / backend', !!(hs.channel && hs.lease && hs.render && hs.jobs && hs.backend), JSON.stringify(hs))
  ok('无 Blender：从没成功过、没暂停、没在渲染、0 个作业', hs.channel.lastOkAgeMs === null && hs.channel.aiPaused === false
    && hs.render.busy === false && hs.jobs.running === 0, JSON.stringify(hs))
  ok('页脚显示「未连接」', T.footerField(hs, HOLDER, PORT).text === 'Blender ○ 未连接', T.footerField(hs, HOLDER, PORT).text)
  const t0 = Date.now()
  for (let i = 0; i < 10; i++) await fetch('http://127.0.0.1:' + String(PORT) + '/host/state')
  ok('10 次 /host/state < 500 ms（零 Blender 往返）', Date.now() - t0 < 500, Date.now() - t0)

  await new Promise((r) => addonSrv.listen(ADDON_PORT, '127.0.0.1', r))
  const cmd = async () => { try { return await (await fetch('http://127.0.0.1:' + String(PORT) + '/cmd', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'get_scene_info', params: {} }) })).json() } catch (e) { return null } }
  const state = async () => { try { return await (await fetch('http://127.0.0.1:' + String(PORT) + '/host/state')).json() } catch (e) { return null } }
  await cmd()
  const s1 = await state()
  ok('addon 正常应答一次 → lastOkAgeMs 有值、页脚 ●', !!(s1 && s1.channel.lastOkAgeMs !== null && s1.channel.aiPaused === false)
    && T.footerField(s1, HOLDER, PORT).text === 'Blender ●', JSON.stringify(s1 && s1.channel))
  fakeAddon.paused = true
  await cmd()
  const s2 = await state()
  ok('addon 回「AI 操作已暂停」→ aiPaused=true、页脚 ⏸', !!(s2 && s2.channel.aiPaused === true && /暂停/.test(String(s2.channel.lastError)))
    && T.footerField(s2, HOLDER, PORT).text === 'Blender ⏸ AI 暂停', JSON.stringify(s2 && s2.channel))
  fakeAddon.paused = false
  await cmd()
  const s3 = await state()
  ok('继续之后成功一次 → aiPaused 清掉', !!(s3 && s3.channel.aiPaused === false), JSON.stringify(s3 && s3.channel))
}
try { backend.kill('SIGKILL') } catch (e) {}
addonSrv.close()

console.log('')
console.log('dsh-TUI 宿主半边自检：' + String(pass) + ' 通过 / ' + String(fail) + ' 失败')
if (fail) { console.log('失败项：' + failures.join(' | ')); process.exit(1) }
process.exit(0)
