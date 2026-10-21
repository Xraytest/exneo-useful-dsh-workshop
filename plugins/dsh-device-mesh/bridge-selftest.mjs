/**
 * dsh-device-mesh — 桥接层自测（不需要跑 harness，也不需要网络）。
 *
 *   node bridge-selftest.mjs
 *
 * ── 为什么这个文件值得存在 ──────────────────────────────────────────────────
 * 开发过程中在桥接层踩过两个 bug，都属于「不报错、只是静默做错事」：
 *
 *   ① 把 buildPathGroups() 的 group 视图直接当 owners 传给 routePath()，
 *      而它要的是摊平后的 {deviceId, path} 列表 → 永远匹配不上 → 全部判成本机。
 *   ② Caller.request 里把「对端文件路径」和「HTTP 协议路由」合用一个 path 字段
 *      → 请求打到文件路径上 → 405。
 *
 * 两个都只需要一个不碰网络的单测就能拦住。所以这里用**桩**（stub delegate +
 * stub caller）把桥接层的判定与出网形状钉死：不出网、不起进程、毫秒级完成。
 *
 * @module dsh-device-mesh/bridge-selftest
 */

import assert from 'node:assert/strict'
import { MeshFileSystem } from './fs-bridge.js'
import { settledExecution, MeshShellExecutor } from './shell-bridge.js'
import { API } from './protocol.js'
import { collectDeviceNames, collectWorkspacePolicy, resolveOwnerToken } from './routing.js'
import { sessionPermissionFromCandidates } from './exec.js'
import { withPermission } from './caller.js'

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

const SELF = 'dev-host'
const CHILD = 'dev-child'

/** 一份「路径组视图」，形状与 buildPathGroups() 的真实输出一致。 */
const groups = () => [
  {
    id: 'g1',
    homeDeviceId: SELF,
    workspaceId: 'w1',
    workspaceTitle: 'w1',
    primary: { deviceId: SELF, deviceName: 'host', path: '/root/hostwork', exists: true, local: true, stale: false },
    members: [
      { id: 'm1', deviceId: CHILD, deviceName: 'child', path: '/srv/childwork', role: 'mirror', local: false },
    ],
  },
]

/** 桩：出厂实现。所有本地操作打标记，便于断言「这条没出网」。 */
function stubDelegate() {
  const calls = []
  const note = (name) => { calls.push(name); return name }
  return {
    calls,
    sandboxMode: 'stub-sandbox',
    resolve: (path) => { note('resolve'); return Promise.resolve({ targetKey: `local:${path}`, displayPath: path }) },
    processPath: (t) => { note('processPath'); return `local-real:${t.displayPath}` },
    fileUrl: (t) => { note('fileUrl'); return `file://local${t.displayPath}` },
    contains: () => { note('contains'); return true },
    stat: () => { note('stat'); return Promise.resolve({ version: 'v1', type: 'file', size: 1 }) },
    lstat: () => { note('lstat'); return Promise.resolve({ version: 'v1', type: 'file' }) },
    readText: () => { note('readText'); return Promise.resolve('LOCAL-TEXT') },
    streamText: () => { note('streamText'); return Promise.resolve((async function* g() { yield 'LOCAL-TEXT' })()) },
    readBytes: () => { note('readBytes'); return Promise.resolve(new Uint8Array([1, 2])) },
    readByteRange: () => { note('readByteRange'); return Promise.resolve(new Uint8Array([1])) },
    listDir: () => { note('listDir'); return Promise.resolve([]) },
    writeText: () => { note('writeText'); return Promise.resolve({ operation: 'create', version: 'v1', before: null, after: 'x' }) },
    editText: () => { note('editText'); return Promise.resolve({ version: 'v2', before: 'a', after: 'b' }) },
    watch: () => { note('watch'); return Promise.resolve(() => {}) },
    processPathFromHostPath: () => { note('processPathFromHostPath'); return undefined },
  }
}

/** 桩：网格 Caller。记录每次出网的 (route, targetPath, body)，并按需返回信封。 */
function stubCaller(responses = {}) {
  const sent = []
  return {
    sent,
    async request({ deviceId, targetPath, route, body, permission }) {
      sent.push({ deviceId, targetPath, route, body, permission })
      const key = route.split('/').pop()
      const reply = responses[key]
      return { json: reply === undefined ? { ok: true } : reply, deviceId, deviceName: 'child', targetPath }
    },
  }
}

/** 造一个受测的 MeshFileSystem。 */
function makeFs(caller, opts = {}) {
  return new MeshFileSystem({
    delegate: opts.delegate ?? stubDelegate(),
    sandboxed: true,
    enabled: opts.enabled !== false,
    groups: opts.groups ?? groups,
    selfDeviceId: SELF,
    caller,
    fallbackCwd: '/root/hostwork',
    workspacePolicy: opts.policy,
    permissionFor: opts.permissionFor,
  })
}

