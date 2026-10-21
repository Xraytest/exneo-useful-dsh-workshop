/**
 * 远端会话驱动检测（**执行端视角**）。
 *
 * ── 解决的是什么问题 ────────────────────────────────────────────────────────
 * 工作区的「属主/执行侧」与「会话侧」可以不在同一台机器上：以 `DSHpluginWorkSpace`
 * 为例，文件与命令真正跑在 opi（执行端），而 agent/会话跑在 rpi（会话端）。于是
 * **执行端**（opi）的界面上必须能看出「这个工作区里有一条会话正在远端执行，它的
 * 命令会发到本机」—— 这是安全相关的事实，而不只是导航信息。
 *
 * 之前这里是个空缺：P1 为了修掉「属主侧被误标成转发执行工作区」的错误标注，把
 * 属主/执行侧的标注整个 `return null` 掉了。修得没错（原来那个判据对两台都成立，
 * 方向是错的），但结果是执行端**一条标识都没有**。本模块补的就是这个方向。
 *
 * ── 判据（运行时证据优先，配置声明兜底）─────────────────────────────────────
 * | # | 来源 | 含义 | 强度 |
 * | --- | --- | --- | --- |
 * | 1 | 会话镜像索引 `session-replica/index.json` | 该工作区的会话历史被推到本机 | 只有**转发执行**的会话才会被镜像，所以这是「会话在远端」的硬证据 |
 * | 2 | 入站执行审计 `exec-audit.jsonl`（direction=in） | 远端**真的把命令发到本机**执行过 | 最强：不是「可能」，是「已经发生」 |
 * | 3 | 对端清单里的 `localMatch` | 对端报了同一个工作区（同 id 或同路径） | 说明对端也在用这个工作区，但它单独不能定方向 |
 * | 4 | `config.workspaceRoles[path] = {owner, session}` | 人工声明的角色 | 声明，不随运行时变化 |
 *
 * 方向由「会话侧是不是本机」决定：
 *   · 会话侧 = 本机 → 本机在跑 agent（可能命令发到别处）→ **不是**本模块要标的东西；
 *   · 会话侧 = 远端 → 会话在远端执行，命令会到属主侧 → 执行端要标的就是这条。
 *
 * 但还要过一道开关：`workspaceRoles[path].mesh === true`（**是否作为互联会话**）。
 * 没声明 mesh 的工作区是**纯本地**工作区 —— 路由一律本机落地，这时标成「远端执行」
 * 就是错的。界面与路由共用这一个开关，两者不会各说各话。
 *
 * 本模块只做**判定**，不改任何出厂数据、不发起网络请求：输入是已经组装好的
 * `/tree` 设备列表、配置里的角色声明、镜像索引与审计尾部。
 *
 * ── 为什么放在 host 而不是浏览器 ────────────────────────────────────────────
 * 镜像索引与执行审计都是**本机文件**，浏览器侧拿不到；而且判定要「同工作区」
 * 的多种口径（id / path / realpath 后前缀），host 一次算完比浏览器每轮轮询重算可靠。
 *
 * ── 输出形状 ────────────────────────────────────────────────────────────────
 * ```
 * { schema, generatedAt, selfDeviceId, selfName,
 *   workspaces: [ { workspaceId, path, title,
 *                   owner:   { deviceId, name, isSelf, online, source },
 *                   session: { deviceId, name, isSelf, online, source, unresolved? },
 *                   mesh,                       // 配置声明「是否作为互联会话」
 *                   remote,                     // mesh && 会话侧不是本机 → 执行端要标的就是它
 *                   active,                     // 有运行时证据（镜像 / 入站执行）
 *                   evidence: { mirrorSessions, mirrorLastAt,
 *                               inboundExec, inboundDenied, inboundTotal,
 *                               inboundLastAt, inboundLastCommand, inboundDevices },
 *                   remoteDevices: [ { deviceId, deviceName, online, sessions } ] } ],
 *   sessions: [ { sessionId, deviceId, deviceName, workspaceId, workspacePath, title,
 *                 live, lastActivityAt, mirror, mirrorEvents, mirrorLastAt,
 *                 inbound, inboundLastAt, presentLocally, source } ],
 *   truncated }
 * ```
 * `sessions` **只放有运行时证据的会话**（镜像到的 / 命令原文里点到名的），不是对端
 * 清单的副本 —— 那份清单已经在 `/tree` 的 `devices[].inventory` 里了。
 *
 * @module dsh-device-mesh/drivers
 */

