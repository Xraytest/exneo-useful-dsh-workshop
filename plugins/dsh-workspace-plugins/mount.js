/**
 * dsh-workspace-plugins —— 挂载运行时（会话作用域内的子插件装载）。
 *
 * 这是整个插件的机制核心：**把子插件挂进单个会话的 agent 上下文**，而不是挂
 * 到进程根上。为什么这样就「只对该工作区生效」，三条都来自同一件事——
 * 子插件的注册沿 agent.ctx 的作用域链落进该 agent 自己的层：
 *
 *   1. 工具：`ctx.tools.register()` 是作用域注册表。挂在 agent.ctx 下的工具只
 *      出现在该 agent 的 `tools.schemas(scope)` 投影里（请求时才投影，所以挂在
 *      会话中途也立即生效），其它会话的模型看不到、也调不到；
 *      `tools/pre-execute`、`tools/post-execute` 等瀑布由出厂用
 *      `scopeTarget(registry, exec.agent)` 派发，因此这些钩子也只看得见本会话。
 *   2. 提示词段：`ctx.systemPrompt` 同样是作用域注册表，装配期按
 *      `context.scope` 取层（出厂 `system-prompt/assemble` 亦按同一 scope 过滤
 *      瀑布），所以段落只进本会话的请求。
 *   3. agent/* 事件：出厂以 agent 自身的 scope carrier 派发，本插件挂上去的
 *      监听器带的是同一个键，因此只收到本会话（及其后代）的事件。
 *
 * 与出厂 `agentPresets.mountPreset()` 的关系：两者做的是同一件事（把一份组合挂
 * 到 agent 作用域下），差别在时机与来源——preset 在 **发布前** 的 `setup` 里挂
 * 一份磁盘上的组合文件；本插件在 **`agent/created`** 时挂「组合里声明/设置页配
 * 的行」，因此必须自己保证：
 *   · 模块**预导入**（apply 时就 import），使挂载动作本身同步完成——否则第一轮
 *     请求可能在挂载完成前就开始装配，模型会看不到本该有的工具；
 *   · agent 上下文**必须带作用域标签**（`scopeOf(agent.ctx)` 有值），否则注册会
 *     落到进程全局层，那就不是「只对这个工作区生效」而是对所有会话生效。这一条
 *     是硬闸：取不到标签就拒绝挂载并记诊断，宁可什么都不挂。
 *
 * 边界（写进 README，也要在设置页如实展示）：
 *   · 出厂事件里**没有 scope carrier** 的那些（例如 `llm/stream`、`agent/request`
 *     之外的进程级钩子）是全局派发的——挂上去的监听器对所有会话都会触发，子插件
 *     若要在那种钩子里做「只对本工作区」的事，必须自己按会话判断。本插件只保证
 *     注册表（工具/提示词段/agent 作用域事件）的真隔离。
 *   · 子插件若 `ctx.provide(name)` 而没有声明 `isolate`，第二个会话挂载时会撞名
 *     失败——这正是出厂 preset 审计拦下的那种形态；这里如实记为 failed 并给
 *     可行动的提示，而不是静默半挂。
 *
 * @module dsh-workspace-plugins/mount
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { scopeOf } from '@deepseek-ai/dsh-scope';

// 与 index.js 用**同一个** ?v= URL：Node ESM 按完整 URL 缓存模块，少了查询串就会
// 变成「两个 store.js 实例」（一个带 ?v=、一个不带），热重载后 mount.js 可能一直在用
// 上一版匹配逻辑，而且没人看得出来。
import { canonicalPath, matchWorkspace, message, workspaceKeyOf, workspaceSignature } from './store.js?v=wsp-7';

/** 行挂载后的状态：pending（已提交、等 fiber 结算）/ active / waiting / failed / skipped。 */
/**
 * 行状态取值。
 *   pending/active/waiting/failed/skipped —— 见 mountRow；
 *   unavailable —— **网络工作区**上「本机没有这个模块」：同一份工作区在别的设备上还有
 *   一份，路径类子插件的文件只在那台设备上。不是坏行，但本机也挂不上；设置页用独立的
 *   语气提示「请在 <设备> 上声明这一行」，并把它算进「需要人工处理」的计数。
 */
export const ROW_STATES = ['pending', 'active', 'waiting', 'failed', 'skipped', 'unavailable'];

