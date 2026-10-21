/**
 * dsh-device-mesh — 路由型 `ctx.shell`（把命令按工作目录发到子节点执行）。
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────────────────
 * DSH 里所有「跑一条命令」的路径最终都汇到 `ctx.shell`（`@deepseek-ai/dsh-shell`
 * 的 `ShellExecutor` 抽象服务）：模型可见的 `bash` 工具、后台 job、hooks 桥、PTC
 * 运行时……全部走它。而**同一个 context 只能有一个 `ctx.shell` 实现**——重复注册会抛。
 *
 * 所以这里用的不是「再挂一个服务」，而是**替换 + 内层委托**：
 *
 *   · 把内置的 shell 行（`bash-sandbox`）在组合里 disable 掉；
 *   · 本插件注册自己的 `ctx.shell`；
 *   · 它在**隔离 realm** 里构造一份内置实现当委托对象（`ctx.isolate('shell', …)`），
 *     本地命令原样交给它跑。
 *
 * 这样沙箱语义、输出截断、溢出落盘（spill）、后台进程管理**全部仍然来自出厂实现**，
 * 我们只在「这条命令该在哪台设备上跑」这一个问题上插手。少写一层实现，就少一层
 * 与出厂行为分叉的机会。
 *
 * ── 为什么需要隔离 realm ────────────────────────────────────────────────────
 * Cordis 的 `Service` 基类**在构造时就注册**（`ctx.provide(name, this)`）。直接
 * `new SandboxBashExecutor(ctx, …)` 会和我们的注册撞在同一个服务表里、当场抛错。
 * `ctx.isolate('shell', label)` 返回一个子 context，其中 `shell` 这个名字解析到
 * **另一张表**，于是在里面构造内置实现既完成注册、又不影响外层——我们只是把那个
 * 实例当普通对象用。
 *
 * ── 为什么发布时用 `ctx.provide` 而不是 `extends ShellExecutor` ──────────────
 * `ShellExecutor extends Service`，而 `Service` 的构造函数会**当场**注册，于是
 * 注册的同一瞬间依赖方就会来读能力位——出厂 `dsh-permission-presets` 正是在构造时
 * 读 `ctx.shell.sandboxMode`。可那时派生类的字段初始化与构造函数体**都还没跑**，
 * 委托对象根本不存在（实测：`Cannot read properties of undefined (reading 'sandboxMode')`，
 * 直接导致 permission 行装载失败）。
 *
 * 所以这里改成普通类 + **显式 `ctx.provide`**：先把委托建好、对象填满，再一次性
 * 发布一个「出生即完整」的服务。消费者只用鸭子类型（`resolve` / `execute` /
 * `sandboxMode`），额外好处是方法调用拿到的 `this` 就是对象本身，不经过 Cordis 的
 * 可追踪代理。
 *
 * ── 互联会话：这条命令属于哪个会话 ──────────────────────────────────────────
 * 判定依据**只有** `spec.workdir`。出厂 `dsh-tool-bash` 的 `resolveWorkdir()` 给的
 * 就是「会话 cwd（模型没给 workdir 时）/ 会话 cwd 拼上相对 workdir / 沙箱
 * workspaceRoot」，所以它平时就落在会话所在的工作区里。策略见
 * `workspaceRoles[path].mesh`（routing.js 的 `routePathWithPolicy`）：
 *
 *   · `mesh: true` —— 互联会话工作区：工作区之外的命令**一律转发到声明的属主**；
 *     属主解析不出来就**拒绝**（抛错），**绝不回落到本机** —— 回落就是命令在会话端
 *     自己那台跑掉，而文件在属主那台，等于静默执行到错误的世界里；
 *   · `mesh` 缺省 —— 纯本地工作区：一律本机，即使 workdir 命中远端主路径也不转发
 *     （唯一例外是人手工钉的附加路径 member）。
 *
 * 没有策略（老部署、或没声明任何工作区）时判定逐字退回 `routePath()` 的老语义。
 *
 * **已知缺口**（本模块修不了，如实记在这里）：模型**显式**给一个工作区之外的
 * **绝对** workdir 时，出厂 `resolveWorkdir()` 原样采用它，`spec.workdir` 就不再落在
 * 任何已声明工作区里 → 归属判不出来 → 退回老语义（本机）。要修得把会话 cwd 一路
 * 带到 `resolve()` 面前（出厂请求里没有这个字段）。
 *
 * **已修过的静默缺陷**（2026-10-18）：出厂 `dsh-tool-bash` 的 job 路径用
 * `{...spec, signal}` **展开副本**调 `execute()`，对象身份变了 → 按 spec 身份查
 * `remoteSpecs` 永远落空 → resolve 判了远端、execute 却静默在本机跑（线上实测
 * shell.routed 恒 0）。修法见 `redecide()`：判定按 `(workdir, groups, policy)`
 * 同步重算，不再依赖对象身份。
 *
 * ── v1 的诚实边界 ───────────────────────────────────────────────────────────
 *   · **前台**语义完整：远端跑完才返回，退出码 / 信号 / 超时 / 截断如实回传。
 *   · **kill 是尽力而为**：远端命令不是本机子进程，`kill()` 只能返回 false（=它已经
 *     结束了）。对端是否停下取决于对端自己的取消支持，这里不假装能杀。
 *   · **不做远端后台进程流式读取**：`run_in_background` 落到远端时无法提供增量
 *     `readOutput()`，远端整段跑完后一次性可取。需要真后台请在本机跑。
 *   · `resolve()` 是**同步**的（出厂契约如此），所以路由依据必须同步可得——归属列表
 *     由调用方以同步函数传入（工作区账目本身就是内存态）。
 *
 * @module dsh-device-mesh/shell-bridge
 */

