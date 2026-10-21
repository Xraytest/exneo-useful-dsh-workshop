/**
 * 本文件由 `node bump-version.mjs` 生成（v29 → v30），与 v29 逐字相同，
 * 只是把整张 import 图的 loader 缓存标记从 mesh-28 换成了 mesh-29。
 *
 * 为什么需要它：loader 按 specifier 缓存模块，改完 lib 之后必须让**整个图**按新 URL
 * 重新求值，而入口文件的路径本身也是缓存键的一部分 —— 所以「换版本」= 新入口文件名
 * + 全图统一的新标记。细节与踩过的坑见 bump-version.mjs 头部注释。
 *
 * @module dsh-device-mesh/entry-v30
 */

/**
 * 本文件由 `node gen-v11.mjs` 从 entry-v10.js 生成：v10 的全部能力 + 「按路径路由」。
 *
 * ── 相对 v10 的差异（只有这几处）────────────────────────────────────────────
 *   · 新增配置项 `routeExecByPath`（默认 true，配置页可改、可运行时切换）；
 *   · `mountShellRouting()`：接管 `ctx.shell`，按工作目录把命令发到子节点；
 *   · `mountFsRouting()`  ：接管 `ctx.fs`，按路径把文件访问发到子节点；
 *   · `mountFsInbound()`  ：让别的节点能读写本机导出的目录（6 条 fs 原语路由，
 *     门与 /api/exec 同源：join 过 → 授权 → 导出根）。
 *
 * 为此组合里把出厂的 `bash-sandbox` 与 `fs-sandbox` 两行 disable 掉了——同一个
 * context 只能有一个 `ctx.shell` / `ctx.fs`，重复注册会抛。
 * 其余实现与 v10 逐字相同（仅 loader 缓存标记从 mesh-10 换成 mesh-11）。
 *
 * 为什么必须换文件名 + 全图换标记：loader 按 specifier 缓存模块，而入口文件路径本身
 * 就是缓存键的一部分——只改内容不换 URL，运行中的实例会继续跑旧代码。
 * 细节与踩过的坑见 bump-version.mjs 头部注释。
 *
 * @module dsh-device-mesh/entry-v11
 */

/**
 * 设备网格（dsh-device-mesh）— host 半边实现 v1。
 *
 * ── 这个插件解决什么 ────────────────────────────────────────────────────────
 * 装了本插件的每一台 DSH 都是一个**节点**。节点可以同时扮演两种角色：
 *
 *   接入点（inbound）  开放 `/dsh-device-mesh/api/*`，让**别的**节点带着令牌接入，
 *                      接收它们上报的「工作区 + 会话」清单。
 *   接入方（outbound） 主动向别的接入点 join，把自己的清单推过去。
 *
 * 两个角色都开着，就是一张对等网格：A 接 B、B 接 C 之后，A 的界面上能看见 C
 * （通过 B 的镜像，见下「三级结构」）。「理论上通过认证可以随便接」——
 * 认证靠 令牌 + 每请求 HMAC 签名 + 时间窗 + nonce 防重放（见 protocol.js）。
 *
 * ── 三级结构：设备 → 工作区 → 会话 ──────────────────────────────────────────
 * 浏览器侧的 `GET /tree` 汇总三类来源，每条设备都带 `via` 说明「怎么连上的」：
 *
 *   via.kind = 'self'      本机（inventory 由 inventory.js 现采，权威）
 *   via.kind = 'inbound'   接入本机的节点（inventory 由它上报，存 nodes.json）
 *   via.kind = 'outbound'  本机 join 的接入点所见到的设备（镜像，见下）
 *
 * 镜像（mirror）：本机向接入点 join 成功后，会顺带拉一次**对方的一跳总览**
 * （`POST /api/tree`），把对方自己 + 对方接入的节点一起拿回来。所以
 * 「A 接 B、B 接 C」时，A 不用直接认识 C 也能看见 C 的会话。
 *
 * **一跳是硬边界**：接入点的 `/api/tree` 只返回「自己 + 自己接入的节点」，
 * 不返回它从别处镜像来的设备。这条规则同时挡住两种情况——网格成环时的无限递归，
 * 以及设备数按跳数指数膨胀。响应里的 `scope: 'direct'` 就是这个承诺的名字。
 *
 * ── 路由表 ──────────────────────────────────────────────────────────────────
 * 入站 API（远端节点 → 本机；`Origin` 缺席，**只认签名**，不走同源守卫）：
 *   GET  /dsh-device-mesh/api/hello      能力探测（无需认证）
 *   POST /dsh-device-mesh/api/join       接入（幂等）
 *   POST /dsh-device-mesh/api/report     上报全量清单
 *   POST /dsh-device-mesh/api/heartbeat  报活
 *   POST /dsh-device-mesh/api/leave      主动退出
 *   POST /dsh-device-mesh/api/tree       取本接入点的一跳总览（供对端做镜像）
 *
 * 浏览器侧（本机页面 → 本机；同源守卫 + 全部只读或人机写操作）：
 *   GET  /dsh-device-mesh/tree          三级总览（本插件的主界面数据源）
 *   GET  /dsh-device-mesh/status        只读自检
 *   GET  /dsh-device-mesh/config        当前配置 + 设备身份
 *   POST /dsh-device-mesh/config        改设备名 / 开关
 *   GET  /dsh-device-mesh/links         出站接入点清单（secret 已脱敏）
 *   POST /dsh-device-mesh/links         增删改接入点 / 启停
 *   POST /dsh-device-mesh/links/test    探测一个接入点（hello + 可选 join）
 *   POST /dsh-device-mesh/links/sync    立刻推一轮
 *   GET  /dsh-device-mesh/tokens        入站令牌清单（secret 已脱敏）
 *   POST /dsh-device-mesh/tokens        建/撤/删令牌
 *   GET  /dsh-device-mesh/nodes         已接入节点清单
 *   POST /dsh-device-mesh/nodes         改名 / 备注 / 拉黑 / 移除
 *
 * ── 安全边界（读代码时请连同这几条一起看）────────────────────────────────────
 *   · 入站 API **不**用同源守卫：调用方是远端进程，本来就没有 Origin。它的门是
 *     签名 + 令牌 + 时间窗 + nonce + 每次失败按来源计数限流（`authFailMax`）。
 *     没有有效签名时连「这台设备叫什么」都拿不到（hello 给的是公开描述，
 *     不含 hostname / 内存 / CPU）。
 *   · 浏览器侧路由**不**接受签名：它们只能同源访问，且不提供任何「代替远端节点
 *     说话」的能力——两条通道的能力集刻意不重叠。
 *   · 已保存的 secret 永远不回浏览器（`registry.js` 的 list() 全部脱敏），
 *     创建令牌的那一次响应是唯一一次明文。
 *   · 关掉 `allowInbound` 后，入站 API 全部返回 inbound-disabled（含 hello），
 *     本机彻底回到「只出不进」。
 *
 * ── 维护须知（本 profile 的 loader 约定）────────────────────────────────────
 * loader 按 specifier 缓存模块，**不认 `?query` 里的语义**——`?v=` 只是缓存键。
 * 改本文件之外的任何 lib 实现后，要让运行实例生效，需二选一：
 *   · 新写 `entry-v<N+1>.js` 并把 `cordis.patch.yml` 里该行的 name 指过去
 *     （**保持同一行 id**，loader 走 dispose→start），或
 *   · 跑 `node bump-version.mjs`（它把整张 import 图的 `?v=mesh-26N` 标记一起换掉，
 *     并生成新的入口文件），再把 patch 行的 name 指到新入口。
 *     **必须整张图一起换**：只换入口那一层会让 lib 内部仍指向旧实例，
 *     表现是「版本号变了、行为没变」—— 本项目实际踩过这个坑。
 * 只改 config 是安全的（同 id 走 dispose→start）。client.js 由 dsh-client-hmr
 * 每 500 ms stat-poll 就地热换，改完刷新页面即见。
 *
 * 自测：`node selftest.mjs`（纯 node、无副作用、不碰真实 DSH_HOME）。
 *
 * @module dsh-device-mesh
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

import {
  API,
  CODE,
  MESH_VERSION,
  PROTOCOL_VERSION,
  ReplayGuard,
  UI,
  randomHex,
  buildSignatureHeaders,
  verifyRequestSignature,
} from './protocol.js?v=mesh-26'
import { ensureDir, loadIdentity, resolveMeshDir, writeJsonAtomic } from './store.js?v=mesh-26'
import { LinkTable, NodeRegistry, TokenTable, normalizeHubUrl } from './registry.js?v=mesh-26'
import { PathTable } from './paths.js?v=mesh-26'
import { AuditLog, ExecError, Executor } from './exec.js?v=mesh-26'
import { Caller } from './caller.js?v=mesh-26'
import { describeDevice } from './inventory.js?v=mesh-26'
import { createInventoryCache } from './inventory-cache.js?v=mesh-26'
import { requestJson } from './http.js?v=mesh-26'
import { Egress } from './egress.js?v=mesh-26'
import { mountShellRouting } from './shell-bridge.js?v=mesh-26'
import { mountFsRouting } from './fs-bridge.js?v=mesh-26'
import { mountFsInbound } from './fs-inbound.js?v=mesh-26'
import {
  collectDeviceNames,
  collectPathOwners,
  collectWorkspacePolicy,
  explainRoute,
  ownersForPath,
  resolveOwnerToken,
  routePath,
  routePathWithPolicy,
} from './routing.js?v=mesh-26'
import { SessionMirrorSender, SessionReplicaStore, buildSessionLogBytes } from './session-mirror.js?v=mesh-26'
import { computeDrivers } from './drivers.js?v=mesh-26'

/**
 * loader 的模块缓存标记：改 lib/*.js 后递增它（见文件头「维护须知」）。
 *
 * v2（本文件）：把整张 import 图的标记从 `mesh-1` 换成 `mesh-4`。
 * 原因是 loader 按 **specifier** 缓存模块 —— 同一个 `entry-v1.js` 路径只会求值一次，
 * 所以改了 `inventory.js`（修正 `readTitleSnapshots` 的三层返回值形状）之后，光编辑
 * 文件不会让运行实例重新读它；新开一个入口文件（并把 patch 行的 name 指过来）
 * 才会让**整张图**按新 URL 重新求值。这是本 profile 的既有约定，不是特例。
 */
const IMPORT_TAG = 'mesh-26'

/** 本实现的版本号：`/status` 回读它来判断「跑的是哪一版」。 */
export const VERSION = 1

export const name = 'dsh-device-mesh'

/** `webServer` 承载全部 HTTP 路由。 */
export const inject = ['webServer']

/** 路径常量（从 protocol.js 取，避免两侧字符串漂移）。 */
export { API, PROTOCOL_VERSION, MESH_VERSION }

const DEFAULTS = {
  enabled: true,
  /** 设备显示名；空 = identity.json 里存的名字，首次生成时用 os.hostname()。 */
  deviceName: '',
  /** 是否接受其它节点接入本机。关掉 = 入站 API 全部拒绝（含 hello）。 */
  allowInbound: true,
  /** 入站是否必须带令牌。false = 任何人可接入（只适合完全可信的内网，UI 会红字警告）。 */
  requireToken: true,
  /**
   * 按路径路由：把「落在某个子节点已登记工作路径上」的命令与文件访问发到那台执行。
   *
   * 一个开关同时管命令（ctx.shell）与文件（ctx.fs）。刻意不拆成两个：模型的世界观
   * 必须自洽——命令在子节点上 ls、read 却去读主机的同名路径，是比「都不下沉」更糟
   * 的状态。真要单独停掉一半，请直接改组合，而不是在这里给一个会产生矛盾态的开关。
   *
   * 只有确实登记了**远端**工作路径时才会有请求被路由出去，所以默认开着是惰性的；
   * 没挂远端路径的部署行为逐字节不变。
   */
  routeExecByPath: true,
  /** 清单快照 TTL（毫秒）：多个消费方共享同一份，避免每个请求各采一次。 */
  inventoryTtlMs: 5000,
  /** 向接入点推全量的间隔（毫秒）；清单没变时中间只发心跳。 */
  pushIntervalMs: 30000,
  /** 心跳间隔（毫秒）。 */
  heartbeatMs: 20000,
  /** 从接入点拉一跳总览（镜像）的间隔（毫秒）。 */
  mirrorIntervalMs: 60000,
  /** 单次出站请求超时（毫秒）。 */
  requestTimeoutMs: 15000,
  /** 出站响应体上限（字节）。 */
  maxResponseBytes: 4 * 1024 * 1024,
  /** 入站请求体上限（字节）。清单可能很大，给足。 */
  maxBodyBytes: 16 * 1024 * 1024,
  /** 签名时间戳允许的偏差（毫秒）。 */
  requestSkewMs: 300000,
  /** 节点多久没心跳算「迟缓」（毫秒）。 */
  nodeStaleMs: 90000,
  /** 节点多久没心跳算「离线」（毫秒）。 */
  nodeOfflineMs: 600000,
  /** 单个工作区最多列出多少条会话（超出截断并在 UI 说明）。 */
  maxSessionsPerWorkspace: 500,
  /** 最多接入多少台设备。 */
  maxDevices: 64,
  /** 标题日志折叠的单次批量上限（0 = 完全不做，只吃投影缓存）。 */
  titleFoldBudget: 40,
  /** 标题日志折叠的时间预算（毫秒）。 */
  titleFoldBudgetMs: 2500,
  /** 清单里是否包含子代理会话。 */
  includeSubagents: true,
  /** 清单里是否包含已归档会话。 */
  includeArchived: false,
  sessionAuthority: '',
  workspaceRoles: {},
  stateSyncIntervalMs: 30000,
  /** 认证失败限流：窗口内同一来源允许多少次失败。 */
  authFailMax: 40,
  /** 认证失败限流的窗口（毫秒）。 */
  authFailWindowMs: 60000,
  /** nonce 防重放缓存容量。 */
  replayCacheMax: 8192,
  /** 热重挂时路由被旧实例占用的重试次数与间隔（见 registerRoute 注释）。 */
  registerRetries: 40,
  registerRetryMs: 120,
  /** mesh 数据目录；空 = `$DSH_HOME/device-mesh`。 */
  storeDir: '',
  /** 允许把接入点配成明文 http://（内网常用；关掉则只允许 https）。 */
  allowInsecureHttp: true,

  // ── 跨设备执行（权限最高的一组配置，缺省一律失败关闭）─────────────────────
  /** 是否允许远端节点在本机的导出根内执行命令。缺省 false —— 必须显式打开。 */
  allowRemoteExec: false,
  /**
   * 谁可以执行：`grant-required`（缺省，节点 trust 必须是 `exec`）
   * 或 `any-authenticated`（任何认证通过的节点都行 —— "通过认证可以随便接" 那一档）。
   * 令牌只回答「你是谁」，**不**自动等于「你可以在这台机器上跑命令」。
   */
  execTrust: 'grant-required',
  /** 额外导出的绝对路径（跨设备执行可落在这之下）。空 + exportWorkspacePaths=false = 谁都不能执行。 */
  exportRoots: [],
  /** 是否自动把本机工作区路径加进导出根 —— 让「本机工作区」开箱即可被授权对端使用。 */
  exportWorkspacePaths: true,
  /** 单条命令允许的最大执行时长（毫秒）；调用方只能要更短，不能要更长。 */
  execTimeoutMs: 120000,
  /** stdout / stderr 各自的字节上限（超出截断并标注）。 */
  execOutputLimitBytes: 262144,
  /** 同时在跑的执行数上限。 */
  execMaxConcurrent: 4,
  /** 单条命令正文的字符上限（发起侧与受理侧都按它校验）。 */
  execCommandLimit: 32768,
  /** 审计里保存的命令正文截断长度。 */
  execAuditCommandLimit: 2000,
  /** 是否把执行审计落盘（关掉只留内存最近 200 条，`/audit` 仍可读）。 */
  execAudit: true,
  /** 目录列举的条目上限。 */
  listLimit: 500,
  /** 导出根的 realpath 缓存时长（毫秒）。 */
  rootsTtlMs: 10000,

  // ── 会话历史镜像（会话端 → 执行端，执行端只存储）─────────────────────────
  /** 把本机会话的事件历史实时推给「执行端」（该会话工作路径的实际执行设备）。 */
  sessionMirror: true,
  /** 镜像攒批间隔（毫秒）：太小会碎、太大就不实时。 */
  mirrorFlushMs: 300,
  /** 单批最多推多少条事件。 */
  mirrorBatchEvents: 256,
  /** 单个会话的镜像文件上限（字节）；超出后停止追加并标 truncated。 */
  mirrorMaxSessionBytes: 134217728,
  /**
   * 进度面上「还在动」的判定窗口（毫秒）。
   *
   * 判据是**镜像最近还在收到事件**：会话静置（等用户输入）时它会转 false。这与「agent
   * 是否正在跑」是两件事（后者取对端清单的 live），所以窗口只用于显示，不参与任何门。
   */
  mirrorLiveWindowMs: 120000,
  /**
   * **会话数据同步**：每次会话跑完一轮（镜像里出现 `turn/end`）就把上下文落到本机
   * `sessions/`。执行端因此始终持有控制端的历史 —— 本机离线时它还在，要接手时不必等对端。
   */
  sessionSync: true,
  /** 同步去抖（毫秒）：连续几批合一次，避免一轮里写好几遍。 */
  sessionSyncDebounceMs: 5000,
  /** 单会话同步的最小间隔（毫秒）：把「推迟」而不是「丢弃」当节流 —— 最后一轮照样落地。 */
  sessionSyncMinIntervalMs: 30000,
  /**
   * 自动同步的单会话上限（字节，按**镜像明文**算）。
   *
   * 同步是全量重写：读整份镜像明文 + 重压一遍，峰值内存约是明文的 1.5～2 倍。无人值守
   * 的动作不该在小内存机器上因为一条超长会话把进程顶住 —— 超过就跳过并记原因，留给用户
   * 手动接管（那是一次显式动作，用户看得见它要花多少）。
   */
  sessionSyncMaxBytes: 33554432,
}

