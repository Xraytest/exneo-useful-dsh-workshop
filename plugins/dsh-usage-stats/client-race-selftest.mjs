/**
 * dsh-usage-stats / 浏览器半边「过期响应」回归（headless，不需要浏览器）。
 *
 *   node plugins/dsh-usage-stats/client-race-selftest.mjs      # 末行 SELFTEST PASS 才算过
 *
 * 背景（用户实测报告）：点开「分组」页签时，页面会闪出一行红字
 * 「统计插件返回的维度是「model」而不是「group」……」，随后自己消失，功能最终正确。
 * 根因是 `load()` 的**过期响应**没被丢弃，且加载期间还拿上一个维度的 `data` 跟新页签
 * 比较。本文件把这两条都钉成回归：
 *
 *   R1 切页签后，**旧维度的响应后到** → 只允许新维度的结果写进状态（旧响应必须被丢弃）
 *   R2 切页签后、新响应回来之前 → 不得渲染那行红字（也不得渲染旧维度的行）
 *   R3 旧维度的响应**晚于**新维度到达 → 仍然显示新维度（不能把页面退回旧数据）
 *   R4 失败/错误也只认最新一次请求：旧请求的失败不得覆盖新请求的成功
 *   R5 宿主**真的**不支持该维度时，红字仍要在响应到达后照常出现（别把提示一起修没了）
 *   R6 连续快速切 3 个页签 → 最终状态一定是最后一个页签，且期间无红字
 *
 * 做法：`new Function` 以脚本语义跑 client.js，捕获 __ModuleLoader__.load，
 * 用一个只实现 useState/useRef/useCallback/useEffect/useMemo 的 react 桩渲染
 * `UsageStats`，fetch 桩的手动 resolve 队列用来精确控制响应到达顺序。零 DOM。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------- 桩件 ---- */

/** 手动控制的手动 resolve 队列：每次 fetch 返回一个「待决」promise。 */
const pending = [];
let fetchLog = [];
function fetchStub(url) {
  const target = String(url);
  fetchLog.push(target);
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  pending.push({ url: target, resolve, reject });
  return promise;
}
const take = (predicate) => {
  const at = pending.findIndex((p) => predicate(p.url));
  assert.ok(at >= 0, '没有待决请求匹配：' + fetchLog.join(' , '));
  return pending.splice(at, 1)[0];
};
const answer = (entry, payload) => entry.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
const answerError = (entry, message) => entry.resolve({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({ error: message }) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 回填轮询用 setInterval：捕获回调，由测试自己决定什么时候「到点」（真实 900ms 太慢）。
const intervalCallbacks = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; };
globalThis.clearInterval = () => {};

let hookIndex = 0;
let state = [];
let refSlots = [];
const effects = [];
function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { $$element: true, type, props: merged };
}
const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookIndex++;
    if (state.length <= index || state[index] === undefined) state[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value; };
    return [state[index], setter];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (refSlots[index] === undefined) refSlots[index] = { current: initial };
    return refSlots[index];
  },
  useCallback(fn) { hookIndex += 1; return fn; },
  useEffect(fn) { hookIndex += 1; effects.push(fn); },
  useMemo(fn) { hookIndex += 1; return fn(); },
};

const styleNodes = [];
const documentStub = {
  head: { appendChild(node) { styleNodes.push(node); } },
  documentElement: { appendChild(node) { styleNodes.push(node); } },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
};
globalThis.document = documentStub;
let captured = null;
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } }, addEventListener() {}, removeEventListener() {} };
const require = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal: (children) => createElement('portal', null, children) };
  throw new Error('unexpected require: ' + name);
};
new Function('window', 'document', 'require', 'fetch', source)(globalThis.window, documentStub, require, fetchStub);

/* ------------------------------------------------------------- 挂载 ---- */

assert.ok(captured !== null, 'client.js 必须调用 window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-usage-stats');
const exports = captured.factory(require);
const registrations = [];
exports.apply({
  slots: {
    inject(name, fn) { assert.equal(name, 'settings.section'); fn(); },
    register(meta, component) { registrations.push({ meta, component }); },
  },
});
assert.equal(registrations.length, 1, '必须注册一个 settings.section');
assert.equal(registrations[0].meta.id, 'usage-stats');

