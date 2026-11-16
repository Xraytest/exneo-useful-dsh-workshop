/**
 * 统计插件「按分组」维度的独立验证（对**已打过补丁的**统计插件目录跑）。
 *
 *   node plugins/dsh-model-groups/stats-integration-verify.mjs <统计插件目录>
 *
 * 只依赖 fold.js 的真实导出（不 mock），因此验证的是聚合逻辑本身：
 *   1. by=group 按解析结果分桶，未命中进「未分组」桶；
 *   2. **互斥性**：各分组行之和 == totals（不重复计入、不丢量）——分组口径
 *      能对账的前提；
 *   3. 分组行带 label（组名）/ ungrouped / providers（跨供应商成员可见）；
 *   4. 分组插件缺席（无 groupOf）时退化为单个「未分组」行，不抛错；
 *   5. 回归：provider / model / day 三个既有维度的输出与补丁前口径一致
 *      （按键求和仍等于 totals，行的关键字段齐全）。
 *
 * 末行 VERIFY PASS 才算过。
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolvePath(process.argv[2] || '.');
assert.ok(existsSync(join(dir, 'fold.js')), `fold.js 不存在：${dir}`);
const { aggregate } = await import(pathToFileURL(join(dir, 'fold.js')).href);

const DAY = Date.UTC(2026, 9, 8, 12, 0, 0);
const fact = (p, m, tt, offsetHours = 0) => ({
  t: DAY + offsetHours * 3600_000, p, m, tt, it: tt - 10, ot: 6, cr: 4, cw: 0, rt: 1, k: 'main',
});

/** 两个会话：跨供应商的同一组、组外模型、大小写变体。 */
const sessions = [
  {
    id: 's1',
    meta: { title: '会话一' },
    logFacts: [
      fact('our-free-model', 'kimi-k3', 1000),
      fact('localhost', 'qwen/qwen3.8-27b:free', 2000),
      fact('localhost', 'step-5-preview', 500),
    ],
    auxFacts: [fact('our-free-model', 'kimi-k3', 100, 1)],
  },
  {
    id: 's2',
    meta: { title: '会话二' },
    logFacts: [
      fact('localhost', 'step-5-preview', 700, 2),
      fact('localhost', 'deepseek-ai/DeepSeek-V4.1-Flash', 300, 3),
    ],
    auxFacts: [],
  },
];

/** 与 dsh-model-groups 一致的最小解析器（组 free 跨两个供应商）。 */
const FREE = [['our-free-model', '*'], ['localhost', 'qwen/qwen3.8-27b:free']];
const groupOf = (provider, model) => (FREE.some(([p, m]) => (p === '*' || p === provider) && (m === '*' || m === model)) ? 'free' : null);
const labels = { free: '免费车道' };

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (error) { failures.push({ name, error }); process.stdout.write('x'); }
}
const section = (title) => process.stdout.write(`\n${title}\n  `);
const sum = (rows, field) => rows.reduce((acc, row) => acc + row[field], 0);

section('分组维度');

test('by=group：按解析结果分桶 + 未分组桶', () => {
  const result = aggregate(sessions, { by: 'group', groupOf, groupLabels: labels, ungroupedKey: '__ungrouped__', ungroupedLabel: '未分组' });
  assert.equal(result.by, 'group');
  const keys = result.rows.map((row) => row.key).sort();
  assert.deepEqual(keys, ['__ungrouped__', 'free']);
  const free = result.rows.find((row) => row.key === 'free');
  const ungrouped = result.rows.find((row) => row.key === '__ungrouped__');
  assert.equal(free.total, 3100, '跨供应商同组：1000+100+2000');
  assert.equal(ungrouped.total, 1500, '组外：500+700+300');
  assert.equal(free.label, '免费车道', 'label 用组名');
  assert.equal(ungrouped.label, '未分组');
  assert.equal(ungrouped.ungrouped, true);
  assert.equal(free.ungrouped, false);
});

test('互斥性：各分组行之和 == totals（可对账，不重复计入）', () => {
  const result = aggregate(sessions, { by: 'group', groupOf, groupLabels: labels, ungroupedKey: '__ungrouped__' });
  for (const field of ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total']) {
    assert.equal(sum(result.rows, field), result.totals[field], `${field} 应逐项相等`);
  }
  assert.equal(result.totals.total, 4600);
  assert.equal(result.totals.calls, 6);
  assert.equal(result.totals.sessions, 2);
});

test('分组行：providers 列出组内供应商；sessions 去重计数', () => {
  const result = aggregate(sessions, { by: 'group', groupOf, groupLabels: labels, ungroupedKey: '__ungrouped__' });
  const free = result.rows.find((row) => row.key === 'free');
  assert.deepEqual([...free.providers].sort(), ['localhost', 'our-free-model'], '整组成员可跨供应商');
  assert.equal(free.sessions, 1, '两个事实都来自 s1');
  const ungrouped = result.rows.find((row) => row.key === '__ungrouped__');
  assert.equal(ungrouped.sessions, 2, '未分组桶横跨两个会话');
});

