/**
 * dsh-user-keep-compaction 自测：纯逻辑（不连进程、不发请求）。
 *
 *   node plugins/dsh-user-keep-compaction/selftest.mjs
 *
 * 覆盖：可见面分类、工具对平衡边界、选区规划、保留量计价、检查点框架、
 * 人类消息/在途压缩判定、配置校验、选择落盘往返。
 *
 * @module dsh-user-keep-compaction/selftest
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  apply,
  balanceBoundaries,
  checkpointMessage,
  createStore,
  defaultStateFile,
  hasHumanMessage,
  hasOpenCompaction,
  isCheckpointSource,
  joinTextDeltas,
  nodeKind,
  planRuns,
  pointerMessage,
  preservedTokens,
  resolveConfig,
} from './index.js';

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(label, a === b, `实际 ${a}，期望 ${b}`);
}

/* ── 假会话：只实现本插件用到的那几个面 ─────────────────────────────────── */

const userEvent = (text, source = { kind: 'user' }) => ({
  type: 'user/message',
  data: { role: 'user', id: `u-${text}`, content: [{ type: 'text', text }], source },
});
const systemEvent = () => ({ type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } });
const assistantEvent = (...calls) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: calls.length === 0 ? [{ type: 'text', text: 'ok' }] : calls.map((id) => ({ type: 'tool-call', id, name: 'bash', arguments: '{}' })) } },
});
const toolEvent = (callId, text = 'out') => ({
  type: 'tool/result',
  data: { message: { role: 'user', id: `t-${callId}`, source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } },
});
const checkpointEvent = (compactionId = 'c1') => ({
  type: 'user/message',
  surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
  data: { role: 'user', id: `cp-${compactionId}`, source: { kind: 'plugin', plugin: 'compact', compactionId }, content: [{ type: 'text', text: '<compacted-summary>x</compacted-summary>' }] },
});

function fakeSession(events, options = {}) {
  const session = {
    events,
    seq: events.length,
    surface: { nodes: events.map((_, index) => index), replaceGeneration: 0 },
    eventAt(seq) {
      return events[Number(seq)];
    },
    deriveEventMessage(event) {
      return event?.data?.message ?? (event?.type === 'user/message' ? event.data : null);
    },
    requestHeader() {
      return { tools: [{ name: 'bash' }], config: { provider: 'p', model: 'm' } };
    },
    append(type, data, opts) {
      const seq = this.events.length;
      this.events.push({ type, data, ...(opts ?? {}) });
      this.seq = this.events.length;
      if (opts?.surfaceOp?.op === 'replace') {
        const start = this.surface.nodes.indexOf(Number(opts.surfaceOp.startSeq));
        const end = this.surface.nodes.indexOf(Number(opts.surfaceOp.endSeq));
        this.surface.nodes.splice(start, end - start + 1, seq);
        this.surface.replaceGeneration += 1;
      } else {
        this.surface.nodes.push(seq);
      }
      return { seq };
    },
  };
  if (options.noHuman !== true) return session;
  return session;
}

/** 把路由价按节点序号写成 measurement。 */
const measurementOf = (session, prices, heuristic) => ({
  nodes: session.surface.nodes.map((seq, index) => ({
    seq,
    tokens: prices[index] ?? 10,
    heuristicTokens: heuristic?.[index] ?? 4,
  })),
});

/* ── 1. 可见面分类 ──────────────────────────────────────────────────────── */

{
  const session = fakeSession([
    systemEvent(),
    userEvent('人类消息'),
    userEvent('<system-reminder>注入上下文</system-reminder>', { kind: 'harness' }),
    assistantEvent('call-1'),
    toolEvent('call-1'),
    checkpointEvent('old'),
  ]);
  eq('人类消息 → preserved', nodeKind(session, 1), 'preserved');
  eq('注入上下文 → preserved', nodeKind(session, 2), 'preserved');
  eq('助手消息 → compressible', nodeKind(session, 3), 'compressible');
  eq('工具结果 → compressible', nodeKind(session, 4), 'compressible');
  eq('历史检查点 → compressible（必须可被并入）', nodeKind(session, 5), 'compressible');
  ok('检查点标记识别', isCheckpointSource({ kind: 'plugin', plugin: 'compact', compactionId: 'x' }));
  ok('非检查点插件消息不算检查点', !isCheckpointSource({ kind: 'plugin', plugin: 'other' }));
}

/* ── 2. 工具对平衡边界 ──────────────────────────────────────────────────── */

