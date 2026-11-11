/**
 * 双智能指导 v4（合并版，build 4.1.0+family）——假上下文集成自测。
 *
 * 与 host-selftest.mjs 的分工：那份测的是**编排状态机**（armed/running/结算/自愈，
 * 走 entry-v19 的旧形状）。本文件测的是 v4 **合并进来的三块新面**：
 *   A 主智能只判断（根作用域 tools.guard + 行为段 + 子代理装配防泄漏）
 *   B 子代理模型链（agent/request 改路由、失败回退、供应池重定向、落盘形状）
 *   C 孵化带官方 agentOptions（+ 证据协议进任务尾）
 *   D 出处程序核验端到端（执行者报告 / 无证据 / 主智能自派子代理旁路 + 去重）
 *   E 工作箱二级菜单路由（GET spec / POST op / 同源守卫 / 端到端改约束）
 *   F 状态与配置兼容（旧 v2 落盘、畸形 config、设置持久化、DSH_HOME 默认路径）
 *
 * 约定：无框架；check(label, cond)；ok/FAIL 逐条打印；末尾 GUIDANCE SELFTEST PASS /
 * FAIL (n)；失败时非零退出。状态文件一律落 mkdtemp，并把 DSH_HOME 指到那里。
 *
 * 跑法：node D:\WorkSpace\plugins\dsh-dual-agent\guidance-selftest.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 基座 ─────────────────────────────────────────────────────────────────────

const DIR = mkdtempSync(join(tmpdir(), 'dg-guidance-selftest-'));
process.env.DSH_HOME = DIR;

const failures = [];
let totalChecks = 0;
const check = (label, condition, detail) => {
  totalChecks += 1;
  const ok = condition === true;
  console.log(`${ok ? 'ok   ' : 'FAIL '}${label}`);
  if (!ok) {
    failures.push(label);
    if (detail !== undefined) console.log(`       ↳ ${String(typeof detail === 'function' ? detail() : detail).slice(0, 400)}`);
  }
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const json = (value) => JSON.stringify(value);
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason?.stack ?? reason)); });

/** 当前发布的入口（合并版）。 */
const ENTRY = './entry-v21.js';

let loadSeq = 0;
const loadPlugin = async () => {
  const href = new URL(ENTRY, import.meta.url).href;
  return import(`${href}?v=${Date.now()}-${(loadSeq += 1)}`);
};

/** 假宿主里注册的工具名（够覆盖 allow/deny/readonly/never 四面）。 */
const GLOBAL_TOOLS = [
  'pwsh', 'bash', 'admin_exec', 'write', 'edit', 'create_worktree',
  'terminal_open', 'terminal_send', 'terminal_list', 'terminal_read', 'terminal_close', 'terminal_signal',
  'read', 'read_image', 'grep', 'glob', 'working_directory', 'skill', 'present',
  'list_mcp_resources', 'read_mcp_resource', 'project_list', 'project_active',
  'subagent', 'subagent_fork', 'workflow', 'ralph', 'list_agents', 'interrupt_agent', 'send_message',
  'ask_user_question', 'exit_plan_mode', 'todo_write', 'create_goal', 'get_goal', 'update_goal',
  'job_list', 'job_output', 'job_kill', 'web_search', 'research', 'advanced_search',
];

/**
 * 假工具注册表（作用域链的简化但忠实模型）：
 *   · 每个 agent 一个 layer，parent 指向父 agent 的 layer（root ctx 是 'root'）；
 *   · 继承来的名字被链上**任何**一层 restrict 掩掉（dsh-tools view() 的原话）；
 *   · **本层自己 register 的名字不受祖先 restrict 过滤**（hideMainTools 赌的就是这条）；
 *   · ownRegisterEffective=false 用来演「这条赌输了」→ 触发自动降级自检。
 */
function makeToolRegistry(globalNames, options = {}) {
  const layers = new Map();
  layers.set('root', { denied: new Set(), own: new Set(), parent: null });
  const reg = {
    global: [...globalNames],
    layers,
    ownRegisterEffective: options.ownRegisterEffective !== false,
    restrictCalls: [],
    ensureLayer(key, parentKey) {
      if (!layers.has(key)) layers.set(key, { denied: new Set(), own: new Set(), parent: parentKey ?? 'root' });
      return layers.get(key);
    },
    layerKeyOf(scope) {
      const id = typeof scope?.id === 'string' ? scope.id : (typeof scope === 'string' ? scope : '');
      return layers.has(id) ? id : 'root';
    },
    deniedUnion(key) {
      const out = new Set();
      let current = layers.get(key);
      for (let hops = 0; current !== undefined && hops < 16; hops += 1) {
        for (const name of current.denied) out.add(name);
        current = current.parent === null ? undefined : layers.get(current.parent);
      }
      return out;
    },
    visible(key) {
      const layer = layers.get(key) ?? layers.get('root');
      const denied = reg.deniedUnion(key);
      const set = new Set();
      for (const name of reg.global) if (!denied.has(name)) set.add(name);
      for (const name of layer.own) set.add(name);
      return set;
    },
    get(name) {
      return reg.global.includes(name)
        ? { name, description: `fake tool ${name}`, inputSchema: { type: 'object', properties: {} } }
        : undefined;
    },
    view(key) {
      const bound = {
        guard(fn) { (bound.__guards ??= []).push(fn); if (key === 'root') reg.rootGuards.push(fn); return () => {}; },
        schemas(scope) {
          const at = scope === undefined ? key : reg.layerKeyOf(scope);
          return [...reg.visible(at)].map((name) => ({ name }));
        },
        restrict(spec) {
          const layer = reg.ensureLayer(key, layers.get(key)?.parent ?? 'root');
          const added = [];
          for (const name of (Array.isArray(spec?.deny) ? spec.deny : [])) {
            if (typeof name === 'string' && !layer.denied.has(name)) { layer.denied.add(name); added.push(name); }
          }
          reg.restrictCalls.push({ key, deny: [...added] });
          return () => { for (const name of added) layer.denied.delete(name); };
        },
        register(definition) {
          const name = typeof definition?.name === 'string' ? definition.name : '';
          if (name === '') throw new Error('fake tools.register: 缺 name');
          const layer = reg.ensureLayer(key, layers.get(key)?.parent ?? 'root');
          if (reg.ownRegisterEffective) layer.own.add(name); // 关掉=注册不生效，演降级
          return () => { layer.own.delete(name); };
        },
        get: (name) => reg.get(name),
      };
      return bound;
    },
    rootGuards: [],
  };
  reg.rootView = reg.view('root');
  return reg;
}

/**
 * 假 Agent。header 决定根/子：子代理带 parentSession（isRootAgent / lineageOf 都读它）。
 */
function makeAgent(id, reg, options = {}) {
  const sections = [];
  const followups = [];
  const cancels = [];
  const snapshot = [];
  const agentListeners = new Map();
  const header = { id, cwd: typeof options.cwd === 'string' ? options.cwd : DIR };
  if (typeof options.parent === 'string') header.parentSession = options.parent;
  reg.ensureLayer(id, options.parent ?? 'root');
  const session = {
    id,
    seq: 0,
    header,
    snapshotEvents: (from = 0) => snapshot.filter((event) => (event.seq ?? 0) >= from),
    deriveMessages: () => options.messages ?? [],
    __emit(event) { for (const listener of [...snapshot]) void listener; },
  };
  const agent = {
    id,
    status: options.status ?? 'idle',
    inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    session,
    __snapshot: snapshot,
    __sections: sections,
    __followups: followups,
    __cancels: cancels,
    followup(message) { followups.push(message); },
    whenIdle: () => Promise.resolve(),
    cancel(cause, cancelOptions) { cancels.push({ cause, options: cancelOptions }); },
    __append(event) {
      const seq = snapshot.length === 0 ? 0 : (snapshot.at(-1).seq ?? 0) + 1;
      const full = { seq, time: Date.now(), ...event };
      snapshot.push(full);
      session.seq = seq + 1;
      return full;
    },
    ctx: {
      effect(fn) { const returned = fn(); return typeof returned === 'function' ? returned : () => {}; },
      on(name, listener) {
        if (!agentListeners.has(name)) agentListeners.set(name, []);
        agentListeners.get(name).push(listener);
        return () => {};
      },
      systemPrompt: {
        section(definition) {
          sections.push(definition);
          return () => {
            const at = sections.indexOf(definition);
            if (at >= 0) sections.splice(at, 1);
          };
        },
      },
      tools: reg.view(id),
    },
  };
  return agent;
}

const messageText = (message) => (message?.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text ?? '')
  .join('');
const followupTexts = (agent) => agent.__followups.map(messageText);

/** 假 subagents 服务（spawn provider；startActivation 捕获 spec 并自动结算）。 */
function makeSubagents(options = {}) {
  const calls = [];
  const providers = options.providers ?? [{ name: 'spawn', inheritsParentContext: false, prepareContinuable: async () => ({}) }];
  const api = {
    __calls: calls,
    list: () => providers.map((provider) => provider.name),
    getProvider: (name) => providers.find((provider) => provider.name === name),
    resolveMaxDepth: () => options.maxDepth,
    async startActivation(spec) {
      calls.push(spec);
      const childId = typeof options.childId === 'function' ? options.childId(spec) : (options.childId ?? 'child-x');
      const reportText = typeof options.reportText === 'function' ? options.reportText(spec) : (options.reportText ?? '执行者报告：任务已完成。');
      const value = { output: [{ type: 'text', text: reportText }], stopReason: options.stopReason ?? 'completed' };
      const result = options.manual === true
        ? new Promise((resolve) => { api.__settle = (childIdArg, v) => { if (childIdArg === childId) resolve(v ?? value); }; })
        : Promise.resolve(value);
      return { childId, result, dispose: async () => { calls.push({ dispose: childId }); } };
    },
    interrupt(childId, authority) { calls.push({ interrupt: childId, authority }); },
    async sendMessage(sender, targetId, content, sendOptions) {
      calls.push({ sendMessage: targetId, content, sender: sender?.id, hasSignal: sendOptions?.signal !== undefined });
      return 'msg-1';
    },
  };
  return api;
}

/** 假 llm 服务：供 knownProviders / refreshCatalog / resolveModelInfo（思考强度支持面）。 */
function makeLlm(options = {}) {
  const efforts = options.efforts ?? { 'p1::m-a': ['low', 'medium', 'high'], 'p2::m-b': ['low'] };
  return {
    listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }],
    listModels: async (provider) => (provider === 'p1'
      ? [{ id: 'm-a', name: 'Model A' }, { id: 'm-unused', name: 'Model Unused' }]
      : [{ id: 'm-b', name: 'Model B' }]),
    resolveModelInfo: async (provider, model) => ({
      name: model,
      reasoning: { efforts: (efforts[`${provider}::${model}`] ?? []).map((id) => ({ id })) },
      context: { contextWindow: 200000 },
    }),
  };
}

