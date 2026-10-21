/**
 * dsh-model-retry 浏览器半边自测（headless，不需要浏览器）。
 *
 *   node plugins/dsh-model-retry/client-selftest.mjs
 *
 * 与 dsh-model-groups/client-selftest.mjs 同款：`new Function` 以脚本语义执行
 * client.js（只影子化 window / document / require / fetch），捕获
 * __ModuleLoader__.load 注册，再用最小 react 桩渲染设置页——断言直接读元素树。
 *
 * 末段是 C4–C8 回归：模式往返不丢用户填的值 / maxRetries 上限闸门与 400 报错
 * 翻译 / 每条规则稳定 uid（保存剥掉）/ 加载失败进 error 态可重试 / 分组目录为
 * 空或规则引用未知分组时的显示。桩不会自动重渲染或重跑 effect：改完 state 要
 * 手动 `render()`（必要时再手动跑一次 effect）才算「React 提交了一轮」。
 *
 * 末行 SELFTEST PASS 才算过。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* --------------------------------------------------------------- 桩件 ---- */

let timerSeq = 0;
const timers = [];
globalThis.setTimeout = (fn) => { timers.push(fn); return ++timerSeq; };
globalThis.clearTimeout = () => {};
const runTimers = () => { const pending = timers.splice(0, timers.length); for (const fn of pending) fn(); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

let rulesPayload = {
  ok: true,
  rules: [],
  defaults: { mode: 'normal', maxRetries: 5, retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'], statusCodes: [], backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } },
  knownCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED'],
  groups: [],
  groupsAvailable: false,
  warnings: [],
};
let previewPayload = { ok: true, provider: 'our-free-model', model: 'kimi-k3', groupId: 'free', groupName: '免费车道', ruleIndex: 0, rule: { group: 'free', mode: 'always' }, policy: { mode: 'always', backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }, source: 'rule', scores: [{ index: 0, score: 3, rule: { group: 'free', mode: 'always' } }] };
let catalogPayload = { ok: true, value: { groups: [] } };
// 失败注入：复现 GET /rules 网络错 / 非 JSON 4xx、POST 400 校验拒绝等场景。
//   null | { kind: 'network' } | { kind: 'text', status, statusText }
//        | { kind: 'status', status, statusText, body }
let failGetRules = null;
let failPostRules = null;
const requests = [];
async function fetchStub(url, options) {
  const target = String(url);
  const entry = { url: target, method: (options && options.method) || 'GET', body: options && options.body ? JSON.parse(options.body) : null };
  requests.push(entry);
  const isRules = target.indexOf('/dsh-model-retry/rules') !== -1;
  const failure = isRules ? (entry.method === 'POST' ? failPostRules : failGetRules) : null;
  if (failure !== null && failure !== undefined) {
    if (failure.kind === 'network') throw new TypeError('Failed to fetch');
    const statusText = failure.statusText || 'Bad Request';
    const json = failure.kind === 'text'
      ? async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); }
      : async () => failure.body;
    return { ok: false, status: failure.status, statusText, json };
  }
  const payload = target.indexOf('/dsh-model-retry/preview') !== -1 ? previewPayload
    : (isRules
      ? (entry.method === 'POST' ? { ok: true, rules: entry.body.rules } : rulesPayload)
      : {});
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
}

let hookIndex = 0;
let state = [];
let stateLog = [];
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
    const setter = (value) => {
      const previous = state[index];
      state[index] = typeof value === 'function' ? value(previous) : value;
      stateLog.push({ index, value: state[index] });
    };
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

/* ------------------------------------------------------------- runner ---- */

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write('.'); }
  catch (error) { failures.push({ name, error }); process.stdout.write('x'); }
}
const section = (title) => process.stdout.write(`\n${title}\n  `);

/* --------------------------------------------------------- 工具 --------- */

function render(seed) {
  if (seed !== undefined) { state = seed.slice(); refSlots = []; }
  hookIndex = 0; stateLog = []; effects.length = 0; timers.length = 0;
  const wrapper = registrations[0].component({ close: () => {} });
  return wrapper.type(wrapper.props);
}
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (node.$$element === true) { visit(node); walk(node.props.children, visit); }
}
function collectText(node) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value !== null && typeof value === 'object' && value.$$element === true) visit(value.props.children);
  };
  visit(node);
  return parts.join(' | ');
}
const findAll = (node, predicate) => { const out = []; walk(node, (el) => { if (predicate(el)) out.push(el); }); return out; };
const byClass = (node, cls) => findAll(node, (el) => typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls));
const buttonsIn = (node) => findAll(node, (el) => el.type === 'button');
const textOf = (node) => collectText(node);
function buttonByText(node, text) {
  const hit = buttonsIn(node).find((el) => collectText(el) === text);
  assert.ok(hit !== undefined, `找不到按钮: ${text}`);
  return hit;
}
const lastWriteOf = (index) => {
  for (let at = stateLog.length - 1; at >= 0; at -= 1) if (stateLog[at].index === index) return stateLog[at].value;
  return undefined;
};

/* --------------------------------------------------------- 外壳 --------- */

section('模块外壳与挂载');

assert.ok(captured !== null, 'factory 未注册到 __ModuleLoader__');
assert.equal(captured.id, 'dsh-model-retry');
const exports = captured.factory(require);
const ui = exports.__ui;

