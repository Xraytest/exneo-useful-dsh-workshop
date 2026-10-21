import assert from 'node:assert/strict'
import {
  normalizeRoutePath, isWithinRoute, collectPathOwners, matchOwner, routePath, explainRoute,
  collectWorkspacePolicy, workspaceForPath, collectDeviceNames, resolveOwnerToken, routePathWithPolicy, ownerDeviceForWorkspacePath,
} from './routing.js'

let n = 0
const ok = (label, fn) => { fn(); n += 1; console.log('  ok  ' + label) }

ok('归一化：折叠重复斜杠 / 去尾斜杠 / 解析 . 与 ..', () => {
  assert.equal(normalizeRoutePath('/srv//a/./b/../c/'), '/srv/a/c')
  assert.equal(normalizeRoutePath('/'), '/')
  assert.equal(normalizeRoutePath('/../../x'), '/x')
  assert.equal(normalizeRoutePath('relative/path'), undefined)
  assert.equal(normalizeRoutePath(''), undefined)
  assert.equal(normalizeRoutePath(undefined), undefined)
})

ok('分段前缀：/srv/app 不匹配 /srv/application（安全边界）', () => {
  assert.equal(isWithinRoute('/srv/app', '/srv/app'), true)
  assert.equal(isWithinRoute('/srv/app', '/srv/app/sub'), true)
  assert.equal(isWithinRoute('/srv/app', '/srv/application'), false)
  assert.equal(isWithinRoute('/srv/app', '/srv'), false)
  assert.equal(isWithinRoute('/', '/anything'), true)
})

const self = 'dev-host'
const child = 'dev-child'
const third = 'dev-third'
const groups = [
  { workspaceId: 'w1', primary: { deviceId: self, path: '/root/local' }, members: [
    { deviceId: child, path: '/srv/remote' },
    { deviceId: self, path: '/srv/remote-shadow' },
  ] },
  { workspaceId: 'w2', primary: { deviceId: child, path: '/home/x/work' }, members: [
    { deviceId: third, path: '/mnt/data' },
  ] },
]

ok('摊平归属：跳过空路径与非绝对路径', () => {
  const owners = collectPathOwners([...groups, { primary: { deviceId: self, path: 'rel' }, members: [{ deviceId: child, path: '' }] }])
  assert.equal(owners.length, 5)
  assert.deepEqual([...new Set(owners.map((o) => o.source))].sort(), ['member', 'primary'])
})

ok('本地路径 → 本地执行', () => {
  const owners = collectPathOwners(groups)
  assert.equal(routePath('/root/local/x.txt', { owners, selfDeviceId: self }).route.kind, 'local')
  assert.equal(routePath('/srv/remote-shadow/a', { owners, selfDeviceId: self }).route.kind, 'local')
})

ok('子节点路径 → 路由到那台，并带出 root', () => {
  const owners = collectPathOwners(groups)
  const d = routePath('/srv/remote/build/out', { owners, selfDeviceId: self })
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.route.root, '/srv/remote')
  assert.equal(d.route.source, 'member')
})

ok('子节点自己的主路径也认', () => {
  const owners = collectPathOwners(groups)
  const d = routePath('/home/x/work/file', { owners, selfDeviceId: self })
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.route.source, 'primary')
})

ok('无人认领 → 本地（安全缺省）', () => {
  const owners = collectPathOwners(groups)
  assert.equal(routePath('/tmp/whatever', { owners, selfDeviceId: self }).route.kind, 'local')
  assert.equal(routePath('relative', { owners, selfDeviceId: self }).route.kind, 'local')
  assert.equal(routePath(undefined, { owners, selfDeviceId: self }).route.kind, 'local')
})

ok('最长前缀优先：嵌套挂载时更具体的那段赢', () => {
  const owners = collectPathOwners([
    { workspaceId: 'w', primary: { deviceId: self, path: '/a' }, members: [{ deviceId: child, path: '/a/b' }] },
  ])
  assert.equal(routePath('/a/b/c', { owners, selfDeviceId: self }).route.deviceId, child)
  assert.equal(routePath('/a/z', { owners, selfDeviceId: self }).route.kind, 'local')
})