const Page = registrations[0].component;

/** 渲染一次：重置 hook 次序，跑组件函数，返回元素树；同时把 useEffect 收集起来。 */
function render() {
  hookIndex = 0;
  effects.length = 0;
  const element = Page();
  return element.type(element.props);
}

/* ------------------------------------------------------------- 断言件 -- */

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (node.$$element === true) { visit(node); walk(node.props.children, visit); }
};
const textOf = (value) => {
  const parts = [];
  const visit = (item) => {
    if (typeof item === 'string' || typeof item === 'number') { parts.push(String(item)); return; }
    if (Array.isArray(item)) { for (const one of item) visit(one); return; }
    if (item !== null && typeof item === 'object' && item.$$element === true) visit(item.props.children);
  };
  visit(value);
  return parts.join(' ');
};
const findByClass = (node, cls) => {
  const out = [];
  walk(node, (el) => { if (typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls)) out.push(el); });
  return out;
};
const errors = (node) => findByClass(node, 'ust-error').map((el) => textOf(el.props.children));
const dimensionNotice = (node) => errors(node).filter((text) => text.includes('统计插件返回的维度'));
const emptyText = (node) => findByClass(node, 'ust-empty').map((el) => textOf(el.props.children));
/** 元素树里第一个文本节点（行标签就是首列的第一个文本，副标题形态各维度不同）。 */
const firstText = (value) => {
  let out = null;
  const visit = (item) => {
    if (out !== null) return;
    if (typeof item === 'string' || typeof item === 'number') { out = String(item); return; }
    if (Array.isArray(item)) { for (const one of item) visit(one); return; }
    if (item !== null && typeof item === 'object' && item.$$element === true) visit(item.props.children);
  };
  visit(value);
  return out;
};
/** 数据行的首列标签。 */
const rowLabels = (node) => {
  const out = [];
  walk(node, (el) => {
    if (el.type !== 'tr') return;
    const cells = [];
    walk(el.props.children, (cell) => { if (cell.type === 'td') cells.push(cell); });
    if (cells.length > 0) out.push(firstText(cells[0].props.children));
  });
  return out;
};
const tabButtons = (node) => {
  const out = [];
  walk(node, (el) => {
    if (el.type === 'button' && typeof el.props.className === 'string' && el.props.className.split(' ').includes('ust-tab')) out.push(el);
  });
  return out;
};
const clickTab = (node, label) => {
  const hit = tabButtons(node).find((el) => textOf(el.props.children) === label);
  assert.ok(hit !== undefined, `找不到页签：${label}（实际：${tabButtons(node).map((el) => textOf(el.props.children)).join('/')}）`);
  hit.props.onClick();
};

/* ------------------------------------------------------------- 驱动件 -- */

/** 挂载并跑首屏 effect（此刻只有一个 summary 请求在飞——load() 是串行的）。 */
function mount() {
  state = [];
  refSlots = [];
  render();
  for (const fn of effects.slice()) {
    const cleanup = fn();
    assert.equal(cleanup, undefined, '首屏 effect 不应返回清理函数');
  }
  return take((url) => url.includes('/dsh-usage/summary'));
}
/** 切页签：点击 → 重渲染 → 跑新登记的 effect，返回这次新起的 summary 请求。 */
function switchTab(tree, label) {
  clickTab(tree, label);
  tree = render();
  for (const fn of effects.slice()) fn();
  return take((url) => url.includes('/dsh-usage/summary'));
}
/**
 * 只跑「第 index 个及之后」的 effect。回填轮询是组件里最后一个 effect，这样启动它时不会
 * 顺带再触发一次 load（否则 /status 请求混在一起，测不出轮询自身的竞态）。
 */