/**
 * 另一组路径组：多一条**远端主路径** `/srv/childprimary`。
 *
 * 为什么需要它：`groups()` 里对端的路径只以 **member**（附加路径）出现，而 member 在
 * 两种模式下都放行 —— 拿它测「纯本地工作区不按路径转发」会永远绿。必须有一条远端
 * **主路径**，才能区分「按路径转发」和「按工作区策略强制本机」。
 */
const groupsWithRemotePrimary = () => [
  {
    id: 'g1',
    homeDeviceId: SELF,
    workspaceId: 'w1',
    workspaceTitle: 'hostwork',
    primary: { deviceId: SELF, deviceName: 'host', path: '/root/hostwork', exists: true, local: true, stale: false },
    members: [],
  },
  {
    id: 'g2',
    homeDeviceId: CHILD,
    workspaceId: 'w2',
    workspaceTitle: 'childwork',
    primary: { deviceId: CHILD, deviceName: 'child', path: '/srv/childprimary', exists: true, local: false, stale: false },
    members: [],
  },
]

/**
 * 造一个与**入口同形**的策略提供者。
 *
 * 三件套直接来自 routing.js，刻意不在测试里手搓 `{policy, resolveOwner}`：手搓的话，
 * 「入口把名字解析配错了」这类缺陷永远测不出来 —— 而声明里写的是**名字**、归属记录里
 * 只有 **deviceId**，这一环恰恰是最容易配错的地方。
 *
 * @param {object} roles `workspaceRoles` 形状（路径 → `{mesh?, owner?}`）。
 * @param {() => object[]} [groupsFn] 路径组视图（解析设备名用）。
 * @returns {() => (object|undefined)} 提供者。
 */
function policyProvider(roles, groupsFn = groups) {
  return () => {
    const policy = collectWorkspacePolicy(roles)
    // 与入口一致：没声明任何工作区 → `undefined` → 判定退回老语义。
    if (policy.entries.length === 0) return undefined
    const names = collectDeviceNames(groupsFn(), { deviceId: SELF, name: 'host' })
    return { policy, resolveOwner: (token) => resolveOwnerToken(names, token) }
  }
}

/** 造一个受测的 MeshShellExecutor（delegate 是纯桩：只回显 workdir，不起进程）。 */
function makeShell(opts = {}) {
  return new MeshShellExecutor({
    delegate: {
      sandboxMode: 'stub-sandbox',
      resolve: (r) => ({ workdir: r.workdir, command: r.command }),
      execute: async () => 'LOCAL',
    },
    sandboxed: false,
    enabled: opts.enabled !== false,
    groups: opts.groups ?? groups,
    selfDeviceId: SELF,
    runRemote: opts.runRemote ?? (async () => ({})),
    workspacePolicy: opts.policy,
    permissionFor: opts.permissionFor,
  })
}

// ── 路由判定 ────────────────────────────────────────────────────────────────
check('本机路径判本地（不碰网络）', () => {
  const fs = makeFs(stubCaller())
  assert.equal(fs.decide('/root/hostwork/a.txt').kind, 'local')
  assert.equal(fs.decide('rel.txt', '/root/hostwork').kind, 'local')
})

check('子节点路径判远端，并带出 root（← 归属列表必须被摊平）', () => {
  const fs = makeFs(stubCaller())
  const d = fs.decide('/srv/childwork/a.txt')
  assert.equal(d.kind, 'remote')
  assert.equal(d.deviceId, CHILD)
  assert.equal(d.root, '/srv/childwork')
})

check('无人认领的绝对路径判本地（安全缺省）', () => {
  const fs = makeFs(stubCaller())
  assert.equal(fs.decide('/tmp/nowhere').kind, 'local')
})

check('开关关闭时一律本地', () => {
  const fs = makeFs(stubCaller(), { enabled: false })
  assert.equal(fs.decide('/srv/childwork/a.txt').kind, 'local')
})

check('相对路径按 cwd 归一；cwd 落在远端时同样路由', () => {
  const fs = makeFs(stubCaller())
  const d = fs.decide('sub/a.txt', '/srv/childwork')
  assert.equal(d.kind, 'remote')
  assert.equal(d.path, '/srv/childwork/sub/a.txt')
})

check('前缀按路径分段：/srv/childworkX 不属于 /srv/childwork', () => {
  const fs = makeFs(stubCaller())
  assert.equal(fs.decide('/srv/childworkX/a.txt').kind, 'local')
})