ok('判定与挂载顺序无关（同样的输入永远同样的答案）', () => {
  const a = collectPathOwners(groups)
  const b = collectPathOwners([...groups].reverse())
  const pa = routePath('/srv/remote/x', { owners: a, selfDeviceId: self })
  const pb = routePath('/srv/remote/x', { owners: b, selfDeviceId: self })
  assert.equal(pa.route.deviceId, pb.route.deviceId)
})

ok('explainRoute 给人读的一行', () => {
  const owners = collectPathOwners(groups)
  const remote = routePath('/srv/remote/x', { owners, selfDeviceId: self })
  assert.match(explainRoute(remote, () => '树莓派'), /树莓派/)
  const local = routePath('/root/local/y', { owners, selfDeviceId: self })
  assert.match(explainRoute(local, () => '?'), /本地执行/)
})

// ── 工作区策略：互联会话 vs 纯本地会话的完全分离 ──────────────────────────────

const MESH_PATH = '/root/meshproj'
const LOCAL_PATH = '/root/localproj'
// 两台机器都跑同一份策略：本机是 self（会话端）或 child（属主）。
const meshGroups = [
  { workspaceId: 'w-mesh', primary: { deviceId: child, deviceName: 'orangepi5', path: MESH_PATH }, members: [] },
  { workspaceId: 'w-local', primary: { deviceId: self, deviceName: 'xray4668', path: LOCAL_PATH }, members: [] },
]
const meshRoles = {
  [MESH_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true },
  [LOCAL_PATH]: { owner: 'xray4668', session: 'xray4668' },
}
/** 会话端的视角：本机 = self，属主 = child（名字 orangepi5）。 */
const policyFromSessionSide = () => {
  const owners = collectPathOwners(meshGroups)
  const names = collectDeviceNames(meshGroups, { deviceId: self, name: 'xray4668' })
  return {
    owners,
    names,
    policy: collectWorkspacePolicy(meshRoles),
    resolveOwner: (token) => resolveOwnerToken(names, token),
  }
}
const decide = (rawPath, cwd, view = policyFromSessionSide(), selfId = self) => routePathWithPolicy(rawPath, {
  owners: view.owners,
  selfDeviceId: selfId,
  policy: view.policy,
  cwd,
  resolveOwner: view.resolveOwner,
})

ok('策略表：归一化路径、mesh 缺省为 false、按最长前缀排序', () => {
  const p = collectWorkspacePolicy({ '/a/b/': { owner: 'x', mesh: true }, '/a': { owner: 'y' }, 'rel': {} })
  assert.deepEqual(p.entries.map((e) => e.path), ['/a/b', '/a'])
  assert.equal(p.entries[0].mesh, true)
  assert.equal(p.entries[1].mesh, false)
})

ok('策略表：账目里的每个工作区都进表，未声明的按纯本地；声明覆盖账目', () => {
  const roles = { [MESH_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } }
  const groups = [
    { workspaceId: 'w-mesh', primary: { deviceId: child, deviceName: 'orangepi5', path: MESH_PATH }, members: [] },
    { workspaceId: 'w-undeclared', primary: { deviceId: child, deviceName: 'orangepi5', path: '/root/undeclared' }, members: [] },
  ]
  const p = collectWorkspacePolicy(roles, groups)
  const byPath = new Map(p.entries.map((e) => [e.path, e]))
  assert.equal(byPath.get(MESH_PATH).mesh, true, '声明的那个仍是互联会话')
  assert.equal(byPath.get(MESH_PATH).workspaceId, 'w-mesh', '账目的 workspaceId 被合并进来')
  assert.equal(byPath.get('/root/undeclared').mesh, false, '账目里未声明的工作区按纯本地')
  assert.equal(byPath.get('/root/undeclared').workspaceId, 'w-undeclared')
})

