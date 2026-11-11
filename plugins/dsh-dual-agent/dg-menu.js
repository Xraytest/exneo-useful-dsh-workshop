/**
 * 双智能指导 · 工作箱二级菜单（dg-menu.js）
 *
 * 这里只做两件事：
 *   ① 把本插件的实况算成一份**声明式面板 spec**；
 *   ② 把面板上来的 op 落到链/设置上，然后重新算 spec。
 *
 * 渲染由 dsh-workbench 负责（它认得 note/switch/select/text/rows/form/buttons 这
 * 七种通用件，不认识任何本插件的语义）。这样工作箱继续是「编排者，不实现」，
 * 二级菜单的内容与规则全都留在本插件里，跨插件之间只有 HTTP JSON 契约——
 * 比互相 require 对方模块稳定得多（插件谁先装载、重载几次都不影响）。
 *
 * 路由（由 index.js 挂载，同源守卫也在那儿）：
 *   GET  /dsh-dual-agent/menu?sessionId=…            → spec
 *   POST /dsh-dual-agent/menu  {sessionId, op, …}    → 新 spec（出错回 4xx/5xx + {error}）
 *
 * @module dsh-dual-agent/dg-menu
 */

const REFRESH_MS = 3000;

const ROUTE_SEP = '::';

/** 'provider::model' → {provider, model} */
const splitRoute = (value) => {
  const text = String(value ?? '');
  const at = text.indexOf(ROUTE_SEP);
  if (at <= 0) return null;
  return { provider: text.slice(0, at).trim(), model: text.slice(at + ROUTE_SEP.length).trim() };
};

const fmtTokens = (value) => {
  const n = Number(value) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
};

/**
 * @param deps 见文件头；hub 由 index.js 组：
 *   hub = {
 *     agentOf(sessionId), statusOf(sessionId),
 *     chain,                       // dg-chain 返回面
 *     enforce,                     // dg-enforce 返回面
 *     settings, setSetting(id,value,sessionId), settingsView(sessionId?),
 *     saveChainTemplate(t),        // v21：把规范化链写进「链模板」（新家族武装时继承）
 *     evidenceFormat(),            // 给面板展示的证据协议文本
 *     catalog(),                   // {groups:[{id,name,models:[{id,name}]}], error}
 *     verifySummary(sessionId),    // 最近一次核验摘要（可空）
 *     log(level, text)
 *   }
 */