import { resolveConfig } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { collectPathOwners, explainRoute, routePathWithPolicy } from './routing.js?v=mesh-31'
import { randomHex } from './protocol.js?v=mesh-31'

/**
 * 把一整段文本包成出厂的「偏移读取器」。
 *
 * 远端命令已经跑完，整段输出就是内存里的一个字符串，所以这里给的是**只读快照**：
 * `readFrom(0)` 取全量，`readFrom(n)` 取 `n` 之后的增量，永不 lossy（没有滚动窗口，
 * 自然也不会丢头）。契约里的 `readFrom` 由调用方持有偏移，多个观察者互不消费。
 *
 * @param {string} text 完整输出文本。
 * @returns {{readFrom: (fromByte: number) => {text: string, nextOffset: number, lossy: boolean}}} 读取器。
 */
function snapshotReader(text) {
  const full = typeof text === 'string' ? text : ''
  return {
    readFrom(fromByte) {
      const from = Number.isSafeInteger(fromByte) && fromByte > 0 ? Math.min(fromByte, full.length) : 0
      return { text: full.slice(from), nextOffset: full.length, lossy: false }
    },
  }
}

/**
 * 把远端两条流拼成 `readOutput()` 期望的单一 delta。
 *
 * 出厂契约写明「stderr 放在一个带标记的段里」：消费型读取器只有一个返回串，
 * 所以本机实现也是把两股流按到达顺序合并、给 stderr 加标记。远端是一次性回来的，
 * 没有到达顺序可依，于是按「stdout 在前、stderr 在后并加标记」的固定顺序合并——
 * 顺序与真实实现可能不同，但内容不丢、标记不误导。
 *
 * @param {string} stdout 标准输出。
 * @param {string} stderr 标准错误。
 * @returns {string} 合并后的 delta。
 */
function composeDelta(stdout, stderr) {
  const out = typeof stdout === 'string' ? stdout : ''
  const err = typeof stderr === 'string' ? stderr : ''
  if (err === '') return out
  return `${out}\n--- stderr ---\n${err}`
}

/**
 * 把一个「已经跑完」的远端结果包装成出厂的 `ShellExecution` 句柄。
 *
 * 远端执行在 `execute()` 返回前就已经结束，所以句柄天然是 settled 的：`done` 立刻
 * resolve，`status` 不是 `completed` 就是 `killed`。这不是偷懒，而是这一版传输的
 * 真实语义——包装成「还在跑」反而是撒谎。
 *
 * @param {{exitCode: number|null, signal: string|null, timedOut: boolean, aborted: boolean, timeoutMs: number, stdout: string, stderr: string, truncated: boolean}} result 远端结果。
 * @returns {object} `ShellExecution`。
 */