function runEffectsFrom(index) {
  for (const fn of effects.slice(index)) fn();
}
const clickButton = (node, label) => {
  const found = [];
  walk(node, (el) => { if (el.type === 'button') found.push(el); });
  // 精确匹配文案：'全部'（时间范围）与 '重建全部'（回填按钮）会互相撞车，
  // 撞错了就会悄悄多跑一次 POST /dsh-usage/rescan。
  const hit = found.find((el) => textOf(el.props.children).trim() === label);
  assert.ok(hit !== undefined, `找不到文案为「${label}」的按钮（实际：${found.map((el) => textOf(el.props.children).trim()).join(' / ')}）`);
  hit.props.onClick();
};
/** 状态行文案（「…已折叠 N 会话 · 事实 M…」整行）。 */
const statusLine = (node) => {
  const hits = [];
  walk(node, (el) => { const text = textOf(el.props.children); if (text.includes('已折叠')) hits.push(text); });
  return hits.length > 0 ? hits[0] : '';
};
const paint = () => render();

/**
 * 应答某个 summary 请求，并顺带应答它随后串行发出的 status 请求。
 * `load()` 只在**两者都到齐**后才写状态，所以测试必须按这个顺序回包。
 */
async function settle(summaryEntry, payload, status = statusPayload()) {
  answer(summaryEntry, payload);
  await tick();
  answer(take((url) => url.includes('/dsh-usage/status')), status);
  await tick();
  await tick();
}

const summaryPayload = (by, rows) => ({ by, range: 'all', rows, totals: { calls: 1, total: 10, sessions: 1 }, series: [] });
const statusPayload = () => ({
  schema: 1, timeZone: 'UTC', weekStart: 1, dir: '/tmp', config: {}, pendingWrites: 0, loadErrors: [],
  sessions: { total: 1, folded: 1 }, facts: { total: 1 }, backfill: { running: false }, gaps: { searchRequests: 0 },
  groups: { available: true, groups: 1, ungroupedKey: '__ungrouped__' },
  modelSettings: { available: true, models: 1 },
});
const MODEL_ROWS = [{ key: 'm1', label: 'model-row', calls: 1, total: 10, share: 1, sessions: 1, providers: ['p'] }];
const GROUP_ROWS = [{ key: 'g1', label: 'group-row', calls: 1, total: 10, share: 1, sessions: 1, providers: ['p'] }];
const DAY_ROWS = [{ key: 'd1', label: 'day-row', calls: 1, total: 10, share: 1, sessions: 1 }];

/* ------------------------------------------------------------- runner -- */

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; process.stdout.write('.'); }
  catch (error) { failures.push({ name, error }); process.stdout.write('x'); }
}

process.stdout.write('\n过期响应回归（切页签不应闪红字 / 不应显示旧维度 / 轮询不乱序）\n  ');

await test('R1 点开分组页签的瞬间：无红字、无旧维度的数据行', async () => {
  let tree = paint();
  const first = mount();
  await settle(first, summaryPayload('model', MODEL_ROWS));
  tree = paint();
  assert.deepEqual(rowLabels(tree), ['model-row'], '首屏应显示模型维度');
  assert.deepEqual(dimensionNotice(tree), [], '首屏不该有红字');

  // 关键一步：**首屏还没回来就切页签**（用户点击时的真实情形）
  const slow = switchTab(tree, '分组');
  tree = paint();
  assert.deepEqual(dimensionNotice(tree), [], '刚点开分组页签时不得出现红字');
  assert.deepEqual(rowLabels(tree), [], '加载中不得继续显示旧维度的行');
  assert.deepEqual(emptyText(tree), ['加载中…'], '应显示加载中');

  // 结论：切页签后旧维度数据被清掉，不会拿它跟新页签比对
  await settle(slow, summaryPayload('group', GROUP_ROWS));
  tree = paint();
  assert.deepEqual(dimensionNotice(tree), [], '分组结果到达后不该有红字');
  assert.deepEqual(rowLabels(tree), ['group-row']);
});

