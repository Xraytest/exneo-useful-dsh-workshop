/**
 * dsh-device-mesh — 本机清单采集（把 DSH 的出厂服务折成「设备 → 工作区 → 会话」）。
 *
 * 这里是整条链路唯一读 DSH 业务服务的地方。所有服务都用 `ctx.get()` **惰性**读取：
 * 缺失任何一个都不让插件挂掉，而是把那一格标进 `degraded`，让对端和 UI 都看得见
 * 「这台设备这一项读不到」，而不是把它渲染成「这台设备没有会话」。
 *
 * ── 三级结构的权威来源 ──────────────────────────────────────────────────────
 *   设备        = 本函数所在进程（identity.json 里的稳定 deviceId）
 *   工作区      = `workspaceRegistry.list()`：path / title / **header 校验过的** sessionIds
 *   会话        = `sessionQuery.listSessions()` 的完整逻辑语料（live + 持久化合并）
 *
 * 工作区归属判定（与出厂语义逐条对齐）：
 *   1. 会话 id 出现在某工作区的 `sessionIds` 里 → 归该工作区。
 *      出厂已经用「会话头规范 cwd == 工作区路径」过滤过这份账目，所以这是**权威**归属。
 *   2. 否则按 `header.cwd` 精确等于某工作区 path → 归该工作区（`inferred: true`）。
 *   3. 否则按 cwd 落在某工作区路径**之下**（最长前缀）→ 归该工作区（`inferred: true`）。
 *   4. 都不命中 → 进 `unassigned`，保留 cwd 原样交给 UI 兜底分组
 *      （临时目录、已删除目录、子代理会话常落这里）。
 *
 * 步骤 3 是本插件加的：出厂只认精确相等，于是「在 workspace 子目录里开的会话」
 * 在侧边栏是散着的。跨设备总览里散着没法看，所以这里按最长前缀收进父工作区并
 * 如实标注 `inferred`，UI 可以据此画成弱化行。**权威归属永不被覆盖**（步骤 1 优先）。
 *
 * 标题读取（成本从低到高，逐级降级）：
 *   1. `sessionProjectionCache.cachedSnapshot(header, 0)` —— 纯内存零 I/O，
 *      DSH 自己的会话列表对冷会话走的就是这条（实测 30 条 3.5 ms）。
 *   2. `sessionQuery.readTitleSnapshots(ids)` —— 要整份解码会话日志，很贵
 *      （本部署 30 条归档会话实测 3.6–4.7 s）。所以**只对缓存未命中的、且数量
 *      不超过 `titleFoldBudget` 的**才走，并受 `titleFoldBudgetMs` 时间预算约束。
 *   3. 都拿不到 → `title: null`，UI 显示「(无标题)」而不是拿 id 冒充标题。
 *
 * @module dsh-device-mesh/inventory
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { PROTOCOL_VERSION, MESH_VERSION } from './protocol.js?v=mesh-31'
import { PERMISSION_MODES } from './exec.js?v=mesh-31'

/** 清单结构版本：对端据此判断要不要拒绝这份快照。 */
export const INVENTORY_SCHEMA = 1

/** 进程内建模式 require：只用来读包元数据，不拉起任何包体。 */
const requireFromHere = createRequire(import.meta.url)

/**
 * 尽力读取 DSH 版本号。三条路都失败就回空串 —— 版本只是展示字段，
 * 不值得为它引入一个可能抛错的强依赖，也绝不让它把清单采集整个打挂。
 * @returns {string} 版本号或空串。
 */
function dshVersion() {
  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  for (const specifier of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json']) {
    try {
      const version = requireFromHere(specifier)?.version
      if (typeof version === 'string' && version !== '') return version
    } catch {
      // 下一个候选。
    }
  }
  return ''
}

/**
 * 平台的人可读标签（UI 直接用，不在浏览器侧重算一遍）。
 * @param {string} platform `process.platform`。
 * @returns {string} 标签。
 */