await test('exports 形状与注册参数', () => {
  const registrations = [];
  const injected = [];
  exports.apply({
    slots: { inject(name, fn) { injected.push(name); fn(); }, register(meta, component) { registrations.push({ meta, component }); } },
    remote: { session: { modelCatalog: async () => catalogPayload } },
  });
  // 先交给后续用例：本用例里的断言失败不该连累它们（桩件只在这里注册一次）
  globalThis.__reg = registrations;
  assert.deepEqual(exports.inject, ['slots', 'remote', 'remote.session']);
  assert.deepEqual(ui.hookLayout, ['rules', 'defaults', 'knownCodes', 'catalog', 'error', 'saveState', 'groups', 'groupsAvailable', 'warnings', 'preview', 'loadState', 'reloadSeq']);
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registrations[0].meta.id, 'retry-policy');
  assert.equal(registrations[0].meta.order, 30);
  assert.equal(registrations[0].meta.label, '重试策略');
  assert.equal(styleNodes.length, 1);
});
const registrations = globalThis.__reg;

/* --------------------------------------------------------- 纯函数 ------- */

section('纯函数');

await test('policyText：普通 / 持续两种模式的中文摘要', () => {
  assert.ok(ui.policyText({ mode: 'always', backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }).includes('持续重试'));
  const normal = ui.policyText({ mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'], statusCodes: [429], backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } });
  assert.ok(normal.includes('最多 3 次'), normal);
  assert.ok(normal.includes('RATE_LIMIT'));
  assert.ok(normal.includes('429'));
  assert.equal(ui.policyText(null), '（无策略）');
});

await test('emptyRule 带 group 槽（新增规则默认不按组）', () => {
  const rule = ui.emptyRule();
  assert.equal(rule.group, null);
  assert.equal(rule.provider, '*');
  assert.equal(rule.model, '*');
  assert.equal(rule.mode, 'normal');
  assert.ok(ui.WEIGHT_TEXT.includes('group'));
});

/* --------------------------------------------------------- 渲染 --------- */

const GROUP_RULE = { provider: '*', model: '*', group: 'free', mode: 'always' };
const PLAIN_RULE = { provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash', mode: 'normal', maxRetries: 3, retryableCodes: null, statusCodes: [], backoff: null };
const DEFAULTS = rulesPayload.defaults;

section('渲染与交互');

await test('首屏：拉取规则 + 目录，规则卡片数与删除按钮数一致', async () => {
  rulesPayload = Object.assign({}, rulesPayload, {
    rules: [GROUP_RULE, PLAIN_RULE],
    groups: [{ id: 'free', name: '免费车道', enabled: true, order: 1 }, { id: 'nv', name: 'NVIDIA', enabled: false, order: 0 }],
    groupsAvailable: true,
    warnings: ['规则引用的分组「ghost」不存在：该规则不会命中。'],
  });
  const tree = render([null, null, null, null, '', '', [], null, [], { provider: '', model: '', result: null, busy: false }]);
  effects[0]();
  await tick(); await tick();
  const text = textOf(tree);
  assert.ok(!text.includes('[object Object]'), '渲染文本里不该出现 [object Object]（字符串拼接元素的典型症状）');
  assert.ok(stateLog.some((entry) => entry.index === 0 && Array.isArray(entry.value) && entry.value.length === 2), '应把规则写进 state[0]');
  assert.equal(lastWriteOf(6).length, 2, '分组目录应写进 state[6]');
  assert.equal(lastWriteOf(7), true, 'groupsAvailable 应写进 state[7]');
  assert.equal(lastWriteOf(8).length, 1, '告警应写进 state[8]');
});

await test('页面渲染出规则卡、告警、缺省说明与试用分组提示', () => {
  const tree = render([
    [GROUP_RULE, PLAIN_RULE], DEFAULTS, rulesPayload.knownCodes, { groups: [] }, '', '',
    [{ id: 'free', name: '免费车道', enabled: true, order: 1 }], true,
    ['规则引用的分组「ghost」不存在：该规则不会命中。'],
    { provider: '', model: '', result: null, busy: false },
  ]);
  const text = textOf(tree);
  assert.ok(!text.includes('[object Object]'), text.slice(0, 200));
  assert.equal(findAll(tree, (el) => el.type === ui.RuleCard).length, 2);
  assert.equal(byClass(tree, 'mretry-warn').length, 1, '应渲染告警区');
  assert.ok(text.includes('ghost'));
  assert.ok(text.includes('官方缺省'));
  assert.ok(text.includes('可用分组'));
  assert.ok(byClass(tree, 'mretry-preview').length === 1, '应有试算面板');
});

await test('分组插件不在线：页面给出明确提示', () => {
  const tree = render([
    [], DEFAULTS, rulesPayload.knownCodes, null, '', '', [], false, [], { provider: '', model: '', result: null, busy: false },
  ]);
  const text = textOf(tree);
  assert.ok(text.includes('不在线'), text.slice(0, 300));
  assert.equal(byClass(tree, 'mretry-warn').length, 1);
});

/* ---- 规则卡内的分组选择器：RuleCard 无 hook，可直接单独渲染 ---- */

function renderCard(rule, props = {}) {
  const captured2 = [];
  const tree = ui.RuleCard(Object.assign({
    rule, index: 0,
    onChange: (index, patch) => captured2.push({ index, patch }),
    onRemove: () => {},
    knownCodes: rulesPayload.knownCodes,
    providerGroups: [{ id: 'localhost', name: 'NewAPIGate', models: [{ id: 'm1', name: 'M1' }] }],
    modelsOf: () => [{ id: 'm1', name: 'M1' }],
    allModels: [{ id: 'm1', name: 'M1' }],
    groups: [{ id: 'free', name: '免费车道', enabled: true, order: 1 }, { id: 'nv', name: 'NVIDIA', enabled: false, order: 0 }],
    groupsAvailable: true,
  }, props));
  return { tree, captured: captured2 };
}

await test('规则卡：分组下拉含「不按组」+ 各分组（停用标注），选择后写回 group', () => {
  const { tree, captured } = renderCard({ provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 5 });
  const select = findAll(tree, (el) => el.type === 'select' && String(el.props.className).includes('mretry-group'))[0];
  assert.ok(select !== undefined, '应有分组选择器');
  assert.equal(select.props.value, '');
  const options = findAll(select, (el) => el.type === 'option');
  assert.deepEqual(options.map((o) => o.props.value), ['', 'free', 'nv']);
  assert.ok(textOf(options[2]).includes('已停用'));
  select.props.onChange({ target: { value: 'free' } });
  assert.deepEqual(captured, [{ index: 0, patch: { group: 'free' } }]);
});

await test('规则卡：已有 group 值不在目录里时保留为「组不存在或已停用」选项', () => {
  const { tree, captured } = renderCard({ provider: '*', model: '*', group: 'ghost', mode: 'always' });
  const select = findAll(tree, (el) => el.type === 'select' && String(el.props.className).includes('mretry-group'))[0];
  assert.equal(select.props.value, 'ghost');
  const options = findAll(select, (el) => el.type === 'option');
  assert.ok(options.some((o) => o.props.value === 'ghost' && textOf(o).includes('组不存在')));
  // 选「不按组」应写成 null（而非空串），保证 payload 里整字段消失
  select.props.onChange({ target: { value: '' } });
  assert.deepEqual(captured, [{ index: 0, patch: { group: null } }]);
});

await test('规则卡：分组目录为空时退化为自由输入（不因缺插件而卡住）', () => {
  const { tree, captured } = renderCard({ provider: '*', model: '*', group: 'free', mode: 'always' }, { groups: [], groupsAvailable: false });
  const input = findAll(tree, (el) => el.type === 'input' && String(el.props.className).includes('mretry-group'))[0];
  assert.ok(input !== undefined);
  assert.ok(String(input.props.placeholder).includes('不在线'));
  input.props.onChange({ target: { value: ' free ' } });
  assert.deepEqual(captured, [{ index: 0, patch: { group: 'free' } }], '应 trim');
});

/* ---- 自动保存 ---- */

await test('自动保存：POST body 带 group；mode=always 时不带 maxRetries', async () => {
  requests.length = 0;
  render([[PLAIN_RULE], DEFAULTS, [], null, '', '', [], true, [], { provider: '', model: '', result: null, busy: false }]);
  effects[1]();                       // 基线记账
  assert.equal(timers.length, 0);
  state[0] = [PLAIN_RULE, GROUP_RULE];  // 模拟一次改动
  effects.length = 0;
  render();
  effects[1]();
  assert.equal(timers.length, 1);
  runTimers();
  await tick(); await tick();
  const post = requests.find((entry) => entry.method === 'POST' && entry.url === '/dsh-model-retry/rules');
  assert.ok(post !== undefined, '应 POST 保存');
  assert.equal(post.body.rules.length, 2);
  assert.equal(post.body.rules[1].group, 'free');
  assert.equal(post.body.rules[1].maxRetries, undefined, 'always 模式不应带 maxRetries');
  assert.equal(post.body.rules[0].group, undefined, '未设组的规则不应出现 group 字段');
  assert.ok(stateLog.some((entry) => entry.index === 5 && entry.value === 'saved'));
});

/* ---- 试算 ---- */

await test('试算：POST /preview 并渲染命中规则、分数与策略', async () => {
  requests.length = 0;
  // 卡片内的「试算」按钮在被渲染的页面树上（previewBox 在页面内联）
  const tree = render([
    [GROUP_RULE], DEFAULTS, rulesPayload.knownCodes, { groups: [{ id: 'our-free-model', name: 'OurFreeModel', models: [{ id: 'kimi-k3', name: 'KimiK3' }] }] }, '', '', [{ id: 'free', name: '免费车道', enabled: true, order: 1 }], true, [],
    { provider: 'our-free-model', model: 'kimi-k3', result: null, busy: false },
  ]);
  buttonByText(tree, '试算').props.onClick();
  await tick(); await tick();
  const post = requests.find((entry) => entry.url === '/dsh-model-retry/preview');
  assert.ok(post !== undefined, '应 POST /preview');
  assert.deepEqual(post.body, { provider: 'our-free-model', model: 'kimi-k3' });
  const write = lastWriteOf(9);
  assert.equal(write.result.ruleIndex, 0, '结果应写进 preview 状态');

  const after = render();
  const text = textOf(after);
  assert.ok(text.includes('命中第 1 条规则'), text.slice(0, 400));
  assert.ok(text.includes('免费车道'));
  assert.ok(text.includes('分数 3'));
  assert.ok(text.includes('持续重试'));
  assert.equal(byClass(after, 'mretry-hit').length, 1);
  assert.equal(byClass(after, 'mretry-score').length, 1);
  assert.ok(byClass(after, 'mretry-score')[0].props.className.includes('win'), '胜出规则应高亮');
});

await test('试算：一条都不命中时说明落到官方缺省', () => {
  const tree = render([
    [GROUP_RULE], DEFAULTS, rulesPayload.knownCodes, null, '', '', [], true, [],
    {
      provider: 'ghost', model: 'zzz', busy: false,
      result: { ok: true, provider: 'ghost', model: 'zzz', groupId: null, groupName: null, ruleIndex: -1, rule: null, source: 'adapter-default', policy: DEFAULTS, scores: [{ index: 0, score: -1, rule: GROUP_RULE }] },
    },
  ]);
  const text = textOf(tree);
  assert.ok(text.includes('未命中任何规则'), text.slice(0, 300));
  assert.equal(byClass(tree, 'mretry-miss').length, 1);
  assert.ok(textOf(byClass(tree, 'mretry-score')[0]).includes('不命中'));
});

await test('试算：分组插件不在线时结果里补一句解释', () => {
  const tree = render([
    [], DEFAULTS, rulesPayload.knownCodes, null, '', '', [], false, [],
    { provider: 'p', model: 'm', busy: false, result: { ok: true, groupId: null, groupName: null, ruleIndex: -1, rule: null, source: 'adapter-default', policy: DEFAULTS, scores: [], groupsAvailable: false } },
  ]);
  assert.ok(textOf(tree).includes('分组插件不在线'));
});

/* ---- C4..C8 回归：设置页数据完整性 / 校验闸门 / 错误面 ---- */

/* 复现用例共用的种植助手：state 数组与 hookLayout 同序（前 10 槽）。 */
const QUIET_PREVIEW = { provider: '', model: '', result: null, busy: false };
function seedOf(rows, over) {
  const extra = over || {};
  return [
    rows, DEFAULTS, rulesPayload.knownCodes, null, '', '',
    extra.groups || [], extra.groupsAvailable === undefined ? true : extra.groupsAvailable,
    extra.warnings || [], QUIET_PREVIEW,
  ];
}
const cardsOf = (tree) => findAll(tree, (el) => el.type === ui.RuleCard);
const keysOf = (tree) => cardsOf(tree).map((el) => el.props.key);
/** 页面树里的规则卡是未展开的元素（桩只展开宿主元素、不渲染函数组件）：
 *  取它的 props 直接调一次 ui.RuleCard，就能读到卡片内部。 */
const cardAt = (tree, at) => ui.RuleCard(Object.assign({}, cardsOf(tree)[at === undefined ? 0 : at].props));
/** 规则卡的「模式」下拉（RuleCard 里 className 恰为 mretry-input 的唯一下拉）。 */
const modeSelectOf = (card) => findAll(card, (el) => el.type === 'select' && String(el.props.className) === 'mretry-input')[0];
/** 「重试次数」输入框（带 mretry-retries，与退避那几个 mretry-num 区分开）。 */
const retriesOf = (card) => findAll(card, (el) => el.type === 'input' && String(el.props.className).includes('mretry-retries'));
const postsOf = () => requests.filter((entry) => entry.method === 'POST' && entry.url === '/dsh-model-retry/rules');
/** 无头桩不会因 state 变化自动重跑 effect：手动 render + 跑保存 effect，模拟 React 一轮提交。 */
const commit = () => { const tree = render(); if (typeof effects[1] === 'function') effects[1](); return tree; };

await test('C4 模式往返 normal→always→normal 后 maxRetries 与类别码原样保留（输入框与最终 payload）', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const rule = { uid: 'r-c4', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 12, retryableCodes: ['RATE_LIMIT', 'SERVER'], statusCodes: [418], backoff: null };
  let tree = render(seedOf([rule]));
  effects[1]();                                       // 基线记账（不上报）
  assert.equal(timers.length, 0);
  assert.deepEqual(postsOf().length, 0);

  // normal → always：只切模式，绝不从组件状态里删用户填过的值
  modeSelectOf(cardAt(tree)).props.onChange({ target: { value: 'always' } });
  assert.equal(state[0][0].mode, 'always');
  assert.equal(state[0][0].maxRetries, 12, '切到 always 不得丢 maxRetries');
  assert.deepEqual(state[0][0].retryableCodes, ['RATE_LIMIT', 'SERVER'], '切到 always 不得丢触发类别码');
  assert.deepEqual(state[0][0].statusCodes, [418], '切到 always 不得丢自定义状态码');

  // always 的下发 payload 省略这些字段（省略只发生在 payload，不发生在状态）
  tree = commit();
  assert.equal(timers.length, 1, '切模式应触发一次保存');
  runTimers(); await tick(); await tick();
  let body = postsOf().pop().body.rules[0];
  assert.equal(body.mode, 'always');
  assert.equal(body.maxRetries, undefined, 'always 的 payload 不带 maxRetries');
  assert.equal(body.retryableCodes, undefined, 'always 的 payload 不带类别码');

  // always → normal：状态、输入框、最终 payload 三处都必须还原
  tree = render();
  assert.equal(retriesOf(cardAt(tree)).length, 0, 'always 模式本就不显示重试次数输入框');
  modeSelectOf(cardAt(tree)).props.onChange({ target: { value: 'normal' } });
  assert.equal(state[0][0].maxRetries, 12);
  assert.deepEqual(state[0][0].retryableCodes, ['RATE_LIMIT', 'SERVER']);
  assert.deepEqual(state[0][0].statusCodes, [418]);

  tree = commit();
  assert.equal(retriesOf(cardAt(tree))[0].props.value, 12, '输入框应仍显示 12');
  const chipOn = findAll(cardAt(tree), (el) => el.props && typeof el.props.label === 'string' && el.props.on === true).map((el) => el.props.label);
  assert.ok(chipOn.includes('RATE_LIMIT') && chipOn.includes('SERVER'), '两个类别码仍应处于勾选态：' + chipOn.join(','));
  runTimers(); await tick(); await tick();
  body = postsOf().pop().body.rules[0];
  assert.equal(body.mode, 'normal');
  assert.equal(body.maxRetries, 12, '最终 payload 应还原 maxRetries=12');
  assert.deepEqual(body.retryableCodes, ['RATE_LIMIT', 'SERVER'], '最终 payload 应还原两个类别码');
  assert.deepEqual(body.statusCodes, [418], '最终 payload 应还原自定义状态码');
});

await test('C5 maxRetries 超 host 上限（0..1000）：inline 报错、不发 POST；改成合法值后自动恢复', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const rule = { uid: 'r-c5', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 5000, retryableCodes: null, statusCodes: [], backoff: null };
  let tree = render(seedOf([rule]));
  effects[1]();
  const flagged = lastWriteOf(5);                     // render() 会清 stateLog，先记下来
  runTimers(); await tick(); await tick();
  assert.equal(postsOf().length, 0, '非法值不得发 POST（否则整批规则永久 400）');
  assert.equal(flagged, 'invalid', 'saveState 应进 invalid');
  tree = render();                                    // 桩不自动重渲染：手动提交一轮再看画面
  const cardText = textOf(cardAt(tree));
  assert.ok(cardText.includes('重试次数'), cardText);
  assert.ok(cardText.includes('0..1000'), 'inline 错误要写清允许范围：' + cardText);
  assert.ok(byClass(cardAt(tree), 'mretry-bad').length >= 1, '非法输入框应有错误描边');
  assert.ok(textOf(tree).includes('不合法'), '页面顶部也要提示未保存');

  // 改成 12 → 恢复自动保存，且发出去的确实是 12
  retriesOf(cardAt(commit()))[0].props.onChange({ target: { value: '12' } });
  assert.equal(state[0][0].maxRetries, 12);
  commit();
  assert.equal(timers.length, 1, '改成合法值后应恢复防抖保存');
  runTimers(); await tick(); await tick();
  assert.equal(postsOf().pop().body.rules[0].maxRetries, 12);
});

await test('C5 host 400 校验失败：错误说清第几条规则 / 哪个字段 / 允许范围，且不静默重试', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const rule = { uid: 'r-c5b', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 7, retryableCodes: null, statusCodes: [], backoff: null };
  render(seedOf([rule]));
  effects[1]();                                       // 基线
  failPostRules = {
    kind: 'status', status: 400, statusText: 'Bad Request',
    // 文案照抄真机 host（zod）实测输出：路径带 `rules.` 前缀。
    // 曾经这里写的是 `0.maxRetries: …`（无前缀），于是翻译逻辑只对假文案成立、
    // 对真机的 `rules.0.maxRetries: …` 会误报成「规则条数超出上限」。
    body: { error: '规则校验失败: rules.0.maxRetries: Too big: expected number to be <=1000; rules.1.backoff.jitterRatio: Too big: expected number to be <=1' },
  };
  state[0] = [Object.assign({}, rule, { maxRetries: 9 })];
  commit();
  assert.equal(timers.length, 1);
  runTimers(); await tick(); await tick();
  const sent = postsOf().length;
  assert.equal(sent, 1, '应只 POST 一次');
  const saveStateAfterFail = lastWriteOf(5);          // render() 会清 stateLog，先记下来

  const text = textOf(render());
  assert.ok(text.includes('第 1 条规则'), text.slice(0, 400));
  assert.ok(text.includes('重试次数') && text.includes('0..1000'), text.slice(0, 400));
  assert.ok(text.includes('第 2 条规则') && text.includes('退避抖动') && text.includes('0..1'), text.slice(0, 400));
  assert.equal(saveStateAfterFail, 'error', 'saveState 应进 error');

  // 不静默重试：没有用户动作就不再发请求
  runTimers(); await tick(); await tick();
  assert.equal(postsOf().length, sent, '保存失败后不得自动重试');

  // 显式「重试保存」按钮：host 恢复后点一下就落盘
  const retryBtn = buttonByText(render(), '重试保存');
  failPostRules = null;
  retryBtn.props.onClick();
  await tick(); await tick();
  assert.equal(postsOf().pop().body.rules[0].maxRetries, 9);
  assert.ok(stateLog.some((entry) => entry.index === 5 && entry.value === 'saved'), '显式重试成功后应回到已保存');
});