/**
 * 归一化插件配置。与同 profile 的其它静态插件一致：手写 clamp，坏值一律回落到
 * 默认，不让一个错配置把整行打成 mount 失败。
 * @param {unknown} config patch 行里的 config。
 * @returns {typeof DEFAULTS} 归一化后的配置。
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const clampInt = (value, min, max, fallback) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const str = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback)
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    deviceName: str(raw.deviceName, DEFAULTS.deviceName).slice(0, 120),
    allowInbound: bool(raw.allowInbound, DEFAULTS.allowInbound),
    requireToken: bool(raw.requireToken, DEFAULTS.requireToken),
    routeExecByPath: bool(raw.routeExecByPath, DEFAULTS.routeExecByPath),
    inventoryTtlMs: clampInt(raw.inventoryTtlMs, 0, 600000, DEFAULTS.inventoryTtlMs),
    pushIntervalMs: clampInt(raw.pushIntervalMs, 5000, 3600000, DEFAULTS.pushIntervalMs),
    heartbeatMs: clampInt(raw.heartbeatMs, 5000, 3600000, DEFAULTS.heartbeatMs),
    mirrorIntervalMs: clampInt(raw.mirrorIntervalMs, 10000, 3600000, DEFAULTS.mirrorIntervalMs),
    requestTimeoutMs: clampInt(raw.requestTimeoutMs, 1000, 300000, DEFAULTS.requestTimeoutMs),
    maxResponseBytes: clampInt(raw.maxResponseBytes, 4096, 64 * 1024 * 1024, DEFAULTS.maxResponseBytes),
    maxBodyBytes: clampInt(raw.maxBodyBytes, 4096, 256 * 1024 * 1024, DEFAULTS.maxBodyBytes),
    requestSkewMs: clampInt(raw.requestSkewMs, 5000, 3600000, DEFAULTS.requestSkewMs),
    nodeStaleMs: clampInt(raw.nodeStaleMs, 10000, 86400000, DEFAULTS.nodeStaleMs),
    nodeOfflineMs: clampInt(raw.nodeOfflineMs, 20000, 30 * 86400000, DEFAULTS.nodeOfflineMs),
    maxSessionsPerWorkspace: clampInt(raw.maxSessionsPerWorkspace, 1, 100000, DEFAULTS.maxSessionsPerWorkspace),
    maxDevices: clampInt(raw.maxDevices, 1, 4096, DEFAULTS.maxDevices),
    titleFoldBudget: clampInt(raw.titleFoldBudget, 0, 1000, DEFAULTS.titleFoldBudget),
    titleFoldBudgetMs: clampInt(raw.titleFoldBudgetMs, 200, 60000, DEFAULTS.titleFoldBudgetMs),
    includeSubagents: bool(raw.includeSubagents, DEFAULTS.includeSubagents),
    includeArchived: bool(raw.includeArchived, DEFAULTS.includeArchived),
    sessionAuthority: typeof raw.sessionAuthority === 'string' ? raw.sessionAuthority.trim() : DEFAULTS.sessionAuthority,
    workspaceRoles: raw.workspaceRoles !== null && typeof raw.workspaceRoles === 'object' && !Array.isArray(raw.workspaceRoles)
      ? raw.workspaceRoles
      : DEFAULTS.workspaceRoles,
    stateSyncIntervalMs: Number.isSafeInteger(raw.stateSyncIntervalMs) && raw.stateSyncIntervalMs >= 5000 ? raw.stateSyncIntervalMs : DEFAULTS.stateSyncIntervalMs,
    authFailMax: clampInt(raw.authFailMax, 1, 100000, DEFAULTS.authFailMax),
    authFailWindowMs: clampInt(raw.authFailWindowMs, 1000, 3600000, DEFAULTS.authFailWindowMs),
    replayCacheMax: clampInt(raw.replayCacheMax, 64, 1 << 20, DEFAULTS.replayCacheMax),
    registerRetries: clampInt(raw.registerRetries, 0, 200, DEFAULTS.registerRetries),
    registerRetryMs: clampInt(raw.registerRetryMs, 20, 5000, DEFAULTS.registerRetryMs),
    storeDir: str(raw.storeDir, DEFAULTS.storeDir),
    allowInsecureHttp: bool(raw.allowInsecureHttp, DEFAULTS.allowInsecureHttp),
    allowRemoteExec: bool(raw.allowRemoteExec, DEFAULTS.allowRemoteExec),
    execTrust: raw.execTrust === 'any-authenticated' ? 'any-authenticated' : DEFAULTS.execTrust,
    exportRoots: Array.isArray(raw.exportRoots)
      ? raw.exportRoots.filter((entry) => typeof entry === 'string' && entry.trim() !== '').slice(0, 64).map((entry) => entry.trim())
      : DEFAULTS.exportRoots,
    exportWorkspacePaths: bool(raw.exportWorkspacePaths, DEFAULTS.exportWorkspacePaths),
    execTimeoutMs: clampInt(raw.execTimeoutMs, 1000, 3600000, DEFAULTS.execTimeoutMs),
    execOutputLimitBytes: clampInt(raw.execOutputLimitBytes, 1024, 16 * 1024 * 1024, DEFAULTS.execOutputLimitBytes),
    execMaxConcurrent: clampInt(raw.execMaxConcurrent, 1, 64, DEFAULTS.execMaxConcurrent),
    execCommandLimit: clampInt(raw.execCommandLimit, 16, 262144, DEFAULTS.execCommandLimit),
    execAuditCommandLimit: clampInt(raw.execAuditCommandLimit, 64, 65536, DEFAULTS.execAuditCommandLimit),
    execAudit: bool(raw.execAudit, DEFAULTS.execAudit),
    listLimit: clampInt(raw.listLimit, 1, 20000, DEFAULTS.listLimit),
    rootsTtlMs: clampInt(raw.rootsTtlMs, 0, 600000, DEFAULTS.rootsTtlMs),
    sessionMirror: bool(raw.sessionMirror, DEFAULTS.sessionMirror),
    mirrorFlushMs: clampInt(raw.mirrorFlushMs, 50, 10000, DEFAULTS.mirrorFlushMs),
    mirrorBatchEvents: clampInt(raw.mirrorBatchEvents, 1, 2048, DEFAULTS.mirrorBatchEvents),
    mirrorMaxSessionBytes: clampInt(raw.mirrorMaxSessionBytes, 1048576, 8 * 1024 * 1024 * 1024, DEFAULTS.mirrorMaxSessionBytes),
    mirrorLiveWindowMs: clampInt(raw.mirrorLiveWindowMs, 5000, 3600000, DEFAULTS.mirrorLiveWindowMs),
    sessionSync: bool(raw.sessionSync, DEFAULTS.sessionSync),
    sessionSyncDebounceMs: clampInt(raw.sessionSyncDebounceMs, 0, 600000, DEFAULTS.sessionSyncDebounceMs),
    sessionSyncMinIntervalMs: clampInt(raw.sessionSyncMinIntervalMs, 0, 86400000, DEFAULTS.sessionSyncMinIntervalMs),
    sessionSyncMaxBytes: clampInt(raw.sessionSyncMaxBytes, 1048576, 8 * 1024 * 1024 * 1024, DEFAULTS.sessionSyncMaxBytes),
  }
}

// ───────────────────────────── HTTP 小工具 ─────────────────────────────

/** 带状态码的调用方错误：4xx 的 message 会原样回到调用方。 */
class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} message 人可读原因。
   * @param {string} code 机器可读码（见 protocol.js 的 CODE）。
   * @param {object} [detail] 要并进失败响应的附加字段（如 auditId）。
   */
  constructor(status, message, code, detail) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code ?? CODE.badRequest
    if (detail !== undefined && detail !== null) Object.assign(this, detail)
  }
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 把任意异常翻成 (状态码, 响应体)。
 *
 * 认三种错误：`HttpError`（本文件）、`ExecError`（exec.js 的执行门）、以及任何
 * 带 `status`/`code` 的第三方错误。**额外字段会被并进失败响应** —— 执行失败时
 * `auditId` / `deviceId` / `cwd` 是排查的关键线索（"哪条命令在哪台机器的哪个目录
 * 被拒了"），丢掉它们等于让调用方只能看到一句笼统的 403。
 * @param {unknown} error 异常。
 * @returns {{status: number, payload: object}} 结果。
 */
function failureOf(error) {
  const status = typeof error?.status === 'number' && Number.isSafeInteger(error.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : (error instanceof HttpError ? error.status : 500)
  const code = typeof error?.code === 'string' && error.code !== ''
    ? error.code
    : (error instanceof HttpError ? error.code : CODE.internal)
  const payload = { ok: false, error: errorText(error), code }
  // 白名单式携带附加字段：不把 Error 的整套自有属性（可能含栈、含内部对象）
  // 无差别倒给调用方。列出来的这几个都是执行链路里刻意构造的可公开字段。
  for (const key of ['auditId', 'deviceId', 'cwd', 'linkId', 'required', 'hint']) {
    const value = error?.[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') payload[key] = value
  }
  return { status, payload }
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {unknown} value 载荷。
 * @returns {void}
 */
function json(res, status, value) {
  if (res.writableEnded === true) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Same-origin 判定，对齐 `dsh-client-connection` 的 `isTrustedApiRequest`
 * 与同 profile 的 dsh-archived-sessions：`sec-fetch-site: cross-site` 一律拒绝；
 * 带 Origin 时必须与 Host 同源；无 Origin 的本机调用放行。
 * lanmode 会把 Host 与 Origin 双双改写成回环权威后再转发，故 LAN 客户端照常通过。
 *
 * **只用于浏览器侧路由**：入站 API 的调用方是远端进程，本来就没有 Origin，
 * 它走签名认证（见 authenticate）。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否可信。
 */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * 读原始请求体（签名覆盖的就是这些字节，所以必须是**原始**内容）。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<Buffer>} 请求体。
 * @throws {HttpError} 413 超限。
 */
function readRawBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new HttpError(413, `请求体超过 ${limit} 字节上限`, CODE.payloadTooLarge))
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolvePromise(Buffer.concat(chunks))
    })
    req.on('error', (error) => fail(error))
    req.on('aborted', () => fail(new HttpError(400, '请求被中断', CODE.badRequest)))
  })
}

/**
 * 解析 JSON 请求体（空体 → 空对象）。
 * @param {Buffer} buffer 原始体。
 * @returns {object} 解析结果。
 * @throws {HttpError} 400 非法 JSON。
 */
function parseJsonBody(buffer) {
  if (buffer.length === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new HttpError(400, `请求体不是合法 JSON：${errorText(error)}`, CODE.badRequest)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', CODE.badRequest)
  }
  return parsed
}

/**
 * 归一化一个来源标识用于限流（IP，去掉 IPv6 映射前缀）。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {string} 来源键。
 */