/**
 * 把一个行的 name 分类，决定它该从哪个 base 解析。
 * 与出厂 `dsh-agent-presets` 的 classifyRowSpecifier 同一口径：
 * 相对/绝对路径属于「组合文件所在目录」，裸包名走 Node 的向上查找。
 * @param name - 行声明的模块标识。
 * @returns `'builtin' | 'relative' | 'file' | 'package'`。
 */
export function classifySpecifier(name) {
  if (name.startsWith('cordis:')) return 'builtin';
  if (name.startsWith('.')) return 'relative';
  if (name.startsWith('file:')) return 'file';
  if (isAbsolute(name)) return 'file';
  // 带协议头的标识一律另立一类：`data:text/javascript,…` 会被 Node 直接求值，
  // `http(s):` 走网络取模块，`node:` 是内建模块——它们都不是「插件包名」。
  // 不把它们和裸包名混在一起，是因为写路由能落一个标识进清单，而这个标识随后会
  // 被 host import：白名单之外的口子等于把「让 host 执行任意代码」交出去。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(name)) return 'scheme';
  return 'package';
}

/**
 * 一个标识是否允许被解析/挂载。
 *
 * 允许：相对路径、绝对路径、`file:`、`cordis:` 内建、裸包名。其余带协议的
 * （`data:`、`http:`、`https:`、`node:`、`blob:`…）一律拒绝——这是本插件的
 * 白名单底线，与同源守卫是两道独立的闸。
 * @param name - 行声明的模块标识。
 * @returns `{ ok, kind, reason }`。
 */
export function checkSpecifier(name) {
  const text = String(name ?? '').trim();
  if (text === '') return { ok: false, kind: 'empty', reason: '模块标识不能为空' };
  const kind = classifySpecifier(text);
  if (kind !== 'scheme') return { ok: true, kind };
  const scheme = text.slice(0, text.indexOf(':') + 1);
  if (scheme === 'file:') return { ok: true, kind: 'file' };
  return {
    ok: false,
    kind: 'scheme',
    reason: `不支持的模块协议 ${scheme}（只允许相对路径、绝对路径、file:、cordis: 内建与裸包名）——带协议的标识会被 Node 直接求值或取网络模块，本容器不接受`,
  };
}

/**
 * 把一个模块命名空间归一成「Cordis 认的插件」——**照抄 loader 的口径**
 * （`cordis-plugin-loader` 的 `Loader.unwrapExports`）：
 *
 *   exports.default ?? exports        // 默认导出优先
 *   若结果带 __esModule（转译产物）→ 再取一次 default
 *
 * 为什么必须照抄：组合行能挂 `export default plugin`，本插件若直接把命名空间交给
 * `ctx.plugin()`，那种模块会挂出一个「没有 apply」的 fiber（或者干脆报错）。这里
 * 与 loader 用同一个口径，行为才一致——包括 `cordis:` 内建（内建本身就是插件对象，
 * 过一次 unwrap 也无害）。
 * @param exported - import() 的命名空间，或 loader 的内建插件。
 * @returns 可交给 `ctx.plugin()` 的插件。
 */
export function unwrapExports(exported) {
  if (exported === null || exported === undefined) return exported;
  let value = exported.default ?? exported;
  if (!value.__esModule) return value;
  return value.default ?? value;
}

/**
 * 建一个挂载运行时。每个插件实例一个（随 apply 的 ctx 生命周期）。
 *
 * @param options.ctx - 本插件所在的 host 上下文（用于 `ctx.loader` 与日志）。
 * @param options.baseUrl - 相对模块标识的解析基准（组合文件所在目录；缺省由
 *   apply 传入 `ctx.baseUrl`，再退回本文件推导出的 profile 目录）。
 * @param options.log - 日志函数 `(level, message) => void`。
 * @returns 运行时句柄。
 */