export function settledExecution(result) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const timedOut = result.timedOut === true
  const aborted = result.aborted === true
  let drained = false
  const runResult = {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    timedOut,
    aborted,
    timeoutMs: Number.isFinite(result.timeoutMs) ? result.timeoutMs : 0,
    stdout: { text: stdout, truncated: result.truncated === true },
    stderr: { text: stderr, truncated: result.truncated === true },
  }
  const killed = timedOut || aborted || runResult.exitCode === null
  return {
    // 超时 / 中止 / 被信号杀死 → killed；正常退出 → completed。没有 running 这一档：
    // 句柄只在远端整段结束后才被构造出来。
    status: killed ? 'killed' : 'completed',
    exitCode: runResult.exitCode,
    signal: runResult.signal,
    done: Promise.resolve(),
    readOutput() {
      // 消费型：第二次读返回空 delta（进程已经结束，没有新输出）。
      if (drained) return { delta: '', lossy: false }
      drained = true
      return {
        delta: composeDelta(stdout, stderr),
        lossy: result.truncated === true,
      }
    },
    observed: { stdout: snapshotReader(stdout), stderr: snapshotReader(stderr) },
    /**
     * 远端命令不是本机子进程，这里没有可杀的本地进程。
     * 返回 `false`（契约里表示「本来就已经结束了」）是准确的事实描述——句柄只在
     * 远端整段结束后才被构造出来，那时确实已经没什么可杀的了。
     *
     * 想中止**还在跑**的远端命令，走的是另一条路：`spec.signal` 中止时
     * `MeshShellExecutor` 会向对端发一条 cancel 请求（见 `cancelRemote`）。
     * @returns {boolean} 恒为 false。
     */
    kill() {
      return false
    },
    result() {
      return Promise.resolve(runResult)
    },
    /**
     * 发起方生成的执行 id（远端才有）。对端靠它在本地中止时点名中止；
     * 本机自己发起的命令没有这个字段。
     */
    jobId: typeof result.jobId === 'string' ? result.jobId : null,
    /**
     * 这一次是「请求了后台、但传输给不了后台语义」的降级执行：命令被**等到跑完**
     * 才返回，`readOutput()` 也只有一次整段输出。为 true 时调用方应当如实告诉用户，
     * 而不是把它当成一个可轮询的后台任务。
     */
    backgroundDegraded: result.backgroundDegraded === true,
  }
}

/** 路由型 `ctx.shell` 的实现（普通类，由 `mountShellRouting` 显式发布）。 */
export class MeshShellExecutor {
  /**
   * @param {object} options 依赖注入。
   * @param {object} options.delegate 已构造好的出厂实现（本地执行全部交给它）。
   * @param {boolean} options.sandboxed 委托是否带沙箱（日志与状态展示用）。
   * @param {boolean} options.enabled 初始是否开启路由。
   * @param {() => object[]} options.groups 同步返回 buildPathGroups() 的路径组视图。
   * @param {string} options.selfDeviceId 本机设备 id。
   * @param {(request: object) => Promise<object>} options.runRemote 把命令发到子节点执行。
   * @param {(deviceId: string) => string|undefined} [options.nameOf] 设备 id → 显示名。
   * @param {object} [options.logger] 日志器。
   */
  constructor(options) {
    /** @type {object} 隔离 realm 里的出厂实现（本地执行全部交给它）。 */
    this.localDelegate = options.delegate
    /** @type {boolean} 委托是否带沙箱。 */
    this.sandboxed = options.sandboxed === true
    /** @type {Map<object, object>} 已判定为远端的 spec → 路由判定。 */
    this.remoteSpecs = new Map()
    /** @type {() => object[]} 同步取当前路径归属列表。 */
    // 收 group 视图、在 resolve() 里摊平：与 fs-bridge 同一约定。理由见下面 pathOwners
    // 那段注释——把「视图」和「摊平后的列表」放同一个字段名，是踩过的坑。
    this.groupsProvider = options.groups
    /** @type {string} 本机设备 id。 */
    this.selfDeviceId = options.selfDeviceId
    /** @type {Function} 真正把命令发到子节点的函数。 */
    this.remoteRunner = options.runRemote
    /**
     * @type {Function|undefined} 中止对端一条正在跑的命令。
     *
     * 缺省 undefined = 不支持中止（那时 `aborted` 只影响本机的等待，对端会跑到自己的
     * 超时）。做成可选依赖而不是硬依赖：没有它时路由仍然可用，只是少了这一件能力，
     * 而「少了一件能力」必须能从 stats 里看出来（见 cancelSupported）。
     */
    this.cancelRemote = options.cancelRemote
    /** @type {object|undefined} 日志器。 */
    this.meshLogger = options.logger
    /**
     * @type {(() => (object|undefined))|undefined}
     * 工作区策略的**提供者**（可选）。每次判定现取一次、不缓存：配置可以在运行期改
     * （UI 里切换「作为互联会话」），设备名 → id 的表也随节点接入/退出变化。
     *
     * 返回 `undefined` = 没有策略（老部署、或没声明任何工作区）→ 判定与改动前逐字一致。
     */
    this.workspacePolicyProvider = options.workspacePolicy
    /** @type {((cwd: unknown) => (object|undefined))|undefined} 会话权限解析器（会话端提供）。 */
    this.permissionFor = options.permissionFor
    /** @type {boolean} 路由开关：关掉时所有命令都在本机跑（服务仍然由我们提供）。 */
    this.routingEnabled = options.enabled !== false
    /** @type {(deviceId: string) => string|undefined} 设备名解析（给可读解释用）。 */
    this.deviceNameOf = options.nameOf
    /**
     * @type {{routed: number, local: number, failed: number, denied: number, cancelSent: number, remoteBackgroundDegraded: number}}
     * 计数（给 /status 与审计看）。`denied` 单列一格：它既不是「本机跑了」也不是
     * 「发到远端失败了」，而是**按策略拒绝执行**——混进任何一格里，排查时都会读错。
     */
    this.counters = { routed: 0, local: 0, failed: 0, denied: 0, cancelSent: 0, remoteBackgroundDegraded: 0, permissionWith: 0, permissionWithout: 0 }
  }