function sourceKey(req) {
  const raw = req.socket?.remoteAddress ?? 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

// ───────────────────────────── 插件主体 ─────────────────────────────

/**
 * 挂载设备网格。
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 上下文。
 * @param {unknown} rawConfig patch 行里的 config。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  const startedAt = new Date().toISOString()
  /** @type {string[]} 落盘层报告的问题（坏文件 / 写失败），由 /status 如实转出。 */
  const problems = []

  if (!config.enabled) {
    logger?.info?.('dsh-device-mesh: enabled=false，本行不注册任何路由')
    return
  }

  // ── 落盘层 ────────────────────────────────────────────────────────────────
  const meshDir = resolveMeshDir(config.storeDir)
  const dirOk = ensureDir(meshDir)
  if (!dirOk) problems.push(`数据目录不可用：${meshDir}`)
  const { identity, created } = loadIdentity(meshDir, config, problems)
  if (created) logger?.info?.(`dsh-device-mesh: 生成设备身份 ${identity.deviceId}（${identity.name}）`)
  const tokens = new TokenTable(meshDir, problems)
  const nodes = new NodeRegistry(meshDir, config.maxDevices, problems)
  const links = new LinkTable(meshDir, problems)
  const pathTable = new PathTable(meshDir, identity.deviceId, problems)
  const audit = new AuditLog(meshDir, config.execAudit)

  /**
   * 本机工作区路径（导出根的自动来源）。
   * 每次都现读 workspaceRegistry：工作区是低频变更，而缓存住它会带来
   * 「新建的工作区要等一会儿才能被远端执行」这种难解释的行为。
   * @returns {string[]} 路径列表。
   */
  const localWorkspacePaths = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return []
    try {
      return (registry.list() ?? []).map((workspace) => workspace.path).filter((value) => typeof value === 'string' && value !== '')
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 读取本机工作区路径失败：${errorText(error)}`)
      return []
    }
  }

  const executor = new Executor({
    config,
    meshDir,
    logger,
    audit,
    workspacePaths: localWorkspacePaths,
  })

  // ── 运行时 ────────────────────────────────────────────────────────────────
  const replay = new ReplayGuard({ windowMs: config.requestSkewMs, maxEntries: config.replayCacheMax })
  /** @type {Map<string, {count: number, windowStart: number}>} 认证失败限流。 */
  const authFailures = new Map()
  /** @type {Map<string, number>} 对端一跳总览镜像：linkId → 拉取时刻。 */
  const mirrors = new Map()
  let inboundRequests = 0
  let deniedRequests = 0
  const counters = { lastError: null, startedAt, lastAuthAt: null }

  const device = () => describeDevice({ identity, config, startedAt })

  /**
   * 公开设备描述：`hello` 在**未认证**时也返回它，所以刻意不含 hostname /
   * 内存 / CPU —— 那些是「认证之后才该知道」的资产信息。
   * @returns {object} 公开描述。
   */
  const publicDevice = () => {
    const full = device()
    return {
      deviceId: full.deviceId,
      name: full.name,
      platform: full.platform,
      os: full.os,
      icon: full.icon,
      dshVersion: full.dshVersion,
      meshVersion: full.meshVersion,
      protocol: full.protocol,
      capabilities: full.capabilities,
    }
  }

  const inventory = createInventoryCache({ ctx, config, device, logger })

  const egress = new Egress({
    config,
    identity,
    links,
    device,
    inventory,
    logger,
  })

  /**
   * 跨设备执行发起器。
   *
   * `context` 用惰性闭包指向稍后定义的 `buildContext`：Caller 构造时那个 const 还
   * 在 TDZ 里，但 `context()` 只在请求到达时被调用 —— 那时 apply() 早已返回、
   * 整段作用域都已初始化。写成「构造时立刻求值」反而会在这里抛 TDZ 错。
   */
  const caller = new Caller({
    config,
    identity,
    links,
    egress,
    executor,
    audit,
    logger,
    context: () => buildContext(),
  })

  // ── 会话历史镜像 ──────────────────────────────────────────────────────────
  const dshHomePath = () => (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh'))

  /**
   * 出厂会话目录的 slug：`/root/a/b` → `--root-a-b--`。
   * 只在「本机还没有这个会话目录」时用来推目标路径；已有目录一律以磁盘为准。
   * @param {string} cwd 会话工作目录。
   * @returns {string} slug。
   */
  const slugForCwd = (cwd) => `--${String(cwd ?? '').replace(/[\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`

  /** 单引号安全包裹（对端是 sh）。 @param {string} value 原样 @returns {string} */
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

  /**
   * 本机某会话的日志现状（给「拉回历史」做前置判断）。
   *
   * 「空桩」的判据是**日志里没有事件**：会话头（几百字节）谁都有，`request/context`
   * 才是第一条真事件。用文件大小做代理不可靠（压缩率差一个量级），所以这里直接
   * 解出第一帧看有没有第二行 —— 解不动（截断/损坏）时按「有事件」处理，宁可拒绝。
   * @param {string} sessionId 会话 id。
   * @returns {{dir:string|null, file:string|null, bytes:number, hasEvents:boolean, live:boolean}|null}
   */
  const localSessionLog = (sessionId) => {
    const root = path.join(dshHomePath(), 'sessions')
    let dir = null
    try {
      for (const slug of fs.readdirSync(root)) {
        const candidate = path.join(root, slug, sessionId)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) { dir = candidate; break }
      }
    } catch { /* sessions/ 不存在：本机从来没写过会话 */ }
    let live = false
    try {
      live = (ctx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === sessionId)
    } catch { /* 取不到活会话列表：不当成活的（后面还有大小/事件判据） */ }
    if (dir === null) return { dir: null, file: null, bytes: 0, hasEvents: false, live }
    let file = null
    let bytes = 0
    for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        const size = fs.statSync(candidate).size
        if (file === null || size > bytes) { file = candidate; bytes = size }
      }
    }
    if (file === null) return { dir, file: null, bytes: 0, hasEvents: false, live }
    let hasEvents = true
    try {
      const raw = fs.readFileSync(file)
      const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      const frames = []
      let index = 0
      for (;;) {
        const at = raw.indexOf(MAGIC, index)
        if (at < 0) break
        if (frames.length > 0) frames[frames.length - 1].end = at
        frames.push({ start: at, end: raw.length })
        index = at + 4
      }
      let text = ''
      for (const frame of frames) {
        try { text += zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString('utf8') } catch { /* 单帧坏：看其余帧 */ }
      }
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      hasEvents = lines.some((line) => {
        try { return JSON.parse(line).type !== 'session' } catch { return false }
      })
    } catch { hasEvents = true }
    return { dir, file, bytes, hasEvents, live }
  }

  // ── 落地（拉回 / 接管共用）────────────────────────────────────────────────

  /** 出厂会话 id 的形状（`session-<uuid>`）。 */
  const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  /** 本机日志的备份目录（**在网格数据目录下**，会话目录只留出厂认识的文件）。 */
  const takeoverBackupDir = () => path.join(meshDir, 'session-takeover-backups')

  /**
   * 覆盖本机日志前先备份。
   * @param {string} sessionId 会话 id。
   * @param {string} file 现有日志文件。
   * @returns {string} 备份路径。
   */
  const backupLocalLog = (sessionId, file) => {
    const dir = takeoverBackupDir()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const target = path.join(dir, `${sessionId}.${Date.now()}.${path.basename(file)}`)
    try {
      fs.copyFileSync(file, target)
    } catch (error) {
      throw new HttpError(500, `备份本机日志失败，已放弃覆盖：${errorText(error)}`, CODE.internal)
    }
    return target
  }

  /**
   * 把**会遮蔽新日志的旧世代**挪出会话目录。
   *
   * 出厂选世代的口径是「目录里数值最高的那个 canonical 世代」
   * （`resolveGenerationInDirectory`）。所以：本机那份旧的 v4 会把刚落地的 v3 整个盖住 ——
   * 拉取看起来成功、打开还是旧历史，是最难查的一类失败。落地后把**比新世代更高**的
   * 日志挪进备份目录；更低的留着无害（出厂根本不会选它），也不动（那是历史）。
   * @param {string} dir 会话目录。
   * @param {number} keepVersion 刚写下的世代。
   * @param {string} sessionId 会话 id（备份命名用）。
   * @returns {string[]} 被挪走的文件。
   */
  const pruneShadowingGenerations = (dir, keepVersion, sessionId) => {
    const moved = []
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return moved
    }
    for (const name of names) {
      const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name)
      if (match === null) continue
      const version = Number(match[1])
      if (!Number.isSafeInteger(version) || version <= keepVersion) continue
      const from = path.join(dir, name)
      const to = path.join(takeoverBackupDir(), `${sessionId}.${Date.now()}.${name}`)
      try {
        fs.mkdirSync(takeoverBackupDir(), { recursive: true, mode: 0o700 })
        fs.renameSync(from, to)
        moved.push(to)
      } catch (error) {
        throw new HttpError(500, `清不掉会遮蔽新日志的旧世代 ${name}（${errorText(error)}），已放弃`, CODE.internal)
      }
    }
    return moved
  }

  /**
   * 接管落地时用的**权威会话 id**。
   *
   * 镜像目录里两代命名并存（`session-<uuid>` 与 `<uuid>`），而出厂一律带前缀，且头行里的
   * id 必须等于请求的 id（`assertStoredId`）。所以：镜像头里有 id 就用它（那是源设备
   * 自己的日志头，最权威），否则把前缀补上。
   * @param {string} sessionId 请求里的会话 id。
   * @param {object|null} replica 镜像索引项。
   * @returns {string} 规范 id；判不出来返回 ''。
   */
  const canonicalSessionId = (sessionId, replica) => {
    const fromHeader = typeof replica?.header?.id === 'string' ? replica.header.id.trim() : ''
    if (SESSION_ID_PATTERN.test(fromHeader)) return fromHeader
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (SESSION_ID_PATTERN.test(trimmed)) return trimmed
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ? `session-${trimmed}` : ''
  }

  /** 接管审计文件（一行一条，追加；读侧只读尾部）。 */
  const takeoverAuditFile = path.join(meshDir, 'session-takeover.jsonl')

  /**
   * 记一条接管审计。
   *
   * 为什么单独一个文件而不是塞进 exec 审计：执行审计回答「谁往本机发过命令」，
   * 接管回答「这条会话是什么时候变成由本机跑的」—— 两者受众与保留期都不一样。
   * @param {object} entry 审计条目。
   * @returns {void}
   */
  const recordTakeover = (entry) => {
    // 记进内存集合：同步工人靠它判断「这条会话本机已经接管过，别再用对端的旧历史往回盖」。
    if (typeof entry?.sessionId === 'string') takenOverIds.add(entry.sessionId)
    try {
      fs.appendFileSync(takeoverAuditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 接管审计写入失败：${errorText(error)}`)
    }
  }

  /**
   * 读接管审计的尾部（有界读，与执行审计同一套路）。
   * @param {number} [maxEntries] 最多返回多少条（新的在后）。
   * @returns {object[]} 审计条目。
   */
  const readTakeoverTail = (maxEntries = 200) => {
    const rows = []
    let handle = null
    try {
      const stat = fs.statSync(takeoverAuditFile)
      const start = Math.max(0, stat.size - 64 * 1024)
      handle = fs.openSync(takeoverAuditFile, 'r')
      const buffer = Buffer.allocUnsafe(stat.size - start)
      const read = fs.readSync(handle, buffer, 0, buffer.length, start)
      let text = buffer.subarray(0, read).toString('utf8')
      if (start > 0) {
        const newline = text.indexOf('\n')
        text = newline === -1 ? '' : text.slice(newline + 1)
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed !== null && typeof parsed === 'object') rows.push(parsed)
        } catch {
          // 半截行/坏行跳过：审计是证据，不该因为一行坏掉就整份读不出来。
        }
      }
    } catch {
      // 还没有接管过：正常。
    } finally {
      if (handle !== null) {
        try { fs.closeSync(handle) } catch { /* 关不上也只能算了 */ }
      }
    }
    return rows.slice(-maxEntries)
  }

  /**
   * 把一份**出厂可读**的日志字节落进本机会话目录。
   * @param {{sessionId:string, cwd:string, version:number, bytes:Buffer, localDir:string|null}} request 落盘参数。
   * @returns {{path:string, dir:string, moved:string[], backup:string|null}} 结果。
   */
  const writeLocalSessionLog = ({ sessionId, cwd, version, bytes, localDir, backup }) => {
    const dir = localDir ?? path.join(dshHomePath(), 'sessions', slugForCwd(cwd), sessionId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `session.v${version}.jsonl.zstd`)
    const tmp = `${file}.takeover-${randomHex(8)}`
    fs.writeFileSync(tmp, bytes, { mode: 0o600 })
    fs.renameSync(tmp, file)
    // 旧世代里比这份更高的会把它整个盖住（出厂选最高世代），必须挪走。
    const moved = pruneShadowingGenerations(dir, version, sessionId)
    return { path: file, dir, moved, backup: backup ?? null }
  }

  /**
   * 落地用的会话头。
   *
   * 优先用镜像里存的那份（对端随镜像送来的**源日志头**，最权威）。旧版索引没存头
   * （那时还没这个字段），就用索引自己有的字段合成一个：`createdAt` 只能用「镜像第一次
   * 见到它」的时间（近似），`version` 留空交给事件形状推断 —— 宁可带一个近似时间，也不
   * 因为缺头把一条能读的历史整条拒绝掉。
   * @param {object} replica 镜像索引项。
   * @param {string} sessionId 规范会话 id。
   * @param {string} cwd 工作目录。
   * @returns {object} 会话头。
   */
  const landingHeader = (replica, sessionId, cwd) => (
    replica.header !== null && replica.header !== undefined
      ? replica.header
      : {
        id: sessionId,
        cwd,
        createdAt: Number.isSafeInteger(Date.parse(replica.createdAt)) ? Date.parse(replica.createdAt) : 0,
      }
  )

  // ── 会话数据同步（每次运行结束后把上下文落到本机）──────────────────────────
  //
  // 需求：**每次会话完成一次运行后**，执行端要有控制端（会话侧）的上下文留在本地 ——
  // 不是「能看见进度」而已，而是这份历史在本机就是一份**完整的、可打开的会话**：本机
  // 离线时它还在，要接手时不用再等对端。镜像自己只落网格数据目录（§12.6 的边界不动），
  // 同步是在镜像**之上**多走一步：把镜像重压成出厂可读的日志，写进本机 `sessions/`。
  //
  // 触发：镜像批里出现 `turn/end`（一次运行结束）。不按时间轮询（会话不动就没有要同步
  // 的东西），也不在跑到一半时同步（那只会得到半截历史，下一批还会变）。
  //
  // 不去动的情况（都记进索引，UI 与 `/replica-progress` 能看到原因）：
  //   · 本机正在跑这条会话（活 agent）→ 覆盖会弄坏它；
  //   · 本机**已经接管**过它（接管审计里有）→ 那之后本机是这条会话的主人，对端的旧历史
  //     不该再往回盖（否则「接管 + 在 3 上又跑一轮」会把本机的新历史悄悄冲掉）；
  //   · 子代理会话（`origin === 'subagent'`）→ 出厂要求用父会话地址打开，落成本机会话
  //     只会多出一个打不开的条目；
  //   · 镜像重压不出来（缺头/分叉/世代判不出来）→ 记 error，UI 能看到原因。
  //
  // 覆盖**不备份**：镜像本身就是那份备份（完整历史一直在 `session-replica/` 里），每轮
  // 备份会让 SD 卡堆出几百 MB 的重复内容。手动接管仍会备份（那是用户显式动作）。
  /** 已接管过的会话 id（懒加载自接管审计；接管时即时补进来）。 */
  const takenOverIds = new Set()
  let takenOverLoaded = false
  const wasTakenOver = (sessionId) => {
    if (!takenOverLoaded) {
      takenOverLoaded = true
      for (const entry of readTakeoverTail(2000)) {
        if (typeof entry.sessionId === 'string') takenOverIds.add(entry.sessionId)
      }
    }
    return takenOverIds.has(sessionId)
  }
  /** sessionId → 已排的定时器（同步是全量重写，同一会话只排一次就够）。 */
  const syncTimers = new Map()
  const syncLastAt = new Map()
  const syncCounters = { scheduled: 0, synced: 0, skipped: 0, failed: 0, lastError: null }

  /**
   * 排一次同步。
   *
   * 两道节流：**去抖**（`sessionSyncDebounceMs`）让连续几批合一次；**每会话最小间隔**
   * （`sessionSyncMinIntervalMs`）避免「一分钟跑五轮」就把几 MB 的日志重压五遍。两者都是
   * **推迟**而不是丢弃 —— 最后一轮的数据照样会落地，只是晚一点。
   * @param {string} sessionId 会话 id（镜像里的形态）。
   * @returns {void}
   */
  const scheduleSync = (sessionId) => {
    if (!config.sessionSync) return
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (syncTimers.has(sessionId)) return
    const due = Math.max(
      Date.now() + config.sessionSyncDebounceMs,
      (syncLastAt.get(sessionId) ?? 0) + config.sessionSyncMinIntervalMs,
    )
    const timer = setTimeout(() => {
      syncTimers.delete(sessionId)
      syncLastAt.set(sessionId, Date.now())
      void syncSession(sessionId)
    }, Math.max(0, due - Date.now()))
    if (typeof timer.unref === 'function') timer.unref()
    syncTimers.set(sessionId, timer)
    syncCounters.scheduled += 1
  }

  /**
   * 同步一条会话：镜像 → 本机 `sessions/`。
   * @param {string} sessionId 会话 id（镜像里的形态）。
   * @returns {Promise<void>} 无（结果记进镜像索引，不抛）。
   */
  const syncSession = async (sessionId) => {
    const replica = replicas.find(sessionId)
    if (replica === null) return
    const canonical = canonicalSessionId(sessionId, replica)
    if (canonical === '') return
    try {
      const local = localSessionLog(canonical)
      if (local === null) {
        replicas.recordSync(sessionId, { error: '读不到本机会话目录' })
        syncCounters.failed += 1
        return
      }
      if (local.live === true) {
        replicas.recordSync(sessionId, { skipped: '本机正在跑这条会话' })
        syncCounters.skipped += 1
        return
      }
      if (wasTakenOver(canonical)) {
        replicas.recordSync(sessionId, { skipped: '本机已接管这条会话（不再自动覆盖）' })
        syncCounters.skipped += 1
        return
      }
      if (replica.header?.origin === 'subagent') {
        replicas.recordSync(sessionId, { skipped: '子代理会话不在本机落地' })
        syncCounters.skipped += 1
        return
      }
      if (replica.bytes > config.sessionSyncMaxBytes) {
        replicas.recordSync(sessionId, { skipped: `镜像 ${replica.bytes} 字节超过自动同步上限，留给手动接管` })
        syncCounters.skipped += 1
        return
      }
      const cwd = typeof replica.header?.cwd === 'string' && replica.header.cwd !== '' ? replica.header.cwd : replica.workspacePath
      if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) {
        replicas.recordSync(sessionId, { error: `镜像里没有可用的绝对工作目录（${String(cwd)}）` })
        syncCounters.failed += 1
        return
      }
      const built = buildSessionLogBytes(landingHeader(replica, canonical, cwd), replicas.readEvents(replica))
      if (!built.ok) {
        replicas.recordSync(sessionId, { error: `镜像不足以落地这条会话：${built.reason}` })
        syncCounters.failed += 1
        return
      }
      const written = writeLocalSessionLog({
        sessionId: canonical,
        cwd,
        version: built.version,
        bytes: built.bytes,
        localDir: local.dir,
        backup: null,
      })
      replicas.recordSync(sessionId, {
        at: new Date().toISOString(),
        seq: replica.lastSeq,
        bytes: built.bytes.length,
        version: `v${built.version}`,
      })
      syncCounters.synced += 1
      syncCounters.lastError = null
      logger?.info?.(`dsh-device-mesh: 会话 ${canonical} 的上下文已同步到本机（v${built.version}，${built.bytes.length} 字节，seq ${replica.lastSeq}，落在 ${written.path}）`)
    } catch (error) {
      syncCounters.failed += 1
      syncCounters.lastError = errorText(error)
      replicas.recordSync(sessionId, { error: syncCounters.lastError })
      logger?.warn?.(`dsh-device-mesh: 会话 ${sessionId} 同步失败：${errorText(error)}`)
    }
  }

  // 插件卸载时把还没到点的同步定时器清掉（会话数据已经落在镜像里，下次触发还会同步）。
  ctx.effect(() => () => {
    for (const timer of syncTimers.values()) clearTimeout(timer)
    syncTimers.clear()
  }, 'dsh-device-mesh: session sync timers')

  /**
   * 在（已经建好的）设备树里找某设备报的某条会话。
   * @param {object} tree buildTree 的结果。
   * @param {string} deviceId 设备 id。
   * @param {string} sessionId 会话 id。
   * @returns {object|null} 会话条目。
   */
  const findRemoteSession = (tree, deviceId, sessionId) => {
    for (const device of tree.devices) {
      if (device.deviceId !== deviceId) continue
      for (const workspace of device.inventory?.workspaces ?? []) {
        for (const session of workspace.sessions ?? []) {
          if (session?.id === sessionId) return session
        }
      }
    }
    return null
  }

  /** 执行端：镜像存储（只落盘，绝不进 DSH 自己的 sessions/）。 */
  const replicas = new SessionReplicaStore(meshDir, problems, {
    maxSessionBytes: config.mirrorMaxSessionBytes,
    maxBatchEvents: config.mirrorBatchEvents,
  })

  /**
   * 会话端：把「在别处执行」的会话历史实时推给那台设备。
   *
   * 目标设备由**路径路由**决定（与会话的 workdir 该在哪台执行同源）：本机执行的
   * 会话不需要镜像，只有转发执行的会话才有第二个家。
   */
  const mirrorSender = new SessionMirrorSender({
    meshDir,
    selfDeviceId: identity.deviceId,
    sessionsRoot: path.join(dshHomePath(), 'sessions'),
    flushMs: config.mirrorFlushMs,
    batchEvents: config.mirrorBatchEvents,
    logger,
    problems,
    resolveTarget: (session) => {
      if (!config.sessionMirror) return null
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return null
      const decision = routePath(cwd, {
        owners: collectPathOwners(buildPathGroups([])),
        selfDeviceId: identity.deviceId,
      })
      return decision.route.kind === 'remote' ? decision.route.deviceId : null
    },
    send: async (deviceId, body) => {
      const { json } = await caller.request({
        deviceId,
        targetPath: typeof body.workspacePath === 'string' && body.workspacePath !== '' ? body.workspacePath : '/',
        route: API.sessionMirror,
        body: { ...body, protocol: PROTOCOL_VERSION },
        timeoutMs: config.requestTimeoutMs,
      })
      return json
    },
  })
  // 会话事件的订阅：每一次**已提交**事件都到这里 —— 镜像的实时性就来自这里。
  // 用 ctx.on 而不是 inject(['sessions'])：事件是广播语义，拿到事件本身就够判断
  // 该不该镜像；会话服务缺席时只是收不到事件，不该把整行拖进 waiting。
  const onSessionEvent = (session, event) => {
    if (!config.sessionMirror) return
    try {
      mirrorSender.observe(session, event)
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 会话镜像入队失败：${errorText(error)}`)
    }
  }
  ctx.on('session/event', onSessionEvent)
  ctx.effect(() => () => mirrorSender.stop(), 'dsh-device-mesh: session mirror cursors')

  // ── 路由注册 ──────────────────────────────────────────────────────────────

  /**
   * 注册一条精确路由，并容忍 patch 层热重挂时的瞬时占用。
   *
   * profile 是 patchReload=live，而 loader 的 EntryGroup.update 是**先建全部新
   * entry、再拆被删掉的旧 entry**，于是新行的 apply 会在旧行仍占着同名路径期间
   * 执行，`webServer.register` 的 duplicate 检查抛错 → 整层 update 回滚 → 旧代码
   * 继续在跑。这里把「路径已被占用」当成可恢复状态重试，dispose 时撤销未完成的
   * 定时器与已注册的路由。（与 dsh-archived-sessions / dsh-session-import 同一套路。）
   * @param {string} label 诊断标签。
   * @param {string} path 路径。
   * @param {Function} handler 处理器。
   * @returns {void}
   */
  const registerRoute = (label, path, handler) => ctx.effect(() => {
    let disposed = false
    let unregister = null
    let timer = null
    const attempt = (remaining) => {
      if (disposed) return
      try {
        unregister = ctx.webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        if (remaining > 0 && /duplicate .*route/i.test(errorText(error))) {
          timer = setTimeout(() => attempt(remaining - 1), config.registerRetryMs)
          return
        }
        logger?.warn?.(`dsh-device-mesh: 路由 ${path} 注册失败：${errorText(error)}`)
      }
    }
    attempt(config.registerRetries)
    return () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      if (unregister !== null) unregister()
    }
  }, label)

  // ── 入站认证 ──────────────────────────────────────────────────────────────

  /**
   * 认证一次入站请求。
   *
   * 顺序刻意如此：限流 → 开关 → 读体 → 取令牌 → 验签 → 防重放 → 节点状态。
   * 限流放在最前面：不能让一个暴力破解者靠「每次都在验签阶段失败」绕开计数。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {string} expectedPath 该路由声明的路径（签名覆盖它）。
   * @returns {Promise<{body: object, raw: Buffer, material: object, token: object, node: object|null}>} 认证结果。
   * @throws {HttpError} 任一环节不通过。
   */
  const authenticate = async (req, expectedPath) => {
    const now = Date.now()
    const source = sourceKey(req)
    if (!allowSource(source, now)) {
      deniedRequests += 1
      throw new HttpError(429, '认证失败次数过多，请稍后再试', CODE.unauthenticated)
    }
    if (!config.allowInbound) {
      throw new HttpError(403, '本机未开启入站接入（allowInbound=false）', CODE.inboundDisabled)
    }
    // 签名覆盖的是 pathname，而这里只签不带 query 的路径。带 query 会让
    // 「签名覆盖了什么」出现两种读法，直接拒绝比解释它更安全。
    const rawUrl = req.url ?? ''
    if (rawUrl.includes('?')) {
      throw new HttpError(400, '入站 API 不接受查询串', CODE.badRequest)
    }

    const raw = await readRawBody(req, config.maxBodyBytes)
    let body = {}
    if (raw.length > 0) body = parseJsonBody(raw)

    if (!config.requireToken) {
      // 开放模式：不验签，但仍要求带设备标识头（否则无人可归属）。
      const deviceId = typeof req.headers['x-dsh-mesh-device'] === 'string' ? req.headers['x-dsh-mesh-device'] : ''
      if (!/^[0-9a-f]{8,128}$/.test(deviceId)) {
        throw new HttpError(400, '缺少 x-dsh-mesh-device 头', CODE.badRequest)
      }
      const node = nodes.get(deviceId) ?? null
      if (node !== null && node.trust === 'denied') {
        throw new HttpError(403, '该设备已被本机拉黑', CODE.deviceDenied)
      }
      return { body, raw, material: { deviceId, tokenId: 'open', protocol: PROTOCOL_VERSION, nonce: '', timestamp: now }, token: null, node }
    }

    const tokenId = typeof req.headers['x-dsh-mesh-token'] === 'string' ? req.headers['x-dsh-mesh-token'].trim() : ''
    const token = tokenId === '' ? undefined : tokens.lookup(tokenId)
    if (token === undefined || token.revoked || (token.expiresAt !== null && Date.parse(token.expiresAt) <= now)) {
      throw new HttpError(401, '令牌不存在、已撤销或已过期', CODE.unauthenticated)
    }

    let material
    try {
      material = verifyRequestSignature({
        secret: token.secret,
        method: req.method ?? 'GET',
        path: expectedPath,
        body: raw,
        headers: req.headers,
        now,
        skewMs: config.requestSkewMs,
      })
    } catch (error) {
      recordAuthFailure(source, now)
      throw new HttpError(401, errorText(error), CODE.badSignature)
    }
    if (!replay.accept(material.tokenId, material.nonce, now)) {
      recordAuthFailure(source, now)
      throw new HttpError(401, '请求 nonce 重复（疑似重放）', CODE.badSignature)
    }
    clearAuthFailures(source)
    tokens.touch(token.id, material.deviceId, now)
    counters.lastAuthAt = new Date(now).toISOString()

    const node = nodes.get(material.deviceId) ?? null
    if (node !== null && node.trust === 'denied') {
      throw new HttpError(403, '该设备已被本机拉黑', CODE.deviceDenied)
    }
    return { body, raw, material, token, node }
  }

  /**
   * 该来源是否还在允许范围内。
   * @param {string} source 来源键。
   * @param {number} now 当前时刻。
   * @returns {boolean} 是否放行。
   */
  const allowSource = (source, now) => {
    const entry = authFailures.get(source)
    if (entry === undefined) return true
    if (now - entry.windowStart > config.authFailWindowMs) {
      authFailures.delete(source)
      return true
    }
    return entry.count < config.authFailMax
  }

  /**
   * 记一次认证失败（供限流）。
   * @param {string} source 来源键。
   * @param {number} now 当前时刻。
   * @returns {void}
   */
  const recordAuthFailure = (source, now) => {
    const entry = authFailures.get(source)
    if (entry === undefined || now - entry.windowStart > config.authFailWindowMs) {
      authFailures.set(source, { count: 1, windowStart: now })
    } else {
      entry.count += 1
    }
    // 表本身也要有界：来源 IP 可能很多。
    if (authFailures.size > 4096) {
      const oldest = authFailures.keys().next()
      if (oldest.done !== true) authFailures.delete(oldest.value)
    }
  }

  /**
   * 清掉某来源的失败计数（一次成功即清零）。
   * @param {string} source 来源键。
   * @returns {void}
   */
  const clearAuthFailures = (source) => {
    authFailures.delete(source)
  }

  /**
   * 入站处理器的统一包装：只调 POST、异常翻译成带 code 的 JSON。
   * @param {string} label 诊断标签。
   * @param {string} path 路径（签名覆盖它）。
   * @param {(input: object, req: object) => Promise<object>} fn 业务。
   * @returns {Function} 处理器。
   */
  const inbound = (label, path, fn) => async (req, res) => {
    inboundRequests += 1
    if ((req.method ?? 'GET') !== 'POST') {
      return json(res, 405, { ok: false, error: 'Method Not Allowed', code: CODE.notFound })
    }
    try {
      const auth = await authenticate(req, path)
      const value = await fn(auth, req)
      return json(res, 200, { ok: true, ...value })
    } catch (error) {
      const { status, payload } = failureOf(error)
      if (status >= 500) {
        counters.lastError = { at: new Date().toISOString(), route: label, error: errorText(error) }
        logger?.warn?.(`dsh-device-mesh: 入站 ${label} 失败：${errorText(error)}`)
      }
      return json(res, status, payload)
    }
  }

  // ── 入站 API ──────────────────────────────────────────────────────────────

  registerRoute('route:api-hello', API.hello, async (req, res) => {
    inboundRequests += 1
    if ((req.method ?? 'GET') !== 'GET') {
      return json(res, 405, { ok: false, error: 'Method Not Allowed', code: CODE.notFound })
    }
    // hello 是唯一无需认证的入口，但「关了入站」时连它也不该回答 ——
    // 否则一台关闭接入的设备仍会向整个网段宣告自己。
    if (!config.allowInbound) {
      return json(res, 403, { ok: false, error: '本机未开启入站接入', code: CODE.inboundDisabled })
    }
    return json(res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      meshVersion: MESH_VERSION,
      authRequired: config.requireToken,
      api: API,
      serverTimeMs: Date.now(),
      hub: publicDevice(),
    })
  })

  registerRoute('route:api-join', API.join, inbound('join', API.join, async (auth) => {
    const now = Date.now()
    const remote = auth.body.device
    if (remote === null || typeof remote !== 'object' || typeof remote.deviceId !== 'string') {
      throw new HttpError(400, '缺少 device 描述', CODE.badRequest)
    }
    // 签名头里的 deviceId 必须与 body 里的一致：否则一个持有合法令牌的节点
    // 可以拿别人的 deviceId 去覆盖那台设备的记录。
    if (config.requireToken && remote.deviceId !== auth.material.deviceId) {
      throw new HttpError(400, '签名设备标识与 device.deviceId 不一致', CODE.badRequest)
    }
    const clientProtocol = Number(auth.body.protocol ?? auth.material.protocol)
    if (clientProtocol !== PROTOCOL_VERSION) {
      throw new HttpError(409, `协议版本不匹配：本机 ${PROTOCOL_VERSION}，对端 ${clientProtocol}`, CODE.protocolMismatch)
    }
    const verdict = nodes.join({
      deviceId: remote.deviceId,
      device: sanitizeRemoteDevice(remote),
      tokenId: auth.token?.id ?? 'open',
      now,
      nodeId: typeof auth.body.nodeId === 'string' ? auth.body.nodeId.slice(0, 64) : undefined,
    })
    if (!verdict.ok) throw new HttpError(503, verdict.error, CODE.tooManyNodes)

    // join 可以顺带带一份清单（正常路径都会带），带了就直接存下来，
    // 省掉「刚接入但还没上报」的空窗期。probe（links/test 的探测）不带。
    const probed = auth.body.probe === true
    const hasInventory = !probed && auth.body.inventory !== null && typeof auth.body.inventory === 'object'
    if (hasInventory) {
      nodes.touch(remote.deviceId, { now, inventory: sanitizeInventory(auth.body.inventory, config), flush: true })
    }
    return {
      protocol: PROTOCOL_VERSION,
      nodeId: verdict.record.nodeId,
      inventoryStored: hasInventory,
      serverTimeMs: now,
      pushIntervalMs: config.pushIntervalMs,
      heartbeatMs: config.heartbeatMs,
      hub: device(),
    }
  }))

  registerRoute('route:api-report', API.report, inbound('report', API.report, async (auth) => {
    const node = requireNode(auth)
    if (auth.body.inventory === null || typeof auth.body.inventory !== 'object') {
      throw new HttpError(400, '缺少 inventory 快照', CODE.badRequest)
    }
    const updated = nodes.touch(node.deviceId, {
      now: Date.now(),
      inventory: sanitizeInventory(auth.body.inventory, config),
      flush: true,
    })
    return {
      protocol: PROTOCOL_VERSION,
      acceptedAt: new Date().toISOString(),
      revision: typeof auth.body.inventory.revision === 'number' ? auth.body.inventory.revision : null,
      workspaceCount: Array.isArray(auth.body.inventory.workspaces) ? auth.body.inventory.workspaces.length : 0,
      sessionCount: Number.isSafeInteger(auth.body.inventory.totals?.sessions) ? auth.body.inventory.totals.sessions : null,
      lastInventoryAt: updated?.lastInventoryAt ?? null,
    }
  }))

  registerRoute('route:api-heartbeat', API.heartbeat, inbound('heartbeat', API.heartbeat, async (auth) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    return {
      protocol: PROTOCOL_VERSION,
      acceptedAt: new Date().toISOString(),
      nextInMs: config.heartbeatMs,
    }
  }))

  registerRoute('route:api-leave', API.leave, inbound('leave', API.leave, async (auth) => {
    const node = requireNode(auth)
    nodes.forget(node.deviceId)
    logger?.info?.(`dsh-device-mesh: 设备 ${node.device?.name ?? node.deviceId} 主动退出`)
    return { protocol: PROTOCOL_VERSION, removed: true }
  }))

  registerRoute('route:api-tree', API.tree, inbound('tree', API.tree, async (auth) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    // 一跳硬边界：只回「自己 + 自己接入的节点」，不回自己镜像来的设备。
    return { protocol: PROTOCOL_VERSION, tree: buildTree({ scope: 'direct', now: Date.now() }) }
  }))

  registerRoute('route:api-paths', API.paths, inbound('paths', API.paths, async (auth) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    // 远端账目是**只读**的：对端拿它展示本机的附加路径、解析「本机主路径在哪台设备上」。
    // 本机不接受对端写自己的账目 —— 谁的账谁说了算，否则两台设备可以互相把对方的
    // 工作区指到一台不存在的机器上。
    const groups = buildPathGroups(buildTree({ scope: 'direct', now: Date.now() }).devices)
    return {
      protocol: PROTOCOL_VERSION,
      deviceId: identity.deviceId,
      generatedAt: new Date().toISOString(),
      workspaces: groups.map((group) => ({
        workspaceId: group.workspaceId,
        title: group.workspaceTitle,
        primaryPath: group.primary.path,
        members: group.members.map((member) => ({
          id: member.id,
          deviceId: member.deviceId,
          path: member.path,
          role: member.role,
          label: member.label,
        })),
      })),
    }
  }))

  registerRoute('route:api-list', API.list, inbound('fs/list', API.list, async (auth) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    // 目录列举与执行**共用同一道导出根闸**（executor.list 内部就是 checkPath）。
    // 共用是刻意的：能列就能推断，能推断就能执行 —— 分成两套判定只会产生不一致，
    // 而不一致的那一侧迟早是更松的那一侧。
    return { protocol: PROTOCOL_VERSION, ...executor.list(auth.body.path) }
  }))

  registerRoute('route:api-exec', API.exec, inbound('exec', API.exec, async (auth) => {
    const node = requireNode(auth)
    const now = Date.now()
    nodes.touch(node.deviceId, { now })
    const command = typeof auth.body.command === 'string' ? auth.body.command : ''
    if (command.trim() === '') throw new HttpError(400, 'command 不能为空', CODE.badRequest)
    if (command.length > config.execCommandLimit) {
      throw new HttpError(400, `command 超过 ${config.execCommandLimit} 字符上限`, CODE.badRequest)
    }

    // 先判权限、再判路径：让「没被授权」与「路径不对」在审计里是两种拒绝，
    // 运维才能一眼看出对端是在试探权限，还是在用错路径。
    let cwd
    try {
      executor.checkAuthority(node)
      cwd = executor.checkPath(auth.body.path)
    } catch (error) {
      if (error instanceof ExecError) {
        // 被门拒掉的尝试也进审计 —— 失败审计比成功审计更有价值。
        const entry = audit.append({
          deviceId: node.deviceId,
          deviceName: node.device?.name ?? node.deviceId,
          direction: 'in',
          actor: 'remote',
          path: typeof auth.body.path === 'string' ? auth.body.path : '',
          command: command.slice(0, config.execAuditCommandLimit),
          outcome: 'denied',
          code: error.code,
          exitCode: null,
          durationMs: 0,
          error: error.message,
        })
        throw new HttpError(error.status, error.message, error.code, { auditId: entry.id })
      }
      throw error
    }

    const result = await executor.run({
      cwd,
      command,
      timeoutMs: auth.body.timeoutMs,
      // 发起方带来的 id：它靠这个在本地中止时点名中止。本机不回传别的 id ——
      // 一次性传输里，本机在跑完之前没机会把 id 告诉对端。
      jobId: auth.body.jobId,
      actor: 'remote',
      deviceId: node.deviceId,
      deviceName: node.device?.name ?? node.deviceId,
      direction: 'in',
      auditPath: cwd,
    })
    return { protocol: PROTOCOL_VERSION, deviceId: identity.deviceId, deviceName: identity.name, ...result }
  }))

  /**
   * 中止一条正在执行的命令（发起方在本机中止时调用）。
   *
   * 与执行同源的三道门：join 过 → 有执行权 → 命令必须是**它自己**发起的。
   * 第三道在 `Executor.cancel` 里按发起方设备 id 判——猜到 id 不等于有权中止。
   */
  registerRoute('route:api-exec-cancel', API.execCancel, inbound('exec/cancel', API.execCancel, async (auth) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    try {
      executor.checkAuthority(node)
    } catch (error) {
      if (error instanceof ExecError) {
        const entry = audit.append({
          deviceId: node.deviceId,
          deviceName: node.device?.name ?? node.deviceId,
          direction: 'in',
          actor: 'remote',
          path: '',
          command: 'exec:cancel',
          outcome: 'denied',
          code: error.code,
          exitCode: null,
          durationMs: 0,
          error: error.message,
        })
        throw new HttpError(error.status, error.message, error.code, { auditId: entry.id })
      }
      throw error
    }
    const jobId = typeof auth.body.jobId === 'string' ? auth.body.jobId : ''
    const outcome = executor.cancel(jobId, node.deviceId)
    // 每一次 cancel 尝试都进审计：中止是一条**会影响对端进程**的动作，
    // 它成没成、被谁发的，都必须留痕（和失败审计比成功审计更有价值同一条理由）。
    const entry = audit.append({
      deviceId: node.deviceId,
      deviceName: node.device?.name ?? node.deviceId,
      direction: 'in',
      actor: 'remote',
      path: '',
      command: `exec:cancel ${jobId}`.slice(0, config.execAuditCommandLimit),
      outcome: outcome.ok ? 'ok' : 'denied',
      code: outcome.ok ? null : outcome.code,
      exitCode: null,
      durationMs: 0,
      error: null,
    })
    return { protocol: PROTOCOL_VERSION, jobId, cancelled: outcome.ok, code: outcome.ok ? null : outcome.code, auditId: entry.id }
  }))

  /**
   * 入站路由要求「已经 join 过」，否则对端应当重新 join。
   * @param {{node: object|null}} auth 认证结果。
   * @returns {object} 节点记录。
   * @throws {HttpError} 404 unknown-node。
   */
  const requireNode = (auth) => {
    if (auth.node === null) {
      throw new HttpError(404, '本机没有该设备的接入记录，请重新 join', CODE.unknownNode)
    }
    return auth.node
  }

  /**
   * 会话历史镜像（会话端 → 执行端）。
   *
   * 门与 exec / fs **同源**（join 过 → 有执行权 → 路径在导出范围内），只多一条
   * 语义约束：`workspacePath` 必须是**本机自己的**工作区路径 —— 镜像只能落进本机
   * 认领的工作区，不能借它往任意目录写文件。
   *
   * 落地是**只存储**：写进 `session-replica/`，不创建会话、不跑 agent、不进
   * workspaceRegistry（详见 session-mirror.js 头注释「为什么不用 DSH 自己的 sessions/」）。
   */
  registerRoute('route:api-session-mirror', API.sessionMirror, inbound('session-mirror', API.sessionMirror, async (auth) => {
    const node = requireNode(auth)
    if (!config.sessionMirror) throw new HttpError(403, '本机未开启会话历史镜像接收', CODE.execDisabled)
    executor.checkAuthority(node)
    const workspacePath = typeof auth.body.workspacePath === 'string' ? auth.body.workspacePath : ''
    if (workspacePath !== '') executor.checkFsPath(workspacePath)
    nodes.touch(node.deviceId, { now: Date.now() })
    const stored = replicas.append({
      deviceId: node.deviceId,
      sessionId: auth.body.sessionId,
      sourceDeviceName: node.device?.name ?? node.deviceId,
      workspacePath,
      workspaceTitle: auth.body.workspaceTitle,
      header: auth.body.header,
      events: auth.body.events,
      fromSeq: auth.body.fromSeq,
      toSeq: auth.body.toSeq,
      reset: auth.body.reset === true,
    })
    // 这一批里有 `turn/end`（一次运行结束）→ 排一次同步：把上下文落到本机 `sessions/`。
    // 排的是**定时器**，不在入站请求里做重压（几 MB 的 zstd 重压不该卡住对端的推送）。
    if (stored.syncWanted === true) scheduleSync(auth.body.sessionId)
    return { protocol: PROTOCOL_VERSION, deviceId: identity.deviceId, ...stored }
  }))
  // ── 会话状态权威（P2）────────────────────────────────────────────────────
  // 模型（用户确认）：工作区有属主/执行侧与会话侧；**所有会话行为先送权威判定，
  // 结果回来后才由会话侧应用**。这里落「归档/恢复」状态面：权威维护
  // session-state.json（版本 + 每会话归档态 + 审计）；副本 propose 先转发权威、
  // 拿回执才本地应用；副本周期拉权威全量状态覆盖本地分叉（权威赢）。
  // 传输层已对每个设备 API 请求强制「令牌 + timestamp+nonce+HMAC 签名」，
  // 应用层再叠加 executor.checkAuthority 与 ts/nonce 审计。
  const SESSION_ID_OK = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const stateFile = path.join(meshDir, 'session-state.json')
  let sessionState = null

  const loadSessionState = () => {
    if (sessionState !== null) return sessionState
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      sessionState = {
        version: Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : 1,
        sessions: raw.sessions !== null && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {},
        log: Array.isArray(raw.log) ? raw.log.slice(-200) : [],
      }
    } catch {
      sessionState = { version: 1, sessions: {}, log: [] }
    }
    reconcileAuthorityState(true)
    return sessionState
  }

  /** 以注册表为准重建 sessions（权威侧的意义；副本侧无害）。 */
  function reconcileAuthorityState(initial) {
    if (sessionState === null) return
    const registry = ctx.get('workspaceRegistry')
    const stored = Array.isArray(registry?.state?.archivedSessionIds) ? registry.state.archivedSessionIds.map(String) : []
    const next = {}
    for (const id of stored) next[id] = sessionState.sessions[id] ?? { archived: true, at: Date.now(), by: initial ? 'initial' : 'reconcile' }
    sessionState.sessions = next
  }

  const saveSessionState = () => {
    try {
      writeJsonAtomic(stateFile, sessionState)
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: session-state 落盘失败：${errorText(error)}`)
    }
  }

  /**
   * 唯一的归档集写路径（与 dsh-archived-sessions 的恢复同款）：只改
   * archivedSessionIds，不碰域记录其它字段。
   * @param {string} sessionId 会话 id。
   * @param {boolean} archived 目标态。
   */
  const applyArchiveState = async (sessionId, archived) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.setState !== 'function' || registry.state === undefined || typeof registry.state !== 'object') {
      throw new HttpError(503, 'workspaceRegistry 未暴露写入路径（setState），无法应用会话状态', CODE.internal)
    }
    const current = registry.state
    const stored = Array.isArray(current.archivedSessionIds) ? current.archivedSessionIds.map(String) : []
    if (stored.includes(sessionId) === archived) return { changed: false, archivedSessionIds: stored }
    const archivedSessionIds = archived ? [...stored, sessionId] : stored.filter((id) => id !== sessionId)
    await registry.setState(Object.assign({}, current, { archivedSessionIds }))
    const after = Array.isArray(registry.state.archivedSessionIds) ? registry.state.archivedSessionIds.map(String) : []
    if (after.includes(sessionId) !== archived) {
      throw new HttpError(500, '归档集写入后与期望不一致，请重试', CODE.internal)
    }
    return { changed: true, archivedSessionIds: after }
  }

  /** 与 /tree 的 authority 解析同一套规则（P1）。 */
  const resolveAuthority = () => {
    const tree = buildTree({ scope: 'full', now: Date.now() })
    const selfDevice = (tree.devices ?? []).find((d) => d.self === true)
    const self = { deviceId: selfDevice?.deviceId ?? identity.deviceId, name: selfDevice?.name ?? '' }
    const wanted = typeof config.sessionAuthority === 'string' ? config.sessionAuthority.trim() : ''
    if (wanted === '') return { ...self, isSelf: true, configured: false, tree }
    if (wanted === self.deviceId || wanted === self.name) return { ...self, isSelf: true, configured: true, tree }
    const peer = (tree.devices ?? []).find((d) => d.self !== true && (d.deviceId === wanted || d.name === wanted))
    if (peer === undefined) return { ...self, isSelf: true, configured: false, unresolved: wanted, tree }
    return { deviceId: peer.deviceId, name: peer.name, isSelf: false, configured: true, tree }
  }

  const pushStateLog = (entry) => {
    sessionState.log.push({ at: Date.now(), ...entry })
    sessionState.log = sessionState.log.slice(-200)
  }

  // 设备 API：权威接收动作（副本转发而来）
  registerRoute('route:api-session-state-action', API.sessionStateAction, inbound('session-state/action', API.sessionStateAction, async (auth) => {
    const node = requireNode(auth)
    executor.checkAuthority(node)
    nodes.touch(node.deviceId, { now: Date.now() })
    const body = auth.body ?? {}
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const action = body.action === 'archive' ? 'archive' : body.action === 'unarchive' ? 'unarchive' : ''
    if (!SESSION_ID_OK.test(sessionId) || action === '') {
      throw new HttpError(400, '需要合法的 sessionId 与 action(archive|unarchive)', CODE.badRequest)
    }
    const authority = resolveAuthority()
    if (!authority.isSelf) {
      throw new HttpError(409, `本机不是会话状态权威（权威是 ${authority.name || authority.deviceId}）`, CODE.conflict)
    }
    loadSessionState()
    const result = await applyArchiveState(sessionId, action === 'archive')
    reconcileAuthorityState()
    sessionState.sessions[sessionId] = { archived: action === 'archive', at: Date.now(), by: node.deviceId }
    sessionState.version += 1
    pushStateLog({ kind: 'action', by: node.deviceId, byName: node.device?.name ?? node.deviceId, sessionId, action, ts: body.ts ?? null, nonce: body.nonce ?? null })
    saveSessionState()
    return { protocol: PROTOCOL_VERSION, deviceId: identity.deviceId, ok: true, role: 'authority', version: sessionState.version, sessionId, archived: action === 'archive', changed: result.changed }
  }))

  // 设备 API：副本拉权威全量状态
  registerRoute('route:api-session-state-fetch', API.sessionStateFetch, inbound('session-state-fetch', API.sessionStateFetch, async (auth) => {
    const node = requireNode(auth)
    executor.checkAuthority(node)
    nodes.touch(node.deviceId, { now: Date.now() })
    loadSessionState()
    reconcileAuthorityState()
    return { protocol: PROTOCOL_VERSION, deviceId: identity.deviceId, ok: true, role: 'authority', version: sessionState.version, sessions: sessionState.sessions }
  }))

  /**
   * 副本侧周期同步：拉权威状态并覆盖本地分叉。权威不可达就等下一轮。
   * 本地比权威**多**的归档（权威掉线期间的降级本地应用）会被撤掉 —— 权威赢。
   */
  const syncSessionStateOnce = async () => {
    const authority = resolveAuthority()
    if (authority.isSelf) return
    loadSessionState()
    const before = JSON.stringify(Object.keys(sessionState.sessions).sort())
    const { json } = await caller.request({
      deviceId: authority.deviceId,
      targetPath: '/',
      route: API.sessionStateFetch,
      body: { since: sessionState.version },
      timeoutMs: config.requestTimeoutMs,
    })
    if (json?.ok !== true || !Number.isSafeInteger(json.version)) return
    const remote = json.sessions ?? {}
    for (const [id, entry] of Object.entries(remote)) {
      if (entry?.archived !== true) continue
      const registry = ctx.get('workspaceRegistry')
      const stored = new Set(Array.isArray(registry?.state?.archivedSessionIds) ? registry.state.archivedSessionIds.map(String) : [])
      if (!stored.has(id)) await applyArchiveState(id, true)
    }
    const remoteSet = new Set(Object.keys(remote))
    for (const id of Object.keys(sessionState.sessions)) {
      if (remoteSet.has(id)) continue
      const registry = ctx.get('workspaceRegistry')
      const stored = new Set(Array.isArray(registry?.state?.archivedSessionIds) ? registry.state.archivedSessionIds.map(String) : [])
      if (stored.has(id)) await applyArchiveState(id, false)
    }
    const after = JSON.stringify(Object.keys(remote).sort())
    sessionState.sessions = remote
    sessionState.version = json.version
    if (after !== before) pushStateLog({ kind: 'sync', from: authority.name || authority.deviceId, version: json.version, count: Object.keys(remote).length })
    saveSessionState()
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      syncSessionStateOnce().catch(() => {})
    }, Math.max(5000, config.stateSyncIntervalMs ?? 30000))
    return () => clearInterval(timer)
  }, 'dsh-device-mesh: session-state sync')


  // ── 浏览器侧路由 ──────────────────────────────────────────────────────────

  /**
   * 浏览器侧处理器的统一包装：同源守卫 + 方法白名单 + 异常翻译。
   * @param {string} label 诊断标签。
   * @param {string[]} methods 允许的方法。
   * @param {(req: object) => Promise<object|undefined>} fn 业务。
   * @returns {Function} 处理器。
   */
  const browser = (label, methods, fn) => async (req, res) => {
    if (!methods.includes(req.method ?? 'GET')) {
      return json(res, 405, { ok: false, error: 'Method Not Allowed', code: CODE.notFound })
    }
    if (!sameOrigin(req)) {
      deniedRequests += 1
      return json(res, 403, { ok: false, error: 'cross-origin request rejected', code: CODE.badRequest })
    }
    try {
      const raw = methods.includes('POST') ? await readRawBody(req, Math.min(config.maxBodyBytes, 1024 * 1024)) : Buffer.alloc(0)
      const body = raw.length === 0 ? {} : parseJsonBody(raw)
      const value = await fn(body, req)
      if (res.writableEnded === true) return undefined
      return json(res, 200, { ok: true, ...(value ?? {}) })
    } catch (error) {
      const { status, payload } = failureOf(error)
      if (status >= 500) {
        counters.lastError = { at: new Date().toISOString(), route: label, error: errorText(error) }
        logger?.warn?.(`dsh-device-mesh: ${label} 失败：${errorText(error)}`)
      }
      return json(res, status, payload)
    }
  }

  /**
   * 把本机工作区同步进路径账目。
   *
   * 只为「有名称可展示」的本机工作区建立 group —— 主路径本身**不写进账目**
   * （那是出厂权威，本插件只读派生），这里建的是一条空 group，等着挂附加路径。
   * 每次调用都是幂等的，且**不落盘**（ensure 对已存在的 group 只更新标题快照，
   * 新建空 group 才落一次）—— 所以它不会因为「每次 /tree 都跑」而磨损磁盘。
   * @returns {void}
   */
  const syncLocalGroups = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return
    try {
      for (const workspace of registry.list() ?? []) {
        const workspaceId = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
        if (workspaceId === '') continue
        pathTable.ensure({
          homeDeviceId: identity.deviceId,
          workspaceId,
          workspaceTitle: typeof workspace.title === 'string' ? workspace.title : '',
        })
      }
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 同步本机工作区到路径账目失败：${errorText(error)}`)
    }
  }

  /**
   * 给远端设备清单标注「与本机工作区的重合」。
   *
   * 为什么必须由 host 做：客户端拿不到出厂 workspaceRegistry（插件只能拿到槽位与
   * 自己注册的服务），而「同一个工作区」的判据恰恰在本机注册表里。host 读一次
   * 注册表，按 id / 路径两种口径判重合，再把结论随 /tree 下发。
   *
   * 判据（保守，宁可标重也不要漏标）：
   *   · 同 workspaceId —— 同一份工作区的克隆（本项目的实际情况）；
   *   · 同 path —— id 不同但目录相同（对端另建了工作区指向同一目录）。
   * 会话级只标 `presentLocally`：本机注册表**已经列了这个 session id** —— 出厂
   * 侧边栏画的就是这份账目，所以标了就等于「侧边栏已经有这一行」。
   *
   * 不原地改缓存里的清单对象：`inventory.current()` 与 nodes 的记录都是共享快照，
   * 原地加字段会顺着镜像泄漏给对端，也会让「陈旧快照」带上本次调用的痕迹。
   * @param {object[]} devices buildTree 已组装好的设备列表（会被就地替换 inventory）。
   * @returns {void}
   */
  const annotateLocalOverlap = (devices) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return
    /** @type {Map<string, {id:string,title:string,path:string,sessions:Set<string>}>} */
    const localById = new Map()
    /** @type {Map<string, string>} 规范化路径 → workspaceId。 */
    const localByPath = new Map()
    try {
      for (const workspace of registry.list() ?? []) {
        const id = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
        if (id === '') continue
        const path = typeof workspace.path === 'string' ? workspace.path : ''
        const record = {
          id,
          title: typeof workspace.title === 'string' ? workspace.title : '',
          path,
          sessions: new Set(Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []),
        }
        localById.set(id, record)
        if (path !== '') localByPath.set(path, id)
      }
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 读本机工作区注册表失败，跳过重合标注：${errorText(error)}`)
      return
    }
    if (localById.size === 0) return
    for (const entry of devices) {
      if (entry.self === true) continue
      const inventory = entry.inventory
      const workspaces = inventory?.workspaces
      if (!Array.isArray(workspaces) || workspaces.length === 0) continue
      let touched = false
      const next = workspaces.map((workspace) => {
        if (workspace === null || typeof workspace !== 'object') return workspace
        const id = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
        const path = typeof workspace.path === 'string' ? workspace.path : ''
        const hit = localById.get(id)
          ?? (path !== '' ? localById.get(localByPath.get(path) ?? '') : undefined)
        if (hit === undefined) return workspace
        touched = true
        const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : []
        return {
          ...workspace,
          localMatch: { workspaceId: hit.id, title: hit.title, path: hit.path },
          sessions: sessions.map((session) => (
            session !== null && typeof session === 'object' && hit.sessions.has(String(session.id ?? ''))
              ? { ...session, presentLocally: true }
              : session
          )),
        }
      })
      if (touched) entry.inventory = { ...inventory, workspaces: next }
    }
  }

  /**
   * 这台设备上的路径能不能被本机执行到。
   *
   * 判据和 Caller 完全一致（self 或直连接入点），**刻意共用同一套判定** ——
   * 如果 UI 说「可达」而执行时说「不可达」，用户只会认为功能坏了。
   * @param {string} deviceId 设备。
   * @returns {boolean} 是否可达。
   */
  const isReachable = (deviceId) => {
    if (deviceId === identity.deviceId) return true
    return links.all().some((link) => link.hubDevice?.deviceId === deviceId && link.enabled)
  }

  /**
   * 组装工作区多路径视图。
   *
   * 主路径的来源按 group 的 homeDeviceId 分流（见 paths.js 头注释）：
   *   本机 group  → 实时读 workspaceRegistry，路径与存在性都是当下事实；
   *   远端 group  → 用账目里的快照，`fromLiveRegistry` 为 null（本机无从核验，**不猜**）。
   * @param {object[]} devices 已组装好的设备列表（用来取名与取路径兜底）。
   * @returns {object[]} PathGroupView 列表。
   */
  const buildPathGroups = (devices) => {
    syncLocalGroups()
    const registry = ctx.get('workspaceRegistry')
    /** @type {Map<string, object>} 本机工作区 id → workspace 实体。 */
    const localWorkspaces = new Map()
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list() ?? []) {
          const workspaceId = typeof workspace.id === 'string' ? workspace.id : String(workspace.id ?? '')
          if (workspaceId !== '') localWorkspaces.set(workspaceId, workspace)
        }
      } catch {
        // 读不到就当没有本机工作区：主路径退化成账目快照，UI 会标 primaryStale。
      }
    }
    const deviceName = (deviceId) => devices.find((entry) => entry.deviceId === deviceId)?.name ?? deviceId

    const groups = []
    for (const group of pathTable.all()) {
      const isLocalHome = group.homeDeviceId === identity.deviceId
      const live = isLocalHome ? localWorkspaces.get(group.workspaceId) : undefined
      const livePath = typeof live?.path === 'string' && live.path !== '' ? live.path : null
      const snapshotPath = group.primaryPath
      const primaryPath = livePath ?? snapshotPath ?? ''
      // 本机 group 但工作区已从出厂注册表消失 = orphan：账目还在、工作区没了。
      // 如实标注而不是删掉它 —— 删掉会连带丢掉用户挂的附加路径。
      const orphan = isLocalHome && live === undefined && localWorkspaces.size > 0
      groups.push({
        id: group.id,
        homeDeviceId: group.homeDeviceId,
        workspaceId: group.workspaceId,
        workspaceTitle: group.workspaceTitle
          || (typeof live?.title === 'string' ? live.title : '')
          || primaryPath
          || group.workspaceId,
        orphan,
        primary: {
          deviceId: group.homeDeviceId,
          deviceName: deviceName(group.homeDeviceId),
          path: primaryPath,
          // 语义是「主路径来自**本机注册表的实时读取**」，**不是**「这个目录存在」。
          // 曾经叫 `exists`，害得人（包括本插件的作者）据此推断「对端确实有这个目录」——
          // 远端路径根本不经本机核验，改名字就是为了让这个误读不可能发生。
          fromLiveRegistry: isLocalHome ? livePath !== null : null,
          local: isLocalHome,
          // 快照来源 = 本机无法实时核验（远端 group，或本机工作区已消失）。
          stale: livePath === null && snapshotPath !== null,
        },
        members: group.members.map((member) => ({
          id: member.id,
          deviceId: member.deviceId,
          deviceName: deviceName(member.deviceId),
          path: member.path,
          role: member.role,
          label: member.label,
          createdAt: member.createdAt,
          prefer: member.prefer === true,
          local: member.deviceId === identity.deviceId,
          reachable: isReachable(member.deviceId),
        })),
      })
    }
    groups.sort((a, b) => a.workspaceTitle.localeCompare(b.workspaceTitle))
    return groups
  }

  /**
   * Caller 的目标解析上下文。
   *
   * 每次都现建：`buildTree` 是纯内存拼装（清单来自缓存、节点来自注册表），
   * 缓存住它反而会产生「刚改的附加路径不生效」这种说不清的行为。
   * 调用方**必须**先 `await inventory.get({})` 热一下清单，否则本机设备条目
   * 的 `inventory` 会是 null，主路径就解析不出来。
   * @returns {{devices: object[], groups: object[]}} 上下文。
   */
  const buildContext = () => {
    const devices = buildTree({ scope: 'full', now: Date.now() }).devices
    return { devices, groups: buildPathGroups(devices) }
  }

  /**
   * 给 UI 的下拉框用的设备选项（只含选择所需字段，不带整份清单）。
   * @param {object[]} devices 设备列表。
   * @returns {object[]} 选项。
   */
  const deviceOptions = (devices) => devices.map((entry) => ({
    deviceId: entry.deviceId,
    name: entry.name,
    self: entry.self === true,
    liveness: entry.liveness,
    // 可达 = 能不能把命令送过去。UI 用它决定执行入口是禁用还是可点。
    reachable: isReachable(entry.deviceId),
    canExec: Array.isArray(entry.device?.capabilities) && entry.device.capabilities.includes('remote-exec'),
    workspaceCount: entry.inventory?.workspaces?.length ?? 0,
    sessionCount: entry.inventory?.totals?.sessions ?? 0,
  }))

  /**
   * 在**所有设备**的清单里按 workspaceId 找工作区。
   *
   * 跨设备是必需的：「给工作区加一条在另一台设备上的路径」这个动作里，工作区本身
   * 可能属于远端设备（本机通过接入点或接入节点看到它）。只在本机工作区里找会让
   * 一半的合法用法报 404。
   * @param {unknown} workspaceId 出厂工作区标识。
   * @returns {{homeDeviceId: string, workspace: object}|undefined} 命中。
   */
  const findWorkspaceInContext = (workspaceId) => {
    const target = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (target === '') return undefined
    const devices = buildContext().devices
    const lower = target.toLowerCase()
    // 先按 id 精确找，再按标题精确找，最后按标题包含找。
    // 只认 id 是不够的：调用方（模型或人）在列表里看到的是标题，
    // 「id 写错一个字符就静默挂到别的工作区上」是必须避免的失败方式
    // —— 实测确实发生过（把附加路径挂到了另一个工作区）。
    for (const entry of devices) {
      for (const workspace of entry.inventory?.workspaces ?? []) {
        if (workspace.id === target) return { homeDeviceId: entry.deviceId, workspace }
      }
    }
    for (const entry of devices) {
      for (const workspace of entry.inventory?.workspaces ?? []) {
        if (String(workspace.title ?? '').toLowerCase() === lower) return { homeDeviceId: entry.deviceId, workspace }
      }
    }
    for (const entry of devices) {
      for (const workspace of entry.inventory?.workspaces ?? []) {
        if (String(workspace.title ?? '').toLowerCase().includes(lower)) return { homeDeviceId: entry.deviceId, workspace }
      }
    }
    return undefined
  }

  /**
   * 组装三级总览。
   *
   * 三类来源合并成一张**扁平设备表**，每条带 `via` 说明来路；同一台设备通过多条
   * 路径可见时保留最直接的那条（self > inbound > outbound），并在 `alsoVia` 里
   * 如实列出其余路径 —— 而不是静默去重，那样会让人以为网格里少了一台设备。
   * @param {{scope: 'direct'|'full', now: number}} options scope=direct 时只含本机 + 接入节点（给对端做镜像用）。
   * @returns {object} 总览。
   */
  const buildTree = (options) => {
    const now = options.now ?? Date.now()
    const local = inventory.current()
    /** @type {Map<string, object>} deviceId → 设备节点。 */
    const table = new Map()

    // ① 本机
    table.set(identity.deviceId, {
      deviceId: identity.deviceId,
      name: identity.name,
      self: true,
      trust: 'inventory',
      note: '',
      via: { kind: 'self', label: '本机' },
      alsoVia: [],
      liveness: 'online',
      lastSeenAt: new Date(now).toISOString(),
      joinedAt: null,
      device: device(),
      inventory: local,
      inventoryStale: local === null,
    })

    // ② 接入本机的节点
    for (const record of nodes.list()) {
      if (record.deviceId === identity.deviceId) continue
      const age = now - Date.parse(record.lastSeenAt)
      table.set(record.deviceId, {
        deviceId: record.deviceId,
        name: record.note !== '' ? record.note : (record.device?.name ?? record.deviceId),
        self: false,
        trust: record.trust,
        note: record.note,
        via: { kind: 'inbound', label: '接入本机', tokenId: record.tokenId, nodeId: record.nodeId },
        alsoVia: [],
        liveness: livenessOf(age, config),
        lastSeenAt: record.lastSeenAt,
        joinedAt: record.joinedAt,
        device: record.device,
        inventory: record.inventory,
        inventoryStale: record.inventory === null,
      })
    }

    // ③ 出站接入点（以及它们的一跳总览镜像）
    if (options.scope !== 'direct') {
      for (const link of links.all()) {
        const mirror = mirrors.get(link.id)
        const hubDevice = link.hubDevice ?? mirror?.hub ?? null
        const hubId = typeof hubDevice?.deviceId === 'string' ? hubDevice.deviceId : null
        const hubAge = link.lastPushAt === null || link.lastPushAt === undefined
          ? Number.POSITIVE_INFINITY
          : now - Date.parse(link.lastPushAt)
        if (hubId !== null && hubId !== identity.deviceId) {
          mergeDevice(table, {
            deviceId: hubId,
            name: hubDevice.name ?? hubId,
            self: false,
            trust: 'inventory',
            note: '',
            via: { kind: 'outbound', label: `经接入点 ${link.label}`, linkId: link.id, url: link.url },
            alsoVia: [],
            liveness: link.state === 'joined' ? 'online' : (Number.isFinite(hubAge) ? livenessOf(hubAge, config) : 'unknown'),
            lastSeenAt: link.lastPushAt,
            joinedAt: link.lastJoinAt,
            device: hubDevice,
            inventory: mirror?.inventory ?? null,
            inventoryStale: mirror?.inventory === undefined || mirror?.inventory === null,
          })
        }
        // 镜像里的其它设备：一跳之内可见，但**不再往外传**（scope=full 才合并）。
        for (const mirrored of mirror?.devices ?? []) {
          if (mirrored.deviceId === identity.deviceId) continue
          const isHubItself = hubId !== null && mirrored.deviceId === hubId
          if (isHubItself) continue
          mergeDevice(table, {
            ...mirrored,
            self: false,
            via: {
              kind: 'outbound',
              label: mirrored.via?.kind === 'inbound'
                ? `经 ${mirror?.hubName ?? link.label} 接入`
                : `经接入点 ${link.label}`,
              linkId: link.id,
              url: link.url,
              hubDeviceId: hubId,
            },
            alsoVia: [],
          })
        }
      }
    }

    const devices = [...table.values()].sort(deviceSort)

    // 同一份工作区在两台机器上都有一份（工作区账目是按设备克隆的）时，侧边栏会把
    // 同一个工作区列两遍、同一批会话也列两遍。这里给**远端**清单打上重合标记，
    // 让 UI 合流：工作区级 `localMatch`（同 id 或同路径），会话级 `presentLocally`
    // （本机注册表里已经有这个 session id）。scope=direct（推给对端的镜像）不打：
    // 对端拿它没用，而且会把本机账目泄漏出去。
    if (options.scope !== 'direct') annotateLocalOverlap(devices)

    // 工作区多路径：只挂在**主路径所属设备**的节点上（谁的账谁展示），
    // 这样 UI 上「工作区 → 附加路径」就落在同一台设备的展开区里，不必跨设备翻。
    // scope=direct（给对端做镜像）时也带上 —— 附加路径是清单的一部分语义，
    // 对端看得见才能据此决定去哪执行（执行本身仍然只走一跳）。
    const groups = buildPathGroups(devices)
    for (const entry of devices) {
      entry.paths = groups.filter((group) => group.homeDeviceId === entry.deviceId)
    }

    return {
      schema: 1,
      scope: options.scope ?? 'full',
      generatedAt: new Date(now).toISOString(),
      protocol: PROTOCOL_VERSION,
      meshVersion: MESH_VERSION,
      selfDeviceId: identity.deviceId,
      devices,
      pathGroups: groups,
      summary: {
        devices: devices.length,
        online: devices.filter((entry) => entry.liveness === 'online').length,
        stale: devices.filter((entry) => entry.liveness === 'stale').length,
        offline: devices.filter((entry) => entry.liveness === 'offline').length,
        workspaces: devices.reduce((sum, entry) => sum + (entry.inventory?.workspaces?.length ?? 0), 0),
        sessions: devices.reduce((sum, entry) => sum + (entry.inventory?.totals?.sessions ?? 0), 0),
        sessionsListed: devices.reduce((sum, entry) => sum + (entry.inventory?.totals?.listed ?? 0), 0),
        links: links.all().length,
        hostedNodes: nodes.list().length,
        inboundEnabled: config.allowInbound,
        authRequired: config.requireToken,
        remoteExec: config.allowRemoteExec,
        pathMembers: groups.reduce((sum, group) => sum + group.members.length, 0),
      },
    }
  }

  /**
   * 合并一台设备：已存在时不覆盖，只记一条 `alsoVia`（多余路径如实展示）。
   * @param {Map<string, object>} table 设备表。
   * @param {object} entry 设备条目。
   * @returns {void}
   */
  const mergeDevice = (table, entry) => {
    const existing = table.get(entry.deviceId)
    if (existing === undefined) {
      table.set(entry.deviceId, entry)
      return
    }
    // 有清单的那一份更有用：镜像里同一个 deviceId 可能两份，一份只有描述。
    if (existing.inventory === null && entry.inventory !== null) {
      table.set(entry.deviceId, { ...entry, alsoVia: [...(existing.alsoVia ?? []), existing.via] })
      return
    }
    existing.alsoVia = [...(existing.alsoVia ?? []), entry.via]
  }

  /**
   * 组装 `computeDrivers` 的输入。
   *
   * 判定的四路依据分别来自：已经拼好的 `/tree`（对端清单与主路径属主）、配置里的
   * `workspaceRoles` 声明、本机的**会话镜像索引**（只有转发执行的会话才会被镜像）、
   * 本机的**入站执行审计**（`direction=in`，证明命令真的发到过本机）。
   *
   * 审计按**尾部有界读**（默认 256 KB）：文件上限 8 MB，而 `/tree` 每 15 s 被轮询
   * 一次，整份读会把「看一眼有没有人来发命令」变成持续的垃圾 IO。审计关掉时没有
   * 落盘文件可读，回落到内存里的最近条目。
   * @param {object} tree buildTree 的结果。
   * @returns {object} computeDrivers 的输入。
   */
  const driverInput = (tree) => {
    const selfDevice = (tree.devices ?? []).find((entry) => entry.self === true)
    return {
      self: { deviceId: selfDevice?.deviceId ?? identity.deviceId, name: selfDevice?.name ?? identity.name },
      devices: tree.devices,
      pathGroups: tree.pathGroups,
      roles: config.workspaceRoles,
      replicas: [...replicas.index.values()],
      ...(config.execAudit === true
        ? { auditFile: audit.file }
        : { auditEntries: audit.tail(200).entries }),
      now: Date.now(),
    }
  }

  registerRoute('route:tree', UI.tree, browser('tree', ['GET'], async () => {
    // **每次都走一遍缓存**（TTL 内直接复用），而不是只在 `current() === null` 时
    // 采一次 —— 后者在「没配任何出站接入点」时会让清单冻在第一次采集的结果上，
    // 面板永远显示一份不会更新的会话列表。
    //
    // 有快照时用「先返回旧数据、后台刷新」（stale-while-revalidate）：一次冷采集
    // 要 ~3 s（大头是标题日志折叠的时间预算），把它放在浏览器请求的关键路径上，
    // 每次轮询都会卡三秒。只有**第一次**（还没有任何快照）才值得等。
    if (inventory.current() === null) await inventory.get({})
    else inventory.kick()
    const tree = buildTree({ scope: 'full', now: Date.now() })
    // P1：多机会话列表权威。sessionAuthority 指到的设备是所有会话行为的判定方；
    // 本机不是它 → 本机是副本侧（会话行为先送权威、结果回来才应用），标注才有意义。
    // 配置为空/解析不出来 → 本机即权威（老行为：不标注、动作本地直落）。
    const authority = (() => {
      const selfDevice = (tree.devices ?? []).find((d) => d.self === true)
      const selfId = selfDevice?.deviceId ?? ''
      const selfName = selfDevice?.name ?? ''
      const self = { deviceId: selfId, name: selfName, isSelf: true }
      const wanted = typeof config.sessionAuthority === 'string' ? config.sessionAuthority.trim() : ''
      if (wanted === '') return { ...self, configured: false }
      if (wanted === selfId || wanted === selfName) return { ...self, configured: true }
      const peer = (tree.devices ?? []).find((d) => d.self !== true && (d.deviceId === wanted || d.name === wanted))
      if (peer === undefined) return { ...self, configured: false, unresolved: wanted }
      return { deviceId: peer.deviceId, name: peer.name, isSelf: false, configured: true }
    })()
    // authority 必须嵌在 tree 里：客户端拿到的就是内层 tree（tree.devices 那层），
    // 放顶层它读不到（实测过一次，标注因此全灭）。
    //
    // 顺带带上远端会话驱动检测（drivers）：执行端要标的是「这个工作区的会话在远端
    // 执行、命令会发到本机」。它与 `/dsh-device-mesh/drivers` **同源**（同一个函数、
    // 同一份输入），所以不会出现两个路由两个结论。
    const drivers = computeDrivers(driverInput(tree))
    return { tree: { ...tree, authority, drivers }, problems }
  }))
  registerRoute('route:drivers', UI.drivers, browser('drivers', ['GET'], async () => {
    // 单独一条路由的目的：用 curl 就能核对判定，不必在 700 KB 的 /tree 里翻。
    if (inventory.current() === null) await inventory.get({})
    else inventory.kick()
    const tree = buildTree({ scope: 'full', now: Date.now() })
    return { ok: true, ...computeDrivers(driverInput(tree)), problems }
  }))
  registerRoute('route:session-state', UI.sessionState, browser('session-state', ['GET'], async () => {
    const authority = resolveAuthority()
    loadSessionState()
    reconcileAuthorityState()
    return {
      ok: true,
      role: authority.isSelf ? 'authority' : 'replica',
      authority: { deviceId: authority.deviceId, name: authority.name, isSelf: authority.isSelf, configured: authority.configured },
      version: sessionState.version,
      archivedIds: Object.keys(sessionState.sessions).filter((id) => sessionState.sessions[id]?.archived === true).sort(),
      log: sessionState.log.slice(-10),
    }
  }))

  registerRoute('route:session-state-propose', `${UI.sessionState}/propose`, browser('session-state/propose', ['POST'], async (body) => {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const action = body.action === 'archive' ? 'archive' : body.action === 'unarchive' ? 'unarchive' : ''
    if (!SESSION_ID_OK.test(sessionId) || action === '') {
      throw new HttpError(400, '需要合法的 sessionId 与 action(archive|unarchive)', CODE.badRequest)
    }
    const authority = resolveAuthority()
    loadSessionState()
    const ts = Date.now()
    const nonce = `${identity.deviceId}-${ts}-${Math.random().toString(16).slice(2, 10)}`

    if (authority.isSelf) {
      const result = await applyArchiveState(sessionId, action === 'archive')
      reconcileAuthorityState()
      sessionState.sessions[sessionId] = { archived: action === 'archive', at: ts, by: 'local-browser' }
      sessionState.version += 1
      pushStateLog({ kind: 'propose', by: 'local-browser', sessionId, action })
      saveSessionState()
      return { ok: true, role: 'authority', applied: true, version: sessionState.version, sessionId, archived: action === 'archive', changed: result.changed }
    }

    // 副本侧：先送权威，拿到回执才本地应用；权威不可达时降级本地应用
    // （可用性优先；周期同步会向权威收敛 —— 权威赢）。
    let receipt = null
    let degraded = null
    try {
      const { json } = await caller.request({
        deviceId: authority.deviceId,
        targetPath: '/',
        route: API.sessionStateAction,
        body: { sessionId, action, actorDeviceId: identity.deviceId, ts, nonce },
        timeoutMs: config.requestTimeoutMs,
      })
      receipt = json
    } catch (error) {
      degraded = errorText(error)
    }
    const result = await applyArchiveState(sessionId, action === 'archive')
    sessionState.sessions[sessionId] = { archived: action === 'archive', at: ts, by: 'local-browser' }
    if (Number.isSafeInteger(receipt?.version)) sessionState.version = receipt.version
    else sessionState.version += 1
    pushStateLog({ kind: 'propose', by: 'local-browser', sessionId, action, forwarded: true, receiptVersion: receipt?.version ?? null, degraded })
    saveSessionState()
    return {
      ok: true,
      role: 'replica',
      applied: true,
      authority: { deviceId: authority.deviceId, name: authority.name },
      version: sessionState.version,
      sessionId,
      archived: action === 'archive',
      changed: result.changed,
      degraded,
    }
  }))


  registerRoute('route:status', UI.status, browser('status', ['GET'], async () => ({
    version: VERSION,
    importTag: IMPORT_TAG,
    protocol: PROTOCOL_VERSION,
    meshVersion: MESH_VERSION,
    enabled: config.enabled,
    startedAt,
    device: device(),
    identityCreated: created,
    meshDir,
    problems,
    config,
    capabilities: {
      inbound: config.allowInbound,
      outbound: true,
      tokenAuth: config.requireToken,
      mirror: true,
      remoteExec: config.allowRemoteExec,
      // 「能不能中止对端正在跑的命令」与「能不能真的后台跑」是两件**独立**的能力，
      // 分开如实声明：远端后台这一版做不到（一次性传输没有增量输出），所以恒为 false。
      remoteExecCancel: shellRouting?.stats?.().cancelSupported === true,
      remoteExecBackground: false,
      execTrust: config.execTrust,
      pathGroups: true,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      sessionQuery: ctx.get('sessionQuery') !== undefined,
      projectionCache: ctx.get('sessionProjectionCache') !== undefined,
    },
    inbound: { requests: inboundRequests, denied: deniedRequests, replay: replay.stats(), authFailSources: authFailures.size },
    inventory: inventory.stats(),
    egress: egress.stats(),
    tokens: tokens.stats(),
    nodes: nodes.stats(),
    links: links.stats(),
    mirrors: [...mirrors.entries()].map(([linkId, value]) => ({
      linkId,
      at: new Date(value.at).toISOString(),
      hubName: value.hubName,
      devices: Array.isArray(value.devices) ? value.devices.length : 0,
      error: value.error ?? null,
    })),
    paths: pathTable.stats(),
    mirror: { sender: mirrorSender.status(), replicas: replicas.status() },
    // 会话数据同步（执行端）：排了多少次、成功/跳过/失败各多少、最后一次错在哪。
    sync: { enabled: config.sessionSync === true, ...syncCounters },
    // 「路由到底挂上没有」是本插件最容易骗人的一格：`config.routeExecByPath` 可以是
    // true，而 `ctx.shell` / `ctx.fs` 实际仍是出厂实现（provide 撞名时挂载会失败，
    // 而失败只写一条日志——进程的 stdout 未必有人看）。所以**配置意图**与**实际挂载
    // 结果**必须分开报：两者不一致本身就是一条 problem，不是正常状态。
    routing: {
      configured: config.routeExecByPath === true,
      shell: shellRouting?.stats() ?? { ready: false, enabled: false, failure: shellRoutingFailure },
      fs: fsRouting?.stats() ?? { ready: false, enabled: false, failure: fsRoutingFailure },
    },
    exec: executor.stats(),
    audit: audit.stats(),
    caller: caller.stats(),
    // 「我的浏览器半边到底进没进 boot 图？」——这是唯一能从 host 侧回答它的地方。
    // 症状很隐蔽：host 半边一切正常（路由都通），但侧边栏里就是不出现那个按钮，
    // 而且浏览器控制台可能什么都不报。client-modules 的扫描是按**包名**做的
    // （`package.json` 的 name + exports["./client"]），所以这里用同一个包名去问它。
    // 已经进了图但页面没刷新时，inGraph=true 而面板仍然不存在 —— 那正是「去刷新页面」的信号。
    clientModules: (() => {
      const registry = ctx.get('clientModules')
      if (registry === undefined || registry === null || typeof registry.clientPath !== 'function') {
        return { available: false, note: '本进程没有 clientModules（非 Web 部署，或该行未挂载）' }
      }
      try {
        const bundle = registry.clientPath(name)
        return { available: true, inGraph: typeof bundle === 'string', bundle: bundle ?? null }
      } catch (error) {
        return { available: true, inGraph: false, error: errorText(error) }
      }
    })(),
    counters,
  })))

  registerRoute('route:config', UI.config, browser('config', ['GET', 'POST'], async (body, req) => {
    if ((req.method ?? 'GET') === 'GET') {
      return {
        config,
        device: device(),
        storeDir: meshDir,
        defaults: DEFAULTS,
        editable: ['deviceName', 'allowInbound', 'requireToken', 'routeExecByPath', 'includeSubagents', 'includeArchived', 'maxSessionsPerWorkspace', 'allowRemoteExec', 'execTrust'],
      }
    }
    // 只允许改「运行期安全」的几项：端口/路径/存储目录这类改了必须重挂，
    // 不在运行期接口里假装能改（那会让人以为生效了）。
    const applied = {}
    if (body.deviceName !== undefined) {
      const next = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 120) : ''
      if (next === '') throw new HttpError(400, '设备名不能为空', CODE.badRequest)
      identity.name = next
      const written = writeJsonAtomic(`${meshDir}/identity.json`, { ...identity })
      if (!written.ok) throw new HttpError(500, `设备名写盘失败：${written.error}`, CODE.internal)
      applied.deviceName = next
    }
    if (typeof body.allowInbound === 'boolean') {
      config.allowInbound = body.allowInbound
      applied.allowInbound = config.allowInbound
    }
    if (typeof body.requireToken === 'boolean') {
      config.requireToken = body.requireToken
      applied.requireToken = config.requireToken
    }
    if (typeof body.routeExecByPath === 'boolean') {
      // 只是换个判定开关，缓存的东西没变——不需要 inventory.invalidate()。
      // 两半都要切：命令与文件必须同时改变去向，否则会留下「命令在子节点、
      // 文件在主机」这种自相矛盾的中间态。
      config.routeExecByPath = body.routeExecByPath
      applied.routeExecByPath = config.routeExecByPath
      shellRouting?.setEnabled?.(config.routeExecByPath)
      fsRouting?.setEnabled?.(config.routeExecByPath)
    }
    if (typeof body.includeSubagents === 'boolean') {
      config.includeSubagents = body.includeSubagents
      inventory.invalidate()
      applied.includeSubagents = config.includeSubagents
    }
    if (typeof body.includeArchived === 'boolean') {
      config.includeArchived = body.includeArchived
      inventory.invalidate()
      applied.includeArchived = config.includeArchived
    }
    if (typeof body.maxSessionsPerWorkspace === 'number') {
      const next = Math.min(100000, Math.max(1, Math.trunc(body.maxSessionsPerWorkspace)))
      config.maxSessionsPerWorkspace = next
      inventory.invalidate()
      applied.maxSessionsPerWorkspace = next
    }
    // 跨设备执行的两个开关可以运行期改：改了立刻生效，也立刻反映到本机对外声明的
    // capabilities 上（对端下一轮心跳就会看到 remote-exec 的增删）。
    if (typeof body.allowRemoteExec === 'boolean') {
      config.allowRemoteExec = body.allowRemoteExec
      applied.allowRemoteExec = config.allowRemoteExec
      logger?.warn?.(
        `dsh-device-mesh: 跨设备执行已${config.allowRemoteExec ? '开启' : '关闭'}`,
      )
    }
    if (body.execTrust === 'grant-required' || body.execTrust === 'any-authenticated') {
      config.execTrust = body.execTrust
      applied.execTrust = config.execTrust
      if (config.execTrust === 'any-authenticated') {
        logger?.warn?.('dsh-device-mesh: execTrust=any-authenticated —— 任何持有有效令牌的节点都可在本机执行命令')
      }
    }
    logger?.info?.(`dsh-device-mesh: 运行期配置已更新 ${JSON.stringify(applied)}`)
    return { applied, config, device: device() }
  }))

  registerRoute('route:links', UI.links, browser('links', ['GET', 'POST'], async (body, req) => {
    if ((req.method ?? 'GET') === 'GET') return { links: links.list(), running: egress.stats() }
    const action = typeof body.action === 'string' ? body.action : 'upsert'
    if (action === 'upsert') {
      const url = normalizeHubUrl(body.url)
      if (url === null) throw new HttpError(400, '接入点地址必须是 http(s):// 开头的完整 URL', CODE.badRequest)
      if (url.startsWith('http://') && !config.allowInsecureHttp) {
        throw new HttpError(400, '本配置不允许明文 http 接入点（allowInsecureHttp=false）', CODE.badRequest)
      }
      const result = links.upsert({ ...body, url })
      if (!result.ok) throw new HttpError(400, result.error, CODE.badRequest)
      return { link: result.link, links: links.list() }
    }
    if (action === 'remove') {
      const removed = links.remove(String(body.id ?? ''))
      if (!removed) throw new HttpError(404, '接入点不存在', CODE.notFound)
      return { removed: true, links: links.list() }
    }
    if (action === 'enable' || action === 'disable') {
      const next = links.setEnabled(String(body.id ?? ''), action === 'enable')
      if (next === undefined) throw new HttpError(400, '接入点不存在，或尚未填写令牌标识与密钥', CODE.badRequest)
      return { link: next, links: links.list() }
    }
    throw new HttpError(400, `未知动作 ${action}`, CODE.badRequest)
  }))

  registerRoute('route:links-test', UI.linkTest, browser('links/test', ['POST'], async (body) => {
    const url = normalizeHubUrl(body.url)
    if (url === null) throw new HttpError(400, '接入点地址必须是 http(s):// 开头的完整 URL', CODE.badRequest)
    if (url.startsWith('http://') && !config.allowInsecureHttp) {
      throw new HttpError(400, '本配置不允许明文 http 接入点（allowInsecureHttp=false）', CODE.badRequest)
    }
    // 允许「用表单里刚填的密钥测」，也允许「用已保存的密钥测」——
    // 后者必须有，否则 UI 只能拿着 secret 前缀干瞪眼。
    let tokenId = typeof body.tokenId === 'string' ? body.tokenId.trim() : ''
    let secret = typeof body.secret === 'string' ? body.secret.trim() : ''
    if ((secret === '' || tokenId === '') && typeof body.id === 'string' && body.id !== '') {
      const saved = links.get(body.id)
      if (saved !== undefined) {
        tokenId = tokenId === '' ? saved.tokenId : tokenId
        secret = secret === '' ? saved.secret : secret
      }
    }
    return egress.probe({ url, tokenId, secret })
  }))

  registerRoute('route:links-sync', UI.linkSync, browser('links/sync', ['POST'], async (body) => {
    const linkId = typeof body.id === 'string' && body.id !== '' ? body.id : undefined
    if (linkId !== undefined && links.get(linkId) === undefined) {
      throw new HttpError(404, '接入点不存在', CODE.notFound)
    }
    inventory.invalidate()
    const results = await egress.tick({ linkId, force: true })
    // 「立即同步」同时刷新镜像：只推不拉会让对方新接入的设备在本机看不见，
    // 而那正是用户按下这个按钮时想确认的事。
    await mirrorTick(true)
    return { results, links: links.list() }
  }))

  registerRoute('route:tokens', UI.tokens, browser('tokens', ['GET', 'POST'], async (body, req) => {
    if ((req.method ?? 'GET') === 'GET') return { tokens: tokens.list(), required: config.requireToken }
    const action = typeof body.action === 'string' ? body.action : 'create'
    if (action === 'create') {
      const result = tokens.create({ label: body.label, ttlMs: body.ttlMs })
      if (!result.ok) throw new HttpError(400, result.error, CODE.badRequest)
      // secret 只在这里出现这一次。
      return { token: result.token, secret: result.secret, persisted: result.persisted, tokens: tokens.list() }
    }
    if (action === 'revoke') {
      if (!tokens.revoke(String(body.id ?? ''))) throw new HttpError(404, '令牌不存在', CODE.notFound)
      return { tokens: tokens.list() }
    }
    if (action === 'delete') {
      if (!tokens.remove(String(body.id ?? ''))) throw new HttpError(404, '令牌不存在', CODE.notFound)
      return { tokens: tokens.list() }
    }
    throw new HttpError(400, `未知动作 ${action}`, CODE.badRequest)
  }))

  registerRoute('route:paths', UI.paths, browser('paths', ['GET', 'POST'], async (body, req) => {
    // 清单要热过再建上下文：buildContext 里本机设备条目的 inventory 若是 null，
    // 主路径就解析不出来，UI 会看到一条空路径的「主路径」。
    await inventory.get({})
    if ((req.method ?? 'GET') === 'GET') {
      const context = buildContext()
      return { groups: context.groups, devices: deviceOptions(context.devices) }
    }
    const action = typeof body.action === 'string' ? body.action : 'add'
    if (action === 'add') {
      const workspace = findWorkspaceInContext(body.workspaceId)
      if (workspace === undefined) throw new HttpError(404, '找不到该工作区（id 不存在，或对应设备还没上报清单）', CODE.notFound)
      const devices = buildContext().devices
      const target = body.deviceId === undefined ? identity.deviceId : String(body.deviceId)
      if (!devices.some((entry) => entry.deviceId === target)) {
        throw new HttpError(404, `找不到设备「${target}」`, CODE.notFound)
      }
      const result = pathTable.add({
        homeDeviceId: workspace.homeDeviceId,
        workspaceId: workspace.workspace.id,
        workspaceTitle: workspace.workspace.title,
        primaryPath: workspace.workspace.path,
        deviceId: target,
        path: body.path,
        role: body.role,
        prefer: body.prefer,
        label: body.label,
      })
      if (!result.ok) throw new HttpError(400, result.error, CODE.badRequest)
      return { groups: buildContext().groups, devices: deviceOptions(buildContext().devices) }
    }
    if (action === 'remove') {
      const result = pathTable.remove(String(body.id ?? ''))
      if (!result.ok) throw new HttpError(404, result.error, CODE.notFound)
      return { groups: buildContext().groups, devices: deviceOptions(buildContext().devices) }
    }
    if (action === 'update') {
      const result = pathTable.update(String(body.id ?? ''), { role: body.role, label: body.label, prefer: body.prefer })
      if (!result.ok) throw new HttpError(400, result.error, CODE.badRequest)
      return { groups: buildContext().groups, devices: deviceOptions(buildContext().devices) }
    }
    throw new HttpError(400, `未知动作 ${action}`, CODE.badRequest)
  }))

  /**
   * 路由干跑：这条路径会在哪台设备上执行、凭什么。
   *
   * 只回答判定，**不执行任何东西**（不碰 ctx.shell / ctx.fs）。加它的理由很具体：
   * 排查「这条命令为什么去了那台」时，判定过程原本完全在暗处——`/status` 只有
   * 汇总计数，审计里只有既成事实。尤其是**同长并列**（主路径与附加路径字符串
   * 完全相同）那种情形，光看结果根本看不出当时有几个候选。
   */
  registerRoute('route:route', UI.route, browser('route', ['POST'], async (body) => {
    const raw = typeof body.path === 'string' ? body.path.trim() : ''
    if (raw === '') throw new HttpError(400, 'path 不能为空', CODE.badRequest)
    const owners = collectPathOwners(routingGroups())
    const { normalized, contenders } = ownersForPath(raw, owners)
    if (normalized === undefined) throw new HttpError(400, 'path 必须是绝对路径', CODE.badRequest)
    // 可选 `cwd`：会话的 cwd 是「这条请求属于哪个工作区」的唯一依据。排查互联会话
    // 为什么读到本地时，必须能指定 cwd —— 否则工作区之外的路径永远看不出 mesh 判定。
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : undefined
    const extra = workspacePolicy()
    const decision = routePathWithPolicy(raw, {
      owners,
      selfDeviceId: identity.deviceId,
      policy: extra?.policy,
      cwd,
      resolveOwner: extra?.resolveOwner,
    })
    const lengthOf = (owner) => owner.path.length
    // 「并列」= 最优与次优的匹配前缀一样长。那正是会因 deviceId 变化而翻面的情形，
    // 也是唯一需要人去显式声明 prefer 的情形，所以单独标出来。
    const tied = contenders.length > 1 && lengthOf(contenders[0]) === lengthOf(contenders[1])
    return {
      path: raw,
      normalized,
      cwd: cwd ?? null,
      decision: decision.route,
      explanation: explainRoute(decision, (deviceId) => deviceId),
      // 工作区策略的判定结果：是不是互联会话、属主是谁、命中了哪条声明。
      workspace: decision.workspace === undefined ? null : {
        path: decision.workspace.path,
        mesh: decision.workspace.mesh === true,
        owner: decision.workspace.owner,
        ownerDeviceId: extra?.resolveOwner(decision.workspace.owner) ?? null,
        // 属主是「按声明名字」还是「按账目」定出来的：后者说明设备名表不全（排查用）。
        ownerVia: decision.ownerVia ?? null,
      },
      tied,
      // 显式声明过的路径不该再依赖 id 兜底；没声明又有并列就是隐患，如实标出来。
      needsPrefer: tied && contenders[0].prefer !== true,
      contenders: contenders.map((owner) => ({
        deviceId: owner.deviceId,
        path: owner.path,
        source: owner.source,
        prefer: owner.prefer === true,
      })),
    }
  }))

  registerRoute('route:exec', UI.exec, browser('exec', ['POST'], async (body) => {
    await inventory.get({})
    const result = await caller.exec({
      path: body.path,
      workspace: body.workspace,
      device: body.device ?? body.deviceId,
      command: body.command,
      timeoutMs: body.timeoutMs,
      actor: 'browser',
      direction: 'browser',
    })
    return result
  }))

  /**
   * 把**对端设备上**某会话的完整历史拉回本机，填掉本机那份空桩。
   *
   * 背景（用户报的「网络会话里缺省上下文占用量UI」的真实根因）：出厂的「上下文占用」
   * 圆环按钮读的是 `contextPressure` 会话投影，而投影要从**本机这份会话日志**里折出来
   * （`request/context` 给容量、assistant 的 usage 给用量）。真实日志在 orangepi5 上的
   * 会话，本机只剩一个几百字节的空桩 —— 没有事件，按钮必然不渲染。所以正解不是改 UI，
   * 是**把日志拿回来**。
   *
   * 通道：走 mesh 已有的入站 `exec`（HMAC 认证、审计、导出根约束）。会话日志可能到
   * MB 级，而单条 exec 的 stdout 上限是 `execOutputLimitBytes`（256 KB），所以按
   * 180 KB 分块读、每块 base64 后拼接，最后校验 zstd 魔数再落盘。
   *
   * 安全面（都是「宁可不动」的档）：
   *   - 本机该会话**正在跑**（活 agent）→ 拒绝：覆盖活会话的日志会直接弄坏它；
   *   - 本机日志**已经有事件**（非空桩）→ 默认拒绝：那不是「缺省」，是「本机也有历史」，
   *     盲目覆盖会丢本机内容。`force`（接管）时才覆盖，且**先备份**到
   *     `<meshDir>/session-takeover-backups/`（会话目录只留出厂认识的文件）；
   *   - 落盘用同目录 tmp + rename + 0600，绝不半截写进会话目录。
   *
   * `/session-pull`（填空桩，不覆盖）与 `/takeover`（显式接管，允许覆盖）共用这一份实现。
   *
   * @param {object} request `{ sessionId, deviceId?, force? }`。
   * @returns {Promise<{sessionId:string, deviceId:string, bytes:number, chunks:number, path:string, version:'v4'|'v3'}>}
   */
  const pullSessionFrom = async ({ sessionId: rawSessionId, deviceId: rawDeviceId, force }) => {
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new HttpError(400, '需要合法的 sessionId', CODE.badRequest)
    }
    await inventory.get({})

    // ── 1. 目标设备：显式给了就用；否则在清单里找报这条会话的那台（非本机） ──────
    const tree = buildTree({ scope: 'full', now: Date.now() })
    const wanted = typeof rawDeviceId === 'string' ? rawDeviceId.trim() : ''
    let target = null
    for (const device of tree.devices) {
      if (device.self === true) continue
      if (wanted !== '' && device.deviceId !== wanted) continue
      const workspaces = device.inventory?.workspaces ?? []
      const hit = workspaces.some((workspace) => (workspace.sessions ?? []).some((session) => session?.id === sessionId))
      if (hit) { target = device; break }
    }
    if (target === null && wanted !== '') {
      // 归档会话不进清单（includeArchived=false），但日志还在盘上：显式指定了
      // 设备就继续走（locate 的 glob 本来就扫全部工作区目录），而不是 404。
      target = tree.devices.find((d) => d.self !== true && d.deviceId === wanted) ?? null
    }
    if (target === null) {
      throw new HttpError(404, `没有任何对端设备报过会话 ${sessionId}`, CODE.notFound)
    }

    // ── 2. 本机侧前置检查：活的拒绝、非空桩拒绝（force 时改为「先备份再覆盖」）────
    const local = localSessionLog(sessionId)
    if (local === null) throw new HttpError(500, `读不到本机会话目录：${path.join(dshHomePath(), 'sessions')}`, CODE.internal)
    if (local.live === true) {
      throw new HttpError(409, `会话 ${sessionId} 在本机是活会话，不能覆盖它的日志`, CODE.busy)
    }
    if (local.hasEvents === true && force !== true) {
      throw new HttpError(409, `本机已有该会话的历史（${local.bytes} 字节），不覆盖；要强制重建请先归档或手工处理`, CODE.conflict)
    }
    // 强制覆盖前把本机那份挪出会话目录（备份在网格数据目录下，会话目录只留出厂认识的文件）。
    const backup = local.hasEvents === true && local.file !== null ? backupLocalLog(sessionId, local.file) : null

    // ── 3. 在对端上定位日志文件（v4 优先，退回 v3） ───────────────────────────
    // cwd 用该会话自己的工作目录：它一定在导出根里（那是台已登记的工作区路径）。
    const remoteSession = findRemoteSession(tree, target.deviceId, sessionId)
    const cwd = typeof remoteSession?.cwd === 'string' && remoteSession.cwd !== '' ? remoteSession.cwd : target.inventory?.workspaces?.[0]?.path
    if (typeof cwd !== 'string' || cwd === '') {
      throw new HttpError(409, `找不到会话 ${sessionId} 在 ${target.name} 上的工作目录`, CODE.conflict)
    }
    const locate = await caller.exec({
      device: target.deviceId,
      path: cwd,
      command: [
        'for h in "$HOME/.dsh" /root/.dsh; do',
        `  for f in "$h"/sessions/*/${sessionId}/session.v4.jsonl.zstd "$h"/sessions/*/${sessionId}/session.v3.jsonl.zstd; do`,
        '    [ -f "$f" ] && echo "$f" && exit 0',
        '  done',
        'done',
        'exit 1',
      ].join('\n'),
      timeoutMs: 20000,
      actor: 'browser',
      direction: 'browser',
    })
    if (locate.exitCode !== 0 || typeof locate.stdout !== 'string' || locate.stdout.trim() === '') {
      throw new HttpError(404, `${target.name} 上找不到会话 ${sessionId} 的日志文件`, CODE.notFound)
    }
    const remoteFile = locate.stdout.trim().split('\n')[0].trim()
    // 归档会话不在清单里，cwd 只能是兜底猜的；用真实文件路径反推工作区 slug，
    // 避免把会话落进错误的工作区目录。
    const remoteSlug = /\/sessions\/([^/]+)\//.exec(remoteFile)?.[1] ?? null
    const remoteVersion = remoteFile.includes('session.v4.') ? 'v4' : 'v3'

    // ── 4. 分块读回来（单块 180 KB → base64 后 ~240 KB，留在 256 KB 输出上限内） ──
    const chunk = 180 * 1024
    const parts = []
    let offset = 0
    for (let guard = 0; guard < 4096; guard += 1) {
      const read = await caller.exec({
        device: target.deviceId,
        path: cwd,
        command: `tail -c +${offset + 1} ${shellQuote(remoteFile)} | head -c ${chunk} | base64 -w0`,
        timeoutMs: 60000,
        actor: 'browser',
        direction: 'browser',
      })
      if (read.exitCode !== 0) {
        throw new HttpError(502, `读取 ${remoteFile} 第 ${offset} 字节起的内容失败：${String(read.stderr ?? '').slice(0, 200)}`, CODE.upstream)
      }
      const encoded = String(read.stdout ?? '').trim()
      if (read.stdoutTruncated === true || encoded === '') {
        // 截断只会发生在最后一块正好卡在上限 —— 那也说明这一块没读全，宁可失败。
        if (encoded === '' && offset > 0) break
        throw new HttpError(502, `读取 ${remoteFile} 时输出被截断（单块 ${chunk} 字节）`, CODE.upstream)
      }
      const decoded = Buffer.from(encoded, 'base64')
      if (decoded.length === 0) break
      parts.push(decoded)
      offset += decoded.length
      if (decoded.length < chunk) break
    }
    const bytes = Buffer.concat(parts)
    if (bytes.length < 4 || bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd) {
      throw new HttpError(502, `拉回的内容不是 zstd 会话日志（${bytes.length} 字节，头 ${bytes.subarray(0, 4).toString('hex')}）`, CODE.upstream)
    }

    // ── 5. 落盘：同目录 tmp + rename，0600；v4/v3 各按对端的世代命名 ───────────
    // 目录：本机已有会话目录就用它；否则按对端日志路径反推的 slug（归档会话的兜底）。
    const written = writeLocalSessionLog({
      sessionId,
      cwd: remoteSession?.cwd ?? cwd,
      version: remoteVersion === 'v4' ? 4 : 3,
      bytes,
      localDir: local.dir ?? path.join(dshHomePath(), 'sessions', remoteSlug ?? slugForCwd(remoteSession?.cwd ?? cwd), sessionId),
      backup,
    })
    logger?.info?.(`dsh-device-mesh: 会话 ${sessionId} 的历史已从 ${target.name} 拉回本机（${bytes.length} 字节，${parts.length} 块）`)
    return {
      sessionId,
      deviceId: target.deviceId,
      deviceName: target.name,
      bytes: bytes.length,
      chunks: parts.length,
      path: written.path,
      version: remoteVersion,
      backup: written.backup,
      shadowed: written.moved,
      note: '重新打开该会话即可看到完整历史；出厂 composer 的「上下文占用」按钮会随投影一起出现',
    }
  }

  registerRoute('route:session-pull', UI.sessionPull, browser('session-pull', ['POST'], async (body) => pullSessionFrom({
    sessionId: body.sessionId,
    deviceId: body.deviceId,
    force: body.force === true,
  })))

  registerRoute('route:browse', UI.browse, browser('browse', ['POST'], async (body) => {
    await inventory.get({})
    return caller.list({ deviceId: body.deviceId, device: body.deviceId, path: body.path })
  }))

  /**
   * 会话历史镜像概况：本机作为**执行端**收到了什么（按源设备分组），
   * 以及本机作为**会话端**推了多少（sender）。只读。
   */
  registerRoute('route:mirror', UI.mirror, browser('mirror', ['GET'], async () => ({
    configured: config.sessionMirror,
    sender: mirrorSender.status(),
    replicas: replicas.status(),
    sessionsRoot: path.join(dshHomePath(), 'sessions'),
  })))

  /**
   * 执行端的**进度面**：镜像里每条会话「最近在干什么」。只读。
   *
   * 为什么单独一条路由而不是塞进 `/tree`：`/tree` 是 700 KB 量级（含对端整份清单），
   * 而进度要每 15 s 刷一次；塞进去等于每轮把清单也重传一遍。这里只回镜像索引的摘要
   * 字段，再合并对端清单里的活跃标记（口径与 `drivers` 一致：**镜像的「最近有没有动」
   * 与对端的「agent 在不在跑」是两件事**，UI 两个都要，所以两个都给）。
   *
   * 会话列表里**依旧没有**这些会话（它们还不是本机的会话）—— 这条路由只喂「远程工作区」
   * 那一段的进度行，不改变「镜像不污染本机会话列表」这条边界。
   */
  registerRoute('route:replica-progress', UI.replicaProgress, browser('replica-progress', ['GET'], async () => {
    if (inventory.current() === null) await inventory.get({})
    else inventory.kick()
    const tree = buildTree({ scope: 'full', now: Date.now() })
    const liveWindowMs = config.mirrorLiveWindowMs
    const rows = replicas.progress({ now: Date.now(), liveWindowMs })
    // 对端清单里的会话（标题 / agent 是否在跑 / 本机有没有）。清单是快照，取第一次报的。
    const reported = new Map()
    for (const device of tree.devices) {
      if (device.self === true) continue
      for (const workspace of device.inventory?.workspaces ?? []) {
        for (const session of workspace.sessions ?? []) {
          const id = typeof session?.id === 'string' ? session.id : ''
          if (id === '' || reported.has(id)) continue
          reported.set(id, {
            deviceName: typeof device.name === 'string' ? device.name : '',
            title: typeof session.title === 'string' ? session.title : '',
            live: session.live === true,
            lastActivityAt: Number(session.lastActivityAt) || Number(session.createdAt) || null,
          })
        }
      }
    }
    const takeoverBySession = new Map()
    for (const entry of readTakeoverTail()) {
      if (typeof entry.sessionId === 'string') takeoverBySession.set(entry.sessionId, entry)
    }
    const sessions = rows.map((row) => {
      const replica = replicas.find(row.sessionId)
      const canonical = canonicalSessionId(row.sessionId, replica)
      const sessionId = canonical === '' ? row.sessionId : canonical
      const remote = reported.get(sessionId) ?? reported.get(row.sessionId) ?? null
      const local = localSessionLog(sessionId)
      const takeover = takeoverBySession.get(sessionId) ?? null
      return {
        ...row,
        sessionId,
        replicaId: row.sessionId,
        title: row.title !== '' ? row.title : (remote?.title ?? ''),
        sourceDeviceName: row.sourceDeviceName !== '' ? row.sourceDeviceName : (remote?.deviceName ?? ''),
        remoteLive: remote?.live === true,
        remoteLastActivityAt: remote?.lastActivityAt ?? null,
        localExists: local !== null && local.dir !== null,
        localHasEvents: local !== null && local.hasEvents === true,
        localLive: local !== null && local.live === true,
        localBytes: local?.bytes ?? 0,
        takenOverAt: typeof takeover?.at === 'string' ? takeover.at : null,
        // 能不能接管：本机没有活会话（有就不许动），且镜像里有事件（没事件的落地是空会话）。
        canTakeover: (local === null || local.live !== true) && row.events > 0,
      }
    })
    return { ok: true, liveWindowMs, generatedAt: new Date().toISOString(), sessions }
  }))

  /**
   * **接管**：把一条在别处执行的会话变成本机会话（用户的显式动作）。
   *
   * 两条路径，落点相同 —— 本机 `sessions/` 里一份出厂可读的日志：
   *   1. **在线**：从源设备按字节拉回（与 `/session-pull` 同一实现；世代与文件名由对端
   *      日志本身决定，最忠实）；
   *   2. **离线**（源设备不可达）：用本机已有的**镜像**重压 —— 镜像里是源设备实时推来的
   *      `{seq,time,type,data}`（外加 surfaceOp/sourceEventSeqs），重压成「头行 + 每行一个
   *      独立 zstd 帧」就是出厂读取器认识的日志（`buildSessionLogBytes`）。
   *
   * 为什么必须有离线路径：最需要接管的时刻恰恰是源设备关机/掉线的时候 —— 那台不在了，
   * 会话却要接着跑。只有在线路径的话，「随时接管」就只在两台都活着时成立。
   *
   * 门（拒绝得明明白白）：
   *   · 本机该会话是活会话 → 409（覆盖活会话的日志会直接弄坏它）；
   *   · 本机已有历史 → 接管恒 force（先备份到网格数据目录，再覆盖）；
   *   · 既没有镜像、在线也拉不到 → 把在线那个错误原样抛出来（404/502 各说各的）。
   */
  registerRoute('route:takeover', UI.takeover, browser('takeover', ['POST'], async (body) => {
    const requested = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (requested === '') throw new HttpError(400, '需要 sessionId', CODE.badRequest)
    const replica = replicas.find(requested)
    const sessionId = canonicalSessionId(requested, replica)
    if (sessionId === '') throw new HttpError(400, `会话 id 形状不对：${requested}`, CODE.badRequest)
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim() !== '' ? body.deviceId.trim() : undefined
    if (replica === null && deviceId === undefined) {
      throw new HttpError(404, `本机没有 ${sessionId} 的镜像，也不知道它属于哪台设备`, CODE.notFound)
    }

    // 1) 在线：源设备可达就按字节拉（忠实）。
    let onlineError = null
    try {
      const pulled = await pullSessionFrom({ sessionId, deviceId, force: true })
      recordTakeover({
        at: new Date().toISOString(),
        sessionId,
        mode: 'pull',
        deviceId: pulled.deviceId,
        deviceName: pulled.deviceName,
        version: pulled.version,
        bytes: pulled.bytes,
        backup: pulled.backup,
      })
      return {
        ok: true,
        mode: 'pull',
        sessionId,
        deviceId: pulled.deviceId,
        deviceName: pulled.deviceName,
        version: pulled.version,
        bytes: pulled.bytes,
        path: pulled.path,
        backup: pulled.backup,
        shadowed: pulled.shadowed,
        note: '已接管：这条会话现在是本机会话。重新打开它即可看到完整历史并在这里继续。',
      }
    } catch (error) {
      onlineError = error
    }

    // 2) 离线：用镜像重压落地。
    if (replica === null) throw onlineError
    const local = localSessionLog(sessionId)
    if (local === null) throw new HttpError(500, `读不到本机会话目录：${path.join(dshHomePath(), 'sessions')}`, CODE.internal)
    if (local.live === true) throw new HttpError(409, `会话 ${sessionId} 在本机是活会话，不能接管`, CODE.busy)
    const cwd = typeof replica.header?.cwd === 'string' && replica.header.cwd !== '' ? replica.header.cwd : replica.workspacePath
    if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) {
      throw new HttpError(409, `镜像里没有可用的绝对工作目录（cwd=${String(cwd)}），不知道这条会话该落在哪`, CODE.conflict)
    }
    const built = buildSessionLogBytes(
      // 会话头：优先镜像里存的那份源日志头；旧索引没存头时合成一个（见 landingHeader）。
      landingHeader(replica, sessionId, cwd),
      replicas.readEvents(replica),
    )
    if (!built.ok) {
      throw new HttpError(409, `镜像不足以落地这条会话：${built.reason}`, CODE.conflict)
    }
    const backup = local.hasEvents === true && local.file !== null ? backupLocalLog(sessionId, local.file) : null
    const written = writeLocalSessionLog({
      sessionId,
      cwd,
      version: built.version,
      bytes: built.bytes,
      localDir: local.dir,
      backup,
    })
    recordTakeover({
      at: new Date().toISOString(),
      sessionId,
      mode: 'replica',
      deviceId: replica.deviceId,
      deviceName: replica.sourceDeviceName,
      version: `v${built.version}`,
      bytes: built.bytes.length,
      events: replica.events,
      backup,
      // 离线路径的边界如实记下来：镜像可能比源设备落后（最后一批之后的事件没到本机）。
      lastSeq: replica.lastSeq,
      sourceUnreachable: errorText(onlineError),
    })
    logger?.info?.(`dsh-device-mesh: 会话 ${sessionId} 已由本机镜像接管落地（${built.bytes.length} 字节，源设备不可达：${errorText(onlineError)}）`)
    return {
      ok: true,
      mode: 'replica',
      sessionId,
      deviceId: replica.deviceId,
      deviceName: replica.sourceDeviceName,
      version: `v${built.version}`,
      bytes: built.bytes.length,
      lines: built.lines,
      lastSeq: replica.lastSeq,
      path: written.path,
      backup: written.backup,
      shadowed: written.moved,
      sourceUnreachable: errorText(onlineError),
      note: '源设备当前不可达，已用本机镜像接管落地；镜像可能落后于源设备的最后几条事件。',
    }
  }))

  /**
   * 把**已有历史**一次性回填给执行端。
   *
   * 实时镜像只覆盖「挂上功能之后还动过」的会话；这个接口补上静置会话的历史。
   * 需要显式触发（默认不做全量回填）：几百条会话的历史是几百 MB 量级的流量，
   * 落在 SD 卡上的执行端不该被一个默认动作压住。
   */
  registerRoute('route:mirror-backfill', UI.mirrorBackfill, browser('mirror/backfill', ['POST'], async (body) => {
    if (!config.sessionMirror) throw new HttpError(400, '会话历史镜像未开启', CODE.badRequest)
    const limit = Math.max(1, Math.min(5000, Math.trunc(Number(body?.limit ?? 100)) || 100))
    const devices = buildTree({ scope: 'full', now: Date.now() }).devices
    const owners = collectPathOwners(buildPathGroups([]))
    const entries = []
    for (const entry of devices) {
      // 只回填**本机**的会话：远端设备的清单是快照，拿它去推对端的历史没有意义。
      if (entry.self !== true) continue
      for (const workspace of entry.inventory?.workspaces ?? []) {
        for (const session of workspace.sessions ?? []) {
          if (session.origin === 'subagent') continue
          const cwd = typeof session.cwd === 'string' ? session.cwd : ''
          if (cwd === '') continue
          const decision = routePath(cwd, { owners, selfDeviceId: identity.deviceId })
          if (decision.route.kind !== 'remote') continue
          entries.push({
            sessionId: session.id,
            cwd,
            deviceId: decision.route.deviceId,
            workspaceTitle: workspace.title,
            header: { id: session.id, cwd, title: session.title ?? null },
          })
          if (entries.length >= limit) break
        }
        if (entries.length >= limit) break
      }
      if (entries.length >= limit) break
    }
    const backfilled = await mirrorSender.backfillSessions(entries)
    return { requested: entries.length, backfilled, limit, sender: mirrorSender.status() }
  }))

  registerRoute('route:audit', UI.audit, browser('audit', ['GET'], async (_body, req) => {
    const raw = typeof req.url === 'string' ? req.url : ''
    const match = /[?&]limit=(\d{1,4})/.exec(raw)
    const limit = match === null ? 100 : Number(match[1])
    const result = audit.tail(limit)
    return { ...result, stats: audit.stats() }
  }))

  registerRoute('route:nodes', UI.nodes, browser('nodes', ['GET', 'POST'], async (body, req) => {
    if ((req.method ?? 'GET') === 'GET') {
      return {
        nodes: nodes.list().map((record) => ({
          deviceId: record.deviceId,
          nodeId: record.nodeId,
          name: record.note !== '' ? record.note : (record.device?.name ?? record.deviceId),
          device: record.device,
          trust: record.trust,
          note: record.note,
          tokenId: record.tokenId,
          joinedAt: record.joinedAt,
          lastSeenAt: record.lastSeenAt,
          lastInventoryAt: record.lastInventoryAt,
          reportCount: record.reportCount,
          liveness: livenessOf(Date.now() - Date.parse(record.lastSeenAt), config),
          workspaceCount: record.inventory?.workspaces?.length ?? 0,
          sessionCount: record.inventory?.totals?.sessions ?? 0,
        })),
      }
    }
    const deviceId = String(body.deviceId ?? '')
    const action = typeof body.action === 'string' ? body.action : 'update'
    if (action === 'forget') {
      if (!nodes.forget(deviceId)) throw new HttpError(404, '节点不存在', CODE.notFound)
      return { nodes: nodes.list().length }
    }
    if (action === 'update') {
      const updated = nodes.update(deviceId, { note: body.note, trust: body.trust })
      if (updated === undefined) throw new HttpError(404, '节点不存在', CODE.notFound)
      return { node: { deviceId: updated.deviceId, note: updated.note, trust: updated.trust } }
    }
    throw new HttpError(400, `未知动作 ${action}`, CODE.badRequest)
  }))

  // ── 出站循环 ──────────────────────────────────────────────────────────────

  /**
   * 顺带维护「接入点一跳总览」镜像。
   *
   * 单独一个慢循环（`mirrorIntervalMs`，默认 60 s）而不是塞进 egress 的心跳路径：
   * 镜像要跑一次完整 `buildTree`，比心跳重得多，不该被心跳频率带着走。
   * @returns {Promise<void>}
   */
  const mirrorTick = async (force = false) => {
    const now = Date.now()
    for (const link of links.all()) {
      if (!link.enabled) continue
      const last = mirrors.get(link.id)
      // force 由「立即同步」按钮与对端首次接入后触发：让人按一下就看到最新拓扑，
      // 而不必等一个 mirrorIntervalMs（缺省 60 s）。
      if (!force && last !== undefined && now - last.at < config.mirrorIntervalMs) continue
      const state = egress.stateOf(link.id)
      if (state?.joined !== true || link.tokenId === '' || link.secret === '') continue
      const body = JSON.stringify({ protocol: PROTOCOL_VERSION, nodeId: state.nodeId, depth: 1 })
      const headers = buildSignatureHeaders({
        deviceId: identity.deviceId,
        tokenId: link.tokenId,
        secret: link.secret,
        method: 'POST',
        path: API.tree,
        body,
        now,
      })
      const result = await requestJson(link.url, {
        path: API.tree,
        method: 'POST',
        body,
        headers,
        timeoutMs: config.requestTimeoutMs,
        maxBytes: config.maxResponseBytes,
      })
      if (!result.ok) {
        // 镜像失败不影响接入本身：链接状态由 egress 负责，这里只把失败记进镜像位
        // 并**保留上一份可用镜像**，免得一次抖动让 UI 上的远端设备整片消失。
        mirrors.set(link.id, { ...(last ?? { devices: [] }), at: now, error: result.error })
        continue
      }
      const payload = result.json !== null && typeof result.json === 'object' ? result.json : {}
      const tree = payload.tree !== null && typeof payload.tree === 'object' ? payload.tree : {}
      const devices = Array.isArray(tree.devices) ? tree.devices : []
      const selfInMirror = devices.find((entry) => entry.deviceId === tree.selfDeviceId)
      mirrors.set(link.id, {
        at: now,
        devices,
        hubName: selfInMirror?.name ?? link.hubDevice?.name ?? link.label,
        inventory: selfInMirror?.inventory ?? null,
        hub: selfInMirror?.device ?? link.hubDevice ?? null,
        error: null,
      })
    }
  }

  ctx.effect(() => {
    egress.start()
    const timer = setInterval(() => {
      // 镜像循环与出站循环共用一个「插件活着」的生命周期；异常一律吞掉并记日志，
      // 不让一个未捕获的 rejection 打挂整行。
      void mirrorTick().catch((error) => logger?.warn?.(`dsh-device-mesh: 镜像循环异常：${errorText(error)}`))
    }, Math.min(Math.max(10000, config.mirrorIntervalMs), 600000))
    timer.unref?.()
    void mirrorTick().catch(() => {})
    return () => {
      clearInterval(timer)
      egress.stop()
      tokens.flush()
    }
  }, 'dsh-device-mesh:runtime')

  // ── 模型工具 ──────────────────────────────────────────────────────────────
  //
  // 这两个工具**注册在 host 的 tools 注册表上**（不是某个 agent 预设里），
  // 所以无论会话跑哪个预设都能用 —— 与同 profile 的 image-unload 行同一套路。
  //
  // 用 `ctx.inject(['tools'], ...)` 而不是 `export const inject = [...]`：
  // 前者是「等这个服务出现再注册」的规范写法，在启动期与 patch 热重载期都对；
  // 后者会让整行在 tools 缺席时进入 waiting，把网格的其它功能一起拖住。
  // 回调返回的 disposer 归当前 fiber，插件被拆时工具随之消失。
  ctx.inject(['tools'], (toolsCtx) => {
    /** 执行类工具的返回渲染：先给人看结论，再给原文。 */
    const renderExec = (_args, value) => {
      const target = value?.target ?? {}
      const lines = [
        `${target.local === true ? '本机' : '远端'} ${target.deviceName ?? '?'}:${value?.cwd ?? '?'}`
        + `${target.role === 'primary' ? '（主路径）' : `（附加路径 ${target.role ?? ''}）`}`,
        `命令：${value?.command ?? ''}`,
        `退出码：${value?.exitCode === null || value?.exitCode === undefined ? '（无，进程被信号终止）' : value.exitCode}`
        + `${value?.signal === null || value?.signal === undefined ? '' : ` 信号：${value.signal}`}`
        + `${value?.timedOut === true ? '  **超时已终止**' : ''}`
        + `${typeof value?.durationMs === 'number' ? `  耗时：${value.durationMs} ms` : ''}`,
      ]
      if (value?.stdout) lines.push(`── stdout ──\n${value.stdout}${value.stdoutTruncated === true ? '\n[stdout 已截断]' : ''}`)
      if (value?.stderr) lines.push(`── stderr ──\n${value.stderr}${value.stderrTruncated === true ? '\n[stderr 已截断]' : ''}`)
      if (!value?.stdout && !value?.stderr) lines.push('（无输出）')
      if (value?.auditId) lines.push(`审计编号：${value.auditId}`)
      return [{ type: 'text', text: lines.join('\n') }]
    }

    /** 路径账目工具的渲染：按工作区分组，主路径在前、附加路径在后。 */
    const renderPaths = (_args, value) => {
      const lines = []
      for (const group of value?.groups ?? []) {
        // id 必须打出来：`add` 要用它，而人在列表里只看得见标题。
        // 「看得见标题、猜不到 id」是上一版真踩过的坑。
        lines.push(`■ ${group.workspaceTitle}  [${group.workspaceId}]${group.orphan === true ? '（工作区已不在本机注册表中）' : ''}`)
        lines.push(`  主路径  ${group.primary.deviceName}:${group.primary.path || '(未知)'}${group.primary.stale === true ? '  [快照]' : ''}`)
        if ((group.members ?? []).length === 0) lines.push('  （没有附加路径）')
        for (const member of group.members ?? []) {
          lines.push(`  附加    ${member.deviceName}:${member.path}  role=${member.role}`
            + `${member.reachable === true ? '' : '  [不可达：本机没有指向它的接入点]'}`)
        }
      }
      if (lines.length === 0) lines.push('（还没有任何工作区路径账目）')
      if ((value?.devices ?? []).length > 0) {
        lines.push('', '可用设备：')
        for (const device of value.devices) {
          lines.push(`  ${device.name}  [${device.deviceId}]  ${device.self === true ? '[本机] ' : ''}`
            + `${device.liveness}  可达=${device.reachable === true}  可执行=${device.canExec === true}`
            + `  工作区=${device.workspaceCount}  会话=${device.sessionCount}`)
        }
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }

    const disposeExec = toolsCtx.tools.register({
      name: 'mesh_exec',
      description: [
        '在设备网格里的某台设备上执行一条 shell 命令。',
        '不指定目标时在本机执行；跨设备执行只走一跳（目标必须是本机直连的接入点，',
        '且对端已开启跨设备执行并授予本机执行权限）。',
        '目标解析顺序：path（先在附加路径账目里查，再在各设备主路径里查）→ workspace（用它的主路径）',
        '→ device（用该设备第一个有会话的工作区主路径）。',
        '命令以对端 DSH 进程的身份运行，与它对端本地的 bash 工具同级。',
        '返回退出码、stdout、stderr、耗时与审计编号。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令（在目标目录下运行）。' },
          path: { type: 'string', description: '目标工作目录的绝对路径。可以是某个工作区的主路径或附加路径。' },
          workspace: { type: 'string', description: '工作区名或 id；用它**主路径**所在的设备与目录执行。' },
          device: { type: 'string', description: '设备名或 deviceId。与 path 同用时表示「就在这台设备的这个路径上」。' },
          timeoutMs: { type: 'integer', description: '超时毫秒数；只能比目标设备的上限更短。' },
        },
        required: ['command'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderExec },
      async execute(args) {
        await inventory.get({})
        return caller.exec({
          path: args?.path,
          workspace: args?.workspace,
          device: args?.device,
          command: args?.command,
          timeoutMs: args?.timeoutMs,
          actor: 'tool',
          direction: 'tool',
        })
      },
    })

    const disposePaths = toolsCtx.tools.register({
      name: 'mesh_workspace_paths',
      description: [
        '查看或维护「工作区 → 多个工作路径」账目。',
        '一个工作区永远有一个主路径（它在所属设备上的出厂目录，不可改，也是默认工作位置），',
        '另外可以挂若干条附加路径，落在本机或另一台设备上。',
        'action=list 列出全部；action=add 需要 workspaceId/deviceId/path（可选 role=mirror|scratch、prefer=true、label）；',
        'action=remove 需要 id（附加路径的 id）。',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: '要做的动作。' },
          workspaceId: { type: 'string', description: '工作区 id **或标题**（add 时必填；先 list 拿到）。' },
          deviceId: { type: 'string', description: '附加路径所在设备的 deviceId（add 时必填；省略则本机）。' },
          path: { type: 'string', description: '附加路径的绝对路径（add 时必填）。' },
          role: { type: 'string', enum: ['mirror', 'scratch'], description: 'mirror=同一项目的另一份副本；scratch=临时工作目录。' },
          label: { type: 'string', description: '这条附加路径的备注。' },
          prefer: { type: 'boolean', description: '显式优先级：当工作区主路径与这条附加路径的字符串完全相同时（把工作路径定位到另一台机器的常见做法），用来裁决命令去哪台执行。不设则按设备 id 兜底。' },
          id: { type: 'string', description: '附加路径 id（remove 时必填）。' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderPaths },
      async execute(args) {
        await inventory.get({})
        const action = typeof args?.action === 'string' ? args.action : 'list'
        if (action === 'list') {
          const context = buildContext()
          return { groups: context.groups, devices: deviceOptions(context.devices) }
        }
        if (action === 'add') {
          const workspace = findWorkspaceInContext(args?.workspaceId)
          if (workspace === undefined) throw new Error('找不到该工作区：请先用 mesh_workspace_paths action=list 查看可用的 workspaceId')
          const result = pathTable.add({
            homeDeviceId: workspace.homeDeviceId,
            workspaceId: workspace.workspace.id,
            workspaceTitle: workspace.workspace.title,
            primaryPath: workspace.workspace.path,
            deviceId: args?.deviceId ?? identity.deviceId,
            path: args?.path,
            role: args?.role,
            prefer: args?.prefer,
            label: args?.label,
          })
          if (!result.ok) throw new Error(result.error)
          const context = buildContext()
          return { groups: context.groups, devices: deviceOptions(context.devices) }
        }
        if (action === 'remove') {
          const result = pathTable.remove(String(args?.id ?? ''))
          if (!result.ok) throw new Error(result.error)
          const context = buildContext()
          return { groups: context.groups, devices: deviceOptions(context.devices) }
        }
        throw new Error(`未知 action：${action}（只支持 list / add / remove）`)
      },
    })

    return () => {
      disposeExec()
      disposePaths()
    }
  }, 'dsh-device-mesh:tools')

  // ── 按路径路由：会话在本机跑，命令与文件访问发到子节点 ────────────────────
  // 这两行**替换**了出厂的内置实现（见 cordis.patch.yml 里 bash-sandbox 与 fs-sandbox
  // 的 `disabled: true`）：同一个 context 只能有一个 ctx.shell / ctx.fs，重复注册会抛。
  // 本机请求原样委托给隔离 realm 里的出厂实现（沙箱、截断、spill、原子写、版本令牌
  // 都还是出厂那套），只有「属于子节点路径」的请求才真的发出去。
  //
  // 归属列表统一走 buildPathGroups([])：该函数只在取名时用 devices，路由需要的
  // path/deviceId 完全来自工作区注册表与路径账目（都是内存态小数据）。传全量设备树
  // 会让每个请求——包括本机请求——都背上一次全量清单构建，那是白花的钱。
  const routingGroups = () => buildPathGroups([])

  /**
   * 工作区策略提供者 —— **互联会话与纯本地会话的分离点**。
   *
   * 为什么必须有它：`routePath()` 对「谁都匹配不上」的路径回落本机执行（对纯本地部署
   * 是安全缺省），而互联会话的 agent 在会话端、文件在属主那台 —— 回落到本机就是
   * **静默读到会话端自己的文件系统**。用户实测报过这条（互联会话读到本地路径）。
   *
   * 判据来自 `config.workspaceRoles[path].mesh`：`true` = 互联会话工作区，其余 = 纯本地。
   * 归属靠**会话 cwd**（出厂 `dsh-tool-fs` 传的就是 `exec.agent.session.header.cwd`）：
   * 目标路径不参与反推归属，否则会自证循环。
   *
   * 返回 `undefined` 表示「没有声明任何工作区」→ 路由行为与改动前逐字一致（老部署不变）。
   * 设备名 → deviceId 的表从路径组现取（几个条目，很便宜）：声明里写的是名字，而归属
   * 记录里只有 id，两边对不上时必须**失败关闭**而不是猜。
   *
   * @returns {{policy: object, resolveOwner: (token: string) => string|undefined}|undefined} 策略。
   */
  const workspacePolicy = () => {
    const groups = routingGroups()
    // 账目里的**每个**工作区都进表：未声明的按纯本地记。否则「未声明 = 纯本地」
    // 这条缺省落不了地 —— cwd 归属不到条目就会掉回旧的按路径判定。
    const policy = collectWorkspacePolicy(config.workspaceRoles, groups)
    if (policy.entries.length === 0) return undefined
    // 设备名 → id 的表必须从**节点表/接入点表**取，不能只靠路径组：路由用的路径组是
    // `buildPathGroups([])` 建的（不带设备清单），组里的 `deviceName` 是空的。实测踩过：
    // 声明里的 owner 名字解析不出来，互联会话被误判成「属主不明」而拒绝执行。
    const nameCandidates = [
      ...nodes.list().map((record) => ({ deviceId: record.deviceId, name: record.device?.name ?? record.deviceId })),
      ...links.all().map((link) => ({ deviceId: link.hubDevice?.deviceId, name: link.hubDevice?.name })),
    ]
    const names = collectDeviceNames(groups, { deviceId: identity.deviceId, name: identity.name }, nameCandidates)
    return { policy, resolveOwner: (token) => resolveOwnerToken(names, token) }
  }

  let shellRouting
  let shellRoutingFailure = null
  try {
    shellRouting = mountShellRouting(ctx, {
      config,
      groups: routingGroups,
      caller,
      selfDeviceId: identity.deviceId,
      logger,
      workspacePolicy,
      /**
       * 本机中止时告诉对端「别再跑了」。
       *
       * 复用 `Caller.request`（同一条签名与设备钉住逻辑），`targetPath` 传命令的
       * 工作目录：它只用来钉设备与审计，cancel 本身不需要路径——但完全不传路径会让
       * 目标解析退化成「设备 + 该设备第一个工作区」，在一台没有工作区的设备上直接失败。
       */
      cancelRemote: async ({ deviceId, jobId, workdir }) => {
        return caller.request({
          deviceId,
          targetPath: typeof workdir === 'string' ? workdir : '',
          route: API.execCancel,
          body: { jobId },
          // 中止是收尾动作：给它一个短超时，不能让它把「停止」这件事本身拖住。
          timeoutMs: 5000,
        })
      },
    })
  } catch (error) {
    shellRoutingFailure = errorText(error)
    // 挂载失败必须同时进 problems 与 /status.routing：只写一条日志的话，
    // 「配置说开着路由、实际压根没挂」在界面上和一切正常长得一模一样。
    problems.push(`命令路由未挂载，命令只在本机执行：${shellRoutingFailure}`)
    logger?.warn?.(`dsh-device-mesh: 命令路由挂载失败，命令继续在本机执行：${shellRoutingFailure}`)
  }

  let fsRouting
  let fsRoutingFailure = null
  try {
    fsRouting = mountFsRouting(ctx, {
      config,
      groups: routingGroups,
      caller,
      selfDeviceId: identity.deviceId,
      logger,
      workspacePolicy,
    })
  } catch (error) {
    fsRoutingFailure = errorText(error)
    problems.push(`文件路由未挂载，文件访问只在本机执行：${fsRoutingFailure}`)
    logger?.warn?.(`dsh-device-mesh: 文件路由挂载失败，文件访问继续在本机执行：${fsRoutingFailure}`)
  }

  // 入站侧的远端文件系统原语：让**别的**节点能读写本机导出的目录。
  // 复用现成的 registerRoute + inbound（签名鉴权、失败码映射、请求体上限都在里面），
  // 落地一律交给本机自己的 ctx.fs——语义与「对端自己跑工具」逐字一致。
  //
  // 门与 /api/exec 同源：join 过 → 授权（allowRemoteExec + execTrust）→ 导出根。
  // 文件访问刻意复用「执行权限」这套门——读写对端文件和在对端跑命令是同一量级的
  // 权力，给它单独一套更松的规则没有道理。被拒的尝试同样写审计。
  const fsGate = (auth, rawPath, label) => {
    const node = requireNode(auth)
    nodes.touch(node.deviceId, { now: Date.now() })
    try {
      executor.checkAuthority(node)
      return executor.checkFsPath(rawPath)
    } catch (error) {
      if (error instanceof ExecError) {
        const entry = audit.append({
          deviceId: node.deviceId,
          deviceName: node.device?.name ?? node.deviceId,
          direction: 'in',
          actor: 'remote',
          path: typeof rawPath === 'string' ? rawPath : '',
          command: `fs:${label}`,
          outcome: 'denied',
          code: error.code,
          exitCode: null,
          durationMs: 0,
          error: error.message,
        })
        throw new HttpError(error.status, error.message, error.code, { auditId: entry.id })
      }
      throw error
    }
  }

  try {
    mountFsInbound({ registerRoute, inbound, API, CODE, ctx, gate: fsGate, logger })
  } catch (error) {
    logger?.warn?.(`dsh-device-mesh: 远端文件系统原语注册失败，别的节点无法读写本机文件：${errorText(error)}`)
  }

  // ── 对其它行暴露的服务 ────────────────────────────────────────────────────
  // 本行挂在 profile patch 的根列表上（不是 preset），所以发布在进程级 realm 是
  // 正确的：任何一行的消费方都该看到同一个网格。消费方一律惰性 ctx.get('deviceMesh')。
  try {
    ctx.provide('deviceMesh', {
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      identity: () => ({ ...identity }),
      device,
      tree: (scope = 'full') => buildTree({ scope, now: Date.now() }),
      inventory: (options) => inventory.get(options ?? {}),
      links: () => links.list(),
      nodes: () => nodes.list().map((record) => ({ ...record, inventory: undefined })),
      push: (linkId) => egress.tick({ linkId, force: true }),
      // 跨设备执行与路径账目：消费方（另一个插件 / 命令 / 会话）可以复用同一套
      // 门与审计，而不是自己再拼一遍签名与导出根判定。
      exec: (request) => caller.exec({ ...request, actor: request?.actor ?? 'service' }),
      list: (request) => caller.list(request ?? {}),
      paths: () => buildContext().groups,
      audit: (limit) => audit.tail(limit ?? 100),
      status: () => ({ version: VERSION, protocol: PROTOCOL_VERSION, problems: [...problems] }),
    })
  } catch (error) {
    logger?.warn?.(`dsh-device-mesh: ctx.provide('deviceMesh') 失败，其它插件拿不到该服务：${errorText(error)}`)
  }

  logger?.info?.(
    `dsh-device-mesh v${VERSION}: 设备 ${identity.name}（${identity.deviceId}），`
    + `入站${config.allowInbound ? '开' : '关'}${config.allowInbound ? (config.requireToken ? '（需令牌）' : '（**无认证**）') : ''}，`
    + `出站接入点 ${links.all().length} 条，数据目录 ${meshDir}`,
  )
}

