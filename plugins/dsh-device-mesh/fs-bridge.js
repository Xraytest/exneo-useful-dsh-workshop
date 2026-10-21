/**
 * dsh-device-mesh — 路由型 `ctx.fs`（把文件操作按路径发到子节点执行）。
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────────────────
 * 命令下沉之后，如果文件工具还在主机上跑，模型的世界观就自相矛盾了：它用 `bash` 在
 * 子节点上 `ls`，又用 `read` 去读主机的同名路径。所以文件系统必须跟着一起下沉。
 *
 * DSH 里所有文件访问都汇到 `ctx.fs`（`@deepseek-ai/dsh-fs` 的 `FileSystem` 抽象服务）：
 * `read`/`write`/`edit` 工具、技能目录、AGENTS.md 说明文件、GUI 文件页……全都走它。
 * 和 shell 一样，**同一个 context 只能有一个实现**，所以还是同一套路：
 *
 *   · 组合里 disable 掉出厂的 `fs-sandbox` 行；
 *   · 本插件注册自己的实现；
 *   · 在**隔离 realm** 里构造一份出厂实现当委托对象，本机路径的请求原样交给它。
 *
 * ── 哪些方法不需要过网 ──────────────────────────────────────────────────────
 * 契约里的 13 个抽象方法并不是 13 次往返。只有 6 个真的碰数据：
 *
 *   stat / lstat / readText / streamText / readBytes / readByteRange / listDir /
 *   writeText / editText
 *
 * 而 `resolve` / `processPath` / `fileUrl` / `contains` 全是**纯本地计算**——目标是我们
 * 自己铸造的，路径就在 targetKey 里，判包含关系用分段前缀比较即可（见 routing.js）。
 * 少一次往返就少一次超时与失败面。
 *
 * ── 目标铸造 ────────────────────────────────────────────────────────────────
 * `FsTarget` 对消费者是不透明的，但契约把「铸造权」给了 backend（"a consumer never
 * manufactures a key, it receives one from resolve()"）。我们铸成
 * `mesh:<deviceId>:<绝对路径>`：设备与路径都可从它无损还原，于是**不需要额外的映射表**，
 * 也就不会出现「重启后映射丢失、目标变成孤儿」这种状态。
 *
 * ── 互联会话：这条路径属于哪个会话 ──────────────────────────────────────────
 * 同一个工作区可以「会话跑在这台、文件与命令落在属主那台」（互联会话）。判定这条
 * 会话的文件访问该去哪，依据**只有**一个：调用方传进来的 `cwd`（出厂 `dsh-tool-fs`
 * 传的是 `exec.agent.session.header.cwd`）。目标路径**不参与**反推归属 —— 那会自证
 * 循环（路径在远端 ⇒ 所以是互联会话 ⇒ 所以发到远端）。
 *
 * 策略来自 `workspaceRoles[path].mesh`（见 routing.js 的 `routePathWithPolicy`）：
 *   · `mesh: true` —— 互联会话工作区：工作区之外的路径**一律转发到声明的属主**；
 *     属主解析不出来就**拒绝**（denied），**绝不回落到本机** —— 回落就是静默读到
 *     会话端自己的文件，那正是这套策略要消灭的缺陷；
 *   · `mesh` 缺省 —— 纯本地工作区：一律本机，即使路径命中远端主路径也不转发
 *     （唯一例外是人手工钉的附加路径 member）。
 *
 * 没有策略（老部署、或没声明任何工作区）时判定逐字退回 `routePath()` 的老语义。
 *
 * ── v1 的诚实边界 ───────────────────────────────────────────────────────────
 *   · `watch()` 对远端目标**明确拒绝**（沿用出厂基类对「不支持观察的 provider」的语义）：
 *     本机没法直接观察对端的文件系统，假装能观察只会让 GUI 静默不刷新。本地目标照常
 *     委托，所以本地工作区的文件页不受影响。
 *   · `processPathFromHostPath()` 对远端路径返回 `undefined`——这正是契约里
 *     「这个执行世界读不到那个主机文件」的表达。
 *   · 远端写入**不把主机的 sandboxPolicy 传过去**：沙箱是执行地自己的事，主机替对端
 *     决定它该用什么策略是越权的。对端按自己的策略执行。
 *
 * @module dsh-device-mesh/fs-bridge
 */