await test('C5 真机 host 的两种 400 路径都要翻对：rules.<i>.<字段> 与 rules（整数组超限）', async () => {
  // 只认字段级文案：整数组超限是 `rules: Too big: expected array to have <=N items`，
  // 不能把前者误翻成「规则条数超出上限」（真机实测踩过这个坑）。
  requests.length = 0; failGetRules = null; failPostRules = null;
  const rule = { uid: 'r-c5d', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 7, retryableCodes: null, statusCodes: [], backoff: null };
  render(seedOf([rule]));
  effects[1]();
  failPostRules = {
    kind: 'status', status: 400, statusText: 'Bad Request',
    body: { error: '规则校验失败: rules.0.maxRetries: Too big: expected number to be <=1000' },
  };
  state[0] = [Object.assign({}, rule, { maxRetries: 9 })];
  commit();
  runTimers(); await tick(); await tick();
  let text = textOf(render());
  assert.ok(text.includes('第 1 条规则') && text.includes('重试次数'), '字段级路径应翻译到具体规则与字段：' + text.slice(0, 300));
  assert.ok(!text.includes('规则条数超出上限'), '不得把字段级越界说成条数超限：' + text.slice(0, 300));

  requests.length = 0; failPostRules = null;
  render(seedOf([rule]));
  effects[1]();
  failPostRules = {
    kind: 'status', status: 400, statusText: 'Bad Request',
    body: { error: '规则校验失败: rules: Too big: expected array to have <=64 items' },
  };
  state[0] = [Object.assign({}, rule, { maxRetries: 9 })];
  commit();
  runTimers(); await tick(); await tick();
  text = textOf(render());
  assert.ok(text.includes('规则条数超出上限'), '整数组超限应翻成条数上限：' + text.slice(0, 300));
});

