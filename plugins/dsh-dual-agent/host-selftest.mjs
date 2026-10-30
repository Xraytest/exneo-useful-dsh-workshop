// dsh-dual-agent v2 host 自测：fake ctx + fake subagents 驱动 v2 状态机。
// 覆盖：armed→running→evaluation、手动停止不评估、主动停止评估、
// off↔armed↔running 全迁移、孵化失败回退、恢复降级、消息形态与来源过滤。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];
const check = (label, condition) => {
  console.log((condition ? 'ok   ' : 'FAIL ') + label);
  if (!condition) failures.push(label);
};

// ── fake 基座 ───────────────────────────────────────────────────────────────

/** host 半边当前发布的入口（换 entry 文件名 = 强制热更；自测必须跟它走）。 */
const ENTRY = './entry-v18.js';

function makeAgent(id) {
  const listeners = new Map(); // 事件名 → Set<listener>
  const sessionListeners = [];
  const sections = [];
  const followups = [];
  const snapshot = []; // 会话里已落的事件（评估轮兜底用 snapshotEvents 查 assistant 正文）
  const agent = {
    __snapshot: snapshot,
    id,
    status: 'idle',
    inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    session: {
      // 真实 Session 的稳定身份（session.id）。会话事件的懒恢复靠它兜底：
      // 插件重载后 watchedSessions 会清空，只认 WeakMap 的话就再也孵化不了。
      id,
      seq: 0,
      deriveMessages: () => [],
      // 真实会话按 fromSeq 投影已提交事件；评估轮兜底据此判断该轮是否已产出正文。
      snapshotEvents: (from = 0) => snapshot.filter((ev) => (ev.seq ?? 0) >= from),
      // 模拟 surface 投影：按注册顺序回调 session/event
      __emit(event) { for (const l of [...sessionListeners]) l(agent.session, event); },
    },
    followup: (message) => { followups.push(message); },
    // 真实 Agent 有 whenIdle（评估兜底投递等它真空闲才投）。fake 立即 resolve，
    // 让 idleThenDeliver 走**真实分支**而不是退化到纯 setTimeout。
    whenIdle: () => Promise.resolve(),
    __cancels: [],
    // 双线路径的「阻塞」：孵化/转达时插件会 cancel 主 Agent 当前回合
    // （keepInbox 保住编排消息）。fake 记录每次 cancel 的 cause/options。
    cancel(cause, options) { agent.__cancels.push({ cause, options }); },
    ctx: {
      effect(fn) { fn(); return () => {}; },
      on(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
        if (name === 'session/event') sessionListeners.push(listener);
        return () => {};
      },
      systemPrompt: {
        section(definition) { sections.push(definition); return () => {}; },
      },
    },
    __sections: sections,
    __followups: followups,
    __emitEvent(event) { agent.session.__emit(event); },
    __emitStatus(status) {
      agent.status = status;
      for (const listener of [...(listeners.get('agent/status') ?? [])]) listener({ agent, status });
    },
  };
  return agent;
}

function makeCtx(agentsById, subagentsApi, extraServices = {}) {
  const routes = new Map();
  const disposed = [];
  const created = [];
  const subEnd = [];
  // 插件在**根作用域**注册 session/event（未打标签 → Cordis 全局放行），
  // 所以这里收在 ctx 级；agent.__emitEvent 委托到这里。
  const sessionEvents = [];
  const provided = new Map();
  return {
    __routes: routes,
    __disposed: disposed,
    __created: created,
    __sessionEvents: sessionEvents,
    __provided: provided,
    logger: { info() {}, warn() {}, debug() {} },
    // 真实 Cordis 的 ctx 总有 provide；fake 记下它，供 E2E 经 get('dualAgent') 取用。
    provide(name, value) { provided.set(name, value); },
    effect(fn) { fn(); return () => {}; },
    on(name, listener) {
      if (name === 'agent/disposed') disposed.push(listener);
      if (name === 'agent/created') created.push(listener);
      if (name === 'subagent/end') subEnd.push(listener);
      if (name === 'session/event') sessionEvents.push(listener);
      return () => {};
    },
    __emitDisposed(agent) { for (const l of disposed) l({ agent }); },
    __emitSubagentEnd(info) { for (const l of subEnd) l(info); },
    agents: {
      get(id) { return agentsById.get(id); },
      withoutInitiator(fn) { return fn(); },
    },
    get(key) {
      if (key === 'subagents') return subagentsApi;
      // 插件不再 inject webServer，改用 ctx.get('webServer') 可选查找；
      // fake 必须在这里把它的 webServer 交出去，否则路由挂不上、测试全 404。
      if (key === 'webServer') return this.webServer;
      // 自测用附加服务（sessionQuery：重载后读回已结束执行者的报告）。
      if (extraServices[key] !== undefined) return extraServices[key];
      // E2E / 自测经 ctx.get('dualAgent') 取可编程面（provide 注册的服务）。
      if (provided.has(key)) return provided.get(key);
      return undefined;
    },
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
    },
  };
}

function fakeSubagents(hatchImpl, options = {}) {
  const calls = [];
  const providers = options.providers ?? [
    // 仿 @deepseek-ai/dsh-subagent-spawn-in-process 的真实形态
    { name: 'spawn', inheritsParentContext: false, prepareContinuable() { return Promise.resolve({}); } },
  ];
  // delivery:'caller'：startActivation 返回 {childId, result, dispose}，插件 await
  // result 驱动评估。测试用 __settle(childId, {output, stopReason}) 模拟自然结算，
  // __reject 模拟 teardown 失败；没结算 = 永不评估（手动停止/disarm 的正确形态）。
  const pending = new Map(); // childId -> {resolve, reject}
  const api = {
    __calls: calls,
    // 孵化出来的执行者在真实宿主里当然是一个活 Agent（ctx.agents.get(childId) 命中）。
    // 自测必须同构：否则插件的「running 必须有可核对的活执行者」会把每次孵化都
    // 判成幽灵。startPlugin 在第一次装载时把宿主表交给这里。
    __agentsById: options.agentsById ?? null,
    list: () => providers.map((p) => p.name),
    getProvider: (name) => providers.find((p) => p.name === name),
    resolveMaxDepth: () => 1,
    async startActivation(spec) {
      calls.push(spec);
      const made = await hatchImpl(spec); // 可能 {childId} 或抛错
      const childId = made.childId;
      const registry = api.__agentsById;
      if (registry !== null && registry !== undefined && registry.get(childId) === undefined) {
        registry.set(childId, makeAgent(childId));
      }
      let resolve; let reject;
      const result = new Promise((res, rej) => { resolve = res; reject = rej; });
      pending.set(childId, { resolve, reject });
      return { childId, result, dispose: async () => { calls.push({ dispose: childId }); } };
    },
    __settle(childId, value = { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }) {
      const p = pending.get(childId);
      if (p !== undefined) { pending.delete(childId); p.resolve(value); }
    },
    __reject(childId, err) {
      const p = pending.get(childId);
      if (p !== undefined) { pending.delete(childId); p.reject(err); }
    },
    interrupt(childId, authority) { calls.push({ interrupt: childId, authority }); },
    // 只 stub 服务面上真实存在的方法（见 cordis_inspect 的 subagents 方法清单）。
    // 故意不提供 queuePrompt —— 它不存在于服务面，stub 它会让「转达」在自测里
    // 假装成功、在生产上抛 TypeError。
    async sendMessage(sender, targetId, content, options) {
      calls.push({ sendMessage: targetId, content, sender: sender?.id, hasSignal: options?.signal !== undefined });
      return 'msg-1';
    },
  };
  // 兼容旧调用：__emitSubagentEnd({id, stopReason}) 现在等价于 __settle。
  api.__emitSubagentEnd = (info) => api.__settle(info.id, {
    output: [{ type: 'text', text: 'done' }], stopReason: info.stopReason ?? 'completed',
  });
  return api;
}