import { pathToFileURL } from 'node:url'
import { isAbsolute, join, normalize } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { resolveConfig } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { API } from './protocol.js?v=mesh-31'
import { collectPathOwners, isWithinRoute, normalizeRoutePath, routePathWithPolicy } from './routing.js?v=mesh-31'

/** 远端目标键的前缀。改它等于换协议——两端必须同时换。 */
const TARGET_PREFIX = 'mesh:'

/**
 * 目标 → 会话权限。
 *
 * 为什么要这张表：权限是在 `decide(path, cwd)` 那一刻算出来的（那时才知道会话 cwd），
 * 而真正发请求是在后面的 `readText(target)` / `writeText(target)` 里 —— 那时手里
 * 只有目标对象。用 WeakMap 挂在目标对象上：目标被回收时权限一起走，也不会污染
 * 出厂目标的形状（它是 WeakMap 的键，不是自有字段）。
 */
const TARGET_PERMISSIONS = new WeakMap()

/**
 * 铸造一个远端目标。
 * @param {string} deviceId 归属设备。
 * @param {string} absPath 归一化后的绝对路径。
 * @param {{mode: string, workspaceRoot: string}} [permission] 会话权限（有就跟着目标走）。
 * @returns {{targetKey: string, displayPath: string}} 目标。
 */
function mintTarget(deviceId, absPath, permission) {
  const target = { targetKey: FsTargetKey(`${TARGET_PREFIX}${deviceId}:${absPath}`), displayPath: absPath }
  if (permission !== undefined && permission !== null && typeof permission.mode === 'string') {
    TARGET_PERMISSIONS.set(target, permission)
  }
  return target
}

/**
 * 从一个目标里还原「设备 + 路径」；不是本 backend 铸造的返回 `undefined`。
 * @param {object} target 目标。
 * @returns {{deviceId: string, path: string, permission?: object}|undefined} 还原结果。
 */