await test('C5 always 模式下不会被下发的 limit 字段不阻塞保存（切模式本身照样落盘）', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const rule = { uid: 'r-c5c', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 5000, retryableCodes: null, statusCodes: [], backoff: null };
  const tree = render(seedOf([rule]));
  effects[1]();
  assert.equal(lastWriteOf(5), 'invalid', 'normal 模式下 5000 越界：先拦住');
  // 切到 always：这些字段被 buildPayload 省略、host 也整段忽略，
  // 一条压根不会下发的问题值不该把「切模式」这件事一起堵死。
  modeSelectOf(cardAt(tree)).props.onChange({ target: { value: 'always' } });
  commit();
  assert.equal(state[0][0].mode, 'always');
  assert.equal(timers.length, 1, 'always 下非法 limit 字段不该阻塞保存');
  runTimers(); await tick(); await tick();
  const body = postsOf().pop().body.rules[0];
  assert.equal(body.mode, 'always');
  assert.equal(body.maxRetries, undefined);
  assert.ok(stateLog.some((entry) => entry.index === 5 && entry.value === 'saved'), '应回到已保存');
});

await test('C5 规则条数超过 host 上限（64）时阻塞保存并说明条数', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const many = Array.from({ length: 65 }, (_, at) => ({
    uid: 'r-many-' + at, provider: 'p' + at, model: 'm' + at, group: null,
    mode: 'normal', maxRetries: 1, retryableCodes: null, statusCodes: [], backoff: null,
  }));
  render(seedOf(many));
  effects[1]();
  const flagged = lastWriteOf(5);
  runTimers(); await tick(); await tick();
  assert.equal(postsOf().length, 0, '65 条不得发 POST（host 上限 64）');
  assert.equal(flagged, 'invalid');
  const text = textOf(render());
  assert.ok(text.includes('最多 64 条'), text.slice(0, 300));
  assert.ok(text.includes('65'), text.slice(0, 300));
});

