/**
 * dsh-user-keep-compaction host 半边自测：真正跑一遍 `apply()`。
 *
 *   node plugins/dsh-user-keep-compaction/host-selftest.mjs
 *
 * 覆盖（这正是另外两个脚本不碰的部分——pre-step 编排、溢出恢复、HTTP 路由、
 * 会话级门控、半截事务兜底）：
 *   ① 监听注册：agent/pre-step 与 agent/request-error 都必须 prepend（顺序与注册
 *      时间/热重载无关），agent/status 还清溢出配额，agent/disposed 清退回记录；
 *   ② 门控：未启用的会话直通；启用的会话才压；signal 已 abort、已有未配对
 *      compaction/start、低于阈值、拿不到 meter/llm 都要老老实实直通；
 *   ③ waterfall 语义：无论压不压，都返回 next() 的结果；
 *   ④ 事务：真的向会话追加 start → summary+replace → …prune+replace… → end，
 *      用户消息仍在可见面上（规则本体已由 verify-shipped.mjs 逐条对出厂校验）；
 *   ⑤ 溢出恢复：只在 CONTEXT_WINDOW_EXCEEDED 且真的改动了可见面时返回 retry；
 *      配额用满后直通；回到 idle 还清；
 *   ⑥ 半截事务兜底：start 之后任何一步抛错都必须补一条 compaction/end{error}；
 *   ⑦ 路由：同源守卫、方法校验、参数校验、已发消息的会话 409、选择真的落盘。
 *
 * 桩只桩「外部世界」（meter/llm/webServer/日志），插件本体与它调用的
 * token-meter 估算器都是真代码。
 *
 * @module dsh-user-keep-compaction/host-selftest
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { existsSync as exists } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction';
import { apply, hasHumanMessage } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/* ── 真代码：出厂的固定估算器（与运行时同一份） ─────────────────────────── */

function locateShipped() {
  const argvIndex = process.argv.indexOf('--dsh-root');
  const candidates = [];
  if (argvIndex !== -1 && process.argv[argvIndex + 1] !== undefined) candidates.push(process.argv[argvIndex + 1]);
  if (process.env.DSH_INSTALL_ROOT !== undefined && process.env.DSH_INSTALL_ROOT !== '') candidates.push(process.env.DSH_INSTALL_ROOT);
  candidates.push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  for (const candidate of candidates) {
    const modules = join(candidate, 'node_modules', '@deepseek-ai');
    if (exists(join(modules, 'dsh-token-meter', 'lib', 'types', 'estimate.js'))) return modules;
  }
  throw new Error('找不到 DSH 安装树；用 --dsh-root 指定');
}
const SHIPPED = locateShipped();
const { estimateMessage } = await import(join(SHIPPED, 'dsh-token-meter', 'lib', 'types', 'estimate.js'));
const { deriveEventMessage, isSurfaceEvent, isReplacementSurfaceEvent } = await import(join(SHIPPED, 'dsh-session', 'lib', 'types', 'surface.js'));

/* ── 会话：直接用**出厂 Session**（真会话的可见面/溯源/事件数据校验） ─────── */

const { Session } = await import(join(SHIPPED, 'dsh-session', 'lib', 'index.js'));

/**
 * 建一个真会话：`Session.create(id, seed)` 会把种子逐条喂给出厂
 * `SurfaceManager.validateNext` —— 也就是说 **append 的溯源规则
 * （sourceEventSeqs 必须覆盖全部被遮蔽节点、必须更早、不得重复）、surfaceOp
 * 形状、事件数据形状全部是真判据**，不是本脚本复刻的一套。
 */
const makeSession = (id, events) => Session.create(id, normalizeSeed(id, events));

/**
 * 种子必须带齐事件信封（type / seq / time / data），seq 从 0 连续。
 * 这里只补 `seq`、`time` 两个信封字段，事件数据本身原样交给真会话校验。
 */