function platformLabel(platform) {
  const table = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
    freebsd: 'FreeBSD',
    openbsd: 'OpenBSD',
    sunos: 'SunOS',
    aix: 'AIX',
  }
  return table[platform] ?? platform ?? '未知系统'
}

/**
 * 平台图标类别：客户端只按这个值选 SVG，不再自己嗅探字符串。
 * @param {string} platform `process.platform`。
 * @returns {'desktop' | 'server' | 'unknown'} 类别。
 */
function platformIcon(platform) {
  if (platform === 'win32' || platform === 'darwin') return 'desktop'
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'server'
  return 'unknown'
}

/**
 * 本机设备描述。这个对象会被推给对端、也会出现在 UI 上，所以字段都取「人可读 + 机可判」两用。
 * @param {{identity: {deviceId: string, name: string, createdAt: string}, config: object, startedAt: string}} input 材料。
 * @returns {object} 设备描述。
 */
export function describeDevice(input) {
  const platform = process.platform
  return {
    deviceId: input.identity.deviceId,
    name: input.identity.name,
    deviceCreatedAt: input.identity.createdAt,
    platform,
    os: platformLabel(platform),
    arch: process.arch,
    hostname: os.hostname(),
    icon: platformIcon(platform),
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    cpuCount: os.cpus().length,
    dshVersion: dshVersion(),
    meshVersion: MESH_VERSION,
    protocol: PROTOCOL_VERSION,
    startedAt: input.startedAt,
    // 能力位让对端知道「这台设备能干什么」，而不是靠版本号猜。
    capabilities: capabilities(input.config),
  }
}

/**
 * 本机对外声明支持的能力。
 * @param {object} config 归一化配置。
 * @returns {string[]} 能力名列表。
 */
function capabilities(config) {
  const list = ['inventory']
  if (config.allowInbound) list.push('accept-nodes')
  if (config.requireToken) list.push('token-auth')
  // 跨设备执行的能力位：对端据此决定要不要在 UI 上放开执行入口。
  // 关掉它时对端连「试一下」都不该做 —— 那只会换来一个 403。
  if (config.allowRemoteExec) {
    list.push('remote-exec')
    // 「能停」不等于「能跑」：单独一个能力位，对端据此决定本机中止时值不值得
    // 发那条 cancel 请求。缺了它，对端只会在每次中止时白换一个 404。
    list.push('remote-exec-cancel')
  }
  return list
}

/**
 * 安全地读一个可选服务。
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @param {string} name 服务名。
 * @returns {object | undefined} 服务实例。
 */
function optionalService(ctx, name) {
  try {
    const service = ctx.get(name)
    return service === undefined || service === null ? undefined : service
  } catch {
    return undefined
  }
}

/**
 * 从投影缓存零 I/O 取一批标题。
 * @param {object|undefined} cache `sessionProjectionCache` 服务。
 * @param {Map<string, object>} headers id → SessionHeader。
 * @returns {{titles: Map<string, {title: string, lastPromptAt: number|null}>, usable: boolean}} 命中结果与能力位。
 */
function cachedTitles(cache, headers) {
  const titles = new Map()
  const usable = cache !== undefined && typeof cache.cachedSnapshot === 'function'
  if (!usable) return { titles, usable }
  for (const [id, header] of headers) {
    try {
      let block = cache.cachedSnapshot(header, 0)
      if (block === undefined && typeof cache.cachedPredecessorTitle === 'function') {
        block = cache.cachedPredecessorTitle(header, 0)
      }
      const values = block !== null && typeof block === 'object' ? block.values : undefined
      if (values === null || typeof values !== 'object') continue
      const title = values.title
      if (typeof title !== 'string' || title === '') continue
      const metadata = values.sessionListMetadata
      const lastPromptAt = metadata !== null && typeof metadata === 'object' && typeof metadata.lastPromptAt === 'number'
        ? metadata.lastPromptAt
        : null
      titles.set(id, { title, lastPromptAt })
    } catch {
      // 单条读失败不该拖垮整次采集：这条退到日志折叠或空标题。
    }
  }
  return { titles, usable }
}