await test('C6 加载 / 新增 / 复制各生成稳定 uid，删除一条后其余卡不错位，payload 剥掉 uid', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const savedPayload = rulesPayload;
  rulesPayload = Object.assign({}, rulesPayload, { rules: [{ provider: 'p0', model: 'm0', mode: 'normal', maxRetries: 4 }] });
  try {
    // 加载路径：GET 回来的规则没有 uid，加载时必须补上
    const loaded = render([null, null, null, null, '', '', [], true, [], QUIET_PREVIEW]);
    effects[0]();
    await tick(); await tick();
    assert.equal(state[0].length, 1);
    assert.ok(typeof state[0][0].uid === 'string' && state[0][0].uid !== '', '加载时应生成 uid');
    assert.deepEqual(keysOf(render()), [state[0][0].uid], '卡片 key 应是 uid（加载规则也不再用下标）');
  } finally {
    rulesPayload = savedPayload;
  }

  const rows = [
    { uid: 'r-a', provider: 'p1', model: 'm1', group: null, mode: 'normal', maxRetries: 1, retryableCodes: null, statusCodes: [429], backoff: null },
    { uid: 'r-b', provider: 'p2', model: 'm2', group: null, mode: 'normal', maxRetries: 2, retryableCodes: null, statusCodes: [418], backoff: null },
    { uid: 'r-c', provider: 'p3', model: 'm3', group: null, mode: 'normal', maxRetries: 3, retryableCodes: null, statusCodes: [503], backoff: null },
  ];
  let tree = render(seedOf(rows));
  effects[1]();
  assert.deepEqual(keysOf(tree), ['r-a', 'r-b', 'r-c'], 'key 必须是稳定 uid，不能是数组下标');

  // 删中间一条：剩下的卡仍按自己的 uid 复用，未受控输入框不会串位
  cardsOf(tree)[1].props.onRemove(1);
  assert.deepEqual(state[0].map((r) => r.uid), ['r-a', 'r-c']);
  tree = render();
  assert.deepEqual(keysOf(tree), ['r-a', 'r-c']);
  const providerInput = findAll(cardAt(tree, 1), (el) => el.type === 'input' && String(el.props.className).includes('mretry-provider'))[0];
  assert.equal(providerInput.props.value, 'p3', '第三条规则的内容不得因删除而错位');

  // 新增：新 uid
  buttonByText(tree, '＋ 新增规则').props.onClick();
  const added = state[0][state[0].length - 1];
  assert.ok(typeof added.uid === 'string' && added.uid !== '' && added.uid !== 'r-a' && added.uid !== 'r-c', '新增规则要有自己的 uid');

  // 复制：副本拿新 uid、字段照抄，且紧随原规则（此时列表是 ['r-a','r-c',新增]）
  const beforeCopy = state[0].length;
  tree = render();
  buttonByText(cardAt(tree), '复制').props.onClick();   // 卡内按钮：得先展开卡片元素
  assert.equal(state[0].length, beforeCopy + 1);
  assert.equal(state[0][0].uid, 'r-a');
  const clone = state[0][1];
  assert.notEqual(clone.uid, 'r-a');
  assert.notEqual(clone.uid, 'r-c');
  assert.equal(clone.provider, 'p1', '副本应照抄字段');
  assert.equal(state[0][2].uid, 'r-c');
  assert.equal(new Set(state[0].map((r) => r.uid)).size, state[0].length, '全部 uid 必须互不相同');

  // 保存时剥掉 uid（host schema 里没有这个字段）
  commit();
  runTimers(); await tick(); await tick();
  const body = postsOf().pop().body;
  assert.equal(body.rules.length, state[0].length);
  for (const row of body.rules) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'uid'), false, 'payload 不得带前端 uid：' + JSON.stringify(row));
  }
});

