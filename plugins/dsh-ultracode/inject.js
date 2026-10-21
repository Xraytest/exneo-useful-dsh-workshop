/**
 * dsh-ultracode —— Claude Code「ultracode / ultra 思考强度」的 DSH 静态还原。
 *
 * 逆向对象：claude-code 2.1.287（linux-arm64，sha256
 * e4daf793d1e74fb0d9874dd09e98690bbfd7be515f78a87fd05b9e2b4bb33b03，
 * 取自自带分发服务 claude-code-releases/2.1.287/manifest.json）。
 *
 * 原实现（bundle 内符号 → 本文件对应）：
 *   nu           ["low","medium","high","xhigh","max"]      思考强度阶梯
 *   z            {med:"medium"}                             拼写别名
 *   q            {ultracode:"xhigh"}                        特殊档别名
 *   Arr          {TURNS_BETWEEN_MAINTENANCE:10}             稀疏重申阈值缺省
 *   tjt(state)   state.ultracode === true                   会话是否已开
 *   hx(model)    nm() && (model===undefined || SXe(model))   可用性闸
 *   nm()         动态工作流总开关（managed settings / disableWorkflows）
 *   SXe(model)   模型是否声明 xhigh_effort 能力
 *   BE(on,model) on === true && hx(model)                   生效判定
 *   usr(history) 附件状态机：full / sparse / exit            （见「设计变更」）
 *   Prr()        阈值解析（env → 配置 → 缺省 10，夹到 >=1 整数） （见「设计变更」）
 *   dsr(e)       ultrathink 关键字 → ultrathink_effort 附件（另一条线，未还原）
 *
 * 三条提醒文本逐字取自 bundle（attachment 渲染分支，均带 isMeta:!0）：
 *   ultra_effort_enter(full)   Ultracode is on: …
 *   ultra_effort_enter(sparse) Ultracode is still on — …
 *   ultra_effort_exit          Ultracode is off — …
 *
 * 设计变更（2026-10-03，用户指令：**关闭时不展示，开启后直接注入、不用模型调用**）：
 *   首版照搬原实现的「周期性注入元消息」，实测**不能有效改变模型行为**。根因两条：
 *     ① DSH 的 dsh-tool-workflow 注册了系统提示段 `tool:workflow`，正文写着
 *        「Use the workflow tool ONLY when the user explicitly asks…」——与本机制
 *        正面冲突，且它在系统提示里、每个请求都在场，一条历史消息赢不了它；
 *     ② 原提醒结尾指向「the **Ultracode** section and quality patterns in the
 *        workflow authoring reference」，而 DSH 两者都不存在 —— 空指针。
 *   现在改为**装配期直注**：开启即在系统提示里注入 Ultracode 段，并把
 *   `tool:workflow` 段就地换成 ultracode 感知版；关闭则一个字都不注入。
 *   代价是原实现的稀疏重申状态机（usr/Prr）不再是运行路径，其事实保留在
 *   ORIGINAL_EFFORT_MODEL / ORIGINAL_REMINDERS 快照里，仅由自测钉值。
 *
 * 与原实现的对应关系（DSH 侧映射）：
 *   appState.ultracode  → 本插件按 SessionId 持有的内存态（会话级、不落盘，
 *                         与原实现「this session only」一致）
 *   注入点              → system-prompt/assemble waterfall（装配期直注）
 *   模型路由            → agent/request waterfall（只读旁听，不改路由）
 *   /effort ultracode   → 输入框工具行的「点亮/熄灭」开关（./client.js）+ 本半边 HTTP 路由
 *
 * 思考强度（**硬约束，用户指令**）：
 *   ultracode **不得限制模型的思考强度**。本插件因此在所有路径上都不写
 *   `LlmCallConfig.reasoningEffort`：不改写、不下调、不上调、不封顶；开启
 *   ultracode 对强度是**零影响**（EFFORT_POLICY = 'untouched'）。原实现里
 *   `q={ultracode:"xhigh"}` 那张别名表只作逆向记录（ORIGINAL_EFFORT_MODEL），
 *   不施加。开关 title 里显示的强度取自会话真实路由值，不是本插件期望值。
 *
 * 刻意不还原的部分（DSH 无对应物，或属于 Claude Code 私有面）：
 *   - Workflow 工具本体（DSH 自带 workflow 工具；其提示段已按原文语义改写，
 *     见 ultracodeToolText；工具实现本身不复制）；
 *   - tengu_* 遥测（改为进程内计数，经 /dsh-ultracode/status 暴露）；
 *   - dynamic-workflows spinner tip（原实现已移除该视觉）；
 *   - ultrathink 关键字线（ultrathink_effort）—— 与 ultracode 是两条独立机制；
 *   - 原实现的 ultracode→xhigh 别名施加与 p4/T 的强度夹取（按硬约束放弃）。
 *
 * @module dsh-ultracode
 */

