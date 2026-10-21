/**
 * dsh-device-mesh — 跨设备执行（受理侧）+ 审计。
 *
 * ── 这是整个插件里权限最高的一段代码，读它时请连同下面的门一起读 ────────────
 * 一台装了本插件的 DSH，只要有人给它一个令牌，就能在这台设备上跑命令。所以受理侧
 * 刻意做成**失败关闭（fail closed）**：
 *
 *   1. 总开关      `allowRemoteExec`（缺省 false）—— 关着就一律 403 exec-disabled。
 *   2. 节点授权    `trust === 'exec'`，或本机把 `execTrust` 显式设成
 *                  `any-authenticated`（"理论上通过认证可以随便接" 就是这一档）。
 *                  令牌只证明「你是谁」，**不**自动等于「你可以在这台机器上跑命令」。
 *                  这两道合起来回答的是**「谁能连」**，与「能做什么」是两件事。
 *   3. 会话权限    请求体带来的 `sessionMode`（`read-only` / `workspace-write` /
 *                  `danger-full-access`）+ `workspaceRoot`：**会话端设置的会话权限就是
 *                  权威**，属主侧照它放行或拒绝（写才受 `workspaceRoot` 限制，读不限）。
 *                  判定在 {@link Executor.checkPermission}；`danger-full-access` 下一
 *                  条不存在的路径得到的是 404「不存在」，而不是权限错误。
 *   4. 路径真实    目标必须存在、且是目录（命令）；不是就 404 path-missing。
 *
 * **`sessionMode` 缺失时退回旧的「导出根」门**（`exportRoots` ∪ `exportWorkspacePaths`
 * 时的本机工作区路径，realpath 后按路径分段判定）：老 peer 不带这个字段，行为与升级前
 * 逐字一致。`effectiveRoots()` 因此保留 —— 但它只在**兼容路径**上参与放行，新版请求
 * 里它不再决定任何事（仍用于 `/status` 展示与诊断）。
 *
 * 门全过了以后，命令以**本进程的身份**（同一个用户、同一份环境变量）在目标目录下
 * 运行 —— 与本地 bash 工具调用完全同级。本插件不提供降权：要更强的隔离，
 * 应当把这个 DSH 本身跑在受限用户/容器里，而不是指望插件替它做沙箱。
 *
 * ── 审计 ────────────────────────────────────────────────────────────────────
 * **每一次尝试都写审计**，包括被四道门拒绝的。审计是追加式 JSONL，
 * `$DSH_HOME/device-mesh/exec-audit.jsonl`，超过上限轮转一份 `.1`。
 * 命令正文会被截断到 `execAuditCommandLimit` 字符后存档（保留可追责信息，
 * 又不至于让一条巨型命令把审计文件撑爆）。
 *
 * ── 输出与时限 ──────────────────────────────────────────────────────────────
 * stdout/stderr 各自有字节上限。**超限后继续读并丢弃**（而不是停止读取）：
 * 停止读取会让子进程的管道写满而永久阻塞，那就从「输出被截断」变成「命令挂死」了。
 *
 * @module dsh-device-mesh/exec
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CODE, randomHex } from './protocol.js?v=mesh-31'
import { ensureDir } from './store.js?v=mesh-31'

/** 带 HTTP 状态与机器码的错误：entry-v1 直接把它翻成响应。 */
export class ExecError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} message 人可读原因。
   * @param {string} code 机器可读码（见 protocol.js 的 CODE）。
   * @param {object} [detail] 附加字段（会并进失败响应）。
   */
  constructor(status, message, code, detail) {
    super(message)
    this.name = 'ExecError'
    this.status = status
    this.code = code
    if (detail !== undefined) Object.assign(this, detail)
  }
}

/** 审计文件的最大字节数，超过就轮转成 `.1`（只留一代）。 */
const AUDIT_MAX_BYTES = 8 * 1024 * 1024

/**
 * 会话权限模式，**由严格到宽松**排列。
 *
 * 顺序有意义：多会话共享同一个 cwd 而权限不同时，取**最严格**的那个（见入口里的
 * `sessionPermission()`）—— 宁可少给权限，也不要把 A 会话的完全权限借给 B 会话。
 * 所以这里的顺序同时是「谁更严」的定义，改动它等于改动安全裁决。
 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * 本轮新增的两个机器码。
 *
 * 为什么不塞进 `protocol.js` 的 `CODE`：那个文件属于**线上协议常量**，改它要连同
 * 协议版本一起考虑；这两个码只描述「会话权限拒绝」，先在 exec 这一侧定义。值本身
 * 会原样进失败响应与审计，所以取名字符串即可。
 */
export const SESSION_CODE = {
  readOnly: 'session-read-only',
  workspaceWrite: 'session-workspace-write',
}

/**
 * 在一组会话权限里取**最严格**的那个。
 *
 * 用在「多个会话共享同一个 cwd」的情形（父子会话、子代理）：权限不同就必须取最严的
 * 一个，否则等于把宽权限借给了窄权限的会话 —— 那是提权。返回 `undefined` 表示这组里
 * 没有一个认识的模式（调用方据此**不带权限**，而不是挑一个凑合用）。
 *
 * @param {unknown[]} modes 候选模式。
 * @returns {string|undefined} 最严格的模式。
 */
