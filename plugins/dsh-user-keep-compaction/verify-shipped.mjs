/**
 * dsh-user-keep-compaction 交叉验证：把本插件产出的事件序列喂给**出厂实现**，
 * 用出厂代码判定它是否合法、影子价是否零漂移。
 *
 *   node plugins/dsh-user-keep-compaction/verify-shipped.mjs [--dsh-root <path>]
 *
 * 验证对象（全部来自安装树，不是本仓库的复刻）：
 *   - `@deepseek-ai/dsh-session` 的 **真 Session**：夹具用 `Session.create` 建、
 *     事务用 `session.append` 落 —— 溯源规则（sourceEventSeqs 必须覆盖全部被遮蔽
 *     节点、不得重复、必须更早）、surfaceOp 形状、事件数据形状都由真 store 判定；
 *   - `@deepseek-ai/dsh-compaction` 的 compaction 不变式 `install(ctx, fail)`：
 *     逐事件按出厂流程走「先 internal/dispatch 预校验、后 session/event 提交」，
 *     断言 fail 从未被调用；
 *   - `@deepseek-ai/dsh-session` 的 `SurfaceManager`：断言压缩后的可见面里
 *     **人类消息原样留在原位**，被替换的只有用户消息之间的助手/工具段；
 *   - `@deepseek-ai/dsh-token-meter` 的 `foldSurfaceProjection`：断言整份日志
 *     折叠出的总量与「最终可见面逐节点 estimateMessage 求和」**完全相等**（零漂移），
 *     并断言影子计价事件与替换事件严格相邻（否则折叠会抛错）。
 *
 * 还有两组**反向对照**（防止自测空过）：故意写坏影子区间 / 抽掉计价事件时，
 * 出厂校验必须报错——证明这套判据真的能发现问题。
 *
 * 只做本地计算：不连进程、不发模型请求、不写会话日志。
 *
 * @module dsh-user-keep-compaction/verify-shipped
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { appendTransaction, nodeKind, planRuns } from './index.js';

/* ── 定位安装树里的出厂模块 ─────────────────────────────────────────────── */