// ───────────────────────────── 纯函数小工具 ─────────────────────────────

/**
 * 按最后可见时间算活跃度。
 * @param {number} ageMs 距最后一次心跳的毫秒数。
 * @param {{nodeStaleMs: number, nodeOfflineMs: number}} config 配置。
 * @returns {'online'|'stale'|'offline'|'unknown'} 活跃度。
 */
export function livenessOf(ageMs, config) {
  if (!Number.isFinite(ageMs)) return 'unknown'
  if (ageMs <= config.nodeStaleMs) return 'online'
  if (ageMs <= config.nodeOfflineMs) return 'stale'
  return 'offline'
}

/**
 * 设备排序：本机最前，其次在线、迟缓、离线、未知，同级按会话数降序、名字升序。
 * @param {object} a 设备条目。
 * @param {object} b 设备条目。
 * @returns {number} 比较结果。
 */
export function deviceSort(a, b) {
  if (a.self !== b.self) return a.self ? -1 : 1
  const rank = { online: 0, stale: 1, offline: 2, unknown: 3 }
  const left = rank[a.liveness] ?? 4
  const right = rank[b.liveness] ?? 4
  if (left !== right) return left - right
  const sessions = (b.inventory?.totals?.sessions ?? 0) - (a.inventory?.totals?.sessions ?? 0)
  if (sessions !== 0) return sessions
  return String(a.name ?? '').localeCompare(String(b.name ?? ''))
}