test('大小写变体归入未分组（默认区分大小写），组名缺失时退回 id', () => {
  const result = aggregate(sessions, { by: 'group', groupOf, groupLabels: {}, ungroupedKey: '__ungrouped__' });
  const free = result.rows.find((row) => row.key === 'free');
  assert.equal(free.label, 'free', '没有名字时用 id');
  const ci = aggregate(sessions, {
    by: 'group',
    groupOf: (p, m) => (/deepseek-v4\.1-flash/i.test(m) ? 'nv' : groupOf(p, m)),
    groupLabels: { nv: 'NVIDIA', free: '免费车道' },
    ungroupedKey: '__ungrouped__',
  });
  assert.equal(ci.rows.find((row) => row.key === 'nv').total, 300);
});

test('分组插件缺席：单桶兜底，不抛错、不丢量', () => {
  const result = aggregate(sessions, { by: 'group', ungroupedKey: '__ungrouped__' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].key, '__ungrouped__');
  assert.equal(result.rows[0].total, result.totals.total);
  assert.equal(result.rows[0].ungrouped, true);
});

test('解析器抛错不应炸聚合（消费方已自行 try/catch 的前提）', () => {
  const result = aggregate(sessions, { by: 'group', groupOf: (p, m) => (m === 'kimi-k3' ? 'free' : null), ungroupedKey: '__ungrouped__' });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find((row) => row.key === 'free').total, 1100);
});

section('既有维度回归');

test('model / provider / day 输出形状不变，且都与 totals 对齐', () => {
  const byModel = aggregate(sessions, { by: 'model' });
  assert.equal(sum(byModel.rows, 'total'), byModel.totals.total);
  assert.equal(byModel.rows.length, 4);
  assert.equal(byModel.rows[0].total, 2000, '按 total 降序');
  assert.ok(Array.isArray(byModel.rows[0].providers), 'by=model 仍带 providers');
  assert.equal(byModel.rows[0].label, undefined, 'by=model 不新增 label（由 index.js 兜别名）');

  const byProvider = aggregate(sessions, { by: 'provider' });
  assert.deepEqual(byProvider.rows.map((row) => row.key).sort(), ['localhost', 'our-free-model']);
  assert.equal(byProvider.rows.find((row) => row.key === 'localhost').total, 3500);
  assert.equal(byProvider.rows[0].ungrouped, undefined, 'by=provider 不应带 ungrouped 字段');

  const byDay = aggregate(sessions, { by: 'day', timeZone: 'UTC' });
  assert.equal(byDay.rows.length, 1);
  assert.equal(byDay.rows[0].key, '2026-10-08');
  assert.equal(sum(byDay.rows, 'total'), byDay.totals.total);

  const byWeek = aggregate(sessions, { by: 'week', timeZone: 'UTC', weekStart: 1 });
  assert.equal(byWeek.rows.length, 1);
  assert.equal(byWeek.rows[0].key, '2026-10-05', '周一为周界');
});

test('时间范围过滤对分组维度同样生效', () => {
  const narrowed = aggregate(sessions, {
    by: 'group', groupOf, groupLabels: labels, ungroupedKey: '__ungrouped__',
    timeZone: 'UTC', fromKey: '2026-10-08', toKey: '2026-10-08',
  });
  assert.equal(narrowed.totals.total, 4600);
  const empty = aggregate(sessions, {
    by: 'group', groupOf, groupLabels: labels, ungroupedKey: '__ungrouped__',
    timeZone: 'UTC', fromKey: '2026-10-09',
  });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.totals.total, 0);
});

section('接口白名单');

test("index.js 的 BY 白名单含 'group'，且未破坏既有维度", async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(join(dir, 'index.js'), 'utf8'));
  const match = /const BY = \[([^\]]*)\]/.exec(source);
  assert.ok(match !== null, '找不到 BY 定义');
  const by = match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const dim of ['model', 'provider', 'group', 'session', 'day', 'week']) assert.ok(by.includes(dim), `BY 缺少 ${dim}`);
  assert.ok(source.includes("by === 'group' ? groupResolver() : null"), 'summaryPayload 未接分组解析');
  assert.ok(source.includes('UNGROUPED_KEY'), 'index.js 未定义未分组桶常量');
});

process.stdout.write('\n');
if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) {
    process.stdout.write(`  ✗ ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 5).join('\n    ') : failure.error}\n`);
  }
  process.stdout.write(`VERIFY FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`VERIFY PASS (${passed} checks, dir=${dir})\n`);
}