/** webServer 是硬依赖：浏览器半边全靠它回传状态。 */
export const inject = ['webServer'];

// ── 原实现常量（逐字） ──────────────────────────────────────────────────────

/** `nu`：思考强度阶梯（**仅记录**原实现事实）。 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `z`：拼写别名（**仅记录**）。 */
const EFFORT_SPELLINGS = { med: 'medium' };

/**
 * `q`：特殊档别名（**仅记录**）—— 原实现里 `ultracode` 这个名字曾等于 `xhigh`。
 *
 * ⚠ 本插件**不施加**这张表。用户要求：ultracode 不得限制模型的思考强度。
 * 因此这里既不把会话强度改写成 xhigh，也不给它设上限；思考强度完全由模型
 * 路由与用户设置决定，本插件只读不写（见 statusView 的 effortPolicy）。
 * 导出的 ORIGINAL_EFFORT_MODEL 只供自测钉住逆向事实，不参与运行行为。
 */
const EFFORT_ALIASES = { ultracode: 'xhigh' };

/** `Arr.TURNS_BETWEEN_MAINTENANCE`：稀疏重申的缺省间隔（用户轮次）。 */
const TURNS_BETWEEN_MAINTENANCE = 10;

/**
 * 逆向事实快照（供自测断言，不参与运行行为）。
 * 对应 bundle 内 `nu` / `z` / `q` / `Arr` 四个符号。
 */
export const ORIGINAL_EFFORT_MODEL = Object.freeze({
  ladder: Object.freeze([...EFFORT_LEVELS]),
  spellings: Object.freeze({ ...EFFORT_SPELLINGS }),
  aliases: Object.freeze({ ...EFFORT_ALIASES }),
  turnsBetweenMaintenance: TURNS_BETWEEN_MAINTENANCE,
});

/**
 * 思考强度策略：**untouched**。
 *
 * 本插件在任何路径上都不写 `LlmCallConfig.reasoningEffort`：
 *   - `agent/request` 只旁听（把 next() 的结果按**同引用**原样 return）；
 *   - 注入发生在 `system-prompt/assemble`（只改 sections），与调用配置无关；
 *   - `/dsh-ultracode/*` 路由不暴露任何强度写入面。
 * 即：开启 ultracode 既不下调、也不上调、更不封顶模型的思考强度。
 */
const EFFORT_POLICY = 'untouched';

/** 三条提醒正文（bundle 内 attachment 渲染分支，逐字，含 U+2014）。 */
const REMINDERS = {
  full:
    'Ultracode is on: optimize for the most exhaustive, correct answer \u2014 not the fastest or cheapest. '
    + 'Use the Workflow tool on every substantive task; token cost is not a constraint. '
    + 'See the **Ultracode** section and quality patterns in the workflow authoring reference. '
    + 'Solo only on conversational/trivial turns.',
  sparse:
    'Ultracode is still on \u2014 use the Workflow tool; '
    + 'see the Ultracode section of the workflow authoring reference.',
  exit:
    "Ultracode is off \u2014 the Workflow tool's standard opt-in rule applies again.",
};