  /** 沙箱能力事实：直接反映出厂实现，工具层据此如实展示升级选项。 */
  get sandboxMode() {
    return this.localDelegate.sandboxMode
  }

  /** 路由是否开着。 */
  get enabled() {
    return this.routingEnabled
  }

  /**
   * 运行时开关路由。
   *
   * 关掉时把**已判定但还没执行**的 spec 一并丢掉：留着它们会在「关掉之后、执行之前」
   * 的窗口里仍然把命令发出去，而那正是用户以为已经关掉的时候。
   *
   * @param {boolean} value 新的开关状态。
   * @returns {void}
   */
  setEnabled(value) {
    this.routingEnabled = value === true
    if (!this.routingEnabled) this.remoteSpecs.clear()
  }

  /** 路由统计（只读快照）。 */
  stats() {
    return {
      ...this.counters,
      enabled: this.routingEnabled,
      sandboxed: this.sandboxed,
      // 「能不能中止远端命令」是可观测事实，不是隐含能力：挂载时没拿到 cancelRemote
      // 就如实报 false，而不是让调用方以为 kill() 真的会起作用。
      cancelSupported: typeof this.cancelRemote === 'function',
    }
  }

  /**
   * 取一次工作区策略视图。
   *
   * 三种结果语义完全不同：
   *   · `undefined` —— 没有策略（提供者缺席，或它说「没声明任何工作区」）。**刻意**的
   *     向后兼容：退回 `routePath()` 的老语义，老部署行为逐字不变；
   *   · `{policy, resolveOwner}` —— 正常策略；
   *   · `{error}` —— 提供者抛了。**失败关闭**：读不到策略时唯一能确定的事实是
   *     「不知道这条命令该在哪台跑」，而互联会话下「不知道」等价于「可能跑在错误
   *     的机器上」，所以不能当作「没有策略」放行。
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
      this.meshLogger?.warn?.(`dsh-device-mesh: 读取工作区策略失败，命令按拒绝处理：${message}`)
      return { error: `工作区策略读取失败：${message}` }
    }
  }

  /**
   * 取一次**会话权限**（会话端提供）。
   *
   * `undefined` = 提供者缺席 / 查不到这个 cwd 上的会话 / 提供者抛错 —— 三种情况都
   * **不带权限**，属主按旧的导出根口径裁决。刻意如此：权限的权威是会话端，会话端
   * 说不出来时，本机**不能替它决定给什么权限**（唯一安全的方向是不带，让属主按自己的
   * 规矩办）。
   *
   * @param {unknown} cwd 会话 cwd（这里是 `spec.workdir`）。
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
   * 构造一次「拒绝执行」的错误。
   *
   * 用普通 `Error`：出厂 `ctx.shell` 契约里没有专用错误类型，`dsh-tool-bash` 自己拒绝
   * 执行时抛的也是普通 `Error`（例如「后台被禁用」那条），工具层对两者的渲染路径完全
   * 一样——换成自定义类只会多一个没人在乎的类型。
   *
   * @param {string} reason 拒绝原因。
   * @param {unknown} workdir 命令的工作目录。
   * @returns {Error} 错误。
   */
  deniedError(reason, workdir) {
    const where = typeof workdir === 'string' && workdir !== '' ? workdir : '(未指定工作目录)'
    return new Error(`互联会话只允许在属主设备上落地：${reason}（工作目录 ${where}）`)
  }