// ── 目标铸造与本地纯计算 ────────────────────────────────────────────────────
check('远端目标可无损还原（不需要额外映射表）', async () => {
  const fs = makeFs(stubCaller())
  const target = await fs.resolve('/srv/childwork/a.txt')
  assert.match(String(target.targetKey), /^mesh:dev-child:\/srv\/childwork\/a\.txt$/)
  assert.equal(fs.processPath(target), '/srv/childwork/a.txt')
  assert.equal(fs.fileUrl(target), 'file:///srv/childwork/a.txt')
})

check('混合执行世界的 contains 一律 false', async () => {
  const fs = makeFs(stubCaller())
  const remote = await fs.resolve('/srv/childwork/a.txt')
  const local = await fs.resolve('/root/hostwork/a.txt')
  assert.equal(fs.contains(remote, remote), true)
  assert.equal(fs.contains(remote, local), false)
  assert.equal(fs.contains(local, remote), false)
})

check('远端 watch 明确拒绝（本机观察不了对端）', async () => {
  const fs = makeFs(stubCaller())
  const remote = await fs.resolve('/srv/childwork/a.txt')
  await assert.rejects(() => fs.watch(remote, () => {}, undefined), /远端工作路径不支持文件观察/u)
})

// ── 出网形状：这一组专门钉死「路由 vs 路径」那个 bug ─────────────────────────
check('write 出网用协议路由 + 对端文件路径（← 两者必须是不同字段）', async () => {
  const caller = stubCaller({ write: { operation: 'create', version: 'v9', before: null, after: 'x' } })
  const fs = makeFs(caller)
  const target = await fs.resolve('/srv/childwork/a.txt')
  const out = await fs.writeText(target, 'x', undefined)
  assert.equal(caller.sent.length, 1)
  assert.equal(caller.sent[0].route, API.fsWrite)
  assert.equal(caller.sent[0].targetPath, '/srv/childwork/a.txt')
  assert.equal(caller.sent[0].deviceId, CHILD)
  assert.equal(out.version, 'v9')
})

check('六条原语各自打到自己的路由', async () => {
  const caller = stubCaller({
    stat: { info: { exists: true, type: 'file', size: 3, version: 'v1' } },
    lstat: { info: { exists: true, type: 'file', version: 'v1' } },
    read: { kind: 'text', text: 'T' },
    listdir: { entries: [{ name: 'a', type: 'file', size: 1 }] },
    write: { operation: 'update', version: 'v2', before: 'a', after: 'b' },
    edit: { version: 'v3', before: 'a', after: 'b' },
  })
  const fs = makeFs(caller)
  const target = await fs.resolve('/srv/childwork/a.txt')
  await fs.stat(target)
  await fs.lstat('/srv/childwork/a.txt')
  await fs.readText(target)
  await fs.listDir(await fs.resolve('/srv/childwork'))
  await fs.writeText(target, 'x', undefined)
  await fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }, undefined)
  assert.deepEqual(caller.sent.map((s) => s.route), [
    API.fsStat, API.fsLstat, API.fsRead, API.fsListDir, API.fsWrite, API.fsEdit,
  ])
})

check('listDir 的子项目标在主机侧铸造成 mesh:', async () => {
  const caller = stubCaller({ listdir: { entries: [{ name: 'a.txt', type: 'file', size: 2 }] } })
  const fs = makeFs(caller)
  const entries = await fs.listDir(await fs.resolve('/srv/childwork'))
  assert.equal(entries.length, 1)
  assert.match(String(entries[0].target.targetKey), /^mesh:dev-child:\/srv\/childwork\/a\.txt$/)
})

check('对端的 failed 信封被翻成同码 FsError（上层靠 code 分支）', async () => {
  const caller = stubCaller({ read: { failed: true, fsCode: 'FS_NOT_FOUND', message: '没有这个文件' } })
  const fs = makeFs(caller)
  const target = await fs.resolve('/srv/childwork/missing.txt')
  await assert.rejects(() => fs.readText(target), (error) => {
    assert.equal(error.code, 'FS_NOT_FOUND')
    assert.match(error.message, /没有这个文件/u)
    return true
  })
})

check('传输层失败也包成 FsError，不让裸网络异常漏出去', async () => {
  const caller = { sent: [], async request() { throw new Error('boom') } }
  const fs = makeFs(caller)
  const target = await fs.resolve('/srv/childwork/a.txt')
  await assert.rejects(() => fs.readText(target), (error) => {
    assert.equal(error.code, 'FS_IO_ERROR')
    assert.match(error.message, /boom/u)
    return true
  })
})

// ── 本机路径仍然走委托（不能因为加了路由就把本机也绕出去）───────────────────
check('本机路径全部落到委托，一次网络都不发', async () => {
  const delegate = stubDelegate()
  const caller = stubCaller()
  const fs = makeFs(caller, { delegate })
  const target = await fs.resolve('/root/hostwork/a.txt')
  assert.equal(await fs.readText(target), 'LOCAL-TEXT')
  await fs.writeText(target, 'x', undefined)
  await fs.listDir(await fs.resolve('/root/hostwork'))
  assert.equal(caller.sent.length, 0, '本机路径不该产生任何出网请求')
  assert.ok(delegate.calls.includes('readText') && delegate.calls.includes('writeText'))
})