/**
 * 采集每条会话的**权限**（sessionId → 三种模式之一）。
 *
 * 为什么权限要进清单：用户要求「两边权限一致统一，哪边改都同步到两边的显示」。清单本来
 * 就在两台之间互通，所以把权限挂上去 = 两边面板天然都能看到**对面**会话的权限，不需要
 * 新状态、也不需要新的同步循环。
 *
 * 唯一来源是**已加载会话**的出厂策略解析器（与会话端转发请求时用的是**同一个**函数）。
 * 这不是「猜」：它就是执行时实际依据的那个值，所以界面显示与真实执行不可能不一致。
 *
 * 为什么不去读投影缓存（`sessionProjectionCache`）—— 2026-10-18 在节点上核过，这条路
 * **通不了**，两个独立的理由：
 *   1. `sandboxMode` 注册时**没有 `wire`**，而 `sessionProjections.viewCheckpoint()` 对
 *      `def.wire === undefined` 的单元直接 `continue` —— 缓存快照里永远不会有这个键；
 *   2. 就算有，`cachedSnapshot(header, 0)` 这个调用本身会抛：第二个参数是**键数组**，
 *      `new Set(0)` → `TypeError: number 0 is not iterable`。
 * 所以「静置（未加载）的会话」读不到权限，**就不填**（UI 不画）——显示一个猜出来的权限
 * 比不显示更糟。这也与权威口径一致：权限的权威是**正在跑的那条会话**。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @returns {Map<string, string>} 有明确取值的那些会话。
 */
function sessionModes(ctx) {
  const modes = new Map()
  const agents = optionalService(ctx, 'agents')
  const policy = optionalService(ctx, 'sandboxPolicy')
  if (agents === undefined || typeof agents.list !== 'function' || typeof policy?.resolve !== 'function') return modes
  try {
    for (const agent of agents.list() ?? []) {
      const session = agent?.session
      const id = typeof session?.id === 'string' ? session.id : ''
      if (id === '') continue
      const mode = policy.resolve({ session })?.mode
      if (PERMISSION_MODES.includes(mode)) modes.set(id, mode)
    }
  } catch {
    // 拿不到就当没读到：权限显示缺一格，好过显示错的。
  }
  return modes
}

/**
 * 采集本机清单。
 *
 * 全程只读，且接受 `signal`：调用方（egress 循环 / `/tree`）取消时立刻停下。
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @param {{device: object, config: object, revision: number, signal?: AbortSignal, now?: number}} input 材料。
 * @returns {Promise<object>} 清单快照。
 */
/** 空会话壳的日志上限：只有头部事件的日志是几百字节，8 KB 已是很宽的上界。 */
const BLANK_LOG_MAX_BYTES = 8192

/**
 * 会话目录 slug，与出厂编码规则一致：`/root/a/b` → `--root-a-b--`。
 * @param {string} cwd 会话的工作目录。
 * @returns {string|null} slug。
 */
function sessionDirName(cwd) {
  if (typeof cwd !== 'string') return null
  const trimmed = cwd.trim()
  if (trimmed === '' || !trimmed.startsWith('/')) return null
  return `--${trimmed.replace(/^\/+/u, '').replace(/[\\/]+/gu, '-')}--`
}