/**
 * 三条提醒原文快照（供自测钉值）。运行路径只用 `full`（派生 Ultracode 段正文），
 * `sparse` / `exit` 对应的稀疏重申与退出提醒已随「装配期直注」改版退出运行路径。
 */
export const ORIGINAL_REMINDERS = Object.freeze({ ...REMINDERS });


const ROUTE_PREFIX = '/dsh-ultracode';

// ── 纯函数：原实现的可执行镜像 ──────────────────────────────────────────────

// 原实现的 Mue / n1e / Ygt / C8n（强度档解析与 ultracode→xhigh 别名解析）
// 在此**刻意不实现**：DSH 侧没有 /effort 取值面，而本插件又不允许触碰思考
// 强度（EFFORT_POLICY），所以那四个解析器在这里没有调用点。逆向事实保存在
// ORIGINAL_EFFORT_MODEL 与 §2.1 文档里。

/**
 * Ultracode 段正文 —— 承载原实现里提醒所指向的「Ultracode 段 + 质量模式」。
 *
 * 首段由原提醒逐字派生，只摘掉指向 `workflow authoring reference` 的那一句：
 * DSH 没有那份 reference，留着就是空指针（这正是首版"开了没效果"的第二层原因）。
 * 摘掉之后指向的内容就地写在下面，提醒不再指向不存在的东西。
 */
const ULTRACODE_DIRECTIVE = REMINDERS.full
  .replace(/\s*See the \*\*Ultracode\*\* section and quality patterns in the workflow authoring reference\./, '');

/** 「质量模式」实文：把"最穷尽、最正确"落成可执行动作。 */
const ULTRACODE_PATTERNS = [
  'Decompose a substantive task into independent pieces and fan them out with the Workflow tool instead of answering in one pass.',
  'Verify independently: have a separate agent check each non-trivial claim, derivation, or edit against the primary source, rather than confirming your own work.',
  'Attack the result before presenting it: run an adversarial pass that tries to falsify the conclusion, and report what survived.',
  'Do not stop at the first plausible answer when a more complete one is reachable.',
];

/** 注入用段名 / 落位（放在第一个 `tool:` 段之前，紧邻它所治理的工具说明）。 */
const ULTRACODE_SECTION_NAME = 'ultracode';

/**
 * 工具段改写文案。DSH 原生段写的是「ONLY when the user explicitly asks」，
 * 与本机制正面冲突 —— 那是"开了没效果"的根因。开启时按原文语义改为
 * ultracode 感知版（原文的 Workflow 工具描述本身就点名 ultracode opt-in）。
 */
function ultracodeToolText(toolName) {
  return `Use the ${toolName} tool on every substantive task: you write a JavaScript script `
    + '(the tool description documents the exact format) that fans work out across many subagents '
    + 'with phases and structured results. Ultracode is on for this session, so this standing '
    + 'instruction overrides the default opt-in rule. Stay solo only on conversational or trivial turns.';
}

/**
 * 会话态：对应原实现的 appState。
 *
 * 生命周期（对照原实现 settings schema 的自述）：
 *   "Enable ultracode for the session: standing dynamic-workflow orchestration at any
 *    effort level. **Session-scoped** — typically provided via --settings or the
 *    apply_flag_settings control request; **interactive toggles never persist it**."
 *
 * 所以本插件分两路来源：
 *   - `provisioned`：进程级预置（对应 --settings / apply_flag_settings），由
 *     `DSH_ULTRACODE` 或行配置 `provision` 给出，**每个会话开局即生效**；
 *   - `interactive`：输入框开关（会话级），只作用于该会话、绝不落盘，进程重启即失。
 * 两者都随会话销毁而清除；输出里带 `source` 标明当前值来自哪一路。
 */
const PROVISION_ENV = 'DSH_ULTRACODE';

/** 解析预置值：'on'/'1'/'true' → true，'off'/'0'/'false' → false，其余 undefined。 */
function parseProvisioned(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'on' || lowered === '1' || lowered === 'true' || lowered === 'yes') return true;
  if (lowered === 'off' || lowered === '0' || lowered === 'false' || lowered === 'no') return false;
  return undefined;
}