/**
 * 清洗对端上报的设备描述：只留白名单字段、全部有界。
 *
 * 对端上报的内容是**不可信输入**（它会被原样渲染到本机 UI 上，也会被写进
 * nodes.json），所以不能 `{...remote}` 直接存：那等于让对端往本机数据库里
 * 塞任意键值对。
 * @param {object} remote 对端描述。
 * @returns {object} 清洗后的描述。
 */
export function sanitizeRemoteDevice(remote) {
  const str = (value, limit = 120) => (typeof value === 'string' ? value.slice(0, limit) : '')
  const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
  const platform = str(remote.platform, 32)
  const iconTable = { win32: 'desktop', darwin: 'desktop', linux: 'server', freebsd: 'server', openbsd: 'server' }
  return {
    deviceId: str(remote.deviceId, 128),
    name: str(remote.name) || str(remote.hostname) || '未命名设备',
    platform,
    os: str(remote.os, 64) || platform || '未知系统',
    arch: str(remote.arch, 32),
    hostname: str(remote.hostname, 255),
    icon: typeof remote.icon === 'string' && ['desktop', 'server', 'unknown'].includes(remote.icon)
      ? remote.icon
      : (iconTable[platform] ?? 'unknown'),
    memoryGb: typeof remote.memoryGb === 'number' && Number.isFinite(remote.memoryGb) ? remote.memoryGb : null,
    cpuCount: int(remote.cpuCount),
    dshVersion: str(remote.dshVersion, 64),
    meshVersion: int(remote.meshVersion),
    protocol: int(remote.protocol),
    startedAt: str(remote.startedAt, 64),
    capabilities: Array.isArray(remote.capabilities)
      ? remote.capabilities.filter((entry) => typeof entry === 'string').slice(0, 16).map((entry) => entry.slice(0, 32))
      : [],
  }
}

