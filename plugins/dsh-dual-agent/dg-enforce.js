/**
 * 双智能指导 · 主智能约束（dg-enforce.js）
 *
 * 用户要求（2026-11-03）：「如果插件使能，则主会话的智能体不应该亲自进行任何除
 * 判断以外的行为，编码、调试、信息收集等任何需求都需要交给子代理完成。」
 *
 * 机制选择（为什么不是 tools.restrict 当权威）：
 *   `tools.restrict()` / `agent.ctx.tools.guard()` 都挂在**作用域链**上
 *   （@deepseek-ai/dsh-tools 的 view() 注释原话：「Restrictions intersect across the
 *   whole chain: any scope on it may mask an inherited name for everything nested
 *   inside it」）。执行者子代理的作用域链把父 Agent 那一层当祖先，所以在父作用域上
 *   摘工具会**连带摘掉子代理的工具**——那正好摧毁本插件想做的事。
 *   权威手段因此是**注册在插件根作用域的 guard**：回调里按 `exec.agent.id` 精确判定
 *   「是被武装的那个主会话本人在调用」，只否它的调用。子代理、其它会话、嵌套层都不受影响。
 *
 * 可选 `hideMainTools`（默认关）：把不该用的工具也从主智能的**清单**里摘掉，然后在
 * 每个子代理出生时（agent/created）把定义重新注册进子代理**自己的那一层**——按同一
 * 份注释「own layer 的注册不受祖先 restriction 过滤」，理论上既隐藏又不伤子代理。
 * 这条路依赖作用域实现细节，所以：
 *   ① 默认关；
 *   ② 打开时每次补注册后**回读子代理的可见清单**自检；仍缺就撤销隐藏、降级回
 *      guard-only，并把降级原因交给 status。绝不静默半坏。
 *
 * 人格段泄漏也在这里处理：`system-prompt/assemble` 瀑布里对子代理剥掉本插件的段，
 * 免得执行者读到「你是挑刺者 / 你不执行任务」。
 *
 * @module dsh-dual-agent/dg-enforce
 */

/** 判断与派活永远允许：这些就是「把需求交出去 + 对用户说话」本身。 */
export const CORE_ALLOW = [
  'subagent', 'subagent_fork', 'workflow', 'ralph',
  'list_agents', 'interrupt_agent', 'send_message',
  'ask_user_question', 'exit_plan_mode',
  'todo_write', 'create_goal', 'get_goal', 'update_goal',
  'job_list', 'job_output', 'job_kill',
];

/** mode=readonly 追加：为判断而回看已有内容（收集新信息仍然禁止）。 */
export const READONLY_ALLOW = [
  'read', 'read_image', 'grep', 'glob', 'working_directory',
  'skill', 'present', 'list_mcp_resources', 'read_mcp_resource',
  'project_list', 'project_active', 'terminal_list', 'terminal_read',
];

/** 即使用户写进 extraAllowed 也不放：这些是「亲自动手」的核心面。 */
export const NEVER_ALLOW = [
  'pwsh', 'bash', 'admin_exec', 'write', 'edit', 'create_worktree',
  'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close',
];

const ORDER_BASE = 10400;
const SECTION_NAME = 'dual-guidance:enforce';
/** 本插件所有段前缀（子代理装配里整组剥掉）。 */
const OWN_SECTION_PREFIXES = ['dual-agent:', 'dual-guidance:'];

/** 被拒时给模型看的话：说清为什么、该怎么做、怎么解除。 */
export const denyReason = (toolName, label) => `【${label}】本会话已开启「主智能只判断、不动手」，工具 ${toolName} 已按规则拒绝执行。`
  + `请把这件事交给子代理完成（subagent / subagent_fork / workflow，或经工具箱武装后的后台执行者），`
  + `拿到**带出处**的回报后再判断。若确需主智能亲自执行：在工具箱本插件的二级菜单里调低限制，或关闭总开关。`;

/**
 * 常驻主上下文的行为说明段。guard 只负责否决，这段负责让它知道该怎么做。
 * @param facts { mode, denyListPreview, evidenceFormat }
 */