import fs from 'node:fs'

/** 单个字符串字段的截断上限（防止清单里的巨串把 /tree 撑爆）。 */
const MAX_NAME = 160
const MAX_TITLE = 300
const MAX_PATH = 1024
const MAX_COMMAND = 240
/** 有运行时证据的会话条目上限（证据本身是稀疏的，这个上限只防病态）。 */
const MAX_EVIDENCE_SESSIONS = 400
/** 审计尾部默认读多少字节（**不整份读**：审计文件上限 8 MB，每次轮询整份读太亏）。 */
const DEFAULT_AUDIT_BYTES = 256 * 1024
const DEFAULT_AUDIT_ENTRIES = 400

/** `session-<uuid>` —— 会话 id 的出厂形状。 */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 从命令文本里**尽力**捞会话 id（审计里没有 sessionId 字段，只有命令原文）。 */
const SESSION_ID_SCAN_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * 取一个安全字符串。
 * @param {unknown} value 原始值。
 * @param {number} max 上限长度。
 * @returns {string} 字符串（超长截断，非字符串归空）。
 */
function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 规范化路径：去掉尾部斜杠（根目录除外），统一分隔符。
 * @param {unknown} value 原始路径。
 * @returns {string} 规范化路径；非法输入归空。
 */
function normPath(value) {
  const raw = text(value, MAX_PATH)
  if (raw === '') return ''
  const unified = raw.replace(/\\/g, '/')
  const stripped = unified.replace(/\/+$/, '')
  return stripped === '' ? '/' : stripped
}

/**
 * `target` 是否等于 `root` 或落在它之下（纯字符串口径，两侧都先规范化）。
 * @param {string} root 根。
 * @param {string} target 目标。
 * @returns {boolean} 是否在根内。
 */
function isWithin(root, target) {
  if (root === '' || target === '') return false
  if (target === root) return true
  return target.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * 设备署名：id 与名字都能命中同一条记录（配置里写的是名字，清单里给的是 id）。
 * @param {{deviceId?: string, name?: string}} device 设备。
 * @returns {string[]} 可命中的键（小写）。
 */
function deviceKeys(device) {
  const keys = []
  const id = text(device?.deviceId, MAX_NAME)
  const name = text(device?.name, MAX_NAME)
  if (id !== '') keys.push(id.toLowerCase())
  if (name !== '') keys.push(name.toLowerCase())
  return keys
}

/**
 * 按 id 或名字找设备。
 * @param {object[]} devices 设备列表。
 * @param {string} wanted 配置里写的设备（id 或名字）。
 * @returns {object|null} 命中的设备；没命中返回 null。
 */
function findDevice(devices, wanted) {
  const key = text(wanted, MAX_NAME).toLowerCase()
  if (key === '') return null
  for (const device of devices) {
    if (deviceKeys(device).includes(key)) return device
  }
  return null
}

/**
 * 读审计文件的**尾部**（不整份读）。
 *
 * 审计文件上限 8 MB，而 `/tree` 每 15 s 被轮询一次；整份 `readFileSync` 会把
 * 「看一眼有没有人往本机发命令」变成每轮 8 MB 的垃圾 IO。这里只读最后
 * `maxBytes` 字节，丢掉第一行（很可能是半截行），再从后往前取 `maxEntries` 条。
 *
 * @param {string} file 审计文件路径。
 * @param {{maxBytes?: number, maxEntries?: number}} [options] 上限。
 * @returns {{entries: object[], source: 'file', bytes: number}|{entries: object[], source: 'none', bytes: number}} 结果（新→旧）。
 */
export function readAuditTail(file, options = {}) {
  const maxBytes = Math.max(4096, Number(options.maxBytes) || DEFAULT_AUDIT_BYTES)
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_AUDIT_ENTRIES)
  let handle = null
  try {
    const stat = fs.statSync(file)
    const size = stat.size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return { entries: [], source: 'file', bytes: 0 }
    handle = fs.openSync(file, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const read = fs.readSync(handle, buffer, 0, length, start)
    let text = buffer.subarray(0, read).toString('utf8')
    // 只有真的从中间开始时，第一行才可能是半截；从头读就不必丢。
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n')
    const entries = []
    for (let index = lines.length - 1; index >= 0 && entries.length < maxEntries; index -= 1) {
      const line = lines[index].trim()
      if (line === '') continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
      } catch {
        // 半截行 / 坏行：跳过，不因为一行坏掉就放弃整份证据。
      }
    }
    return { entries, source: 'file', bytes: length }
  } catch {
    return { entries: [], source: 'none', bytes: 0 }
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle) } catch { /* 关不上也只能算了 */ }
    }
  }
}