ok('未声明的工作区（账目里有）→ 反向保证生效：即使命中远端主路径也不转发', () => {
  const groups = [
    { workspaceId: 'w-mesh', primary: { deviceId: child, deviceName: 'orangepi5', path: MESH_PATH }, members: [] },
    { workspaceId: 'w-undeclared', primary: { deviceId: self, deviceName: 'xray4668', path: '/root/undeclared' }, members: [] },
  ]
  const owners = collectPathOwners(groups)
  const names = collectDeviceNames(groups, { deviceId: self, name: 'xray4668' })
  const policy = collectWorkspacePolicy(meshRoles, groups)
  const resolveOwner = (t) => resolveOwnerToken(names, t)
  // 目标落在**对端**的主路径下，但会话的 cwd 在一个未声明的工作区里 → 必须本机
  const d = routePathWithPolicy(MESH_PATH + '/src/app.js', {
    owners, selfDeviceId: self, policy, cwd: '/root/undeclared/sub', resolveOwner,
  })
  assert.equal(d.route.kind, 'local')
  assert.equal(d.workspace.mesh, false)
  assert.match(explainRoute(d, () => '?'), /纯本地工作区/)
})

ok('会话归属按 cwd 判定（最长前缀），目标路径不参与反推', () => {
  const { policy } = policyFromSessionSide()
  assert.equal(workspaceForPath(MESH_PATH + '/src/app.js', policy).path, MESH_PATH)
  assert.equal(workspaceForPath(MESH_PATH, policy).path, MESH_PATH)
  assert.equal(workspaceForPath('/root/other', policy), undefined)
})

ok('设备名解析表：名字与 id 都能命中（大小写不敏感）', () => {
  const names = collectDeviceNames(meshGroups, { deviceId: self, name: 'xray4668' })
  assert.equal(resolveOwnerToken(names, 'orangepi5'), child)
  assert.equal(resolveOwnerToken(names, 'ORANGEPI5'), child)
  assert.equal(resolveOwnerToken(names, ' orangepi5 '), child)
  assert.equal(resolveOwnerToken(names, child), child)
  assert.equal(resolveOwnerToken(names, 'xray4668'), self)
  assert.equal(resolveOwnerToken(names, ''), undefined)
  assert.equal(resolveOwnerToken(names, undefined), undefined)
  assert.equal(resolveOwnerToken(undefined, 'orangepi5'), undefined)
})

ok('互联会话：工作区内的路径 → 发到属主', () => {
  const d = decide(MESH_PATH + '/src/app.js', MESH_PATH)
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.route.root, MESH_PATH)
})

ok('互联会话：工作区之外的路径 → 仍然发到属主（**绝不回落本机**）', () => {
  const d = decide('/etc/hosts', MESH_PATH)
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.route.source, 'mesh-owner')
  assert.equal(d.route.root, MESH_PATH)
  assert.match(explainRoute(d, () => 'orangepi5'), /互联会话/)
})

ok('互联会话：本机自己的工作区路径也发到属主（互联会话不在会话端落地）', () => {
  const d = decide(LOCAL_PATH + '/x', MESH_PATH)
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
})

ok('互联会话：属主就是本机时 → 本机执行（属主那台才是对的）', () => {
  const view = policyFromSessionSide()
  const d = decide(MESH_PATH + '/src/app.js', MESH_PATH, view, child)
  assert.equal(d.route.kind, 'local')
  const outside = decide('/etc/hosts', MESH_PATH, view, child)
  assert.equal(outside.route.kind, 'local')
})

ok('互联会话：属主名字解析不出来 → 用账目兜底（**不是**回落本机，也不是无脑拒绝）', () => {
  const view = policyFromSessionSide()
  const d = routePathWithPolicy('/etc/hosts', {
    owners: view.owners,
    selfDeviceId: self,
    policy: collectWorkspacePolicy({ [MESH_PATH]: { owner: '不存在的设备', mesh: true } }),
    cwd: MESH_PATH,
    resolveOwner: view.resolveOwner,
  })
  // 账目里这条工作区路径挂着对端 → 用账目定属主，照常转发（这正是实测踩到的那条：
  // 会话端的路径组不带 deviceName，声明里的名字解析不出来，旧实现会直接拒绝）。
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.ownerVia, 'ledger')

  // 连 owner 都没声明时同样用账目兜底（`mesh: true` 却没写 owner 是配置疏漏，
  // 但账目知道这条路径归谁，不该因此把会话卡死）。
  const noOwner = routePathWithPolicy('/etc/hosts', {
    owners: view.owners,
    selfDeviceId: self,
    policy: collectWorkspacePolicy({ [MESH_PATH]: { mesh: true } }),
    cwd: MESH_PATH,
    resolveOwner: view.resolveOwner,
  })
  assert.equal(noOwner.route.kind, 'remote')
  assert.equal(noOwner.ownerVia, 'ledger')
})