/** 会话日志根目录（`$DSH_HOME/sessions`）。 */
function sessionsRootPath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/**
 * 这条会话是不是「空壳」：建了就从没用过。
 *
 * 为什么必须把它认出来：出厂客户端在「打开工作区但找不到可复用的 blank」时会
 * `sessions.create({ workspaceId })` 建一条只有头部事件的会话（侧边栏显示成
 * 「New Session」）。这种壳从建立起就再没被写过 —— 而会话镜像只镜像「还会动的
 * 会话」—— 于是它**永远**只存在于出生的那台，对端总把它看成「我缺的一条会话」，
 * 点亮一行 extras，让同一个工作区在侧边栏出现两遍。
 *
 * 判据刻意保守：任一条不确定就返回 false（宁可多显示，不可误藏）。
 * 最有力的一条是「日志文件极小」——真正用过的会话，日志至少几十 KB。
 *
 * @param {object} header 会话头。
 * @param {object|undefined} cached 投影缓存里命中的标题（命中即说明有标题事件）。
 * @param {object} record `listSessions()` 的记录。
 * @param {string} sessionsRoot 会话日志根目录。
 * @returns {boolean} 是否空壳。
 */
function isBlankShell(header, cached, record, sessionsRoot) {
  if (record !== null && typeof record === 'object' && record.live === true) return false
  // cachedTitles 只收「非空标题」，所以命中即代表这条会话有标题事件。
  if (cached !== undefined) return false
  if (typeof header.origin === 'string' && header.origin !== '') return false
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return false
  if (Number.isSafeInteger(header.depth) && header.depth !== 0) return false
  const dir = sessionDirName(typeof header.cwd === 'string' ? header.cwd : '')
  if (dir === null) return false
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    try {
      const st = fs.statSync(path.join(sessionsRoot, dir, String(header.id ?? ''), name))
      if (st.isFile()) return st.size < BLANK_LOG_MAX_BYTES
    } catch {
      // 这个代次没有日志文件：试下一个
    }
  }
  return false
}