/**
 * 清洗对端上报的清单快照：结构白名单 + 数量上界。
 *
 * 上界是必须的：对端可以声称自己有一百万个工作区。上限同时约束设备数、
 * 工作区数与每个工作区的会话数，超出即截断并置 `truncated`（不静默）。
 * @param {object} inventory 对端清单。
 * @param {{maxDevices: number, maxSessionsPerWorkspace: number}} config 配置。
 * @returns {object} 清洗后的清单。
 */
export function sanitizeInventory(inventory, config) {
  const str = (value, limit = 400) => (typeof value === 'string' ? value.slice(0, limit) : '')
  const num = (value) => (Number.isFinite(value) ? value : null)
  const workspaceLimit = Math.min(4096, Math.max(1, config.maxDevices * 64))
  const sessionLimit = Math.min(20000, Math.max(1, config.maxSessionsPerWorkspace))
  let truncated = inventory.truncated === true

  /**
   * 会话条目只有在有 id 时才保留。
   *
   * 没有 id 的条目在本机**没有任何用途**：既不能引用、也不能打开、也去不了重，
   * UI 只能渲染一行占位垃圾。对端送这种东西过来只可能是格式不对或蓄意灌数据，
   * 一律丢弃而不是留成一行空壳。
   */
  const session = (row) => ({
    id: str(row?.id, 128),
    title: typeof row?.title === 'string' ? row.title.slice(0, 400) : null,
    cwd: typeof row?.cwd === 'string' ? row.cwd.slice(0, 1024) : null,
    createdAt: num(row?.createdAt),
    lastActivityAt: num(row?.lastActivityAt),
    live: row?.live === true,
    persisted: row?.persisted === true,
    seeded: row?.seeded === true,
    origin: str(row?.origin, 32) || null,
    parentSession: str(row?.parentSession, 128) || null,
    depth: Number.isSafeInteger(row?.depth) ? row.depth : 0,
    agentPresetId: str(row?.agentPresetId, 128) || null,
    archived: row?.archived === true,
    // 空壳（建了没用过）也要过线：对端据此不再把它当成「我缺的一条会话」，
    // 否则一个工作区会因为一条没人用过的空会话在侧边栏出现两遍。
    blank: row?.blank === true,
    inferred: row?.inferred === true,
  })

  const rawWorkspaces = Array.isArray(inventory.workspaces) ? inventory.workspaces : []
  if (rawWorkspaces.length > workspaceLimit) truncated = true
  const workspaces = rawWorkspaces.slice(0, workspaceLimit).map((workspace) => {
    const rawSessions = Array.isArray(workspace?.sessions) ? workspace.sessions : []
    if (rawSessions.length > sessionLimit) truncated = true
    return {
      id: str(workspace?.id, 128),
      title: str(workspace?.title, 400) || str(workspace?.path, 400) || '未命名工作区',
      path: str(workspace?.path, 1024),
      createdAt: str(workspace?.createdAt, 64) || null,
      updatedAt: str(workspace?.updatedAt, 64) || null,
      sessionCount: Number.isSafeInteger(workspace?.sessionCount) ? workspace.sessionCount : rawSessions.length,
      droppedSessions: Number.isSafeInteger(workspace?.droppedSessions) ? workspace.droppedSessions : 0,
      liveCount: Number.isSafeInteger(workspace?.liveCount) ? workspace.liveCount : 0,
      sessions: rawSessions.slice(0, sessionLimit).map(session).filter((row) => row.id !== ''),
    }
  }).filter((workspace) => workspace.id !== '')

  const rawUnassigned = Array.isArray(inventory.unassigned) ? inventory.unassigned : []
  if (rawUnassigned.length > sessionLimit) truncated = true

  return {
    schema: 1,
    revision: Number.isSafeInteger(inventory.revision) ? inventory.revision : 0,
    generatedAt: str(inventory.generatedAt, 64) || new Date().toISOString(),
    device: sanitizeRemoteDevice(inventory.device ?? {}),
    workspaces,
    unassigned: rawUnassigned.slice(0, sessionLimit).map(session).filter((row) => row.id !== ''),
    unassignedDropped: Number.isSafeInteger(inventory.unassignedDropped) ? inventory.unassignedDropped : 0,
    totals: {
      workspaces: workspaces.length,
      sessions: Number.isSafeInteger(inventory.totals?.sessions) ? inventory.totals.sessions : 0,
      listed: workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0),
      live: Number.isSafeInteger(inventory.totals?.live) ? inventory.totals.live : 0,
      subagents: Number.isSafeInteger(inventory.totals?.subagents) ? inventory.totals.subagents : 0,
      archived: Number.isSafeInteger(inventory.totals?.archived) ? inventory.totals.archived : 0,
    },
    truncated,
    degraded: null,
    receivedAt: new Date().toISOString(),
  }
}