export const guidanceText = (facts = {}) => `【双智能指导·执行约束】本会话已由用户开启双智能指导（总开关=开）。

规则：你（主上下文）**只做判断与派发**，不亲自动手。
- 禁止自己做：编码、改文件、跑命令、调试、装依赖、联网收集信息、抓取网页、驱动外部程序。这些一律交给子代理。
- 允许自己做：理解意图、拆解任务、写委派说明、审阅回报、判定是否达标、向用户解释与提问、维护待办与目标。
- 你能看到工具清单，但**主智能调用受限工具会被程序拒绝**，拒绝理由会指示你派活。子代理不受这条限制，它们有完整工具面。
- 当前模式：${facts.mode === 'readonly' ? '允许回看本地已有内容（read / grep / glob 等），但仍禁止收集新信息与动手改动' : '严格：只判断，连只读查看也交给子代理'}。${facts.denyListPreview ?? ''}

**出处要求（硬性）**：委派任务时必须在任务说明里要求子代理在收尾给出证据块——
${facts.evidenceFormat}
你向用户转述结论时，只能把**程序核验通过**的出处当作事实；核验为「不符」或「无法核验」的内容必须原样标注为未经证实。

（本段由双智能指导插件注入；用户关闭总开关后立即消失，一切回到常态。）`;

/**
 * @param ctx 插件根作用域（需要 tools / systemPrompt）
 * @param deps {
 *   label?: string
 *   isEnabled(sessionId): boolean     // 该会话总开关是否使能
 *   settings(sessionId): { enforce, mode, extraAllowed, hideMainTools }
 *     // v21：按**调用者会话**取（index.js 侧 settingsFor(sessionId).guidance）——
 *     // 行为段文本、允许清单、guard 拒绝口径都跟随该会话所属家族的快照。
 *   evidenceFormat(): string
 *   onDegrade(reason): void
 *   log?(level, text)
 * }
 */