ok('纯本地会话：即使路径命中远端主路径也不转发', () => {
  const d = decide(MESH_PATH + '/src/app.js', LOCAL_PATH)
  assert.equal(d.route.kind, 'local')
  assert.match(explainRoute(d, () => '?'), /纯本地工作区/)
})

ok('纯本地会话：本机路径本机执行；未登记路径也本机执行', () => {
  assert.equal(decide(LOCAL_PATH + '/x', LOCAL_PATH).route.kind, 'local')
  assert.equal(decide('/tmp/x', LOCAL_PATH).route.kind, 'local')
})

ok('显式附加路径（member）在两种模式下都优先', () => {
  const groups = [
    { workspaceId: 'w-mesh', primary: { deviceId: child, deviceName: 'orangepi5', path: MESH_PATH }, members: [{ deviceId: third, deviceName: 'third', path: '/mnt/scratch' }] },
    { workspaceId: 'w-local', primary: { deviceId: self, deviceName: 'xray4668', path: LOCAL_PATH }, members: [{ deviceId: child, deviceName: 'orangepi5', path: '/srv/mounted' }] },
  ]
  const owners = collectPathOwners(groups)
  const names = collectDeviceNames(groups, { deviceId: self, name: 'xray4668' })
  const policy = collectWorkspacePolicy(meshRoles)
  const resolveOwner = (t) => names.get(String(t ?? '').trim().toLowerCase())
  const meshMember = routePathWithPolicy('/mnt/scratch/a', { owners, selfDeviceId: self, policy, cwd: MESH_PATH, resolveOwner })
  assert.equal(meshMember.route.deviceId, third)
  const localMember = routePathWithPolicy('/srv/mounted/a', { owners, selfDeviceId: self, policy, cwd: LOCAL_PATH, resolveOwner })
  assert.equal(localMember.route.kind, 'remote')
  assert.equal(localMember.route.deviceId, child)
  assert.equal(localMember.route.source, 'member')
})

ok('无法归属会话（cwd 不在任何已声明工作区）→ 沿用旧的按路径判定', () => {
  const d = decide(MESH_PATH + '/src/app.js', '/root/nowhere')
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.route.source, 'primary')
  assert.equal(decide('/tmp/x', '/root/nowhere').route.kind, 'local')
})

ok('策略判定与声明顺序无关', () => {
  const view = policyFromSessionSide()
  const reversed = collectWorkspacePolicy({ [LOCAL_PATH]: { owner: 'xray4668' }, [MESH_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } })
  const d = routePathWithPolicy('/etc/hosts', { owners: view.owners, selfDeviceId: self, policy: reversed, cwd: MESH_PATH, resolveOwner: view.resolveOwner })
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
})

ok('routePath（旧接口）行为逐字不变 —— mesh_exec 等显式动作仍按路径路由', () => {
  const owners = collectPathOwners(meshGroups)
  assert.equal(routePath('/etc/hosts', { owners, selfDeviceId: self }).route.kind, 'local')
  assert.equal(routePath(MESH_PATH + '/x', { owners, selfDeviceId: self }).route.kind, 'remote')
})