await test('R2 旧维度响应后到：不得写进状态（只认最新一次请求）', async () => {
  const slow = mount();                              // by=model，先不回包
  const tree0 = paint();
  const fresh = switchTab(tree0, '分组');             // by=group，立刻切
  await settle(fresh, summaryPayload('group', GROUP_ROWS));
  let tree = paint();
  assert.deepEqual(rowLabels(tree), ['group-row']);

  await settle(slow, summaryPayload('model', MODEL_ROWS));   // 旧响应现在才到
  tree = paint();
  assert.deepEqual(rowLabels(tree), ['group-row'], '过期响应不得覆盖新维度');
  assert.deepEqual(dimensionNotice(tree), [], '过期响应不得触发红字');
});

await test('R3 旧响应**晚于**新响应落地：页面不得退回旧数据', async () => {
  // 关键在于两个请求都「配对到齐」的先后：旧请求的 summary+status **最后**才凑齐，
  // 于是它的写状态尝试落在新请求之后——这正是过期响应最坏的情形。
  const slow = mount();                       // by=model：summary 先不回
  const tree0 = paint();
  const fresh = switchTab(tree0, '分组');      // by=group：summary 先不回

  answer(slow, summaryPayload('model', MODEL_ROWS));   // 旧 summary 到 → 旧请求转去取 status
  await tick();
  const slowStatus = take((url) => url.includes('/dsh-usage/status'));

  answer(fresh, summaryPayload('group', GROUP_ROWS));  // 新 summary 到 → 新请求转去取 status
  await tick();
  const freshStatus = take((url) => url.includes('/dsh-usage/status'));

  answer(freshStatus, statusPayload());        // 新请求先到齐 → 写状态
  await tick(); await tick();
  answer(slowStatus, statusPayload());         // 旧请求后到齐（修复前：覆盖成旧维度）
  await tick(); await tick();
  const tree = paint();
  assert.deepEqual(rowLabels(tree), ['group-row'], '过期响应不得把页面退回旧维度');
  assert.deepEqual(dimensionNotice(tree), [], '过期响应不得触发红字');
});

await test('R4 旧请求的失败不得覆盖新请求的成功', async () => {
  const slow = mount();
  const tree0 = paint();
  const fresh = switchTab(tree0, '分组');

  answer(fresh, summaryPayload('group', GROUP_ROWS));
  await tick();
  answer(take((url) => url.includes('/dsh-usage/status')), statusPayload());
  await tick(); await tick();
  answerError(slow, '旧请求失败');
  await tick();
  const lateStatus = pending.find((entry) => entry.url.includes('/dsh-usage/status'));
  if (lateStatus) answerError(lateStatus, '旧请求失败');
  await tick(); await tick();
  const tree = paint();
  assert.deepEqual(errors(tree), [], '过期请求的失败不该显示成错误');
  assert.deepEqual(rowLabels(tree), ['group-row'], '新数据必须保留');
});

await test('R5 宿主真的不支持该维度时，红字仍要出现（别把提示修没了）', async () => {
  const first = mount();
  await settle(first, summaryPayload('model', MODEL_ROWS));
  let tree = paint();

  const asked = switchTab(tree, '分组');            // 宿主忽略 by=group，仍回 by=model
  await settle(asked, summaryPayload('model', MODEL_ROWS));
  tree = paint();
  const notices = dimensionNotice(tree);
  assert.equal(notices.length, 1, '宿主不支持该维度时必须给出红字说明：' + JSON.stringify(errors(tree)));
  assert.ok(notices[0].includes('model') && notices[0].includes('group'), '提示要写清实际维度与请求维度：' + notices[0]);
});

await test('R6 连续快切 3 个页签：最终只认最后一个，且全程无红字', async () => {
  await settle(mount(), summaryPayload('model', MODEL_ROWS));
  let tree = paint();

  const second = switchTab(tree, '分组');
  const third = switchTab(paint(), '每日');
  assert.ok(third.url.includes('by=day'), '最后一次请求应是 by=day：' + third.url);
  tree = paint();
  assert.deepEqual(dimensionNotice(tree), []);

  // 乱序回包：最新的（每日）先到，过期的（分组）后到
  await settle(third, summaryPayload('day', DAY_ROWS));
  await settle(second, summaryPayload('group', GROUP_ROWS));
  tree = paint();
  assert.deepEqual(dimensionNotice(tree), [], '乱序回包不得触发红字');
  const rows = rowLabels(tree);
  assert.deepEqual(rows, ['day-row'], '最终必须是最后一个页签的数据：' + JSON.stringify(rows));
});