await test('C7 GET /rules 失败（非 JSON 4xx / 网络错）进 error 态给「重试」，不停留在加载中', async () => {
  requests.length = 0; failPostRules = null;
  const loadingSeed = () => render([null, null, null, null, '', '', [], null, [], QUIET_PREVIEW]);

  failGetRules = { kind: 'text', status: 404, statusText: 'Not Found' };   // 非 JSON 4xx
  let tree = loadingSeed();
  effects[0]();
  await tick(); await tick();
  tree = render();                                    // 桩不自动重渲染：手动提交一轮再看画面
  assert.ok(!textOf(tree).includes('加载中'), '失败后不得停在加载中：' + textOf(tree).slice(0, 200));
  assert.ok(textOf(tree).includes('读取重试规则失败'), textOf(tree).slice(0, 300));
  const retryBtn = buttonByText(tree, '重试');
  assert.equal(cardsOf(tree).length, 0, '没加载出来就不该渲染规则卡');

  failGetRules = { kind: 'network' };                                       // 网络错
  tree = loadingSeed();
  effects[0]();
  await tick(); await tick();
  tree = render();
  assert.ok(textOf(tree).includes('读取重试规则失败'), '网络错也要进 error 态');
  assert.ok(!textOf(tree).includes('加载中'), '网络错也不得停在加载中');
  assert.ok(buttonByText(tree, '重试') !== undefined);

  // 点「重试」恢复（无头桩不自动重跑 effect：手动渲染并再跑加载 effect）
  const savedPayload = rulesPayload;
  rulesPayload = Object.assign({}, rulesPayload, { rules: [PLAIN_RULE] });
  failGetRules = null;
  retryBtn.props.onClick();
  render(); effects[0]();
  await tick(); await tick();
  const after = render();
  assert.equal(cardsOf(after).length, 1, '重试成功后应渲染出规则卡');
  assert.ok(!textOf(after).includes('读取重试规则失败'));
  rulesPayload = savedPayload;
});