/** 归并同一工作区的两条记录（id 与 path 两种口径可能各来一条）。 */
function mergeWorkspace(target, incoming) {
  if (target.workspaceId === '' && incoming.workspaceId !== '') target.workspaceId = incoming.workspaceId
  if (target.path === '' && incoming.path !== '') target.path = incoming.path
  if (target.title === '' && incoming.title !== '') target.title = incoming.title
  return target
}

/**
 * 计算「哪些工作区的会话在远端执行」。
 *
 * 输入全部来自调用方（host 入口），本函数**不做 IO**（审计尾部由调用方用
 * `readAuditTail` 读好传进来，当然传 `auditFile` 也可以，这里会自己读）。
 *
 * @param {object} input 输入。
 * @param {{deviceId?: string, name?: string}} input.self 本机设备。
 * @param {object[]} [input.devices] `/tree` 的设备列表（含 self）。
 * @param {object[]} [input.pathGroups] `/tree` 的工作区多路径分组。
 * @param {object} [input.roles] 配置 `workspaceRoles`：路径 → `{owner, session}`。
 * @param {object[]} [input.replicas] 会话镜像索引项（`SessionReplicaStore.index` 的值）。
 * @param {object[]} [input.auditEntries] 审计条目（新→旧）。
 * @param {string} [input.auditFile] 审计文件（给了就自己读尾部）。
 * @param {number} [input.now] 当前时间。
 * @returns {object} 判定结果（见下）。
 */