check('本机路径的 watch 委托出去（本地文件页不受影响）', async () => {
  const delegate = stubDelegate()
  const fs = makeFs(stubCaller(), { delegate })
  const target = await fs.resolve('/root/hostwork/a.txt')
  await fs.watch(target, () => {}, undefined)
  assert.ok(delegate.calls.includes('watch'))
})

// ── 统计 ────────────────────────────────────────────────────────────────────
check('统计如实区分 routed / local（resolve 与操作各计一次）', async () => {
  const fs = makeFs(stubCaller({ read: { kind: 'text', text: 'T' } }))
  await fs.readText(await fs.resolve('/root/hostwork/a.txt'))
  await fs.readText(await fs.resolve('/srv/childwork/a.txt'))
  const stats = fs.stats()
  // 每次「解析 + 落地」各计一次：解析也要走一次归属判定，它本身就是一次真实的
  // 路由决定（而且失败模式与落地不同），所以分开计数比合并成一个数字更有诊断价值。
  assert.equal(stats.local, 2)
  assert.equal(stats.routed, 2)
  assert.equal(stats.failed, 0)
})

// ── shell 桥接的句柄形状 ────────────────────────────────────────────────────
check('settledExecution：正常退出 → completed，退出码与输出如实', async () => {
  const h = settledExecution({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: 'out', stderr: '', truncated: false })
  assert.equal(h.status, 'completed')
  assert.equal(h.exitCode, 0)
  assert.equal((await h.result()).stdout.text, 'out')
  assert.equal(h.readOutput().delta, 'out')
  assert.equal(h.readOutput().delta, '', '消费型读取器第二次应为空')
})

check('settledExecution：超时 → killed，timedOut 如实', async () => {
  const h = settledExecution({ exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 500, stdout: '', stderr: '', truncated: false })
  assert.equal(h.status, 'killed')
  assert.equal((await h.result()).timedOut, true)
})

check('settledExecution：stderr 带标记合进 delta，不丢内容', () => {
  const h = settledExecution({ exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1, stdout: 'o', stderr: 'e', truncated: false })
  const delta = h.readOutput().delta
  assert.ok(delta.includes('o') && delta.includes('e') && delta.includes('stderr'))
})

check('MeshShellExecutor：开关切换会让已判定的远端 spec 失效', () => {
  const exec = new MeshShellExecutor({
    delegate: { sandboxMode: 'm', resolve: (r) => ({ workdir: r.workdir, command: r.command }), execute: async () => 'LOCAL' },
    sandboxed: false,
    enabled: true,
    groups,
    selfDeviceId: SELF,
    // 这条 check 没有 opts 形参（不是从 builder 里来的），直接给一个字面量 ——
    // 之前这里残留了 `opts.runRemote`，整包自测在节点上抛 ReferenceError。
    runRemote: async () => ({}),
  })
  const remoteSpec = exec.resolve({ command: 'x', workdir: '/srv/childwork' })
  assert.equal(exec.remoteSpecs.size, 1)
  exec.setEnabled(false)
  assert.equal(exec.remoteSpecs.size, 0, '关掉后不得再发出已判定的请求')
  assert.equal(exec.enabled, false)
  // 关掉后重新 resolve 不再判定为远端
  assert.equal(exec.remoteSpecs.size, 0)
  assert.ok(remoteSpec !== undefined)
})

// ── 互联会话策略：工作区之外的路径绝不允许静默落到本机 ──────────────────────
// 用户报的缺陷就是这一条：会话端（跑 agent 的那台）读 /etc/hosts 这类工作区之外的
// 路径时，静默读到了**会话端自己**的文件。下面第一组断言就是它的回归测试。

check('互联会话：工作区之外的路径发给属主设备（← 用户报的缺陷）', async () => {
  const delegate = stubDelegate()
  const caller = stubCaller()
  const fs = makeFs(caller, {
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true, owner: 'child' } }, groupsWithRemotePrimary),
    delegate,
  })
  const d = fs.decide('/etc/hosts', '/srv/meshwork')
  assert.equal(d.kind, 'remote', '互联会话读工作区之外的路径必须转发，不能判本机')
  assert.equal(d.deviceId, CHILD)
  assert.equal(d.path, '/etc/hosts', '转发的仍然是原始目标路径')
  assert.equal(d.root, '/srv/meshwork')
  const target = await fs.resolve('/etc/hosts', { cwd: '/srv/meshwork' })
  assert.match(String(target.targetKey), /^mesh:dev-child:\/etc\/hosts$/u)
  assert.equal(delegate.calls.includes('resolve'), false, '不得落到本机委托（那就是读到会话端自己的文件）')
  assert.equal(caller.sent.length, 0, 'resolve 本身不出网')
  assert.equal(fs.stats().denied, 0)
  // 写类工具走的是同一个判定：同样发属主，不是本机。
  await fs.writeText(target, 'x', undefined)
  assert.equal(caller.sent.length, 1)
  assert.equal(caller.sent[0].deviceId, CHILD)
  assert.equal(caller.sent[0].targetPath, '/etc/hosts')
})