export function attachMenu(hub) {
  const title = '双智能指导';

  /** 主面板：状态条 + 约束区 + 模型链区 + 核验区。 */
  async function buildSpec(sessionId) {
    const status = hub.statusOf(sessionId);
    // v21：面板上的设置值按**该会话所属家族**的快照读（无快照回模板）。
    const settings = hub.settingsView(sessionId);
    const chain = hub.chain.chainView(sessionId);
    const enforce = hub.enforce.describe(sessionId);
    const catalog = await hub.catalog();
    const items = [];

    items.push({
      kind: 'note',
      tone: status.phase === 'off' ? 'warn' : 'ok',
      text: status.phase === 'off'
        ? '总开关关着：下面这些规则**已保存但不生效**（主智能照旧自己干活，子代理沿用主会话模型）。拨开工作箱里本行的开关后立刻按此生效。'
        : `已使能（${status.phase === 'running' ? '执行者运行中' : '待命中'}）。${status.note ?? ''}`,
    });

    // ── 约束区 ───────────────────────────────────────────────────────────────
    // 关着也能预先设规则（不生效而已）——用 disabled 挡住只会逼人先开开关再回来配。
    items.push({ kind: 'heading', text: '主智能行为约束' });
    items.push({
      kind: 'switch', id: 'enforce', label: '主智能只判断、不动手',
      hint: '开启后：主会话调用受限工具会被程序拒绝，并提示它派活给子代理。子代理不受限制。',
      value: settings.enforce === true,
    });
    items.push({
      kind: 'select', id: 'mode', label: '约束力度',
      hint: '严格＝连只读查看也交给子代理；只读辅助＝允许主智能回看本地已有内容（read/grep/glob），但仍禁止收集新信息与改动。',
      value: settings.mode === 'readonly' ? 'readonly' : 'strict',
      options: [
        { value: 'strict', label: '严格（只判断 + 派活）' },
        { value: 'readonly', label: '允许只读回看' },
      ],
    });
    items.push({
      kind: 'switch', id: 'hideMainTools', label: '把受限工具从主智能清单里隐藏',
      hint: `更彻底（模型看不到就不会试），但依赖作用域细节；若自检发现会连带伤到子代理会自动降级并在此说明。当前：可见 ${enforce.allowedCount}/${enforce.total}，被拒面 ${enforce.deniedCount}。`,
      value: settings.hideMainTools === true,
      warn: enforce.degraded === true ? '已自动降级：隐藏会伤及子代理，现只按拒绝拦截。' : null,
    });
    // v4.1（2026-11-03 用户指令「新的插件就不需要阻塞主会话了」）：旧编排默认关。
    items.push({
      kind: 'switch', id: 'orchestrate', label: '旧编排：自动派执行者并接管主会话',
      hint: '默认关。开着时你的消息不再由主智能回应，而是被编排直接交给后台执行者，'
        + '主会话在它工作期间保持静默；结束后回传报告并做挑刺者评估。关掉即恢复「主智能自己判断、派活」。',
      value: settings.orchestrate === true,
      warn: settings.orchestrate === true
        ? '已开启：你发出的消息会被编排接管（主智能不回答），直到执行者结算。'
        : null,
    });
    items.push({
      kind: 'text', id: 'extraAllowed', label: '额外放行工具名（逗号分隔）',
      hint: '在模式之上再加允许的工具（写文件/跑命令这类核心动手面永远不放行）。留空=不加。',
      value: (Array.isArray(settings.extraAllowed) ? settings.extraAllowed : []).join(', '),
      placeholder: '例如：web_search, present',
    });

    // ── 子代理模型区 ─────────────────────────────────────────────────────────
    items.push({ kind: 'heading', text: '子代理模型链' });
    // v21：链模板继承的可见说明——改链在这里只影响本会话家族；之后新武装的
    // 会话（家族）会自动继承「最近一次配置的链」当起点。
    items.push({
      kind: 'note',
      tone: 'info',
      text: '这里配置的是**本会话家族**的链；最近一次配置会被记住，之后新使能的会话会在武装时自动继承它（用量从零计起）。',
    });
    items.push({
      kind: 'switch', id: 'applyChain', label: '子代理走这条链（否则沿用主会话模型）',
      hint: '链按顺序 C1→C2…：某个候选额度用尽或请求失败就自动回退下一个；全部不可用时子代理回落到自己的原路由。',
      value: settings.applyChain === true,
    });
    items.push({
      kind: 'rows',
      label: '有序候选',
      empty: chain.configured !== true ? '还没有候选。用下面的表单加一个。' : null,
      rows: (chain.candidates ?? []).map((candidate, index) => {
        const active = chain.activeIndex === index;
        // ⚠ chainView 给的是**扁平**形状：{unlimited, kind:'requests'|'tokens', limit:number,
        // used:{requests,tokens}}，不是内部的 limit:{kind,value}。按内部形状读会全是 undefined。
        const tokenBased = candidate.unlimited !== true && candidate.kind === 'tokens';
        const used = tokenBased ? fmtTokens(candidate.used.tokens) : String(candidate.used.requests);
        const limitText = candidate.unlimited === true ? '不限'
          : (tokenBased ? `${fmtTokens(candidate.limit)} tokens` : `${candidate.limit} 次`);
        const chips = [];
        if (active) chips.push({ text: '当前', tone: 'brand' });
        if (candidate.failed === true) chips.push({ text: '已失败', tone: 'error' });
        else if (candidate.exhausted === true) chips.push({ text: '已用尽', tone: 'warn' });
        return {
          index,
          title: `C${index + 1} · ${candidate.provider} / ${candidate.model}`,
          subtitle: `已用 ${used} / ${limitText}`,
          chips,
          progress: candidate.unlimited === true ? null : {
            used: tokenBased ? candidate.used.tokens : candidate.used.requests,
            limit: candidate.limit,
            label: tokenBased ? 'tokens' : '请求',
          },
          buttons: [
            { op: 'candidate-up', index, label: '↑', title: '往上（更早被使用）' },
            { op: 'candidate-down', index, label: '↓', title: '往下' },
            { op: 'candidate-unlimited', index, label: '不限', title: '改成不限量（并清除失败标记）' },
            { op: 'candidate-remove', index, label: '删除', tone: 'danger' },
          ],
        };
      }),
    });
    items.push({
      kind: 'form',
      label: '添加候选',
      hint: chain.candidates?.length >= hub.chain.MAX_CANDIDATES ? `最多 ${hub.chain.MAX_CANDIDATES} 个候选` : null,
      fields: [
        {
          name: 'route', label: '模型', kind: 'select', value: '',
          options: catalogGroupsToOptions(catalog),
          placeholder: catalog.error ?? '选择 provider / 模型',
        },
        {
          name: 'limitKind', label: '限额口径', kind: 'select', value: 'requests',
          options: [{ value: 'requests', label: '成功请求数' }, { value: 'tokens', label: '混合 token' }],
        },
        { name: 'limitValue', label: '额度', kind: 'number', value: '20', placeholder: '正整数；勾选不限则忽略' },
        { name: 'unlimited', label: '不限量', kind: 'checkbox', value: false },
      ],
      submit: { op: 'add-candidate', label: '加入候选' },
    });
    items.push({
      kind: 'switch', id: 'countAuxiliary', label: '标题/压缩等辅助调用也计入链',
      hint: '默认不计：会话标题、上下文压缩这些后台小请求不消耗候选额度。',
      value: chain.countAuxiliary === true, disabled: chain.configured !== true,
    });
    items.push({
      kind: 'switch', id: 'countTowardPool', label: '子代理用量同时计入整会话供应池',
      hint: '与 dsh-model-pool 联动：勾上后池子按根会话一起记账。',
      value: chain.countTowardPool === true, disabled: chain.configured !== true,
    });
    items.push({
      kind: 'buttons',
      buttons: [
        { op: 'reset-counters', label: '重置计数与失败标记' },
        { op: 'clear-chain', label: '清空模型链', tone: 'danger' },
        { op: 'refresh', label: '刷新' },
      ],
    });

    // ── 出处核验区 ───────────────────────────────────────────────────────────
    items.push({ kind: 'heading', text: '出处与程序核验' });
    const summary = hub.verifySummary(sessionId);
    if (summary !== null && summary !== undefined) items.push({ kind: 'note', tone: summary.tone ?? 'info', text: summary.text });
    items.push({ kind: 'note', tone: 'info', text: `证据协议：${hub.evidenceFormat()}` });
    items.push({
      kind: 'switch', id: 'verify.enabled', label: '对子代理回报跑程序核验',
      hint: '确定性代码逐条核对出处（文件系统 / 会话记录 / 算术），不经模型判断；核验结果与报告一起进主上下文。',
      value: settings.verifyEnabled === true,
    });
    items.push({
      kind: 'switch', id: 'verify.requireEvidence', label: '没给证据块就明说「无出处」',
      hint: '报告里没有证据块时，核验结论会写成「无出处，未经程序验证」，不会被当成已证实。',
      value: settings.verifyRequireEvidence === true,
    });
    items.push({
      kind: 'switch', id: 'verify.urlChecks', label: '允许联网核对 url 类出处',
      hint: '开启后对 url 声称发 HEAD/GET（默认 8 秒超时）。关闭时这类声称一律标「无法核验」。',
      value: settings.verifyUrlChecks === true,
    });
    items.push({
      kind: 'switch', id: 'verify.delegation', label: '也核验主智能自己派出去的子代理回报',
      hint: '覆盖 subagent / subagent_fork / workflow 工具的结果：落进主会话时由程序跑一遍核验，再注入一条核验实况。',
      value: settings.verifyDelegation === true,
    });

    return {
      title,
      sessionId: sessionId ?? null,
      phase: status.phase,
      refreshMs: REFRESH_MS,
      degraded: enforce.degraded === true,
      items,
      generatedAt: Date.now(),
    };
  }

  /** op 落地 → 返回新 spec。任何校验失败都抛错，由 index.js 折成 4xx。 */
  async function applyOp(body = {}) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId === '') throw menuError('sessionId 必填', 400);
    const op = String(body.op ?? '');

    /**
     * v21 链模板：把**规范化后**的链（candidates 不带计数、只带路由与限额）
     * 记录为「最近一次经二级菜单配置的链」。只由菜单 op 驱动——程序化
     * chain.set 不改模板（那是别处脚本的行为，不该污染用户偏好）。
     * candidates 为空 = clear-chain → 模板清成 null（reset-counters 不动模板）。
     */
    const rememberChainTemplate = (candidates) => {
      const view = hub.chain.chainView(sessionId);
      const entries = Array.isArray(candidates) ? candidates : [];
      if (entries.length === 0) {
        hub.saveChainTemplate?.(null);
        return;
      }
      hub.saveChainTemplate?.({
        candidates: entries.map((candidate) => ({
          provider: candidate.provider,
          model: candidate.model,
          // 视图形状 unlimited/kind/limit → 存储形状 limit:{kind,value}|null
          limit: candidate.unlimited === true ? null : { kind: candidate.kind, value: candidate.limit },
        })),
        countAuxiliary: view.countAuxiliary === true,
        countTowardPool: view.countTowardPool === true,
      });
    };

    if (op === 'set') {
      const id = String(body.id ?? '');
      // 链上的两个记账开关走链自己的 adjust（它们是「本会话的链」的属性）。
      if (id === 'countAuxiliary' || id === 'countTowardPool') {
        if (hub.chain.chainView(sessionId).configured !== true) throw menuError('本会话还没有模型链，无从设置记账开关', 409);
        hub.chain.adjust(sessionId, { [id]: body.value === true });
        // 记账开关也是「链配置」的一部分：同步进模板，让新家族继承同样的记账口径。
        rememberChainTemplate(hub.chain.chainView(sessionId).candidates);
        return buildSpec(sessionId);
      }
      // v21：菜单的设置改动**带 sessionId**——写该会话家族的快照（+同步模板），
      // 不再全局改写所有会话的生效策略。
      const outcome = hub.setSetting(id, body.value, sessionId);
      if (outcome.applied.length === 0) throw menuError(`不认识的设置项：${id === '' ? '(空)' : id}`, 400);
      return buildSpec(sessionId);
    }

    if (op === 'add-candidate') {
      const fields = body.fields ?? {};
      const route = splitRoute(fields.route);
      if (route === null) throw menuError('请选择一个具体的 provider / 模型', 400);
      const unlimited = fields.unlimited === true || String(fields.unlimited) === 'true';
      const added = { provider: route.provider, model: route.model };
      if (!unlimited) {
        const kind = fields.limitKind === 'tokens' ? 'tokens' : 'requests';
        const value = Number(fields.limitValue);
        if (!Number.isInteger(value) || value < 1) throw menuError('额度必须是正整数（或勾选不限量）', 400);
        added.limit = { kind, value };
      }
      const view = hub.chain.chainView(sessionId);
      const candidates = (view.candidates ?? []).map((candidate) => ({
        provider: candidate.provider, model: candidate.model,
        limit: candidate.unlimited ? null : { kind: candidate.kind, value: candidate.limit },
      }));
      if (candidates.length >= hub.chain.MAX_CANDIDATES) throw menuError(`最多 ${hub.chain.MAX_CANDIDATES} 个候选`, 400);
      hub.chain.setChain(sessionId, [...candidates, added], {
        countAuxiliary: view.countAuxiliary, countTowardPool: view.countTowardPool,
      });
      // v21：链变更成功 → 更新链模板（下一次新家族武装时继承这条链）。
      rememberChainTemplate(hub.chain.chainView(sessionId).candidates);
      return buildSpec(sessionId);
    }

    if (op === 'candidate-remove' || op === 'candidate-unlimited' || op === 'candidate-up' || op === 'candidate-down') {
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0) throw menuError('index 必须是数组下标', 400);
      const view = hub.chain.chainView(sessionId);
      if (view.configured !== true) throw menuError('本会话没有已启用的模型链', 409);
      const candidates = view.candidates.map((candidate) => ({
        provider: candidate.provider, model: candidate.model,
        limit: candidate.unlimited ? null : { kind: candidate.kind, value: candidate.limit },
      }));
      if (op === 'candidate-remove') {
        if (index >= candidates.length) throw menuError('index 越界', 400);
        candidates.splice(index, 1);
        if (candidates.length === 0) { hub.chain.clearChain(sessionId); rememberChainTemplate([]); return buildSpec(sessionId); }
        hub.chain.setChain(sessionId, candidates, { countAuxiliary: view.countAuxiliary, countTowardPool: view.countTowardPool });
        rememberChainTemplate(hub.chain.chainView(sessionId).candidates);
        return buildSpec(sessionId);
      }
      if (op === 'candidate-unlimited') {
        if (index >= candidates.length) throw menuError('index 越界', 400);
        candidates[index].limit = null;
        hub.chain.setChain(sessionId, candidates, { countAuxiliary: view.countAuxiliary, countTowardPool: view.countTowardPool });
        rememberChainTemplate(hub.chain.chainView(sessionId).candidates);
        return buildSpec(sessionId);
      }
      const to = op === 'candidate-up' ? index - 1 : index + 1;
      if (index >= candidates.length || to < 0 || to >= candidates.length) return buildSpec(sessionId); // 边界内不动
      const [moved] = candidates.splice(index, 1);
      candidates.splice(to, 0, moved);
      hub.chain.setChain(sessionId, candidates, { countAuxiliary: view.countAuxiliary, countTowardPool: view.countTowardPool });
      rememberChainTemplate(hub.chain.chainView(sessionId).candidates);
      return buildSpec(sessionId);
    }

    if (op === 'reset-counters') {
      hub.chain.resetCounters(sessionId);
      // v21：reset-counters 只清本家族的用量计数，**不动**链模板（计数不是配置）。
      return buildSpec(sessionId);
    }

    if (op === 'clear-chain') {
      hub.chain.clearChain(sessionId);
      // v21：清空 = 用户明确撤销了这条链 → 链模板也清成 null（否则下一个新家族
      // 又会把已撤销的链继承回去，违背用户刚刚表达的意图）。
      rememberChainTemplate([]);
      return buildSpec(sessionId);
    }

    if (op === 'refresh') return buildSpec(sessionId);

    throw menuError(`不认识的 op：${op === '' ? '(空)' : op}`, 400);
  }

  return { buildSpec, applyOp, splitRoute };
}

function menuError(message, status) {
  const error = new Error(message);
  error.menuStatus = status;
  return error;
}

/** catalog groups → 带 optgroup 的扁平选项（工作箱用一个 select 全渲染）。 */
function catalogGroupsToOptions(catalog) {
  const out = [];
  for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
    for (const model of Array.isArray(group.models) ? group.models : []) {
      out.push({
        value: `${group.id}${ROUTE_SEP}${model.id}`,
        label: `${group.name || group.id} / ${model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id}`,
        group: group.name || group.id,
      });
    }
  }
  return out;
}

export { menuError };
