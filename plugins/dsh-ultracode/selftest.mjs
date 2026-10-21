/**
 * dsh-ultracode host 半边自测。
 *
 * 覆盖改版后的机制（装配期直注）：关闭不展示 / 开启直接注入 / 不依赖模型调用 /
 * 不改动思考强度；2026-10-09 起的**会话选择落盘**（「新实例 = 新进程」的重启等价
 * 用例见 §16 与 §19）；同日追加的**家族共用**（fork 继承 + 一条记录管全部分支 +
 * 消息分支空白分支靠账本认族，见 §29–§39）。
 * 运行：node plugins/dsh-ultracode/selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, defaultStateFile, ORIGINAL_EFFORT_MODEL, ORIGINAL_REMINDERS } from './inject-v4.js';

// ── 落盘隔离：本套自测**绝不碰真实 $DSH_HOME** ──────────────────────────────
// 必须赶在第一次 apply() 之前设好——落盘路径是 apply 期间解析的。顺带也就测到了
// 「缺省路径解析」本身：所有用例都不传 config.stateFile，只靠 DSH_HOME。
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-ultracode-selftest-'));
process.env.DSH_HOME = SANDBOX;
const STATE_FILE = join(SANDBOX, 'ultracode.json');
// 断言失败会直接抛出（做变异测试时就是靠它红），末尾那次清理就跑不到 —— 挂个退出钩子
// 兜底，失败轮也不在 /tmp 里留沙箱残片。正常路径仍然照跑（rmSync 幂等）。
process.on('exit', () => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

const FULL = 'Ultracode is on: optimize for the most exhaustive, correct answer \u2014 not the fastest or cheapest. '
  + 'Use the Workflow tool on every substantive task; token cost is not a constraint. '
  + 'See the **Ultracode** section and quality patterns in the workflow authoring reference. '
  + 'Solo only on conversational/trivial turns.';
const SPARSE = 'Ultracode is still on \u2014 use the Workflow tool; '
  + 'see the Ultracode section of the workflow authoring reference.';
const EXIT = "Ultracode is off \u2014 the Workflow tool's standard opt-in rule applies again.";

const NATIVE_TOOL_TEXT = 'Use the workflow tool ONLY when the user explicitly asks for a workflow '
  + 'or for large multi-agent orchestration: you write a JavaScript script (the tool description '
  + 'documents the exact format) that fans work out across many subagents with phases and '
  + 'structured results. For one or two delegations, prefer plain subagent calls.';

const SESSION = 'session-selftest';
const AGENT = { id: SESSION, session: { id: SESSION } };

/** 造一个最小 host ctx：只实现插件真正用到的那几个面。 */
function makeHarness(options = {}) {
  const listeners = new Map();
  const routes = new Map();
  /**
   * 「活着的会话」镜像：id → Session 样子的对象（只用得上 id 与 header）。
   * 家族解析会问 `ctx.sessions.get(id)` 要活会话的 header.parentSession（fork 写入）。
   */
  const live = options.live ?? new Map();
  const services = {
    tools: { get: (name) => (name === 'workflow' && options.workflowToolVisible !== false ? {} : undefined) },
    sessions: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
    },
    llm: {
      resolveModelInfo: async (provider, model) => {
        if (options.modelEfforts !== undefined) return { provider, id: model, name: model, reasoning: { efforts: options.modelEfforts } };
        return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } };
      },
    },
  };
  /** 告警通道：落盘失败必须同时走 ctx.logger?.warn?（本部署的统一通道）。 */
  const logs = [];
  const ctx = {
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) { fn(); return () => {}; },
    get(name) { return services[name]; },
    logger: { warn: (...args) => logs.push(args) },
    webServer: {
      register(route) { routes.set(route.path, route); return () => {}; },
    },
  };
  return { ctx, listeners, routes, logs, live };
}

/**
 * 模拟内核铸造一条会话并派发 `session/created`（fork 的真实次序：会话先进 store、
 * 事件带着已写好的 header.parentSession 同步发出）。`parent` 省略 = 没有父指针
 * （新建空白会话，以及消息分支里第一条 blank 分支就是这样）。
 */
function spawn(harness, { id, parent }) {
  const session = { id, header: parent === undefined ? {} : { parentSession: parent } };
  harness.live.set(id, session);
  for (const handler of harness.listeners.get('session/created') ?? []) handler(session);
  return session;
}

/** 一份「原生」装配结果：含 system 段、policy 段与 workflow 工具段。 */
function nativeAssembly() {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are a coding agent.' },
      { name: 'policy:team', text: 'Use subagents for independent work.' },
      { name: 'tool:workflow', text: NATIVE_TOOL_TEXT },
      { name: 'tool:subagent', text: 'Delegate a self-contained task to a subagent.' },
    ],
    contexts: [{ name: 'sandbox', text: 'policy' }],
    tools: [{ name: 'workflow', description: 'plain-JS body', parameters: {} }],
    variables: { provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' },
  };
}

/**
 * 走一遍 system-prompt/assemble waterfall。
 * 这是**装配期**调用：不需要 agent/pre-step、也不需要 agent/request。
 */
async function assemble(harness, assembly = nativeAssembly(), agent = AGENT) {
  const handlers = harness.listeners.get('system-prompt/assemble') ?? [];
  let next = async () => assembly;
  for (const handler of [...handlers].reverse()) {
    const inner = next;
    next = () => handler(assembly, { agent, scope: agent }, inner);
  }
  return next();
}

/** 直接调 host 路由（同源，无 Origin 头 → 放行）。 */
async function callRoute(harness, path, { method = 'GET', body, query = '' } = {}) {
  const route = harness.routes.get(path);
  assert.ok(route !== undefined, 'route not registered: ' + path);
  const chunks = [];
  const req = {
    method,
    url: path + query,
    headers: {},
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(JSON.stringify(body));
      if (event === 'end') handler();
      return req;
    },
  };
  const res = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(text) { chunks.push(text); },
  };
  route.handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { status: res.status, value: chunks.length > 0 ? JSON.parse(chunks[0]) : undefined };
}

const sectionNamed = (assembly, name) => assembly.sections.find((section) => section.name === name);