await test('R7 点击当次提交就不该含红字（不依赖 effect 时序的结构性保证）', async () => {
  const first = mount();
  await settle(first, summaryPayload('model', MODEL_ROWS));
  let tree = paint();
  assert.deepEqual(rowLabels(tree), ['model-row']);

  // 只点击 + 重渲染，**故意不跑 effect**：模拟「setBy 已提交、load 的 effect 还没跑」的
  // 中间态。旧数据必须已经在同一次更新里被清掉，否则红字会被提交进 DOM——真实浏览器里
  // 只是靠 React 在绘制前冲刷被动 effect 才没画出来（换成定时器/过渡更新就会露出来）。
  clickTab(tree, '分组');
  tree = paint();
  assert.deepEqual(dimensionNotice(tree), [], '点击当次提交里不得含维度红字（不能只靠 effect 时序）');
  assert.deepEqual(rowLabels(tree), [], '点击当次提交里不得仍显示旧维度的行');
});

await test('R8 回填轮询：旧的状态响应不得覆盖新响应的数字', async () => {
  const first = mount();
  await settle(first, summaryPayload('model', MODEL_ROWS));
  let tree = paint();

  // 点「重建全部」开始回填 → busy=true → 轮询 effect 启动（组件里最后一个 effect）
  clickButton(tree, '重建全部');
  tree = render();
  runEffectsFrom(2);
  answer(take((url) => url.includes('/dsh-usage/rescan')), { started: true });
  await tick();
  const tickA = take((url) => url.includes('/dsh-usage/status'));   // effect 启动时的立即 tick
  intervalCallbacks.forEach((fn) => fn());                          // 900ms 到点：第二次 tick
  await tick();
  const tickB = take((url) => url.includes('/dsh-usage/status'));
  assert.ok(intervalCallbacks.length > 0, '回填期间应登记轮询定时器');

  const poll = (folded, facts) => Object.assign(statusPayload(), {
    sessions: { total: folded, folded },
    facts: { total: facts },
    backfill: { running: true, scanned: 0, folded: 0, skipped: 0, imported: 0 },
  });
  answer(tickB, poll(99, 999));     // 新的先回
  await tick();
  answer(tickA, poll(1, 10));       // 旧的后回（修复前：状态行数字回退）
  await tick(); await tick();
  tree = paint();
  const line = statusLine(tree);
  assert.ok(line.includes('已折叠 99'), '状态行必须保留最新一次轮询的数字：' + line);
  assert.ok(line.includes('事实 999'), '事实数同样必须保留最新值：' + line);
});

await test('R9 点当前项（无效点击）不得清空表格、也不得多发请求', async () => {
  const first = mount();
  await settle(first, summaryPayload('model', MODEL_ROWS));
  let tree = paint();
  const before = fetchLog.length;

  clickTab(tree, '模型');            // 已经在这个页签上
  tree = paint();
  assert.deepEqual(rowLabels(tree), ['model-row'], '无效点击后表格必须还在');
  assert.equal(fetchLog.length, before, '无效点击不该再发请求');

  clickButton(tree, '全部');          // 时间范围里点当前项
  tree = paint();
  const afterRange = fetchLog.length;
  assert.ok(rowLabels(tree).length === 1, '无效的范围点击后表格必须还在：' + JSON.stringify(rowLabels(tree)));
  assert.equal(afterRange, before, '无效的范围点击不该再发请求');
});

/* ------------------------------------------------------------- 收尾 ---- */

process.stdout.write('\n\n');
if (failures.length > 0) {
  for (const item of failures) {
    process.stdout.write('  ✗ ' + item.name + '\n');
    process.stdout.write('    ' + String(item.error && item.error.message ? item.error.message : item.error).split('\n').slice(0, 6).join('\n    ') + '\n');
  }
  process.stdout.write(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exit(1);
}
process.stdout.write(`SELFTEST PASS (${passed} checks client-race)\n`);