  /**
   * 应用到请求上的默认值 / 上限 / 沙箱策略**全部沿用出厂实现**，我们只多做一件事：
   * 记下这条命令该去哪台设备跑。判定结果挂在 spec 对象上（`Map` 键是对象身份），
   * `execute()` 拿到同一个对象即可取回。
   *
   * ── 为什么 denied 在这里抛、而不是留到 execute() ────────────────────────────
   * 看出厂调用点（`dsh-tool-bash/lib/index.js`）：`execute()` 工具里三处
   * `ctx.shell.resolve({...})` 与 `ctx.shell.execute(...)` 都写在**同一个 await 表达式**
   * 里（后台那条 664、提升成 job 那条 671、前台那条 683），所以两边抛出对调用方是
   * **同一种结果**：工具执行失败、以工具错误回到模型面前，进程不受影响。
   * 既然等价，就选更早的那个点：resolve 阶段拒绝时，job 不会注册、命令不会被构造、
   * 更不会有任何一端开始跑 —— 在「fail closed」这件事上，早失败没有额外代价。
   *
   * @param {object} request 调用方的请求。
   * @returns {object} 已解析的 spec。
   */
  resolve(request) {
    const spec = this.localDelegate.resolve(request)
    if (!this.routingEnabled) return spec
    const policyView = this.policyView()
    if (policyView !== undefined && typeof policyView.error === 'string') {
      this.counters.denied += 1
      throw this.deniedError(policyView.error, spec.workdir)
    }
    const decision = routePathWithPolicy(spec.workdir, {
      owners: collectPathOwners(this.groupsProvider()),
      selfDeviceId: this.selfDeviceId,
      policy: policyView?.policy,
      // shell 这边没有独立的「会话 cwd」可用：出厂 `resolveWorkdir()` 已经把会话 cwd
      // 落进了 spec.workdir（模型没显式指定 workdir 时），归属就按它判。
      cwd: spec.workdir,
      resolveOwner: policyView?.resolveOwner,
    })
    if (decision.route.kind === 'denied') {
      this.counters.denied += 1
      throw this.deniedError(decision.route.reason, spec.workdir)
    }
    if (decision.route.kind === 'remote') {
      // 会话权限：shell 这边会话 cwd 已经落在 spec.workdir 上（见上面注释）。
      this.remoteSpecs.set(spec, { ...decision, permission: this.resolvePermission(spec.workdir) })
    }
    return spec
  }

  /**
   * 对一条 spec 重新做一次**同步**的路由判定。
   *
   * 为什么必须有它（这是实打实的线上缺陷，不是防御式编程）：出厂 `dsh-tool-bash`
   * 的 job 路径在 `startJob(...).run()` 里这样调用：
   *
   *     const spec = ctx.shell.resolve({...request, onExpiry: 'none'})   // ← 对象 A
   *     startJob(jobs, args, exec, spec)
   *       → run: () => { proc = await ctx.shell.execute({ ...spec, signal }) }  // ← 对象 B
   *
   * `{...spec, signal}` 是**展开后新建的对象**：身份变了，`remoteSpecs.get(specB)`
   * 永远取不到。于是 resolve() 明明判了「远端」（permissionWith 计数都涨了），
   * execute() 却查不到判定 → 静默落到本机委托执行。本部署的实测症状就是它：
   * `/status` 里 shell.routed 恒为 0、local 涨到几百，而同一段时间 fs.routed 正常
   * （fs-bridge 把判定铸进 target 对象里，展开复制不会丢）。
   *
   * 判定本身是 `(workdir, groups, policy)` 的纯函数，同步可重算 —— 所以这里不依赖
   * 对象身份，拿不到就**重算**。resolve() 里的 Map 仍然保留（那是「不出网就能对齐
   * resolve/execute 两次判定」的快路径，也承担 denied 的早抛语义），重算只在
   * Map 未命中时发生，本地路径两次判定都落空、代价为零。
   *
   * 会话权限同样重算一次：它也是同步的（permissionFor 就是这么被调用的）。
   *
   * 两次判定结果不一致时（resolve 判远端、重算判本地，或反过来），以**重算**为准
   * 并记 warn：执行时刻的事实比注册时刻的更真，但差异本身值得被看见 —— 它意味着
   * 配置或归属列表在 resolve 与 execute 之间变了。
   *
   * @param {object} spec execute() 收到的 spec（可能是展开副本）。
   * @returns {{route: {kind: string}, owner?: object, normalized?: string, permission?: object}|undefined}
   *     远端判定；`undefined` = 本地（Map 与重算都判本地）。
   */
  redecide(spec) {
    // 开关关着 = 一律本机。这个检查必须在这里再做一次（resolve 里也做）：
    // setEnabled(false) 清空 Map 之后，重算路径不能再把已关掉的命令重新判成远端，
    // 否则「关掉之后不得再发出已判定的请求」这条不变量就被绕过了。
    if (!this.routingEnabled) return undefined
    const cached = this.remoteSpecs.get(spec)
    const decideNow = () => routePathWithPolicy(spec.workdir, {
      owners: collectPathOwners(this.groupsProvider()),
      selfDeviceId: this.selfDeviceId,
      policy: this.policyView()?.policy,
      cwd: spec.workdir,
      resolveOwner: this.policyView()?.resolveOwner,
    })
    if (cached === undefined) {
      const decision = decideNow()
      if (decision.route.kind !== 'remote') return undefined
      return { ...decision, permission: this.resolvePermission(spec.workdir) }
    }
    // Map 命中：仍要核对（开关可能在 resolve 之后被关掉，那条路径 setEnabled 已清表，
    // 这里天然安全；但配置/归属变化的差异值得看见）。
    const now = decideNow()
    if (now.route.kind !== 'remote') {
      this.meshLogger?.warn?.(
        `dsh-device-mesh: resolve 判远端、execute 重算判本地，按重算落地本机（workdir ${String(spec.workdir)}）`,
      )
      this.remoteSpecs.delete(spec)
      return undefined
    }
    if (now.route.deviceId !== cached.route.deviceId) {
      this.meshLogger?.warn?.(
        `dsh-device-mesh: resolve 与 execute 的远端判定不一致（${cached.route.deviceId} → ${now.route.deviceId}），按重算结果发送（workdir ${String(spec.workdir)}）`,
      )
    }
    return { ...now, permission: cached.permission ?? this.resolvePermission(spec.workdir) }
  }