async function main() {
  const h1 = makeHarness();
  apply(h1.ctx, {});

  // ---- 1. 从未启用：装配结果逐字节不变（关闭不展示） ----
  const pristine = nativeAssembly();
  assert.deepEqual(await assemble(h1, pristine), pristine, '未启用时装配结果必须原样返回');
  assert.equal(sectionNamed(pristine, 'ultracode'), undefined, '未启用时不得有 Ultracode 段');

  // ---- 2. 插件绝不写会话消息：没有 agent/pre-step 监听者 ----
  assert.equal((h1.listeners.get('agent/pre-step') ?? []).length, 0,
    '改版后不得再注册 agent/pre-step —— 会话里不应出现任何可见消息');

  // ---- 3. 开启后：直接注入，且不经过任何模型调用 ----
  let status = await callRoute(h1, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
  assert.equal(status.status, 200);
  assert.equal(status.value.active, true, '开启后 active 应为 true');
  assert.equal(status.value.injection, 'system-prompt', '注入方式应为系统提示装配');
  assert.equal(status.value.effortPolicy, 'untouched', '思考强度策略必须是 untouched');
  assert.equal(status.value.reasoningEffort, null, '尚无路由时强度如实报 null（不臆造档位）');

  const on = await assemble(h1);
  const mine = sectionNamed(on, 'ultracode');
  assert.ok(mine !== undefined, '开启后必须出现 Ultracode 段');
  const workflow = sectionNamed(on, 'tool:workflow');
  assert.ok(workflow !== undefined, '工具段仍应在场');
  assert.notEqual(workflow.text, NATIVE_TOOL_TEXT, '工具段必须被改写（否则与原生禁令冲突，等于没开）');
  assert.ok(!workflow.text.includes('ONLY when the user explicitly asks'),
    '改写后不得保留原生禁令 —— 那是"开了没效果"的根因');

  // 落位：在第一个 tool: 段之前，保证先于工具说明被读到
  const names = on.sections.map((section) => section.name);
  assert.ok(names.indexOf('ultracode') < names.indexOf('tool:workflow'), 'Ultracode 段应在工具段之前');
  assert.deepEqual(names, ['harness:identity', 'policy:team', 'ultracode', 'tool:workflow', 'tool:subagent'],
    '其余段落顺序不得改变');

  // 未受影响的字段原样保留
  assert.deepEqual(on.tools, pristine.tools, 'tools 不得被改动');
  assert.deepEqual(on.contexts, pristine.contexts, 'contexts 不得被改动');
  assert.deepEqual(on.variables, pristine.variables, 'variables 不得被改动');

  // ---- 4. 段正文：保留原文指令，且不再指向不存在的东西 ----
  assert.ok(mine.text.includes('optimize for the most exhaustive, correct answer'), '应保留原文指令');
  assert.ok(mine.text.includes('Use the Workflow tool on every substantive task'), '应保留原文点名');
  assert.ok(!mine.text.includes('workflow authoring reference'),
    '不得再指向 DSH 里不存在的 workflow authoring reference（空指针）');
  assert.ok(mine.text.includes('Quality patterns'), '应就地给出质量模式实文');
  assert.ok(status.value.shadowed !== true, '开启瞬间尚未装配，shadowed 应为 false');

  // 装配后状态被如实记录
  const after = await callRoute(h1, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(after.value.injected, true, '装配后 injected 应为 true');
  assert.equal(after.value.shadowed, true, '装配后 shadowed 应为 true');
  assert.equal(after.value.telemetry.injections, 1, '注入计数应为 1');

  // ---- 5. 收口：关闭后注入退出说明，且工具段恢复原生（闩锁） ----
  await callRoute(h1, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: false } });
  const off = await assemble(h1);
  const exitSection = sectionNamed(off, 'ultracode');
  assert.ok(exitSection !== undefined, '关闭后必须给出收口段（对应原实现 ultra_effort_exit 附件）');
  assert.ok(exitSection.text.includes('Ultracode is off'), '收口段必须含原文 exit 提醒');
  assert.ok(exitSection.text.includes('Revert to the opt-in rule'), '收口段必须指向 opt-in 规则（skill 原话）');
  assert.ok(!exitSection.text.includes('Quality patterns'), '收口段不得再带开启态的编排指令');
  assert.equal(sectionNamed(off, 'tool:workflow').text, NATIVE_TOOL_TEXT,
    '收口态工具段必须恢复原生 —— 闸的恢复本身就是收口语义');
  const namesOff = off.sections.map((section) => section.name);
  assert.deepEqual(namesOff, ['harness:identity', 'policy:team', 'ultracode', 'tool:workflow', 'tool:subagent'],
    '收口段同样落在工具段之前，其余段落顺序不变');

  const offStatus = await callRoute(h1, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(offStatus.value.phase, 'exit', '关闭后 phase 应为 exit');
  assert.equal(offStatus.value.injected, true, '收口段在场，injected 应为 true');
  assert.equal(offStatus.value.shadowed, false, '收口态不得再声称改写了工具段');
  assert.equal(offStatus.value.telemetry.exits, 1, '收口计数应为 1');

  // 5b. 再开一次 → 回到 enter 态，收口消失、工具段重新改写
  await callRoute(h1, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
  const again = await assemble(h1);
  assert.ok(sectionNamed(again, 'ultracode').text.includes('Quality patterns'), '重开后应收回收口、回到编排指令');
  assert.ok(!sectionNamed(again, 'tool:workflow').text.includes('ONLY when the user explicitly asks'),
    '重开后工具段应再次被改写');
  const againStatus = await callRoute(h1, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(againStatus.value.phase, 'enter', '重开后 phase 应回到 enter');

  // ---- 6. 可用性闸：工作流总开关关掉 → 不注入 ----
  const h3 = makeHarness();
  apply(h3.ctx, { workflowsEnabled: false });
  await callRoute(h3, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
  const gated = nativeAssembly();
  assert.deepEqual(await assemble(h3, gated), gated, '工作流关闭时不得注入');
  const st3 = await callRoute(h3, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(st3.value.available, false);
  assert.equal(st3.value.reason, 'workflows');

  // ---- 7. 可用性闸：模型档位不足 → 不注入 ----
  const h4 = makeHarness({ modelEfforts: [{ id: 'off' }, { id: 'low' }] });
  apply(h4.ctx, {});
  await callRoute(h4, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
  await callRoute(h4, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION })
    .then(() => undefined);
  // 先让路由被观察到（模型档位判定需要模型标识）
  const req4 = (h4.listeners.get('agent/request') ?? [])[0];
  await req4({ agent: AGENT, turn: 1, step: 1, signal: undefined },
    async () => ({ provider: 'p', model: 'weak-model', reasoningEffort: 'high' }));
  const gated4 = nativeAssembly();
  assert.deepEqual(await assemble(h4, gated4), gated4, '模型档位不足时不得注入');
  const st4 = await callRoute(h4, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(st4.value.available, false);
  assert.equal(st4.value.reason, 'model');

  // ---- 8. 会话隔离：别的会话不受影响 ----
  const other = { id: 'session-other', session: { id: 'session-other' } };
  const otherAssembly = nativeAssembly();
  assert.deepEqual(await assemble(h1, otherAssembly, other), otherAssembly, '未启用的会话不得被注入');

  // ---- 9. 思考强度硬约束：ultracode 不得限制模型思考强度 ----
  const h5 = makeHarness();
  apply(h5.ctx, {});
  await callRoute(h5, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
  const requestHandlers = h5.listeners.get('agent/request') ?? [];
  assert.equal(requestHandlers.length, 1, 'agent/request 应恰好一个监听者');
  const handedIn = { provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash', reasoningEffort: 'max', maxTokens: 384000, temperature: 0.3 };
  const handedBack = await requestHandlers[0]({ agent: AGENT, turn: 1, step: 1, signal: undefined }, async () => handedIn);
  assert.equal(handedBack, handedIn, 'agent/request 必须返回同一个对象（同引用透传）');
  assert.equal(handedBack.reasoningEffort, 'max', 'reasoningEffort 必须原样保留，不得下调/上调/封顶');
  assert.equal(handedBack.maxTokens, 384000, 'maxTokens 不得被改写');
  assert.equal(handedBack.temperature, 0.3, 'temperature 不得被改写');

  for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'off']) {
    const hx = makeHarness();
    apply(hx.ctx, {});
    await callRoute(hx, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: true } });
    const handler = (hx.listeners.get('agent/request') ?? [])[0];
    const cfg = { provider: 'p', model: 'm', reasoningEffort: level };
    const returned = await handler({ agent: AGENT, turn: 1, step: 1, signal: undefined }, async () => cfg);
    assert.equal(returned, cfg, 'strength=' + level + ' 时仍须同引用透传');
    assert.equal(returned.reasoningEffort, level, 'strength=' + level + ' 必须原样保留');
  }

  // 注入路径也不得触碰强度
  const st5 = await callRoute(h5, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(st5.value.reasoningEffort, 'max', 'status 应如实回显会话自身强度');
  assert.equal(st5.value.effortPolicy, 'untouched');
  assert.equal(st5.value.underlyingEffort, undefined, '不得再暴露任何“应有档位”字段');

  // ---- 10. 逆向事实快照（只钉事实，不参与行为） ----
  assert.deepEqual(ORIGINAL_EFFORT_MODEL.ladder, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(ORIGINAL_EFFORT_MODEL.spellings, { med: 'medium' });
  assert.deepEqual(ORIGINAL_EFFORT_MODEL.aliases, { ultracode: 'xhigh' });
  assert.equal(ORIGINAL_EFFORT_MODEL.turnsBetweenMaintenance, 10);
  assert.equal(ORIGINAL_REMINDERS.full, FULL, 'full 提醒必须与 bundle 逐字一致');
  assert.equal(ORIGINAL_REMINDERS.sparse, SPARSE, 'sparse 提醒必须与 bundle 逐字一致');
  assert.equal(ORIGINAL_REMINDERS.exit, EXIT, 'exit 提醒必须与 bundle 逐字一致');

  // ---- 11. 状态生命周期：reset 抹掉交互态，提示逐字节回到原生 ----
  const reset = await callRoute(h1, '/dsh-ultracode/reset', { method: 'POST', body: { sessionId: SESSION } });
  assert.equal(reset.status, 200);
  assert.equal(reset.value.requested, false, 'reset 后应回到未启用');
  assert.equal(reset.value.phase, 'none', 'reset 后不应再欠收口');
  assert.deepEqual(await assemble(h1, nativeAssembly()), nativeAssembly(),
    'reset 后装配结果必须与原生逐字节一致（连收口段也不留）');

  // ---- 12. 状态生命周期：预置来源（--settings / apply_flag_settings 的对应物） ----
  process.env.DSH_ULTRACODE = 'on';
  const h6 = makeHarness();
  apply(h6.ctx, {});
  const bootStatus = await callRoute(h6, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(bootStatus.value.requested, true, 'DSH_ULTRACODE=on 时新会话开局即启用');
  assert.equal(bootStatus.value.source, 'provisioned', '来源应标为 provisioned');
  const bootAssembly = await assemble(h6);
  assert.ok(sectionNamed(bootAssembly, 'ultracode').text.includes('Quality patterns'),
    '预置开启的会话无需任何开关即直注');
  // 交互开关接管来源，且不改变「永不落盘」的语义（此处只验证来源切换与关闭收口）
  await callRoute(h6, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: SESSION, active: false } });
  const afterToggle = await callRoute(h6, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(afterToggle.value.source, 'interactive', '交互开关应接管来源');
  delete process.env.DSH_ULTRACODE;

  // ---- 13. 回执文案所需字段：Valid options 列表 ----
  const st6 = await callRoute(h1, '/dsh-ultracode/status', { query: '?sessionId=' + SESSION });
  assert.equal(typeof st6.value.validOptions, 'string', 'status 必须能支撑 Valid options 回执');
  assert.ok(st6.value.validOptions.includes('auto'), 'Valid options 必须含 auto（对齐原实现 g(e)）');
  assert.ok(!/(^|, )off(,|$)/.test(st6.value.validOptions), 'Valid options 不得把 off 列为可选项');
  assert.ok(st6.value.validOptions.includes('ultracode [on|off]'), '支持 ultracode 时须附 [on|off]（逐字对齐 g(e)）');

  // ══ 会话选择落盘（2026-10-09）：跨 dsh 重启不失效 ═══════════════════════════
  //
  // 「重启」在自测里的等价物 = **再调一次 apply()**：本插件的全部状态都活在 apply
  // 的闭包与盘上文件里，模块级没有任何可变状态，所以「新实例 + 同一份 $DSH_HOME」
  // 与「dsh 进程重启后重新加载插件、会话按原 id 恢复」走的是同一条代码路径
  // （stateOf 的第 ② 路）。真实事故现场：dsh-web 重启后胶囊回到熄灭态。

  const readStore = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const recordOf = (sessionId) => readStore().sessions[sessionId];
  /** 新实例 = 新进程。 */
  const freshHarness = (config = {}) => {
    const made = makeHarness();
    apply(made.ctx, config);
    return made;
  };

  // ---- 14. 缺省落盘路径 = $DSH_HOME/ultracode.json（自测整体隔离在沙箱里） ----
  assert.equal(defaultStateFile(), STATE_FILE, '缺省落盘路径必须是 $DSH_HOME/ultracode.json');
  assert.ok(defaultStateFile().startsWith(SANDBOX), '自测的 DSH_HOME 必须指向沙箱，不得碰真实 $DSH_HOME');
  assert.notEqual(join(homedir(), '.dsh', 'ultracode.json'), defaultStateFile(),
    'DSH_HOME 在场时不得退回 ~/.dsh');

  // ---- 15. 落盘形状：{version, sessions:{<sessionId>:{enabled, phase, decidedAt}}} ----
  const PA = 'session-persist-a';
  const AGENT_A = { id: PA, session: { id: PA } };
  const hA = freshHarness();
  const setA = await callRoute(hA, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PA, active: true } });
  assert.equal(setA.value.persisted, true, 'set 之后本会话盘上应已有记录');
  assert.equal(setA.value.restored, false, '本次是点击写入，不该标成「由落盘恢复」');
  assert.equal(setA.value.stateFile, STATE_FILE, 'status 必须如实报出落盘路径');
  assert.equal(readStore().version, 2, '落盘格式版本必须是 2（家族表 + 家谱表；version 1 仍可读，见 §38）');
  assert.equal(recordOf(PA).enabled, true, '记录必须保存选择本身');
  assert.equal(recordOf(PA).phase, 'enter', '记录必须保存 phase（原实现的进入/退出本就从持久化历史回扫）');
  assert.equal(Number.isFinite(recordOf(PA).decidedAt), true, '记录必须带决定时间');

  // ---- 16. 重启等价：新实例按盘上记录原样重建（本次修改的核心用例） ----
  const onBefore = await assemble(hA, nativeAssembly(), AGENT_A);
  const hB = freshHarness();                       // ← 新进程
  const bootB = await callRoute(hB, '/dsh-ultracode/status', { query: '?sessionId=' + PA });
  assert.equal(bootB.value.requested, true, '重启后必须仍记得「开着」');
  assert.equal(bootB.value.active, true, '重启后仍应是生效态');
  assert.equal(bootB.value.source, 'interactive', '恢复出来仍是「会话开关」这一路，不是预置');
  assert.equal(bootB.value.restored, true, '必须标出「本次由落盘恢复」');
  assert.equal(bootB.value.persisted, true, '盘上仍有本会话记录');
  assert.equal(bootB.value.phase, 'enter', 'phase 必须一并恢复');
  assert.ok(bootB.value.telemetry.restores >= 1, '恢复计数应增加');
  const onAfter = await assemble(hB, nativeAssembly(), AGENT_A);
  assert.deepEqual(onAfter, onBefore, '重启前后装配结果必须逐字节一致（注入段与工具段改写都在场）');
  assert.ok(sectionNamed(onAfter, 'ultracode').text.includes('Quality patterns'),
    '重启后 Ultracode 段必须照旧是开启态正文');
  assert.ok(!sectionNamed(onAfter, 'tool:workflow').text.includes('ONLY when the user explicitly asks'),
    '重启后工具段必须照旧是 ultracode 感知版');

  // ---- 17. 关闭同样跨重启（退出闩锁一起落盘） ----
  await callRoute(hA, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PA, active: false } });
  assert.equal(recordOf(PA).phase, 'exit', '关闭后盘上 phase 应为 exit');
  const hC = freshHarness();                       // ← 又一次「重启」
  const offC = await callRoute(hC, '/dsh-ultracode/status', { query: '?sessionId=' + PA });
  assert.equal(offC.value.requested, false, '重启后必须仍记得「关着」');
  assert.equal(offC.value.phase, 'exit', '退出闩锁同样跨重启');
  const offAssembly = await assemble(hC, nativeAssembly(), AGENT_A);
  assert.ok(sectionNamed(offAssembly, 'ultracode').text.includes('Ultracode is off'), '重启后仍应给出收口语义');
  assert.equal(sectionNamed(offAssembly, 'tool:workflow').text, NATIVE_TOOL_TEXT, '收口态工具段恢复原生');

  // ---- 18. reset 连盘上记录一起抹掉（只清内存等于没 reset） ----
  await callRoute(hC, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PA, active: true } });
  const resetA = await callRoute(hC, '/dsh-ultracode/reset', { method: 'POST', body: { sessionId: PA } });
  assert.equal(resetA.value.persisted, false, 'reset 之后盘上不得再留本会话记录');
  assert.equal(recordOf(PA), undefined, 'reset 必须把记录从盘上删掉');
  const hD = freshHarness();                       // ← 又一次「重启」
  const bootD = await callRoute(hD, '/dsh-ultracode/status', { query: '?sessionId=' + PA });
  assert.equal(bootD.value.requested, false, 'reset 后重启不得把抹掉的选择恢复回来');
  assert.equal(bootD.value.phase, 'none', 'reset 后不得再欠收口');
  assert.deepEqual(await assemble(hD, nativeAssembly(), AGENT_A), nativeAssembly(),
    'reset 后（哪怕再重启）装配结果必须与原生逐字节一致');

  // ---- 19. agent/disposed 只清内存、**不清盘**（本条就是「重启后不失效」的钉子） ----
  const PE = 'session-persist-e';
  const AGENT_E = { id: PE, session: { id: PE } };
  const hE = freshHarness();
  await callRoute(hE, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PE, active: true } });
  for (const handler of hE.listeners.get('agent/disposed') ?? []) handler({ agent: AGENT_E });
  assert.equal(recordOf(PE).enabled, true, '会话销毁不得删掉盘上记录（删了就退回「重启即失」）');
  const afterDispose = await callRoute(hE, '/dsh-ultracode/status', { query: '?sessionId=' + PE });
  assert.equal(afterDispose.value.restored, true, '销毁后内存态确实清掉了：再问一次会重新从盘上恢复');
  const hF = freshHarness();                       // ← 又一次「重启」
  const bootF = await callRoute(hF, '/dsh-ultracode/status', { query: '?sessionId=' + PE });
  assert.equal(bootF.value.requested, true, '会话销毁后重启仍应记得开着');
  assert.equal(bootF.value.restored, true, '并且如实标出「由落盘恢复」');

  // ---- 20. 坏文件容错：不抛、不连累路由，且下一次写盘把文件救回来 ----
  const PB = 'session-persist-b';
  writeFileSync(STATE_FILE, '{ this is not json', 'utf8');
  let threw = false;
  let hG;
  try { hG = freshHarness(); } catch { threw = true; }
  assert.equal(threw, false, '坏文件不得让 apply 抛异常（插件必须照常挂载）');
  const bootG = await callRoute(hG, '/dsh-ultracode/status', { query: '?sessionId=' + PB });
  assert.equal(bootG.status, 200, '坏文件时状态路由仍须 200');
  assert.equal(typeof bootG.value.storeError, 'string', '坏文件必须如实上报原因，不得静默');
  assert.ok(bootG.value.storeError.length > 0, 'storeError 必须带上真实原因');
  assert.equal(bootG.value.requested, false, '坏文件按「没有记录」降级');
  const healed = await callRoute(hG, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PB, active: true } });
  assert.equal(healed.value.storeError, null, '写盘成功后应清掉上一次的失败原因');
  assert.equal(recordOf(PB).enabled, true, '下一次写盘必须把坏文件整表覆盖成合法 JSON');

  // ---- 21. 多进程合并：写自己那条时不得抹掉别的进程写的会话 ----
  const FOREIGN = 'session-persist-foreign';
  const table = readStore();
  table.sessions[FOREIGN] = { enabled: true, phase: 'enter', decidedAt: Date.now() - 1000 };
  writeFileSync(STATE_FILE, JSON.stringify(table, null, 2) + '\n', 'utf8');
  const PC = 'session-persist-c';
  const hH = freshHarness();
  await callRoute(hH, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PC, active: true } });
  assert.equal(recordOf(FOREIGN).enabled, true, '写盘前先重读+合并：别的进程写的会话必须原样留着');
  assert.equal(recordOf(PC).enabled, true, '本次写的会话当然要在');
  await callRoute(hH, '/dsh-ultracode/reset', { method: 'POST', body: { sessionId: PC } });
  assert.equal(recordOf(PC), undefined, 'reset 后本会话条目应消失');
  assert.equal(recordOf(FOREIGN).enabled, true, '删自己那条时也不得顺手带走/复活别的会话');

  // ---- 22. 预置 vs 落盘：对某会话的显式选择高于进程级缺省 ----
  const PP = 'session-persist-provisioned';
  const hI = freshHarness();
  await callRoute(hI, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PP, active: false } });
  process.env.DSH_ULTRACODE = 'on';
  const hJ = freshHarness();
  const bootJ = await callRoute(hJ, '/dsh-ultracode/status', { query: '?sessionId=' + PP });
  assert.equal(bootJ.value.requested, false,
    '预置不得覆盖用户对该会话的显式关闭（否则每次重启都会把用户手动关掉的又打开）');
  assert.equal(bootJ.value.source, 'interactive', '有落盘记录时来源是会话开关');
  const freshId = 'session-persist-fresh';
  const bootFresh = await callRoute(hJ, '/dsh-ultracode/status', { query: '?sessionId=' + freshId });
  assert.equal(bootFresh.value.requested, true, '没有记录的会话仍按预置开局');
  assert.equal(bootFresh.value.source, 'provisioned', '没有记录时来源是预置');
  assert.equal(bootFresh.value.persisted, false, '没有记录时不得声称已落盘');

  // ---- 23. reset 抹掉记录后回到预置开局 ----
  const resetJ = await callRoute(hJ, '/dsh-ultracode/reset', { method: 'POST', body: { sessionId: PP } });
  assert.equal(resetJ.value.requested, true, 'reset 抹掉记录后应回到预置开局');
  assert.equal(resetJ.value.source, 'provisioned', 'reset 后来源回到预置');
  assert.equal(resetJ.value.persisted, false, 'reset 后盘上不得再留记录');
  delete process.env.DSH_ULTRACODE;

  // ---- 24. 未落盘的会话不受影响（补充 §8 的会话隔离） ----
  const untouched = nativeAssembly();
  assert.deepEqual(await assemble(hF, untouched, { id: freshId, session: { id: freshId } }), untouched,
    '别的会话的记录不得注入到本会话，未落盘的会话仍逐字节直通');

  // ---- 25. 落盘彻底不可用（stateFile 路径被一个同名目录占住）：插件照常工作 ----
  // 覆盖头注释里那句「写不进去也不影响装配与路由」：切换必须照常生效（内存态优先），
  // 失败同时走 ctx.logger?.warn? 与 status.storeError，且不留 tmp 残片。
  const blockedFile = join(SANDBOX, 'blocked', 'ultracode.json');
  mkdirSync(dirname(blockedFile), { recursive: true });
  mkdirSync(blockedFile);                       // 同名目录占位 → 读是 EISDIR、换名也失败
  const hK = freshHarness({ stateFile: blockedFile });
  const PK = 'session-persist-blocked';
  const setK = await callRoute(hK, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PK, active: true } });
  assert.equal(setK.status, 200, '写不进盘时 /set 仍须 200（本次切换已在内存里生效）');
  assert.equal(setK.value.requested, true, '写不进盘也必须让本次切换生效，不能反过来阻断用户');
  assert.equal(setK.value.persisted, false, '写失败时不得声称已落盘');
  assert.equal(typeof setK.value.storeError, 'string', '写失败必须如实上报原因');
  assert.ok(setK.value.storeError.length > 0, 'storeError 必须带上真实原因');
  assert.equal(setK.value.stateFile, blockedFile, 'status 必须如实报出实际使用的落盘路径');
  assert.ok(hK.logs.length > 0, '落盘失败必须同时走 ctx.logger?.warn?（不能只躺在 /status 里）');
  assert.ok(String(hK.logs[0][0]).includes('落盘'), '告警文案应指明是落盘失败');
  const blockedAssembly = await assemble(hK, nativeAssembly(), { id: PK, session: { id: PK } });
  assert.ok(sectionNamed(blockedAssembly, 'ultracode') !== undefined, '落盘失败不得影响系统提示注入');
  assert.deepEqual(readdirSync(dirname(blockedFile)).filter((name) => name.includes('.tmp-')), [],
    '写失败不得把 tmp 残片留在目录里');

  // ---- 26. 落盘判定必须**逐会话**：A 写成功、B 写失败时，A 仍是「已落盘」 ----
  // 注入手法：主文件名长到让 tmp 名（file + '.tmp-' + uuid36）越过 NAME_MAX=255 ——
  // 主文件本身照常可读可写，只有原子写的 tmp 那一步必然 ENAMETOOLONG。
  // （用 chmod 造失败在这里行不通：本机是 root，DAC 被绕过。）
  const longDir = join(SANDBOX, 'namelen');
  mkdirSync(longDir, { recursive: true });
  const longFile = join(longDir, 'u'.repeat(236) + '.json');
  const PL = 'session-persist-longname';
  const PM = 'session-persist-writefail';
  writeFileSync(longFile,
    JSON.stringify({ version: 1, sessions: { [PL]: { enabled: true, phase: 'enter', decidedAt: 1 } } }, null, 2) + '\n',
    'utf8');
  const hL = freshHarness({ stateFile: longFile });
  const bootL = await callRoute(hL, '/dsh-ultracode/status', { query: '?sessionId=' + PL });
  assert.equal(bootL.value.persisted, true, '从盘上读回来的记录本来就是已落盘');
  const setL = await callRoute(hL, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PM, active: true } });
  assert.equal(setL.status, 200, '落盘失败仍须 200（本次切换已在内存里生效）');
  assert.equal(typeof setL.value.storeError, 'string', '这一步必须如实报出写失败');
  assert.equal(setL.value.persisted, false, '写失败的那条不得声称已落盘');
  const stillL = await callRoute(hL, '/dsh-ultracode/status', { query: '?sessionId=' + PL });
  assert.equal(stillL.value.persisted, true,
    '别的会话写失败，不得把 A 的「已落盘」连坐成 false（否则标题会同时说「由落盘恢复」和「重启会丢」）');
  assert.equal(stillL.value.restored, true, 'A 仍是本次由盘上恢复');
  assert.equal(JSON.parse(readFileSync(longFile, 'utf8')).sessions[PL].enabled, true, '写失败不得破坏盘上原有内容');

  // ---- 27. 别的进程 reset 掉的记录，本进程不得在下次整表回写时复活 ----
  const PX = 'session-persist-cross-del';
  const PY = 'session-persist-cross-other';
  const hX = freshHarness();
  await callRoute(hX, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PX, active: true } });
  assert.equal(recordOf(PX).enabled, true, '前置：X 已在盘上（= 本进程内存里也有一份干净副本）');
  // 模拟另一个 dsh 进程把 X reset 掉：盘上这条直接消失
  writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions: {} }, null, 2) + '\n', 'utf8');
  await callRoute(hX, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PY, active: true } });
  assert.equal(recordOf(PX), undefined, '盘上已被别的进程删掉的记录，不得被本进程整表回写复活');
  assert.equal(recordOf(PY).enabled, true, '本次写的会话当然要在');
  const afterCrossDel = await callRoute(hX, '/dsh-ultracode/status', { query: '?sessionId=' + PX });
  assert.equal(afterCrossDel.value.persisted, false, '内存里也应跟着消失（不再对外声称有这条记录）');

  // ---- 28. 冷进程里 /set 先到：必须先读盘，别把退出闩锁算丢 ----
  const PZ = 'session-persist-cold-set';
  writeFileSync(STATE_FILE,
    JSON.stringify({ version: 1, sessions: { [PZ]: { enabled: true, phase: 'enter', decidedAt: Date.now() } } }, null, 2) + '\n',
    'utf8');
  const hZ = freshHarness();
  // **不先问 /status** 就直接点熄灭（只有直接打 HTTP 的调用者会这样做；GUI 有守卫）
  const setZ = await callRoute(hZ, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: PZ, active: false } });
  assert.equal(setZ.value.phase, 'exit', '先到的 /set 必须从盘上认出「刚才是开着」，从而闩上收口段');
  assert.equal(recordOf(PZ).phase, 'exit', '盘上记录也必须改写成 exit，而不是覆写成 none');
  assert.equal(recordOf(PZ).enabled, false, '选择本身当然要落盘');

  // ══ 家族（2026-10-09 追加）：一个血脉共用一个开关，改动影响全部分支 ═════════
  //
  // 用户口径：ultracode 不是「一个会话一个选择」，而是**一个家族一个选择** —— 主线
  // 与它 fork/分叉出来的全部分支共享，在哪条分支上点一下，整族一起变。记录因此按
  // 「家族根会话 id」存一条，任意会话先解析出自己的家族根再读写它。

  // 家族一组自成一档：先把盘上清成空的 v2 文件，免得前面用例的记录混进「一族一条」断言。
  writeFileSync(STATE_FILE, JSON.stringify({ version: 2, families: {}, sessions: {} }, null, 2) + '\n', 'utf8');

  // ---- 29. fork 继承：子会话没点过任何开关，直接认领家族的开启状态 ----
  const famRoot = 'session-fam-root';
  const famChild = 'session-fam-child';
  const famGrand = 'session-fam-grand';
  const hFam = freshHarness();
  spawn(hFam, { id: famRoot });                       // 主线：没有父指针
  const setFamRoot = await callRoute(hFam, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: famRoot, active: true } });
  assert.equal(setFamRoot.value.family, famRoot, '主线自己的家族根就是自己');
  assert.equal(setFamRoot.value.familyRoot, true, 'rooted 标记要指向主线');
  assert.equal(setFamRoot.value.branches, 0, '还没有分支时分支数为 0');

  spawn(hFam, { id: famChild, parent: famRoot });     // fork：内核带着父指针铸造
  const childInherit = await callRoute(hFam, '/dsh-ultracode/status', { query: '?sessionId=' + famChild });
  assert.equal(childInherit.value.requested, true, 'fork 出来的分支必须继承家族的开启状态（用户没在它上面点过）');
  assert.equal(childInherit.value.active, true, '继承来的状态要真的算「已点亮」');
  assert.equal(childInherit.value.family, famRoot, '分支的家族根是主线');
  assert.equal(childInherit.value.familyRoot, false, '分支自己不是根');
  assert.equal(childInherit.value.restored, true, '继承来的值算「由落盘恢复」，不是本次点击');
  assert.equal(childInherit.value.persisted, true, '记录与家谱都必须真的在盘上');
  assert.equal(childInherit.value.branches, 1, '主线能看到自己有一条分支');
  const rootSeesBranch = await callRoute(hFam, '/dsh-ultracode/status', { query: '?sessionId=' + famRoot });
  assert.equal(rootSeesBranch.value.branches, 1, '分支数两个方向都要对得上');

  // 一次装配：继承来的分支必须**真的**在系统提示里拿到 Ultracode 段（不只是胶囊变绿）
  const childAssembly = await assemble(hFam, nativeAssembly(), { id: famChild, session: { id: famChild } });
  assert.ok(sectionNamed(childAssembly, 'ultracode') !== undefined, '继承开启的分支必须真的注入 Ultracode 段');
  assert.ok(sectionNamed(childAssembly, 'ultracode').text.includes('optimize for the most exhaustive, correct answer'),
    '继承开启的分支必须真的拿到指令正文（不是空壳段）');
  assert.ok(sectionNamed(childAssembly, 'ultracode').text.includes('Use the Workflow tool on every substantive task'),
    '分支拿到的正文与主线同源');

  // ---- 30. 落盘形状：一个家族一条记录 + 一张家谱 ----
  const famDisk = readStore();
  assert.equal(famDisk.version, 2, '落盘格式版本升到 2（家族表 + 家谱表）');
  assert.deepEqual(Object.keys(famDisk.sessions), [famRoot], '一个家族只占一条开关记录');
  assert.equal(famDisk.families[famChild], famRoot, '家谱要记下分支的归属');
  assert.equal(famDisk.families[famRoot], undefined, '根本不用记自己（自己就是根）');

  // ---- 31. 全族共用：在分支上熄灭 → 主线（及提示注入）一起熄 ----
  const turnOffInBranch = await callRoute(hFam, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: famChild, active: false } });
  assert.equal(turnOffInBranch.value.requested, false, '分支上的点击先在自己身上生效');
  assert.equal(turnOffInBranch.value.phase, 'exit', '熄灭要闩上收口段（分支侧）');
  const rootAfterBranchOff = await callRoute(hFam, '/dsh-ultracode/status', { query: '?sessionId=' + famRoot });
  assert.equal(rootAfterBranchOff.value.requested, false, '在分支上熄灭必须影响主线（「修改影响全部分支」）');
  assert.equal(rootAfterBranchOff.value.phase, 'exit', '收口闩锁同样整族生效');
  const rootAssemblyAfterOff = await assemble(hFam, nativeAssembly(), { id: famRoot, session: { id: famRoot } });
  assert.ok(sectionNamed(rootAssemblyAfterOff, 'ultracode').text.includes(EXIT),
    '主线**下一次装配**就要按新状态收口（状态对账发生在 stateOf，不在 /status 里）');
  assert.ok(rootAfterBranchOff.value.telemetry.syncs > 0, '对账跟上别的分支的改动要有遥测证据（syncs>0）');

  // 反向：主线点亮 → 分支跟着亮
  await callRoute(hFam, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: famRoot, active: true } });
  const childAfterRootOn = await callRoute(hFam, '/dsh-ultracode/status', { query: '?sessionId=' + famChild });
  assert.equal(childAfterRootOn.value.requested, true, '主线点亮后分支必须跟上');
  assert.equal(childAfterRootOn.value.restored, true, '这次分支是被家族记录带亮的（不是自己点的）');

  // ---- 32. 链式继承：孙代归到同一个家族根 ----
  spawn(hFam, { id: famGrand, parent: famChild });
  const grandStatus = await callRoute(hFam, '/dsh-ultracode/status', { query: '?sessionId=' + famGrand });
  assert.equal(grandStatus.value.family, famRoot, '孙代要归到同一个家族根（不是归到父级）');
  assert.equal(grandStatus.value.requested, true, '孙代同样继承开关');
  assert.equal(grandStatus.value.branches, 2, '主线此时能看到两条分支');
  assert.deepEqual(Object.keys(readStore().sessions), [famRoot], '三代同堂仍然只占一条记录');

  // ---- 33. 父没做过选择：子不得凭空开启（继承的是「记录」，不是「父还活着」） ----
  const hQuiet = freshHarness();
  const quietRoot = 'session-fam-quiet';
  const quietChild = 'session-fam-quiet-child';
  spawn(hQuiet, { id: quietRoot });
  spawn(hQuiet, { id: quietChild, parent: quietRoot });
  const quietStatus = await callRoute(hQuiet, '/dsh-ultracode/status', { query: '?sessionId=' + quietChild });
  assert.equal(quietStatus.value.requested, false, '父从未点过开关时，子会话不得凭空变成开启');
  assert.equal(quietStatus.value.family, quietRoot, '但归属照样要认得（家谱已记，父以后点亮它会跟上）');
  assert.equal(quietStatus.value.persisted, false, '没有记录就不能声称已落盘');
  assert.equal(readStore().sessions[quietRoot], undefined, '认亲不产生开关记录（家谱 ≠ 选择）');
  assert.equal(readStore().sessions[quietChild], undefined, '子会话自己也不该凭空多出一条记录');

  // ---- 34. 重启后父不在内存：单独打开一条分支，靠家谱仍要继承 ----
  const hCold = freshHarness();
  const coldRoot = 'session-fam-cold-root';
  const coldChild = 'session-fam-cold-child';
  spawn(hCold, { id: coldRoot });
  await callRoute(hCold, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: coldRoot, active: true } });
  spawn(hCold, { id: coldChild, parent: coldRoot });
  const hCold2 = freshHarness();                       // ← 新进程（父会话不会被恢复）
  hCold2.live.set(coldChild, { id: coldChild, header: {} });   // 连父指针都没有（极端情形）
  const coldInherit = await callRoute(hCold2, '/dsh-ultracode/status', { query: '?sessionId=' + coldChild });
  assert.equal(coldInherit.value.family, coldRoot, '父不在内存、连父指针都没有时，靠盘上家谱也要认族');
  assert.equal(coldInherit.value.requested, true, '冷启动后单独打开分支必须继承家族的开启状态');

  // ---- 35. 消息分支的空白分支：出厂谱系断了，靠消息分支账本认族 ----
  // 消息分支里第一条分支是 sessions.create 出来的空白会话（header 没有 parentSession），
  // 它自己的 groups.json 记着「这个会话属于哪个组、组根是谁」——只读那本账，读不到就作罢。
  const hMb = freshHarness();
  const mbRoot = 'session-mb-root';
  const mbBlank = 'session-mb-blank';
  spawn(hMb, { id: mbRoot });
  hMb.live.set(mbBlank, { id: mbBlank, header: {} });   // 空白分支：**没有** parentSession
  await callRoute(hMb, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: mbRoot, active: true } });
  mkdirSync(join(SANDBOX, 'message-branches'), { recursive: true });
  writeFileSync(join(SANDBOX, 'message-branches', 'groups.json'), JSON.stringify({
    version: 1,
    groups: {
      [mbRoot]: {
        rootSessionId: mbRoot,
        branches: [
          { sessionId: mbRoot, parentSessionId: null, kind: 'root' },
          { sessionId: mbBlank, parentSessionId: mbRoot, kind: 'blank' },
        ],
      },
    },
  }, null, 2) + '\n', 'utf8');
  const blankStatus = await callRoute(hMb, '/dsh-ultracode/status', { query: '?sessionId=' + mbBlank });
  assert.equal(blankStatus.value.family, mbRoot, '空白分支必须靠消息分支账本认到组根');
  assert.equal(blankStatus.value.requested, true, '空白分支也要继承组根的开关');
  assert.equal(readStore().families[mbBlank], mbRoot, '这次认亲同样要落盘（重启后仍认得）');
  const hMb2 = freshHarness();                          // 新进程：账本还在，家谱也还在
  hMb2.live.set(mbBlank, { id: mbBlank, header: {} });
  const blankCold = await callRoute(hMb2, '/dsh-ultracode/status', { query: '?sessionId=' + mbBlank });
  assert.equal(blankCold.value.family, mbRoot, '重启后仍归组根（账本或家谱任一路都够）');
  assert.equal(blankCold.value.requested, true, '重启后空白分支仍继承组根的开启状态');
  rmSync(join(SANDBOX, 'message-branches'), { recursive: true, force: true });

  // ---- 36. reset 是**整族**的：记录抹掉、家谱保留 ----
  const hReset = freshHarness();
  const rsRoot = 'session-fam-reset-root';
  const rsChild = 'session-fam-reset-child';
  spawn(hReset, { id: rsRoot });
  spawn(hReset, { id: rsChild, parent: rsRoot });
  await callRoute(hReset, '/dsh-ultracode/set', { method: 'POST', body: { sessionId: rsRoot, active: true } });
  const resetInChild = await callRoute(hReset, '/dsh-ultracode/reset', { method: 'POST', body: { sessionId: rsChild } });
  assert.equal(resetInChild.value.requested, false, 'reset 之后回到预置开局');
  const rootAfterReset = await callRoute(hReset, '/dsh-ultracode/status', { query: '?sessionId=' + rsRoot });
  assert.equal(rootAfterReset.value.requested, false, 'reset 是整族的：主线也要回到预置');
  assert.equal(rootAfterReset.value.persisted, false, '盘上不得再留这条记录');
  assert.equal(readStore().families[rsChild], rsRoot, '家谱要保留（骨架还在，只是没有选择了）');

  // ---- 37. session/created 认证亲**绝不外抛**（外抛会否决会话创建并回滚） ----
  const hGuard = freshHarness();
  const before = readStore().families === undefined ? {} : readStore().families;
  let createThrew = false;
  const bomb = { get id() { throw new Error('kernel-side getter exploded'); } };
  try {
    for (const handler of hGuard.listeners.get('session/created') ?? []) handler(bomb);
  } catch {
    createThrew = true;
  }
  assert.equal(createThrew, false, '认亲失败必须被吞掉：同步抛错会回滚会话创建');
  assert.ok(hGuard.logs.length > 0, '吞掉不等于静默：必须走 ctx.logger?.warn?');
  assert.deepEqual(readStore().families ?? {}, before, '失败的认亲不得写坏家谱');
  // 没有父指针的普通新会话：既不认亲也不报错
  const soloId = 'session-fam-solo';
  const logsBefore = hGuard.logs.length;
  spawn(hGuard, { id: soloId });
  assert.equal(readStore().families?.[soloId], undefined, '没有父指针就不该有家谱条目');
  assert.equal(hGuard.logs.length, logsBefore, '正常的新会话不该触发任何告警');

  // ---- 38. 旧格式（version 1，按会话一条记录）照常读得进来 ----
  const v1Id = 'session-fam-v1';
  writeFileSync(STATE_FILE,
    JSON.stringify({ version: 1, sessions: { [v1Id]: { enabled: true, phase: 'enter', decidedAt: 42 } } }, null, 2) + '\n',
    'utf8');
  const hV1 = freshHarness();
  const v1Status = await callRoute(hV1, '/dsh-ultracode/status', { query: '?sessionId=' + v1Id });
  assert.equal(v1Status.value.requested, true, 'version 1 的旧文件必须照常读进来（每个键各自成家）');
  assert.equal(v1Status.value.family, v1Id, '旧记录的那个会话自己就是家族根');
  assert.equal(v1Status.value.persisted, true, '旧记录同样是「已落盘」');
  assert.equal(v1Status.value.phase, 'enter', '旧记录里的退出闩锁照样读得回来');

  // ---- 39. 不认识的版本按坏文件处理：告警 + 不假装有记录 ----
  writeFileSync(STATE_FILE, JSON.stringify({ version: 99, sessions: {} }, null, 2) + '\n', 'utf8');
  const hBadVer = freshHarness();
  const badVerStatus = await callRoute(hBadVer, '/dsh-ultracode/status', { query: '?sessionId=' + v1Id });
  assert.equal(badVerStatus.value.requested, false, '读不动的文件不得被当成「有记录」');
  assert.equal(badVerStatus.value.persisted, false, '读不动就不能声称已落盘');
  assert.ok(hBadVer.logs.length > 0, '未知版本必须告警（不猜、不静默、不迁移）');
  assert.equal(typeof badVerStatus.value.storeError, 'string', '原因要如实出现在 storeError 里');

  // 用完即删：沙箱（含临时文件）不留残片。
  rmSync(SANDBOX, { recursive: true, force: true });

  console.log('SELFTEST PASS');
}

main().catch((error) => {
  console.error('SELFTEST FAIL:', error.message);
  process.exitCode = 1;
});