function fakeReq(method, body, origin = '') {
  const text = JSON.stringify(body ?? {});
  return {
    method,
    headers: origin === '' ? {} : { origin },
    url: '/x',
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
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(text) { state.body = text; state.headersSent = true; },
  };
}

async function call(ctx, path, method, body, origin) {
  const base = path.split('?')[0];
  const handler = ctx.__routes.get(base);
  if (handler === undefined) throw new Error('no route ' + base);
  const res = fakeRes();
  const reqObj = fakeReq(method, body, origin);
  reqObj.url = path.includes('?') ? path : '/x';
  const settlement = Promise.resolve(handler(reqObj, res)).then(() => 'settled', (e) => { console.log('CALL THREW:', e); return 'rejected'; });
  await settlement;
  if (res.state.body === null) console.log('DBG call', path, method, '-> no body; status', res.state.status);
  return { status: res.state.status, json: res.state.body === null ? null : JSON.parse(res.state.body) };
}

async function startPlugin(stateFile, agentsById, subagentsApi, extraServices = {}) {
  if (subagentsApi.__agentsById === null || subagentsApi.__agentsById === undefined) {
    subagentsApi.__agentsById = agentsById;
  }
  const ctx = makeCtx(agentsById, subagentsApi, extraServices);
  // 用**当前发布的入口文件**自测：和宿主真实加载路径一致。
  const pluginUrl = new URL(ENTRY, import.meta.url);
  const { apply } = await import(`${pluginUrl.href}?v=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  apply(ctx, { stateFile });
  // 路由是**懒注册**的（等 webServer 服务出现，见 index.js whenWebServer）：
  // fake ctx 里 webServer 立即可见，但仍需一个宏任务让注册完成。
  await new Promise((r) => { setTimeout(r, 5); });
  // 监视器现在挂在**根 ctx** 上（未打标签 → 全局放行）。让 agent.__emitEvent 走
  // 真实的派发路径：把事件交给根 ctx 的 session/event 监听器，并带上会话对象。
  for (const agent of agentsById.values()) {
    agent.__emitEvent = (event) => {
      for (const listener of [...ctx.__sessionEvents]) listener(agent.session, event);
    };
  }
  return ctx;
}

const humanUserMessage = (text, seq = 0, extraBlocks = []) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: {
    id: `u-${seq}`,
    role: 'user',
    content: [...(text === '' ? [] : [{ type: 'text', text }]), ...extraBlocks],
    source: { kind: 'user', rpcId: `rpc-${seq}` },
  },
});

// ── 用例 ───────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'dual-agent-v2-test-'));
const stateFile = join(dir, 'dual-agent.json');

// ① 启动 = 武装：不孵化 child，按钮回包带 note
{
  const agent = makeAgent('s1');
  const sub = fakeSubagents(async () => { throw new Error('should not hatch'); });
  const ctx = await startPlugin(stateFile, new Map([['s1', agent]]), sub);
  const result = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's1' });
  check('arm returns 200 armed', result.status === 200 && result.json.action === 'armed');
  check('no child hatched on arm', sub.__calls.filter((c) => c.interrupt === undefined).length === 0);
  check('armed note tells user to type', typeof result.json.note === 'string' && result.json.note.includes('初始指令'));
  check('two sections installed (critic+armed)', agent.__sections.length === 2);
  check('sections have finite order', agent.__sections.every((s) => Number.isFinite(s.order)));
}

// ② 用户键入初始指令 → 孵化执行者 + 转达主上下文（不评估）
// （s2 是全新会话：off + 点击 = 武装。①里 s1 已被武装，再点会解除。）
{
  const agent = makeAgent('s2');
  let hatchCount = 0;
  const sub = fakeSubagents(async () => {
    hatchCount += 1;
    return { childId: 'child-1' };
  });
  const ctx = await startPlugin(stateFile, new Map([['s2', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's2' }); // arm
  // 模拟 agent/created 已经触发（插件启动时注册的 watcher 需要 agent/created 事件装配）
  for (const l of ctx.__created) l({ agent });
  agent.__emitEvent(humanUserMessage('做一个导出功能，必须支持中文文件名'));
  await new Promise((r) => setTimeout(r, 10));
  check('executor hatched once on first user message', hatchCount === 1);
  const spec = sub.__calls[0];
  check('hatch via spawn provider', spec.provider === 'spawn');
  check('delivery caller（结算不自动唤醒主 Agent）', spec.delivery === 'caller');
  check('task text carries user message', spec.request.prompt[0].text.includes('中文文件名'));
  check('running note now', (await call(ctx, '/dsh-dual-agent/status?sessionId=s2', 'GET')).json.phase === 'running');
  // 双线路径的「阻塞」：孵化时主上下文必须**静默**（不投任何编排消息 = 主页面不出现
  // 新动作），回合被 cancel（keepInbox 保住消息）。这是用户观察到的缺陷的正解。
  check('hatch keeps main context silent (no new action)', agent.__followups.length === 0);
  check('hatch cancels main turn with keepInbox', agent.__cancels.some((c) => c.options?.keepInbox === true && c.cause?.kind === 'hook'));
  check('no evaluation on hatch', !agent.__followups.some((m) => m.content[0].text.includes('【挑刺者评估】')));
}

// ③ 智能体主动停止 → 评估轮（挑刺者以主上下文视角输出）
{
  const agent = makeAgent('s3');
  const sub = fakeSubagents(async () => ({ childId: 'child-1' }));
  const ctx = await startPlugin(stateFile, new Map([['s3', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's3' });
  for (const l of ctx.__created) l({ agent });
  agent.__emitEvent(humanUserMessage('做一个导出功能，必须支持中文文件名'));
  await new Promise((r) => setTimeout(r, 10));
  agent.__followups.length = 0;
  sub.__emitSubagentEnd({ id: 'child-1', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 5));
  const evalMsg = agent.__followups.find((m) => m.content[0].text.includes('【挑刺者评估】'));
  check('evaluation injected on natural stop', evalMsg !== undefined);
  check('evaluation names child and reason', evalMsg !== undefined && evalMsg.content[0].text.includes('child-1') && evalMsg.content[0].text.includes('completed'));
  check('evaluation message is producer-sourced', evalMsg.role === 'user' && evalMsg.source.kind === 'plugin:dsh-dual-agent');
  const status = await call(ctx, '/dsh-dual-agent/status?sessionId=s3', 'GET');
  check('back to armed after evaluation', status.json.phase === 'armed');
}

// ④ 用户手动停止（running→paused）→ 中断 child、不评估、note 变待命
{
  const agent = makeAgent('s4');
  const sub = fakeSubagents(async () => ({ childId: 'child-1' }));
  const ctx = await startPlugin(stateFile, new Map([['s4', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's4' });
  for (const l of ctx.__created) l({ agent });
  agent.__emitEvent(humanUserMessage('任务 A'));
  await new Promise((r) => setTimeout(r, 10));
  agent.__followups.length = 0;
  const stop = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's4' });
  check('manual stop returns paused', stop.json.action === 'paused');
  check('child interrupt requested', sub.__calls.some((c) => c.interrupt === 'child-1' && c.authority.kind === 'user'));
  check('back to armed after manual stop', stop.json.phase === 'armed');
  check('armed note after stop', typeof stop.json.note === 'string' && stop.json.note.includes('初始指令'));
  // 该次 disposal 的 end 事件（手动停止）→ 不评估
  sub.__emitSubagentEnd({ id: 'child-1', stopReason: 'aborted' });
  await new Promise((r) => setTimeout(r, 5));
  check('no evaluation after manual stop', !agent.__followups.some((m) => m.content[0].text.includes('【挑刺者评估】')));
  // 停止等待用户补充：再次用户消息 → 重新孵化（新 child）
  agent.__emitEvent(humanUserMessage('补充：还要支持长文件名', 1));
  await new Promise((r) => setTimeout(r, 10));
  const hatches = sub.__calls.filter((c) => c.interrupt === undefined && c.provider !== undefined);
  check('re-hatch on supplement after manual stop', hatches.length === 2);
  check('supplement carried into new task', hatches[1].request.prompt[0].text.includes('长文件名'));
}

// ⑤ armed→off：完全解除
{
  const agent = makeAgent('s5');
  const sub = fakeSubagents(async () => ({ childId: 'x' }));
  const ctx = await startPlugin(stateFile, new Map([['s5', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's5' }); // arm
  const off = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's5' });
  check('second click disarms', off.json.action === 'disarmed' && off.json.phase === 'off');
  const status = await call(ctx, '/dsh-dual-agent/status?sessionId=s5', 'GET');
  check('status off after disarm', status.json.phase === 'off');
}

// ⑥ 孵化失败 → 回 armed 并说明（等待用户重试）
{
  const agent = makeAgent('s6');
  const sub = fakeSubagents(async () => { throw new Error('spawn 不可用'); });
  const ctx = await startPlugin(stateFile, new Map([['s6', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's6' });
  for (const l of ctx.__created) l({ agent });
  agent.__emitEvent(humanUserMessage('任务 B'));
  await new Promise((r) => setTimeout(r, 10));
  const failMsg = agent.__followups.find((m) => m.content[0].text.includes('孵化失败'));
  check('hatch failure surfaces', failMsg !== undefined && failMsg.content[0].text.includes('spawn 不可用'));
  const status = await call(ctx, '/dsh-dual-agent/status?sessionId=s6', 'GET');
  check('back to armed after hatch failure', status.json.phase === 'armed');
}

// ⑦ 恢复：落盘 running 记录在「同进程重载、执行者还活着」时被**接管**（running），
//    轮询本身不改盘；执行者真的不在时才降级（见 ㉖）。
{
  const agentA = makeAgent('s7');
  const subA = fakeSubagents(async () => ({ childId: 'child-7' }));
  const ctxA = await startPlugin(stateFile, new Map([['s7', agentA]]), subA);
  await call(ctxA, '/dsh-dual-agent/action', 'POST', { sessionId: 's7' });
  for (const l of ctxA.__created) l({ agent: agentA });
  agentA.__emitEvent(humanUserMessage('任务 C'));
  await new Promise((r) => setTimeout(r, 10));
  const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('running persisted with child', onDisk.sessions['s7']?.phase === 'running' && onDisk.sessions['s7']?.childId === 'child-7');
  const agentB = makeAgent('s7');
  // 同进程：执行者仍在 ctx.agents 里（宿主表是进程级的），新实例必须接管而不是降级。
  const ctxB = await startPlugin(stateFile, new Map([['s7', agentB], ['child-7', makeAgent('child-7')]]), fakeSubagents(async () => ({ childId: 'y' })));
  const status = await call(ctxB, '/dsh-dual-agent/status?sessionId=s7', 'GET');
  check('status adopts a live executor instead of downgrading it', status.json.phase === 'running' && status.json.running === true);
  const afterPoll = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('status polling does not rewrite the running record',
    afterPoll.sessions['s7']?.phase === 'running' && afterPoll.sessions['s7']?.childId === 'child-7',
    JSON.stringify(afterPoll.sessions?.s7 ?? null));
  // 接管后执行者自然停 → 结算（这里没有可读报告，故以「报告未取回」收尾）。
  await new Promise((r) => setTimeout(r, 1_600));
  const settled = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('adopted reload settles after the executor stops', settled.sessions['s7']?.phase === 'armed');
}

// ⑧ 人类消息过滤：非 rpcId 的注入消息不触发孵化；挑刺者评估轮也不触发
{
  const agent = makeAgent('s8');
  let hatchCount = 0;
  const sub = fakeSubagents(async () => { hatchCount += 1; return { childId: 'c' }; });
  const ctx = await startPlugin(stateFile, new Map([['s8', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's8' });
  for (const l of ctx.__created) l({ agent });
  // 插件编排消息（真实形态：kind:'plugin:dsh-dual-agent'，不是裸 user）绝不孵化。
  agent.__emitEvent({ type: 'user/message', seq: 1, time: Date.now(), data: { id: 'p1', role: 'user', content: [{ type: 'text', text: '插件注入' }], source: { kind: 'plugin:dsh-dual-agent', form: 'notice' } } });
  await new Promise((r) => setTimeout(r, 5));
  check('plugin-injected message does not hatch', hatchCount === 0);
  // 挑刺者评估轮（真实形态同样是 plugin 源）：即便带前缀也不孵化；前缀过滤是同源伪造的防御。
  agent.__emitEvent({ type: 'user/message', seq: 2, time: Date.now(), data: { id: 'e1', role: 'user', content: [{ type: 'text', text: '【挑刺者评估】评估' }], source: { kind: 'plugin:dsh-dual-agent' } } });
  await new Promise((r) => setTimeout(r, 5));
  check('critic evaluation message does not hatch', hatchCount === 0);
  // 但**人类**输入即便不带 rpcId（ACP/headless/SDK 形态）也要孵化——这是放宽闸门的目的。
  agent.__emitEvent({ type: 'user/message', seq: 3, time: Date.now(), data: { id: 'h1', role: 'user', content: [{ type: 'text', text: '无 rpcId 的人类指令' }], source: { kind: 'user' } } });
  await new Promise((r) => setTimeout(r, 20));
  check('human message without rpcId hatches', hatchCount === 1);
}

// ⑨ 会话销毁 → 全拆清账
{
  const agent = makeAgent('s9');
  const ctx = await startPlugin(stateFile, new Map([['s9', agent]]), fakeSubagents(async () => ({ childId: 'c' })));
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's9' });
  ctx.__emitDisposed(agent);
  const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
  check('dispose clears persisted record', onDisk.sessions['s9'] === undefined);
}

// ⑩ 错误形态：Agent 不在线 409、跨站 403、缺 sessionId 400
{
  const ctx = await startPlugin(stateFile, new Map(), fakeSubagents(async () => ({ childId: 'c' })));
  const ghost = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 'ghost' });
  check('unknown session → 409', ghost.status === 409);
  const agent = makeAgent('s10');
  const ctx2 = makeCtx(new Map([['s10', agent]]), fakeSubagents(async () => ({ childId: 'c' })));
  const pluginUrl = new URL('./entry-v10.js', import.meta.url);
  const { apply } = await import(`${pluginUrl.href}?v=${Date.now()}`);
  apply(ctx2, { stateFile });
  await new Promise((r) => { setTimeout(r, 5); }); // 等懒注册完成（同 startPlugin）
  const cross = await call(ctx2, '/dsh-dual-agent/action', 'POST', { sessionId: 's10' }, 'http://evil.example');
  check('cross-origin rejected 403', cross.status === 403);
  const missing = await call(ctx2, '/dsh-dual-agent/action', 'POST', {});
  check('missing sessionId → 400', missing.status === 400);
}

// ⑪ 关键装配路径：**没有 agent/created**（会话早已存在）时点按钮，
//     用户消息仍须触发孵化——监视器必须由 /action 直接装上，
//     不能指望「插件装载后才新建的会话」才有的 agent/created 事件。
{
  const agent = makeAgent('s11');
  let hatched = 0;
  const sub = fakeSubagents(async () => { hatched += 1; return { childId: 'child-11' }; });
  const ctx = await startPlugin(stateFile, new Map([['s11', agent]]), sub);
  // 刻意不发射 ctx.__created —— 模拟「用户在既有会话里点启动」。
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's11' });
  agent.__emitEvent(humanUserMessage('既有会话里的任务'));
  await new Promise((r) => setTimeout(r, 10));
  check('hatch works without agent/created (existing session)', hatched === 1);
  check('child recorded', (await call(ctx, '/dsh-dual-agent/status?sessionId=s11', 'GET')).json.childId === 'child-11');
}

// ⑫ 迟到的 end（抑制窗口外）仍按主动停止处理：不能永久吞掉评估
{
  const agent = makeAgent('s12');
  const sub = fakeSubagents(async () => ({ childId: 'child-12' }));
  const ctx = await startPlugin(stateFile, new Map([['s12', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's12' });
  agent.__emitEvent(humanUserMessage('任务 D', 0));
  await new Promise((r) => setTimeout(r, 10));
  agent.__followups.length = 0;
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's12' }); // 手动停止 → 抑制窗口打开
  // 模拟 end 晚到（把抑制起点改到 30s 前，越过 15s 窗口）
  sub.__emitSubagentEnd({ id: 'child-12', stopReason: 'aborted' });
  await new Promise((r) => setTimeout(r, 5));
  const suppressed = agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】'));
  check('late abort inside window is suppressed', suppressed.length === 0);
}

// ⑫b 静态守卫：插件对 subagents 的调用必须全部落在真实服务面上。
// 这条挡住过真实缺陷：`subagents.queuePrompt(...)` 并不存在（它只在内部 manager 上），
// 运行时抛 TypeError 被 catch 吞成「转达失败」，功能静默死亡。fake 若跟着 stub
// 不存在的方法，自测就永远测不出来——所以这里对**源码**做白名单校验。
{
  const SUBAGENT_SERVICE_METHODS = new Set([
    'resolveMaxDepth', 'startActivation', 'waitForChildren', 'sendMessage', 'interrupt',
    'drainDescendants', 'drainChildren', 'listChildren', 'listDescendants', 'prompt',
    'interruptByParent', 'registerProvider', 'getProvider', 'list',
  ]);
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const called = new Set();
  for (const match of source.matchAll(/\bsubagents\??\.(\w+)\s*\(/g)) called.add(match[1]);
  const unknown = [...called].filter((name) => !SUBAGENT_SERVICE_METHODS.has(name));
  check('every subagents method call exists on the service surface', unknown.length === 0);
  if (unknown.length > 0) console.log('  unknown:', unknown.join(', '));
}

// ⑬ UI 契约：status/action 回包必须带 boolean running（工作箱按钮据此判定）
{
  const agent = makeAgent('s13');
  const ctx = await startPlugin(stateFile, new Map([['s13', agent]]), fakeSubagents(async () => ({ childId: 'c13' })));
  const off = await call(ctx, '/dsh-dual-agent/status?sessionId=s13', 'GET');
  check('status running is boolean when off', typeof off.json.running === 'boolean' && off.json.running === false);
  const armed = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's13' });
  check('action carries boolean running (armed)', armed.json.running === true && armed.json.armed === true && armed.json.phase === 'armed');
  const st = await call(ctx, '/dsh-dual-agent/status?sessionId=s13', 'GET');
  check('status carries boolean running (armed)', st.json.running === true && st.json.phase === 'armed' && typeof st.json.note === 'string');
}

// ⑭ running 期用户补充要转达给执行者（需求里的「补充要有去处」）
{
  const agent = makeAgent('s14');
  const sub = fakeSubagents(async () => ({ childId: 'child-14' }));
  const ctx = await startPlugin(stateFile, new Map([['s14', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's14' });
  agent.__emitEvent(humanUserMessage('初始任务', 0));
  await new Promise((r) => setTimeout(r, 20));
  check('child hatched for initial task', sub.__calls.some((c) => c.provider !== undefined));
  agent.__emitEvent(humanUserMessage('补充：还要支持长文件名', 1));
  await new Promise((r) => setTimeout(r, 20));
  const relays = sub.__calls.filter((c) => c.sendMessage === 'child-14');
  check('supplement relayed to executor', relays.length >= 1);
  check('relay carries supplement text', relays.length >= 1 && relays[0].content[0].text.includes('长文件名'));
  check('relay goes through the published sendMessage surface', relays.length >= 1 && relays[0].hasSignal === true);
  // 双线路径的「阻塞」：补充成功转达后主上下文必须**静默**（不投「已转达」消息），
  // 且这条补充触发的回合被 cancel。主页面出现新动作正是用户报告的缺陷。
  check('relay keeps main context silent', agent.__followups.length === 0);
  check('supplement turn cancelled', agent.__cancels.length >= 2);
}

// ⑮ 纯附件（无文字）的初始指令必须孵化，且附件要原样交给执行者。
// 只取 text 块会让「改这张图」变成空任务：主上下文被待命段告知不要自己执行，
// 执行者又拿不到材料，于是没有任何一方处理这条消息。
{
  const agent = makeAgent('s15');
  const sub = fakeSubagents(async () => ({ childId: 'child-15' }));
  const ctx = await startPlugin(stateFile, new Map([['s15', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's15' });
  agent.__emitEvent(humanUserMessage('', 0, [{
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1024, width: 800, height: 600 },
  }]));
  await new Promise((r) => setTimeout(r, 20));
  const spec = sub.__calls.find((c) => c.provider !== undefined);
  check('attachment-only message hatches', spec !== undefined);
  const prompt = spec?.request?.prompt ?? [];
  check('image block forwarded to executor', prompt.some((block) => block.type === 'image'));
  check('task tail appended after blocks', prompt.length >= 2 && prompt.at(-1).type === 'text' && prompt.at(-1).text.length > 0);
}

// ⑯ 开关语义：enabled=true 幂等武装；enabled=false 从 running 直接关闭，
//     中断执行者且不挑刺（开关是二态的，不再靠「下一次点击该进哪一态」猜测）。
{
  const agent = makeAgent('s16');
  const sub = fakeSubagents(async () => ({ childId: 'child-16' }));
  const ctx = await startPlugin(stateFile, new Map([['s16', agent]]), sub);

  const on = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's16', enabled: true });
  check('switch on arms', on.json.phase === 'armed' && on.json.running === true && on.json.action === 'armed');
  const onAgain = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's16', enabled: true });
  check('switch on is idempotent', onAgain.json.phase === 'armed' && onAgain.json.action === 'unchanged');

  agent.__emitEvent(humanUserMessage('任务 E', 0));
  await new Promise((r) => setTimeout(r, 20));
  check('switch on + instruction hatches', (await call(ctx, '/dsh-dual-agent/status?sessionId=s16', 'GET')).json.phase === 'running');

  agent.__followups.length = 0;
  const off = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's16', enabled: false });
  check('switch off from running lands off', off.json.phase === 'off' && off.json.running === false);
  check('switch off interrupts executor', sub.__calls.some((c) => c.interrupt === 'child-16'));
  check('switch off does not critique', agent.__followups.every((m) => !m.content[0].text.includes('【挑刺者评估】')));

  sub.__emitSubagentEnd({ id: 'child-16', stopReason: 'aborted' });
  await new Promise((r) => setTimeout(r, 10));
  check('interrupted child settlement stays uncriticised', agent.__followups.every((m) => !m.content[0].text.includes('【挑刺者评估】')));
  check('switch off is idempotent', (await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's16', enabled: false })).json.action === 'unchanged');
}

// ⑰ UX：running 透出 hatchAt 锚点 + 阻塞语义说明；armed 就绪警告（时长格式化在客户端）。
{
  const agent = makeAgent('s17');
  const sub = fakeSubagents(async () => ({ childId: 'child-17' }));
  const ctx = await startPlugin(stateFile, new Map([['s17', agent]]), sub);
  const armedRes = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's17', enabled: true });
  check('armed note (ready) tells user to type', armedRes.json.note.includes('初始指令') && !armedRes.json.note.includes('无法孵化'));
  agent.__emitEvent(humanUserMessage('任务 U', 0));
  await new Promise((r) => setTimeout(r, 20));
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s17', 'GET')).json;
  check('running note explains blocking silence', typeof st.note === 'string' && st.note.includes('主对话已让位'));
  check('running note has no server-side elapsed (client owns timer)', !st.note.includes('已工作'));
  check('status exposes hatchAt for client timer', typeof st.hatchAt === 'number' && st.hatchAt > 0);
  check('hatchAt null when not running', (() => true)()); // armed 会话的 hatchAt=null 见 ⑰b
}
{
  // ⑰b armed（未 running）时 hatchAt 必须是 null，客户端据此不挂计时器。
  const agent = makeAgent('s17b');
  const sub = fakeSubagents(async () => ({ childId: 'c' }));
  const ctx = await startPlugin(stateFile, new Map([['s17b', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's17b', enabled: true });
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s17b', 'GET')).json;
  check('armed hatchAt is null', st.hatchAt === null);
}
{
  // armed note 在没有任何可用 provider 时显式警告，而不是等用户键入后才失败。
  const agent = makeAgent('s18');
  const ctx = await startPlugin(stateFile, new Map([['s18', agent]]),
    fakeSubagents(async () => ({ childId: 'x' }), { providers: [{ name: 'fork', inheritsParentContext: true }] }));
  const res = await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's18', enabled: true });
  check('armed note warns when hatch not ready', res.json.note.includes('无法孵化执行者'), res.json.note);
  check('status hatch.ready false surfaced', res.json.hatch.ready === false);
}

// ⑱ 评估轮兜底：注入后该轮 error 且无正文 → 自动重试一次 → 再失败给可读兜底。
{
  const agent = makeAgent('s19');
  const sub = fakeSubagents(async () => ({ childId: 'child-19' }));
  const ctx = await startPlugin(stateFile, new Map([['s19', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's19', enabled: true });
  agent.__emitEvent(humanUserMessage('任务 V', 0));
  await new Promise((r) => setTimeout(r, 20));
  agent.__followups.length = 0;
  sub.__emitSubagentEnd({ id: 'child-19', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 10));
  const critic1 = agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length;
  check('natural settle injects critic round', critic1 === 1);
  // 评估轮自己失败（额度/网络），没有 assistant 正文 → 应自动重试一次。
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((r) => setTimeout(r, 10));
  const critic2 = agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length;
  check('failed critic auto-retries once', critic2 === 2, `injections=${critic2}`);
  // 重试轮又失败 → 可读兜底（不再无限重试）。
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((r) => setTimeout(r, 10));
  const giveUp = agent.__followups.filter((m) => m.content[0].text.includes('评估连续未能产出')).length;
  const critic3 = agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length;
  check('second failure surfaces readable fallback', giveUp === 1, `giveUp=${giveUp}`);
  check('no third retry (bounded)', critic3 === 2);
  // 兜底清账：后续无关的 turn/end 不再触发任何注入。
  agent.__followups.length = 0;
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((r) => setTimeout(r, 10));
  check('idle turns after fallback stay silent', agent.__followups.length === 0);
}
{
  // ⑱b 评估轮 error 但**已产出正文**（残帧）→ 不重试（用户看得见内容）。
  const agent = makeAgent('s20');
  const sub = fakeSubagents(async () => ({ childId: 'child-20' }));
  const ctx = await startPlugin(stateFile, new Map([['s20', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's20', enabled: true });
  agent.__emitEvent(humanUserMessage('任务 W', 0));
  await new Promise((r) => setTimeout(r, 20));
  agent.__followups.length = 0;
  sub.__emitSubagentEnd({ id: 'child-20', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 10));
  agent.__snapshot.push({ type: 'assistant/message', seq: agent.session.seq + 1 });
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((r) => setTimeout(r, 10));
  check('partial-text critic error does not retry',
    agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length === 1
    && agent.__followups.filter((m) => m.content[0].text.includes('评估连续未能产出')).length === 0);
}
{
  // ⑱c 用户手动打断评估轮（aborted）= 明确意图：静默清账，不重试不兜底。
  const agent = makeAgent('s21');
  const sub = fakeSubagents(async () => ({ childId: 'child-21' }));
  const ctx = await startPlugin(stateFile, new Map([['s21', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's21', enabled: true });
  agent.__emitEvent(humanUserMessage('任务 X', 0));
  await new Promise((r) => setTimeout(r, 20));
  agent.__followups.length = 0;
  sub.__emitSubagentEnd({ id: 'child-21', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 10));
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  await new Promise((r) => setTimeout(r, 10));
  check('manual interrupt of critic round stays silent',
    agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length === 1);
  // 下一次自然结算重新计一次重试（兜底状态没被毒化）。
  agent.__emitEvent(humanUserMessage('任务 Y', 1));
  await new Promise((r) => setTimeout(r, 20));
  sub.__emitSubagentEnd({ id: 'child-21', stopReason: 'completed' }); // 第二个 child 复用同 id
  await new Promise((r) => setTimeout(r, 10));
  const criticsAfterSecondSettle = agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length;
  check('second task injects a fresh critic', criticsAfterSecondSettle === 2, `critics=${criticsAfterSecondSettle}`);
  // 这一轮的评估轮又 error（无正文）→ 重试预算应已刷新，注入第三条。
  agent.__emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((r) => setTimeout(r, 10));
  check('retry budget refreshes next round',
    agent.__followups.filter((m) => m.content[0].text.includes('【挑刺者评估】')).length === 3);
}

// ⑲ 角度抽取质量（纯函数）：点名必须是**可验证维度**，不是任务复述。
{
  const { extractAngles } = await import(`${new URL('./entry-v8.js', import.meta.url).href}?ang=${Date.now()}`);
  const hinted = extractAngles(['写一个计算斐波那契数列的函数，必须支持中文文件名，还要说明复杂度']);
  check('requirement-bearing fragment preferred (hinted first)', hinted[0]?.text === '必须支持中文文件名', `first=${hinted[0]?.text}`);
  check('hinted fragment marked as hinted', hinted[0]?.hinted === true);
  const restate = extractAngles(['为窗口甲生成季度总结']);
  check('whole-sentence task restatement is NOT an angle', restate.length === 0, JSON.stringify(restate));
  // 回归：单字暗示词误判——「会议纪要」含「要」、「需求/所需」含「需」，都**不是**要求。
  const falsePos = extractAngles(['整理一份本周的会议纪要并输出', '分析系统所需资源']);
  check('no false-positive hints from 要/需 inside ordinary nouns',
    falsePos.every((a) => a.hinted === false) && !falsePos.some((a) => a.text === '整理一份本周的会议纪要并输出'),
    JSON.stringify(falsePos.map((a) => `${a.text}(${a.hinted})`)));
  const short = extractAngles(['把响应速度']);   // ≤8 字无暗示词：名词短语，可作维度
  check('short noun phrase still usable as angle', short.some((a) => a.text === '把响应速度'), JSON.stringify(short));
  const mixed = extractAngles(['整理一份本周的会议纪要并输出', '必须覆盖行动项']);
  check('hinted piece ranks first; long restatement excluded',
    mixed[0]?.text === '必须覆盖行动项' && mixed.every((a) => a.text !== '整理一份本周的会议纪要并输出'),
    JSON.stringify(mixed.map((a) => a.text)));
  const empty = extractAngles([]);
  check('no user text -> no angles (caller falls back to built-ins)', empty.length === 0);
}

// ⑳ 执行者活性透出（running 中「安静 ≠ 卡死」的可分辨性）：
//     statusOf 只读探测 child agent 的存活/状态，note 追加人话后缀；任何异常吞掉回 null。
{
  const agent = makeAgent('s22');
  const child = makeAgent('child-22');       // 执行者：同一 agentsById，可被 get 到
  child.status = 'running';
  const agentsById = new Map([['s22', agent], ['child-22', child]]);
  const sub = fakeSubagents(async () => ({ childId: 'child-22' }));
  const ctx = await startPlugin(stateFile, agentsById, sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's22', enabled: true });
  agent.__emitEvent(humanUserMessage('任务 Z', 0));
  await new Promise((r) => setTimeout(r, 20));
  const stRun = (await call(ctx, '/dsh-dual-agent/status?sessionId=s22', 'GET')).json;
  check('running status exposes childLive/childStatus',
    stRun.childLive === true && stRun.childStatus === 'running', `live=${stRun.childLive} status=${stRun.childStatus}`);
  check('busy child gets no alarming suffix', !stRun.note.includes('已不在本进程') && !stRun.note.includes('等待编排结算'));
  // 执行者 idle（本轮已停、等待结算）→ note 说明，不让用户以为卡死。
  child.status = 'idle';
  const stIdle = (await call(ctx, '/dsh-dual-agent/status?sessionId=s22', 'GET')).json;
  check('idle child note says awaiting settlement', stIdle.note.includes('等待编排结算'), stIdle.note.slice(-60));
  // 执行者消失（进程内已无该 agent）→ 不再宣称「执行中」：收敛回待命并说明
  // 报告没取回（v18；旧行为是挂着 running + 一句「已不在本进程」的警告，永远不会好）。
  agentsById.delete('child-22');
  const stGone = (await call(ctx, '/dsh-dual-agent/status?sessionId=s22', 'GET')).json;
  check('gone child is no longer reported as executing', stGone.phase === 'armed' && stGone.running === true,
    `phase=${stGone.phase}`);
  await new Promise((r) => setTimeout(r, 40));
  const stGone2 = (await call(ctx, '/dsh-dual-agent/status?sessionId=s22', 'GET')).json;
  check('gone child note says the old executor has ended',
    String(stGone2.note).includes('插件重载/进程重启时丢失'), String(stGone2.note).slice(0, 40));
  check('gone child settlement explains the lost report once',
    agent.__followups.filter((m) => (m.content[0]?.text ?? '').includes('没有回到主上下文')).length === 1,
    `n=${agent.__followups.length}`);
  // armed 态不探测（无 child），字段为 null。
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's22', enabled: false });
  const stOff = (await call(ctx, '/dsh-dual-agent/status?sessionId=s22', 'GET')).json;
  check('off/armed status has null child liveness', stOff.childLive === null && stOff.childStatus === null);
}

// ㉑ 进程重启恢复：落盘 phase=running → 恢复成 armed 且**明说旧执行者已中断**，
//     用户发新任务后提示清除（不永久残留）。
{
  // 预置一个「上次进程死在 running」的落盘状态。
  const sf = join(dir, 'recover.json');
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { 's23': { phase: 'running', childId: 'ghost-child', updatedAt: Date.now() } },
  }), 'utf8');
  const agent = makeAgent('s23');
  const sub = fakeSubagents(async () => ({ childId: 'c23' }));
  const ctx = await startPlugin(sf, new Map([['s23', agent]]), sub);
  // 插件装载后新建会话的兜底（agent/created）会接上恢复出的武装会话。
  for (const l of ctx.__created) l({ agent });
  await new Promise((r) => setTimeout(r, 10));
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s23', 'GET')).json;
  check('running record downgraded to armed on recovery', st.phase === 'armed' && st.childId === null, `phase=${st.phase} child=${st.childId}`);
  check('recovery note explains the interrupted executor', typeof st.note === 'string' && st.note.includes('插件重载/进程重启时丢失'), st.note);
  // 落盘也已纠偏（此时还没发新任务，记录应已是 armed、无 childId）。
  const onDisk = JSON.parse(readFileSync(sf, 'utf8'));
  check('persisted phase corrected to armed on recovery', onDisk.sessions['s23']?.phase === 'armed' && onDisk.sessions['s23']?.childId === undefined,
    JSON.stringify(onDisk.sessions?.['s23'] ?? null));
  // 用户发新任务 → 提示清除，回到标准待命文案。
  agent.__emitEvent(humanUserMessage('重试任务', 0));
  await new Promise((r) => setTimeout(r, 20));
  const st2 = (await call(ctx, '/dsh-dual-agent/status?sessionId=s23', 'GET')).json;
  check('new task clears the interruption notice', !String(st2.note).includes('插件重载/进程重启时丢失') && String(st2.note).includes('主对话已让位'), String(st2.note).slice(0, 40));
  // 新任务孵化后落盘回到 running+新 childId（setChild 的既有语义）。
  const onDisk2 = JSON.parse(readFileSync(sf, 'utf8'));
  check('new task persists running with fresh child', onDisk2.sessions['s23']?.phase === 'running' && onDisk2.sessions['s23']?.childId === 'c23',
    JSON.stringify(onDisk2.sessions?.['s23'] ?? null));
}

// ㉒ 幽灵 running 的诚实口径：落盘 running 但会话不在本进程（无 run、无 agent）时，
//     note 绝不能宣称「执行者独立工作中」——那是个幽灵状态。
{
  const sf = join(dir, 'orphan.json');
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { 'ghost-session': { phase: 'running', childId: 'ghost', since: Date.now() } },
  }), 'utf8');
  const agentsById = new Map();
  const ctx = await startPlugin(sf, agentsById, fakeSubagents(async () => ({ childId: 'c' })));
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=ghost-session', 'GET')).json;
  check('orphan running keeps honest phase', st.phase === 'running' && st.agentLive === false, `phase=${st.phase} live=${st.agentLive}`);
  check('orphan note does not claim executor is working',
    typeof st.note === 'string' && !st.note.includes('执行者独立工作') && st.note.includes('不在本进程'), st.note);
  // 一旦会话真的上线（agent/created → ensureRun），立刻降级 armed + 中断说明。
  const agent = makeAgent('ghost-session');
  agentsById.set('ghost-session', agent);
  for (const l of ctx.__created) l({ agent });
  await new Promise((r) => setTimeout(r, 10));
  const st2 = (await call(ctx, '/dsh-dual-agent/status?sessionId=ghost-session', 'GET')).json;
  check('live session downgrades to armed with interruption note',
    st2.phase === 'armed' && String(st2.note).includes('插件重载/进程重启时丢失'), `phase=${st2.phase} note=${String(st2.note).slice(0, 30)}`);
}

// ㉓ 报告嵌入截断（长报告不整体灌进主会话上下文）。
{
  const { reportTextOf } = await import(`${new URL(ENTRY, import.meta.url).href}?rep=${Date.now()}`);
  const mk = (n) => ({ output: [{ type: 'text', text: 'x'.repeat(n) }] });
  const short = reportTextOf(mk(100));
  check('short report passes through untouched', short.length === 100 && !short.includes('省略'));
  const long = reportTextOf(mk(40_000));
  check('long report truncated to limit', long.length < 13_000 && long.includes('省略'), `len=${long.length}`);
  check('truncation keeps head and tail', long.startsWith('x') && long.endsWith('x'));
  check('truncation states how much was dropped', /省略 \d+ 字/.test(long));
  const noText = reportTextOf({ output: [], diagnostic: 'boom' });
  check('no-text falls back to diagnostic', noText.includes('boom'), noText);
  const empty = reportTextOf({ output: [] });
  check('empty report has readable placeholder', empty.includes('未产出可读正文'), empty);
}

// ㉔ 模型-facing 提示契约（防回退）：挑刺者必须被要求「追更有表现力的指标」，
//    running 段不能说 stale 的「settlement 通知」（caller 模式没有它）。
{
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  check('critic persona demands sharper indicators', src.includes('指标的「表现力」是你的核心追求'));
  check('critic persona forbids repeating used indicators', src.includes('已用过的指标不要再原样重复'));
  check('evaluate prompt demands judgeable indicator', src.includes('在 X 输入下必须返回 Y'));
  check('running prompt no longer claims settlement notice (caller mode)',
    !/带 settlement 通知的那个孩子/.test(src) && src.includes('由编排把报告取回并送入本会话'));
  check('running prompt still forbids re-executing the task', src.includes('不要重复执行任务本体'));
  // 补充转达的真实语义：成功静默（无回执）、失败才有【双主智能编排】说明。
  // prompt 不许承诺一个不存在的「已转达」回执（v1 遗留，会误导模型自己声明已转达）。
  check('running prompt does not promise a 已转达 receipt',
    !/「已转达/.test(src) && src.includes('转达成功时编排保持静默'));
  // 死代码守卫：RUNNING_TAIL（v2 delivery:'parent' 遗留）应保持删除状态。
  check('dead constant RUNNING_TAIL stays removed', !/const RUNNING_TAIL/.test(src));
  // round 24 审计：child 任务尾不得承诺「中途文字小结」（caller 模式无回传通道）。
  check('child task tail does not promise mid-task reporting',
    !src.includes('中途结论也可以提前用文字小结') && src.includes('收尾消息'));
  // round 24 审计：停止情形人话化，不得出现「已完成任务（停止原因：error）」式自相表述。
  check('stop reason has honest labels', src.includes('因错误中止（未完成）') && src.includes('stopReasonLabel'));
  check('evaluate prompt no longer claims 已完成任务 unconditionally',
    !/执行者（subagent \$\{childId\}）已完成任务/.test(src));
  // orphan note 不得同义重复（正文已说清 + 后缀重复）。
  check('orphan note has no duplicated liveness suffix', !/orphan \? '（该会话不在本进程/.test(src));
}

// ㉕ 多轮闭环：第二轮孵化必须带上**上一轮挑刺者评估**作为上下文，
//     否则零父上下文的执行者看不懂「按第 2 点改」这类指代。
{
  const agent = makeAgent('s26');
  const sub = fakeSubagents(async () => ({ childId: 'c26' }));
  const ctx = await startPlugin(stateFile, new Map([['s26', agent]]), sub);
  await call(ctx, '/dsh-dual-agent/action', 'POST', { sessionId: 's26', enabled: true });
  agent.__emitEvent(humanUserMessage('第一轮任务', 0));
  await new Promise((r) => setTimeout(r, 20));
  sub.__emitSubagentEnd({ id: 'c26', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 10));
  // 挑刺者这一轮真的产出正文（真实内核里这是自然的 assistant/message 事件）——
  // 编排靠它把**结论**收进历史，下一轮执行者才带得上。
  agent.__emitEvent({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '【挑刺者】第1轮结论：边界条件未覆盖。' }] } } });
  await new Promise((r) => setTimeout(r, 10));
  const firstCritic = agent.__followups.find((m) => m.content[0].text.includes('【挑刺者评估】'));
  check('round 1 critic injected', firstCritic !== undefined);
  // 第二轮：用户只说要改，不带上下文——执行者必须仍看得到上一轮评估。
  agent.__emitEvent(humanUserMessage('按上面的第 2 点改', 1));
  await new Promise((r) => setTimeout(r, 20));
  const hatches = sub.__calls.filter((c) => c.provider !== undefined);
  check('second hatch happened', hatches.length === 2, `hatches=${hatches.length}`);
  const blocks = hatches[1]?.request?.prompt ?? [];
  const prior = blocks.find((b) => b.type === 'text' && String(b.text).includes('最近几轮挑刺者评估结论'));
  check('round 2 prompt carries prior critique', prior !== undefined, `blocks=${blocks.length}`);
  check('prior critique is truncated/bounded', prior === undefined || prior.text.length < 14_000, `len=${prior?.text.length ?? -1}`);
  check('prior critique marked as not the child own record', prior?.text.includes('它不是你的工作记录') === true);
  // 第三轮验证**滚动更新**：评估历史增长，带的是最近几轮而不是只有第一轮。
  sub.__emitSubagentEnd({ id: 'c26', stopReason: 'completed' });
  await new Promise((r) => setTimeout(r, 10));
  agent.__emitEvent({ type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'text', text: '【挑刺者】第2轮结论：文档仍不完整。' }] } } });
  await new Promise((r) => setTimeout(r, 10));
  agent.__emitEvent(humanUserMessage('再改一轮', 2));
  await new Promise((r) => setTimeout(r, 20));
  const hatches3 = sub.__calls.filter((c) => c.provider !== undefined);
  const prior3 = (hatches3[2]?.request?.prompt ?? []).find((b) => b.type === 'text' && String(b.text).includes('最近几轮挑刺者评估结论'));
  check('third hatch carries a rolling history', prior3 !== undefined && prior3.text !== prior?.text);
  // 深度有界：连跑 6 轮，历史块不超过 CRITIQUE_HISTORY_DEPTH 条。
  for (let r = 3; r <= 6; r += 1) {
    sub.__emitSubagentEnd({ id: 'c26', stopReason: 'completed' });
    await new Promise((r2) => setTimeout(r2, 10));
    agent.__emitEvent({ type: 'assistant/message', seq: 10 + r, data: { message: { content: [{ type: 'text', text: `【挑刺者】第${r}轮结论：仍有第${r}类差距。` }] } } });
    await new Promise((r2) => setTimeout(r2, 10));
    agent.__emitEvent(humanUserMessage(`第${r}轮`, r));
    await new Promise((r2) => setTimeout(r2, 20));
  }
  const allHatches = sub.__calls.filter((c) => c.provider !== undefined);
  const last = (allHatches[allHatches.length - 1]?.request?.prompt ?? []).find((b) => b.type === 'text' && String(b.text).includes('最近几轮挑刺者评估结论'));
  const items = last ? (last.text.match(/—— 第 \d+ 条 ——/g) ?? []).length : 0;
  check('critique history stays bounded (max 3)', items <= 3, `items=${items}`);
}

// ── v18：结算自愈（用户报障「后台执行者结束、前台仍执行中」） ────────────────
const messageTextOf = (message) => (message?.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text ?? '')
  .join('');
const followupTexts = (agent) => agent.__followups.map(messageTextOf);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ㉖ 幽灵 running（执行者已不在、会话也读不回来）：status 不得再宣称「执行中」，
//     落盘要收敛成 armed，且只投一条「报告未取回」——重复轮询不得重复投。
{
  const sf = join(dir, 'ghost.json');
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { s27: { phase: 'running', childId: 'gone-child', since: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } },
  }), 'utf8');
  const agent = makeAgent('s27');
  const sub = fakeSubagents(async () => ({ childId: 'c27' }));
  const ctx = await startPlugin(sf, new Map([['s27', agent]]), sub);
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s27', 'GET')).json;
  check('ghost running is no longer reported as executing', st.phase === 'armed', `phase=${st.phase}`);
  check('ghost status keeps the recorded child id for diagnosis', st.childId === 'gone-child', `child=${st.childId}`);
  check('ghost status exposes the build marker', st.build === '3.5.0+reconcile', String(st.build));
  await sleep(40);
  const onDisk = JSON.parse(readFileSync(sf, 'utf8'));
  check('ghost running converges to armed on disk',
    onDisk.sessions.s27?.phase === 'armed' && onDisk.sessions.s27?.childId === undefined,
    JSON.stringify(onDisk.sessions?.s27 ?? null));
  const notices = () => followupTexts(agent).filter((text) => text.includes('没有回到主上下文'));
  check('ghost settlement explains the lost report once', notices().length === 1, `n=${notices().length}`);
  await call(ctx, '/dsh-dual-agent/status?sessionId=s27', 'GET');
  await call(ctx, '/dsh-dual-agent/status?sessionId=s27', 'GET');
  await sleep(40);
  check('repeated polling does not duplicate the notice', notices().length === 1, `n=${notices().length}`);
}

// ㉗ 幽灵 running + 执行者会话可读：把报告读回来照常评估，而不是只说"丢了"。
{
  const sf = join(dir, 'ghost-report.json');
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { s28: { phase: 'running', childId: 'report-child', since: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } },
  }), 'utf8');
  let disposed = 0;
  const sessionQuery = {
    async observeSession() {
      return {
        events: [
          { type: 'assistant/message', seq: 1, time: 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '执行者最终报告：已修好 3 处。' }] } } },
          { type: 'turn/end', seq: 2, time: 2, data: { reason: { kind: 'completed' } } },
        ],
        [Symbol.dispose]() { disposed += 1; },
      };
    },
  };
  const agent = makeAgent('s28');
  const ctx = await startPlugin(sf, new Map([['s28', agent]]), fakeSubagents(async () => ({ childId: 'c28' })), { sessionQuery });
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s28', 'GET')).json;
  check('ghost with readable report leaves executing state immediately', st.phase === 'armed', `phase=${st.phase}`);
  await sleep(40);
  const critics = followupTexts(agent).filter((text) => text.includes('【挑刺者评估】'));
  check('recovered report is evaluated as a normal settlement', critics.length === 1, `n=${critics.length}`);
  check('recovered report reaches the critic prompt', critics[0]?.includes('已修好 3 处') === true, critics[0]?.slice(0, 60));
  check('recovered-report path does not also send the lost notice',
    !followupTexts(agent).some((text) => text.includes('没有回到主上下文')));
  check('session observation lease is disposed', disposed === 1, `n=${disposed}`);
}

// ㉘ 重载后执行者仍活着：接管它（不误判为待命/幽灵），停了再结算，报告照样评估。
{
  const sf = join(dir, 'adopt.json');
  const parent = makeAgent('s29');
  const child = makeAgent('live-child');
  const agentsById = new Map([['s29', parent], ['live-child', child]]);
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { s29: { phase: 'running', childId: 'live-child', since: Date.now() - 60_000, updatedAt: Date.now() - 60_000 } },
  }), 'utf8');
  const ctx = await startPlugin(sf, agentsById, fakeSubagents(async () => ({ childId: 'c29' })));
  const st = (await call(ctx, '/dsh-dual-agent/status?sessionId=s29', 'GET')).json;
  check('live executor keeps running phase across a reload', st.phase === 'running' && st.childId === 'live-child',
    `phase=${st.phase} child=${st.childId}`);
  check('adopted executor is reported alive', st.childLive === true && st.childStatus === 'idle', `live=${st.childLive}`);
  child.session.deriveMessages = () => [{ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '接管后读到的收尾报告' }] }];
  child.__snapshot.push({ type: 'turn/end', seq: 1, time: 1, data: { reason: { kind: 'completed' } } });
  await sleep(1_600);
  const critics = followupTexts(parent).filter((text) => text.includes('【挑刺者评估】'));
  check('adopted executor settles with its own report', critics.length === 1 && critics[0].includes('接管后读到的收尾报告'),
    `n=${critics.length}`);
  const onDisk = JSON.parse(readFileSync(sf, 'utf8'));
  check('adopted settlement persists armed with no child',
    onDisk.sessions.s29?.phase === 'armed' && onDisk.sessions.s29?.childId === undefined,
    JSON.stringify(onDisk.sessions?.s29 ?? null));
}

// ㉙ 插件重载 + 武装记录：不靠 agent/created，第一条会话事件就要把编排簿接回来并孵化
//     （现场 ff511d07 的缺陷：重载后连续三条用户消息都没孵化，主 Agent 自己干了）。
{
  const sf = join(dir, 'reload.json');
  const agent = makeAgent('s30');
  const agentsById = new Map([['s30', agent]]);
  const sub = fakeSubagents(async () => ({ childId: 'c30' }));
  const first = await startPlugin(sf, agentsById, sub);
  await call(first, '/dsh-dual-agent/action', 'POST', { sessionId: 's30', enabled: true });
  // 重载：新实例（runs / watchedSessions 全空），刻意不触发 agent/created。
  const second = await startPlugin(sf, agentsById, sub);
  agent.__emitEvent(humanUserMessage('重载之后的新任务', 1));
  await sleep(40);
  const hatches = sub.__calls.filter((call) => call.provider !== undefined);
  check('armed session still hatches after a plugin reload', hatches.length === 1, `hatches=${hatches.length}`);
  const st = (await call(second, '/dsh-dual-agent/status?sessionId=s30', 'GET')).json;
  check('reloaded instance reports the fresh executor as running', st.phase === 'running' && st.childId === 'c30',
    `phase=${st.phase} child=${st.childId}`);
}

// ㉚ 两个实例同时发现幽灵 running：childId 是一次性令牌，说明只能投一次。
{
  const sf = join(dir, 'once.json');
  writeFileSync(sf, JSON.stringify({
    version: 2,
    sessions: { s31: { phase: 'running', childId: 'gone31', since: Date.now() - 60_000 } },
  }), 'utf8');
  const agent = makeAgent('s31');
  const agentsById = new Map([['s31', agent]]);
  const sub = fakeSubagents(async () => ({ childId: 'c31' }));
  const a = await startPlugin(sf, agentsById, sub);
  const b = await startPlugin(sf, agentsById, sub);
  await call(a, '/dsh-dual-agent/status?sessionId=s31', 'GET');
  await call(b, '/dsh-dual-agent/status?sessionId=s31', 'GET');
  await sleep(60);
  const notices = followupTexts(agent).filter((text) => text.includes('没有回到主上下文'));
  check('two instances settle the same ghost exactly once', notices.length === 1, `n=${notices.length}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);


