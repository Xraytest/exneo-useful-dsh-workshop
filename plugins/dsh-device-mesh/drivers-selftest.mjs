#!/usr/bin/env node
/**
 * `drivers.js` 自测：纯 node、零第三方依赖、不碰网络、不写真实 DSH_HOME。
 *
 * 设计原则与主自测一致：**每条断言都必须会失败**。夹具按真实 `/tree`、真实
 * `session-replica/index.json`、真实 `exec-audit.jsonl` 的形状手工构造（字段从 .19
 * 的实测输出里摘的），不是随手编的对象 —— 否则测的是想象而不是协议。
 *
 * 用法：`node drivers-selftest.mjs`
 *
 * @module dsh-device-mesh/drivers-selftest
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeDrivers, findDriver, readAuditTail } from './drivers.js'

let pass = 0
let fail = 0

/**
 * 断言相等。
 * @param {unknown} actual 实际值。
 * @param {unknown} expected 期望值。
 * @param {string} label 说明。
 * @returns {void}
 */
function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1
    return
  }
  fail += 1
  console.error(`FAIL ${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}

/**
 * 断言真值。
 * @param {unknown} value 值。
 * @param {string} label 说明。
 * @returns {void}
 */
function ok(value, label) {
  eq(value === true, true, label)
}

const SELF_OPI = { deviceId: 'a0d8c46c63f4f6e66b1b4dcc6ea14114', name: 'orangepi5' }
const DEV_OPI = { deviceId: SELF_OPI.deviceId, name: 'orangepi5', self: true, liveness: 'online' }
const DEV_RPI = { deviceId: 'bf7e92cf6de979871eb225736373ffc0', name: 'xray4668', self: false, liveness: 'online' }
const WS_PATH = '/root/DSHpluginWorkSpace'
const WS_ID = 'db264e09-112c-478f-8bbd-f01baa20307c'
const AT_PATH = '/root/nas/ArkTower'
const AT_ID = '863de1b8-a5f4-4560-beb7-fda46cf99189'

/** 会话 id 常量（形状与出厂一致）。 */
const S1 = 'session-db8fec3f-07b7-4f48-9cb7-e8bacd7a1aa1'
const S2 = 'session-8ee27c35-3606-4679-b4ca-3704776940f2'
const S3 = 'session-c0c74ddc-b106-4e55-8823-d19832616e94'

/**
 * 造一份 `.19`（属主/执行端）视角的 /tree 设备列表。
 * @returns {object[]} 设备列表。
 */
function devicesOwnerSide() {
  return [
    {
      ...DEV_OPI,
      inventory: {
        workspaces: [
          {
            id: WS_ID,
            title: 'DSHpluginWorkSpace',
            path: WS_PATH,
            sessionCount: 1193,
            sessions: [{ id: S1, cwd: WS_PATH, live: false, blank: true, presentLocally: true }],
          },
          {
            id: AT_ID,
            title: 'ArkTower',
            path: AT_PATH,
            sessionCount: 494,
            sessions: [{ id: S3, cwd: AT_PATH, live: false, blank: true, presentLocally: true }],
          },
        ],
      },
    },
    {
      ...DEV_RPI,
      inventory: {
        workspaces: [
          {
            id: WS_ID,
            title: 'DSHpluginWorkSpace',
            path: WS_PATH,
            sessionCount: 1454,
            localMatch: { workspaceId: WS_ID, title: 'DSHpluginWorkSpace', path: WS_PATH },
            sessions: [
              { id: S1, cwd: WS_PATH, live: true, lastActivityAt: 1791900000000, presentLocally: true },
              { id: S2, cwd: WS_PATH, live: false, lastActivityAt: 1791800000000 },
            ],
          },
          {
            id: AT_ID,
            title: 'ArkTower',
            path: AT_PATH,
            sessionCount: 494,
            localMatch: { workspaceId: AT_ID, title: 'ArkTower', path: AT_PATH },
            sessions: [{ id: S3, cwd: AT_PATH, live: false, lastActivityAt: 1791700000000 }],
          },
        ],
      },
    },
  ]
}

/** `.19` 的 pathGroups：两个工作区的主路径都在本机。 */
const GROUPS_OWNER = [
  {
    id: 'e14042cb5367b437',
    homeDeviceId: SELF_OPI.deviceId,
    workspaceId: WS_ID,
    workspaceTitle: 'DSHpluginWorkSpace',
    orphan: false,
    primary: { deviceId: SELF_OPI.deviceId, deviceName: 'orangepi5', path: WS_PATH, fromLiveRegistry: true, local: true, stale: false },
    members: [],
  },
  {
    id: '8b4f8572fdb0e560',
    homeDeviceId: SELF_OPI.deviceId,
    workspaceId: AT_ID,
    workspaceTitle: 'ArkTower',
    orphan: false,
    primary: { deviceId: SELF_OPI.deviceId, deviceName: 'orangepi5', path: AT_PATH, fromLiveRegistry: true, local: true, stale: false },
    members: [],
  },
]

/** 真实镜像索引项（字段从 .19 的 index.json 摘的）。 */
const REPLICAS = [
  { deviceId: DEV_RPI.deviceId, sessionId: S1, cwd: WS_PATH, title: '', workspacePath: WS_PATH, sourceDeviceName: 'xray4668', firstSeq: 0, lastSeq: 1959, events: 1960, bytes: 9362868, createdAt: '2026-10-11T05:11:07.882Z', updatedAt: '2026-10-13T04:20:41.807Z' },
  { deviceId: DEV_RPI.deviceId, sessionId: S2, cwd: WS_PATH, title: '', workspacePath: WS_PATH, sourceDeviceName: 'xray4668', firstSeq: 0, lastSeq: 507, events: 508, bytes: 1898036, createdAt: '2026-10-13T01:59:54.052Z', updatedAt: '2026-10-13T03:01:25.509Z' },
]

/** 真实入站审计条目形状（direction=in）。 */
const AUDIT = [
  { id: 'df5272a7dcec', at: '2026-10-13T10:45:11.980Z', deviceId: DEV_RPI.deviceId, deviceName: 'xray4668', direction: 'in', actor: 'remote', path: WS_PATH, cwd: WS_PATH, command: 'tail -c +3870721 "/root/.dsh/sessions/--root-DSHpluginWorkSpace--/' + S1 + '/session.v4.jsonl.zstd" | head -c 184320 | base64 -w0', outcome: 'ok', exitCode: 0 },
  { id: 'aa11', at: '2026-10-13T10:40:00.000Z', deviceId: DEV_RPI.deviceId, deviceName: 'xray4668', direction: 'in', actor: 'remote', path: WS_PATH, cwd: WS_PATH, command: 'git status --short', outcome: 'ok', exitCode: 0 },
  { id: 'bb22', at: '2026-10-13T10:39:00.000Z', deviceId: DEV_RPI.deviceId, deviceName: 'xray4668', direction: 'in', actor: 'remote', path: WS_PATH, cwd: WS_PATH, command: 'sudo rm -rf /', outcome: 'denied', code: 'exec-denied' },
  { id: 'dd44', at: '2026-10-13T10:38:30.000Z', deviceId: DEV_RPI.deviceId, deviceName: 'xray4668', direction: 'in', actor: 'remote', path: '/etc', cwd: '/etc', command: 'cat /etc/shadow', outcome: 'denied', code: 'path-not-exported' },
  { id: 'cc33', at: '2026-10-13T10:38:00.000Z', deviceId: SELF_OPI.deviceId, deviceName: 'orangepi5', direction: 'out', actor: 'browser', path: WS_PATH, cwd: WS_PATH, command: 'echo 本机发出去的，不算入站', outcome: 'ok' },
]

// ── 场景 1：属主/执行端（.19）—— 人工声明 + 运行时证据 ─────────────────────────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: devicesOwnerSide(),
    pathGroups: GROUPS_OWNER,
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true }, [AT_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } },
    replicas: REPLICAS,
    auditEntries: AUDIT,
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  ok(hit !== null, '属主侧：按 workspaceId 查到判定')
  eq(hit.path, WS_PATH, '属主侧：路径')
  eq(hit.owner.isSelf, true, '属主侧：owner 是本机（命令在这里跑）')
  eq(hit.owner.source, 'roles', '属主侧：owner 来自声明')
  eq(hit.session.isSelf, false, '属主侧：会话侧不是本机')
  eq(hit.session.name, 'xray4668', '属主侧：会话侧设备名')
  eq(hit.mesh, true, '属主侧：mesh 来自声明')
  eq(hit.remote, true, '属主侧：判定为「会话在远端执行」')
  eq(hit.active, true, '属主侧：有运行时证据')
  eq(hit.evidence.mirrorSessions, 2, '属主侧：镜像到本机的会话 2 条')
  eq(hit.evidence.mirrorLastAt, '2026-10-13T04:20:41.807Z', '属主侧：镜像最近时间')
  eq(hit.evidence.inboundExec, 2, '属主侧：入站成功执行 2 次')
  eq(hit.evidence.inboundDenied, 1, '属主侧：入站被拒 1 次（也要看见）')
  eq(hit.evidence.inboundTotal, 3, '属主侧：本工作区的入站尝试总数')
  eq(hit.evidence.inboundExec + hit.evidence.inboundDenied, 3, '属主侧：out 方向的条目没被算进来')
  eq(hit.evidence.inboundLastAt, '2026-10-13T10:45:11.980Z', '属主侧：最近一次入站时间')
  eq(hit.evidence.inboundDevices.join(','), 'xray4668', '属主侧：入站设备名去重')
  eq(hit.evidence.inboundLastCommand.startsWith('tail -c +3870721'), true, '属主侧：最近一条命令原文')
  eq(hit.evidence.inboundLastCommand.includes('/etc/shadow'), false, '属主侧：/etc 的拒绝不算进本工作区')
  eq(hit.remoteDevices.length, 1, '属主侧：报了这个工作区的对端设备 1 台')
  eq(hit.remoteDevices[0].sessions, 2, '属主侧：该对端在这个工作区的会话数')
  // 会话级证据
  const s1 = drivers.sessions.find((item) => item.sessionId === S1)
  ok(s1 !== undefined, '属主侧：会话 S1 有证据条目')
  eq(s1.mirror, true, '属主侧：S1 历史被镜像到本机')
  eq(s1.source, 'exec', '属主侧：S1 有入站执行证据（命令原文里点到它）→ exec 优先')
  eq(s1.inbound, 1, '属主侧：S1 的入站执行次数')
  eq(s1.workspaceId, WS_ID, '属主侧：S1 归属到该工作区')
  eq(s1.deviceName, 'xray4668', '属主侧：S1 的会话侧设备名')
  eq(s1.mirrorEvents, 1960, '属主侧：S1 的镜像事件数')
  const s2 = drivers.sessions.find((item) => item.sessionId === S2)
  ok(s2 !== undefined, '属主侧：会话 S2 有证据条目（只有镜像）')
  eq(s2.source, 'mirror', '属主侧：S2 只有镜像证据')
  eq(s2.inbound, 0, '属主侧：S2 没有入站执行证据（不硬扯）')
  // 稀疏性：没有运行时证据的会话不进来（S3 只有清单，没有镜像/入站）
  eq(drivers.sessions.find((item) => item.sessionId === S3), undefined, '属主侧：无证据的会话不进 sessions')
  eq(drivers.sessions.length, 2, '属主侧：sessions 只放有证据的（稀疏，不是清单副本）')
  // 另一个工作区：方向同样是远端，但没有运行时证据
  const ark = findDriver(drivers, { path: AT_PATH })
  ok(ark !== null, '属主侧：ArkTower 也有判定')
  eq(ark.remote, true, '属主侧：ArkTower 的会话也在远端执行')
  eq(ark.active, false, '属主侧：ArkTower 没有运行时证据 → active=false')
  eq(ark.evidence.mirrorSessions, 0, '属主侧：ArkTower 没有镜像')
  eq(ark.evidence.inboundTotal, 0, '属主侧：ArkTower 没有入站执行')
  // 按路径（含子目录）也能查
  ok(findDriver(drivers, { path: WS_PATH + '/packages/app' }) !== null, '属主侧：按子路径也能查到')
  eq(findDriver(drivers, { path: '/root/nowhere' }), null, '属主侧：无关路径查不到')
}

// ── 场景 2：会话端（.3）—— 方向反过来，不能标成「会话在远端」 ────────────────
{
  const drivers = computeDrivers({
    self: { deviceId: DEV_RPI.deviceId, name: 'xray4668' },
    devices: [
      { ...DEV_RPI, self: true, inventory: { workspaces: [{ id: WS_ID, path: WS_PATH, title: 'DSHpluginWorkSpace', sessions: [] }] } },
      { ...DEV_OPI, self: false, inventory: { workspaces: [{ id: WS_ID, path: WS_PATH, localMatch: { workspaceId: WS_ID, path: WS_PATH }, sessions: [] }] } },
    ],
    pathGroups: [{ workspaceId: WS_ID, primary: { deviceId: DEV_OPI.deviceId, deviceName: 'orangepi5', path: WS_PATH, local: false } }],
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true }, [AT_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } },
    replicas: [],
    auditEntries: [],
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  eq(hit.owner.isSelf, false, '会话侧：owner 是远端（命令发到那边）')
  eq(hit.session.isSelf, true, '会话侧：会话就在本机')
  eq(hit.remote, false, '会话侧：**不是**「会话在远端执行」——方向不能反')
}

// ── 场景 3：没有声明 mesh —— 即使对端清单能推出会话侧，也**不是**互联会话 ──────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: devicesOwnerSide(),
    pathGroups: GROUPS_OWNER,
    roles: {},
    replicas: [],
    auditEntries: [],
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  eq(hit.session.isSelf, false, '无声明：会话侧由 localMatch 推出，不是本机')
  eq(hit.session.source, 'inventory', '无声明：来源标 inventory')
  eq(hit.session.name, 'xray4668', '无声明：会话侧设备名')
  eq(hit.mesh, false, '无声明：mesh 缺省 false（纯本地工作区）')
  eq(hit.remote, false, '无声明：**不标**远端执行（纯本地工作区一律本机落地）')
  eq(hit.active, false, '无声明且无证据：active 为 false（纯静态判定）')
}

// ── 场景 3b：声明了 owner/session 但**没有** mesh → 仍然是纯本地 ──────────────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: devicesOwnerSide(),
    pathGroups: GROUPS_OWNER,
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668' } },
    replicas: REPLICAS,
    auditEntries: AUDIT,
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  eq(hit.mesh, false, '声明了角色但没声明 mesh：mesh=false')
  eq(hit.remote, false, '声明了角色但没声明 mesh：不标远端执行（界面与路由共用同一个开关）')
  eq(hit.evidence.inboundTotal, 3, '证据仍然照实统计（诊断用），只是不画标识')
}

// ── 场景 3c：mesh 显式 false → 纯本地 ────────────────────────────────────────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: devicesOwnerSide(),
    pathGroups: GROUPS_OWNER,
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: false } },
    replicas: [],
    auditEntries: [],
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  eq(hit.mesh, false, 'mesh: false → mesh=false')
  eq(hit.remote, false, 'mesh: false → 不标远端执行')
}

// ── 场景 4：对端独有的工作区（没有 localMatch）不能标 ────────────────────────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: [
      { ...DEV_OPI, inventory: { workspaces: [] } },
      {
        ...DEV_RPI,
        inventory: {
          workspaces: [{
            id: 'ffffffff-0000-0000-0000-000000000000',
            path: '/root/only-on-rpi',
            title: 'rpi 独有',
            sessions: [{ id: S2, cwd: '/root/only-on-rpi', live: true }],
          }],
        },
      },
    ],
    pathGroups: [],
    roles: {},
    replicas: [],
    auditEntries: [],
  })
  const hit = drivers.workspaces.find((item) => item.path === '/root/only-on-rpi')
  eq(hit.remote, false, '对端独有工作区：方向是反的，不标')
  eq(hit.owner.source, 'unknown', '对端独有工作区：属主未知（不猜）')
}

// ── 场景 5：声明了但设备离线/清单里没有 —— 名字仍要显示 ─────────────────────
{
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: [DEV_OPI],
    pathGroups: [],
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true }, [AT_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } },
    replicas: [],
    auditEntries: [],
  })
  const hit = findDriver(drivers, { path: WS_PATH })
  ok(hit !== null, '离线声明：清单里没有也要有一条判定')
  eq(hit.session.name, 'xray4668', '离线声明：名字仍然给出来')
  eq(hit.session.unresolved, true, '离线声明：标 unresolved，不假装在线')
  eq(hit.session.online, false, '离线声明：online=false')
  eq(hit.remote, true, '离线声明：仍然是远端会话（那台就是不在线而已）')
}

// ── 场景 6：恶意/畸形输入不抛、不污染 ───────────────────────────────────────
{
  const drivers = computeDrivers({
    self: null,
    devices: [null, undefined, { deviceId: SELF_OPI.deviceId, inventory: { workspaces: [null, 'x', { id: WS_ID, path: WS_PATH, sessions: [null, { id: 'not-a-session' }] }] } }],
    pathGroups: [null, {}],
    roles: { [WS_PATH]: { session: { toString: null } } },
    replicas: [null, { deviceId: 'x', sessionId: '__proto__' }, { sessionId: S1, workspacePath: WS_PATH, deviceId: DEV_RPI.deviceId }],
    auditEntries: [null, 'x', { direction: 'in', cwd: WS_PATH, command: 42 }, { direction: 'in', cwd: WS_PATH, command: 'echo ' + 'a'.repeat(5000), at: '2026-10-13T10:00:00.000Z' }],
  })
  ok(Array.isArray(drivers.workspaces), '畸形输入：workspaces 仍是数组')
  eq(Object.prototype.polluted, undefined, '畸形输入：没有污染原型')
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  ok(hit !== null, '畸形输入：合法的那部分照常判定')
  eq(hit.evidence.inboundLastCommand.length <= 240, true, '畸形输入：超长命令被截断')
  eq(findDriver({ workspaces: null }, { workspaceId: WS_ID }), null, '畸形输入：findDriver 不抛')
}

// ── 场景 7：readAuditTail 的边界 ────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmesh-drivers-'))
  const file = path.join(dir, 'exec-audit.jsonl')
  const rows = []
  for (let index = 0; index < 50; index += 1) {
    rows.push(JSON.stringify({ id: `e${index}`, at: `2026-10-13T10:00:${String(index).padStart(2, '0')}.000Z`, direction: 'in', cwd: WS_PATH, command: `cmd ${index}` }))
  }
  fs.writeFileSync(file, rows.join('\n') + '\n', 'utf8')
  const tail = readAuditTail(file, { maxBytes: 4096, maxEntries: 5 })
  eq(tail.source, 'file', 'readAuditTail：来源是文件')
  eq(tail.entries.length, 5, 'readAuditTail：条数受 maxEntries 限制')
  eq(tail.entries[0].id, 'e49', 'readAuditTail：最新的在前')
  eq(tail.entries[4].id, 'e45', 'readAuditTail：逆序取 5 条')
  eq(tail.entries.every((entry) => typeof entry.id === 'string'), true, 'readAuditTail：没有半截行混进来')
  const all = readAuditTail(file, { maxBytes: 10 * 1024 * 1024, maxEntries: 1000 })
  eq(all.entries.length, 50, 'readAuditTail：整份都能读到')
  eq(all.entries[0].id, 'e49', 'readAuditTail：整份时最新仍然在前')
  eq(readAuditTail(path.join(dir, '不存在.jsonl'), {}).entries.length, 0, 'readAuditTail：文件不存在返回空')
  eq(readAuditTail(path.join(dir, '不存在.jsonl'), {}).source, 'none', 'readAuditTail：文件不存在标 none')
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 场景 8：computeDrivers 直接吃 auditFile（自己读尾部）────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmesh-drivers-'))
  const file = path.join(dir, 'exec-audit.jsonl')
  fs.writeFileSync(file, AUDIT.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  const drivers = computeDrivers({
    self: SELF_OPI,
    devices: devicesOwnerSide(),
    pathGroups: GROUPS_OWNER,
    roles: { [WS_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true }, [AT_PATH]: { owner: 'orangepi5', session: 'xray4668', mesh: true } },
    replicas: [],
    auditFile: file,
  })
  const hit = findDriver(drivers, { workspaceId: WS_ID })
  eq(hit.evidence.inboundExec, 2, 'auditFile：自己读尾部也能数出入站执行')
  eq(drivers.auditSource, 'file', 'auditFile：来源标 file')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\ndrivers-selftest: ${pass} PASS / ${fail} FAIL`)
if (fail > 0) process.exit(1)