check('互联会话：属主解析不出来 → 拒绝并抛出（绝不静默本机）', async () => {
  const delegate = stubDelegate()
  const caller = stubCaller()
  const fs = makeFs(caller, {
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true, owner: 'ghost' } }, groupsWithRemotePrimary),
    delegate,
  })
  const d = fs.decide('/etc/hosts', '/srv/meshwork')
  assert.equal(d.kind, 'denied')
  assert.match(d.reason, /解析不到设备/u)
  await assert.rejects(() => fs.resolve('/etc/hosts', { cwd: '/srv/meshwork' }), (error) => {
    // 码必须是 FS_PERMISSION_DENIED：FS_SANDBOX_DENIED 会被出厂工具层替换掉文案，
    // 真正有用的原因（哪个工作区、缺什么声明）就传不到模型面前了。
    assert.equal(error.code, 'FS_PERMISSION_DENIED')
    assert.match(error.message, /互联会话只允许在属主设备上落地/u)
    assert.match(error.message, /ghost/u, '原因里要带上解析不出来的那个名字')
    assert.match(error.message, /\/etc\/hosts/u, '原因里要带上目标路径')
    return true
  })
  await assert.rejects(() => fs.lstat('/etc/hosts', { cwd: '/srv/meshwork' }), /互联会话只允许在属主设备上落地/u)
  assert.equal(delegate.calls.includes('resolve'), false, 'denied 不得落到本机委托')
  assert.equal(delegate.calls.includes('lstat'), false, 'denied 不得落到本机委托')
  assert.equal(caller.sent.length, 0, 'denied 不发任何请求')
  assert.equal(fs.stats().denied, 3, 'decide + resolve + lstat 各记一次拒绝')
})

check('互联会话：连 owner 都没声明 → 同样拒绝（不是「没有策略」）', () => {
  const fs = makeFs(stubCaller(), {
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true } }, groupsWithRemotePrimary),
  })
  const d = fs.decide('/etc/hosts', '/srv/meshwork')
  assert.equal(d.kind, 'denied', '声明了 mesh 却没写 owner = 判不出来，必须拒绝')
  assert.match(d.reason, /没有声明 owner/u)
})

check('策略提供者抛错 → 失败关闭（denied，不是静默本机）', async () => {
  const delegate = stubDelegate()
  const fs = makeFs(stubCaller(), {
    policy: () => { throw new Error('配置读坏了') },
    delegate,
  })
  const d = fs.decide('/root/hostwork/a.txt')
  assert.equal(d.kind, 'denied', '读不到策略时唯一能确定的事实是「不知道落在哪」，不能放行到本机')
  assert.match(d.reason, /配置读坏了/u)
  await assert.rejects(() => fs.resolve('/root/hostwork/a.txt'), /互联会话只允许在属主设备上落地/u)
  assert.equal(delegate.calls.includes('resolve'), false)
})

check('纯本地工作区：路径命中远端主路径仍然本机（不按路径转发）', async () => {
  const delegate = stubDelegate()
  const caller = stubCaller()
  const fs = makeFs(caller, {
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/root/localwork': {} }, groupsWithRemotePrimary),
    delegate,
  })
  const d = fs.decide('/srv/childprimary/a.txt', '/root/localwork')
  assert.equal(d.kind, 'local', '纯本地工作区不因为路径命中远端主路径就转发')
  const target = await fs.resolve('/srv/childprimary/a.txt', { cwd: '/root/localwork' })
  assert.match(String(target.targetKey), /^local:/u)
  assert.ok(delegate.calls.includes('resolve'), '必须落到本机委托')
  assert.equal(caller.sent.length, 0)
  assert.equal(fs.stats().denied, 0, '纯本地工作区不是拒绝，是本机')
  // 反证：同一个路径、没有策略时确实是远端 —— 否则上面那条断言可能因为别的原因绿。
  const bare = makeFs(stubCaller(), { groups: groupsWithRemotePrimary })
  assert.equal(bare.decide('/srv/childprimary/a.txt', '/root/localwork').kind, 'remote')
})