export function strictestMode(modes) {
  if (!Array.isArray(modes)) return undefined
  return PERMISSION_MODES.find((mode) => modes.includes(mode))
}

/**
 * 由「这个 cwd 上的候选会话」推出该 cwd 的会话权限（**纯函数**，可单测）。
 *
 * 抽成纯函数是因为它是这套权限模型里唯一有判断的地方（归属 + 取最严），而它原来写在
 * 入口的闭包里，只能靠起一个真节点来测。现在入口只负责把服务读成候选列表：
 *
 * ```js
 * sessionPermissionFromCandidates({
 *   cwd: 请求的 cwd,
 *   candidates: agents.list().map((a) => ({ cwd: a?.session?.header?.cwd, mode: modeOf(a?.session) })),
 *   workspaceRoot: 工作区路径,
 * })
 * ```
 *
 * 返回 `undefined` 的情形一律等同「不带权限」（属主退回导出根口径）：cwd 为空、没有
 * 一个候选的 cwd 与它相同、或没有一个候选给出可识别的模式。**绝不猜一个模式出来**。
 *
 * @param {{cwd?: unknown, candidates?: {cwd?: unknown, mode?: unknown}[], workspaceRoot?: unknown}} input 候选与会话 cwd。
 * @returns {{mode: string, workspaceRoot: string, matched: number, mixed: boolean}|undefined} 权限。
 */
export function sessionPermissionFromCandidates(input) {
  const raw = typeof input?.cwd === 'string' ? input.cwd.trim() : ''
  if (raw === '') return undefined
  const wanted = normalizePathForCompare(raw)
  const candidates = Array.isArray(input?.candidates) ? input.candidates : []
  const modes = []
  let matched = 0
  for (const candidate of candidates) {
    const candidateCwd = typeof candidate?.cwd === 'string' ? candidate.cwd.trim() : ''
    if (candidateCwd === '') continue
    if (normalizePathForCompare(candidateCwd) !== wanted) continue
    matched += 1
    if (PERMISSION_MODES.includes(candidate?.mode)) modes.push(candidate.mode)
  }
  if (matched === 0 || modes.length === 0) return undefined
  const mode = strictestMode(modes)
  if (mode === undefined) return undefined
  const rootRaw = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot.trim() : ''
  return {
    mode,
    workspaceRoot: rootRaw !== '' ? rootRaw : raw,
    matched,
    mixed: new Set(modes).size > 1,
  }
}

/**
 * 路径比较用的归一：去尾斜杠、折叠重复斜杠（**纯字符串**，不碰磁盘、不解析符号链接）。
 * @param {string} value 路径。
 * @returns {string} 归一结果。
 */