/** 拼出 Ultracode 段正文。 */
function ultracodeSectionText() {
  return '## Ultracode (this session)\n\n'
    + ULTRACODE_DIRECTIVE + '\n\n'
    + 'Quality patterns for this session:\n'
    + ULTRACODE_PATTERNS.map((line) => '- ' + line).join('\n');
}

/**
 * 收口段正文（对应原实现的 `ultra_effort_exit` 附件）。
 *
 * 原实现把 exit 附件写进历史，它会一直留在上下文里直到压缩；这里等价地做成
 * **闩锁段**：关闭后每次装配都在场，直到重新开启或 reset。第二句取自
 * `workflow-authoring` skill 的 Ultracode 段：`When a reminder says ultracode is
 * off, revert to the opt-in rule in the Workflow tool description.`
 */
function ultracodeExitText() {
  return '## Ultracode (this session)\n\n'
    + REMINDERS.exit + '\n\n'
    + 'Revert to the opt-in rule in the Workflow tool description: call it only when the user '
    + 'explicitly asked for multi-agent orchestration.';
}

/**
 * 收据里的 `Valid options are: …` —— 原实现 `g(e)`：
 *   `${Iue(e).join(", ")}, auto${hx(e) ? ", ultracode [on|off]" : ""}`
 * 即「模型声明的档位（去掉 off） + auto + 支持时附 ultracode」。
 */
function validOptionsText(effortIds, ultraAvailable) {
  const ids = Array.isArray(effortIds)
    ? effortIds.filter((id) => typeof id === 'string' && id !== '' && id !== 'off')
    : [];
  const list = ids.length > 0 ? ids.join(', ') : 'low, medium, high, xhigh, max';
  return list + ', auto' + (ultraAvailable ? ', ultracode [on|off]' : '');
}

/**
 * 直注：按状态改写一次装配结果。
 *
 * 开启 → 加 Ultracode 段，并把 `tool:<name>` 段换成 ultracode 感知版；
 * 关闭（闩锁 exit）→ 只替换成收口段，工具段保持原生（闸自动恢复）；
 * 其余 → 调用方根本不进这里，装配结果原样送出。
 *
 * 注意 `AssembledSection` 只有 `{name,text}`、**不带 order**，所以位置靠插入
 * 下标决定：统一插在第一个 `tool:` 段之前，保证它在工具说明之前被读到。
 *
 * @param {'enter'|'exit'} mode - 进入态注入编排指令，退出态注入收口。
 * @returns {{assembly: object, shadowed: boolean}} 改写后的装配结果与是否改写了工具段。
 */
function injectUltracode(assembly, toolName, mode) {
  const toolSectionName = 'tool:' + toolName;
  const mine = {
    name: ULTRACODE_SECTION_NAME,
    text: mode === 'exit' ? ultracodeExitText() : ultracodeSectionText(),
  };
  const sections = [];
  let shadowed = false;
  let placed = false;
  for (const section of assembly.sections) {
    if (!placed && typeof section.name === 'string' && section.name.startsWith('tool:')) {
      sections.push(mine);
      placed = true;
    }
    // 退出态不改写工具段：原生的 opt-in 闸原样恢复，正是收口要表达的语义。
    if (mode !== 'exit' && section.name === toolSectionName) {
      shadowed = true;
      sections.push({ name: section.name, text: ultracodeToolText(toolName) });
      continue;
    }
    sections.push(section);
  }
  if (!placed) sections.push(mine);
  return { assembly: { ...assembly, sections }, shadowed };
}