function parseTarget(target) {
  const key = target === null || target === undefined ? '' : String(target.targetKey ?? '')
  if (!key.startsWith(TARGET_PREFIX)) return undefined
  const rest = key.slice(TARGET_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return undefined
  const permission = target !== null && typeof target === 'object' ? TARGET_PERMISSIONS.get(target) : undefined
  return { deviceId: rest.slice(0, sep), path: rest.slice(sep + 1), ...permission !== undefined ? { permission } : {} }
}

/** 路由型 `ctx.fs` 的实现（普通类，由 `mountFsRouting` 显式发布）。 */
export class MeshFileSystem {
  /**
   * @param {object} options 依赖注入。
   * @param {object} options.delegate 已构造好的出厂实现（本机路径全部交给它）。
   * @param {boolean} options.sandboxed 委托是否带沙箱。
   * @param {boolean} options.enabled 初始是否开启路由。
   * @param {() => object[]} options.groups 同步返回 buildPathGroups() 的路径组视图。
   * @param {string} options.selfDeviceId 本机设备 id。
   * @param {object} options.caller 网格 Caller（真正的签名传输）。
   * @param {string} options.fallbackCwd 没有 cwd 时的兜底基准目录。
   * @param {object} [options.logger] 日志器。
   */
  constructor(options) {
    /** @type {object} 隔离 realm 里的出厂实现。 */
    this.localDelegate = options.delegate
    /** @type {boolean} */
    this.sandboxed = options.sandboxed === true
    /**
     * @type {() => object[]}
     * 路径组视图的提供者。**刻意收 group 视图而不是摊平后的归属列表**：
     * 后者容易被调用方直接传成 buildPathGroups() 的结果，而那种错法不会报错——
     * 只会让 matchOwner 永远匹配不上、静默把全部请求判成本机。摊平放在这里做，
     * 调用方就没有机会传错。
     */
    this.groupsProvider = options.groups
    /** @type {string} */
    this.selfDeviceId = options.selfDeviceId
    /** @type {object} */
    this.caller = options.caller
    /** @type {string} */
    this.fallbackCwd = options.fallbackCwd
    /** @type {object|undefined} */
    this.meshLogger = options.logger
    /**
     * @type {(() => (object|undefined))|undefined}
     * 工作区策略的**提供者**（可选）。每次判定现取一次、不缓存：配置可以在运行期改
     * （UI 里切换「作为互联会话」），设备名 → id 的表也随节点接入/退出变化；缓存一份
     * 会让「刚改了配置却还是老行为」表现为一次静默的错误路由。
     *
     * 返回 `undefined` = 没有策略（老部署、或没声明任何工作区）→ 判定与改动前逐字一致。
     */
    this.workspacePolicyProvider = options.workspacePolicy
    /**
     * @type {((cwd: unknown) => (object|undefined))|undefined}
     * **会话权限**解析器（会话端提供）。每一次转发都会被问一次：这个 cwd 上的会话是什么
     * 权限？返回 undefined = 不带权限，属主按旧的导出根口径裁决（**绝不因此放行**）。
     */
    this.permissionFor = options.permissionFor
    /** @type {boolean} */
    this.routingEnabled = options.enabled !== false
    /** @type {{routed: number, local: number, failed: number, denied: number}} */
    this.counters = { routed: 0, local: 0, failed: 0, denied: 0, permissionWith: 0, permissionWithout: 0 }
  }

  /** 沙箱能力事实：如实反映出厂实现。 */
  get sandboxMode() {
    return this.localDelegate.sandboxMode
  }

  /** 路由是否开着。 */
  get enabled() {
    return this.routingEnabled
  }

  /**
   * 运行时开关路由（关闭后所有文件访问都在本机落地）。
   * @param {boolean} value 新状态。
   * @returns {void}
   */
  setEnabled(value) {
    this.routingEnabled = value === true
  }

  /** 路由统计。 */
  stats() {
    return { ...this.counters, enabled: this.routingEnabled, sandboxed: this.sandboxed }
  }

  /**
   * 把调用方给的路径归一成绝对路径（**纯词法**，不碰磁盘）。
   *
   * 刻意不做 realpath：远端路径在本机可能根本不存在，`realpath` 会直接失败；
   * 而且判定归属本来就是纯字符串问题。真伪与符号链接交给落地那一端（本机则是委托实现）。
   *
   * @param {string} path 调用方给的路径。
   * @param {string} [cwd] 基准目录。
   * @returns {string|undefined} 归一化绝对路径；非法输入返回 `undefined`。
   */
  absolutize(path, cwd) {
    if (typeof path !== 'string' || path.trim() === '') return undefined
    const base = typeof cwd === 'string' && cwd !== '' ? cwd : this.fallbackCwd
    const joined = isAbsolute(path) ? path : join(base, path)
    return normalizeRoutePath(normalize(joined))
  }

  /**
   * 取一次工作区策略视图。
   *
   * 三种结果语义完全不同，调用方必须分开处理：
   *   · `undefined` —— 没有策略（提供者缺席，或它说「没声明任何工作区」）。这是
   *     **刻意的向后兼容**：判定退回 `routePath()` 的老语义，老部署行为逐字不变；
   *   · `{policy, resolveOwner}` —— 正常策略；
   *   · `{error}` —— 提供者抛了。**失败关闭**：读不到策略时唯一能确定的事实是
   *     「不知道这条路径该落在哪」，而互联会话下「不知道」等价于「可能读到会话端
   *     自己的文件」，所以不能当作「没有策略」放行。
   *
   * @returns {{policy: object, resolveOwner: Function}|{error: string}|undefined} 视图。
   */
  policyView() {
    if (typeof this.workspacePolicyProvider !== 'function') return undefined
    try {
      const view = this.workspacePolicyProvider()
      return view === null || view === undefined ? undefined : view
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.meshLogger?.warn?.(`dsh-device-mesh: 读取工作区策略失败，文件访问按拒绝处理：${message}`)
      return { error: `工作区策略读取失败：${message}` }
    }
  }

  /**
   * 把「拒绝落地」翻成 `FsError`。
   *
   * 用 `FS_PERMISSION_DENIED` 而**不是** `FS_SANDBOX_DENIED`：出厂 `dsh-tool-fs` 对后者
   * 有特殊处理——它会替换掉异常文案，改成「file access denied under <mode> mode」并
   * 附一句「可以申请提权」。那个提示在这里是错的（拒绝来自网格的工作区策略，不是
   * 沙箱模式，提权也解决不了），而且会把真正有用的原因（哪个工作区、缺什么声明）
   * 冲掉。`FS_PERMISSION_DENIED` 只被会话控制器映射成 HTTP 403，文案原样到模型面前。
   *
   * @param {{reason: string, path?: string}} decision 判定。
   * @returns {FsError} 错误。
   */
  deniedError(decision) {
    const where = typeof decision.path === 'string' && decision.path !== '' ? decision.path : '(未指定路径)'
    return new FsError(
      `互联会话只允许在属主设备上落地：${decision.reason}（目标 ${where}）`,
      'FS_PERMISSION_DENIED',
    )
  }

  /**
   * 判定一条路径该在哪台设备上落地。
   * @param {string} path 调用方给的路径。
   * @param {string} [cwd] 基准目录，同时也是**会话归属**的依据（见文件头）。
   * @returns {{kind: 'local'}|{kind: 'remote', deviceId: string, root: string, path: string}|{kind: 'denied', reason: string, path: string}} 判定。
   */
  decide(path, cwd) {
    const abs = this.absolutize(path, cwd)
    if (abs === undefined) return { kind: 'local' }
    if (!this.routingEnabled) return { kind: 'local' }
    const policyView = this.policyView()
    if (policyView !== undefined && typeof policyView.error === 'string') {
      this.counters.denied += 1
      return { kind: 'denied', reason: policyView.error, path: abs }
    }
    const decision = routePathWithPolicy(abs, {
      owners: collectPathOwners(this.groupsProvider()),
      selfDeviceId: this.selfDeviceId,
      policy: policyView?.policy,
      // cwd **原样**传：它是「这条路径属于哪个会话 / 哪个工作区」的唯一依据。
      //
      // 读类与写类工具都给得到**会话 cwd**，这一点 2026-10-17 在节点上核过：
      //   · 读（`resolveRegularReadTarget`）传 `sessionCwd(exec)`；
      //   · 写 / 编辑传 `sandboxPolicy.workspaceRoot`，而它在**会话内**就等于
      //     `session.header.cwd`（`dsh-sandbox-policy` 的 `resolve()`：
      //     `session?.header.cwd ?? this.workspaceRoot`）—— 部署默认根只对
      //     **无会话**调用生效，那种调用本来也没有会话可归属。
      // 所以两类工具都能归属到工作区；曾经担心「写类工具归属不到」是误判。
      cwd,
      resolveOwner: policyView?.resolveOwner,
    })
    if (decision.route.kind === 'denied') {
      this.counters.denied += 1
      return { kind: 'denied', reason: decision.route.reason, path: abs }
    }
    if (decision.route.kind !== 'remote') return { kind: 'local' }
    // 会话权限：**只对远端转发有意义**（本机落地由本机自己的沙箱策略管）。
    const permission = this.resolvePermission(cwd)
    return { kind: 'remote', deviceId: decision.route.deviceId, root: decision.route.root, path: abs, permission }
  }

  /**
   * 取一次**会话权限**（会话端提供）。
   *
   * 三种结果：`{mode, workspaceRoot}` = 正常；`undefined` = 提供者缺席、或它说「查不到」
   * —— 这时**不带权限**，属主按旧的导出根口径裁决（刻意的向后兼容，不是放行）；
   * 提供者抛错也返回 `undefined`（**绝不因为取权限失败而自己决定给什么权限**：
   * 权限的权威是会话端，会话端说不出来就交给属主按自己的规矩办）。
   *
   * @param {unknown} cwd 会话 cwd（请求的基准目录）。
   * @returns {{mode: string, workspaceRoot: string}|undefined} 权限。
   */
  resolvePermission(cwd) {
    if (typeof this.permissionFor !== 'function') {
      this.counters.permissionWithout += 1
      return undefined
    }
    let permission
    try {
      permission = this.permissionFor(cwd)
    } catch (error) {
      this.meshLogger?.warn?.(`dsh-device-mesh: 取会话权限失败，本次转发不带权限：${error instanceof Error ? error.message : String(error)}`)
      permission = undefined
    }
    if (permission !== undefined && permission !== null && typeof permission.mode === 'string' && permission.mode !== '') {
      this.counters.permissionWith += 1
      return permission
    }
    this.counters.permissionWithout += 1
    return undefined
  }

  /**
   * 发一条远端原语请求并把 `failed` 信封翻译回 `FsError`。
   *
   * 对端把文件系统层面的失败以 `{failed:true, fsCode, message}` 的 200 回传（见
   * fs-inbound.js 的说明），在这里重建同码 FsError——上层靠 code 分支，不解析文案。
   *
   * @param {{deviceId: string, path: string, permission?: object}} target 归属（带会话权限）。
   * @param {string} route 协议路由。
   * @param {object} body 请求体。
   * @returns {Promise<object>} 对端返回的 json。
   */
  async callRemote(target, route, body) {
    try {
      const { json } = await this.caller.request({
        deviceId: target.deviceId,
        targetPath: target.path,
        route,
        body,
        // 会话权限跟着**每一次**转发走：属主按它放行或拒绝（见 exec.js 的 checkPermission）。
        permission: target.permission,
      })
      if (json.failed === true) {
        throw new FsError(String(json.message ?? '远端文件操作失败'), typeof json.fsCode === 'string' ? json.fsCode : 'FS_IO_ERROR')
      }
      return json
    } catch (error) {
      this.counters.failed += 1
      if (error instanceof FsError) throw error
      // 传输层问题（没有接入点、签名失败、超时）——如实包成 FsError，让上层看到的是
      // 「这个文件操作失败了」而不是一个裸的网络异常。
      throw new FsError(
        `远端文件操作失败（${target.deviceId}）：${error instanceof Error ? error.message : String(error)}`,
        'FS_IO_ERROR',
        { cause: error },
      )
    }
  }

  /**
   * 统计一次远端落地。
   * @returns {void}
   */
  countRemote() {
    this.counters.routed += 1
  }

  /** 统计一次本机落地。 */
  countLocal() {
    this.counters.local += 1
  }

  // ── 解析与身份 ────────────────────────────────────────────────────────────

  /**
   * 解析一个路径为稳定目标。
   * @param {string} path 路径。
   * @param {{cwd?: string, signal?: AbortSignal}} [opts] 选项。
   * @returns {Promise<object>} 目标。
   */
  async resolve(path, opts = {}) {
    const decision = this.decide(path, opts.cwd)
    // 拒绝**不是**本地：静默落到本机就等于「互联会话读到了会话端自己的文件」，
    // 那正是这套策略要消灭的缺陷。必须抛，并且抛得让模型看懂原因（缺声明 / 属主
    // 解析不出来），而不是一个光秃秃的 IO 错误。
    if (decision.kind === 'denied') throw this.deniedError(decision)
    if (decision.kind === 'local') {
      this.countLocal()
      return this.localDelegate.resolve(path, opts)
    }
    this.countRemote()
    return mintTarget(decision.deviceId, decision.path, decision.permission)
  }

  /**
   * 一个目标在它自己的执行世界里可被打开的绝对路径。
   * @param {object} target 目标。
   * @returns {string} 绝对路径。
   */
  processPath(target) {
    const remote = parseTarget(target)
    return remote === undefined ? this.localDelegate.processPath(target) : remote.path
  }

  /**
   * 把主机绝对路径映射到本执行世界；远端世界里读不到主机文件，如实返回 `undefined`。
   * @param {string} hostPath 主机绝对路径。
   * @returns {string|undefined} 映射结果。
   */
  processPathFromHostPath(hostPath) {
    return this.localDelegate.processPathFromHostPath(hostPath)
  }

  /**
   * 目标的 `file:` URI。
   * @param {object} target 目标。
   * @returns {string} URI。
   */
  fileUrl(target) {
    const remote = parseTarget(target)
    return remote === undefined ? this.localDelegate.fileUrl(target) : pathToFileURL(remote.path).href
  }

  /**
   * 判断包含关系。跨执行世界一律 `false`——远端目录不可能包含本机文件。
   * @param {object} parent 父目标。
   * @param {object} child 子目标。
   * @returns {boolean} 是否包含。
   */
  contains(parent, child) {
    const p = parseTarget(parent)
    const c = parseTarget(child)
    if (p === undefined && c === undefined) return this.localDelegate.contains(parent, child)
    if (p === undefined || c === undefined) return false
    return p.deviceId === c.deviceId && isWithinRoute(p.path, c.path)
  }

  /**
   * 观察一个目标。远端目标明确拒绝：本机观察不了对端的文件系统，
   * 假装支持只会让 GUI 静默不刷新。
   * @param {object} target 目标。
   * @param {Function} changed 失效回调。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<Function>} 关闭函数。
   */
  watch(target, changed, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) return this.localDelegate.watch(target, changed, signal)
    signal?.throwIfAborted?.()
    return Promise.reject(new FsError(
      '远端工作路径不支持文件观察：本机无法直接观察对端的文件系统。'
      + '需要实时刷新请在子节点上直接打开该工作区。',
      'FS_IO_ERROR',
    ))
  }

  // ── 元数据 ────────────────────────────────────────────────────────────────

  /**
   * 目标元数据（跟随符号链接）。
   * @param {object} target 目标。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<object|undefined>} 元数据，缺席为 `undefined`。
   */
  async stat(target, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.stat(target, signal)
    }
    this.countRemote()
    const { info } = await this.callRemote(remote, API.fsStat, { path: remote.path })
    if (info === undefined || info.exists !== true) return undefined
    const out = { version: FsVersion(String(info.version)), type: info.type }
    if (Number.isFinite(info.size)) out.size = info.size
    return out
  }

  /**
   * 路径元数据（不跟随符号链接）。
   * @param {string} path 路径。
   * @param {{cwd?: string}} [opts] 选项。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<object|undefined>} 元数据，缺席为 `undefined`。
   */
  async lstat(path, opts = {}, signal) {
    const decision = this.decide(path, opts.cwd)
    // 与 resolve() 同一道门：拒绝必须抛，不能静默变成本机的 lstat。
    if (decision.kind === 'denied') throw this.deniedError(decision)
    if (decision.kind === 'local') {
      this.countLocal()
      return this.localDelegate.lstat(path, opts, signal)
    }
    this.countRemote()
    const { info } = await this.callRemote(decision, API.fsLstat, { path: decision.path })
    if (info === undefined || info.exists !== true) return undefined
    const out = { version: FsVersion(String(info.version)), type: info.type }
    if (Number.isFinite(info.size)) out.size = info.size
    return out
  }

  // ── 读 ────────────────────────────────────────────────────────────────────

  /**
   * 读整个文件为文本。
   * @param {object} target 目标。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<string>} 文本。
   */
  async readText(target, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.readText(target, signal)
    }
    this.countRemote()
    const { text } = await this.callRemote(remote, API.fsRead, { path: remote.path, mode: 'text' })
    return typeof text === 'string' ? text : ''
  }

  /**
   * 流式读文本。远端一次性取回后按**单块**产出：这一版传输没有分块协议，
   * 假造多块只是把一次往返装扮成流式，对调用方没有任何好处。
   * @param {object} target 目标。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<AsyncIterable<string>>} 文本流。
   */
  async streamText(target, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.streamText(target, signal)
    }
    const text = await this.readText(target, signal)
    return (async function* single() { yield text })()
  }

  /**
   * 读字节（带上限）。
   * @param {object} target 目标。
   * @param {AbortSignal|undefined} signal 取消信号。
   * @param {number} maxBytes 上限。
   * @returns {Promise<Uint8Array>} 字节。
   */
  async readBytes(target, signal, maxBytes) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.readBytes(target, signal, maxBytes)
    }
    this.countRemote()
    const { base64 } = await this.callRemote(remote, API.fsRead, { path: remote.path, mode: 'bytes', maxBytes })
    return Uint8Array.from(Buffer.from(typeof base64 === 'string' ? base64 : '', 'base64'))
  }

  /**
   * 读字节窗口。
   * @param {object} target 目标。
   * @param {{offset: number, length: number}} range 窗口。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<Uint8Array>} 字节。
   */
  async readByteRange(target, range, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.readByteRange(target, range, signal)
    }
    this.countRemote()
    const { base64 } = await this.callRemote(remote, API.fsRead, {
      path: remote.path,
      mode: 'bytes',
      offset: range?.offset,
      length: range?.length,
    })
    return Uint8Array.from(Buffer.from(typeof base64 === 'string' ? base64 : '', 'base64'))
  }

  /**
   * 列目录的直接子项。子目标的铸造在本机完成（不走网）。
   * @param {object} target 目标。
   * @param {AbortSignal} [signal] 取消信号。
   * @returns {Promise<object[]>} 子项。
   */
  async listDir(target, signal) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.listDir(target, signal)
    }
    this.countRemote()
    const { entries } = await this.callRemote(remote, API.fsListDir, { path: remote.path })
    const base = remote.path === '/' ? '' : remote.path
    return (Array.isArray(entries) ? entries : []).map((entry) => {
      const name = String(entry?.name ?? '')
      const out = { name, type: typeof entry?.type === 'string' ? entry.type : 'other', target: mintTarget(remote.deviceId, `${base}/${name}`, remote.permission) }
      if (Number.isFinite(entry?.size)) out.size = entry.size
      if (typeof entry?.version === 'string') out.version = FsVersion(entry.version)
      return out
    })
  }

  // ── 写 ────────────────────────────────────────────────────────────────────

  /**
   * 写文本（可带守卫意图）。
   * @param {object} target 目标。
   * @param {string} content 内容。
   * @param {object} [expected] 守卫意图。
   * @param {AbortSignal} [signal] 取消信号。
   * @param {object} [_sandboxPolicy] 忽略：沙箱是执行地自己的事（见文件头）。
   * @returns {Promise<object>} 写结果。
   */
  async writeText(target, content, expected, signal, _sandboxPolicy) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.writeText(target, content, expected, signal, _sandboxPolicy)
    }
    this.countRemote()
    const wire = expected === undefined || expected === null
      ? undefined
      : {
        kind: expected.kind,
        ...(expected.version === undefined ? {} : { version: String(expected.version) }),
      }
    const out = await this.callRemote(remote, API.fsWrite, { path: remote.path, content, expected: wire })
    return { operation: out.operation, version: FsVersion(String(out.version)), before: out.before ?? null, after: out.after ?? null }
  }

  /**
   * 字面量替换（服务端读-改-写）。
   * @param {object} target 目标。
   * @param {{oldString: string, newString: string, replaceAll: boolean}} edit 编辑。
   * @param {{version: object}} [expected] 版本守卫。
   * @param {AbortSignal} [signal] 取消信号。
   * @param {object} [_sandboxPolicy] 忽略：沙箱是执行地自己的事（见文件头）。
   * @returns {Promise<object>} 编辑结果。
   */
  async editText(target, edit, expected, signal, _sandboxPolicy) {
    const remote = parseTarget(target)
    if (remote === undefined) {
      this.countLocal()
      return this.localDelegate.editText(target, edit, expected, signal, _sandboxPolicy)
    }
    this.countRemote()
    const out = await this.callRemote(remote, API.fsEdit, {
      path: remote.path,
      oldString: edit?.oldString,
      newString: edit?.newString,
      replaceAll: edit?.replaceAll === true,
      expectedVersion: expected?.version === undefined ? undefined : String(expected.version),
    })
    return { version: FsVersion(String(out.version)), before: out.before ?? '', after: out.after ?? '' }
  }
}