ok('设备名解析表：可以从**节点表/接入点表**补名字（路径组里名字为空也能解析）', () => {
  // 真实情形：路由用的路径组是 buildPathGroups([]) 建的，deviceName 是空的。
  const namelessGroups = [
    { workspaceId: 'w-mesh', primary: { deviceId: child, path: MESH_PATH }, members: [{ deviceId: child, path: MESH_PATH }] },
  ]
  const owners = collectPathOwners(namelessGroups)
  const fromGroupsOnly = collectDeviceNames(namelessGroups, { deviceId: self, name: 'xray4668' })
  assert.equal(resolveOwnerToken(fromGroupsOnly, 'orangepi5'), undefined, '只有路径组时名字确实解析不出来（这就是实测踩到的坑）')
  const withDevices = collectDeviceNames(namelessGroups, { deviceId: self, name: 'xray4668' }, [
    { deviceId: child, name: 'orangepi5' },
  ])
  assert.equal(resolveOwnerToken(withDevices, 'orangepi5'), child, '补上设备清单后名字能解析')
  // 于是互联会话的「工作区之外」能正常转发，而不是被拒
  const policy = collectWorkspacePolicy(meshRoles, namelessGroups)
  const d = routePathWithPolicy('/etc/hosts', {
    owners, selfDeviceId: self, policy, cwd: MESH_PATH, resolveOwner: (t) => resolveOwnerToken(withDevices, t),
  })
  assert.equal(d.route.kind, 'remote')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.ownerVia, 'declared')
})

ok('属主名字解析不出来时用**账目**兜底（名字是提示，账目才是权威）', () => {
  const namelessGroups = [
    { workspaceId: 'w-mesh', primary: { deviceId: self, path: MESH_PATH }, members: [{ deviceId: child, path: MESH_PATH }] },
  ]
  const owners = collectPathOwners(namelessGroups)
  const policy = collectWorkspacePolicy(meshRoles, namelessGroups)
  const names = collectDeviceNames(namelessGroups, { deviceId: self, name: 'xray4668' }) // 名字表里没有 orangepi5
  const d = routePathWithPolicy('/etc/hosts', {
    owners, selfDeviceId: self, policy, cwd: MESH_PATH, resolveOwner: (t) => resolveOwnerToken(names, t),
  })
  assert.equal(d.route.kind, 'remote', '名字解析不出来也不该拒 —— 账目里有这条路径的属主')
  assert.equal(d.route.deviceId, child)
  assert.equal(d.ownerVia, 'ledger')
})

ok('账目里也没有属主时才拒绝（失败关闭）', () => {
  const owners = collectPathOwners([{ workspaceId: 'w', primary: { deviceId: self, path: '/root/onlyself' }, members: [] }])
  const policy = collectWorkspacePolicy({ [MESH_PATH]: { owner: '不存在的设备', mesh: true } }, [])
  const d = routePathWithPolicy('/etc/hosts', {
    owners, selfDeviceId: self, policy, cwd: MESH_PATH, resolveOwner: () => undefined,
  })
  assert.equal(d.route.kind, 'denied')
  assert.match(d.route.reason, /解析不到设备/)
  assert.match(d.route.reason, /账目里也没有它的属主/)
})

ok('ownerDeviceForWorkspacePath：只认非本机的属主，更长前缀优先', () => {
  const owners = collectPathOwners([
    { workspaceId: 'w', primary: { deviceId: self, path: MESH_PATH }, members: [{ deviceId: child, path: MESH_PATH }] },
  ])
  assert.equal(ownerDeviceForWorkspacePath(MESH_PATH, owners, self).deviceId, child, '本机是 self → 对端 member 是唯一的「别的设备」')
  // 反过来：把对端当本机看，账目里本机那一份就是「别的设备」。
  assert.equal(ownerDeviceForWorkspacePath(MESH_PATH, owners, child).deviceId, self)
  const selfOnly = collectPathOwners([{ workspaceId: 'w', primary: { deviceId: self, path: MESH_PATH }, members: [] }])
  assert.equal(ownerDeviceForWorkspacePath(MESH_PATH, selfOnly, self), undefined, '账目里只有本机 → 没有别的设备')
  const nested = collectPathOwners([
    { workspaceId: 'w', primary: { deviceId: child, path: '/a' }, members: [{ deviceId: third, path: '/a/b' }] },
  ])
  assert.equal(ownerDeviceForWorkspacePath('/a/b', nested, self).deviceId, third, '更长前缀优先')
  assert.equal(ownerDeviceForWorkspacePath('relative', owners, self), undefined)
})

console.log(`\n  ${n} 项通过`)