{
  const session = fakeSession([
    systemEvent(),
    userEvent('a'),
    assistantEvent('c1', 'c2'),
    userEvent('中途插话'),
    toolEvent('c1'),
    toolEvent('c2'),
    assistantEvent(),
    userEvent('b'),
    assistantEvent('c3'),
    toolEvent('c3'),
  ]);
  const balanced = balanceBoundaries(session, session.surface.nodes);
  eq('边界数组长度 = 节点数 + 1', balanced.length, session.surface.nodes.length + 1);
  eq('首个节点之前的边界平衡', balanced[0], true);
  eq('工具调用之后失衡', balanced[3], false);
  eq('中间插的用户消息不清空未回调用', balanced[4], false);
  eq('只回来一个结果仍失衡', balanced[5], false);
  eq('两个结果都到齐后平衡', balanced[6], true);
  eq('用户消息 b 之前平衡', balanced[7], true);
  eq('最后一个结果之后平衡', balanced[balanced.length - 1], true);
}

/* ── 3. 选区规划：保留用户消息、只压段 ───────────────────────────────────── */

{
  // 0 系统 / 1 用户 / 2-3 助手+工具 / 4 助手 / 5 用户 / 6 助手 / 7 工具 / 8 用户 / 9 助手（尾巴）
  const session = fakeSession([
    systemEvent(),
    userEvent('需求一'),
    assistantEvent('c1'),
    toolEvent('c1', '很长很长的一坨输出'),
    assistantEvent(),
    userEvent('需求二'),
    assistantEvent('c2'),
    toolEvent('c2', '又一坨输出'),
    userEvent('需求三'),
    assistantEvent(),
  ]);
  const prices = [100, 20, 40, 900, 40, 20, 40, 900, 20, 30];
  const measurement = measurementOf(session, prices, prices.map((value) => Math.floor(value / 4)));
  // retainTokens = 30 ⇒ 只保留最后一个节点（尾巴），头部 = 1..8
  const plan = planRuns(session, measurement, 30);
  ok('规划成功', plan !== null);
  eq('头部起点跳过 system 头', plan.firstIdx, 1);
  eq('头部覆盖到保留尾巴之前', plan.keepFromIdx, 9);
  eq('两个可压段（用户消息之间）', plan.runs.length, 2);
  eq('第一段 = 助手+工具+助手', plan.runs[0].seqs, [2, 3, 4]);
  eq('第二段 = 助手+工具', plan.runs[1].seqs, [6, 7]);
  eq('段内路由价合计', plan.runs[0].tokens, 40 + 900 + 40);
  eq('头部里被保留的路由价（三条用户消息）', preservedTokens(session, plan, measurement), 20 + 20 + 20);
  ok('段不含任何 user 节点', plan.runs.every((run) => run.seqs.every((seq) => nodeKind(session, seq) !== 'preserved')));
}

/* ── 4. 平衡吸附：绝不把工具对劈到摘要两侧 ────────────────────────────── */

{
  // 工具调用没等到结果（回合被打断/中止）时，跨越它的段必须整段放弃 —— 宁可这一步
  // 不压，也不能让 tool-call 进摘要、而它的结果留在可见面上（那会让下一次请求
  // 带着一个没有对应调用的结果，直接被供应商拒掉）。
  const torn = fakeSession([
    systemEvent(),
    userEvent('a'),
    assistantEvent('c1'), // 永远没等到结果
    checkpointEvent('old'),
    userEvent('b'),
    assistantEvent(),
  ]);
  eq('未回结果的死对子 ⇒ 整段放弃', planRuns(torn, measurementOf(torn, [100, 20, 40, 30, 20, 30]), 0), null);

  // 同一个形状，把结果补上 ⇒ 同一段立刻可压（说明上一条判据确实卡在「缺结果」上，
  // 而不是夹具本身压不动）。
  const healed = fakeSession([
    systemEvent(),
    userEvent('a'),
    assistantEvent('c1'),
    toolEvent('c1'),
    checkpointEvent('old'),
    userEvent('b'),
    assistantEvent(),
  ]);
  const plan = planRuns(healed, measurementOf(healed, [100, 20, 40, 40, 30, 20, 30]), 0);
  ok('结果到齐后同一段可压', plan !== null && plan.runs.length === 1);
  eq('段 = 助手 + 结果 + 历史检查点（连续可压）', plan.runs[0].seqs, [2, 3, 4]);
}

/* ── 5. 保留尾巴吞掉整个头部时不动作 ────────────────────────────────────── */

{
  const session = fakeSession([systemEvent(), userEvent('a'), assistantEvent()]);
  const measurement = measurementOf(session, [1000, 10, 10]);
  eq('尾部预算覆盖全部内容 → 不规划', planRuns(session, measurement, 100000), null);
}

/* ── 6. 检查点框架 ─────────────────────────────────────────────────────── */

{
  const message = checkpointMessage('cid-1', [{ type: 'text', text: '## Next Step\n- x' }]);
  eq('检查点角色', message.role, 'user');
  ok('检查点带 compact 标记', isCheckpointSource(message.source));
  eq('检查点前缀 + 开标签', message.content[0].text.endsWith('<compacted-summary>'), true);
  eq('检查点闭标签收尾', message.content.at(-1).text, '</compacted-summary>');
  const pointer = pointerMessage('cid-1');
  ok('指针也是 compact 检查点（下一代可并入）', isCheckpointSource(pointer.source));
  ok('指针正文极短', pointer.content[0].text.length < 200);
  eq('流式文本拼接', joinTextDeltas(['a', undefined, 'b']), 'ab');
}