/**
 * 在隔离 realm 里构造出厂实现，作为本机文件访问的委托对象。
 *
 * 有 `sandboxPolicy` 服务就用沙箱实现（否则会因为缺依赖在构造时抛），没有则退回
 * 朴素本地实现。两者构造签名一致：`(ctx, config)`。
 *
 * 配置必须走一遍**出厂 schema 的解析**——出厂代码读的是活值（`config.cwd.get()` 之类），
 * 直接喂普通对象会在第一次访问配置时炸。`resolveConfig` 只用 `runtime.Config` 一个字段，
 * 所以把类本身当 runtime 传即可。
 *
 * @param {object} ctx 插件上下文。
 * @returns {{delegate: object, sandboxed: boolean}} 委托与是否沙箱。
 */
export function createLocalFsDelegate(ctx) {
  const sandboxed = ctx.get('sandboxPolicy') !== undefined
  const delegateCtx = ctx.isolate('fs', 'dsh-device-mesh:local-fs')
  const DelegateClass = sandboxed ? SandboxedFileSystem : LocalFileSystem
  return { delegate: new DelegateClass(delegateCtx, resolveConfig(DelegateClass, {})), sandboxed }
}

/**
 * 挂载路由型 `ctx.fs`。
 *
 * 调用方必须已经在组合里 disable 掉出厂的 `fs-sandbox` 行，否则 `ctx.provide` 会因为
 * 「服务已被占用」当场抛错——这是刻意的，宁可装载失败也不要两个实现各跑一半。
 *
 * 与 shell 一样用 `ctx.inject` 拿装配好的子 context 来构造委托（Cordis 不允许未声明
 * `inject` 就取 `ctx.sandboxPolicy`），并同步返回门面给配置处理器。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} options 依赖。
 * @param {object} options.config 归一化配置。
 * @param {() => object[]} options.groups 同步返回 `buildPathGroups()` 结果。
 * @param {object} options.caller 网格 Caller。
 * @param {string} options.selfDeviceId 本机设备 id。
 * @param {() => (object|undefined)} [options.workspacePolicy] 工作区策略提供者（互联会话判定用，见文件头）。
 * @param {object} [options.logger] 日志器。
 * @returns {{setEnabled: Function, stats: Function, ready: Function}} 同步门面。
 */