await test('C7 host 返回 200 但响应体不是对象（如 null）：同样进 error 态，不装作没有规则', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const savedPayload = rulesPayload;
  rulesPayload = null;                                   // 200 + `null`：json() 解出来是 null
  try {
    render([null, null, null, null, '', '', [], null, [], QUIET_PREVIEW]);
    effects[0]();
    await tick(); await tick();
    const tree = render();
    assert.ok(!textOf(tree).includes('加载中'), '不得停在加载中：' + textOf(tree).slice(0, 200));
    assert.ok(textOf(tree).includes('读取重试规则失败'), textOf(tree).slice(0, 300));
    assert.ok(buttonByText(tree, '重试') !== undefined, '要能重试');
    assert.equal(cardsOf(tree).length, 0);
  } finally {
    rulesPayload = savedPayload;
  }
});

await test('C7 host 读文件失败（200 但带 error 字段）：原因要显示出来，不能装作没有规则', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const savedPayload = rulesPayload;
  rulesPayload = Object.assign({}, rulesPayload, { rules: [], error: '读取规则文件失败: Unexpected token } in JSON' });
  try {
    render([null, null, null, null, '', '', [], null, [], QUIET_PREVIEW]);
    effects[0]();
    await tick(); await tick();
    const tree = render();
    assert.ok(textOf(tree).includes('读取规则文件出错'), textOf(tree).slice(0, 400));
    assert.ok(textOf(tree).includes('Unexpected token'), 'host 原话要带出来');
    assert.ok(byClass(tree, 'mretry-warn').length >= 1, '应有告警区');
  } finally {
    rulesPayload = savedPayload;
  }
});

await test('C8 分组目录为空 / 插件不在线：规则卡与试算面板不出空下拉，并写明原因', () => {
  // 插件不在线：退化为手输，并给出文字说明
  const offline = renderCard({ provider: '*', model: '*', group: 'free', mode: 'normal', maxRetries: 5 }, { groups: [], groupsAvailable: false }).tree;
  assert.equal(findAll(offline, (el) => el.type === 'select' && String(el.props.className).includes('mretry-group')).length, 0, '分组不可用时不得渲染空下拉');
  assert.ok(textOf(offline).includes('不在线'), textOf(offline));

  // 插件在线但一个分组都没有：同样不出空下拉，并指向「模型分组」页
  const empty = renderCard({ provider: '*', model: '*', group: null, mode: 'normal', maxRetries: 5 }, { groups: [], groupsAvailable: true }).tree;
  assert.equal(findAll(empty, (el) => el.type === 'select' && String(el.props.className).includes('mretry-group')).length, 0);
  assert.ok(textOf(empty).includes('还没有分组'), textOf(empty));

  // 试算面板：在线但没分组 → 说明去「模型分组」新建
  const page = render(seedOf([GROUP_RULE], { groups: [], groupsAvailable: true }));
  assert.ok(textOf(page).includes('还没有分组'), textOf(page).slice(0, 400));
  // 试算面板：分组状态未知（null）→ 说明带 group 的规则可能不命中
  const unknown = render(seedOf([], { groups: [], groupsAvailable: null }));
  assert.ok(textOf(unknown).includes('分组目录'), textOf(unknown).slice(0, 400));
  // 规则卡与试算面板都不出现「没有任何 option 的下拉」
  for (const tree of [offline, empty, page, unknown]) {
    for (const select of findAll(tree, (el) => el.type === 'select')) {
      assert.ok(findAll(select, (el) => el.type === 'option').length > 0, '不允许出现空下拉');
    }
  }
});