function normalizeSeed(id, events) {
  const base = 1_700_000_000_000 + (id.length * 1000);
  return events.map((event, index) => ({ seq: index, time: base + index, ...event }));
}

const MODEL_SOURCE = { kind: 'model', provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' };
const human = (text) => ({
  type: 'user/message',
  data: { role: 'user', id: `h-${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } },
  surfaceOp: 'append',
});
let assistantSeq = 0;
const assistant = (blocks, turn = 1, step = 1) => {
  assistantSeq += 1;
  return {
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', id: `a-${assistantSeq}`, content: blocks, source: MODEL_SOURCE },
      turn,
      step,
      stream: [],
    },
    surfaceOp: 'append',
  };
};
const tool = (callId, text) => ({
  type: 'tool/result',
  data: {
    message: {
      role: 'user',
      id: `t-${callId}`,
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
    },
  },
  surfaceOp: 'append',
});

/** 真实会话里的请求信封（provider/model 从这里解析；routeTarget 依赖它）。 */
const requestHeader = () => ({
  type: 'request/header',
  data: {
    header: { config: { provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash', maxTokens: 32768 }, tools: [{ name: 'bash' }] },
    reason: 'initial',
  },
});

/** 一份「有两条人类消息、中间夹着大块工具输出」的会话：启用规则后必可压。 */
const bigSessionLog = (id) => [
  { type: 'system/message', data: { message: { role: 'system', id: 'sys', source: { kind: 'plugin', plugin: 'dsh-system-prompt' }, content: [{ type: 'text', text: 'system prompt' }] } }, surfaceOp: 'append' },
  requestHeader(),
  { type: 'turn/start', data: { turn: 1 } },
  human(`需求一 ${id}`),
  assistant([{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }]),
  tool('c1', 'x'.repeat(24000)),
  assistant([{ type: 'text', text: '做完了。' }]),
  human(`需求二 ${id}`),
  assistant([{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }]),
  tool('c2', 'y'.repeat(24000)),
  assistant([{ type: 'text', text: '也做完了。' }]),
];

/* ── ctx 桩 ─────────────────────────────────────────────────────────────── */

const routes = new Map();
const listeners = new Map();
const effects = [];
const logs = { info: [], warn: [] };

const meterOf = (session) => {
  const nodes = session.surface.nodes.map((seq) => {
    const message = session.deriveEventMessage(session.eventAt(seq));
    const heuristicTokens = message === null ? 0 : estimateMessage(message);
    return { seq, tokens: heuristicTokens, heuristicTokens };
  });
  return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) };
};

let contextWindow = 100000;
let llmCalls = 0;
const meter = { measure: meterOf, estimateMessage };
const llm = {
  async resolveModelInfo() { return { context: { contextWindow } }; },
  stream(options) {
    llmCalls += 1;
    const chunks = [
      { type: 'text-delta', index: 0, text: '## Next Step\n- 继续' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    return (async function* generate() {
      assert.equal(Array.isArray(options.messages) && options.messages.length > 0, true, '摘要调用必须带消息');
      assert.equal(options.purpose, 'compaction', '摘要调用必须标 purpose=compaction');
      for (const chunk of chunks) yield chunk;
    })();
  },
};

const sessionStore = new Map();
let hostCtx = null;
const ctx = {
  logger: {
    info: (message) => logs.info.push(String(message)),
    warn: (message, error) => logs.warn.push(`${message}${error === undefined ? '' : ` :: ${error?.message ?? error}`}`),
  },
  get(name) {
    if (name === 'tokenMeter') return meter;
    if (name === 'llm') return llm;
    if (name === 'toolResultPruner') return hostCtx?.pruner;
    return undefined;
  },
  on(name, listener, options) {
    const list = listeners.get(name) ?? [];
    list.push({ listener, options });
    listeners.set(name, list);
    return () => {
      const at = list.findIndex((entry) => entry.listener === listener);
      if (at >= 0) list.splice(at, 1);
    };
  },
  inject(deps, callback) {
    assert.deepEqual(deps, ['webServer', 'sessions'], 'host 半边只依赖 webServer 与 sessions');
    callback({
      sessions: { get: (id) => sessionStore.get(id) },
      webServer: {
        register(entry) {
          routes.set(entry.path, entry.handler);
          return () => routes.delete(entry.path);
        },
      },
    });
  },
  effect(factory) { const cleanup = factory(); effects.push(cleanup); return cleanup; },
};

const stateDir = mkdtempSync(join(tmpdir(), 'ukc-host-'));
const stateFile = join(stateDir, 'state.json');
apply(ctx, { thresholdRatio: 0.02, retainRatio: 0.001, maxTokens: 4096, stateFile });

const listenerFor = (name) => {
  const entries = listeners.get(name);
  assert.ok(entries !== undefined && entries.length >= 1, `应注册 ${name} 监听器`);
  return entries[0];
};
const nextStub = (value) => { let calls = 0; const next = async () => { calls += 1; return value; }; next.calls = () => calls; return next; };

/* ── ① 监听注册契约 ─────────────────────────────────────────────────────── */

for (const name of ['agent/pre-step', 'agent/request-error', 'agent/status', 'agent/disposed']) {
  assert.ok(listeners.has(name), `应注册 ${name}`);
}
assert.equal(listenerFor('agent/pre-step').options?.prepend, true, 'pre-step 必须 prepend（先于预设实景的 compaction-basic）');
assert.equal(listenerFor('agent/request-error').options?.prepend, true, 'request-error 也必须 prepend（顺序不能依赖注册时间/热重载）');
assert.equal(listenerFor('agent/status').options?.prepend, undefined, 'agent/status 只做清理，无需插队');
assert.deepEqual([...routes.keys()].sort(), ['/dsh-ukc/set', '/dsh-ukc/status'], '应注册两条路由');

/* ── ② 未启用的会话：直通，一个字都不写 ─────────────────────────────────── */

const idle = makeSession('s-off', bigSessionLog('s-off'));
sessionStore.set('s-off', idle);
{
  const before = idle.seq;
  const next = nextStub({ kind: 'enter' });
  const decision = await listenerFor('agent/pre-step').listener({ agent: { session: idle }, turn: 1, step: 1, signal: undefined }, next);
  assert.deepEqual(decision, { kind: 'enter' }, 'waterfall 必须返回 next() 的结果');
  assert.equal(next.calls(), 1, '必须放行到下一个监听器（不能否决整条链）');
  assert.equal(idle.seq, before, '未启用的会话不得写入任何事件');
  assert.equal(llmCalls, 0, '未启用的会话不得调模型');
}

/* ── ③ 路由：把选择写进去（新会话） ─────────────────────────────────────── */

const fakeRes = () => {
  const res = { status: null, body: '', headers: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (text) => { res.body = text ?? ''; };
  return res;
};
const callRoute = async (path, { method = 'GET', url, body, origin } = {}) => {
  const res = fakeRes();
  const req = {
    method,
    url: url ?? path,
    headers: origin === undefined ? { host: 'localhost:3080' } : { host: 'localhost:3080', origin },
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(body));
      if (event === 'end') handler();
      return req;
    },
    destroy() {},
  };
  await routes.get(path)(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) };
};

{
  const missing = await callRoute('/dsh-ukc/status', { url: '/dsh-ukc/status' });
  assert.equal(missing.status, 400, '缺 sessionId 必须 400');
  assert.equal((await callRoute('/dsh-ukc/status', { method: 'POST', url: '/dsh-ukc/status?sessionId=x' })).status, 405, '方法不对必须 405');
  assert.equal((await callRoute('/dsh-ukc/status', { url: '/dsh-ukc/status?sessionId=x', origin: 'http://evil.example' })).status, 403, '跨源必须 403');
  assert.equal((await callRoute('/dsh-ukc/set', { method: 'POST', body: '{oops' })).status, 400, '坏 JSON 必须 400');
  assert.equal((await callRoute('/dsh-ukc/set', { method: 'POST', body: JSON.stringify({ sessionId: 'ghost', enabled: true }) })).status, 409, '不在本进程的会话必须 409');

  const blank = makeSession('s-new', bigSessionLog('s-new').slice(0, 2)); // 只有 system + turn/start
  sessionStore.set('s-new', blank);
  const status0 = await callRoute('/dsh-ukc/status', { url: '/dsh-ukc/status?sessionId=s-new' });
  assert.equal(status0.json.canSet, true, '全新会话应可设置');
  assert.equal(status0.json.enabled, false, '缺省关闭');
  assert.equal(status0.json.manualCompactBypasses, true, '状态路由应如实标注 /compact 不受本规则约束');

  const set = await callRoute('/dsh-ukc/set', { method: 'POST', body: JSON.stringify({ sessionId: 's-new', enabled: true }) });
  assert.equal(set.status, 200, '新会话应写入成功');
  assert.equal(set.json.enabled, true);
  assert.equal(existsSync(stateFile), true, '选择必须落盘');
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.sessions['s-new'].enabled, true, '落盘内容应包含该会话');

  // 已发过人类消息的会话：读取可以，写入必须 409。
  const used = makeSession('s-used', bigSessionLog('s-used'));
  sessionStore.set('s-used', used);
  assert.equal(hasHumanMessage(used), true, '夹具里确实有人类消息');
  const refused = await callRoute('/dsh-ukc/set', { method: 'POST', body: JSON.stringify({ sessionId: 's-used', enabled: true }) });
  assert.equal(refused.status, 409, '发出消息后必须拒绝修改');
  const statusUsed = await callRoute('/dsh-ukc/status', { url: '/dsh-ukc/status?sessionId=s-used' });
  assert.equal(statusUsed.json.canSet, false, '已发消息的会话 canSet=false');
}


/* ── 会话夹具：先在空白态开启规则，再让消息进来（与真实时序一致） ────────── */

const blankSession = (id) => makeSession(id, bigSessionLog(id).slice(0, 2));
/** 把剩余消息逐条灌进会话（保留原事件的 surfaceOp，可见面因此正常增长）。 */
const seedTailOf = (id) => bigSessionLog(id).slice(2);

const growSession = (session, id) => {
  for (const event of seedTailOf(id)) {
    // 只有面事件才带 surfaceOp（非面事件带它会被真会话直接拒掉）。
    session.append(event.type, event.data, ...(event.surfaceOp === undefined ? [] : [{ surfaceOp: 'append' }]));
  }
  return session;
};
/** 再灌一轮「人类消息 + 大块工具输出」——模拟后续回合继续把压力顶上去。 */
const appendRound = (session, tag) => {
  session.append('user/message', { role: 'user', id: `h-${tag}`, content: [{ type: 'text', text: `需求 ${tag}` }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('assistant/message', { message: { role: 'assistant', id: `a-${tag}`, content: [{ type: 'tool-call', id: `call-${tag}`, name: 'bash', arguments: '{}' }], source: MODEL_SOURCE }, turn: 1, step: 1, stream: [] }, { surfaceOp: 'append' });
  session.append('tool/result', { message: { role: 'user', id: `t-${tag}`, source: { kind: 'tool', callId: `call-${tag}` }, content: [{ type: 'tool-result', toolCallId: `call-${tag}`, content: [{ type: 'text', text: 'z'.repeat(24000) }] }] } }, { surfaceOp: 'append' });
  session.append('assistant/message', { message: { role: 'assistant', id: `a2-${tag}`, content: [{ type: 'text', text: '完成。' }], source: MODEL_SOURCE }, turn: 1, step: 1, stream: [] }, { surfaceOp: 'append' });
  return session;
};

/** 记录此后写进会话的每个事件（不依赖会话内部字段，真/假会话都适用）。 */
const appendSpy = (session) => {
  const seen = [];
  const real = session.append.bind(session);
  session.append = (type, data, opts) => {
    const event = real(type, data, opts);
    seen.push(event);
    return event;
  };
  return seen;
};

/** 真实流程：建空白会话 → 通过路由定下选择 → 消息才开始进来。 */
const enableSession = async (id, { grow = true } = {}) => {
  const session = blankSession(id);
  sessionStore.set(id, session);
  const set = await callRoute('/dsh-ukc/set', { method: 'POST', body: JSON.stringify({ sessionId: id, enabled: true }) });
  assert.equal(set.status, 200, `${id} 应能在空白态下开启规则`);
  return grow ? growSession(session, id) : session;
};

/* ── ④ 启用后的会话：真的按规则压一次 ───────────────────────────────────── */


{
  const session = await enableSession('s-on');

  const humans = session.surface.nodes.filter((seq) => session.eventAt(seq)?.type === 'user/message' && session.eventAt(seq).data.source?.kind === 'user');
  const before = session.seq;
  const appended = appendSpy(session);
  const next = nextStub({ kind: 'enter', messages: [] });
  const decision = await listenerFor('agent/pre-step').listener({ agent: { session }, turn: 1, step: 1, signal: undefined }, next);
  assert.deepEqual(decision, { kind: 'enter', messages: [] }, '压完仍必须返回 next() 的结果');
  assert.equal(next.calls(), 1, '压完必须放行');
  // 首轮压完若压力仍越线，runForAgent 会自动追加一轮（retainTokens=0），上限
  // maxPassesPerStep=2 —— 这份夹具（两条人类消息 + 2×24000 字符工具输出）正好
  // 需要两轮，于是这里同时验证了「逐步加压」这条路径。
  assert.equal(llmCalls, 2, `首轮之后仍越线 ⇒ 自动追加一轮，实际调用 ${llmCalls} 次（告警：${logs.warn.join(' | ') || '无'}）`);
  assert.equal(session.seq > before, true, '应写入事务事件');

  const types = appended.map((event) => event.type);
  assert.equal(types[0], 'compaction/start', `事务必须以 compaction/start 开头，实际 ${types.join(' ')}`);
  assert.equal(types.at(-1), 'compaction/end', `事务必须以 compaction/end 收尾，实际 ${types.join(' ')}`);

  // 按括号切开逐段验：每条 compaction/start…compaction/end 里恰好一条 summary，
  // 每条计价事件（summary/prune）之后紧邻它自己的面替换事件。
  let brackets = 0;
  for (let at = 0; at < types.length;) {
    assert.equal(types[at], 'compaction/start', '括号必须以 start 开头');
    const compactionId = appended[at].data.compactionId;
    assert.equal(typeof compactionId, 'string', 'compaction/start 必须带 compactionId');
    let cursor = at + 1;
    let summaries = 0;
    while (cursor < types.length && types[cursor] !== 'compaction/end') {
      if (types[cursor] === 'compaction/summary') summaries += 1;
      if (types[cursor] === 'compaction/summary' || types[cursor] === 'compaction/prune') {
        const metering = appended[cursor];
        const replacement = appended[cursor + 1];
        assert.equal(types[cursor + 1], 'user/message', `计价事件（第 ${cursor} 项）之后必须紧邻替换事件`);
        // 替换区间必须与计价事件声明的区间一致（影子价协议的硬要求）。
        assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: metering.data.shadowedRange.start, endSeq: metering.data.shadowedRange.end },
          '替换区间必须与计价事件声明的区间一致');
        // 溯源：计价事件（以及括号自身）都要写进 sourceEventSeqs。
        assert.ok(replacement.sourceEventSeqs.includes(metering.seq), '替换事件必须把计价事件写进 sourceEventSeqs');
        assert.ok(replacement.sourceEventSeqs.includes(appended[at].seq), '替换事件必须把 compaction/start 写进 sourceEventSeqs');
        assert.equal(metering.seq + 1, replacement.seq, '替换必须紧邻它的计价事件（中间不得插任何事件）');
        // 出厂标记写在**消息的 source** 里（compactCheckpointSource 的形状）——UI 靠它
        // 把替换节点渲染成压缩检查点而不是用户气泡，出厂不变式也靠它认检查点。
        assert.ok(isCompactCheckpointSource(replacement.data.source),
          '替换消息必须带本括号的出厂压缩检查点标记');
        assert.equal(replacement.data.source.compactionId, compactionId,
          '检查点标记必须指向本括号的 compactionId');
        cursor += 2;
        continue;
      }
      assert.fail(`括号里出现了意外事件 ${types[cursor]}`);
    }
    assert.equal(summaries, 1, '一条 start/end 括号里只能有一条 summary');
    assert.equal(types[cursor], 'compaction/end', '括号必须以 end 收尾');
    assert.equal(appended[cursor].data.compactionId, compactionId, 'end 必须与 start 同一个 compactionId');
    brackets += 1;
    at = cursor + 1;
  }
  assert.equal(brackets, 2, '两轮压缩 = 两个独立括号');
  assert.equal(appended.filter((event) => event.type === 'compaction/end' && event.data.error !== undefined).length, 0, '成功事务的 end 不应带 error');

  const shadowed = new Set(appended
    .filter((event) => event.type === 'compaction/summary' || event.type === 'compaction/prune')
    .flatMap((event) => event.data.shadowedSeqs));
  for (const seq of humans) {
    assert.ok(session.surface.nodes.includes(seq), '人类消息必须仍在可见面上');
    assert.equal(shadowed.has(seq), false, '人类消息不得出现在 shadowedSeqs 里');
  }
}

/* ── ⑤ 该直通的情形：低压力 / 在途锁 / 已 abort ─────────────────────────── */

{
  contextWindow = 100000000; // 阈值被抬到天上 ⇒ 低于阈值
  const session = await enableSession('s-low');
  const before = session.seq;
  const next = nextStub({ kind: 'enter' });
  await listenerFor('agent/pre-step').listener({ agent: { session }, turn: 1, step: 1, signal: undefined }, next);
  assert.equal(session.seq, before, '低于阈值不得写任何事件');
  contextWindow = 100000;

  const locked = await enableSession('s-locked');
  locked.append('compaction/start', { compactionId: 'other', turn: 1 }); // 出厂引擎正在压（括号开着）
  const lockedBefore = locked.seq;
  await listenerFor('agent/pre-step').listener({ agent: { session: locked }, turn: 1, step: 1, signal: undefined }, nextStub({ kind: 'enter' }));
  assert.equal(locked.seq, lockedBefore, '已有未配对 compaction/start 时不得再开一个括号');

  const aborted = await enableSession('s-abort');
  const abortBefore = aborted.seq;
  await listenerFor('agent/pre-step').listener({ agent: { session: aborted }, turn: 1, step: 1, signal: { aborted: true } }, nextStub({ kind: 'enter' }));
  assert.equal(aborted.seq, abortBefore, 'signal 已 abort 时不得动手');
}

/* ── ⑥ 溢出恢复：只在 CONTEXT_WINDOW_EXCEEDED 且真的改了可见面时接管 ────── */

{
  const other = await enableSession('s-other');
  const next = nextStub(undefined);
  const result = await listenerFor('agent/request-error').listener({ agent: { session: other }, turn: 1, failure: { code: 'RATE_LIMITED' }, signal: undefined }, next);
  assert.equal(result, undefined, '非溢出错误必须交还控制权');
  assert.equal(next.calls(), 1, '非溢出错误必须放行');

  const overflow = await enableSession('s-overflow');
  const retry = await listenerFor('agent/request-error').listener({ agent: { session: overflow }, turn: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: undefined }, nextStub(undefined));
  assert.deepEqual(retry, { kind: 'retry' }, `溢出且成功压过 ⇒ 返回 retry（实际 ${JSON.stringify(retry)}；告警：${logs.warn.join(' | ') || '无'}）`);
  const stressAfter = overflow.surface.replaceGeneration;
  assert.equal(stressAfter > 0, true, '溢出路径必须真的替换过可见面');

  // 配额（缺省 1 次）用满后直通；回到 idle 再还清。
  const next2 = nextStub(undefined);
  const second = await listenerFor('agent/request-error').listener({ agent: { session: overflow }, turn: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: undefined }, next2);
  assert.equal(second, undefined, '配额用满后必须交还控制权');
  assert.equal(next2.calls(), 1, '配额用满后必须放行');

  // 回到 idle ⇒ 配额还清；下一轮消息再把压力顶上去时应该还能再救一次。
  listenerFor('agent/status').listener({ agent: { session: overflow }, status: 'idle' });
  appendRound(overflow, 'again');
  const third = await listenerFor('agent/request-error').listener({ agent: { session: overflow }, turn: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: undefined }, nextStub(undefined));
  assert.deepEqual(third, { kind: 'retry' }, 'idle 之后配额应还清，可以再救一次');

  // 反证：非 idle 的状态不得还清配额（否则每次错误重试都能再压一轮）。
  listenerFor('agent/status').listener({ agent: { session: overflow }, status: 'running' });
  appendRound(overflow, 'again2');
  const fourth = await listenerFor('agent/request-error').listener({ agent: { session: overflow }, turn: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: undefined }, nextStub(undefined));
  assert.equal(fourth, undefined, 'running 状态不得还清配额');
}

/* ── ⑦ 半截事务兜底：start 之后抛错必须补 end{error} ───────────────────── */

{
  const session = await enableSession('s-fail');
  // 真会话本身不会「拒绝」合法事件，这里只把 append 包一层，让它在 start 之后炸掉
  // ——模拟真实世界里的中途失败（磁盘写满、日志被并发关闭、校验拒绝等）。
  const landed = appendSpy(session);
  const spyAppend = session.append;
  session.append = (type, data, opts) => {
    if (type === 'compaction/summary') throw new Error('selftest: append refused');
    return spyAppend(type, data, opts);
  };
  const next = nextStub({ kind: 'enter' });
  const decision = await listenerFor('agent/pre-step').listener({ agent: { session }, turn: 1, step: 1, signal: undefined }, next);
  assert.deepEqual(decision, { kind: 'enter' }, '事务失败也不得阻断本轮');
  assert.equal(next.calls(), 1, '事务失败也必须放行');
  const tail = landed.map((event) => event.type);
  assert.deepEqual(tail.slice(-2), ['compaction/start', 'compaction/end'], `失败后必须补一条 compaction/end，实际尾部 ${tail.join(' ')}`);
  assert.equal(typeof landed.at(-1).data.error, 'string', '补的 end 必须带 error');
  assert.equal(logs.warn.some((line) => line.includes('压缩轮次异常')), true, '失败必须留下告警');
}

/* ── ⑧ 清理：卸载带走路由 ──────────────────────────────────────────────── */

for (const cleanup of effects) if (typeof cleanup === 'function') cleanup();
assert.equal(routes.size, 0, '卸载后路由必须回收');
rmSync(stateDir, { recursive: true, force: true });

process.stdout.write(`HOST SELFTEST PASS（apply 接线：门控/事务/溢出配额/半截兜底/路由，${logs.warn.length} 条预期告警）\n`);