/* ── 7. 人类消息 / 在途压缩判定 ────────────────────────────────────────── */

{
  const fresh = fakeSession([systemEvent(), userEvent('<system-reminder>注入</system-reminder>', { kind: 'harness' })]);
  eq('只有注入上下文 → 仍可设置', hasHumanMessage(fresh), false);
  const used = fakeSession([systemEvent(), userEvent('真消息')]);
  eq('有真实人类消息 → 不可再改', hasHumanMessage(used), true);

  const idle = fakeSession([systemEvent()]);
  eq('无压缩括号', hasOpenCompaction(idle), false);
  const running = fakeSession([{ type: 'compaction/start', data: { compactionId: 'x', turn: 1 } }]);
  eq('未配对 start → 在途', hasOpenCompaction(running), true);
  const closed = fakeSession([
    { type: 'compaction/start', data: { compactionId: 'x', turn: 1 } },
    { type: 'compaction/summary', data: {} },
    { type: 'compaction/end', data: { compactionId: 'x', turn: 1 } },
  ]);
  eq('已配对 → 空闲', hasOpenCompaction(closed), false);
  const orphaned = fakeSession([
    { type: 'compaction/start', data: { compactionId: 'x', turn: 1 } },
    { type: 'session/end-seed', data: {} },
  ]);
  eq('跨进程生命周期的孤儿锁 → 视为陈旧', hasOpenCompaction(orphaned), false);
}

/* ── 8. 配置校验 ───────────────────────────────────────────────────────── */

{
  const config = resolveConfig(undefined);
  eq('缺省阈值比', config.thresholdRatio, 0.8);
  eq('缺省保留比', config.retainRatio, 0.16);
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/ukc-home-probe';
  eq('状态文件跟随 $DSH_HOME', defaultStateFile(), '/tmp/ukc-home-probe/user-keep-compaction.json');
  process.env.DSH_HOME = '~/ukc-probe';
  ok('$DSH_HOME 里的 ~ 会被展开成绝对路径', defaultStateFile() === join(homedir(), 'ukc-probe', 'user-keep-compaction.json'));
  process.env.DSH_HOME = savedHome === undefined ? '' : savedHome;
  if (savedHome === undefined) delete process.env.DSH_HOME;
  ok('缺省状态文件是绝对路径且以 user-keep-compaction.json 收尾',
    config.stateFile.startsWith('/') && config.stateFile.endsWith('/user-keep-compaction.json'));
  const custom = resolveConfig({ thresholdRatio: 0.7, retainRatio: 0.2, maxTokens: 4096, stateFile: '/tmp/x.json' });
  eq('自定义阈值生效', custom.thresholdRatio, 0.7);
  const rejects = (label, raw, expectation) => {
    try {
      resolveConfig(raw);
      ok(label, false, '未抛错');
    } catch (error) {
      ok(label, String(error.message).includes(expectation), `错误信息：${error.message}`);
    }
  };
  rejects('保留比不得 ≥ 阈值比', { thresholdRatio: 0.5, retainRatio: 0.5 }, 'retainRatio');
  rejects('未知配置项被拒', { nope: 1 }, '未知配置项');
  rejects('maxTokens 必须正整数', { maxTokens: 0 }, 'maxTokens');
}

/* ── 9. 选择落盘往返 ───────────────────────────────────────────────────── */

{
  const dir = mkdtempSync(join(tmpdir(), 'ukc-'));
  const file = join(dir, 'state.json');
  const store = createStore(file);
  eq('未知会话默认关', store.enabled('s1'), false);
  store.set('s1', true);
  store.set('s2', false);
  const reloaded = createStore(file);
  eq('重启后仍在', reloaded.enabled('s1'), true);
  eq('未启用的会话保持关', reloaded.enabled('s2'), false);
  eq('记录写入了 decidedAt', typeof reloaded.get('s1').decidedAt, 'number');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  eq('落盘结构', raw.version, 1);
  eq('落盘条目', Object.keys(raw.sessions).sort(), ['s1', 's2']);
  rmSync(dir, { recursive: true, force: true });
}

/* ── 10. 装配面 ────────────────────────────────────────────────────────── */

{
  eq('导出 apply', typeof apply, 'function');
}

/* ── 汇总 ──────────────────────────────────────────────────────────────── */

if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.stdout.write(`\nSELFTEST FAIL（${passed} 通过 / ${failures.length} 失败）\n`);
  process.exit(1);
}
process.stdout.write(`SELFTEST PASS（${passed} 项）\n`);