function normalizePathForCompare(value) {
  const unified = value.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/')
  const trimmed = unified.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * 从入站请求体里读出**会话权限**。
 *
 * 兼容性与字段冲突都在这一个函数里解决：
 *   · 老 peer 不带任何一个字段 → 返回 `undefined`，调用方退回旧的导出根门；
 *   · `fsRead` 的 `mode` 历史上是**读的编码**（`text` / `bytes`），与权限模式共用字段名。
 *     所以优先认 `sessionMode`；只有当 `mode` 的**取值恰好是三种权限模式之一**时才把它
 *     当权限（那时它不可能是编码）。这样新的发送端可以统一发 `sessionMode`，而按契约
 *     发 `mode` 的请求也仍然被认。
 *   · 非法值 → 400（宁可拒绝，不要「看不懂就当没权限」地放行）。
 *
 * @param {object} body 请求体。
 * @returns {{mode: string, workspaceRoot: string}|undefined} 权限；没有就是 `undefined`。
 * @throws {ExecError} 400 bad-request（模式字符串非法）。
 */
export function readPermissionMode(body) {
  const raw = body !== null && typeof body === 'object' ? body : {}
  let candidate
  if (typeof raw.sessionMode === 'string' && raw.sessionMode.trim() !== '') candidate = raw.sessionMode.trim()
  else if (PERMISSION_MODES.includes(raw.mode)) candidate = raw.mode
  if (candidate === undefined) return undefined
  if (!PERMISSION_MODES.includes(candidate)) {
    throw new ExecError(400, `会话权限模式非法：${candidate}（可用：${PERMISSION_MODES.join(' / ')}）`, CODE.badRequest)
  }
  return {
    mode: candidate,
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : '',
  }
}

/**
 * 追加式执行审计。
 *
 * 写失败**绝不**让执行失败：审计是「事后追责」设施，如果它一坏就让功能停摆，
 * 运维第一反应会是关掉审计 —— 那才是真的失去追责能力。所以写失败只记
 * `lastError` 并由 `/status` 报告。
 */
export class AuditLog {
  /**
   * @param {string} meshDir mesh 数据目录。
   * @param {boolean} enabled 是否落盘。
   */
  constructor(meshDir, enabled) {
    this.file = path.join(meshDir, 'exec-audit.jsonl')
    this.enabled = enabled
    this.lastError = null
    this.count = 0
    /** @type {object[]} 内存里保留最近若干条，供 `/audit` 在没开落盘时也能看到。 */
    this.recent = []
    this.recentLimit = 200
  }

  /**
   * 记一条。
   * @param {object} entry 审计条目。
   * @returns {object} 补全 id/at 后的条目。
   */
  append(entry) {
    const full = { id: randomHex(6), at: new Date().toISOString(), ...entry }
    this.count += 1
    this.recent.push(full)
    if (this.recent.length > this.recentLimit) this.recent.splice(0, this.recent.length - this.recentLimit)
    if (this.enabled) {
      try {
        ensureDir(path.dirname(this.file))
        try {
          const size = fs.statSync(this.file).size
          if (size > AUDIT_MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`)
        } catch {
          // 文件还不存在，正常。
        }
        fs.appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 })
        this.lastError = null
      } catch (error) {
        this.lastError = error?.message ?? String(error)
      }
    }
    return full
  }

  /**
   * 读最近的条目。优先读文件（进程重启后仍在），文件不可读时回落到内存。
   * @param {number} limit 条数上限。
   * @returns {{entries: object[], truncated: boolean, source: 'file'|'memory'}} 结果。
   */
  tail(limit = 100) {
    const max = Math.min(Math.max(1, limit), 1000)
    if (this.enabled) {
      try {
        const text = fs.readFileSync(this.file, 'utf8')
        const lines = text.split('\n').filter((line) => line.trim() !== '')
        const slice = lines.slice(-max)
        const entries = []
        for (const line of slice) {
          try {
            const parsed = JSON.parse(line)
            if (parsed !== null && typeof parsed === 'object') entries.push(parsed)
          } catch {
            // 半截行（写入过程中被读到）直接跳过。
          }
        }
        return { entries: entries.reverse(), truncated: lines.length > max, source: 'file' }
      } catch {
        // 落到内存。
      }
    }
    const entries = [...this.recent].reverse().slice(0, max)
    return { entries, truncated: this.recent.length > max, source: 'memory' }
  }

  /** 诊断。 */
  stats() {
    return { enabled: this.enabled, file: this.file, recorded: this.count, lastError: this.lastError }
  }
}

/**
 * 判断 `target` 是否等于 `root` 或落在它之下。
 *
 * 用 `path.relative` 而不是字符串前缀：`/srv/app2` 不是 `/srv/app` 的子路径，
 * 但 `startsWith` 会说它是 —— 这是最经典的目录穿越误判。
 * @param {string} root 根（已 realpath）。
 * @param {string} target 目标（已 realpath）。
 * @returns {boolean} 是否在根内。
 */
export function isWithin(root, target) {
  if (target === root) return true
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * realpath；失败返回 null（不存在 / 权限 / 环）。
 * @param {string} target 路径。
 * @returns {string|null} 规范路径。
 */
function realpathOrNull(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/**
 * 杀掉**一整棵进程树**，而不是只杀直接子进程。
 *
 * ── 为什么必须这样 ──────────────────────────────────────────────────────────
 * 本机跑的是 `/bin/sh -c <命令>`，而 dash **不总是 exec** 那条命令：实测
 * `sh -c 'sleep 20'` 的进程树是 sh → sleep。此时只对 sh 发信号会留下那个仍在跑的
 * 孙进程，而它**继承着 stdout/stderr 管道** —— 父进程侧等 'end' 就永远等不到，
 * 于是「已经杀掉了」的命令继续把这次执行钉住，直到孙进程自己退出
 * （实测：只 SIGTERM sh，3 秒后 stdout 仍未 end，sleep 仍在跑）。
 * 这恰好是超时逻辑声称要避免的那件事，所以**超时与取消都必须按进程组杀**。
 *
 * 子进程以 `detached: true` 起（自成进程组），于是 `-pid` 的负号精确命中它自己那一组，
 * 不会波及 DSH 自己的进程组。Windows 没有进程组信号，退回直接 kill。
 *
 * @param {object} child 子进程句柄。
 * @param {string} signal 信号名。
 * @returns {void}
 */
function killTree(child, signal) {
  if (child === null || child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      child.kill(signal)
    } catch {
      // 已经退出了。
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 进程组已经没了（或平台不支持）：退回只杀直接子进程，聊胜于无。
    try {
      child.kill(signal)
    } catch {
      // 已经退出了。
    }
  }
}

/**
 * 受理侧的跨设备执行器。
 */
export class Executor {
  /**
   * @param {{config: object, meshDir: string, logger?: object, workspacePaths: () => string[], audit: AuditLog, now?: () => number}} options 依赖。
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.audit = options.audit
    this.workspacePaths = options.workspacePaths
    this.now = options.now ?? Date.now
    /** @type {string[]|null} 有效导出根缓存。 */
    this.rootCache = null
    this.rootCacheAt = 0
    this.rootCacheError = null
    this.running = 0
    this.peakConcurrent = 0
    this.completed = 0
    this.refused = 0
    this.timedOut = 0
    this.cancelled = 0
    /**
     * 正在跑的命令：**发起方提供的** jobId → 句柄。
     *
     * 为什么要发起方提供 id：传输是一次性请求/响应，本机在命令跑完之前没有任何机会
     * 把「这次执行的 id」告诉对端，而对端要中止它必须能点名。所以 id 由发起方生成、
     * 随请求带过来，本机只负责按 id 登记与查找。
     *
     * 键里同时记 `deviceId`：甲节点不能中止乙节点正在跑的命令，即使它猜到了 id。
     * @type {Map<string, {deviceId: string, child: object, cancelled: boolean}>}
     */
    this.active = new Map()
  }

  /**
   * 有效导出根（realpath 后）。
   *
   * 缓存 `rootsTtlMs`：每个请求都做一遍 realpath 是纯浪费，而工作区增减是低频事件。
   * 缓存的是「存在的那些根」——不存在的根对容纳判定毫无贡献（目标也不可能存在）。
   * @param {boolean} [force] 跳过缓存。
   * @returns {string[]} 规范根列表。
   */
  effectiveRoots(force = false) {
    const now = this.now()
    if (!force && this.rootCache !== null && now - this.rootCacheAt < this.config.rootsTtlMs) return this.rootCache
    /** @type {Set<string>} */
    const candidates = new Set()
    for (const raw of this.config.exportRoots) {
      const normalized = typeof raw === 'string' && path.isAbsolute(raw) ? path.normalize(raw).replace(/[\\/]+$/, '') : null
      if (normalized !== null && normalized !== '') candidates.add(normalized)
    }
    if (this.config.exportWorkspacePaths) {
      try {
        for (const candidate of this.workspacePaths()) {
          if (typeof candidate === 'string' && candidate !== '') candidates.add(candidate)
        }
      } catch (error) {
        this.rootCacheError = `读取本机工作区路径失败：${error?.message ?? error}`
      }
    }
    const roots = []
    for (const candidate of candidates) {
      const resolved = realpathOrNull(candidate)
      if (resolved !== null) roots.push(resolved)
    }
    this.rootCache = roots
    this.rootCacheAt = now
    return roots
  }

  /** 配置变化后让根缓存立刻失效。 */
  invalidateRoots() {
    this.rootCache = null
    this.rootCacheAt = 0
  }

  /**
   * **旧的**导出根门 —— 只在请求没带会话权限时使用。
   *
   * 保留它是为了与老 peer 兼容（它们不发 `sessionMode`）；新版请求走到这里就说明
   * 调用方没把会话权限传下来，那时「按本机导出面放行」是唯一可用的口径。
   * @param {string} resolved 已 realpath 的路径。
   * @returns {void}
   * @throws {ExecError} 403 path-not-exported。
   */
  checkExported(resolved) {
    const roots = this.effectiveRoots()
    if (roots.length === 0) {
      throw new ExecError(
        403,
        '本机没有任何导出的路径可供远端使用（配置 exportRoots，或打开 exportWorkspacePaths）',
        CODE.pathNotExported,
      )
    }
    if (!roots.some((root) => isWithin(root, resolved))) {
      throw new ExecError(403, `路径不在本机导出范围内：${resolved}`, CODE.pathNotExported)
    }
  }

  /**
   * 把请求里的 `workspaceRoot` 解析成可比较的绝对路径。
   * @param {{workspaceRoot?: string}} permission 会话权限。
   * @returns {string|null} 规范根；缺失/非法返回 `null`（**判不了就不放行写**）。
   */
  permissionRoot(permission) {
    const raw = typeof permission?.workspaceRoot === 'string' ? permission.workspaceRoot.trim() : ''
    if (raw === '' || !path.isAbsolute(raw)) return null
    const normalized = path.normalize(raw).replace(/[\\/]+$/, '')
    if (normalized === '') return null
    // 根可能还不存在（工作区刚建）→ 退回词法路径，判定仍是纯字符串、可预测。
    return realpathOrNull(normalized) ?? normalized
  }

  /**
   * 按**会话权限**判定一次落地是否允许。
   *
   * 口径来自用户确认的模型：**会话端设置的会话权限是权威的**，属主侧照它执行。
   *
   * | mode | 读 | 写 |
   * | --- | --- | --- |
   * | `read-only` | 放行 | 403 `session-read-only` |
   * | `workspace-write` | 放行 | 仅 `workspaceRoot` 之下（按路径分段判） |
   * | `danger-full-access` | 放行 | 放行 |
   *
   * `workspace-write` 但 `workspaceRoot` 缺失/非法 → 403（**判不了就拒绝**，绝不放行）。
   *
   * @param {{mode: string, workspaceRoot: string}} permission 会话权限。
   * @param {string} target 目标路径（已归一化；realpath 前后各判一次以挡符号链接逃逸）。
   * @param {{write?: boolean}} [options] 这一次是不是写操作。
   * @returns {void}
   * @throws {ExecError} 403 session-read-only / session-workspace-write。
   */
  checkPermission(permission, target, options = {}) {
    const write = options.write === true
    if (permission?.mode === 'danger-full-access') return
    if (permission?.mode === 'read-only') {
      if (!write) return
      throw new ExecError(403, `会话权限是 read-only，不允许写：${target}`, SESSION_CODE.readOnly)
    }
    // workspace-write（以及在入口层校验过、不该出现的其它值）：读不限、写必须在根内。
    if (!write) return
    const root = this.permissionRoot(permission)
    if (root === null) {
      throw new ExecError(
        403,
        `会话权限是 workspace-write，但请求没带可用的 workspaceRoot，无法判定写范围：${target}`,
        SESSION_CODE.workspaceWrite,
      )
    }
    if (!isWithin(root, target)) {
      throw new ExecError(
        403,
        `会话权限是 workspace-write，只允许写 ${root} 之下：${target}`,
        SESSION_CODE.workspaceWrite,
      )
    }
  }

  /**
   * 这次落地里「什么范围内的路径算数」——给目录列举过滤符号链接条目用。
   *
   * `null` = 不限制（权限模式不按路径收窄）；数组 = 只认这些根。
   * @param {{mode: string, workspaceRoot: string}|undefined} permission 会话权限。
   * @returns {string[]|null} 允许的根。
   */
  allowedRootsFor(permission) {
    if (permission === undefined) return this.effectiveRoots()
    if (permission.mode === 'workspace-write') {
      const root = this.permissionRoot(permission)
      return root === null ? [] : [root]
    }
    return null
  }

  /**
   * 校验目标路径**有权落地**并且真实可用（命令目录 / 目录列举）。
   * @param {unknown} target 请求里的路径。
   * @param {{mode: string, workspaceRoot: string}} [permission] 会话权限（缺省走旧的导出根门）。
   * @param {{write?: boolean}} [options] 这次是不是「跑命令」（默认 true）。目录列举是**读**，
   *   必须传 `write: false` —— 否则 workspace-write 下连列一下工作区之外的目录都会被拒，
   *   而「读任何模式都放行」是这套权限模型的第一条。
   * @returns {string} realpath 后的目标目录。
   * @throws {ExecError} 400 bad-request / 404 path-missing / 403 权限拒绝。
   */
  checkPath(target, permission, options = {}) {
    const write = options.write !== false
    if (typeof target !== 'string' || target.trim() === '' || !path.isAbsolute(target.trim())) {
      throw new ExecError(400, '路径必须是绝对路径', CODE.badRequest)
    }
    const normalized = path.normalize(target.trim())
    // **先判权限、再判存在**：这样 danger-full-access 下一条不存在的路径得到的是
    // 404「不存在」（用户要的答案），而不是一句误导性的权限错误。
    if (permission !== undefined) this.checkPermission(permission, normalized, { write })
    const resolved = realpathOrNull(normalized)
    if (resolved === null) {
      throw new ExecError(404, `目录不存在或不可访问：${target}`, CODE.pathMissing)
    }
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch (error) {
      throw new ExecError(404, `路径不可访问：${error?.message ?? error}`, CODE.pathMissing)
    }
    if (!stat.isDirectory()) {
      throw new ExecError(400, `路径不是目录：${resolved}`, CODE.badRequest)
    }
    // realpath 之后再判一次：符号链接可能把目标带出 workspaceRoot。
    if (permission !== undefined) this.checkPermission(permission, resolved, { write })
    else this.checkExported(resolved)
    return resolved
  }

  /**
   * 校验一个**文件路径**有权落地（允许目标尚不存在）。
   *
   * 与 {@link checkPath} 的分工：那个是「在一个已存在的目录里跑命令」，
   * 这个是「读写一个文件（可能还没创建）」。
   *
   * @param {unknown} target 请求里的路径。
   * @param {{mode: string, workspaceRoot: string}} [permission] 会话权限（缺省走旧的导出根门）。
   * @param {{write?: boolean}} [options] 这一次是不是写操作。
   * @returns {string} 解析后的绝对路径（已存在部分取 realpath）。
   * @throws {ExecError} 400 bad-request / 404 path-missing / 403 权限拒绝。
   */
  checkFsPath(target, permission, options = {}) {
    if (typeof target !== 'string' || target.trim() === '' || !path.isAbsolute(target.trim())) {
      throw new ExecError(400, '路径必须是绝对路径', CODE.badRequest)
    }
    const normalized = path.normalize(target.trim())
    if (permission !== undefined) this.checkPermission(permission, normalized, options)
    // 沿路径往上找到最深的**已存在**祖先：写一个还不存在的文件时，目标自己不存在，
    // 但父目录在。符号链接绕过只能在已存在的那一段上发生，所以解析到那里就够了。
    let probe = normalized
    let resolved = realpathOrNull(probe)
    while (resolved === null) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
      resolved = realpathOrNull(probe)
    }
    if (resolved === null) {
      throw new ExecError(404, `路径不存在或不可访问：${target}`, CODE.pathMissing)
    }
    // 把尚未存在的那一截接回去。它必定不存在，因此没有符号链接可绕过。
    const tail = path.relative(probe, normalized)
    const full = tail === '' ? resolved : path.join(resolved, tail)
    if (permission !== undefined) this.checkPermission(permission, full, options)
    else this.checkExported(full)
    return full
  }

  /**
   * 本机自身发起的执行：解析目标目录，但**不**过远端那两道门（权限/导出根）。
   *
   * 那些门的用途是「约束远端对端」，不是约束本机操作者 —— 本机的人本来就能
   * 直接用出厂 bash 工具在任意目录跑命令，让插件的本机路径反而更严是自欺欺人。
   * 审计仍然照记（本地与远端一条不漏）。
   * @param {unknown} target 请求里的路径。
   * @returns {string} realpath 后的目标目录。
   * @throws {ExecError} 400 bad-request / 404 path-missing。
   */
  resolveLocal(target) {
    if (typeof target !== 'string' || target.trim() === '' || !path.isAbsolute(target.trim())) {
      throw new ExecError(400, '路径必须是绝对路径', CODE.badRequest)
    }
    const resolved = realpathOrNull(path.normalize(target.trim()))
    if (resolved === null) throw new ExecError(404, `路径不存在或不可访问：${target}`, CODE.pathMissing)
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        throw new ExecError(400, `路径不是目录：${resolved}`, CODE.badRequest)
      }
    } catch (error) {
      if (error instanceof ExecError) throw error
      throw new ExecError(404, `路径不可访问：${error?.message ?? error}`, CODE.pathMissing)
    }
    return resolved
  }

  /**
   * 授权门的总判定（不含路径与权限检查，便于 `/api/exec` 先判权限再判路径，
   * 让「没被授权」和「路径不对」在审计里能分开）。
   * @param {{trust: string|null}} node 节点记录（null = 开放模式下的未知节点）。
   * @returns {void}
   * @throws {ExecError} 403 exec-disabled / exec-denied。
   */
  checkAuthority(node) {
    if (!this.config.allowRemoteExec) {
      throw new ExecError(403, '本机未开启跨设备执行（allowRemoteExec=false）', CODE.execDisabled)
    }
    if (this.config.execTrust === 'any-authenticated') return
    if (node === null || node === undefined || node.trust !== 'exec') {
      throw new ExecError(
        403,
        '该设备没有被授予执行权限（在「设备」页把它的信任级别改成 exec，或把 execTrust 设为 any-authenticated）',
        CODE.execDenied,
      )
    }
  }

  /**
   * 跑一条命令。
   *
   * 解析过门之后调用；**不**在这里再判权限（调用方已经判过，避免两处规则漂移）。
   * `permission` 只用于**审计**（记下这次是什么权限跑的），不参与放行。
   * @param {{cwd: string, command: string, timeoutMs?: unknown, actor: string, deviceId: string, deviceName: string, direction: 'in'|'out'|'browser'|'tool', auditPath: string, permission?: {mode: string, workspaceRoot: string}}} options 执行材料。
   * @returns {Promise<object>} 执行结果（含审计 id）。
   */
  async run(options) {
    const requested = Number(options.timeoutMs)
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(100, Math.trunc(requested)), this.config.execTimeoutMs)
      : this.config.execTimeoutMs

    if (this.running >= this.config.execMaxConcurrent) {
      this.refused += 1
      const entry = this.audit.append({
        deviceId: options.deviceId,
        deviceName: options.deviceName,
        direction: options.direction,
        actor: options.actor,
        path: options.auditPath,
        command: truncate(options.command, this.config.execAuditCommandLimit),
        outcome: 'denied',
        code: CODE.execBusy,
        exitCode: null,
        durationMs: 0,
        error: '并发执行数已达上限',
      })
      throw new ExecError(429, `本机同时在跑的执行数已达上限 ${this.config.execMaxConcurrent}`, CODE.execBusy, { auditId: entry.id })
    }

    this.running += 1
    this.peakConcurrent = Math.max(this.peakConcurrent, this.running)
    const startedAt = this.now()
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
    const shellArgs = isWindows ? ['/d', '/s', '/c', options.command] : ['-c', options.command]

    /** 采集结果。 */
    const outcome = {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      spawnError: null,
    }

    let child = null
    try {
      child = spawn(shell, shellArgs, {
        cwd: options.cwd,
        env: process.env,
        // stdin 关闭：远端命令不该等着一个永远不会来的输入而挂住。
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // 自成进程组：这样超时/取消能整棵树一起杀（见 killTree 的说明）。
        // 否则 `sh -c` fork 出来的孙进程会继续持有输出管道，把这次执行钉住。
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      this.running -= 1
      outcome.spawnError = error?.message ?? String(error)
    }

    // 只有**发起方带了 jobId** 的执行才登记：本机自己发起的命令没人会来中止它，
    // 登记它们只会让 cancel 的表面变大。id 的形状与签名头里的 nonce 同一套字符集，
    // 免得把任意字符串塞进查找表。
    const jobKey = typeof options.jobId === 'string' && /^[0-9a-f]{8,64}$/.test(options.jobId.trim())
      ? options.jobId.trim()
      : null
    const jobRecord = jobKey === null || child === null
      ? null
      : { deviceId: options.deviceId, child, cancelled: false }
    if (jobKey !== null && jobRecord !== null) this.active.set(jobKey, jobRecord)

    if (child !== null) {
      const limit = this.config.execOutputLimitBytes
      const collectors = {
        stdout: collect(child.stdout, limit),
        stderr: collect(child.stderr, limit),
      }
      let killTimer = null
      const timer = setTimeout(() => {
        outcome.timedOut = true
        killTree(child, 'SIGTERM')
        // SIGTERM 之后给 2 秒体面退出；还不走就 SIGKILL —— 否则一个忽略 SIGTERM
        // 的子进程会把这次执行钉住，而超时的意义就是「不许钉住」。
        // 两次都按**进程组**发：只杀 sh 会留下持有管道的孙进程（见 killTree）。
        killTimer = setTimeout(() => {
          killTree(child, 'SIGKILL')
        }, 2000)
        killTimer.unref?.()
      }, timeoutMs)
      timer.unref?.()

      await new Promise((resolvePromise) => {
        child.on('error', (error) => {
          outcome.spawnError = error?.message ?? String(error)
          resolvePromise()
        })
        child.on('close', (code, signal) => {
          outcome.exitCode = Number.isSafeInteger(code) ? code : null
          outcome.signal = typeof signal === 'string' ? signal : null
          resolvePromise()
        })
      })
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)

      const out = await collectors.stdout
      const err = await collectors.stderr
      outcome.stdout = out.text
      outcome.stdoutTruncated = out.truncated
      outcome.stderr = err.text
      outcome.stderrTruncated = err.truncated
      // 先读走取消标记再摘牌：cancel() 改的是同一个对象，摘早了就读不到了。
      outcome.cancelled = jobRecord?.cancelled === true
      if (jobKey !== null) this.active.delete(jobKey)
      this.running -= 1
    }

    const durationMs = this.now() - startedAt
    if (outcome.timedOut) this.timedOut += 1
    this.completed += 1

    const ok = outcome.spawnError === null && !outcome.timedOut && outcome.exitCode === 0
    const entry = this.audit.append({
      deviceId: options.deviceId,
      deviceName: options.deviceName,
      direction: options.direction,
      actor: options.actor,
      path: options.auditPath,
      cwd: options.cwd,
      // **当时是什么权限**要进审计：事后追责问的第一个问题就是「它凭什么能写这儿」。
      // 老 peer 不带权限 → 记 null（表示走的是旧的导出根口径）。
      mode: options.permission?.mode ?? null,
      command: truncate(options.command, this.config.execAuditCommandLimit),
      outcome: outcome.spawnError !== null
        ? 'error'
        : (outcome.cancelled ? 'cancelled' : (outcome.timedOut ? 'timeout' : (ok ? 'ok' : 'error'))),
      code: outcome.spawnError !== null
        ? CODE.internal
        : (outcome.cancelled ? 'cancelled' : (outcome.timedOut ? 'timeout' : null)),
      exitCode: outcome.exitCode,
      durationMs,
      error: outcome.spawnError,
      stdoutBytes: outcome.stdout.length,
      stderrBytes: outcome.stderr.length,
    })

    if (outcome.spawnError !== null) {
      throw new ExecError(500, `命令无法启动：${outcome.spawnError}`, CODE.internal, { auditId: entry.id, cwd: options.cwd })
    }

    return {
      auditId: entry.id,
      // 发起方带来的 id 原样回传：它拿这个去发 cancel。
      jobId: jobKey,
      cwd: options.cwd,
      command: options.command,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      durationMs,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
    }
  }

  /**
   * 列一个目录（权限由 permission 决定）。条目数有界；符号链接目录**不**递归展开，
   * 但仍然只列出根内的条目 —— 越界的条目会被过滤掉而不是报错
   * （一个目录里混着链接是常态，整目录报错没法用）。
   * @param {string} target 目标目录（绝对路径）。
   * @returns {object} 列表结果。
   * @throws {ExecError} 权限/存在性错误。
   */
  list(target, permission) {
    // 目录列举是**读**：`write: false`（读在任何模式下都放行；写范围只用来过滤条目的符号链接）。
    const resolved = this.checkPath(target, permission, { write: false })
    const roots = this.allowedRootsFor(permission)
    let entries
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true })
    } catch (error) {
      throw new ExecError(500, `读取目录失败：${error?.message ?? error}`, CODE.internal)
    }
    const limit = this.config.listLimit
    const rows = []
    let truncated = false
    for (const entry of entries) {
      if (rows.length >= limit) {
        truncated = true
        break
      }
      const full = path.join(resolved, entry.name)
      let isDir = entry.isDirectory()
      // 目录符号链接：报告它是不是目录，但**不**跟随越界的链接。
      // `roots === null` = 权限模式不按路径收窄（read-only / danger-full-access）。
      if (entry.isSymbolicLink()) {
        const real = realpathOrNull(full)
        if (real === null) continue
        if (roots !== null && !roots.some((root) => isWithin(root, real))) continue
        try {
          isDir = fs.statSync(real).isDirectory()
        } catch {
          continue
        }
      }
      rows.push({ name: entry.name, path: full, dir: isDir })
    }
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)))
    const parent = path.dirname(resolved)
    const parentAllowed = roots === null ? true : roots.some((root) => isWithin(root, parent))
    return {
      path: resolved,
      parent: parentAllowed ? parent : null,
      roots: roots ?? [],
      entries: rows,
      truncated,
    }
  }

  /** 诊断。 */
  /**
   * 中止一条**正在跑**的命令。
   *
   * 这是「远端命令跑飞了只能干等超时」的解药：发起方在本机中止时发一条 cancel 请求，
   * 本机按 id 找到子进程，走与超时**完全相同**的那条路（SIGTERM → 2 秒 → SIGKILL）。
   *
   * 失败一律返回结构化结果、不抛错：cancel 是收尾动作，它自己失败不该把「中止」
   * 升级成一个更响的错误，掩盖掉本来要报告的那件事。
   *
   * @param {string} jobId 发起方在执行请求里带来的 id。
   * @param {string} deviceId 发起方设备 id；必须是登记这条命令的那一台。
   * @returns {{ok: true} | {ok: false, code: string}} 结果。
   */
  cancel(jobId, deviceId) {
    const key = typeof jobId === 'string' ? jobId.trim() : ''
    if (key === '') return { ok: false, code: CODE.badRequest }
    const job = this.active.get(key)
    // unknown-job 多数是正常竞态：命令恰好在 cancel 到达之前自己跑完、登记已摘牌。
    // 把它当错误去报会制造大量假警报，所以只如实回码。
    if (job === undefined) return { ok: false, code: CODE.unknownJob }
    if (job.deviceId !== deviceId) return { ok: false, code: CODE.notYours }
    job.cancelled = true
    this.cancelled += 1
    // 与超时走同一条路：按**进程组**杀，否则 `sh -c` fork 出来的孙进程会继续
    // 持有输出管道，让发起方那条请求一直挂到孙进程自己退出。
    killTree(job.child, 'SIGTERM')
    const killTimer = setTimeout(() => {
      killTree(job.child, 'SIGKILL')
    }, 2000)
    killTimer.unref?.()
    return { ok: true }
  }

  stats() {
    return {
      allowRemoteExec: this.config.allowRemoteExec,
      execTrust: this.config.execTrust,
      exportRoots: this.config.exportRoots,
      exportWorkspacePaths: this.config.exportWorkspacePaths,
      effectiveRoots: this.effectiveRoots(),
      rootsError: this.rootCacheError,
      running: this.running,
      // `peakConcurrent` 是观测到的峰值；`limits.maxConcurrent` 才是配置的上限。
      // 曾把两者都叫 maxConcurrent —— 那会让人把「峰值 0」读成「上限 0」。
      peakConcurrent: this.peakConcurrent,
      completed: this.completed,
      refused: this.refused,
      timedOut: this.timedOut,
      // 被远端 cancel 掉的条数，以及当前登记在册、还能被 cancel 的执行数。
      cancelled: this.cancelled,
      active: this.active.size,
      limits: {
        timeoutMs: this.config.execTimeoutMs,
        outputLimitBytes: this.config.execOutputLimitBytes,
        maxConcurrent: this.config.execMaxConcurrent,
      },
    }
  }
}

/**
 * 起一个带字节上限的采集器。
 *
 * 超过上限后**继续消费**并丢弃：停止读取会让子进程的管道写满而永久阻塞，
 * 那就把「输出被截断」变成了「命令挂死」。返回的 Promise 在流结束时 resolve。
 * @param {import('node:stream').Readable|null} stream 子进程流。
 * @param {number} limit 字节上限。
 * @returns {Promise<{text: string, truncated: boolean}>} 采集结果。
 */
function collect(stream, limit) {
  return new Promise((resolvePromise) => {
    if (stream === null || stream === undefined) {
      resolvePromise({ text: '', truncated: false })
      return
    }
    const chunks = []
    let size = 0
    let truncated = false
    stream.on('data', (chunk) => {
      if (size >= limit) {
        truncated = true
        return
      }
      const remaining = limit - size
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        size = limit
        truncated = true
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    const done = () => resolvePromise({ text: Buffer.concat(chunks).toString('utf8'), truncated })
    stream.on('end', done)
    stream.on('close', done)
    stream.on('error', done)
  })
}

/**
 * 有界截断（用于审计里的命令正文）。
 * @param {string} value 原文。
 * @param {number} limit 字符上限。
 * @returns {string} 截断后的文本。
 */
function truncate(value, limit) {
  if (typeof value !== 'string') return ''
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…（共 ${value.length} 字符）`
}