check('显式附加路径 member：两种模式下都转发（人钉的意图比开关更具体）', () => {
  for (const role of [{ mesh: true, owner: 'host' }, {}]) {
    const fs = makeFs(stubCaller(), {
      policy: policyProvider({ '/root/hostwork': role }),
    })
    const d = fs.decide('/srv/childwork/a.txt', '/root/hostwork')
    assert.equal(d.kind, 'remote', `member 在 ${JSON.stringify(role)} 下也必须转发`)
    assert.equal(d.deviceId, CHILD)
    assert.equal(d.root, '/srv/childwork')
  }
})

check('没有策略（提供者返回 undefined）→ 判定与改动前逐字一致', () => {
  const paths = [
    ['/root/hostwork/a.txt', '/root/hostwork'],
    ['/srv/childwork/a.txt', undefined],
    ['/srv/childprimary/a.txt', undefined],
    ['/srv/childprimary/deep/x.txt', '/root/hostwork'],
    ['/tmp/nowhere', undefined],
    ['sub/a.txt', '/root/hostwork'],
  ]
  const bare = makeFs(stubCaller(), { groups: groupsWithRemotePrimary })
  const undefinedProvider = makeFs(stubCaller(), { groups: groupsWithRemotePrimary, policy: () => undefined })
  const emptyDeclaration = makeFs(stubCaller(), { groups: groupsWithRemotePrimary, policy: policyProvider({}, groupsWithRemotePrimary) })
  for (const [p, cwd] of paths) {
    // 逐条 deepEqual：老部署（没有提供者）与新入口在「没声明任何工作区」时的行为
    // 必须**一模一样**，包括 root/deviceId 这些细节。差一个字都算回归。
    assert.deepEqual(undefinedProvider.decide(p, cwd), bare.decide(p, cwd))
    assert.deepEqual(emptyDeclaration.decide(p, cwd), bare.decide(p, cwd))
  }
  assert.equal(undefinedProvider.stats().denied, 0, '没有策略不该产生任何拒绝')
})

// ── shell 侧的同一套策略 ────────────────────────────────────────────────────
// 注意 shell 与 fs 的差别：shell 只有 `spec.workdir` 一个字段既当**会话归属**又当
// **目标路径**，所以「工作区之外的路径」在 shell 这边等价于「workdir 在声明工作区
// 之外」——那种情形下面单独有一条「已知缺口」断言钉住它。

check('shell 互联会话：workdir 落在互联工作区 → 转发给声明的属主', () => {
  const exec = makeShell({
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true, owner: 'child' } }, groupsWithRemotePrimary),
  })
  const spec = exec.resolve({ command: 'ls', workdir: '/srv/meshwork' })
  const decision = exec.remoteSpecs.get(spec)
  assert.ok(decision !== undefined, '互联会话的命令必须判给属主设备')
  assert.equal(decision.route.deviceId, CHILD)
  assert.equal(decision.route.kind, 'remote')
  assert.equal(exec.stats().denied, 0)
})

check('shell 互联会话：属主解析不出来 → 抛错（不静默在本机执行）', () => {
  const exec = makeShell({
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true, owner: 'ghost' } }, groupsWithRemotePrimary),
  })
  assert.throws(
    () => exec.resolve({ command: 'ls', workdir: '/srv/meshwork' }),
    /互联会话只允许在属主设备上落地/u,
  )
  assert.equal(exec.remoteSpecs.size, 0, '被拒的命令不得留下任何已判定状态')
  assert.equal(exec.stats().denied, 1)
})

check('shell 纯本地工作区：workdir 命中远端主路径也不转发', () => {
  const exec = makeShell({
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/childprimary': {} }, groupsWithRemotePrimary),
  })
  const spec = exec.resolve({ command: 'ls', workdir: '/srv/childprimary' })
  assert.equal(exec.remoteSpecs.has(spec), false, '纯本地工作区一律本机')
  assert.equal(exec.stats().denied, 0)
  // 反证：同一个 workdir、没有策略时是远端的。
  const bare = makeShell({ groups: groupsWithRemotePrimary })
  assert.equal(bare.remoteSpecs.has(bare.resolve({ command: 'ls', workdir: '/srv/childprimary' })), true)
})

check('shell 显式附加路径 member：互联与纯本地两种模式下都转发', () => {
  for (const role of [{ mesh: true, owner: 'host' }, {}]) {
    const exec = makeShell({ policy: policyProvider({ '/srv': role }) })
    const spec = exec.resolve({ command: 'ls', workdir: '/srv/childwork' })
    const decision = exec.remoteSpecs.get(spec)
    assert.ok(decision !== undefined, `member 在 ${JSON.stringify(role)} 下也必须转发`)
    assert.equal(decision.route.deviceId, CHILD)
    assert.equal(decision.route.source, 'member')
  }
})