export function attachEnforce(ctx, deps = {}) {
  const label = typeof deps.label === 'string' && deps.label !== '' ? deps.label : '双智能指导';
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => false;
  const settingsOf = typeof deps.settings === 'function' ? deps.settings : () => ({});
  const evidenceFormat = typeof deps.evidenceFormat === 'function' ? deps.evidenceFormat : () => '';
  const log = (level, text) => { try { deps.log?.(level, text); } catch { /* 日志不致命 */ } };

  /** 已装行为段的会话 → disposer；隐藏表也按会话记，供子代理补注册用。 */
  const installed = new Map(); // sessionId -> { dispose, hidden: string[], degraded: boolean }
  /**
   * 因自检失败而**永久放弃**清单隐藏的会话（本进程内）。必须记住：
   * 否则下一次 install（phase 切换/改设置都会重装）又会把工具藏起来，
   * 又伤一次子代理——那正是「自检发现会伤及子代理就降级」要防的事。
   * 解除武装时清掉（用户重新开一次开关等于给它第二次机会）。
   */
  const degradedSessions = new Set();

  /** v21：settings 按 sessionId 调用（家族隔离口径）；防御：拿不到就空形状。 */
  const settingsNow = (sessionId) => {
    let resolved;
    try { resolved = settingsOf(sessionId); } catch { resolved = undefined; }
    return resolved ?? {};
  };

  /** 该会话此刻允许的顶层工具名集合；约束关着时回 null（不拦）。 */
  const allowSetFor = (sessionId) => {
    const settings = settingsNow(sessionId);
    if (settings.enforce !== true) return null;
    const names = new Set(CORE_ALLOW);
    if (settings.mode === 'readonly') for (const name of READONLY_ALLOW) names.add(name);
    for (const raw of Array.isArray(settings.extraAllowed) ? settings.extraAllowed : []) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (name !== '' && !NEVER_ALLOW.includes(name)) names.add(name);
    }
    return names;
  };

  /** 直接判「这个 agent 是不是根会话」——子代理永远不受约束（它是干活的那一方）。 */
  const isRootAgent = (agent) => {
    const header = agent?.session?.header;
    if (header === undefined || header === null) return true;
    return typeof header.parentSession !== 'string' || header.parentSession === '';
  };

  const globalToolNames = () => {
    try { return (ctx.tools.schemas() ?? []).map((schema) => String(schema?.name ?? '')).filter((name) => name !== ''); } catch { return []; }
  };

  /**
   * 某个会话**自己看得见**的工具名。为什么不能只看全局表：preset 把工具挪到
   * agent 平面后，可见面是「全局 + 祖先作用域贡献」，而 restrict() 只接受该作用域
   * restrictable 的名字——用全局表算 deny 会漏，也可能撞上 unknown name 抛错。
   */
  const visibleNamesOf = (agent) => {
    try {
      const tools = agent?.ctx?.tools ?? ctx.get('tools');
      if (tools === undefined || typeof tools.schemas !== 'function') return null;
      return (tools.schemas(agent) ?? []).map((schema) => String(schema?.name ?? '')).filter((name) => name !== '');
    } catch { return null; }
  };

  /** 名字清单的口径：优先按会话可见面，取不到再退回全局表（status 只读，不能抛）。 */
  const namesFor = (sessionId) => {
    const agent = typeof deps.agentOf === 'function' ? deps.agentOf(sessionId) : undefined;
    return visibleNamesOf(agent) ?? globalToolNames();
  };

  // ── 权威拦阻：根作用域 guard，按调用者身份精确判定 ─────────────────────────
  ctx.tools.guard((execution) => {
    const agent = execution?.agent;
    const sessionId = typeof agent?.id === 'string' ? agent.id : undefined;
    if (sessionId === undefined || isEnabled(sessionId) !== true) return undefined;
    if (!isRootAgent(agent)) return undefined;
    // v21：允许清单按调用者会话（= 家族根）的快照算——不同家族的约束力度可以不同。
    const allow = allowSetFor(sessionId);
    if (allow === null) return undefined;
    const name = String(execution?.name ?? '');
    if (allow.has(name)) return undefined;
    return denyReason(name, label);
  });

  // ── 可选：隐藏清单 + 子代理出生时补回 ─────────────────────────────────────
  const childVisibleNames = (agent) => {
    try {
      const tools = agent?.ctx?.tools;
      if (tools === undefined || typeof tools.schemas !== 'function') return null;
      return new Set((tools.schemas(agent) ?? []).map((schema) => String(schema?.name ?? '')));
    } catch { return null; }
  };

  /** 子代理出生：把被隐藏的每个定义注册进它自己的那一层，再回读自检。 */
  const restoreForChild = (child) => {
    const parentId = child?.session?.header?.parentSession;
    if (typeof parentId !== 'string' || parentId === '') return;
    const state = installed.get(parentId);
    if (state === undefined || state.degraded === true || state.hidden.length === 0) return;
    if (isEnabled(parentId) !== true) return;
    let attempted = 0;
    for (const name of state.hidden) {
      try {
        const definition = ctx.tools.get(name);
        if (definition === undefined) continue;
        child.ctx.tools.register(definition);
        attempted += 1;
      } catch { /* 子代理那层已有同名：忽略即可 */ }
    }
    if (attempted === 0) return;
    const visible = childVisibleNames(child);
    if (visible === null) return; // 读不到就不下结论
    const missing = state.hidden.filter((name) => visible.has(name) !== true);
    if (missing.length > 0) {
      const reason = `隐藏主智能工具会连带让子代理失去 ${missing.slice(0, 4).join('、')}${missing.length > 4 ? '…' : ''}；已自动撤销隐藏，降级为「只拒绝主智能调用、不隐藏清单」。`;
      state.degraded = true;
      degradedSessions.add(parentId);
      log('warn', `${label}: ${reason}`);
      try { deps.onDegrade?.(reason); } catch { /* 通知失败不影响降级本身 */ }
      liftHidden(state);
      // 说明段此刻还写着「已隐藏 N 个工具」——必须改口，否则主智能读到的是假话。
      const parent = typeof deps.agentOf === 'function' ? deps.agentOf(parentId) : undefined;
      if (parent !== undefined) install(parent);
    }
  };

  /** 撤销某会话的清单隐藏（guard 仍在，只是不再摘 schema）。 */
  const liftHidden = (state) => {
    state.hidden = [];
    if (typeof state.liftRestrict === 'function') {
      try { state.liftRestrict(); } catch { /* 尽力 */ }
      state.liftRestrict = undefined;
    }
  };

  /** 装清单隐藏：返回被摘掉的名字（空数组=没摘）。 */
  const hideFromMain = (agent, allow) => {
    const tools = agent?.ctx?.tools ?? ctx.get('tools');
    if (tools === undefined || typeof tools.restrict !== 'function') return { hidden: [], dispose: undefined };
    const all = visibleNamesOf(agent) ?? globalToolNames();
    const denied = [...new Set(all.filter((name) => allow.has(name) !== true))];
    if (denied.length === 0) return { hidden: [], dispose: undefined };
    try {
      const dispose = tools.restrict({ deny: denied });
      return { hidden: denied, dispose: typeof dispose === 'function' ? dispose : undefined };
    } catch (cause) {
      log('warn', `${label}: 隐藏主智能工具失败（退回只拒绝）：${String(cause?.message ?? cause)}`);
      return { hidden: [], dispose: undefined };
    }
  };

  ctx.on('agent/created', ({ agent }) => {
    // v21：hideMainTools 按出生子代理的父会话（其家族）的快照取——不是全局模板。
    if (settingsNow(agent?.session?.header?.parentSession).hideMainTools !== true) return;
    try { restoreForChild(agent); } catch (cause) { log('warn', `${label}: 子代理工具补注册异常：${String(cause?.message ?? cause)}`); }
  });

  /**
   * 武装某会话：装行为说明段（+ 可选清单隐藏）。重复调用幂等。
   * phase 切换时 index.js 会先 uninstall 再 install，段文本跟着新实况刷新。
   */
  const install = (agent) => {
    const sessionId = agent?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    // v21：段文本与隐藏清单按**这个会话**所属家族的快照现算。
    const settings = settingsNow(sessionId);
    const allow = allowSetFor(sessionId);
    let hidden = [];
    let liftRestrict;
    // 已经降级过的会话不再尝试隐藏（见 degradedSessions 注释）。
    if (allow !== null && settings.hideMainTools === true && degradedSessions.has(sessionId) !== true) {
      const outcome = hideFromMain(agent, allow);
      hidden = outcome.hidden;
      liftRestrict = outcome.dispose;
    }
    const hiding = settings.hideMainTools === true && degradedSessions.has(sessionId) !== true;
    const facts = {
      mode: settings.mode === 'readonly' ? 'readonly' : 'strict',
      denyListPreview: hidden.length > 0
        ? `\n- 已从你的清单里隐藏 ${hidden.length} 个工具（子代理仍然拥有它们）。`
        : (settings.hideMainTools === true && hiding !== true ? '\n- 清单隐藏已降级关闭（自检发现会伤及子代理），仍按拒绝拦截。' : ''),
      evidenceFormat: evidenceFormat(),
    };
    const previous = installed.get(sessionId);
    if (previous !== undefined) { try { previous.dispose?.(); } catch { /* 尽力 */ } }
    let dispose;
    try {
      dispose = agent.ctx.effect(() => {
        const remove = agent.ctx.systemPrompt.section({ name: SECTION_NAME, order: ORDER_BASE, text: guidanceText(facts) });
        return () => { try { remove?.(); } catch { /* 尽力 */ } };
      }, `${label}: guidance section`);
    } catch (cause) {
      log('warn', `${label}: 装行为说明段失败：${String(cause?.message ?? cause)}`);
    }
    installed.set(sessionId, {
      dispose, hidden, liftRestrict,
      degraded: degradedSessions.has(sessionId) || (hidden.length === 0 && settings.hideMainTools === true),
    });
  };

  /** 解除某会话的约束装配（关开关 / 会话销毁 / 插件卸载）。 */
  const uninstall = (sessionId) => {
    degradedSessions.delete(sessionId); // 重新开一次开关 = 再给隐藏一次机会
    const state = installed.get(sessionId);
    if (state === undefined) return;
    liftHidden(state);
    try { state.dispose?.(); } catch { /* 尽力 */ }
    installed.delete(sessionId);
  };

  /** 实况（纯读）。多会话同时武装时按会话取，不能用「随便第一个」。 */
  const describe = (sessionId) => {
    // v21：口径按该会话所属家族的快照（sessionId undefined = 无会话上下文 → 空形状）。
    const settings = settingsNow(sessionId);
    const allow = allowSetFor(sessionId);
    const all = sessionId === undefined ? globalToolNames() : namesFor(sessionId);
    const allowed = allow === null ? [] : all.filter((name) => allow.has(name));
    const state = sessionId === undefined ? undefined : installed.get(sessionId);
    return {
      enforce: settings.enforce === true,
      mode: settings.mode === 'readonly' ? 'readonly' : 'strict',
      hideMainTools: settings.hideMainTools === true,
      allowed,
      allowedCount: allowed.length,
      deniedCount: allow === null ? 0 : all.length - allowed.length,
      total: all.length,
      hidden: state?.hidden?.length ?? 0,
      degraded: state?.degraded === true,
    };
  };

  // ── 段泄漏防线：子代理的装配里剥掉本插件的段 ───────────────────────────────
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    const agent = context?.agent;
    if (agent === undefined) return result;
    if (!isRootAgent(agent)) {
      const sections = result.sections ?? [];
      const kept = sections.filter((section) => !OWN_SECTION_PREFIXES.some((prefix) => String(section?.name ?? '').startsWith(prefix)));
      if (kept.length !== sections.length) return { ...result, sections: kept };
    }
    return result;
  }, { prepend: true });

  return {
    install,
    uninstall,
    describe,
    CORE_ALLOW,
    READONLY_ALLOW,
    NEVER_ALLOW,
    denyReason,
    guidanceText,
  };
}