export function mountFsRouting(ctx, options) {
  const { config, groups, caller, selfDeviceId, logger, workspacePolicy, permissionFor } = options
  const sandboxed = ctx.get('sandboxPolicy') !== undefined
  const deps = sandboxed ? ['sandboxPolicy'] : []

  /** @type {object|undefined} */
  let service
  let wantedEnabled = config.routeExecByPath === true

  const build = (childCtx) => {
    const { delegate } = createLocalFsDelegate(childCtx)
    service = new MeshFileSystem({
      delegate,
      sandboxed,
      enabled: wantedEnabled,
      groups,
      selfDeviceId,
      caller,
      fallbackCwd: process.cwd(),
      logger,
      // **必须显式转交**：策略只收在 mountFsRouting 的入参里，MeshFileSystem 拿不到，
      // 漏掉这一步的症状是「互联会话开关配好了、行为却完全没变」—— 静默回到本机路由。
      workspacePolicy,
      permissionFor,
    })
    // 先建满再发布：依赖方可能在 provide 的同一瞬间就来读 sandboxMode。
    childCtx.provide('fs', service)
    logger?.info?.(
      `dsh-device-mesh: ctx.fs 已接管（${sandboxed ? '沙箱' : '朴素'}本地委托）；`
      + `文件路由${service.enabled ? '开' : '关'}`
      + `${service.enabled ? '——落在子节点工作路径上的文件访问将发到那台执行' : '（routeExecByPath=false，全部本机访问）'}`,
    )
    return () => { service = undefined }
  }

  if (deps.length === 0) build(ctx)
  else ctx.inject(deps, build)

  return {
    /** 真服务是否已发布。 */
    ready: () => service !== undefined,
    /**
     * 运行时开关路由。
     * @param {boolean} value 新状态。
     * @returns {void}
     */
    setEnabled(value) {
      wantedEnabled = value === true
      service?.setEnabled(wantedEnabled)
    },
    /** 路由统计。 */
    stats() {
      return service?.stats() ?? { ready: false, enabled: wantedEnabled }
    },
  }
}