check('shell 已知缺口：workdir 在工作区之外的绝对路径 → 判不出归属，仍走老语义（本机）', () => {
  // 这不是「期望行为」，是**如实钉住当前的缺口**：出厂 `resolveWorkdir()` 对模型显式
  // 给的绝对 workdir 原样采用，于是 spec.workdir 不落在任何已声明工作区里，归属判不
  // 出来 → 退回老语义（本机）。修它需要把会话 cwd 一路带到 resolve() 面前（出厂请求里
  // 没有这个字段），不在桥接层能做到的范围内。
  // 为什么还要写这条：不留断言的话，这个缺口会以「不知道修没修」的状态长期存在；
  // 钉住它之后，将来真修好时这条会**失败**，逼人显式改测试而不是悄悄改变行为。
  const exec = makeShell({
    groups: groupsWithRemotePrimary,
    policy: policyProvider({ '/srv/meshwork': { mesh: true, owner: 'child' } }, groupsWithRemotePrimary),
  })
  const spec = exec.resolve({ command: 'cat /etc/hosts', workdir: '/etc' })
  assert.equal(exec.remoteSpecs.has(spec), false, '判不出归属 → 老语义（本机），这是缺口本身')
  assert.equal(exec.stats().denied, 0, '缺口不等于拒绝：它连「该拒绝」都判不出来')
})

check('shell 没有策略（提供者返回 undefined）→ 判定与改动前逐字一致', () => {
  const workdirs = ['/root/hostwork', '/srv/childwork', '/srv/childprimary', '/tmp/nowhere']
  const bare = makeShell({ groups: groupsWithRemotePrimary })
  const undefinedProvider = makeShell({ groups: groupsWithRemotePrimary, policy: () => undefined })
  const emptyDeclaration = makeShell({ groups: groupsWithRemotePrimary, policy: policyProvider({}, groupsWithRemotePrimary) })
  for (const workdir of workdirs) {
    const shape = (exec) => {
      const spec = exec.resolve({ command: 'ls', workdir })
      const decision = exec.remoteSpecs.get(spec)
      return decision === undefined ? 'local' : `${decision.route.kind}:${decision.route.deviceId}:${decision.route.root}:${decision.route.source}`
    }
    assert.equal(shape(undefinedProvider), shape(bare))
    assert.equal(shape(emptyDeclaration), shape(bare))
  }
  assert.equal(undefinedProvider.stats().denied, 0)
})

// ── 会话权限（sessionMode）随转发走 ─────────────────────────────────────────
// 桥接层只做「问提供者 + 原样带上」；「取最严」的规则在 exec.js 的纯函数里，这里也钉一条
// （多会话共享 cwd 时的提权方向必须堵死，两处都验一遍不嫌多）。
check('没有 permissionFor（老部署）→ 转发不带权限，计数器记 without', async () => {
  const caller = stubCaller({ read: { text: 'x' } })
  const fs = makeFs(caller)
  const target = await fs.resolve('/srv/childwork/a.txt', { cwd: '/srv/childwork' })
  await fs.readText(target)
  assert.equal(caller.sent.length, 1)
  assert.equal(caller.sent[0].permission, undefined, '没有提供者时不能凭空造一个权限')
  assert.equal(fs.stats().permissionWithout, 1)
  assert.equal(fs.stats().permissionWith, 0)
})

check('permissionFor 说「查不到」→ 不带权限', async () => {
  const caller = stubCaller({ read: { text: 'x' } })
  const fs = makeFs(caller, { permissionFor: () => undefined })
  await fs.readText(await fs.resolve('/srv/childwork/a.txt', { cwd: '/srv/childwork' }))
  assert.equal(caller.sent[0].permission, undefined)
  assert.equal(fs.stats().permissionWithout, 1)
})

check('permissionFor 抛错 → 降级成不带权限（绝不编一个默认权限）', async () => {
  const caller = stubCaller({ read: { text: 'x' } })
  const fs = makeFs(caller, { permissionFor: () => { throw new Error('boom') } })
  await fs.readText(await fs.resolve('/srv/childwork/a.txt', { cwd: '/srv/childwork' }))
  assert.equal(caller.sent[0].permission, undefined, '取权限失败必须降级成「不带权限」')
  assert.equal(fs.stats().permissionWithout, 1)
})

check('permissionFor 给出权限 → 原样透传到出网请求', async () => {
  const permission = { mode: 'workspace-write', workspaceRoot: '/srv/childwork' }
  const caller = stubCaller({ write: { operation: 'create', version: 'v1', before: null, after: 'x' } })
  const fs = makeFs(caller, { permissionFor: () => permission })
  await fs.writeText(await fs.resolve('/srv/childwork/new.txt', { cwd: '/srv/childwork' }), 'hello')
  assert.equal(caller.sent[0].permission.mode, 'workspace-write')
  assert.equal(caller.sent[0].permission.workspaceRoot, '/srv/childwork')
  assert.equal(fs.stats().permissionWith, 1)
})