await test('C8 规则引用未知分组：规则卡内联标注 + 试算面板逐条列出，不静默', () => {
  const card = renderCard({ provider: '*', model: '*', group: 'ghost', mode: 'normal', maxRetries: 5 }, { groups: [{ id: 'free', name: '免费车道' }], groupsAvailable: true }).tree;
  assert.ok(textOf(card).includes('ghost'), textOf(card));
  assert.ok(textOf(card).includes('不会命中'), '未知分组要在卡片上写明后果：' + textOf(card));

  const page = render(seedOf([{ uid: 'g1', provider: '*', model: '*', group: 'ghost', mode: 'normal', maxRetries: 5 }], { groups: [{ id: 'free', name: '免费车道' }], groupsAvailable: true }));
  const text = textOf(page);
  assert.ok(text.includes('第 1 条规则') && text.includes('ghost'), text.slice(0, 400));
  assert.ok(byClass(page, 'mretry-warn').length >= 1, '试算面板应有告警区');
});

await test('选择器越界（provider/model/group > 200 字符）在规则卡里有 inline 提示，不是只拦不发', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const MAX_SELECTOR_CHARS = ui.MAX_SELECTOR_CHARS;
  const long = 'p'.repeat(MAX_SELECTOR_CHARS + 5);
  const rule = { uid: 'r-hint', provider: long, model: '*', group: null, mode: 'normal', maxRetries: 5, retryableCodes: null, statusCodes: [], backoff: null };
  render(seedOf([rule]));
  effects[1]();
  // 页头说「见规则卡内提示」——卡片里必须真的有一条说清是哪个字段超长
  const cardText = textOf(renderCard(rule).tree);
  assert.ok(cardText.includes('超过 ' + MAX_SELECTOR_CHARS + ' 字符'), '卡片应显示越界提示：' + cardText.slice(0, 300));
  assert.ok(cardText.includes('provider'), '应指出是 provider：' + cardText.slice(0, 300));
  // 拦下不发：整批不发 POST
  runTimers(); await tick(); await tick();
  assert.equal(requests.filter((r) => r.method === 'POST').length, 0, '越界时不得发 POST');
  assert.equal(lastWriteOf(5), 'invalid');
});

await test('host 报告规则文件读不出来：同实例二次加载后依然不自动保存（不得覆盖用户文件）', async () => {
  requests.length = 0; failGetRules = null; failPostRules = null;
  const savedPayload = rulesPayload;
  rulesPayload = Object.assign({}, rulesPayload, { rules: [], error: '规则文件形状不合法：rules 应为数组，实际是object' });
  const seed = () => [null, null, null, null, '', '', [], true, [], QUIET_PREVIEW, 'loading', 0];
  const ruleOf = (retries) => ({ uid: 'r-host', provider: '*', model: '*', group: null, mode: 'normal', maxRetries: retries, retryableCodes: null, statusCodes: [], backoff: null });
  try {
    render(seed());
    effects[0]();                                     // 触发加载
    await tick(); await tick();
    let tree = render();                              // 桩不自动重渲染：手动提交一轮再看画面
    assert.ok(textOf(tree).includes('读取规则文件出错'), '应显示 host 的读取错误：' + textOf(tree).slice(0, 300));
    assert.ok(textOf(tree).includes('不会自动保存'), '应说明不会覆盖文件');

    // 第一次 commit 只是建立基线（load 后的首个保存 effect 不上报）
    commit();
    // 用户改一条规则：保存 effect 必须拦住（否则空规则集覆盖掉用户文件）
    state[0] = [ruleOf(9)];
    commit();
    runTimers(); await tick(); await tick();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0, '读取出错时不得自动保存');
    assert.equal(lastWriteOf(5), 'invalid', 'saveState 应停在 invalid');

    // 同一实例内的二次加载（ctx 身份变化会让 load effect 重跑）：闸门不得被绕过
    requests.length = 0;
    effects[0]();
    await tick(); await tick();
    state[0] = [ruleOf(11)];
    commit();
    runTimers(); await tick(); await tick();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 0, '二次加载后仍不得自动保存');

    // host 恢复正常（无 error）后放行：闸门只在「文件读不出来」时存在
    rulesPayload = Object.assign({}, rulesPayload, { error: undefined });
    requests.length = 0;
    effects[0]();
    await tick(); await tick();
    state[0] = [ruleOf(12)];
    commit();
    runTimers(); await tick(); await tick();
    assert.equal(requests.filter((r) => r.method === 'POST').length, 1, '文件可正常读取后应恢复自动保存');
  } finally {
    rulesPayload = savedPayload;
  }
});

/* ------------------------------------------------------------- 收尾 ---- */

process.stdout.write('\n');
if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) {
    process.stdout.write(`  ✗ ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 8).join('\n    ') : failure.error}\n`);
  }
  process.stdout.write(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`SELFTEST PASS (${passed} checks)\n`);
}