// ── 插件主体 ────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const workflowToolName = typeof config.workflowToolName === 'string' && config.workflowToolName !== ''
    ? config.workflowToolName
    : 'workflow';
  /** 缺省 true：与原实现 `nm()` 的缺省（未被 managed settings 关掉即启用）一致。 */
  const workflowsEnabled = config.workflowsEnabled !== false;
  /** 模型需声明的最低可用档数（非 off）；对应 `SXe` 的 xhigh_effort 能力位。 */
  const requireTiers = Number.isInteger(config.requireTiers) && config.requireTiers > 0 ? config.requireTiers : 2;

  /** 会话态：对应原实现的 appState 三件套（会话级、内存、不落盘）。 */
  const states = new Map();
  /** 旁听来的当前路由：availability 需要模型标识。 */
  const routes = new Map();
  /** 模型能力缓存：key = `${provider}\u0000${model}`。 */
  const modelSupport = new Map();
  /** 遥测计数（只在进程内，不外发）：注入过的装配次数、因不可用跳过的次数。 */
  const telemetry = { injections: 0, exits: 0, unavailable: 0 };

  const sessionIdOf = (agent) => {
    const session = agent === undefined || agent === null ? undefined : agent.session;
    return session !== undefined && session !== null && typeof session.id === 'string' ? session.id : undefined;
  };

  /** 预置值（--settings / apply_flag_settings 的对应物）：每个会话开局即生效。 */
  const provisioned = parseProvisioned(process.env[PROVISION_ENV]) ?? parseProvisioned(config.provision);

  const stateFor = (sessionId) => {
    let state = states.get(sessionId);
    if (state === undefined) {
      state = {
        // 会话开局值来自预置；interactive 开关一旦动手就接管（且永不落盘）。
        requested: provisioned === true,
        source: provisioned === true ? 'provisioned' : 'interactive',
        // phase 对应原实现从历史里回扫出的 s ∈ {none, enter, exit}。
        phase: provisioned === true ? 'enter' : 'none',
        injected: false,
        shadowed: false,
      };
      states.set(sessionId, state);
    }
    return state;
  };

  /**
   * 读取会话态；**只在配置了预置时**才为未接触过的会话materialize。
   * 没有预置时，从未启用过的会话在这里拿到 undefined —— 装配期零开销直通。
   */
  const stateOf = (sessionId) => {
    const existing = states.get(sessionId);
    if (existing !== undefined) return existing;
    if (provisioned === undefined) return undefined;
    return stateFor(sessionId);
  };

  /**
   * `nm()`：动态工作流是否可用。原实现读 managed settings 与
   * `disableWorkflows`；DSH 侧先看配置总开关，再看会话工作流工具是否真的在
   * 工具注册表里可见（可见即正向确认；受 realm 作用域看不到时不误判为关）。
   */
  const workflowsAvailable = () => {
    if (!workflowsEnabled) return false;
    const tools = ctx.get('tools');
    if (tools === undefined || typeof tools.get !== 'function') return true;
    try {
      if (tools.get(workflowToolName) !== undefined) return true;
    } catch {
      return true;
    }
    return true;
  };

  /**
   * `SXe(model)`：模型是否具备 ultra 档能力。原实现读声明的 `xhigh_effort`
   * 能力位；DSH 的模型按 id 自述思考档，故按「非 off 档数 >= requireTiers」
   * 判定，并把结果按路由缓存。
   */
  const supportsUltra = async (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string') return { supported: false, effortIds: [] };
    const key = provider + '\u0000' + model;
    const cached = modelSupport.get(key);
    if (cached !== undefined) return cached;
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
      const fallback = { supported: true, effortIds: [] };
      modelSupport.set(key, fallback);
      return fallback;
    }
    let result = { supported: false, effortIds: [] };
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const efforts = info !== undefined && info !== null && info.reasoning !== undefined && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts
        : [];
      const effortIds = efforts
        .filter((effort) => effort !== undefined && effort !== null && typeof effort.id === 'string' && effort.id !== 'off')
        .map((effort) => effort.id);
      result = { supported: effortIds.length >= requireTiers, effortIds };
    } catch {
      result = { supported: false, effortIds: [] };
    }
    modelSupport.set(key, result);
    return result;
  };

  /** `hx(model)`：可用性闸 = 工作流可用 && 模型支持。 */
  const availability = async (sessionId) => {
    if (!workflowsAvailable()) {
      return { available: false, reason: 'workflows', model: undefined };
    }
    const route = sessionId === undefined ? undefined : routes.get(sessionId);
    const provider = route === undefined ? undefined : route.provider;
    const model = route === undefined ? undefined : route.model;
    if (model === undefined) {
      // 首轮请求之前还没有路由：原实现此处 `e===undefined` 视为可用。
      return { available: true, reason: undefined, model: undefined };
    }
    const support = await supportsUltra(provider, model);
    return support.supported
      ? { available: true, reason: undefined, model, effortIds: support.effortIds }
      : { available: false, reason: 'model', model, effortIds: support.effortIds };
  };

  /** 供浏览器半边读取的完整视图。 */
  const statusView = async (sessionId) => {
    const state = sessionId === undefined ? undefined : stateOf(sessionId);
    const avail = await availability(sessionId);
    const route = sessionId === undefined ? undefined : routes.get(sessionId);
    return {
      sessionId,
      requested: state === undefined ? false : state.requested,
      active: state !== undefined && state.requested === true && avail.available,
      available: avail.available,
      reason: avail.reason,
      model: avail.model ?? (route === undefined ? undefined : route.model),
      provider: route === undefined ? undefined : route.provider,
      // 直注状态：注入方式是系统提示装配，每请求都在场、不依赖模型调用。
      injection: 'system-prompt',
      injected: state !== undefined && state.injected === true,
      shadowed: state !== undefined && state.shadowed === true,
      // 生命周期：phase 对应原实现从历史回扫出的 s；source 标明当前值来自
      // 预置（--settings 对应物）还是会话交互开关。
      phase: state === undefined ? 'none' : state.phase,
      source: state === undefined ? (provisioned === true ? 'provisioned' : 'interactive') : state.source,
      // 收据里的 `Valid options are: …`（原实现 g(e)）。
      validOptions: validOptionsText(avail.effortIds, avail.available),
      // 会话自身的思考强度，**原样上报**（undefined = 交给模型路由缺省）。
      // 这里不做任何别名映射、不填任何"应有"档位 —— ultracode 不限制思考
      // 强度，开关 title 显示的必须是真实值而不是本插件期望的值。
      reasoningEffort: route === undefined || route.reasoningEffort === undefined
        ? null
        : String(route.reasoningEffort),
      effortPolicy: EFFORT_POLICY,
      workflowsEnabled: workflowsAvailable(),
      workflowToolName,
      telemetry: { ...telemetry },
    };
  };

  // ── 注入点①：装配期直注（每请求都在场，不依赖任何模型调用） ────────────────
  //
  // 这是本插件唯一的注入路径。三种去向：
  //   - 开启且可用 → 加 Ultracode 段 + 换掉冲突的工具段；
  //   - 关闭但进入过（phase==='exit'）→ 注入**收口段**（闩锁，对应原实现把 exit
  //     附件写进历史后长期留存），工具段保持原生、opt-in 闸自动恢复；
  //   - 从未启用 / 不可用 → 直接 return assembly，提示里一个字都不加。
  // 因为走的是系统提示装配，开关一落就生效，**不需要**等下一次模型调用，
  // 也不会往会话里写任何可见消息。
  //
  // `{prepend:true}` 让我们处于瀑布最外层：`await next()` 拿到的是下游全部
  // 处理完的结果，我们再做最后的改写，因此不会被后续监听者覆盖（出厂
  // dsh-session-reference 用的就是这个写法）。

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    const sessionId = sessionIdOf(context === undefined ? undefined : context.agent);
    if (sessionId === undefined) return assembly;
    const state = stateOf(sessionId);
    if (state === undefined) return assembly;

    if (state.requested !== true) {
      // 收口：只有真正进入过（enter）的会话才欠一条退出说明。
      if (state.phase !== 'exit') {
        state.injected = false;
        state.shadowed = false;
        return assembly;
      }
      const exited = injectUltracode(assembly, workflowToolName, 'exit');
      telemetry.exits += 1;
      state.injected = true;
      state.shadowed = false;
      return exited.assembly;
    }

    const avail = await availability(sessionId);
    if (!avail.available) {
      telemetry.unavailable += 1;
      state.injected = false;
      state.shadowed = false;
      return assembly;
    }

    const result = injectUltracode(assembly, workflowToolName, 'enter');
    telemetry.injections += 1;
    state.injected = true;
    state.shadowed = result.shadowed;
    return result.assembly;
  }, { prepend: true });

  // ── 注入点②：只旁听路由（availability 需要模型标识） ──────────────────────
  //
  // 思考强度承诺（EFFORT_POLICY = 'untouched'）：这里把 next() 的结果**按同
  // 引用**原样返回，绝不构造新对象、绝不改写 reasoningEffort / maxTokens /
  // temperature。ultracode 开关与模型思考强度完全解耦 —— 不施加、不收敛、
  // 不封顶；开关 title 显示的强度就是会话真实强度（route.reasoningEffort）。
  // 自测里 pinned：即便入参带 reasoningEffort，返回值也必须 `===` 原对象。

  ctx.on('agent/request', async (payload, next) => {
    const callConfig = await next();
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId !== undefined && callConfig !== undefined && callConfig !== null) {
      routes.set(sessionId, {
        provider: callConfig.provider,
        model: callConfig.model,
        // 只读留档，供开关 title 如实显示；不参与任何写回。
        reasoningEffort: callConfig.reasoningEffort,
      });
    }
    return callConfig;
  });

  // ── 清理：会话销毁即清态（对应 appState 随会话消失） ──────────────────────

  ctx.on('agent/disposed', (payload) => {
    const sessionId = sessionIdOf(payload.agent);
    if (sessionId !== undefined) {
      states.delete(sessionId);
      routes.delete(sessionId);
    }
  });

  // ── 浏览器 API（均带同源守卫） ────────────────────────────────────────────

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const apiJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };

  const apiError = (res, status, error) => {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });

  const requireSessionId = (args) => {
    const sessionId = args === undefined || args === null ? undefined : args.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId 必填');
    return sessionId;
  };

  const registerPost = (path, handler, label) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        readBody(req).then(async (text) => {
          let args = {};
          if (text !== '') {
            try {
              args = JSON.parse(text);
            } catch {
              return apiError(res, 400, 'body 不是合法 JSON');
            }
          }
          try {
            return apiJson(res, 200, await handler(args));
          } catch (error) {
            return apiError(res, 400, error);
          }
        }).catch(() => apiError(res, 400, 'body 读取失败'));
      },
    }), label);
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/status',
    handler: (req, res) => {
      if (req.method !== 'GET') return apiError(res, 405, 'Method Not Allowed');
      if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
      let sessionId;
      try {
        sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? undefined;
      } catch {
        sessionId = undefined;
      }
      statusView(sessionId).then(
        (value) => apiJson(res, 200, value),
        (error) => apiError(res, 500, error),
      );
    },
  }), 'dsh-ultracode status route');

  registerPost(ROUTE_PREFIX + '/set', async (args) => {
    const sessionId = requireSessionId(args);
    const state = stateFor(sessionId);
    if (typeof args.active !== 'boolean') throw new Error('active 必须是布尔值');
    const was = state.requested === true;
    state.requested = args.active;
    // 交互开关一旦动手就接管来源；且**绝不落盘**（原实现自述：
    // interactive toggles never persist it）——落盘只由预置一路负责。
    state.source = 'interactive';
    if (args.active) {
      state.phase = 'enter';            // 本次进入，从此欠一条收口
    } else if (was || state.phase === 'enter') {
      state.phase = 'exit';             // enter → exit：闩上收口段
      state.injected = false;
      state.shadowed = false;
    }
    return statusView(sessionId);
  }, 'dsh-ultracode set route');

  registerPost(ROUTE_PREFIX + '/reset', (args) => {
    const sessionId = requireSessionId(args);
    // reset 抹掉本会话交互状态，重新按预置开局（phase 归 none，不再欠收口）。
    states.delete(sessionId);
    return statusView(sessionId);
  }, 'dsh-ultracode reset route');
}