check('出网形状：并进 sessionMode，且**不覆盖** fsRead 既有的 mode（读的编码）', () => {
  const permission = { mode: 'workspace-write', workspaceRoot: '/srv/childwork' }
  const readBody = withPermission({ path: '/p', mode: 'text' }, permission)
  assert.equal(readBody.mode, 'text', 'fsRead 的 mode 是读的编码，绝不能被权限冲掉')
  assert.equal(readBody.sessionMode, 'workspace-write')
  assert.equal(readBody.workspaceRoot, '/srv/childwork')
  const noRoot = withPermission({ path: '/p' }, { mode: 'read-only', workspaceRoot: '' })
  assert.equal(noRoot.sessionMode, 'read-only')
  assert.equal('workspaceRoot' in noRoot, false, '根为空时不带这个字段')
  const body = { path: '/p' }
  assert.equal(withPermission(body, undefined), body, '无权限时原样返回同一个对象')
})

check('多会话同 cwd 取最严（提权方向必须堵死）', () => {
  const strict = sessionPermissionFromCandidates({
    cwd: '/srv/childwork',
    candidates: [
      { cwd: '/srv/childwork', mode: 'danger-full-access' },
      { cwd: '/srv/childwork', mode: 'read-only' },
      { cwd: '/srv/other', mode: 'danger-full-access' },
    ],
    workspaceRoot: '/srv/childwork',
  })
  assert.equal(strict.mode, 'read-only')
  assert.equal(strict.matched, 2)
  assert.equal(strict.mixed, true)
})

check('shell：权限跟着 remoteRunner 的请求走', async () => {
  const requests = []
  const shell = makeShell({
    permissionFor: () => ({ mode: 'workspace-write', workspaceRoot: '/srv/childwork' }),
    runRemote: async (request) => { requests.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
  })
  const spec = shell.resolve({ command: 'echo hi', workdir: '/srv/childwork' })
  await shell.execute(spec)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].permission.mode, 'workspace-write')
  assert.equal(shell.stats().permissionWith, 1)
})

// ── 出厂 job 路径的展开副本（2026-10-18 线上缺陷的回归测试）─────────────────
// dsh-tool-bash 在 startJob(...).run() 里用 `{...spec, signal}` 调 execute() ——
// 展开产生**新对象**，按对象身份查 remoteSpecs 永远落空，命令于是静默在本机跑。
// 线上症状：/status 里 shell.routed 恒为 0、local 涨到几百，fs.routed 却正常。
// 判定改为在 execute 里按 (workdir, groups, policy) 同步重算（redecide）。

check('shell：execute 收到的是 {...spec, signal} 展开副本时仍然路由（← 2026-10-18 线上缺陷）', async () => {
  const requests = []
  const shell = makeShell({
    permissionFor: () => ({ mode: 'workspace-write', workspaceRoot: '/srv/childwork' }),
    runRemote: async (request) => { requests.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
  })
  const spec = shell.resolve({ command: 'echo hi', workdir: '/srv/childwork' })
  assert.equal(shell.remoteSpecs.size, 1, '前置：resolve 已判远端')
  // 出厂 job 路径的调用形状：展开副本 + signal。
  await shell.execute({ ...spec, signal: undefined })
  assert.equal(requests.length, 1, '展开副本绝不能让路由判定丢失')
  assert.equal(requests[0].deviceId, CHILD)
  assert.equal(requests[0].workdir, '/srv/childwork')
  assert.equal(shell.stats().routed, 1)
  assert.equal(shell.stats().local, 0)
})

check('shell：展开副本 + 开关在 resolve 之后关掉 → 不发（不变量不被重算绕过）', async () => {
  const requests = []
  const shell = makeShell({
    runRemote: async (request) => { requests.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
  })
  const spec = shell.resolve({ command: 'echo hi', workdir: '/srv/childwork' })
  shell.setEnabled(false)
  await shell.execute({ ...spec, signal: undefined })
  assert.equal(requests.length, 0, '关掉之后不得因为重算把命令重新判成远端')
})

check('shell：展开副本落在本机路径 → 仍然本机，重算不产生多余出网', async () => {
  const requests = []
  const shell = makeShell({
    runRemote: async (request) => { requests.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
  })
  const spec = shell.resolve({ command: 'echo hi', workdir: '/root/hostwork' })
  const result = await shell.execute({ ...spec, signal: undefined })
  assert.equal(result, 'LOCAL')
  assert.equal(requests.length, 0)
  assert.equal(shell.stats().local, 1)
})

console.log(`\n  BRIDGE SELFTEST PASS (${passed} checks)`)