export function createRuntime(options) {
  const { ctx, log } = options;
  const baseUrl = normalizeBase(options.baseUrl);
  /** @type {Map<string, { specifier: string, state: string, module?: any, error?: string, attempts: number }>} */
  const modules = new Map();
  /** @type {Map<string, any>} agentId → 挂载记录 */
  const mounts = new Map();
  let workspaces = [];
  /**
   * 挂载用的 config 副本。
   *
   * 不给副本的话，同一行的多个会话、以及 /state 的 fileState（保存基线）会**共用同一个
   * 对象**：子插件里一句 `config.x ??= …` 就会串到别的会话，还会被设置页下次保存写进
   * 状态文件（无 Config schema 的子插件拿到的就是原对象，实测如此）。所以每次挂载都
   * 结构化克隆一份；克隆不了（config 里塞了函数/活对象）就退回原对象并记一条警告，
   * 而不是把行挂失败。
   * @param row - 清单里的一行。
   * @returns 交给 `ctx.plugin()` 的 config。
   */
  function configForMount(row) {
    const config = row.config;
    if (config === undefined || config === null) return {};
    if (typeof config !== 'object') return config;
    try {
      return structuredClone(config);
    } catch (error) {
      log('warn', `行 ${row.id} 的 config 无法结构化克隆（${message(error)}），本次挂载直接传原对象——子插件对它的修改会影响同行的其它会话`);
      return config;
    }
  }

  /** 预导入是否至少成功完成过一次，以及此刻是否有一次在飞。 */
  let ready = false;
  let preloading = false;

  // ── 模块预导入 ──────────────────────────────────────────────────────────

  /**
   * 解析一个模块标识，返回 `{ module, plugin }`。
   *
   * 三条口径都对齐 loader 的行为：
   *   · `cordis:xxx` —— 不是可 import 的 URL，而是 loader 的**内建插件表**里的条目
   *     （`loader.builtins['xxx']`，cordis-plugin-loader 就是这么解析的）。拿不到
   *     loader 或没有该内建时给一条能读懂的错，而不是让 Node 抛奇怪的话。
   *   · 相对标识相对**组合文件所在目录**（baseUrl）；绝对路径与 file: 直接当 URL。
   *   · 裸包名按 Node 规则解析（从本插件所在目录向上找 node_modules）。
   * 最后统一过 `unwrapExports`，与 loader 挂组合行时同一个口径。
   *
   * @param specifier - 行声明的模块标识。
   * @returns `{ module, plugin }`：module 用于形态展示（探测），plugin 用于挂载。
   */
  async function importSpecifier(specifier) {
    const verdict = checkSpecifier(specifier);
    if (!verdict.ok) throw new Error(verdict.reason);
    const kind = verdict.kind;
    // `ctx.get('loader')`（而不是 ctx.loader）：Cordis 4 里读未声明 inject 的服务属性
    // 会直接抛错，而 loader 对本插件是可选的——拿不到就退回本模块自己的 import()。
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
    if (kind === 'builtin') {
      const key = specifier.slice('cordis:'.length);
      const builtin = loader?.builtins?.[key];
      if (builtin === undefined) {
        throw new Error(`解析不到内建插件 ${specifier}：loader 的 builtins 里没有 "${key}"${loader === undefined ? '（当前上下文拿不到 loader 服务）' : ''}`);
      }
      return { module: builtin, plugin: unwrapExports(builtin) };
    }
    const target = kind === 'file' && isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
    const internal = loader?.internal;
    const module = internal !== undefined && typeof internal.import === 'function'
      ? await internal.import(target, baseUrl, {})
      : kind === 'package'
        ? await import(target)
        : await import(new URL(target, baseUrl).href);
    return { module, plugin: unwrapExports(module) };
  }

  /**
   * 预导入当前清单里所有启用行引用的模块。
   *
   * 必须在 `agent/created` 之前完成，挂载才会是同步的（见模块头注释）。导入是
   * 幂等的（Node 模块缓存 + 本函数的记录表），重复调用只补新增/失败的标识。
   * @returns 本轮结果摘要。
   */
  async function preload() {
    preloading = true;
    try {
      return await runPreload();
    } finally {
      preloading = false;
      ready = true;
    }
  }

  /** preload 的本体（外层只负责维护 ready/preloading 两个标志）。 */
  async function runPreload() {
    const wanted = new Set();
    for (const workspace of workspaces) {
      for (const row of workspace.plugins) {
        if (row.disabled === true || row.conflict === true) continue;
        wanted.add(row.name);
      }
    }
    const jobs = [];
    for (const specifier of wanted) {
      const existing = modules.get(specifier);
      if (existing !== undefined && existing.state === 'ok') continue;
      const record = existing ?? { specifier, state: 'loading', attempts: 0 };
      record.state = 'loading';
      record.attempts += 1;
      modules.set(specifier, record);
      jobs.push((async () => {
        try {
          const resolved = await importSpecifier(specifier);
          record.module = resolved.module;
          record.plugin = resolved.plugin;
          record.state = 'ok';
          record.error = undefined;
        } catch (error) {
          record.state = 'failed';
          record.error = message(error);
          log('warn', `预导入失败：${specifier} —— ${message(error)}`);
        }
      })());
    }
    // 清单里已消失的标识不再保留（避免设置页显示幽灵模块；已挂载的实例不受影响）。
    for (const specifier of [...modules.keys()]) if (!wanted.has(specifier)) modules.delete(specifier);
    await Promise.all(jobs);
    return moduleSnapshot();
  }

  /** 模块预导入状态的可序列化快照。 */
  function moduleSnapshot() {
    return [...modules.values()]
      .map((record) => ({
        specifier: record.specifier,
        state: record.state,
        attempts: record.attempts,
        error: record.error,
        pluginShape: describeModule(record.plugin ?? record.module),
      }))
      .sort((left, right) => left.specifier.localeCompare(right.specifier));
  }

  /**
   * 进程全局层当前看得见的工具名。
   *
   * `tools.schemas(undefined)` 是「默认层」的投影——会话作用域里挂的工具不出现在
   * 这里（自测里有断言证明这一点）。拿不到 tools 服务（宿主没装工具注册表）时返回
   * null，泄漏探针自动失效（不误报）。
   * @returns 名字数组，或 null（探针不可用）。
   */
  function globalToolNames() {
    try {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
      if (tools === undefined || tools === null || typeof tools.schemas !== 'function') return null;
      return tools.schemas(undefined).map((schema) => schema.name);
    } catch {
      return null;
    }
  }

  /**
   * 只导入、不挂载：给设置页的「探测」用。
   * 设置页在保存前先探一次，能把「模块不存在 / 不是插件」这类错误挡在写盘之前，
   * 也能顺带回显模块形态（是否导出 apply/inject），帮助确认这行到底挂上了什么。
   * @param specifier - 行声明的模块标识。
   * @returns `{ ok, specifier, pluginShape? , error? }`。
   */
  async function probe(specifier) {
    if (typeof specifier !== 'string' || specifier.trim() === '') return { ok: false, specifier: String(specifier), error: 'specifier 不能为空' };
    const name = specifier.trim();
    const verdict = checkSpecifier(name);
    if (!verdict.ok) return { ok: false, specifier: name, kind: verdict.kind, resolvedFrom: baseUrl, error: verdict.reason };
    try {
      const { module, plugin } = await importSpecifier(name);
      const pluginShape = describeModule(plugin);
      if (pluginShape.apply === undefined) {
        return { ok: false, specifier: name, pluginShape, resolvedFrom: baseUrl, error: '该模块既不是插件函数、也没有导出 apply/默认导出一个插件——不是可挂载的 Cordis 插件' };
      }
      return {
        ok: true,
        specifier: name,
        pluginShape,
        resolvedFrom: baseUrl,
        // 与 loader 同口径地归一过：默认导出被解开的、以及 cordis: 内建，都在这里说明。
        unwrapped: plugin !== module,
        kind: classifySpecifier(name),
      };
    } catch (error) {
      return { ok: false, specifier: name, resolvedFrom: baseUrl, error: message(error) };
    }
  }

  // ── 会话挂载 ────────────────────────────────────────────────────────────

  /**
   * 会话 → 命中的有效工作区。
   * 判定顺序见 store.matchWorkspace：注册表身份账 → 精确路径 → 子树最长优先。
   * @param cwd - 会话 header.cwd。
   * @param sessionId - 会话 id（可选；给了才能用注册表的会话归属做身份命中）。
   * @returns `{ workspace, mode, by, path, kind }` 或 undefined。
   */
  function resolveWorkspace(cwd, sessionId) {
    return matchWorkspace(workspaces, cwd, sessionId);
  }

  /**
   * 为一个已创建的 agent 挂载命中的子插件行。
   *
   * **同步**完成「决定 + 提交挂载」两步：`ctx.plugin()` 在下一微任务里才跑子插件
   * 的 apply，而 agent/created 的监听器同步返回后，会话还要经过多轮 await 才装配
   * 第一个请求，因此首轮就能看到这些注册（模块必须已预导入）。
   * 幂等：同一个 agent 已有挂载记录时直接返回它。
   *
   * @param agent - 出厂 agent 句柄（需要 `id`、`session.header.cwd`、`ctx`）。
   * @returns 挂载记录，或 `{ skipped, reason }`。
   */
  function mountForAgent(agent) {
    const agentId = agent?.id;
    if (typeof agentId !== 'string' || agentId === '') return { skipped: 'no-agent' };
    const existing = mounts.get(agentId);
    if (existing !== undefined) return existing;
    const cwd = canonicalPath(agent?.session?.header?.cwd);
    if (cwd === null) return { skipped: 'no-cwd', reason: '会话没有 cwd，无法判定工作区' };
    const matched = resolveWorkspace(cwd, agentId);
    if (matched === undefined) return { skipped: 'no-match', cwd };
    if (!ready || preloading) {
      // 模块还没预导入完（启动头几毫秒、或刚改过清单的那一瞬）：**不要**在这里记一条
      // failed 行——那条记录会一直留着，让这个会话永远缺插件（签名没变就不会重挂）。
      // 正确做法是「什么都不做」：调用方 refresh() 在 preload 之后必定会 sweep 一次
      // 活会话列表，那时这个会话已经在列表里，会被正常挂上（同步提交，模块已就绪）。
      return { skipped: 'not-ready', cwd };
    }
    if (scopeOf(agent.ctx) === undefined) {
      // 硬闸：没有作用域标签的上下文会把注册落到进程全局层。
      log('error', `拒绝挂载：会话 ${agentId} 的 agent 上下文没有作用域标签（注册会变成全局）`);
      return { skipped: 'unscoped', reason: 'agent 上下文没有作用域标签，拒绝挂载以免污染其它会话' };
    }
    const record = {
      agentId,
      cwd,
      // key：稳定键（ws:<id> / path:<路径>），设置页与内存里的清单都用它对行。
      key: matched.workspace.key ?? workspaceKeyOf(matched.workspace),
      workspaceId: matched.workspace.workspaceId ?? null,
      // workspace：给人看的显示串（本机路径；身份绑定且本机无路径时退回 `工作区 <id>`）。
      workspace: matched.workspace.path ?? matched.workspace.registryPath ?? (matched.workspace.workspaceId === undefined ? '(未知工作区)' : `工作区 ${matched.workspace.workspaceId}`),
      workspaceLabel: matched.workspace.label ?? matched.workspace.registryTitle ?? undefined,
      mode: matched.mode,
      // 凭什么命中：session（注册表账）| path（精确/子树），以及命中的是哪条路径
      // （主路径还是本机附加路径）——设置页要能说清「为什么这个会话被挂上了」。
      matchedBy: matched.by ?? 'path',
      matchedPath: matched.path ?? null,
      matchedKind: matched.kind ?? null,
      signature: workspaceSignature(matched.workspace),
      mountedAt: new Date().toISOString(),
      agent,
      rows: [],
    };
    mounts.set(agentId, record);
    // 泄漏探针：挂这个会话的全部行**之前**记一次进程全局层的工具名，全部结算后再看
    // 一次；凭空多出来的名字说明有注册逃出了会话作用域（等于对所有会话生效）——本
    // 插件唯一的承诺就是不会发生这件事，所以宁可多花一次投影也要把它变成可见信号。
    //
    // 只开到**会话**粒度、不点到行：窗口是按时间切的，一次 sweep 里同时挂的多个会话
    // 会互相污染对方的窗口（评审实测：干净的那一行也被标成泄漏）。与其给错误的行号，
    // 不如老实说「本次挂载窗口内全局层多出了这些名字」。
    const globalToolsBefore = globalToolNames();
    const settled = [];
    for (const row of matched.workspace.plugins) {
      const entry = mountRow(agent, row, agentId, matched.workspace);
      record.rows.push(entry);
      if (entry.settled !== undefined) settled.push(entry.settled);
    }
    if (globalToolsBefore !== null && settled.length > 0) {
      void Promise.all(settled).then(() => {
        const leaked = globalToolNames().filter((name) => !globalToolsBefore.includes(name));
        if (leaked.length === 0) return;
        record.leaked = leaked;
        log('error', `会话 ${agentId}：本次挂载窗口内进程全局层多出 ${leaked.join(', ')}——本工作区有子插件把注册落到了全局层（对所有会话生效）。逐行定位需要单独开一个会话复现`);
      }).catch(() => {});
    }
    return record;
  }

  /**
   * 模块预导入失败的报错是否属于「本机根本没有这个文件/包」。
   *
   * 只认明确的「找不到」类错误（ENOENT / ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND /
   * Cannot find module|package），语法错误、导出形状错误、依赖内部抛错都不算——那些
   * 在哪台设备上都是真故障。
   * @param error - 预导入记录里的错误文本。
   * @returns 是否属于「本机缺失」。
   */
  function missingLocally(error) {
    if (typeof error !== 'string' || error === '') return false;
    return /ENOENT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (module|package)/.test(error);
  }

  /** 路径类标识（相对/绝对/file:）——它们的文件只存在于声明时那台设备上。 */
  function pathLike(specifier) {
    if (typeof specifier !== 'string' || specifier === '') return false;
    const kind = classifySpecifier(specifier);
    return kind === 'relative' || kind === 'absolute' || kind === 'file';
  }

  /**
   * 提交一个行的挂载。
   * @param agent - 目标 agent。
   * @param row - 有效清单里的行。
   * @param agentId - 会话 id（诊断用）。
   * @param workspace - 该行所属的工作区记录（网络工作区的判定要用它，可缺省）。
   * @returns 行记录（状态先 pending，随后异步结算）。
   */
  function mountRow(agent, row, agentId, workspace) {
    const entry = { id: row.id, name: row.name, source: row.source, state: 'pending' };
    if (row.conflict === true) {
      entry.state = 'skipped';
      entry.error = '同一工作区内 id 与组合声明冲突，未挂载';
      return entry;
    }
    if (row.disabled === true) {
      entry.state = 'skipped';
      entry.error = '已停用';
      return entry;
    }
    const loaded = modules.get(row.name);
    if (loaded === undefined || loaded.state !== 'ok') {
      const raw = loaded?.error ?? '模块尚未预导入（配置刚变更或预导入失败）';
      // 网络工作区上的「本机没有这个模块」不是坏行：同一个工作区在别的设备上还有一份，
      // 而路径类子插件的文件只存在于那边。把它标成 unavailable 并给出可行动的说明，
      // 免得用户对着 failed 去本机找一个根本不该在本机的文件（评审前的形状就是那样）。
      const networkHint = workspace?.network?.hint ?? null;
      if (networkHint !== null && pathLike(row.name) && (missingLocally(raw) || loaded === undefined)) {
        entry.state = 'unavailable';
        entry.error = `${raw}；${networkHint}（路径类子插件不会跨设备传递：文件在哪台设备上，就得在哪台设备上声明这一行）`;
        return entry;
      }
      entry.state = 'failed';
      entry.error = raw;
      return entry;
    }
    try {
      let target = agent.ctx;
      for (const [service, label] of Object.entries(row.isolate ?? {})) {
        // true＝每次挂载一个独立服务域（两个会话各自 provide 同名服务不撞车）；
        // 字符串＝同名标签共享一个域（跨会话共用一份实现）。
        target = label === true ? target.isolate(service) : target.isolate(service, String(label));
      }
      const handle = target.plugin(loaded.plugin ?? loaded.module, configForMount(row));
      entry.handle = handle;
      entry.state = 'pending';
      // 结算：apply 抛错/配置校验失败由 fiber 内部吞掉并落 _error，必须靠 await 取回；
      // 等待服务而停在 pending 的行（出厂 mountPreset 会因此拒挂整份组合）在这里
      // 如实标成 waiting，并在设置页给可行动提示，而不是让人以为「挂了但没反应」。
      entry.settled = (async () => {
        try {
          await handle;
        } catch (error) {
          entry.state = 'failed';
          entry.error = message(error);
          log('warn', `会话 ${agentId}：子插件 ${row.id}（${row.name}）挂载失败：${message(error)}`);
          return;
        }
        const missing = Object.keys(handle.inject ?? {}).filter((name) => handle.ctx?.get?.(name) === undefined);
        if (missing.length > 0) {
          entry.state = 'waiting';
          entry.waitingFor = missing;
          log('warn', `会话 ${agentId}：子插件 ${row.id}（${row.name}）在等待服务 ${missing.join(', ')}——它在 agent 作用域里解析不到，检查该服务是否只在 host 平面提供`);
        } else {
          entry.state = 'active';
        }
      })();
    } catch (error) {
      entry.state = 'failed';
      entry.error = message(error);
      log('warn', `会话 ${agentId}：子插件 ${row.id}（${row.name}）提交失败：${message(error)}`);
    }
    return entry;
  }

  /**
   * 卸载一个会话的全部子插件。
   *
   * agent 被销毁时它的 fiber 本来就会连带卸载这些子 fiber（它们的父是 agent.ctx），
   * 这里显式再卸一次是为了**配置热重载**与**插件卸载**这两条路径：那时 agent 还活着。
   * @param agentId - 会话 id。
   * @returns 卸载完成。
   */
  async function unmountAgent(agentId) {
    const record = mounts.get(agentId);
    if (record === undefined) return false;
    mounts.delete(agentId);
    await Promise.all(record.rows.map(async (row) => {
      if (row.handle === undefined) return;
      try {
        await row.handle.dispose?.();
      } catch (error) {
        log('warn', `会话 ${agentId}：子插件 ${row.id} 卸载失败：${message(error)}`);
      }
    }));
    return true;
  }

  /** 一行的状态是否「还需要再试一次」。skipped（停用/冲突）不算不健康。 */
  function isUnhealthy(state) {
    // unavailable（网络工作区上本机没有的模块）也算不健康：会话期间那条路径上出现了
    // 文件、或用户把声明改对了，下一次 refresh 就该把它挂上，不该等到强制重挂。
    return state === 'failed' || state === 'waiting' || state === 'pending' || state === 'unavailable';
  }

  /**
   * 就地重试一个会话里不健康的行。
   *
   * 卸掉该行的 fiber → 重新判定 → 重新挂。健康的行完全不碰（它们的子插件实例、
   * 计数器、订阅都保留）。挂载记录原地更新，会话不会短暂「空窗」。
   * @param agent - 目标会话的 agent。
   * @param record - 该会话现有的挂载记录。
   * @returns 重试的行数。
   */
  async function retryUnhealthyRows(agent, record) {
    const cwd = agent?.session?.header?.cwd;
    const matched = resolveWorkspace(typeof cwd === 'string' ? cwd : undefined, typeof agent?.id === 'string' ? agent.id : undefined);
    if (matched === undefined) return 0;
    const rows = matched.workspace.plugins ?? [];
    let retried = 0;
    for (const row of rows) {
      const existing = record.rows.find((entry) => entry.id === row.id);
      if (existing === undefined || !isUnhealthy(existing.state)) continue;
      if (existing.handle !== undefined) {
        try {
          await existing.handle.dispose?.();
        } catch (error) {
          log('warn', `会话 ${agent.id}：重试前卸载行 ${row.id} 失败：${message(error)}`);
        }
      }
      const next = mountRow(agent, row, agent.id, matched.workspace);
      const index = record.rows.indexOf(existing);
      if (index >= 0) record.rows[index] = next;
      retried += 1;
      log('info', `会话 ${agent.id}：重试行 ${row.id}（原状态 ${existing.state}）`);
    }
    return retried;
  }

  /**
   * 按当前清单重挂所有活着的会话。
   *
   * 两种模式：
   *   · 默认（force=false）——**清单没变就不动**：用签名比对，相同则保留原挂载
   *     （避免无谓抖动与子插件状态丢失）；变了或不再命中则先卸（等卸载完成，避免
   *     同名工具/服务重复注册撞车）再按新清单挂。
   *   · force=true —— 全部卸载后重挂（显式「重新加载」/「强制重挂」）。
   * 已经不存在的会话（挂载记录里的 agentId 不在 live 列表）一律清掉。
   *
   * @param agents - 当前 live agent 列表。
   * @param options.force - 无视签名强制重挂。
   * @param options.signatureOf - `(agent, record) => string|null`：算出该会话当前
   *   应有的签名（null＝不再命中任何工作区），由调用方决定比对口径。
   * @returns `{ remounted, mounted, kept, skipped }` 计数。
   */
  async function remountLive(agents, options = {}) {
    const force = options.force === true;
    const signatureOf = options.signatureOf;
    const live = Array.isArray(agents) ? agents : [];
    const liveIds = new Set(live.map((agent) => agent?.id).filter((id) => typeof id === 'string'));
    for (const agentId of [...mounts.keys()]) {
      if (!liveIds.has(agentId)) await unmountAgent(agentId);
    }
    let remounted = 0;
    let mounted = 0;
    let kept = 0;
    const skipped = [];
    for (const agent of live) {
      if (typeof agent?.id !== 'string') continue;
      const existing = mounts.get(agent.id);
      if (existing !== undefined && !force && typeof signatureOf === 'function') {
        let next;
        try {
          next = signatureOf(agent, existing);
        } catch {
          next = undefined;
        }
        if (typeof next === 'string' && next === existing.signature) {
          // 签名相同≠没事：上一次挂载可能有行是 failed/waiting（模块当时坏了、服务还
          // 没就绪）。这种行**必须重试**，否则「改好文件 → 点保存」永远不生效，只能
          // 靠强制重挂（评审实测过：模块 failed→ok 而该行一直留在 failed）。
          // 只重试不健康的那几行：健康的行保持原实例，不丢子插件的运行时状态。
          const retried = await retryUnhealthyRows(agent, existing);
          if (retried > 0) remounted += 1;
          else kept += 1;
          continue;
        }
      }
      if (existing !== undefined) await unmountAgent(agent.id);
      const record = mountForAgent(agent);
      if (record.skipped === undefined) {
        if (existing === undefined) mounted += 1;
        else remounted += 1;
      } else if (record.skipped !== 'no-match' && record.skipped !== 'no-cwd') {
        skipped.push({ agentId: agent.id, reason: record.reason ?? record.skipped });
      }
    }
    return { remounted, mounted, kept, skipped };
  }

  /** 卸掉全部挂载（插件卸载时调用）。 */
  async function disposeAll() {
    const ids = [...mounts.keys()];
    await Promise.all(ids.map(async (id) => await unmountAgent(id)));
    return ids.length;
  }

  /** 挂载状态的可序列化快照（设置页与 /status 用）。 */
  function mountSnapshot() {
    return [...mounts.values()].map((record) => ({
      sessionId: record.agentId,
      cwd: record.cwd,
      key: record.key,
      workspaceId: record.workspaceId,
      workspace: record.workspace,
      workspaceLabel: record.workspaceLabel,
      mode: record.mode,
      matchedBy: record.matchedBy,
      matchedPath: record.matchedPath,
      matchedKind: record.matchedKind,
      mountedAt: record.mountedAt,
      leaked: record.leaked,
      rows: record.rows.map((row) => ({
        id: row.id,
        name: row.name,
        source: row.source,
        state: row.state,
        error: row.error,
        waitingFor: row.waitingFor,
      })),
    }));
  }

  /** 换一份有效清单（后续挂载按新清单判定）。 */
  function setWorkspaces(next) {
    workspaces = Array.isArray(next) ? next : [];
  }

  return {
    baseUrl,
    setWorkspaces,
    getWorkspaces: () => workspaces,
    preload,
    probe,
    moduleSnapshot,
    resolveWorkspace,
    mountForAgent,
    unmountAgent,
    remountLive,
    disposeAll,
    mountSnapshot,
    isMounted: (agentId) => mounts.has(agentId),
    mountedCount: () => mounts.size,
  };
}