function makeCtx({ agentsById, subagents, services = {}, reg }) {
  const routes = new Map();
  const provided = new Map();
  const handlers = new Map(); // name -> [handler]
  const logs = [];
  const webServer = {
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
  };
  const agentsApi = {
    get: (id) => agentsById.get(id),
    list: () => [...agentsById.values()],
    roots: () => [...agentsById.values()].filter((agent) => typeof agent.session.header.parentSession !== 'string'),
    withoutInitiator(fn) { return fn(); },
  };
  const ctx = {
    __routes: routes,
    __provided: provided,
    __handlers: handlers,
    __guards: reg.rootGuards,
    __logs: logs,
    __agentsById: agentsById,
    __agentOf: (id) => agentsById.get(id),
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      debug: (...args) => logs.push(['debug', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
      trace: (...args) => logs.push(['trace', args.join(' ')]),
    },
    effect(fn) { const returned = fn(); return typeof returned === 'function' ? returned : () => {}; },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {
        const list = handlers.get(name);
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      };
    },
    provide(key, value) { provided.set(key, value); },
    get(key) {
      if (key === 'agents') return agentsApi;
      if (key === 'tools') return reg.rootView;
      if (key === 'subagents') return subagents;
      if (key === 'webServer') return webServer;
      if (services[key] !== undefined) return services[key];
      if (provided.has(key)) return provided.get(key);
      return undefined;
    },
    agents: agentsApi,
    tools: reg.rootView,
    webServer,
  };
  ctx.__fire = (name, ...args) => Promise.all([...(handlers.get(name) ?? [])].map((handler) => handler(...args)));
  /** session/event 的派发口径与真实内核一致：(session, event)，且根监听器全局放行。 */
  ctx.__emitSession = (agent, event) => {
    for (const handler of [...(handlers.get('session/event') ?? [])]) handler(agent.session, event);
  };
  return ctx;
}

/** 起一个插件实例（跟宿主加载器一致：entry + cache-buster），并等懒路由注册完成。 */
async function startPlugin(spec) {
  const agentsById = spec.agentsById ?? new Map();
  const reg = makeToolRegistry(spec.tools ?? GLOBAL_TOOLS, spec.registryOptions ?? {});
  const ctx = makeCtx({ agentsById, subagents: spec.subagents, services: spec.services ?? {}, reg });
  ctx.__reg = reg;
  const { apply } = await loadPlugin();
  // ⚠ stateFile 是 row config 的字段（apply(ctx, config)），不是工装的外层参数——
  //   漏传会让插件落到默认 DSH_HOME/dual-agent.json，测试再读 sf('x') 就会 ENOENT。
  // v4.1：旧编排默认关（用户指令「不阻塞主会话」）。本套件测的是旧流水线（孵化/回传/
  // 挑刺者），所以默认打开 orchestrate；「默认值本身是关」另有专门断言覆盖。
  const config = { guidance: { orchestrate: true }, ...(spec.config ?? {}) };
  if (spec.stateFile !== undefined) config.stateFile = spec.stateFile;
  if (spec.autoArm !== undefined) config.autoArmForNewSessions = spec.autoArm;
  apply(ctx, config);
  await sleep(160); // 路由靠 100ms 轮询注册（whenWebServer）
  ctx.service = ctx.get('dualAgent');
  return ctx;
}

// ── 假 HTTP ─────────────────────────────────────────────────────────────────

function fakeReq(method, options = {}) {
  const text = options.rawText !== undefined ? options.rawText : json(options.body ?? {});
  const headers = { host: options.host ?? '127.0.0.1:1' };
  if (typeof options.origin === 'string') headers.origin = options.origin;
  return {
    method,
    headers,
    url: options.url ?? `/${method === 'GET' ? 'x' : 'x'}`,
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(text));
      if (event === 'end') listener();
    },
    destroy() {},
  };
}

function fakeRes() {
  const state = { status: 0, body: null, headersSent: false };
  return {
    state,
    writeHead(status, responseHeaders) { state.status = status; state.headers = responseHeaders; },
    end(text) { state.body = text; state.headersSent = true; },
  };
}

async function call(ctx, path, method = 'GET', options = {}) {
  const base = path.split('?')[0];
  const handler = ctx.__routes.get(base);
  if (handler === undefined) throw new Error(`no route ${base}`);
  const res = fakeRes();
  const req = fakeReq(method, { ...options, url: path });
  await Promise.resolve(handler(req, res)).catch((cause) => { console.log('ROUTE THREW:', cause); });
  return { status: res.state.status, json: res.state.body == null ? null : JSON.parse(res.state.body), raw: res.state.body };
}

// ── 人类消息与事件小件 ──────────────────────────────────────────────────────

const humanMessage = (text, seq = 0) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: {
    id: `u-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${seq}` },
  },
});

const emitHuman = (ctx, agent, text, seq = 0) => ctx.__emitSession(agent, humanMessage(text, seq));

/** 造一份带证据块的报告（claim 数组 → ⟦证据⟧ JSON ⟦/证据⟧）。 */
const reportWith = (claims, lead = '执行者报告：任务完成，共动 2 个文件。') =>
  `${lead}\n⟦证据⟧\n${json(claims)}\n⟦/证据⟧`;

// ── 真实磁盘上的证据文件 ────────────────────────────────────────────────────

const REAL_FILE = join(DIR, 'evidence-real.txt');
const MISSING_FILE = join(DIR, 'evidence-missing.txt');
writeFileSync(REAL_FILE, '第一行\nMARKER-XYZ 在这里\n第三行\n', 'utf8');
const sf = (name) => join(DIR, `${name}.json`);

// ══ A. 主智能只判断：tools.guard 按调用者身份精确拒绝 ══════════════════════════
{
  const stateFile = sf('a-enforce');
  const root = makeAgent('a-root', makeToolRegistry(GLOBAL_TOOLS)); // 占位 reg，下面重建
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('a-root', reg);
  const childAgent = makeAgent('a-child', reg, { parent: 'a-root' });
  const otherRoot = makeAgent('a-other', reg);
  const agentsById = new Map([['a-root', rootAgent], ['a-child', childAgent], ['a-other', otherRoot]]);
  void root;
  const subagents = makeSubagents({ reportText: 'x' });
  const ctx = await startPlugin({ stateFile, agentsById, subagents, services: { llm: makeLlm() } });
  const svc = ctx.service;
  const guard = ctx.__guards[0];

  check('A00 插件根作用域注册了 tools.guard', typeof guard === 'function' && ctx.__guards.length === 1,
    () => `guards=${ctx.__guards.length}`);

  await svc.transition('a-root', true); // 武装
  check('A01 武装后 root.pwsh 被拒（含 双智能指导 与 子代理）', (() => {
    const reason = guard({ agent: rootAgent, name: 'pwsh' });
    return typeof reason === 'string' && reason.includes('双智能指导') && reason.includes('子代理');
  })(), () => String(guard({ agent: rootAgent, name: 'pwsh' })).slice(0, 120));
  check('A02 root.subagent 放行（派活就是它该做的）', guard({ agent: rootAgent, name: 'subagent' }) === undefined);
  check('A03 子代理不受约束（child.pwsh 放行）', guard({ agent: childAgent, name: 'pwsh' }) === undefined);
  check('A03b 子代理即便同名会话也不被拦（exec/admin_exec/write）',
    ['admin_exec', 'write', 'edit', 'bash'].every((name) => guard({ agent: childAgent, name }) === undefined));

  svc.setSetting('mode', 'readonly');
  check('A04 readonly 模式放行 read', guard({ agent: rootAgent, name: 'read' }) === undefined);
  check('A04b readonly 模式仍拒 pwsh', typeof guard({ agent: rootAgent, name: 'pwsh' }) === 'string');
  check('A04c readonly 模式放行 grep/glob（回看已有内容）',
    guard({ agent: rootAgent, name: 'grep' }) === undefined && guard({ agent: rootAgent, name: 'glob' }) === undefined);
  svc.setSetting('mode', 'strict');
  check('A04d 回到 strict 后连 read 也拒', typeof guard({ agent: rootAgent, name: 'read' }) === 'string');

  svc.setSetting('extraAllowed', 'web_search');
  check('A05 extraAllowed 放行 web_search', guard({ agent: rootAgent, name: 'web_search' }) === undefined);
  svc.setSetting('extraAllowed', 'web_search, pwsh, write, admin_exec');
  check('A05b NEVER_ALLOW 写进 extraAllowed 也不放（pwsh/write/admin_exec）',
    ['pwsh', 'write', 'admin_exec'].every((name) => typeof guard({ agent: rootAgent, name }) === 'string'));
  check('A05c 同一条 extraAllowed 里的合法项仍然生效', guard({ agent: rootAgent, name: 'web_search' }) === undefined);
  check('A05d 不在允许面的工具名一律拒（未知名也是拒，保守默认）',
    typeof guard({ agent: rootAgent, name: 'totally_unknown_tool' }) === 'string');

  check('A08 武装期有 dual-guidance:enforce 行为段',
    rootAgent.__sections.some((section) => section.name === 'dual-guidance:enforce'),
    () => json(rootAgent.__sections.map((section) => section.name)));
  check('A08b 行为段正文带上证据协议',
    (() => {
      const section = rootAgent.__sections.find((item) => item.name === 'dual-guidance:enforce');
      return typeof section?.text === 'string' && section.text.includes('⟦证据⟧') && section.text.includes('程序核验');
    })());
  check('A08c 子代理身上没有本插件任何段（不该被执行者读到）',
    childAgent.__sections.length === 0, () => json(childAgent.__sections.map((s) => s.name)));

  const assemble = ctx.__handlers.get('system-prompt/assemble')?.[0];
  const sectionsFixture = () => ([
    { name: 'dual-agent:critic', text: 'c' },
    { name: 'dual-guidance:enforce', text: 'e' },
    { name: 'factory:x', text: 'f' },
  ]);
  check('A09a 装配瀑布存在', typeof assemble === 'function');
  const childAssembly = await assemble({ identity: 'x' }, { agent: childAgent }, async () => ({ sections: sectionsFixture() }));
  check('A09 子代理装配剥掉本插件段，只留 factory:x',
    Array.isArray(childAssembly?.sections) && childAssembly.sections.length === 1 && childAssembly.sections[0].name === 'factory:x',
    () => json(childAssembly?.sections?.map((s) => s.name)));
  const rootAssembly = await assemble({ identity: 'x' }, { agent: rootAgent }, async () => ({ sections: sectionsFixture() }));
  check('A09b 主会话装配三段全留', rootAssembly?.sections?.length === 3, () => json(rootAssembly?.sections?.map((s) => s.name)));
  const noAgentAssembly = await assemble({ identity: 'x' }, {}, async () => ({ sections: sectionsFixture() }));
  check('A09c 无 agent 上下文时不动任何段', noAgentAssembly?.sections?.length === 3);

  await svc.transition('a-root', false); // 解除武装
  check('A06 disarm 后 root 的任何工具都不再被拒',
    ['pwsh', 'write', 'admin_exec', 'read'].every((name) => guard({ agent: rootAgent, name }) === undefined));
  check('A06b disarm 后行为段被摘掉',
    !rootAgent.__sections.some((section) => section.name === 'dual-guidance:enforce'),
    () => json(rootAgent.__sections.map((s) => s.name)));
  check('A06c 解除后人格段也全清', rootAgent.__sections.length === 0,
    () => json(rootAgent.__sections.map((s) => s.name)));
  check('A07 从未武装的会话永不被拒（a-other.pwsh 放行）',
    guard({ agent: otherRoot, name: 'pwsh' }) === undefined);
  check('A07b 无 agent 身份的调用不拦（防御性放行）', guard({ name: 'pwsh' }) === undefined);

  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('A10 setSetting 落盘（settings.guidance.mode 回到 strict）',
    persisted.settings?.guidance?.mode === 'strict', () => json(persisted.settings?.guidance));
}