export async function collectInventory(ctx, input) {
  const now = input.now ?? Date.now()
  const config = input.config
  const workspaceRegistry = optionalService(ctx, 'workspaceRegistry')
  const sessionQuery = optionalService(ctx, 'sessionQuery')
  const projectionCache = optionalService(ctx, 'sessionProjectionCache')
  const sessionsRoot = sessionsRootPath()

  /** @type {object[]} */
  let workspaceList = []
  /** @type {Set<string>} */
  let archived = new Set()
  let workspaceError = null
  if (workspaceRegistry !== undefined && typeof workspaceRegistry.list === 'function') {
    try {
      workspaceList = workspaceRegistry.list() ?? []
      const ids = workspaceRegistry.archivedSessionIds
      if (Array.isArray(ids)) archived = new Set(ids)
    } catch (error) {
      workspaceError = error?.message ?? String(error)
    }
  } else {
    workspaceError = 'workspaceRegistry 服务不可用'
  }

  /** @type {object[]} */
  let records = []
  let sessionError = null
  if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
    try {
      records = (await sessionQuery.listSessions(input.signal)) ?? []
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      sessionError = error?.message ?? String(error)
    }
  } else {
    sessionError = 'sessionQuery 服务不可用'
  }

  // ── 标题：先零 I/O 快路径，再按预算补日志折叠 ──────────────────────────────
  const headers = new Map()
  for (const record of records) {
    const header = record?.header
    if (header !== null && typeof header === 'object' && typeof header.id === 'string') headers.set(header.id, header)
  }
  const { titles, usable: projectionCacheUsable } = cachedTitles(projectionCache, headers)
  // 权限：只对有明确取值的**已加载**会话填（静置会话读不到 —— 投影缓存不暴露
  // `sandboxMode`，见 sessionModes() 的说明）。
  const modes = sessionModes(ctx)

  let titleFolded = 0
  let titleNoEvent = 0
  let titleFoldError = null
  const missing = [...headers.keys()].filter((id) => !titles.has(id))
  const foldBudget = Math.max(0, config.titleFoldBudget)
  // 被预算挡下的条数要单独记：把「没试」和「试了但日志里真的没有标题事件」
  // 都算成 missing，会让人误以为折叠路径坏了 —— 而它其实可能一条不漏地跑完了。
  let titleNotAttempted = Math.max(0, missing.length - foldBudget)
  if (
    missing.length > 0 && foldBudget > 0
    && sessionQuery !== undefined && typeof sessionQuery.readTitleSnapshots === 'function'
  ) {
    const batch = missing.slice(0, foldBudget)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(200, config.titleFoldBudgetMs))
    const onAbort = () => controller.abort()
    input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const observations = await sessionQuery.readTitleSnapshots(batch, controller.signal)
      // 出厂形状是**三层**的：`{ sessionId, status, value: { session, title } }`，
      // 其中 `value.title` 才是 SessionTitleSnapshot（自己带 `.title` / `.updatedAt`）。
      // 少拆一层不会报错，只会静默地一条标题都拿不到 —— 那种「看起来在工作、
      // 其实全 miss」的错最难发现，所以这里逐层判类型，并且只认 status='fulfilled'。
      for (const result of observations ?? []) {
        if (result === null || typeof result !== 'object') continue
        if (result.status !== 'fulfilled') continue
        const id = result.sessionId
        if (typeof id !== 'string' || id === '') continue
        const value = result.value
        const snapshot = value !== null && typeof value === 'object' ? value.title : undefined
        // fulfilled 但没有 title = 这个会话的日志里确实没有 session/title 事件
        // （子代理会话常见）。这与「读失败」是两件事，分开计数。
        if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
          titleNoEvent += 1
          continue
        }
        if (typeof snapshot.title !== 'string' || snapshot.title === '') {
          titleNoEvent += 1
          continue
        }
        titles.set(id, {
          title: snapshot.title,
          lastPromptAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
        })
        titleFolded += 1
      }
    } catch (error) {
      if (error?.name !== 'AbortError') titleFoldError = error?.message ?? String(error)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  // ── 归属判定 ──────────────────────────────────────────────────────────────
  /** id → {workspaceId, inferred} */
  const ownership = new Map()
  const pathIndex = []
  for (const workspace of workspaceList) {
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
    if (workspaceId === '') continue
    for (const sessionId of workspace.sessionIds ?? []) ownership.set(sessionId, { workspaceId, inferred: false })
    if (typeof workspace.path === 'string' && workspace.path !== '') {
      pathIndex.push({ workspaceId, path: workspace.path, title: workspace.title })
    }
  }
  // 最长路径优先，保证「子目录会话收进最近的父工作区」。
  pathIndex.sort((a, b) => b.path.length - a.path.length)

  /** @type {Map<string, object[]>} */
  const byWorkspace = new Map()
  for (const workspace of workspaceList) {
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
    if (workspaceId !== '') byWorkspace.set(workspaceId, [])
  }
  /** @type {object[]} */
  const unassigned = []

  let archivedCount = 0
  let subagentCount = 0
  let liveCount = 0

  for (const record of records) {
    const header = record?.header
    if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
    const id = header.id
    const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    const isArchived = archived.has(id)
    const isSubagent = header.origin === 'subagent'
    if (isArchived) archivedCount += 1
    if (isSubagent) subagentCount += 1
    if (record.live === true) liveCount += 1
    if (isArchived && !config.includeArchived) continue
    if (isSubagent && !config.includeSubagents) continue
    const blank = isBlankShell(header, titles.get(id), record, sessionsRoot)

    const cached = titles.get(id)
    const entry = {
      id,
      title: cached?.title ?? null,
      cwd,
      createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
      lastActivityAt: cached?.lastPromptAt ?? (Number.isFinite(header.createdAt) ? header.createdAt : null),
      live: record.live === true,
      persisted: record.persisted === true,
      seeded: header.isSeeded === true,
      origin: typeof header.origin === 'string' ? header.origin : null,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
      depth: Number.isSafeInteger(header.depth) ? header.depth : 0,
      agentPresetId: typeof header.agentPresetId === 'string' ? header.agentPresetId : null,
      archived: isArchived,
      blank,
    }
    // 权限只在**读得到**时出现：缺字段 = 这台/这一版读不到，UI 就不画（老 host 兼容）。
    const mode = modes.get(id)
    if (mode !== undefined) entry.mode = mode

    let target = ownership.get(id)
    if (target === undefined && cwd !== null) {
      const exact = pathIndex.find((candidate) => candidate.path === cwd)
      if (exact !== undefined) {
        target = { workspaceId: exact.workspaceId, inferred: true }
      } else {
        const under = pathIndex.find((candidate) => cwd.startsWith(candidate.path.endsWith(path.sep) ? candidate.path : `${candidate.path}${path.sep}`))
        if (under !== undefined) target = { workspaceId: under.workspaceId, inferred: true }
      }
    }

    if (target !== undefined && byWorkspace.has(target.workspaceId)) {
      byWorkspace.get(target.workspaceId).push({ ...entry, inferred: target.inferred })
    } else {
      unassigned.push({ ...entry, inferred: false })
    }
  }

  // ── 排序 + 截断 ───────────────────────────────────────────────────────────
  const recency = (a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0)
  const limit = Math.max(1, config.maxSessionsPerWorkspace)
  let truncated = false
  const shape = (list) => {
    const sorted = [...list].sort(recency)
    if (sorted.length <= limit) return { sessions: sorted, dropped: 0 }
    truncated = true
    return { sessions: sorted.slice(0, limit), dropped: sorted.length - limit }
  }

  const workspaces = []
  for (const workspace of workspaceList) {
    const workspaceId = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
    if (workspaceId === '') continue
    const bucket = byWorkspace.get(workspaceId) ?? []
    const { sessions, dropped } = shape(bucket)
    workspaces.push({
      id: workspaceId,
      title: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : String(workspace.path ?? workspaceId),
      path: typeof workspace.path === 'string' ? workspace.path : '',
      createdAt: typeof workspace.createdAt === 'string' ? workspace.createdAt : null,
      updatedAt: typeof workspace.updatedAt === 'string' ? workspace.updatedAt : null,
      sessionCount: bucket.length,
      droppedSessions: dropped,
      liveCount: bucket.filter((entry) => entry.live).length,
      sessions,
    })
  }
  // 有会话的工作区排前面，其余按标题稳定排列 —— 跨设备总览里「空工作区」不该占视线。
  workspaces.sort((a, b) => {
    if (a.sessionCount !== b.sessionCount) return b.sessionCount - a.sessionCount
    return a.title.localeCompare(b.title)
  })

  const { sessions: unassignedSessions, dropped: unassignedDropped } = shape(unassigned)

  return {
    schema: INVENTORY_SCHEMA,
    revision: input.revision,
    generatedAt: new Date(now).toISOString(),
    device: input.device,
    workspaces,
    unassigned: unassignedSessions,
    unassignedDropped,
    totals: {
      workspaces: workspaces.length,
      sessions: workspaces.reduce((sum, workspace) => sum + workspace.sessionCount, 0) + unassigned.length,
      listed: workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0) + unassignedSessions.length,
      live: liveCount,
      subagents: subagentCount,
      archived: archivedCount,
    },
    truncated,
    degraded: {
      workspaceRegistry: workspaceError,
      sessionQuery: sessionError,
      projectionCache: projectionCacheUsable ? null : 'sessionProjectionCache 不可用，标题全部依赖日志折叠',
      titleFold: titleFoldError,
      titleSources: {
        // cache        = 投影缓存命中（零 I/O 快路径）
        // logFold      = 走了日志折叠并拿到标题
        // noTitleEvent = 折叠成功、但日志里确实没有标题事件
        // notAttempted = 被 titleFoldBudget 挡下，本次没试
        // missing      = 到本次采集结束仍然没有标题的总数（= noTitleEvent + notAttempted）
        cache: titles.size - titleFolded,
        logFold: titleFolded,
        noTitleEvent: titleNoEvent,
        notAttempted: titleNotAttempted,
        missing: Math.max(0, headers.size - titles.size),
      },
    },
  }
}