function locateShipped() {
  const argvIndex = process.argv.indexOf('--dsh-root');
  const candidates = [];
  if (argvIndex !== -1 && process.argv[argvIndex + 1] !== undefined) candidates.push(process.argv[argvIndex + 1]);
  if (process.env.DSH_INSTALL_ROOT !== undefined && process.env.DSH_INSTALL_ROOT !== '') candidates.push(process.env.DSH_INSTALL_ROOT);
  // 全局 npm 安装：<nodeBin>/../lib/node_modules/@deepseek-ai/dsh
  candidates.push(join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  for (const candidate of candidates) {
    const modules = join(candidate, 'node_modules', '@deepseek-ai');
    if (existsSync(join(modules, 'dsh-compaction', 'lib', 'types', 'invariant.js'))) return modules;
  }
  throw new Error(`找不到 DSH 安装树（试过：${candidates.join('、')}）；用 --dsh-root 或 DSH_INSTALL_ROOT 指定`);
}

const SHIPPED = locateShipped();
const compactionInvariant = await import(join(SHIPPED, 'dsh-compaction', 'lib', 'types', 'invariant.js'));
/** 走出厂公开路径拿 install：不变式包就是这么被 ctx.invariants.register 收下的。 */
let installCompactionInvariant = null;
await compactionInvariant.apply({
  invariants: {
    register(packageName, install) {
      assert.equal(packageName, '@deepseek-ai/dsh-compaction', '不变式包名应与出厂一致');
      installCompactionInvariant = install;
      return () => {};
    },
  },
});
assert.equal(typeof installCompactionInvariant, 'function', '应从出厂 apply 里拿到 install');
const { SurfaceManager, deriveEventMessage, isSurfaceEvent, isReplacementSurfaceEvent } = await import(join(SHIPPED, 'dsh-session', 'lib', 'types', 'surface.js'));
const { Session, SessionLogOffset } = await import(join(SHIPPED, 'dsh-session', 'lib', 'index.js'));
const { estimateMessage } = await import(join(SHIPPED, 'dsh-token-meter', 'lib', 'types', 'estimate.js'));
const { foldSurfaceProjection } = await import(join(SHIPPED, 'dsh-token-meter', 'lib', 'types', 'surface-projection.js'));

/* ── 造一份仿真会话日志（形状逐字段对齐真实日志） ───────────────────────── */

const log = [];
const SEED_TIME = 1_700_000_000_000;
const appendRaw = (type, data, opts) => {
  const event = { type, data, seq: log.length, time: SEED_TIME + log.length, ...(opts ?? {}) };
  log.push(event);
  return event;
};

/** 人类消息（source.kind='user'）：本规则下必须逐字保留。 */
const humanMessage = (text, turn) => appendRaw('user/message', {
  role: 'user',
  id: `human-${log.length}`,
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
  ...(turn === undefined ? {} : { turn }),
}, { surfaceOp: 'append' });
/** 注入上下文（source.kind='harness'）：user 角色，按规则同样逐字保留。 */
const injectedContext = (text) => appendRaw('user/message', {
  role: 'user',
  id: `ctx-${log.length}`,
  content: [{ type: 'text', text }],
  source: { kind: 'harness' },
}, { surfaceOp: 'append' });
const assistantMessage = (blocks) => appendRaw('assistant/message', {
  message: {
    role: 'assistant',
    id: `assistant-${log.length}`,
    content: blocks,
    source: { kind: 'model', provider: 'selftest', model: 'selftest' },
  },
  // 真会话要求结算字段齐全（turn/step/stream），否则种子在构造期就被拒。
  turn: 1,
  step: log.filter((event) => event.type === 'step/start').length,
  stream: [],
}, { surfaceOp: 'append' });
const toolResult = (callId, text) => appendRaw('tool/result', {
  message: {
    role: 'user',
    id: `tool-${callId}`,
    source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  },
}, { surfaceOp: 'append' });

appendRaw('system/message', { message: { role: 'system', id: 'sys-0', source: { kind: 'plugin', plugin: 'selftest-system-prompt' }, content: [{ type: 'text', text: 'system prompt' }] } }, { surfaceOp: 'append' });
appendRaw('request/header', { header: { config: { provider: 'selftest', model: 'selftest', maxTokens: 8192 }, tools: [{ name: 'bash' }] }, reason: 'initial' });
appendRaw('turn/start', { turn: 1 });
appendRaw('step/start', { turn: 1, step: 1 });
humanMessage('需求一：把 A 改成 B', 1);
injectedContext('<system-reminder>运行时上下文注入</system-reminder>');
assistantMessage([{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }]);
toolResult('call-1', 'x'.repeat(4000));
assistantMessage([{ type: 'text', text: '改好了 A → B。' }]);
appendRaw('step/end', { turn: 1, step: 1 });
appendRaw('step/start', { turn: 1, step: 2 });
humanMessage('需求二：再看看 C 文件', 1);
assistantMessage([{ type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"file_path":"/tmp/c"}' }]);
toolResult('call-2', 'y'.repeat(4000));
assistantMessage([{ type: 'tool-call', id: 'call-3', name: 'bash', arguments: '{"command":"wc"}' }]);
toolResult('call-3', 'z'.repeat(4000));
assistantMessage([{ type: 'text', text: 'C 文件没问题。' }]);
appendRaw('step/end', { turn: 1, step: 2 });
humanMessage('需求三：继续', 1);
assistantMessage([{ type: 'text', text: '好，我继续。' }]);

/* ── 用真实规划函数选区、再用真实落地函数写事务 ─────────────────────────── */

/**
 * 真会话：`Session.create` 用出厂 SurfaceManager 逐条校验种子，`append` 也走
 * 出厂校验（surfaceOp 形状、sourceEventSeqs 覆盖全部被遮蔽节点且必须更早、
 * 事件数据形状）。所以下面 `appendTransaction` 落的每一个替换事件，都是被
 * **真 store** 放行的，不是本脚本自证。
 */
const session = Session.create('session-selftest', log);
const fakeSession = session;
// 真会话在建种子时会补一条 `session/end-seed` 事件（种子边界标记），本地 log
// 因此回读一次、与会话保持一致 —— 后面的不变式重放与可见面判定都基于它。
log.length = 0;
for (const event of session.snapshotEvents(SessionLogOffset(0), SessionLogOffset(Number(session.seq)))) log.push(event);

const prefixLength = Number(session.seq); // 压缩前的事件数（含 session/end-seed）
assert.equal(log.length, prefixLength, '夹具：本地日志必须与真会话逐条对齐');
/**
 * 定价字段刻意分离：`heuristicTokens` 是出厂固定估算（4 字符/token），
 * `tokens` 是路由价（这里取 3 倍，模拟真实世界里带图片/文件附件的节点）。
 * 影子价必须用**固定估算**，收缩校验必须用**路由价** —— 两边取错字段都会被下面的
 * 断言抓住（若两者相等，这个测试就分辨不出取错字段的情况）。
 */
const ROUTE_PRICE_FACTOR = 3;
const heuristicOf = (seq) => {
  const message = deriveEventMessage(fakeSession.eventAt(seq));
  return message === null ? 0 : estimateMessage(message);
};
const measurement = {
  nodes: fakeSession.surface.nodes.map((seq) => {
    const heuristicTokens = heuristicOf(seq);
    return { seq, tokens: heuristicTokens * ROUTE_PRICE_FACTOR, heuristicTokens };
  }),
};
// 尾巴预算：只留最后一个节点 ⇒ 头部覆盖到「需求三」之前，正好切出两个可压段。
const tailBudget = measurement.nodes.at(-1).tokens;
assert.equal(tailBudget, heuristicOf(measurement.nodes.at(-1).seq) * ROUTE_PRICE_FACTOR, '夹具必须让路由价 ≠ 固定启发式价');
const plan = planRuns(fakeSession, measurement, tailBudget);
assert.ok(plan !== null, '规划必须成功');
assert.equal(plan.runs.length, 2, `应切出两段可压区间（用户消息之间），实际 ${plan.runs === null ? 'null' : plan.runs.length}`);

const summary = { blocks: [{ type: 'text', text: '## Next Step\n- 继续实现' }] };
const result = appendTransaction(session, plan, summary, {
  provider: 'selftest',
  model: 'selftest',
  maxTokens: 8192,
  turn: 1,
});

/** 事务事件：从真会话里取回来（真 store 已经验过溯源）。 */
const transaction = session.snapshotEvents(SessionLogOffset(prefixLength), SessionLogOffset(Number(session.seq)));
for (const event of transaction) log.push(event);

/* ── 判据 1：出厂 compaction 不变式（真代码，真流程） ───────────────────── */

const traceSurfaceEvents = [];
const traces = new Map();
const handlers = {};
const failures = [];
const fail = (message) => failures.push(message);
const seededSession = {
  snapshotEvents: () => log.slice(0, prefixLength),
};
const fakeCtx = {
  sessions: { list: () => [seededSession] },
  on(name, handler) {
    handlers[name] = handler;
  },
};
installCompactionInvariant(fakeCtx, fail);
assert.equal(typeof handlers['internal/dispatch'], 'function', '不变式应注册 internal/dispatch 预校验');
assert.equal(typeof handlers['session/event'], 'function', '不变式应注册 session/event 提交');

/** 按出厂顺序重放：先预校验，再提交（与 cordis 的 dispatch → listener 顺序一致）。 */
const replay = (events) => {
  for (const event of events) {
    handlers['internal/dispatch']('emit', 'session/event', [seededSession, event]);
    handlers['session/event'](seededSession, event);
  }
};

replay(transaction);
assert.deepEqual(failures, [], `出厂不变式必须放行本插件的事务，实际报错：${failures.join('；')}`);

/* ── 判据 2：出厂 SurfaceManager 判定压缩后的可见面 ─────────────────────── */

// 造一个与不变式同源的 SurfaceManager，喂进同一串事件，读它算出的最终可见面。
const managerEvents = [];
const seededManager = new SurfaceManager(managerEvents);
for (const event of log) managerEvents.push(event);
const finalNodes = [...seededManager.nodes];
const nodeOf = (seq) => log.find((event) => event.seq === Number(seq));

// 「必须逐字保留」的集合用**实现自己的判据**（nodeKind），避免自测复刻一套规则后
// 两边一起错：preserved = 一切 user 角色节点，除历史压缩检查点。
const humanSeqs = fakeSession.surface.nodes
  .filter((seq) => nodeKind(fakeSession, seq) === 'preserved')
  .map(Number);
for (const seq of humanSeqs) {
  assert.ok(finalNodes.includes(seq), `人类/注入消息 seq=${seq} 必须原样留在可见面上`);
}
const shadowed = new Set();
for (const event of transaction) {
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    for (const seq of event.data.shadowedSeqs) shadowed.add(Number(seq));
  }
}
for (const seq of humanSeqs) {
  assert.ok(!shadowed.has(seq), `人类/注入消息 seq=${seq} 绝不能被写进 shadowedSeqs`);
}
assert.equal(finalNodes.length, humanSeqs.length + plan.runs.length + 2,
  `最终可见面 = 系统头 + ${humanSeqs.length} 条保留消息 + ${plan.runs.length} 个检查点/指针 + 尾巴（实际 ${finalNodes.length}）`);

// 可见面顺序不得改变：保留消息之间的相对次序一致。
const finalHumanOrder = finalNodes.filter((seq) => humanSeqs.includes(seq));
assert.deepEqual(finalHumanOrder, humanSeqs, '保留消息必须留在原位置、原顺序');

/* ── 判据 3：影子计价折叠零漂移 ─────────────────────────────────────────── */

let claim;
let folded = 0;
for (const event of log) {
  const step = foldSurfaceProjection(claim, event);
  folded += step.deltaTokens;
  claim = step.claim;
}
const direct = finalNodes.reduce((total, seq) => {
  const message = deriveEventMessage(nodeOf(seq));
  return total + (message === null ? 0 : estimateMessage(message));
}, 0);
assert.equal(folded, direct, `影子计价折叠必须与最终可见面直接求和相等（折叠 ${folded} / 直接 ${direct}）`);

/* ── 判据 4：替换节点的形状（检查点框架 + 指针） ───────────────────────── */

const replacementEvents = transaction.filter(isReplacementSurfaceEvent);
assert.equal(replacementEvents.length, plan.runs.length, '每段一个替换节点');
const checkpointText = deriveEventMessage(replacementEvents[0]).content.map((block) => block.text).join('');
assert.ok(checkpointText.includes('<compacted-summary>'), '最老的那段落检查点（带 <compacted-summary> 框架）');
assert.ok(checkpointText.includes('</compacted-summary>'), '检查点必须有收尾标签');
assert.ok(checkpointText.includes('## Next Step'), '检查点必须带上模型产出的摘要正文');
assert.equal(replacementEvents[0].data.source.plugin, 'compact', '检查点必须带出厂 compact 标记（UI 按压缩卡片渲染）');
for (const event of replacementEvents.slice(1)) {
  const text = deriveEventMessage(event).content.map((block) => block.text).join('');
  assert.ok(text.length < 300, `后续段落必须是指针（极短），实际 ${text.length} 字符`);
  assert.equal(event.data.source.plugin, 'compact', '指针同样带 compact 标记（下一代压缩可并入）');
}

/* ── 判据 4b：影子价必须取固定启发式价（取成路由价就会被抓住）──────────── */

for (const run of plan.runs) {
  const expected = run.seqs.reduce((total, seq) => total + heuristicOf(seq), 0);
  const metering = transaction.find((event) => (event.type === 'compaction/summary' || event.type === 'compaction/prune')
    && event.data.shadowedRange.start === run.startSeq);
  assert.ok(metering !== undefined, `run ${run.startSeq}-${run.endSeq} 必须有影子计价事件`);
  assert.equal(metering.data.shadowedTokenCount, expected,
    `影子价必须用固定启发式价（段 ${run.startSeq}-${run.endSeq}）`);
}

/* ── 判据 5：影子计价事件与替换严格相邻 ────────────────────────────────── */

transaction.forEach((event, index) => {
  if (!isReplacementSurfaceEvent(event)) return;
  const previous = transaction[index - 1];
  assert.ok(previous !== undefined && (previous.type === 'compaction/summary' || previous.type === 'compaction/prune'),
    `替换 seq=${event.seq} 前一个事件必须是它的计价事件`);
  assert.equal(previous.data.shadowedRange.start, event.surfaceOp.startSeq);
  assert.equal(previous.data.shadowedRange.end, event.surfaceOp.endSeq);
});

/* ── 反向对照①：故意写坏第二段的影子区间，出厂校验必须报错 ─────────────── */

{
  const badLog = log.slice(0, prefixLength);
  const badFailures = [];
  const badTraces = new Map();
  const badHandlers = {};
  installCompactionInvariant({
    sessions: { list: () => [{ snapshotEvents: () => log.slice(0, prefixLength) }] },
    on(name, handler) { badHandlers[name] = handler; },
  }, (message) => badFailures.push(message));
  const broken = transaction.map((event) => (event.type === 'compaction/prune'
    ? { ...event, data: { ...event.data, shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2] } }
    : event));
  for (const event of broken) {
    badHandlers['internal/dispatch']('emit', 'session/event', [seededSession, event]);
    badHandlers['session/event'](seededSession, event);
  }
  assert.ok(badFailures.length > 0, '反向对照失败：写坏影子区间后出厂校验竟然放行');
}

/* ── 反向对照②：影子计价协议的两条边 ───────────────────────────────────── */

{
  // (a) 计价事件与替换**不匹配**：折叠必须当场抛错（相邻事件互相矛盾，属于生产者违约）。
  const mismatched = transaction.map((event) => (event.type === 'compaction/prune'
    ? { ...event, data: { ...event.data, shadowedRange: { start: 1, end: 2 } } }
    : event));
  let mismatchedThrew = false;
  try {
    let badClaim;
    for (const event of [...log.slice(0, prefixLength), ...mismatched]) {
      badClaim = foldSurfaceProjection(badClaim, event).claim;
    }
  } catch {
    mismatchedThrew = true;
  }
  assert.equal(mismatchedThrew, true, '反向对照失败：计价区间与替换区间矛盾时，折叠没有报错');

  // (b) 抽掉计价事件：折叠按协议退化为漂移（不报错），且确实不再等于直接求和 ——
  //     这正是「计价事件必须紧邻替换」的实质意义，不是形式要求。
  const withoutPricing = transaction.filter((event) => event.type !== 'compaction/prune');
  let driftedClaim;
  let drifted = 0;
  for (const event of [...log.slice(0, prefixLength), ...withoutPricing]) {
    const step = foldSurfaceProjection(driftedClaim, event);
    drifted += step.deltaTokens;
    driftedClaim = step.claim;
  }
  assert.notEqual(drifted, direct, '反向对照失败：抽掉计价事件后折叠竟然仍然精确');
}

/* ── 判据 6：出厂 compaction-basic 的选区规则未被破坏 ──────────────────── */

// 压缩后必须真的变小，否则出厂那段阈值检查会继续动手（本插件每轮都做收缩校验）。
const before = measurement.nodes.reduce((total, node) => total + node.tokens, 0);
const after = direct;
assert.ok(after < before, `压缩后头部必须变小（前 ${before} / 后 ${after}）`);
const runsRouteTokens = plan.runs.reduce((total, run) => total + run.tokens, 0);
const runsHeuristicTokens = plan.runs.reduce((total, run) => total + run.heuristicTokens, 0);
assert.notEqual(runsRouteTokens, runsHeuristicTokens, '夹具必须让两种价可分');
assert.equal(runsRouteTokens, runsHeuristicTokens * ROUTE_PRICE_FACTOR, 'run.tokens 必须是路由价');
assert.equal(plan.headTokens % ROUTE_PRICE_FACTOR, 0, 'headTokens 必须按路由价累加（收缩校验的口径）');

process.stdout.write([
  'VERIFY PASS（对出厂实现交叉验证）',
  `  事务：${plan.runs.length} 段可压区间，${transaction.length} 个事件，compactionId=${result.compactionId}`,
  `  可见面：${measurement.nodes.length} 节点 → ${finalNodes.length} 节点（人类/注入消息 ${humanSeqs.length} 条全部原位保留）`,
  `  影子计价：折叠总量 ${folded} = 直接求和 ${direct}（零漂移）`,
  `  反向对照：写坏影子区间 → 出厂校验报错；计价与替换错配 → 折叠报错；抽掉计价 → 折叠漂移`,
  '',
].join('\n'));