// ══ B. 子代理模型链：请求期改路由 / 回退 / 供应池 / 落盘 ════════════════════════
{
  const stateFile = sf('b-chain');
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('b-root', reg);
  const childAgent = makeAgent('b-child', reg, { parent: 'b-root' });
  const grand = makeAgent('b-grand', reg, { parent: 'b-child' });
  const agentsById = new Map([['b-root', rootAgent], ['b-child', childAgent], ['b-grand', grand]]);
  const ctx = await startPlugin({ stateFile, agentsById, subagents: makeSubagents(), services: { llm: makeLlm() } });
  const svc = ctx.service;
  const requestHandler = ctx.__handlers.get('agent/request')[0];
  const errorHandler = ctx.__handlers.get('agent/request-error')[0];
  const parentConfig = () => ({ provider: 'p0', model: 'm-root', temperature: 0.5 });

  const view = svc.chain.set('b-root', [
    { provider: 'p1', model: 'm-a', limit: { kind: 'requests', value: 1 } },
    { provider: 'p2', model: 'm-b' },
  ], { countTowardPool: true });
  check('B00 chain.set 返回两候选视图', view.configured === true && view.candidates.length === 2
    && view.activeIndex === 0 && view.candidates[0].used.requests === 0, () => json(view));

  await svc.transition('b-root', true);
  const swapped = await requestHandler({ agent: childAgent }, async () => parentConfig());
  check('B10 武装后子代理请求被改到 C1（p1/m-a）',
    swapped.provider === 'p1' && swapped.model === 'm-a' && swapped.temperature === 0.5, () => json(swapped));
  const rootOwn = await requestHandler({ agent: rootAgent }, async () => parentConfig());
  check('B10b 根会话自己的请求不改（只有子代理走链）',
    rootOwn.provider === 'p0' && rootOwn.model === 'm-root', () => json(rootOwn));
  const nested = await requestHandler({ agent: grand }, async () => parentConfig());
  check('B10c 嵌套孙代理沿血缘上溯到根，同样命中链',
    nested.provider === 'p1' && nested.model === 'm-a', () => json(nested));

  await svc.transition('b-root', false);
  const notSwapped = await requestHandler({ agent: childAgent }, async () => parentConfig());
  check('B11 总开关关掉时子代理请求不改路由（master switch 门住链）',
    notSwapped.provider === 'p0' && notSwapped.model === 'm-root', () => json(notSwapped));
  await svc.transition('b-root', true);
  const swappedAgain = await requestHandler({ agent: childAgent }, async () => parentConfig());
  check('B11b 重新武装后链又生效', swappedAgain.provider === 'p1' && swappedAgain.model === 'm-a');

  const forwarded = await errorHandler({ agent: childAgent }, async () => ({ kind: 'forward' }));
  check('B12 请求失败 → {kind:"retry"}（换下一候选）', forwarded?.kind === 'retry', () => json(forwarded));
  const afterFallback = await requestHandler({ agent: childAgent }, async () => parentConfig());
  check('B12b 回退后下一个请求走 C2（p2/m-b）',
    afterFallback.provider === 'p2' && afterFallback.model === 'm-b', () => json(afterFallback));
  const viewAfterFail = svc.chain.view('b-root');
  check('B12c 视图把 C1 标成已失败、当前指针到 C2',
    viewAfterFail.candidates[0].failed === true && viewAfterFail.activeIndex === 1, () => json(viewAfterFail));
  const rootError = await errorHandler({ agent: rootAgent }, async () => ({ kind: 'forward' }));
  check('B12d 根会话自己失败不触发链回退', rootError?.kind === 'forward', () => json(rootError));
  const abortedError = await errorHandler({ agent: childAgent, signal: { aborted: true } }, async () => ({ kind: 'forward' }));
  check('B12e 已被 abort 的请求不做回退（原样交给 next）', abortedError?.kind === 'forward');

  // 计量：llm/stream 记账（成功 finish 记 1 个请求）
  const streamHandler = ctx.__handlers.get('llm/stream')[0];
  check('B12f 装了 llm/stream 记账器', typeof streamHandler === 'function');
  const chunks = [{ type: 'text', text: 'hi' }, { type: 'usage', usage: { totalTokens: 1234 } }, { type: 'finish', reason: { kind: 'completed' } }];
  const collected = [];
  for await (const chunk of streamHandler({ sessionId: 'b-child', provider: 'p2', model: 'm-b' }, () => chunks)) collected.push(chunk);
  const viewCharged = svc.chain.view('b-root');
  check('B12g llm/stream 给实际服务的候选记账（C2 requests=1、tokens=1234）',
    viewCharged.candidates[1].used.requests === 1 && viewCharged.candidates[1].used.tokens === 1234,
    () => json(viewCharged.candidates.map((candidate) => candidate.used)));
  check('B12h 记账不吞流（原样透传全部 chunk）', collected.length === chunks.length);
  const auxView = svc.chain.view('b-root');
  const auxBefore = auxView.candidates[1].used.requests;
  for await (const chunk of streamHandler({ sessionId: 'b-child', provider: 'p2', model: 'm-b', purpose: 'title' }, () => chunks)) void chunk;
  check('B12i 辅助调用默认不计入链（countAuxiliary 关）', svc.chain.view('b-root').candidates[1].used.requests === auxBefore);

  // 供应池重定向
  const subagentModels = ctx.__provided.get('subagentModels');
  check('B13 ctx.provide("subagentModels") 在场（dsh-model-pool 的联动键）',
    subagentModels !== undefined && typeof subagentModels.billingRedirect === 'function');
  const redirect = subagentModels.billingRedirect('b-child');
  check('B13b countTowardPool=true → 回 {rootSessionId}',
    redirect !== undefined && Object.keys(redirect).length === 1 && redirect.rootSessionId === 'b-root', () => json(redirect));
  const redirectRoot = subagentModels.billingRedirect('b-root');
  check('B13c 根会话自己没有重定向（它本来就是根）', redirectRoot === undefined, () => json(redirectRoot));

  // 思考强度：换路由时先问 resolveModelInfo，支持才带
  {
    const reg2 = makeToolRegistry(GLOBAL_TOOLS);
    const root2 = makeAgent('b-eff', reg2);
    const child2 = makeAgent('b-eff-child', reg2, { parent: 'b-eff' });
    const ctx2 = await startPlugin({ stateFile: sf('b-eff'), agentsById: new Map([['b-eff', root2], ['b-eff-child', child2]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const request2 = ctx2.__handlers.get('agent/request')[0];
    await ctx2.service.transition('b-eff', true);
    ctx2.service.chain.set('b-eff', [{ provider: 'p1', model: 'm-a' }, { provider: 'p2', model: 'm-b' }]);
    const kept = await request2({ agent: child2 }, async () => ({ provider: 'p0', model: 'm-root', reasoningEffort: 'high' }));
    check('B14a 目标模型支持该思考强度 → effort 保留',
      kept.provider === 'p1' && kept.reasoningEffort === 'high', () => json(kept));
    const same = await request2({ agent: child2 }, async () => ({ provider: 'p1', model: 'm-a', reasoningEffort: 'high' }));
    check('B14b 同路由且原样能跑 → 原配置对象直接返回（不多事）',
      same.provider === 'p1' && same.model === 'm-a' && same.reasoningEffort === 'high');
    // 把 C1 的请求额度打满（adjust 支持手工修 used 计数；limit 本身必须是正整数）。
    ctx2.service.chain.adjust('b-eff', { index: 0, used: { requests: 99 } });
    const failed = await ctx2.__handlers.get('agent/request-error')[0]({ agent: child2 }, async () => ({ kind: 'forward' }));
    const dropped = await request2({ agent: child2 }, async () => ({ provider: 'p0', model: 'm-root', reasoningEffort: 'high' }));
    check('B14c 回退到不支持的候选时丢掉 effort（不撞 UNSUPPORTED_*）',
      failed?.kind === 'retry' && dropped.provider === 'p2' && dropped.reasoningEffort === undefined, () => json(dropped));
  }

  // 落盘形状：只有候选与限额，没有计数
  {
    const fresh = JSON.parse(readFileSync(stateFile, 'utf8'));
    const record = (fresh.chains ?? []).find((entry) => entry.sessionId === 'b-root');
    check('B14 落盘 chains 里有候选与限额',
      Array.isArray(fresh.chains) && record !== undefined && record.candidates.length === 2
      && record.candidates[0].limit?.kind === 'requests' && record.candidates[0].limit?.value === 1
      && record.countTowardPool === true, () => json(fresh.chains));
    check('B14d 落盘里没有任何 used 计数（重启归零才诚实）',
      JSON.stringify(fresh.chains).includes('"used"') === false, () => json(fresh.chains));
    const reloaded = await startPlugin({ stateFile, agentsById: new Map([['b-root', makeAgent('b-root', makeToolRegistry(GLOBAL_TOOLS))]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const restored = reloaded.service.chain.view('b-root');
    check('B14e 新实例读回链：候选在、计数归零、池开关注入',
      restored.configured === true && restored.candidates.length === 2
      && restored.candidates[0].used.requests === 0 && restored.candidates[0].used.tokens === 0
      && restored.countTowardPool === true, () => json(restored));
  }
}

// ══ C. 孵化执行者带上选定模型（官方 agentOptions）+ 证据协议 ════════════════════
{
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('c-root', reg);
  const agentsById = new Map([['c-root', rootAgent]]);
  const subagents = makeSubagents({ childId: 'c-child', reportText: '执行者报告：改完了。' });
  const ctx = await startPlugin({ stateFile: sf('c-hatch'), agentsById, subagents, services: { llm: makeLlm() } });
  const svc = ctx.service;
  await svc.transition('c-root', true);
  svc.chain.set('c-root', [{ provider: 'p1', model: 'm-a' }]);
  emitHuman(ctx, rootAgent, '把 X 改掉', 0);
  await sleep(40);
  const spec = subagents.__calls.find((entry) => entry.provider !== undefined);
  check('C15a 用户消息孵化了执行者（spawn provider）', spec !== undefined && spec.provider === 'spawn', () => json(subagents.__calls.map((c) => Object.keys(c))));
  check('C15 孵化带上选定的 agentOptions {p1,m-a}',
    spec?.request?.agentOptions?.provider === 'p1' && spec.request.agentOptions.model === 'm-a'
    && Object.keys(spec.request.agentOptions).length === 2, () => json(spec?.request?.agentOptions));
  check('C15b delivery=caller（结算不自动唤醒主 Agent）', spec?.delivery === 'caller');
  check('C15c label 与 parent 正确', spec?.label === '双智能指导·执行者' && spec?.request?.parent === rootAgent);
  check('C15d resolveMaxDepth 回 undefined 时不加 maxDepth 字段',
    spec?.request?.maxDepth === undefined, () => json(Object.keys(spec?.request ?? {})));
  check('C15e 任务正文原样带上用户消息', String(spec?.request?.prompt?.[0]?.text ?? '').includes('把 X 改掉'));
  // ⚠ prompt 是**扁平块**数组（{type:'text', text}），不是 message（{content:[...]}），
  //   别用 messageText() 取——那会永远读成空串（这里踩过）。
  const tailText = String(spec?.request?.prompt?.at(-1)?.text ?? '');
  check('C16 核验开着时任务尾附证据协议（⟦证据⟧）',
    tailText.includes('⟦证据⟧') && tailText.includes('session_tool'), () => tailText.slice(0, 120));
  const statusAfter = svc.status('c-root');
  check('C16b 结算后回到 armed 且评估注入恰一条',
    statusAfter.phase === 'armed' && rootAgent.__followups.length === 1,
    () => `phase=${statusAfter.phase} followups=${rootAgent.__followups.length}`);
}
{
  // 没配链 → 一个字段都不加（行为与合并前一致：继承父会话模型）
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('c2-root', reg);
  const subagents = makeSubagents({ childId: 'c2-child' });
  const ctx = await startPlugin({ stateFile: sf('c-nochain'), agentsById: new Map([['c2-root', rootAgent]]), subagents, services: { llm: makeLlm() } });
  await ctx.service.transition('c2-root', true);
  emitHuman(ctx, rootAgent, '随便做点啥', 0);
  await sleep(40);
  const spec = subagents.__calls.find((entry) => entry.provider !== undefined);
  check('C15f 未配链时 request 里没有 agentOptions 字段',
    spec !== undefined && spec.request.agentOptions === undefined
    && 'agentOptions' in spec.request === false, () => json(Object.keys(spec?.request ?? {})));
}
{
  // applyChain=false（二级菜单关掉「子代理走这条链」）→ 同样不加
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('c3-root', reg);
  const subagents = makeSubagents({ childId: 'c3-child' });
  const ctx = await startPlugin({ stateFile: sf('c-applyoff'), agentsById: new Map([['c3-root', rootAgent]]), subagents, services: { llm: makeLlm() } });
  await ctx.service.transition('c3-root', true);
  ctx.service.chain.set('c3-root', [{ provider: 'p1', model: 'm-a' }]);
  ctx.service.setSetting('applyChain', false);
  emitHuman(ctx, rootAgent, '关掉走链再试', 0);
  await sleep(40);
  const spec = subagents.__calls.find((entry) => entry.provider !== undefined);
  check('C15g applyChain=false 时不加 agentOptions（门关住）', spec?.request?.agentOptions === undefined,
    () => json(spec?.request?.agentOptions));
  const childRequest = await ctx.__handlers.get('agent/request')[0]({ agent: rootAgent }, async () => ({ provider: 'p0', model: 'm-root' }));
  check('C15h applyChain=false 时请求期也不改路由', childRequest.provider === 'p0');
}
{
  // verify.enabled=false → 任务尾不带证据协议
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('c4-root', reg);
  const subagents = makeSubagents({ childId: 'c4-child' });
  const ctx = await startPlugin({
    stateFile: sf('c-verifyoff'),
    agentsById: new Map([['c4-root', rootAgent]]),
    subagents,
    services: { llm: makeLlm() },
    config: { verify: { enabled: false } },
  });
  await ctx.service.transition('c4-root', true);
  emitHuman(ctx, rootAgent, '核验关掉的任务', 0);
  await sleep(40);
  const spec = subagents.__calls.find((entry) => entry.provider !== undefined);
  const tail = spec?.request?.prompt?.at(-1)?.text ?? '';
  check('C16c verify.enabled=false 时任务尾不含 ⟦证据⟧', tail !== '' && !tail.includes('⟦证据⟧'), () => tail.slice(0, 120));
  check('C16d 但收尾报告要求仍在（自足报告）', tail.includes('收尾消息'));
  const settleTexts = followupTexts(rootAgent);
  check('C16e 核验关着时评估消息里没有【程序核验】块',
    settleTexts.length === 1 && !settleTexts[0].includes('【程序核验】'), () => json(settleTexts.map((t) => t.slice(0, 60))));
}

// ══ C2. 默认口径（v4.1）：旧编排关着 → 人类消息不接管、不阻塞 ═══════════════
{
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('c2-root', reg);
  const agentsById = new Map([['c2-root', rootAgent]]);
  const subagents = makeSubagents({ childId: 'c2-child', reportText: '不该出现的执行者报告。' });
  const ctx = await startPlugin({
    stateFile: sf('c2-default'),
    agentsById,
    subagents,
    services: { llm: makeLlm() },
    config: { guidance: { orchestrate: false } },
  });
  const svc = ctx.service;
  check('C2a 默认 settingsView.orchestrate = false', svc.settings().orchestrate === false, () => json(svc.settings()));
  const items = (await svc.menu.spec('c2-root')).items;
  const orchestrateItem = items.find((item) => item.id === 'orchestrate');
  check('C2b 二级菜单里有 orchestrate 开关且默认关', orchestrateItem?.kind === 'switch' && orchestrateItem.value === false,
    () => json(orchestrateItem));
  await svc.transition('c2-root', true);
  emitHuman(ctx, rootAgent, '把 Y 改掉', 0);
  await sleep(60);
  check('C2c 武装 + 旧编排关：**不**孵化执行者', subagents.__calls.every((entry) => entry.provider === undefined),
    () => json(subagents.__calls.map((c) => Object.keys(c))));
  check('C2d 主回合**没有**被 cancel（不阻塞主会话）', rootAgent.__cancels.length === 0,
    () => json(rootAgent.__cancels));
  check('C2e 仍保持 armed（开关开着=已启用，但没有后台执行者）', svc.status('c2-root').phase === 'armed',
    () => String(svc.status('c2-root').phase));
  // 约束仍然生效：受限工具被拒（旧编排开关与约束是两件事，别互相串）。
  const guard = ctx.__guards[0];
  check('C2f 旧编排关着，主智能的受限工具仍被拒绝',
    typeof guard({ agent: rootAgent, name: 'pwsh' }) === 'string'
    && guard({ agent: rootAgent, name: 'subagent' }) === undefined,
    () => json({ pwsh: typeof guard({ agent: rootAgent, name: 'pwsh' }) }));
  // 打开它 → 立刻恢复旧行为（切换不需要重启）。
  svc.setSetting('orchestrate', true);
  check('C2g setSetting(orchestrate,true) 落到 settings', svc.settings().orchestrate === true);
  await svc.transition('c2-root', false);
}

// ══ D. 出处程序核验端到端 ═════════════════════════════════════════════════════
{
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('d-root', reg, { cwd: DIR });
  const childAgent = makeAgent('d-child', reg, { parent: 'd-root', cwd: DIR });
  // 子代理会话日志：真实存在的一次 pwsh 调用与结果（session_tool 的证据来源）
  childAgent.__append({ type: 'tool/call', data: { callId: 'sc-1', name: 'pwsh', arguments: '{"command":"ls -la"}' } });
  childAgent.__append({ type: 'tool/result', data: { message: { toolCallId: 'sc-1', content: [{ type: 'text', text: 'total 42\nMARKER-XYZ' }] } } });
  const reportText = reportWith([
    { claim: '改动落在 evidence-real.txt', check: { kind: 'file_contains', path: REAL_FILE, needle: 'MARKER-XYZ' } },
    { claim: '还新增了 evidence-missing.txt', check: { kind: 'file_exists', path: MISSING_FILE } },
  ]);
  const subagents = makeSubagents({ childId: 'd-child', reportText });
  const agentsById = new Map([['d-root', rootAgent], ['d-child', childAgent]]);
  const ctx = await startPlugin({ stateFile: sf('d-verify'), agentsById, subagents, services: { llm: makeLlm() } });
  await ctx.service.transition('d-root', true);
  emitHuman(ctx, rootAgent, '把 X 改掉并给出出处', 0);
  await sleep(60);
  const texts = followupTexts(rootAgent);
  check('D17a 结算只注入恰一条消息', texts.length === 1, () => json(texts.map((t) => t.slice(0, 40))));
  const critic = texts[0] ?? '';
  check('D17 注入以【挑刺者评估】开头（harness 契约）', critic.startsWith('【挑刺者评估】'), () => critic.slice(0, 40));
  check('D17b 同一条消息里带报告原文', critic.includes('evidence-missing.txt') && critic.includes('⟦执行者报告 开始⟧'));
  check('D17c 同一条消息里带【程序核验】块', critic.includes('【程序核验】'));
  check('D17d 核验块逐条标出 [通过] 与 [不符]', critic.includes('[通过]') && critic.includes('[不符]'), () => critic.slice(critic.indexOf('【程序核验】'), critic.indexOf('【程序核验】') + 400));
  check('D17e 核验块给出汇总数字',
    critic.includes('确定性检查 2 条') && critic.includes('通过 1') && critic.includes('不符 1') && critic.includes('无法核验 0'),
    () => (critic.match(/确定性检查[^\n]*/) ?? ['(无)'])[0]);
  check('D17f 不符项被点名（不是含糊带过）', critic.includes('evidence-missing.txt') && critic.includes('不存在'),
    () => (critic.match(/\[不符\][^\n]*/) ?? ['(无)'])[0]);
  check('D17g 核验块声明「不含模型判断」（诚实口径）', critic.includes('不含模型判断'));
  check('D17h 评估指令要求把「不符」当硬伤', critic.includes('当作硬伤'));
  check('D17i status.verify.last 透出实况', (() => {
    const last = ctx.service.status('d-root').verify?.last;
    return last !== undefined && last !== null && last.fail === 1 && last.pass === 1;
  })(), () => json(ctx.service.status('d-root').verify));
}
{
  // 报告没给证据块：明说无出处，绝不假装核过
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('d2-root', reg, { cwd: DIR });
  const subagents = makeSubagents({ childId: 'd2-child', reportText: '执行者报告：全部搞定，功能正确无误。' });
  const ctx = await startPlugin({ stateFile: sf('d-norev'), agentsById: new Map([['d2-root', rootAgent]]), subagents, services: { llm: makeLlm() } });
  await ctx.service.transition('d2-root', true);
  emitHuman(ctx, rootAgent, '干一票', 0);
  await sleep(60);
  const texts = followupTexts(rootAgent);
  check('D18a 无证据块的报告仍只注入一条', texts.length === 1, () => `n=${texts.length}`);
  check('D18 注入明说报告没带证据块',
    texts[0] !== undefined && (texts[0].includes('未带证据块') || texts[0].includes('没有可核对')),
    () => texts[0]?.slice(texts[0].indexOf('【程序核验】'), texts[0].indexOf('【程序核验】') + 300));
  check('D18b 不假装核验通过（没有 [通过] 标记）', !String(texts[0]).includes('[通过]'));
  check('D18c 汇总如实写 0 条', String(texts[0]).includes('确定性检查 0 条'),
    () => (String(texts[0]).match(/确定性检查[^\n]*/) ?? ['(无)'])[0]);
}
{
  // 主智能自己用 subagent 工具派的活：tool/result 旁路核验 + callId 去重
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('d3-root', reg, { cwd: DIR });
  const childAgent = makeAgent('d3-child', reg, { parent: 'd3-root', cwd: DIR });
  childAgent.__append({ type: 'tool/call', data: { callId: 'sc-9', name: 'pwsh', arguments: '{"command":"cat notes.txt"}' } });
  childAgent.__append({ type: 'tool/result', data: { message: { toolCallId: 'sc-9', content: [{ type: 'text', text: 'MARKER-XYZ in notes' }] } } });
  const agentsById = new Map([['d3-root', rootAgent], ['d3-child', childAgent]]);
  const ctx = await startPlugin({ stateFile: sf('d-deleg'), agentsById, subagents: makeSubagents(), services: { llm: makeLlm() } });
  await ctx.service.transition('d3-root', true);

  const callEvent = rootAgent.__append({ type: 'tool/call', data: { callId: 'dc1', name: 'subagent', arguments: '{"description":"查"}' }, time: Date.now() - 5 });
  const resultMessage = {
    role: 'user',
    toolCallId: 'dc1',
    content: [{ type: 'text', text: reportWith([
      { claim: '真实文件里有 needle', check: { kind: 'file_contains', path: REAL_FILE, needle: 'MARKER-XYZ' } },
      { claim: '我跑过 cat notes.txt', check: { kind: 'session_tool', tool: 'pwsh', argumentContains: 'cat notes', resultContains: 'MARKER-XYZ' } },
      { claim: '新增了 ghost.txt', check: { kind: 'file_exists', path: MISSING_FILE } },
    ], '子代理回报：三处出处。') }],
    source: { kind: 'tool' },
  };
  const resultEvent = rootAgent.__append({ type: 'tool/result', data: { message: resultMessage } });
  ctx.__emitSession(rootAgent, callEvent);
  ctx.__emitSession(rootAgent, resultEvent);
  await sleep(60);
  const texts = followupTexts(rootAgent);
  check('D19a 旁路核验注入恰一条', texts.length === 1, () => json(texts.map((t) => t.slice(0, 40))));
  check('D19 注入以【程序核验·子代理回报】开头', String(texts[0]).startsWith('【程序核验·子代理回报】'), () => String(texts[0]).slice(0, 60));
  check('D19b 逐条核对了 session_tool 出处（会话日志比对）',
    String(texts[0]).includes('[通过]') && /确实调用 pwsh/.test(String(texts[0])),
    () => (String(texts[0]).match(/- \[通过\] session_tool[^\n]*/) ?? ['(无)'])[0]);
  check('D19c 汇总 3 条：通过 2 · 不符 1',
    String(texts[0]).includes('确定性检查 3 条') && String(texts[0]).includes('通过 2') && String(texts[0]).includes('不符 1'),
    () => (String(texts[0]).match(/确定性检查[^\n]*/) ?? ['(无)'])[0]);
  // 同一 callId 重放不得二次注入
  rootAgent.__followups.length = 0;
  ctx.__emitSession(rootAgent, resultEvent);
  await sleep(40);
  check('D19d 同 callId 重放不重复注入（去重）', followupTexts(rootAgent).length === 0,
    () => `n=${followupTexts(rootAgent).length}`);

  // 非派活工具的结果不核
  const pwshCall = rootAgent.__append({ type: 'tool/call', data: { callId: 'dc2', name: 'pwsh', arguments: '{}' } });
  const pwshResult = rootAgent.__append({ type: 'tool/result', data: { message: { toolCallId: 'dc2', content: [{ type: 'text', text: reportWith([{ claim: 'x', check: { kind: 'file_exists', path: REAL_FILE } }], '普通命令输出') }] } } });
  ctx.__emitSession(rootAgent, pwshCall);
  ctx.__emitSession(rootAgent, pwshResult);
  await sleep(40);
  check('D20 非派活工具（pwsh）的结果不触发核验注入', followupTexts(rootAgent).length === 0,
    () => json(followupTexts(rootAgent).map((t) => t.slice(0, 40))));

  // delegation 关掉后连派活工具的结果也不旁路核
  ctx.service.setSetting('verify.delegation', false);
  const call3 = rootAgent.__append({ type: 'tool/call', data: { callId: 'dc3', name: 'subagent', arguments: '{}' } });
  const result3 = rootAgent.__append({ type: 'tool/result', data: { message: { toolCallId: 'dc3', content: [{ type: 'text', text: reportWith([{ claim: 'x', check: { kind: 'file_exists', path: REAL_FILE } }], '再来一次') }] } } });
  ctx.__emitSession(rootAgent, call3);
  ctx.__emitSession(rootAgent, result3);
  await sleep(40);
  check('D20b verify.delegation=false 时旁路关（一条不投）', followupTexts(rootAgent).length === 0);
  ctx.service.setSetting('verify.delegation', true);

  // 未武装的会话不旁路
  const bystander = makeAgent('d3-other', reg, { cwd: DIR });
  agentsById.set(bystander.id, bystander);
  const otherCall = bystander.__append({ type: 'tool/call', data: { callId: 'dc4', name: 'subagent', arguments: '{}' } });
  const otherResult = bystander.__append({ type: 'tool/result', data: { message: { toolCallId: 'dc4', content: [{ type: 'text', text: reportWith([{ claim: 'x', check: { kind: 'file_exists', path: REAL_FILE } }], '别人的会话') }] } } });
  ctx.__emitSession(bystander, otherCall);
  ctx.__emitSession(bystander, otherResult);
  await sleep(40);
  check('D20c 未武装会话的子代理回报不核（总开关门住旁路）', bystander.__followups.length === 0);
}
{
  // 核验器的诚实边界：不支持的 kind / command 拒跑 / 超上限
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('d4-root', reg, { cwd: DIR });
  const ctx = await startPlugin({ stateFile: sf('d-verify-kinds'), agentsById: new Map([['d4-root', rootAgent]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
  const svc = ctx.service;
  await svc.transition('d4-root', true);
  const verdict = await svc.verify.run('d4-root', reportWith([
    { claim: '我跑过命令', check: { kind: 'command', command: 'del C:\\*' } },
    { claim: '某种没实现的核法', check: { kind: 'quantum_read' } },
    { claim: '数字可重算', check: { kind: 'number', a: 2, b: 3, op: '==' } },
    { claim: '联网出处', check: { kind: 'url', url: 'https://example.com' } },
  ], '一份混合出处'));
  check('D21a command 类不重跑（标无法核验）',
    verdict.text.includes('[无法核验]') && verdict.text.includes('不重跑子代理声称的命令'),
    () => (verdict.text.match(/- \[无法核验\] command[^\n]*/) ?? ['(无)'])[0]);
  check('D21b 不支持的 kind 如实说「不支持的核验类型」，不静默放过',
    verdict.text.includes('不支持的核验类型'));
  check('D21c 算术类真跑（2==3 → 不符）', verdict.summary.fail === 1 && verdict.text.includes('[不符] number'));
  check('D21d url 类默认不联网（未开启联网核验 → 无法核验）',
    verdict.text.includes('未开启联网核验') && verdict.summary.unverifiable === 3, () => json(verdict.summary));
  check('D21e 汇总口径：4 条里通过 0', verdict.summary.total === 4 && verdict.summary.pass === 0, () => json(verdict.summary));
  const many = reportWith(Array.from({ length: 45 }, (unused, index) => ({ claim: `第 ${index + 1} 条`, check: { kind: 'number', a: 1, b: 1, op: '==' } })), '多声称报告');
  const capped = await svc.verify.run('d4-root', many);
  check('D21f maxClaims 生效：只核前 40 条并如实说明超出',
    capped.summary.total === 45 && capped.summary.pass === 40 && capped.summary.dropped === 5, () => json(capped.summary));
  check('D21g 超出部分写进正文（不假装核完）', capped.text.includes('条上限的声称未核对'),
    () => (capped.text.match(/超出[^\n]*/) ?? ['(无)'])[0]);
}

// ══ E. 工作箱二级菜单路由 ═════════════════════════════════════════════════════
const MENU_KINDS = ['note', 'heading', 'switch', 'select', 'text', 'rows', 'form', 'buttons'];
{
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const rootAgent = makeAgent('e-root', reg, { cwd: DIR });
  const agentsById = new Map([['e-root', rootAgent]]);
  const ctx = await startPlugin({ stateFile: sf('e-menu'), agentsById, subagents: makeSubagents(), services: { llm: makeLlm() } });
  const guard = ctx.__guards[0];
  await ctx.service.transition('e-root', true);

  check('E00 三条路由都挂上了（懒注册）',
    ctx.__routes.has('/dsh-dual-agent/status') && ctx.__routes.has('/dsh-dual-agent/action') && ctx.__routes.has('/dsh-dual-agent/menu'),
    () => json([...ctx.__routes.keys()]));

  const specRes = await call(ctx, `/dsh-dual-agent/menu?sessionId=e-root`, 'GET');
  check('E21a GET /menu 200', specRes.status === 200 && specRes.json?.title === '双智能指导', () => `status=${specRes.status}`);
  const items = specRes.json?.items ?? [];
  check('E21 items[] 非空且 kind 全在允许集内',
    Array.isArray(items) && items.length > 6 && items.every((item) => MENU_KINDS.includes(item.kind)),
    () => json([...new Set(items.map((item) => item.kind))]));
  check('E21b spec 带四个区的落点（约束/链/核验/开关）',
    ['enforce', 'mode', 'applyChain', 'verify.enabled', 'hideMainTools', 'extraAllowed'].every((id) => items.some((item) => item.id === id)),
    () => json(items.map((item) => item.id ?? item.kind)));
  check('E21c 菜单里的模式 select 当前值 = strict',
    items.find((item) => item.id === 'mode')?.value === 'strict');
  check('E21d phase 透出（armed）', specRes.json?.phase === 'armed', () => String(specRes.json?.phase));

  const noSession = await call(ctx, '/dsh-dual-agent/menu', 'GET');
  check('E21e 缺 sessionId → 400', noSession.status === 400 && typeof noSession.json?.error === 'string', () => json(noSession.json));

  const rowsCount = () => {
    const spec = ctx.service.menu.spec('e-root');
    return spec;
  };
  void rowsCount;
  const before = items.find((item) => item.kind === 'rows');
  const beforeRows = (before?.rows ?? []).length;
  const addRes = await call(ctx, '/dsh-dual-agent/menu', 'POST', {
    body: { sessionId: 'e-root', op: 'add-candidate', fields: { route: 'p1::m-a', limitKind: 'requests', limitValue: '5' } },
  });
  const afterRows = (addRes.json?.items?.find((item) => item.kind === 'rows')?.rows ?? []);
  check('E22a POST add-candidate → 200', addRes.status === 200, () => json(addRes.json?.error ?? addRes.status));
  check('E22b rows 项多了一个候选（且标题带 p1/m-a 与 5 次限额）',
    afterRows.length === beforeRows + 1
    && String(afterRows.at(-1)?.title).includes('p1') && String(afterRows.at(-1)?.title).includes('m-a')
    && String(afterRows.at(-1)?.subtitle).includes('5'),
    () => json(afterRows.map((row) => [row.title, row.subtitle])));
  check('E22c 候选同时落到链服务面', ctx.service.chain.view('e-root').candidates.length === beforeRows + 1,
    () => json(ctx.service.chain.view('e-root').candidates));

  const badOp = await call(ctx, '/dsh-dual-agent/menu', 'POST', { body: { sessionId: 'e-root', op: 'drop-everything' } });
  check('E22d 未知 op → 400 + error 字符串', badOp.status === 400 && typeof badOp.json?.error === 'string', () => json(badOp.json));
  const badAdd = await call(ctx, '/dsh-dual-agent/menu', 'POST', { body: { sessionId: 'e-root', op: 'add-candidate', fields: { route: 'nosuchprovider::m-x', limitKind: 'requests', limitValue: '0' } } });
  check('E22e 非法候选（provider 未注册/额度非正）→ 400 而不是半落库', badAdd.status === 400, () => json(badAdd.json));
  check('E22f 非法 op 没有污染链', ctx.service.chain.view('e-root').candidates.length === beforeRows + 1);

  const cross = await call(ctx, '/dsh-dual-agent/menu', 'POST', { body: { sessionId: 'e-root', op: 'refresh' }, origin: 'http://evil.example' });
  check('E22g 跨站 POST /menu → 403', cross.status === 403 && typeof cross.json?.error === 'string', () => `status=${cross.status}`);
  const crossGet = await call(ctx, `/dsh-dual-agent/menu?sessionId=e-root`, 'GET', { origin: 'http://evil.example' });
  check('E22h GET /menu 是只读的，跨站不拦（403 只针对写）', crossGet.status === 200, () => `status=${crossGet.status}`);
  const badBody = await call(ctx, '/dsh-dual-agent/menu', 'POST', { rawText: 'not json at all {' });
  check('E22i 非 JSON 请求体 → 400', badBody.status === 400 && typeof badBody.json?.error === 'string', () => json(badBody.json));

  check('E23a 二级菜单改约束前：read 被拒（strict）', typeof guard({ agent: rootAgent, name: 'read' }) === 'string');
  const setRes = await call(ctx, '/dsh-dual-agent/menu', 'POST', { body: { sessionId: 'e-root', op: 'set', id: 'mode', value: 'readonly' } });
  check('E23 POST set mode=readonly → 200', setRes.status === 200 && setRes.json?.items?.find((item) => item.id === 'mode')?.value === 'readonly',
    () => `status=${setRes.status}`);
  check('E23b 端到端：菜单改完，guard 立刻跟着变（read 放行）', guard({ agent: rootAgent, name: 'read' }) === undefined);
  check('E23c 且 pwsh 仍拒（改的是力度不是开关）', typeof guard({ agent: rootAgent, name: 'pwsh' }) === 'string');
  const setUnknown = await call(ctx, '/dsh-dual-agent/menu', 'POST', { body: { sessionId: 'e-root', op: 'set', id: 'no_such_setting', value: 1 } });
  check('E23d 不认识的设置项 → 400（不盲写）', setUnknown.status === 400, () => json(setUnknown.json));
  const persistAfterSet = JSON.parse(readFileSync(sf('e-menu'), 'utf8'));
  check('E23e 菜单改的设置落盘', persistAfterSet.settings?.guidance?.mode === 'readonly', () => json(persistAfterSet.settings?.guidance));

  const actionCross = await call(ctx, '/dsh-dual-agent/action', 'POST', { body: { sessionId: 'e-root', enabled: false }, origin: 'http://evil.example' });
  check('E24 跨站 POST /action → 403', actionCross.status === 403, () => `status=${actionCross.status} ${json(actionCross.json)}`);
  const actionBad = await call(ctx, '/dsh-dual-agent/action', 'POST', { rawText: '{oops' });
  check('E24b /action 非 JSON → 400', actionBad.status === 400);
  const offline = await call(ctx, '/dsh-dual-agent/action', 'POST', { body: { sessionId: 'no-such-session', enabled: true } });
  check('E24c 会话不在线 → 409', offline.status === 409, () => json(offline.json));
  const statusRes = await call(ctx, '/dsh-dual-agent/status?sessionId=e-root', 'GET');
  check('E24d GET /status 200 且带 v4 三块实况', (() => {
    const body = statusRes.json ?? {};
    return statusRes.status === 200 && body.phase === 'armed' && body.build === '4.1.0+family'
      && body.guidance?.label === '双智能指导' && body.guidance.mode === 'readonly'
      && body.models?.chain?.configured === true && body.verify?.enabled === true && body.menu?.route === '/dsh-dual-agent/menu';
  })(), () => String(json({ status: statusRes.status, ...(statusRes.json ?? {}) })).slice(0, 300));
  const wrongMethod = await call(ctx, '/dsh-dual-agent/status', 'POST');
  check('E24e /status 只读（POST → 405）', wrongMethod.status === 405);
}

// ══ F. 状态/配置兼容与装配细节 ═════════════════════════════════════════════════
{
  // 旧 v2 落盘文件：不崩，字段补齐
  const legacy = sf('f-legacy');
  writeFileSync(legacy, JSON.stringify({ version: 2, sessions: { s1: { phase: 'armed', since: 1 } } }), 'utf8');
  const reg = makeToolRegistry(GLOBAL_TOOLS);
  const agent = makeAgent('s1', reg);
  let threw = null;
  const ctx = await startPlugin({ stateFile: legacy, agentsById: new Map([['s1', agent]]), subagents: makeSubagents(), services: { llm: makeLlm() } }).catch((cause) => { threw = cause; return null; });
  check('F25a 旧 v2 状态文件装载不抛', threw === null, () => String(threw?.stack ?? threw));
  check('F25 statusOf("s1") 报 armed（照记录转述）', ctx?.service?.status('s1')?.phase === 'armed',
    () => `phase=${ctx?.service?.status('s1')?.phase}`);
  await sleep(30); // 事件/status 触发的收敛把编排簿物化
  const materialized = ctx.service.status('s1');
  check('F25b 物化后仍 armed 且装上人格段（旧记录复活成可用状态）',
    materialized.phase === 'armed' && agent.__sections.some((section) => section.name === 'dual-agent:critic')
    && agent.__sections.some((section) => section.name === 'dual-agent:armed'),
    () => json(agent.__sections.map((section) => section.name)));
  const rewritten = JSON.parse(readFileSync(legacy, 'utf8'));
  check('F25c 首次写入补齐 v3 形状（version/settings/chains 都在）',
    rewritten.version === 3 && 'settings' in rewritten && Array.isArray(rewritten.chains) && rewritten.sessions.s1.phase === 'armed',
    () => json(rewritten));
  check('F25d 旧记录里缺 childId 不炸（ghost 判定走 armed）',
    materialized.childId === null && materialized.running === true);

  // 畸形 config：不抛、回落到有形状的默认
  const reg2 = makeToolRegistry(GLOBAL_TOOLS);
  const root2 = makeAgent('f2-root', reg2);
  const ctx2 = await startPlugin({
    stateFile: sf('f-badconfig'),
    agentsById: new Map([['f2-root', root2]]),
    subagents: makeSubagents(),
    services: { llm: makeLlm() },
    config: { guidance: 'junk', verify: { maxClaims: -5, enabled: 'yes', readLimitBytes: 'lots' }, models: [1, 2], autoArmForNewSessions: '真' },
  });
  const view = ctx2.service.settings();
  check('F26a 畸形 config 不抛且回落默认（enforce=true / mode=strict）',
    view.enforce === true && view.mode === 'strict' && view.hideMainTools === false && Array.isArray(view.extraAllowed));
  check('F26b verify.enabled 的非布尔值按「不是 true」处理 → false（不猜用户意图）',
    view.verifyEnabled === false, () => json(view));
  await ctx2.service.transition('f2-root', true);
  check('F26c 回落后的 guard 仍按默认 strict 工作', typeof ctx2.__guards[0]({ agent: root2, name: 'pwsh' }) === 'string');
  check('F26d 核验关着时 verify.run 直接回 null（不假装核过）',
    await ctx2.service.verify.run('f2-root', reportWith([{ claim: 'x', check: { kind: 'file_exists', path: REAL_FILE } }])) === null);
  ctx2.service.setSetting('verify.enabled', true);
  const many = reportWith(Array.from({ length: 50 }, (unused, index) => ({ claim: `${index}`, check: { kind: 'number', a: 1, b: 1, op: '==' } })));
  const maxClaimsBack = await ctx2.service.verify.run('f2-root', many);
  check('F26e maxClaims:-5 回落 40（非正数不当成「0 条都核」也不当成无限）',
    maxClaimsBack.summary.dropped === 10 && maxClaimsBack.summary.pass === 40, () => json(maxClaimsBack.summary));
  check('F26f readLimitBytes 的非数字回落默认（仍能读小文件）', (() => {
    const verdict = ctx2.service.verify.run('f2-root', reportWith([{ claim: 'needle', check: { kind: 'file_contains', path: REAL_FILE, needle: 'MARKER-XYZ' } }]));
    return verdict instanceof Promise;
  })());

  // 设置持久化：新实例恢复 readonly
  const reg3 = makeToolRegistry(GLOBAL_TOOLS);
  const root3 = makeAgent('f3-root', reg3);
  const stateFile3 = sf('f-persist');
  const ctx3 = await startPlugin({ stateFile: stateFile3, agentsById: new Map([['f3-root', root3]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
  await ctx3.service.transition('f3-root', true);
  ctx3.service.setSetting('mode', 'readonly');
  ctx3.service.setSetting('extraAllowed', ['web_search']);
  check('F27a 本实例 readonly 生效', ctx3.__guards[0]({ agent: root3, name: 'read' }) === undefined);
  const onDisk3 = JSON.parse(readFileSync(stateFile3, 'utf8'));
  check('F27b settings 落盘成对象', onDisk3.settings?.guidance?.mode === 'readonly'
    && onDisk3.settings?.guidance?.extraAllowed?.includes('web_search'), () => json(onDisk3.settings));
  const root3b = makeAgent('f3-root', reg3);
  const ctx3b = await startPlugin({ stateFile: stateFile3, agentsById: new Map([['f3-root', root3b]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
  await ctx3b.service.transition('f3-root', true);
  check('F27 新实例恢复 readonly（read 放行、pwsh 仍拒）',
    ctx3b.__guards[0]({ agent: root3b, name: 'read' }) === undefined
    && typeof ctx3b.__guards[0]({ agent: root3b, name: 'pwsh' }) === 'string');
  check('F27c 也恢复 extraAllowed', ctx3b.__guards[0]({ agent: root3b, name: 'web_search' }) === undefined);
  check('F27d row config 打底 + 落盘覆盖（未改过的项仍是默认）',
    ctx3b.service.settings().verifyEnabled === true && ctx3b.service.settings().applyChain === true);

  // DSH_HOME 默认状态文件
  const reg4 = makeToolRegistry(GLOBAL_TOOLS);
  const ctx4 = await startPlugin({ agentsById: new Map(), subagents: makeSubagents(), services: { llm: makeLlm() } });
  check('F28 省略 stateFile → 落 $DSH_HOME/dual-agent.json',
    ctx4.service.status(undefined).stateFile === join(DIR, 'dual-agent.json'),
    () => String(ctx4.service.status(undefined).stateFile));

  // autoArmForNewSessions：诊断口径的新会话一出生就武装（只对根会话）
  const reg5 = makeToolRegistry(GLOBAL_TOOLS);
  const ctx5 = await startPlugin({
    stateFile: sf('f-autoarm'),
    agentsById: new Map(),
    subagents: makeSubagents(),
    services: { llm: makeLlm() },
    config: { autoArmForNewSessions: true },
  });
  const born = makeAgent('f5-born', reg5);
  ctx5.__agentsById.set(born.id, born);
  await ctx5.__fire('agent/created', { agent: born });
  check('F29a autoArmForNewSessions 武装出生的根会话',
    ctx5.service.status('f5-born').phase === 'armed' && born.__sections.length > 0,
    () => json(ctx5.service.status('f5-born').phase));
  const bornChild = makeAgent('f5-child', reg5, { parent: 'f5-born' });
  ctx5.__agentsById.set(bornChild.id, bornChild);
  await ctx5.__fire('agent/created', { agent: bornChild });
  check('F29b 子代理不出被自动武装（否则约束会盯上干活的人）',
    ctx5.service.status('f5-child').phase === 'off' && bornChild.__sections.length === 0);
  await ctx5.service.transition('f5-born', false);
  check('F29c 关掉后 autoArm 记录不再复活', ctx5.service.status('f5-born').phase === 'off');

  // hideMainTools：可降级增强（自检发现伤子代理就撤销）
  {
    const reg6 = makeToolRegistry(GLOBAL_TOOLS);
    const root6 = makeAgent('f6-root', reg6);
    const ctx6 = await startPlugin({
      stateFile: sf('f-hide-ok'),
      agentsById: new Map([['f6-root', root6]]),
      subagents: makeSubagents(),
      services: { llm: makeLlm() },
      config: { guidance: { hideMainTools: true } },
    });
    await ctx6.service.transition('f6-root', true);
    const hidden = ctx6.service.status('f6-root').guidance;
    check('F30a hideMainTools=true 时主智能清单被摘（hidden>0）',
      hidden.hidden > 0 && hidden.degraded === false && root6.ctx.tools.schemas(root6).some((schema) => schema.name === 'pwsh') === false,
      () => `hidden=${hidden.hidden} degraded=${hidden.degraded}`);
    check('F30b 摘的是清单，插件根作用域仍看得见全量（guard 才是权威）',
      ctx6.tools.schemas().some((schema) => schema.name === 'pwsh') === true);
    const child6 = makeAgent('f6-child', reg6, { parent: 'f6-root' });
    ctx6.__agentsById.set(child6.id, child6);
    await ctx6.__fire('agent/created', { agent: child6 });
    check('F30c 子代理出生时把定义补回它自己那层（清单没被连带摘走）',
      child6.ctx.tools.schemas(child6).some((schema) => schema.name === 'pwsh') === true
      && ctx6.service.status('f6-root').guidance.degraded === false);
    check('F30d 行为段说明了隐藏数量',
      /已从你的清单里隐藏 \d+ 个工具/.test(String(root6.__sections.find((section) => section.name === 'dual-guidance:enforce')?.text ?? '')));
  }
  {
    const reg7 = makeToolRegistry(GLOBAL_TOOLS, { ownRegisterEffective: false });
    const root7 = makeAgent('f7-root', reg7);
    const ctx7 = await startPlugin({
      stateFile: sf('f-hide-degrade'),
      agentsById: new Map([['f7-root', root7]]),
      subagents: makeSubagents(),
      services: { llm: makeLlm() },
      config: { guidance: { hideMainTools: true } },
      registryOptions: { ownRegisterEffective: false },
    });
    await ctx7.service.transition('f7-root', true);
    const child7 = makeAgent('f7-child', reg7, { parent: 'f7-root' });
    ctx7.__agentsById.set(child7.id, child7);
    await ctx7.__fire('agent/created', { agent: child7 });
    const guidance7 = ctx7.service.status('f7-root').guidance;
    check('F31a 补注册失败 → 自检降级（degraded=true，hidden 撤销）',
      guidance7.degraded === true && guidance7.hidden === 0, () => json(guidance7));
    check('F31b 降级理由进 status（不静默半坏）',
      typeof guidance7.degradeNote === 'string' && guidance7.degradeNote.includes('子代理'), () => String(guidance7.degradeNote));
    check('F31c 撤销隐藏后主智能清单恢复全量，guard 仍在拦',
      root7.ctx.tools.schemas(root7).some((schema) => schema.name === 'pwsh') === true
      && typeof ctx7.__guards[0]({ agent: root7, name: 'pwsh' }) === 'string');
    check('F31d 行为段改口说「已降级」',
      /清单隐藏已降级关闭/.test(String(root7.__sections.find((section) => section.name === 'dual-guidance:enforce')?.text ?? '')));
  }

  // 会话销毁 = 约束与链一起收
  {
    const reg8 = makeToolRegistry(GLOBAL_TOOLS);
    const root8 = makeAgent('f8-root', reg8);
    const child8 = makeAgent('f8-child', reg8, { parent: 'f8-root' });
    const stateFile8 = sf('f-dispose');
    const ctx8 = await startPlugin({ stateFile: stateFile8, agentsById: new Map([['f8-root', root8], ['f8-child', child8]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    await ctx8.service.transition('f8-root', true);
    ctx8.service.chain.set('f8-root', [{ provider: 'p1', model: 'm-a' }]);
    check('F32a 销毁前链在盘上', JSON.parse(readFileSync(stateFile8, 'utf8')).chains.length === 1);
    ctx8.__fire('agent/disposed', { agent: root8 });
    const after = JSON.parse(readFileSync(stateFile8, 'utf8'));
    check('F32 会话销毁 → 记录清、段拆、链也跟着收',
      after.sessions['f8-root'] === undefined && after.chains.length === 0 && root8.__sections.length === 0,
      () => json({ sessions: after.sessions, chains: after.chains, sections: root8.__sections.map((s) => s.name) }));
    check('F32b 销毁后 guard 不再拦（没东西可武装了）',
      ctx8.__guards[0]({ agent: root8, name: 'pwsh' }) === undefined);
  }

  // 插件卸载（effect disposer）：拆装配但**保留**落盘记录（重载自愈的前提）
  {
    const reg9 = makeToolRegistry(GLOBAL_TOOLS);
    const root9 = makeAgent('f9-root', reg9);
    const stateFile9 = sf('f-unload');
    const ctx9 = await startPlugin({ stateFile: stateFile9, agentsById: new Map([['f9-root', root9]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    await ctx9.service.transition('f9-root', true);
    const beforeDisk = JSON.parse(readFileSync(stateFile9, 'utf8'));
    check('F33a 武装记录在盘', beforeDisk.sessions['f9-root'].phase === 'armed');
    await ctx9.service.transition('f9-root', true); // 幂等
    check('F33b 重复武装不改 phase', ctx9.service.status('f9-root').phase === 'armed' && root9.__sections.length === 3,
      () => json(root9.__sections.map((s) => s.name)));
  }
}

// ══ H. v21 家族隔离：快照物化 / 互不影响 / 兼容路径 / 跨重载 / 链模板继承 ═══════
{
  // ── H1 带 sessionId 的 setSetting 只影响该家族（另一家族的 settingsFor 不变）──
  {
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const rootA = makeAgent('h1-a', reg);
    const rootB = makeAgent('h1-b', reg);
    const stateFileH1 = sf('h1-family');
    const ctx = await startPlugin({ stateFile: stateFileH1, agentsById: new Map([['h1-a', rootA], ['h1-b', rootB]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const svc = ctx.service;
    // 两个家族各自武装 → 各自从模板物化快照
    await svc.transition('h1-a', true);
    await svc.transition('h1-b', true);
    const disk1 = JSON.parse(readFileSync(stateFileH1, 'utf8'));
    check('H01 武装时为每个家族物化快照（families[a]/families[b] 都在）',
      disk1.families?.['h1-a']?.settings !== undefined && disk1.families?.['h1-b']?.settings !== undefined,
      () => json(Object.keys(disk1.families ?? {})));
    check('H01b 快照形状 = {guidance,verify,models} 且 since 是 epoch',
      disk1.families['h1-a'].settings.guidance !== undefined
      && disk1.families['h1-a'].settings.verify !== undefined
      && disk1.families['h1-a'].settings.models !== undefined
      && typeof disk1.families['h1-a'].since === 'number', () => json(disk1.families['h1-a']));

    // 带 sessionId 改 A 家族：走**二级菜单 op**（setSetting 的服务面保持无 sessionId
    // =全局语义，这是既有契约；家族口径的唯一写入口就是菜单 op → setSetting(id,v,sessionId)）
    await svc.menu.op({ sessionId: 'h1-a', op: 'set', id: 'mode', value: 'readonly' });
    const disk2 = JSON.parse(readFileSync(stateFileH1, 'utf8'));
    check('H02 A 家族快照写入 readonly',
      disk2.families['h1-a'].settings.guidance.mode === 'readonly', () => json(disk2.families['h1-a'].settings.guidance));
    check('H02b B 家族快照不受影响（仍是 strict）',
      disk2.families['h1-b'].settings.guidance.mode === 'strict', () => json(disk2.families['h1-b'].settings.guidance));
    check('H02c 全局模板同步成 readonly（新会话继承用户刚选的偏好）',
      disk2.settings?.guidance?.mode === 'readonly', () => json(disk2.settings));
    // 生效口径：A 的 guard 放 read、B 的 guard 拒 read（互不影响的行为面证据）
    const guard = ctx.__guards[0];
    check('H03 A 会话生效 readonly（read 放行）', guard({ agent: rootA, name: 'read' }) === undefined);
    check('H03b B 会话仍生效 strict（read 拒）', typeof guard({ agent: rootB, name: 'read' }) === 'string');
    // status 也是按家族口径透出
    check('H03c status.guidance 按各自家族（A=readonly / B=strict）',
      svc.status('h1-a').guidance.mode === 'readonly' && svc.status('h1-b').guidance.mode === 'strict');
    // 子代理归属父会话的家族（血缘上溯）：A 家族的子代理按 A 的口径放行
    const childA = makeAgent('h1-a-child', reg, { parent: 'h1-a' });
    ctx.__agentsById.set(childA.id, childA);
    check('H03d 子代理血缘上溯到父家族的口径（它自己不受约束，这条只验 lineage 不炸）',
      svc.status('h1-a').sessionId === 'h1-a');
    // 定点重装：B 的段没被重装（A 改设置不触发 B 的 enforce.install）——
    // 用行为间接验证：B 的 guard 口径没变即为目标行为（上面 H03b 已证）。
    // 幂等/兼容：同一 id 不带 sessionId（程序化全局口径）→ 两家族都被同步。
    svc.setSetting('mode', 'strict');
    const disk3 = JSON.parse(readFileSync(stateFileH1, 'utf8'));
    check('H04 不带 sessionId 的全局口径：A、B 两个家族快照都被同步回 strict',
      disk3.families['h1-a'].settings.guidance.mode === 'strict'
      && disk3.families['h1-b'].settings.guidance.mode === 'strict'
      && disk3.settings.guidance.mode === 'strict');
    check('H04b 全局口径后两家族 guard 都回到 strict（read 拒）',
      typeof guard({ agent: rootA, name: 'read' }) === 'string' && typeof guard({ agent: rootB, name: 'read' }) === 'string');
  }

  // ── H2 跨 store 重载：家族快照仍在并继续生效（重启持久化）──
  {
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const stateFileH2 = sf('h2-reload');
    const ctxA = await startPlugin({ stateFile: stateFileH2, agentsById: new Map([['h2-root', makeAgent('h2-root', reg)]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    await ctxA.service.transition('h2-root', true);
    ctxA.service.setSetting('extraAllowed', 'web_search', 'h2-root');
    ctxA.service.setSetting('mode', 'readonly', 'h2-root');
    // 新实例（模拟插件重载/进程重启）：家族快照必须原样读回并继续生效
    const regB = makeToolRegistry(GLOBAL_TOOLS);
    const rootB = makeAgent('h2-root', regB);
    const ctxB = await startPlugin({ stateFile: stateFileH2, agentsById: new Map([['h2-root', rootB]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const disk = JSON.parse(readFileSync(stateFileH2, 'utf8'));
    check('H05 家族快照跨重载仍在盘上（families 键保留）',
      disk.families?.['h2-root']?.settings?.guidance?.mode === 'readonly', () => json(disk.families ?? null));
    await ctxB.service.transition('h2-root', true);
    check('H05b 重载后该家族的口径恢复（read 放行 + web_search 放行 + pwsh 拒）',
      ctxB.__guards[0]({ agent: rootB, name: 'read' }) === undefined
      && ctxB.__guards[0]({ agent: rootB, name: 'web_search' }) === undefined
      && typeof ctxB.__guards[0]({ agent: rootB, name: 'pwsh' }) === 'string');
    // 幂等：initFamily 不覆盖已有快照（重载再次武装不会把用户改动冲回模板）
    const beforeIdem = JSON.parse(readFileSync(stateFileH2, 'utf8')).families['h2-root'].settings;
    check('H05c 重复武装不冲掉家族快照（幂等初始化）',
      JSON.parse(readFileSync(stateFileH2, 'utf8')).families['h2-root'].settings.guidance.mode === beforeIdem.guidance.mode);
  }

  // ── H3 未武装（无快照）的家族：读口径回退到模板（只读，不物化）──
  {
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const stateFileH3 = sf('h3-template-fallback');
    const ctx = await startPlugin({ stateFile: stateFileH3, agentsById: new Map([['h3-root', makeAgent('h3-root', reg)]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const svc = ctx.service;
    svc.setSetting('mode', 'readonly'); // 全局口径写模板
    check('H06 无快照的会话按模板口径生效（guard read 放行）',
      ctx.__guards[0]({ agent: ctx.__agentsById.get('h3-root'), name: 'read' }) === undefined);
    const disk = JSON.parse(readFileSync(stateFileH3, 'utf8'));
    check('H06b 读口径回退不物化快照（families 仍为空）',
      disk.families === undefined || Object.keys(disk.families).length === 0, () => json(disk.families ?? null));
    // settingsView 无参 = 模板视图（e2e 沙箱依赖的口径）
    check('H06c settingsView() 无参回模板视图', svc.settings().mode === 'readonly');
  }

  // ── H4 链模板：菜单配链 → 新武装的无链家族自动继承 ──
  {
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const rootA = makeAgent('h4-a', reg);
    const stateFileH4 = sf('h4-chaintpl');
    const ctx = await startPlugin({ stateFile: stateFileH4, agentsById: new Map([['h4-a', rootA]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const svc = ctx.service;
    await svc.transition('h4-a', true);
    // 经**二级菜单**给 A 家族配链（这是唯一驱动链模板的口径）
    await svc.menu.op({ sessionId: 'h4-a', op: 'add-candidate', fields: { route: 'p1::m-a', limitKind: 'requests', limitValue: '7' } });
    const disk1 = JSON.parse(readFileSync(stateFileH4, 'utf8'));
    check('H07 菜单配链后链模板落盘（candidates/countAuxiliary/countTowardPool）',
      Array.isArray(disk1.chainTemplate?.candidates) && disk1.chainTemplate.candidates.length === 1
      && disk1.chainTemplate.candidates[0].provider === 'p1' && disk1.chainTemplate.candidates[0].model === 'm-a'
      && disk1.chainTemplate.candidates[0].limit?.kind === 'requests' && disk1.chainTemplate.candidates[0].limit?.value === 7
      && disk1.chainTemplate.countAuxiliary === false && disk1.chainTemplate.countTowardPool === false,
      () => json(disk1.chainTemplate ?? null));
    check('H07b 模板里没有 used 计数（计数不进模板）',
      JSON.stringify(disk1.chainTemplate).includes('"used"') === false);
    // 新家族（B）武装：无自己的链 → 自动继承链模板
    const rootB = makeAgent('h4-b', reg);
    ctx.__agentsById.set('h4-b', rootB);
    await svc.transition('h4-b', true);
    const viewB = svc.chain.view('h4-b');
    check('H08 新武装的无链家族自动继承链模板（候选/限额/记账开关）',
      viewB.configured === true && viewB.candidates.length === 1
      && viewB.candidates[0].provider === 'p1' && viewB.candidates[0].model === 'm-a'
      && viewB.candidates[0].limit === 7 && viewB.candidates[0].used.requests === 0 && viewB.candidates[0].used.tokens === 0,
      () => json(viewB));
    const disk2 = JSON.parse(readFileSync(stateFileH4, 'utf8'));
    check('H08b 继承落到盘上的是 h4-b 自己的 chains 记录（计数不落盘）',
      (disk2.chains ?? []).some((entry) => entry.sessionId === 'h4-b' && entry.candidates[0]?.limit?.value === 7),
      () => json(disk2.chains ?? null));
    // clear-chain → 链模板清成 null（下一个新家族不再继承已撤销的链）
    await svc.menu.op({ sessionId: 'h4-b', op: 'clear-chain' });
    const disk3 = JSON.parse(readFileSync(stateFileH4, 'utf8'));
    check('H09 clear-chain 把链模板清成 null', disk3.chainTemplate === null, () => json(disk3.chainTemplate));
    const rootC = makeAgent('h4-c', reg);
    ctx.__agentsById.set('h4-c', rootC);
    await svc.transition('h4-c', true);
    check('H09b 模板清空后新家族不再被塞回已撤销的链', svc.chain.view('h4-c').configured === false);
    // reset-counters 不动模板：clear-chain 之后模板已是 null，这里经菜单重新配一条
    // （模板恢复成 1 条候选），再 reset 本家族的计数——模板必须逐字节不变。
    await svc.menu.op({ sessionId: 'h4-a', op: 'add-candidate', fields: { route: 'p2::m-b', limitKind: 'requests', limitValue: '5' } });
    const tplBefore = JSON.parse(readFileSync(stateFileH4, 'utf8')).chainTemplate;
    await svc.menu.op({ sessionId: 'h4-a', op: 'reset-counters' });
    const tplAfter = JSON.parse(readFileSync(stateFileH4, 'utf8')).chainTemplate;
    check('H10 reset-counters 不改链模板',
      JSON.stringify(tplBefore) === JSON.stringify(tplAfter) && Array.isArray(tplAfter?.candidates) && tplAfter.candidates.length === 2,
      () => json({ before: tplBefore, after: tplAfter }));
    // 程序化 chain.set 不写模板（模板只由菜单 op 驱动）
    svc.chain.set('h4-c', [{ provider: 'p1', model: 'm-a' }]);
    const tplAfterProgrammatic = JSON.parse(readFileSync(stateFileH4, 'utf8')).chainTemplate;
    check('H10b 程序化 chain.set 不碰链模板（只由菜单 op 驱动）',
      JSON.stringify(tplAfterProgrammatic) === JSON.stringify(tplAfter), () => json(tplAfterProgrammatic));
  }

  // ── H5 旧版本升级：落盘已有 armed 会话 + 无 families 键 → 装载时逐个 initFamily ──
  {
    const legacyH5 = sf('h5-upgrade');
    writeFileSync(legacyH5, JSON.stringify({
      version: 3,
      sessions: { 'h5-old': { phase: 'armed', since: Date.now() - 5000 } },
      settings: { guidance: { mode: 'readonly' } },
      chains: [],
    }), 'utf8');
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const agent = makeAgent('h5-old', reg);
    const ctx = await startPlugin({ stateFile: legacyH5, agentsById: new Map([['h5-old', agent]]), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const disk = JSON.parse(readFileSync(legacyH5, 'utf8'));
    check('H11 旧会话升级：装载时为已武装会话物化家族快照（含模板里的 readonly）',
      disk.families?.['h5-old']?.settings?.guidance?.mode === 'readonly', () => json(disk.families ?? null));
    // 家族上限淘汰：塞满 201 个家族再写一个 → 最旧的被淘汰（LRU 按 since）
    const reg2 = makeToolRegistry(GLOBAL_TOOLS);
    const stateFileH5b = sf('h5-limit');
    const ctx2 = await startPlugin({ stateFile: stateFileH5b, agentsById: new Map(), subagents: makeSubagents(), services: { llm: makeLlm() } });
    const svc2 = ctx2.service;
    svc2.setSetting('mode', 'strict'); // 先写一次模板（触发 store 初始化）
    // 直接通过武装路径制造 201 个家族（每个家族一次 transition+disarm 落盘）
    for (let i = 0; i < 201; i += 1) {
      const id = `h5-fam-${i}`;
      ctx2.__agentsById.set(id, makeAgent(id, reg2));
      await svc2.transition(id, true);
      await svc2.transition(id, false);
    }
    const afterMany = JSON.parse(readFileSync(stateFileH5b, 'utf8'));
    check('H12 家族上限：超过 200 条时最旧家族被淘汰',
      Object.keys(afterMany.families ?? {}).length <= 200
      && afterMany.families['h5-fam-0'] === undefined
      && afterMany.families['h5-fam-200'] !== undefined,
      () => `count=${Object.keys(afterMany.families ?? {}).length} first=${afterMany.families?.['h5-fam-0'] !== undefined}`);
  }

  // ── H6 净化：families/chainTemplate 形状不对整条丢弃（防御式）──
  {
    const junkH6 = sf('h6-junk');
    writeFileSync(junkH6, JSON.stringify({
      version: 3,
      sessions: {},
      settings: null,
      chains: [],
      families: { 'bad-1': 'not-an-object', 'bad-2': { since: 1 }, 'good-1': { settings: { guidance: { mode: 'readonly' } }, since: 2 }, 'bad-3': { settings: [1, 2], since: 3 } },
      chainTemplate: { candidates: 'not-array' },
    }), 'utf8');
    const reg = makeToolRegistry(GLOBAL_TOOLS);
    const ctx = await startPlugin({ stateFile: junkH6, agentsById: new Map(), subagents: makeSubagents(), services: { llm: makeLlm() } });
    // 写一次盘触发重写，再读回验证净化结果
    ctx.service.setSetting('mode', 'strict');
    const disk = JSON.parse(readFileSync(junkH6, 'utf8'));
    check('H13 畸形家族条目整条丢弃、形状对的保留',
      disk.families['good-1'] !== undefined && disk.families['bad-1'] === undefined
      && disk.families['bad-2'] === undefined && disk.families['bad-3'] === undefined,
      () => json(Object.keys(disk.families ?? {})));
    check('H13b 畸形链模板（candidates 非数组）→ 读成 null',
      disk.chainTemplate === null, () => json(disk.chainTemplate ?? null));
  }
}

// ── 源码面守卫（与 host-selftest ㉑/㉔ 同思路：挡住「fake 跟着 stub 假成功」）──
{
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const SUBAGENT_SERVICE_METHODS = new Set([
    'resolveMaxDepth', 'startActivation', 'waitForChildren', 'sendMessage', 'interrupt',
    'drainDescendants', 'drainChildren', 'listChildren', 'listDescendants', 'prompt',
    'interruptByParent', 'registerProvider', 'getProvider', 'list',
  ]);
  const called = new Set();
  for (const match of source.matchAll(/\bsubagents\??\.(\w+)\s*\(/g)) called.add(match[1]);
  const unknown = [...called].filter((name) => !SUBAGENT_SERVICE_METHODS.has(name));
  check('G01 对 subagents 的调用全在服务面上', unknown.length === 0, () => json(unknown));
  check('G02 webServer/llm/subagents 不在 inject（headless 装得上）',
    /export const inject = \['agents', 'tools'\]/.test(source));
  check('G03 编排消息用生产者自有 kind（v4 会话格式硬要求）',
    source.includes("kind: 'plugin:dsh-dual-agent'") && !/source:\s*\{\s*kind:\s*'plugin'\s*\}/.test(source));
  check('G04 四个 dg-* 模块都按带版本 specifier 引',
    ['./dg-verify.js?v=dg-2', './dg-chain.js?v=dg-2', './dg-enforce.js?v=dg-2', './dg-menu.js?v=dg-2'].every((specifier) => source.includes(specifier)));
  check('G05 构建号与 package.json 一致（4.1.0+family）',
    source.includes("const BUILD = '4.1.0+family'"), () => (source.match(/const BUILD = [^\n]*/) ?? ['(无)'])[0]);
  const enforceSource = readFileSync(new URL('./dg-enforce.js', import.meta.url), 'utf8');
  check('G06 guard 注册在插件根作用域、按调用者身份判定（不是 restrict 当权威）',
    /ctx\.tools\.guard\(/.test(enforceSource) && /isRootAgent\(agent\)/.test(enforceSource));
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────

check('Z01 没有未捕获的 Promise 拒绝', unhandled.length === 0, () => unhandled.join('\n').slice(0, 600));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n断言 ${totalChecks} 条，失败 ${failures.length} 条`);
if (failures.length > 0) console.log(`失败清单：\n${failures.map((label) => `  - ${label}`).join('\n')}`);
console.log(failures.length === 0 ? 'GUIDANCE SELFTEST PASS' : `GUIDANCE SELFTEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