  /**
   * 执行一条已解析的 spec：本地 → 委托；远端 → 发到子节点并包装成 settled 句柄。
   *
   * 路由判定不再依赖「execute 收到的是 resolve 返回的同一个对象」—— 出厂
   * job 路径会用 `{...spec, signal}` 展开出**新对象**再调 execute（见
   * {@link redecide} 的注释）。Map 命中用 Map；未命中重算一次。
   *
   * @param {object} spec `resolve()` 的产物，或它的展开副本。
   * @returns {Promise<object>} `ShellExecution`。
   */
  async execute(spec) {
    const decision = this.redecide(spec)
    if (decision === undefined) {
      this.remoteSpecs.delete(spec)
      this.counters.local += 1
      return this.localDelegate.execute(spec)
    }
    this.remoteSpecs.delete(spec)
    this.counters.routed += 1
    const target = decision.route
    this.meshLogger?.info?.(
      `dsh-device-mesh: 命令下沉 ${target.deviceId}（${explainRoute(decision, this.deviceNameOf)}）：`
      + String(spec.command).slice(0, 120),
    )

    // jobId 由**发起方**生成：传输是一次性请求/响应，本机在命令跑完之前没有机会
    // 把 id 告诉对端，而对端要中止它必须能点名。
    const jobId = randomHex(16)
    // 「远端后台」是这一版传输的真实缺口：没有增量 `readOutput()` 可言。与其让调用方
    // 以为拿到了可轮询的后台任务，不如如实记一笔并挂到句柄上——能力缺口必须看得见。
    const backgroundDegraded = spec.background === true
    if (backgroundDegraded) this.counters.remoteBackgroundDegraded += 1

    // 本机中止 → 立刻告诉对端。没有这一步，用户按了停之后对端仍会跑到自己的超时。
    const signal = spec.signal
    let cancelSent = false
    const onAbort = () => {
      if (cancelSent) return
      cancelSent = true
      if (typeof this.cancelRemote !== 'function') return
      this.counters.cancelSent += 1
      Promise.resolve(this.cancelRemote({ deviceId: target.deviceId, jobId, workdir: spec.workdir }))
        .catch((error) => {
          this.meshLogger?.warn?.(
            `dsh-device-mesh: 中止远端命令失败（${target.deviceId}）：${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
      // 已经中止了才进来：addEventListener 不会补发，补一次调用。
      if (signal.aborted === true) onAbort()
    }

    try {
      const result = await this.remoteRunner({
        deviceId: target.deviceId,
        command: spec.command,
        workdir: spec.workdir,
        timeoutMs: spec.timeoutMs,
        signal,
        jobId,
        // 会话权限：属主按它放行/拒绝（read-only 下连 exec 都会被拒）。
        permission: decision.permission,
      })
      return settledExecution({
        ...result,
        timeoutMs: spec.timeoutMs,
        // 本机中止过就按中止报告，而不是等对端把它的信号回传（它未必回传得回来）。
        aborted: result.aborted === true || cancelSent,
        jobId,
        backgroundDegraded,
      })
    } catch (error) {
      this.counters.failed += 1
      this.meshLogger?.warn?.(
        `dsh-device-mesh: 命令下沉失败（${target.deviceId}）：${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    } finally {
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/**
 * 在隔离 realm 里构造出厂实现，作为本地执行的委托对象。
 *
 * 有 `sandboxPolicy` 服务就用沙箱实现（部署默认是真沙箱，不能因为我们换了服务名
 * 就悄悄退化成无沙箱）；没有则退回朴素本地实现。两者构造签名一致，都接收
 * `(ctx, config)`。
 *
 * 用**静态 import**：`apply()` 是同步的，挂载必须在同步路径上完成。动态 import 会把
 * 这里变成异步，进而要求整个 `apply` 变异步——那会改变插件的装载时序。
 *
 * label 固定成常量：重复挂载时两次 `ctx.isolate` 会落到同一张服务表，得到「同一个
 * 委托实例」的语义，而不是每次热重载泄漏一份。
 *
 * @param {object} ctx 插件上下文（主 realm）。
 * @param {object} config 归一化配置（取 `execTimeoutMs` 当默认超时）。
 * @returns {{delegate: object, sandboxed: boolean}} 委托实例与是否沙箱。
 */
export function createLocalDelegate(ctx, config) {
  const sandboxed = ctx.get('sandboxPolicy') !== undefined
  const delegateCtx = ctx.isolate('shell', 'dsh-device-mesh:local-shell')
  const DelegateClass = sandboxed ? SandboxBashExecutor : LocalBashExecutor
  return { delegate: new DelegateClass(delegateCtx, { timeoutMs: config.execTimeoutMs }), sandboxed }
}

/**
 * 挂载路由型 `ctx.shell`。
 *
 * 调用方（入口）必须已经在组合里 disable 掉内置的 shell 行，否则 `ctx.provide` 会
 * 因为「服务已被占用」当场抛错——这是刻意的：宁可装载失败也不要两个实现各跑一半。
 *
 * ── 为什么委托要在 `ctx.inject` 的回调里构造 ────────────────────────────────
 * Cordis 强制「context 上没有的服务属性一律不许取」（`cannot get property "sandboxPolicy"
 * without inject`），而服务属性是靠装载器按插件的 `inject` 声明**装配到 context 上**的。
 * 我们手工 `new SandboxBashExecutor(...)` 时走不到那一步，于是它构造函数里那句
 * `ctx.sandboxPolicy.defaultMode` 直接抛——实测就是这个错误让整个 shell 服务没发布出去。
 *
 * `ctx.inject([...], cb)` 正是解药：它给出一个**已经把这些服务装好**的子 context。
 *
 * 代价是异步（依赖齐了才回调），所以本函数**同步返回一个门面**，门面在真 executor
 * 就绪后转发调用。这不影响可用性：消费方（`dsh-tool-bash`、`dsh-permission-presets`）
 * 本来就以 `inject: ['shell']` 等待这个服务，晚一步发布它们只是在 pending，不会失败。
 * （早先那版卡在 `pending (waiting for service: shell)` 的根因就是这里抛了异常。）
 *
 * 依赖集按实际选中的实现给：有沙箱就三件套，没有就只要 `subprocess`——否则纯本地部署
 * 会因为永远等不到 `sandboxPolicy` 而彻底没有 shell。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} options 依赖。
 * @param {object} options.config 归一化配置。
 * @param {() => object[]} options.groups 同步返回当前 `buildPathGroups()` 结果。
 * @param {object} options.caller 已建好的 `Caller`（远端执行走它）。
 * @param {string} options.selfDeviceId 本机设备 id。
 * @param {(deviceId: string) => string|undefined} [options.nameOf] 设备 id → 显示名。
 * @param {() => (object|undefined)} [options.workspacePolicy] 工作区策略提供者（互联会话判定用，见文件头）。
 * @param {object} [options.logger] 日志器。
 * @returns {{setEnabled: Function, stats: Function, ready: Function}} 同步门面。
 */
export function mountShellRouting(ctx, options) {
  const { config, groups, caller, selfDeviceId, nameOf, logger, workspacePolicy, permissionFor } = options
  const sandboxed = ctx.get('sandboxPolicy') !== undefined
  const deps = sandboxed ? ['sandboxPolicy', 'sandbox', 'subprocess'] : ['subprocess']

  /** @type {object|undefined} 就绪后的真 executor。 */
  let executor
  /** 门面收到的开关意图：executor 就绪时补上（配置可能在装载前就被改过）。 */
  let wantedEnabled = config.routeExecByPath === true

  ctx.inject(deps, (childCtx) => {
    // 隔离 realm：内置实现在这里注册，不会撞上外层（我们）的 shell 服务名。
    // label 固定成常量：重复挂载时两次 isolate 落到同一张服务表，得到「同一个委托实例」
    // 的语义，而不是每次热重载泄漏一份。
    const delegateCtx = childCtx.isolate('shell', 'dsh-device-mesh:local-shell')
    const DelegateClass = sandboxed ? SandboxBashExecutor : LocalBashExecutor
    // 委托的配置必须走一遍**出厂 schema 的解析**：LocalBashExecutor 的配置叶子是
    // schemastery 的活值（代码里读 config.timeoutMs.get()），直接喂 { timeoutMs: 数字 }
    // 会在 resolve() 里炸成 "config.timeoutMs.get is not a function"。
    // resolveConfig 只用 runtime.Config 这一个字段，所以把类本身当 runtime 传即可。
    const delegate = new DelegateClass(
      delegateCtx,
      resolveConfig(DelegateClass, { timeoutMs: config.execTimeoutMs }),
    )
    executor = new MeshShellExecutor({
      delegate,
      sandboxed,
      // 即使开关关着也照常挂载：内置的 shell 行已经在组合里 disable 掉了，我们必须
      // 提供这一个服务，否则 profile 里根本没人提供 ctx.shell。开关只决定「要不要路由」，
      // 不决定「服务存不存在」——这样它才能被安全地运行时切换。
      enabled: wantedEnabled,
      groups,
      selfDeviceId,
      nameOf,
      logger,
      // **必须显式转交**：策略只收在 mountShellRouting 的入参里，MeshShellExecutor
      // 拿不到；漏掉这一步的症状是「互联会话开关配好了、命令却还是在本机跑」。
      workspacePolicy,
      permissionFor,
      // 必须**显式转交**：cancelRemote 只收在 mountShellRouting 的入参里，executor
      // 是拿不到的，于是 stats().cancelSupported 会常年报 false、中止静默失效。
      // （实测漏了这一步：/status 立刻报 cancelSupported:false——这正是把「能力缺口」
      // 做成可观测字段的意义。）
      cancelRemote: options.cancelRemote,
      /**
       * 真正把命令发到子节点。
       *
       * `device` 显式钉住目标：只给 `path` 时 Caller 会在所有设备里找匹配的路径，
       * 而我们这里**已经判定**过该去哪台——再让它重新猜一次就可能落到别的机器上执行。
       */
      runRemote: async (request) => {
        const result = await caller.exec({
          device: request.deviceId,
          path: request.workdir,
          command: request.command,
          timeoutMs: request.timeoutMs,
          // 发起方生成的 id，原样带给对端：本机中止时靠它点名中止那一条命令。
          jobId: request.jobId,
          actor: 'agent',
          direction: 'tool',
          // 会话权限跟着命令一起下去：属主侧按它判 read-only / workspace-write。
          permission: request.permission,
        })
        return {
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          // 对端会把「被 cancel」带回来；本机侧的中止另由 cancelSent 处理。
          aborted: result.cancelled === true,
          jobId: result.jobId,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated === true || result.stderrTruncated === true,
        }
      },
    })
    // 先建满再发布：依赖方会在 provide 的同一瞬间读 sandboxMode（见文件头注释）。
    childCtx.provide('shell', executor)
    logger?.info?.(
      `dsh-device-mesh: ctx.shell 已接管（${sandboxed ? '沙箱' : '朴素'}本地委托）；`
      + `命令路由${executor.enabled ? '开' : '关'}`
      + `${executor.enabled ? '——工作目录落在子节点路径上的命令将发到那台执行' : '（routeExecByPath=false，全部命令在本机执行）'}`,
    )
    // inject 作用域自己管生命周期：返回的 disposer 会在依赖消失时撤销这次 provide。
    return () => {
      executor = undefined
    }
  })

  return {
    /** 真 executor 是否已经发布。 */
    ready: () => executor !== undefined,
    /**
     * 运行时开关路由。executor 还没就绪时先记下意图，就绪时补上。
     * @param {boolean} value 新状态。
     * @returns {void}
     */
    setEnabled(value) {
      wantedEnabled = value === true
      executor?.setEnabled(wantedEnabled)
    },
    /** 路由统计。 */
    stats() {
      return executor?.stats() ?? { ready: false, enabled: wantedEnabled }
    },
  }
}