export function computeDrivers(input = {}) {
  const now = Number(input.now) || Date.now()
  const selfId = text(input.self?.deviceId, MAX_NAME)
  const selfName = text(input.self?.name, MAX_NAME)
  const devices = Array.isArray(input.devices) ? input.devices : []
  const pathGroups = Array.isArray(input.pathGroups) ? input.pathGroups : []
  const roles = input.roles !== null && typeof input.roles === 'object' && !Array.isArray(input.roles) ? input.roles : {}
  const replicas = Array.isArray(input.replicas) ? input.replicas : []
  const audit = Array.isArray(input.auditEntries)
    ? input.auditEntries
    : (typeof input.auditFile === 'string' && input.auditFile !== ''
      ? readAuditTail(input.auditFile, { maxBytes: input.maxAuditBytes, maxEntries: input.maxAuditEntries }).entries
      : [])

  /** 设备描述提炼：统一成 {deviceId, name, isSelf, online}。 */
  const describe = (device) => ({
    deviceId: text(device?.deviceId, MAX_NAME),
    name: text(device?.name, MAX_NAME) || text(device?.deviceId, MAX_NAME),
    isSelf: device?.self === true || (selfId !== '' && text(device?.deviceId, MAX_NAME) === selfId),
    online: device?.liveness === 'online' || device?.self === true,
  })

  // ── 1. 收集工作区：本机账目 + 对端账目（对端带 localMatch 的才算「同一个工作区」）──
  /** @type {Map<string, object>} 键：`path:` 或 `id:`，值：工作区聚合。 */
  const collected = new Map()
  /** 取（或建）一个工作区聚合。 */
  const bucketFor = (workspaceId, path, title) => {
    const key = path !== '' ? `path:${path}` : `id:${workspaceId}`
    let bucket = collected.get(key)
    if (bucket === undefined) {
      bucket = {
        workspaceId: workspaceId !== '' ? workspaceId : '',
        path,
        title,
        localReport: false,
        localSessions: new Set(),
        /** @type {Map<string, {device: object, workspace: object}>} 报了这个工作区的对端设备。 */
        remoteReports: new Map(),
        /** @type {Map<string, object>} 会话 id → 对端会话条目。 */
        remoteSessions: new Map(),
      }
      collected.set(key, bucket)
    }
    mergeWorkspace(bucket, { workspaceId, path, title })
    return bucket
  }

  // 先按**声明**把工作区立起来：对端离线、清单降级时，声明仍然要能变成一条判定，
  // 否则「我知道这个工作区的会话在别处跑」会因为拿不到对端清单而整个消失 ——
  // 而那恰恰是最该看见它的时刻（对端刚掉线、命令却刚发过来过）。
  for (const rolePath of Object.keys(roles)) {
    const path = normPath(rolePath)
    if (path === '') continue
    bucketFor('', path, '')
  }

  for (const device of devices) {
    const workspaces = Array.isArray(device?.inventory?.workspaces) ? device.inventory.workspaces : []
    if (workspaces.length === 0) continue
    const info = describe(device)
    for (const workspace of workspaces) {
      if (workspace === null || typeof workspace !== 'object') continue
      const workspaceId = text(workspace.id, MAX_NAME)
      const path = normPath(workspace.path)
      const title = text(workspace.title, MAX_TITLE)
      if (workspaceId === '' && path === '') continue
      const bucket = bucketFor(workspaceId, path, title)
      const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : []
      if (info.isSelf) {
        bucket.localReport = true
        for (const session of sessions) {
          const id = text(session?.id, MAX_NAME)
          if (id !== '') bucket.localSessions.add(id)
        }
        continue
      }
      // 对端：只有它报了 `localMatch`（= 同一个工作区在本机也有账目）时，「这个工作区
      // 在本机执行、而它在远端的会话在驱动」才成立。没有 localMatch 的对端工作区是
      // 对端**独有**的工作区，方向是反的（它的命令不会到本机），不参与本判定。
      const localMatch = workspace.localMatch
      if (localMatch === null || localMatch === undefined) continue
      bucket.remoteReports.set(info.deviceId, { device: info, workspace })
      for (const session of sessions) {
        const id = text(session?.id, MAX_NAME)
        if (id === '' || !SESSION_ID_RE.test(id)) continue
        const previous = bucket.remoteSessions.get(id)
        if (previous !== undefined && previous.live === true) continue
        bucket.remoteSessions.set(id, {
          sessionId: id,
          device: info,
          title: text(session.title, MAX_TITLE),
          live: session.live === true,
          lastActivityAt: Number(session.lastActivityAt) || Number(session.createdAt) || null,
          presentLocally: session.presentLocally === true,
        })
      }
    }
  }

  // ── 2. pathGroups：主路径的属主（谁的文件与命令在这台机器上）──
  /** @type {Map<string, {deviceId: string, name: string, local: boolean}>} 工作区 id → 主路径属主。 */
  const ownerByWorkspaceId = new Map()
  /** @type {Map<string, {deviceId: string, name: string, local: boolean}>} 路径 → 主路径属主。 */
  const ownerByPath = new Map()
  for (const group of pathGroups) {
    if (group === null || typeof group !== 'object') continue
    const primary = group.primary
    if (primary === null || primary === undefined) continue
    const owner = {
      deviceId: text(primary.deviceId, MAX_NAME),
      name: text(primary.deviceName, MAX_NAME) || text(primary.deviceId, MAX_NAME),
      local: primary.local === true || (selfId !== '' && text(primary.deviceId, MAX_NAME) === selfId),
    }
    const workspaceId = text(group.workspaceId, MAX_NAME)
    const path = normPath(primary.path)
    if (workspaceId !== '') ownerByWorkspaceId.set(workspaceId, owner)
    if (path !== '') ownerByPath.set(path, owner)
  }

  // ── 3. 运行时证据：会话镜像 + 入站执行审计 ──
  /** @type {Map<string, object[]>} 路径 → 镜像索引项。 */
  const replicasByPath = new Map()
  /** @type {Map<string, object[]>} 会话 id → 镜像索引项（同一会话可能多条来源）。 */
  const replicasBySession = new Map()
  for (const replica of replicas) {
    if (replica === null || typeof replica !== 'object') continue
    const sessionId = text(replica.sessionId, MAX_NAME)
    if (sessionId === '' || !SESSION_ID_RE.test(sessionId)) continue
    const path = normPath(replica.workspacePath) || normPath(replica.cwd)
    if (path !== '') {
      const list = replicasByPath.get(path)
      if (list === undefined) replicasByPath.set(path, [replica])
      else list.push(replica)
    }
    const bySession = replicasBySession.get(sessionId)
    if (bySession === undefined) replicasBySession.set(sessionId, [replica])
    else bySession.push(replica)
  }

  /** @type {Map<string, object[]>} 路径 → 入站审计条目（新→旧）。 */
  const inboundByPath = new Map()
  /** @type {Map<string, object[]>} 会话 id → 入站审计条目。 */
  const inboundBySession = new Map()
  for (const entry of audit) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.direction !== 'in') continue
    const path = normPath(entry.cwd) || normPath(entry.path)
    if (path !== '') {
      const list = inboundByPath.get(path)
      if (list === undefined) inboundByPath.set(path, [entry])
      else list.push(entry)
    }
    // 审计里**没有** sessionId 字段（exec 请求体里就没有）。只有在命令原文里出现
    // 会话 id 时才能归到具体会话 —— 这是**尽力而为**的归属，宁可少标不要错标。
    const command = typeof entry.command === 'string' ? entry.command : ''
    if (command === '') continue
    const found = command.match(SESSION_ID_SCAN_RE)
    if (found === null) continue
    for (const raw of new Set(found.map((value) => value.toLowerCase()))) {
      const list = inboundBySession.get(raw)
      if (list === undefined) inboundBySession.set(raw, [entry])
      else list.push(entry)
    }
  }

  /**
   * 从一组审计条目里算出入站执行的汇总。
   *
   * `ok` 是「**在本机真的跑起来过**的入站命令」，含非零退出 / 超时 / 被取消 ——
   * 对「命令有没有发到本机」这个问题来说，跑失败的命令同样是既成事实；被四道门
   * 拒绝的（`outcome === 'denied'`）单独计，它回答的是另一个问题（有没有人来试）。
   * @param {object[]} entries 审计条目。
   * @returns {{ok: number, denied: number, total: number, lastAt: string|null, lastCommand: string, devices: string[]}} 汇总。
   */
  const inboundSummary = (entries) => {
    const devices = new Set()
    let ok = 0
    let denied = 0
    let lastAt = null
    let lastCommand = ''
    for (const entry of entries) {
      if (entry.outcome === 'denied') denied += 1
      else ok += 1
      const name = text(entry.deviceName, MAX_NAME) || text(entry.deviceId, MAX_NAME)
      if (name !== '') devices.add(name)
      const at = text(entry.at, 40)
      if (at !== '' && (lastAt === null || at > lastAt)) {
        lastAt = at
        lastCommand = text(entry.command, MAX_COMMAND)
      }
    }
    return { ok, denied, total: entries.length, lastAt, lastCommand, devices: [...devices] }
  }

  // ── 4. 逐个工作区定方向 ──
  const workspaces = []
  /** @type {Map<string, object>} 会话 id → 有证据的会话条目。 */
  const evidenceSessions = new Map()
  for (const bucket of collected.values()) {
    const role = bucket.path !== '' && roles[bucket.path] !== null && typeof roles[bucket.path] === 'object'
      ? roles[bucket.path]
      : null

    // 属主：人工声明 > 本机注册表（pathGroups 主路径）> 本机账目。
    const declaredOwner = findDevice(devices, role?.owner)
    const groupOwner = (bucket.workspaceId !== '' ? ownerByWorkspaceId.get(bucket.workspaceId) : undefined)
      ?? (bucket.path !== '' ? ownerByPath.get(bucket.path) : undefined)
    let owner
    if (declaredOwner !== null) {
      owner = { ...describe(declaredOwner), source: 'roles' }
    } else if (groupOwner !== undefined) {
      owner = {
        deviceId: groupOwner.deviceId,
        name: groupOwner.name,
        isSelf: groupOwner.local,
        online: true,
        source: 'registry',
      }
    } else if (bucket.localReport) {
      owner = { deviceId: selfId, name: selfName, isSelf: true, online: true, source: 'local' }
    } else {
      owner = { deviceId: '', name: '', isSelf: false, online: false, source: 'unknown' }
    }

    // 会话侧：人工声明 > 对端清单（谁报了同一个工作区）> 本机。
    const declaredSession = findDevice(devices, role?.session)
    let sessionSide
    if (declaredSession !== null) {
      sessionSide = { ...describe(declaredSession), source: 'roles' }
    } else if (bucket.remoteReports.size > 0) {
      // 多台对端都报了这个工作区时，先取在线的那台；都离线就取第一台。
      const reports = [...bucket.remoteReports.values()]
      const picked = reports.find((item) => item.device.online) ?? reports[0]
      sessionSide = { ...picked.device, source: 'inventory' }
    } else if (bucket.localReport) {
      sessionSide = { deviceId: selfId, name: selfName, isSelf: true, online: true, source: 'default' }
    } else {
      sessionSide = { deviceId: '', name: '', isSelf: false, online: false, source: 'unknown' }
    }

    // 声明了会话侧但清单里没有这台设备时，名字仍然要显示出来（那台可能就是离线）。
    if (role !== null && declaredSession === null) {
      const declaredName = text(role.session, MAX_NAME)
      if (declaredName !== '') {
        sessionSide = {
          deviceId: '',
          name: declaredName,
          isSelf: declaredName.toLowerCase() === selfName.toLowerCase() || declaredName.toLowerCase() === selfId.toLowerCase(),
          online: false,
          source: 'roles',
          unresolved: true,
        }
      }
    }

    // 「这个工作区是否**作为互联会话**」由配置显式声明（`workspaceRoles[path].mesh`）。
    // 它与路由用的是同一个开关，所以「界面标了远端执行」与「命令真的发到属主」永远一致；
    // 缺省 false = 纯本地工作区：路由一律本机落地，标成「远端执行」就是错的。
    const mesh = role !== null && role.mesh === true
    const remote = mesh && sessionSide.isSelf !== true && (sessionSide.deviceId !== '' || sessionSide.name !== '')

    // 证据：只对本机（执行端）有意义。会话侧在本机时这些证据说明的是「别人往本机发
    // 命令」的反面，不需要标。
    const replicaHits = (bucket.path !== '' ? replicasByPath.get(bucket.path) ?? [] : [])
    const inboundHits = (bucket.path !== '' ? inboundByPath.get(bucket.path) ?? [] : [])
    let mirrorLastAt = null
    for (const replica of replicaHits) {
      const at = text(replica.updatedAt, 40) || text(replica.createdAt, 40)
      if (at !== '' && (mirrorLastAt === null || at > mirrorLastAt)) mirrorLastAt = at
    }
    const inbound = inboundSummary(inboundHits)
    const evidence = {
      mirrorSessions: replicaHits.length,
      mirrorLastAt,
      inboundExec: inbound.ok,
      inboundDenied: inbound.denied,
      inboundTotal: inbound.total,
      inboundLastAt: inbound.lastAt,
      inboundLastCommand: inbound.lastCommand,
      inboundDevices: inbound.devices,
    }
    const active = evidence.mirrorSessions > 0 || evidence.inboundTotal > 0

    workspaces.push({
      workspaceId: bucket.workspaceId,
      path: bucket.path,
      title: bucket.title,
      owner,
      session: sessionSide,
      mesh,
      remote,
      active,
      evidence,
      remoteDevices: [...bucket.remoteReports.values()].map((item) => ({
        deviceId: item.device.deviceId,
        deviceName: item.device.name,
        online: item.device.online,
        sessions: Array.isArray(item.workspace.sessions) ? item.workspace.sessions.length : 0,
      })),
    })

    // 有**运行时证据**的会话（稀疏）。刻意**不**把对端清单里的会话全抄一遍：
    // 那份清单本来就在 /tree 的 devices[].inventory 里，抄一遍只会让每轮轮询的
    // 响应体积翻倍（本项目单节点 1454 条会话）。
    //   · 镜像到的：只有**转发执行**的会话才会被镜像，所以这是「会话在远端」的硬证据；
    //   · 命令原文里点到名的：入站执行审计里没有 sessionId 字段，只能从命令原文里
    //     尽力捞（`tail … /sessions/<slug>/<sessionId>/session.v4.jsonl.zstd` 这类确实带 id）。
    /** @type {Set<string>} 命令原文里点到名、且落在本工作区内的会话。 */
    const inboundSessionIds = new Set()
    for (const [id, entries] of inboundBySession) {
      const hit = entries.some((entry) => {
        const entryPath = normPath(entry.cwd) || normPath(entry.path)
        return bucket.path !== '' && entryPath !== '' && isWithin(bucket.path, entryPath)
      })
      if (hit) inboundSessionIds.add(id)
    }
    const sessionIds = new Set([
      ...replicaHits.map((replica) => text(replica.sessionId, MAX_NAME)).filter((id) => id !== ''),
      ...inboundSessionIds,
    ])
    for (const sessionId of sessionIds) {
      if (!SESSION_ID_RE.test(sessionId)) continue
      const mirrored = replicasBySession.get(sessionId) ?? []
      const inboundEntries = (inboundBySession.get(sessionId) ?? []).filter((entry) => {
        const entryPath = normPath(entry.cwd) || normPath(entry.path)
        return bucket.path !== '' && entryPath !== '' && isWithin(bucket.path, entryPath)
      })
      const hasMirror = mirrored.length > 0
      const hasInbound = inboundEntries.length > 0
      if (!hasMirror && !hasInbound) continue
      const reported = bucket.remoteSessions.get(sessionId) ?? null
      // 会话侧设备的取名顺序：对端清单 > 镜像索引（源设备名）> 审计条目（发起设备名）。
      // 三条都拿不到时留空，UI 显示成「某台远端设备」而不是编一个名字。
      const device = reported?.device
        ?? describe(mirrored[0] !== undefined
          ? { deviceId: mirrored[0].deviceId, name: mirrored[0].sourceDeviceName }
          : { deviceId: inboundEntries[0]?.deviceId, name: inboundEntries[0]?.deviceName })
      const inboundOne = inboundSummary(inboundEntries)
      const entry = {
        sessionId,
        deviceId: device.deviceId,
        deviceName: device.name,
        workspaceId: bucket.workspaceId,
        workspacePath: bucket.path,
        title: reported?.title || text(mirrored[0]?.title, MAX_TITLE),
        live: reported?.live === true,
        lastActivityAt: reported?.lastActivityAt ?? null,
        mirror: hasMirror,
        mirrorEvents: mirrored.reduce((sum, item) => sum + (Number(item.events) || 0), 0),
        mirrorLastAt: mirrored.map((item) => text(item.updatedAt, 40)).filter((at) => at !== '').sort().pop() ?? null,
        inbound: inboundOne.total,
        inboundLastAt: inboundOne.lastAt,
        presentLocally: reported?.presentLocally === true,
        source: hasInbound ? 'exec' : 'mirror',
      }
      // 一条会话只保留一份：更强的证据赢（有入站执行 > 只有镜像）。
      const previous = evidenceSessions.get(sessionId)
      if (previous === undefined || (previous.inbound === 0 && entry.inbound > 0)) {
        evidenceSessions.set(sessionId, entry)
      }
    }
  }

  // 稳定排序：有运行时证据的工作区在前（UI 与自检都靠这个顺序），其次按路径。
  workspaces.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1
    if (left.remote !== right.remote) return left.remote ? -1 : 1
    return left.path.localeCompare(right.path)
  })

  const sessions = [...evidenceSessions.values()]
    .sort((left, right) => (right.inbound - left.inbound)
      || String(right.mirrorLastAt ?? '').localeCompare(String(left.mirrorLastAt ?? '')))
    .slice(0, MAX_EVIDENCE_SESSIONS)

  return {
    schema: 1,
    generatedAt: new Date(now).toISOString(),
    selfDeviceId: selfId,
    selfName,
    auditSource: typeof input.auditFile === 'string' && input.auditFile !== '' && !Array.isArray(input.auditEntries) ? 'file' : 'memory',
    workspaces,
    sessions,
    truncated: evidenceSessions.size > sessions.length,
  }
}

/**
 * 按 workspaceId 或路径查一条判定（UI 两种口径都会用到）。
 * @param {object} drivers `computeDrivers` 的结果。
 * @param {{workspaceId?: string, path?: string}} query 查询。
 * @returns {object|null} 命中的工作区判定。
 */
export function findDriver(drivers, query = {}) {
  const workspaces = Array.isArray(drivers?.workspaces) ? drivers.workspaces : []
  const workspaceId = text(query.workspaceId, MAX_NAME)
  const path = normPath(query.path)
  if (workspaceId !== '') {
    const hit = workspaces.find((item) => item.workspaceId === workspaceId)
    if (hit !== undefined) return hit
  }
  if (path !== '') {
    const hit = workspaces.find((item) => item.path === path || isWithin(item.path, path))
    if (hit !== undefined) return hit
  }
  return null
}