/**
 * 把 baseUrl 归一成字符串 URL：接受 string / URL / undefined。
 * 都拿不到时退回「本文件所在插件目录的上上级」＝组合文件所在的 profile 目录，
 * 与组合行 `./plugins/...` 的解析基准一致。
 * @param value - ctx.baseUrl 或显式配置。
 * @returns 以 / 结尾的 URL 字符串。
 */
export function normalizeBase(value) {
  const fallback = new URL('../../', import.meta.url).href;
  if (value === undefined || value === null || value === '') return fallback;
  try {
    const url = value instanceof URL ? value : new URL(String(value));
    return url.href.endsWith('/') ? url.href : url.href.replace(/[^/]*$/, '');
  } catch {
    return fallback;
  }
}

/**
 * 描述一个插件的形态（设置页「探测」用，不执行它）。
 * 三种合法形态：插件函数本体、带 apply 的对象、以及（归一前的）带 default 的命名空间。
 * @param plugin - 已 `unwrapExports` 的插件，或原始命名空间。
 * @returns 形态描述；输入为空时返回 undefined。
 */
export function describeModule(plugin) {
  if (plugin === undefined || plugin === null) return undefined;
  if (typeof plugin === 'function') {
    return {
      apply: 'function',
      inject: Array.isArray(plugin.inject) ? plugin.inject : undefined,
      name: typeof plugin.name === 'string' ? plugin.name : undefined,
      form: 'plugin 函数',
    };
  }
  const apply = typeof plugin.apply === 'function' ? 'function' : typeof plugin.default === 'function' ? 'default' : undefined;
  const inject = Array.isArray(plugin.inject) ? plugin.inject : undefined;
  const name = typeof plugin.name === 'string' ? plugin.name : undefined;
  return { apply, inject, name, form: apply === undefined ? '不是插件' : '带 apply 的对象', keys: Object.keys(plugin).slice(0, 24) };
}
