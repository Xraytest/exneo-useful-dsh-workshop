/**
 * dsh-model-groups 浏览器半边自测（headless，不需要浏览器）。
 *
 *   node plugins/dsh-model-groups/client-selftest.mjs
 *
 * 做法与 dsh-archived-sessions/client-selftest.mjs 同款：用 `new Function`
 * 以脚本语义执行 client.js（只影子化 window / document / require / fetch），
 * 捕获 __ModuleLoader__.load 注册，再用一个只实现 useState/useRef/useCallback/
 * useEffect 的 react 桩「渲染」设置页那一节——createElement 返回纯对象树，
 * 断言直接读树。零 DOM、零真实请求。
 *
 * 末行 SELFTEST PASS 才算过。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

// host 侧的尺子（id 正则 / 长度上限）：跨端一致性断言要拿它跟客户端比对。
import { ID_RE, LIMITS } from './resolve.js';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* --------------------------------------------------------------- 桩件 ---- */

let timerSeq = 0;
/** 待定定时器 [{id, fn}]：clearTimeout 真删（否则「防抖泄漏」类回归在自测里不可见）。 */
const timers = [];
globalThis.setInterval = () => ++timerSeq;
globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn) => { const id = ++timerSeq; timers.push({ id, fn }); return id; };
globalThis.clearTimeout = (id) => { const at = timers.findIndex((item) => item.id === id); if (at >= 0) timers.splice(at, 1); };
const runTimers = () => { const pending = timers.splice(0, timers.length); for (const item of pending) item.fn(); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

let statePayload = { ok: true, schema: 1, revision: 1, path: '/tmp/model-groups.json', exists: true, groups: [], warnings: [], limits: {} };
let catalogPayload = { ok: true, value: { groups: [] } };
let resolvePayload = { ok: true, winner: null, candidates: [] };
let auditPayload = { ok: true, catalog: { available: true, routes: 0, providers: 0, failures: [] }, groups: [], ungrouped: [], overlaps: [], warnings: [] };
let usagePayload = { by: 'model', rows: [] };
/** POST /groups 的回包改写钩子：模拟 host 静默改名/截断（默认原样回包）。 */
let postMutation = null;
/** POST /ui 的失败注入：非 null 时该请求 reject（模拟旧 host 404 / 网络错）。 */
let uiPostFailure = null;
/** POST /ui 回包里的 issues（模拟 host 归一化时丢项：超长/非法 id）。 */
let uiPostIssues = null;
/** POST /ui 回包里的 collapsed（缺省原样回显；用来模拟 host 只接受了一部分）。 */
let uiPostEcho = null;
const requests = [];
async function fetchStub(url, options) {
  const target = String(url);
  const entry = { url: target, method: (options && options.method) || 'GET', body: options && options.body ? JSON.parse(options.body) : null };
  requests.push(entry);
  // 失败注入：真 reject（而不是回一个坏 body）——要走到 fetchJson 的 catch 分支。
  if (target.indexOf('/dsh-model-groups/ui') !== -1 && entry.method === 'POST' && uiPostFailure !== null) {
    throw new Error(uiPostFailure);
  }
  const payload = target.indexOf('/dsh-model-groups/state') !== -1 ? statePayload
    : (target.indexOf('/dsh-model-groups/audit') !== -1 ? auditPayload
      : (target.indexOf('/dsh-model-groups/resolve') !== -1 ? resolvePayload
        : (target.indexOf('/dsh-model-groups/groups') !== -1
          ? { ok: true, revision: 2, groups: postMutation === null ? entry.body.groups : postMutation(entry.body.groups), warnings: [] }
          : (target.indexOf('/dsh-model-groups/ui') !== -1
            ? (entry.method === 'POST'
              ? { ok: true, revision: 3, collapsed: uiPostEcho === null ? entry.body.collapsed : uiPostEcho, issues: uiPostIssues === null ? [] : uiPostIssues }
              : { ok: true, revision: 3, collapsed: [] })
            : (target.indexOf('/dsh-usage/summary') !== -1 ? usagePayload : {})))));
  return { ok: true, status: 200, statusText: 'OK', json: async () => payload };
}

let hookIndex = 0;
let state = [];
let stateLog = [];
let refSlots = [];
const callbackSlots = [];      // useCallback 记忆化（身份稳定）
const memoSlots = [];          // useMemo 记忆化
/**
 * effect 簿记（**依赖语义忠实**，别退回「每帧都跑」）：
 * 真实 React 只在依赖浅比较变化时才重跑 effect。旧桩忽略依赖数组，导致
 * 「依赖写错 = 功能全死」这种回归在自测里完全不可见（实测：把折叠落盘 effect 的
 * deps 改成 [] 后，功能彻底不写盘，而 40 项断言照样全过）。
 * 现在：collected = 本帧收集；ranDeps/ranCleanups = 上次真正跑过的依赖与清理函数。
 *   effects[i]()        —— 强制跑（老测试兼容，等于「无视依赖」）
 *   runChangedEffects() —— 只跑依赖变了的（新测试用这个，deps:[] 的变异体会立刻红灯）
 *   unmount()           —— 跑全部清理（卸载路径：卸载补发 / 移除监听）
 */
const collected = [];
const ranDeps = [];
const ranCleanups = [];
const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return true;                 // 无依赖数组 = 每帧都跑
  if (a.length !== b.length) return false;
  return a.every((item, at) => Object.is(item, b[at]));
};
function runEffect(index, force) {
  const item = collected[index];
  if (item === undefined) throw new Error(`effect #${index} 不存在（本帧只有 ${collected.length} 个）`);
  if (force !== true && ranDeps[index] !== undefined && sameDeps(ranDeps[index], item.deps)) return false;
  if (typeof ranCleanups[index] === 'function') { const cleanup = ranCleanups[index]; ranCleanups[index] = null; cleanup(); }
  ranDeps[index] = item.deps === undefined ? undefined : (item.deps === null ? null : item.deps.slice());
  const cleanup = item.fn();
  ranCleanups[index] = typeof cleanup === 'function' ? cleanup : null;
  return true;
}
const effects = [];
function runChangedEffects() {
  const reran = [];
  collected.forEach((_, index) => { if (runEffect(index, false) === true) reran.push(index); });
  return reran;                 // 返回**跑过的 effect 序号**：测试可以断言「哪个 effect 不该跑」
}
function unmount() {
  for (let index = 0; index < collected.length; index += 1) {
    if (typeof ranCleanups[index] === 'function') { const cleanup = ranCleanups[index]; ranCleanups[index] = null; cleanup(); }
    ranDeps[index] = undefined;
  }
}
function resetEffects() { collected.length = 0; ranDeps.length = 0; ranCleanups.length = 0; callbackSlots.length = 0; memoSlots.length = 0; }
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
  useCallback(fn, deps) {
    const index = hookIndex++;
    const slot = callbackSlots[index];
    // 真实 React 的 useCallback 按依赖记忆化：**身份稳定是契约**（挂载 effect 的依赖
    // 数组里就装着 useCallback 的产物）。桩若不记忆化，每次渲染都换身份，挂载 effect
    // 就每帧重跑、重拉 /state，把本地改动冲掉——那是桩造出来的假象。
    if (slot !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return slot.fn;
    callbackSlots[index] = { fn, deps: deps === undefined ? undefined : deps.slice() };
    return fn;
  },
  useEffect(fn, deps) {
    hookIndex += 1;
    const at = collected.length;
    collected.push({ fn, deps });
    effects.push(() => runEffect(at, true));      // at 必须在收集时定住（调用时 length 已变）
  },
  useMemo(fn, deps) {
    const index = hookIndex++;
    const slot = memoSlots[index];
    if (slot !== undefined && deps !== undefined && sameDeps(slot.deps, deps)) return slot.value;
    const value = fn();
    memoSlots[index] = { value, deps: deps === undefined ? undefined : deps.slice() };
    return value;
  },
};

const styleNodes = [];
const documentListeners = new Map();
const documentStub = {
  head: { appendChild(node) { styleNodes.push(node); } },
  documentElement: { appendChild(node) { styleNodes.push(node); } },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
  visibilityState: 'visible',
  addEventListener(type, fn) { documentListeners.set(type, fn); },
  removeEventListener(type) { documentListeners.delete(type); },
};
globalThis.document = documentStub;

let captured = null;
const windowListeners = new Map();
globalThis.window = {
  __ModuleLoader__: { load(entry) { captured = entry; } },
  addEventListener(type, fn) { windowListeners.set(type, fn); },
  removeEventListener(type) { windowListeners.delete(type); },
};
// navigator 在 Node 里是只读 getter，必须 defineProperty 才能装出 sendBeacon（pagehide 冲刷用）。
const beacons = [];
Object.defineProperty(globalThis, 'navigator', {
  value: { sendBeacon(url, blob) { beacons.push({ url, blob }); return true; } },
  configurable: true,
  writable: true,
});

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

/* --------------------------------------------------------- 模块外壳 ------ */

section('模块外壳与挂载');

assert.ok(captured !== null, 'factory 未注册到 __ModuleLoader__');
assert.equal(captured.id, 'dsh-model-groups', 'client 模块 id 必须等于 package.json 的 name');
const exports = captured.factory(require);
const ui = exports.__ui;
const UI_MAX_ID_CHARS = ui.UI_MAX_ID_CHARS;

await test('exports.inject / apply 形状', () => {
  assert.deepEqual(exports.inject, ['slots', 'remote', 'remote.session']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof ui.Page, 'function');
  assert.equal(typeof ui.css, 'string');
  assert.deepEqual(ui.hookLayout, ['groups', 'meta', 'catalog', 'error', 'notice', 'saveState', 'probe', 'audit', 'usage', 'collapsed', 'uiError']);
});

const registrations = [];
const injected = [];
const pluginCtx = {
  slots: { inject(name, fn) { injected.push(name); fn(); }, register(meta, component) { registrations.push({ meta, component }); } },
  remote: { session: { modelCatalog: async () => catalogPayload } },
};
exports.apply(pluginCtx);

await test('注册到 settings.section，order 25（模型能力 20 与重试策略 30 之间）', () => {
  assert.deepEqual(injected, ['settings.section']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].meta.name, 'settings.section');
  assert.equal(registrations[0].meta.id, 'model-groups');
  assert.equal(registrations[0].meta.order, 25);
  assert.equal(registrations[0].meta.label, '模型分组');
  assert.equal(styleNodes.length, 1, '样式只注入一次');
});

/* ----------------------------------------------------------- 渲染 ------- */

function render(seed) {
  // seed 存在 = 开一个新场景：连 effect 簿记（已跑过的依赖/清理函数）一起归零，
  // 否则上一个场景的依赖会「看起来没变」而把新场景的 effect 吃掉。
  if (seed !== undefined) { state = seed.slice(); refSlots = []; resetEffects(); }
  hookIndex = 0; stateLog = []; collected.length = 0; effects.length = 0; timers.length = 0;
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
const findInput = (node, cls) => findAll(node, (el) => (el.type === 'input' || el.type === 'textarea' || el.type === 'select') && typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls))[0];
/** 某次渲染后，最后一次写入指定 state 槽的值（点击处理器常同时写多个槽）。 */
const lastWriteOf = (index) => {
  for (let at = stateLog.length - 1; at >= 0; at -= 1) if (stateLog[at].index === index) return stateLog[at].value;
  return undefined;
};

/** 按 hook 次序拼一份完整的初始 state（groups/meta/catalog/error/notice/saveState/probe/audit/usage/collapsed/uiError）。 */
function seedState(groups, extra = {}) {
  return [
    groups,
    extra.meta !== undefined ? extra.meta : { revision: 1, warnings: [], path: '/tmp/model-groups.json' },
    extra.catalog !== undefined ? extra.catalog : CATALOG,
    extra.error !== undefined ? extra.error : '',
    extra.notice !== undefined ? extra.notice : '',
    extra.saveState !== undefined ? extra.saveState : '',
    extra.probe !== undefined ? extra.probe : { provider: '', model: '', result: null, busy: false },
    extra.audit !== undefined ? extra.audit : null,
    extra.usage !== undefined ? extra.usage : null,
    extra.collapsed !== undefined ? extra.collapsed : {},
    extra.uiError !== undefined ? extra.uiError : '',
  ];
}

/**
 * 极简 keyed 复用器：模拟 React 对同位置元素的复用语义——key 不变就复用同一个
 * 「DOM 节点」（真实浏览器里卡片不被卸载重建、输入框不失焦）；key 变了就是新节点，
 * mounts 计数 +1。用来断言「连打字也不会重挂载」。
 */
const mountedNodes = new Map();
function mountCard(slot, tree) {
  const card = byClass(tree, 'mgrp-card')[slot];
  assert.ok(card !== undefined, '第 ' + slot + ' 张卡片不存在');
  const key = card.props.key === undefined ? null : String(card.props.key);
  const previous = mountedNodes.get(slot);
  if (previous !== undefined && previous.key !== null && previous.key === key) {
    previous.node.props = card.props;          // 复用节点：只更新 props（React 的真实行为）
    previous.node.renders += 1;
    return previous.node;
  }
  const node = { key, props: card.props, mounts: previous === undefined ? 1 : previous.node.mounts + 1, renders: 1 };
  mountedNodes.set(slot, { key, node });
  return node;
}
// 折叠开关 = 卡片最左侧的无杆箭头（class 定位，不看文字：文字是 › 这种符号）
const collapseButton = (node) => buttonsIn(node).find((el) => String(el.props.className).includes('mgrp-chevron'));
const cardOf = (tree, slot) => byClass(tree, 'mgrp-card')[slot];
const inputIn = (card, cls) => findAll(card, (el) => el.type === 'input' && typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls))[0];

const CATALOG = {
  groups: [
    { id: 'localhost', name: 'NewAPIGate', models: [{ id: 'deepseek-ai/deepseek-v4.1-flash', name: 'MSDeepseekV4.1' }, { id: 'qwen/qwen3.8-27b:free', name: 'qwen3.8-27b' }] },
    { id: 'our-free-model', name: 'OurFreeModel', models: [{ id: 'kimi-k3', name: 'KimiK3' }] },
  ],
};
const GROUPS = [
  { uid: 'uid-free', id: 'free', name: '免费车道', description: '', enabled: true, priority: 10, ignoreCase: false, members: [{ provider: 'our-free-model', model: '*' }, { provider: 'localhost', model: 'qwen/qwen3.8-27b:free' }] },
  { uid: 'uid-nvidia', id: 'nvidia', name: 'NVIDIA 直连', description: 'x', enabled: false, priority: 100, ignoreCase: true, members: [{ provider: 'localhost', model: 'deepseek-ai/deepseek-v4.1-flash' }] },
];

/* ----------------------------------------------------------- 纯函数 ----- */

section('纯函数');

await test('orderOf：priority 升序 + 同级按列表顺序，停用组为 0（不出现）', () => {
  const order = ui.orderOf([
    { id: 'a', enabled: true, priority: 50 },
    { id: 'b', enabled: true, priority: 10 },
    { id: 'c', enabled: false, priority: 1 },
    { id: 'd', enabled: true, priority: 50 },
  ]);
  assert.deepEqual(order, { b: 1, a: 2, d: 3 });
});

await test('buildPayload：剥掉派生字段，补默认值', () => {
  const payload = ui.buildPayload([{ id: 'X ', name: 'n', enabled: undefined, priority: '30', members: [{ provider: ' p ', model: '' }], order: 7 }]);
  assert.deepEqual(payload, [{ id: 'x', name: 'n', description: '', enabled: true, priority: 30, ignoreCase: false, members: [{ provider: 'p', model: '*' }] }]);
});

await test('nextGroupId：避开既有 id', () => {
  assert.equal(ui.nextGroupId([]), 'g1');
  assert.equal(ui.nextGroupId([{ id: 'g1' }, { id: 'g2' }]), 'g3');
});

await test('parseBatch：空白分隔 / provider/model / 通配 / 注释 / 去重 / 坏行', () => {
  const parsed = ui.parseBatch([
    '# 注释',
    'localhost qwen/qwen3.8-27b:free',
    'our-free-model/*',
    'localhost qwen/qwen3.8-27b:free',
    '',
    'nonsense-line',
  ].join('\n'));
  assert.deepEqual(parsed.members, [
    { provider: 'localhost', model: 'qwen/qwen3.8-27b:free' },
    { provider: 'our-free-model', model: '*' },
  ]);
  assert.equal(parsed.issues.length, 1);
});

await test('groupsByProvider：按目录每个供应商建组（成员=全部模型）', () => {
  const made = ui.groupsByProvider(CATALOG, []);
  assert.equal(made.length, 2);
  assert.equal(made[0].id, 'localhost');
  assert.equal(made[0].members.length, 2);
  assert.equal(made[1].members[0].provider, 'our-free-model');
  const clash = ui.groupsByProvider(CATALOG, [{ id: 'localhost' }]);
  assert.equal(clash[0].id, 'localhost-2');
});

await test('usageTable：by=group 才可用；未接入时给出提示而不是报错', () => {
  const off = ui.usageTable({ by: 'model', rows: [{ key: 'm', total: 5 }] });
  assert.equal(off.available, false);
  assert.ok(off.note.includes('统计插件'));
  const on = ui.usageTable({ by: 'group', rows: [{ key: 'free', label: '免费车道', total: 1234, calls: 7, sessions: 2 }] });
  assert.equal(on.available, true);
  assert.equal(on.rows.free.total, 1234);
  assert.equal(ui.UNGROUPED_KEY, '__ungrouped__');
});

await test('shortNum：中文面板里的量级缩写', () => {
  assert.equal(ui.shortNum(0), '0');
  assert.equal(ui.shortNum(999), '999');
  assert.equal(ui.shortNum(1500), '1.5k');
  assert.equal(ui.shortNum(2.5e6), '2.50M');
  assert.equal(ui.shortNum(3e9), '3.00B');
});

await test('uid：客户端稳定标识，已有 uid 原样保留，且不进 buildPayload（不发 host）', () => {
  const rows = ui.ensureUids([{ id: 'a', members: [] }, { id: 'b', members: [] }]);
  assert.equal(typeof rows[0].uid, 'string');
  assert.notEqual(rows[0].uid, rows[1].uid, '每行一个独立 uid');
  assert.equal(ui.ensureUids(rows)[0].uid, rows[0].uid, '已有 uid 必须保留（否则整卡重挂载）');
  assert.equal(ui.buildPayload(rows)[0].uid, undefined, 'uid 只能在客户端，保存时必须剥掉');
});

await test('validateGroups：id 缺失 / 非法 / 重复都阻止保存，并给出明确文案', () => {
  const clean = ui.validateGroups([{ id: 'free' }, { id: 'paid' }]);
  assert.equal(clean.blocked, false);
  assert.equal(clean.reason, '');
  assert.deepEqual(clean.messages, []);

  const dup = ui.validateGroups([{ id: 'free' }, { id: 'paid' }, { id: ' Free ' }]);
  assert.equal(dup.blocked, true);
  assert.deepEqual(dup.duplicates.map((row) => row.id), ['free']);
  assert.deepEqual(dup.duplicates[0].indexes, [0, 2], '判定口径与 buildPayload 一致（trim + 小写）');
  assert.ok(dup.messages[0].includes('有 2 个分组用了同一个 id「free」'), dup.messages[0]);
  assert.ok(dup.reason.includes('有 2 个分组用了同一个 id'), dup.reason);

  const bad = ui.validateGroups([{ id: '' }, { id: 'Bad ID' }]);
  assert.equal(bad.blocked, true);
  assert.deepEqual(bad.missing, [0]);
  assert.deepEqual(bad.invalid, [1]);
  assert.ok(bad.messages.join(' ').includes('缺少 id'));
  assert.ok(bad.messages.join(' ').includes('不合法'));
});

await test('mergeHostGroups：按位置合并 host 调整过的 id，uid 与其它字段保持不动', () => {
  const local = [{ uid: 'u1', id: 'free', name: '甲', members: [] }, { uid: 'u2', id: 'free', name: '乙', members: [] }];
  const merged = ui.mergeHostGroups(local, [{ uid: 'IGNORED', id: 'free', name: '甲' }, { id: 'free-2', name: '乙' }]);
  assert.equal(merged.changed, true);
  assert.equal(merged.countMismatch, false);
  assert.equal(merged.groups[0].id, 'free');
  assert.equal(merged.groups[1].id, 'free-2', '必须采用 host 落盘后的 id');
  assert.equal(merged.groups[1].uid, 'u2', '合并不能丢本地 uid');
  assert.equal(merged.groups[1].name, '乙', '合并只改 id，不动用户正在编辑的其它字段');
  assert.ok(merged.adjustments[0].includes('已被 host 调整为「free-2」'), merged.adjustments[0]);

  const same = ui.mergeHostGroups([{ uid: 'u1', id: 'free' }], [{ id: 'free' }]);
  assert.equal(same.changed, false);
  assert.deepEqual(same.adjustments, []);

  const dropped = ui.mergeHostGroups([{ uid: 'u1', id: 'a' }, { uid: 'u2', id: 'b' }], [{ id: 'a' }]);
  assert.equal(dropped.countMismatch, true, '位置对不上时不能硬按位置合并');
  assert.equal(dropped.groups.length, 2);
});

/* ----------------------------------------------------------- 渲染与交互 -- */

section('渲染与交互');

await test('首屏（groups=null）渲染加载态，并请求 host 状态与模型目录', async () => {
  render([null, null, null, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  effects[0]();          // 挂载 effect：拉 /state 与 modelCatalog
  await tick(); await tick();
  assert.ok(requests.some((entry) => entry.url === '/dsh-model-groups/state'));
  assert.ok(stateLog.some((entry) => entry.index === 0), '应把 host 的 groups 写进 state[0]');
  assert.ok(stateLog.some((entry) => entry.index === 1), '应写入 meta');
});

await test('有分组时：卡片数、解析顺序条、成员行、停用标记', () => {
  const tree = render([GROUPS, { revision: 3, warnings: [], path: '/tmp/model-groups.json' }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  assert.equal(byClass(tree, 'mgrp-card').length, 2);
  assert.equal(byClass(tree, 'mgrp-card').filter((el) => el.props.className.includes('off')).length, 1, '停用组应有 off 类');
  const text = textOf(byClass(tree, 'mgrp-order')[0]);
  assert.ok(text.includes('解析顺序'), text);
  assert.ok(text.includes('免费车道'), '顺序条应列出启用的组');
  assert.ok(text.includes('未分组'), '顺序条应说明兜底去向');
  assert.equal(byClass(tree, 'mgrp-member').length, 3, '成员行总数 = 2 + 1');
});

await test('「＋ 新建分组」写入 state[0]，并生成不冲突的 id', () => {
  const tree = render();
  buttonByText(tree, '＋ 新建分组').props.onClick();
  const written = lastWriteOf(0);
  assert.equal(written.length, 3);
  assert.equal(written[2].id, 'g1');
});

await test('「按供应商快速建组」按目录补齐分组', () => {
  let tree = render([[], { revision: 1, warnings: [] }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  buttonByText(tree, '按供应商快速建组').props.onClick();
  const written = lastWriteOf(0);
  assert.equal(written.length, 2);
  assert.equal(written[0].members.length, 2);
  assert.ok(String(lastWriteOf(4)).includes('2 个组'), '应同时提示新建数量');
  tree = render();
  assert.equal(byClass(tree, 'mgrp-card').length, 2);
});

await test('批量输入 → 「应用批量」把成员并进该组（host 侧去重由 setter 结果验证）', () => {
  const refs = {};
  const tree = render([GROUPS, { revision: 1, warnings: [] }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  const applyButtons = buttonsIn(tree).filter((el) => textOf(el) === '应用批量');
  assert.equal(applyButtons.length, 2, '每个组一个批量应用按钮');
  assert.equal(typeof applyButtons[0].props.onClick, 'function');
  void refs;
  // 直接驱动纯函数路径（ref 拿到 DOM 节点的部分在无头环境由 __ui.parseBatch 覆盖）
  const parsed = ui.parseBatch('localhost step-5-preview\nour-free-model/kimi-k3');
  assert.equal(parsed.members.length, 2);
  assert.equal(parsed.members[1].provider, 'our-free-model');
});

await test('自动保存：改动后防抖计时器触发 POST，body 只含落盘字段', async () => {
  requests.length = 0;
  render([GROUPS, { revision: 1, warnings: [] }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  const autosave = effects[1];
  assert.equal(typeof autosave, 'function');
  autosave();                              // 第一次运行：记账为「已保存基线」，不排定时器
  assert.equal(timers.length, 0);
  // 模拟一次改动后重渲染：state[0] 变了，effect 再次运行 → 排定时器
  state[0] = GROUPS.concat([{ id: 'g1', name: '新分组', description: '', enabled: true, priority: 100, ignoreCase: false, members: [] }]);
  effects.length = 0;
  render();
  effects[1]();
  assert.equal(timers.length, 1, '应排一个防抖保存定时器');
  runTimers();
  await tick(); await tick();
  const post = requests.find((entry) => entry.method === 'POST' && entry.url === '/dsh-model-groups/groups');
  assert.ok(post !== undefined, '应 POST 到 /dsh-model-groups/groups');
  assert.equal(post.body.groups.length, 3);
  assert.equal(post.body.groups[0].order, undefined, 'POST body 不应带 order 这类派生字段');
  assert.equal(post.body.groups[0].uid, undefined, 'POST body 不应带客户端 uid');
  assert.ok(stateLog.some((entry) => entry.index === 5 && entry.value === 'saved'), '保存成功应更新保存态');
});

await test('试算按钮：POST /resolve 并把结果写进 probe 状态', async () => {
  resolvePayload = { ok: true, winner: { groupId: 'free', groupName: '免费车道', order: 1, member: { provider: 'our-free-model', model: '*' } }, candidates: [] };
  requests.length = 0;
  const tree = render([GROUPS, { revision: 1, warnings: [] }, CATALOG, '', '', '', { provider: 'our-free-model', model: 'kimi-k3', result: null, busy: false }, null, null, {}]);
  buttonByText(tree, '试算').props.onClick();
  await tick(); await tick();
  const post = requests.find((entry) => entry.url === '/dsh-model-groups/resolve');
  assert.ok(post !== undefined);
  assert.deepEqual(post.body, { provider: 'our-free-model', model: 'kimi-k3' });
  assert.ok(stateLog.some((entry) => entry.index === 6 && entry.value.result !== null), '结果应写进 probe');
});

await test('试算结果显示归属与被遮蔽候选', () => {
  const tree = render([GROUPS, { revision: 1, warnings: [] }, CATALOG, '', '', '', {
    provider: 'localhost', model: 'x',
    result: { winner: { groupId: 'a', groupName: '甲', order: 1, member: { provider: '*', model: '*' } }, candidates: [{ groupId: 'a', groupName: '甲', order: 1 }, { groupId: 'b', groupName: '乙', order: 2 }] },
    busy: false,
  }, null, null, {}]);
  const text = textOf(tree);
  assert.ok(text.includes('归属'), text);
  assert.ok(text.includes('甲'));
  assert.ok(text.includes('被遮蔽'), '应提示被遮蔽的候选');
});

await test('「检查冲突」触发 audit 并渲染目录核算行', async () => {
  auditPayload = {
    ok: true,
    catalog: { available: true, routes: 3, providers: 2, failures: [] },
    groups: [{ id: 'free', name: '免费车道', order: 1, matched: [{ provider: 'our-free-model', model: 'kimi-k3' }], shadowed: [], empty: false }],
    ungrouped: [{ provider: 'localhost', model: 'step-5-preview' }],
    overlaps: [{ provider: 'localhost', model: 'x', winner: 'free', also: ['nvidia'] }],
    warnings: [],
  };
  requests.length = 0;
  const tree = render([GROUPS, { revision: 1, warnings: [] }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  buttonByText(tree, '检查冲突').props.onClick();
  await tick(); await tick();
  assert.ok(requests.some((entry) => entry.url.indexOf('/dsh-model-groups/audit') === 0));
  const after = render();
  const text = textOf(after);
  assert.ok(text.includes('目录核算'), text);
  assert.ok(text.includes('重叠示例'), '应渲染重叠示例');
  assert.ok(text.includes('未归组示例'), '应渲染未归组示例');
});

await test('警告区：host 的 warnings 原样呈现', () => {
  const tree = render([GROUPS, { revision: 1, warnings: ['第 1 位「免费车道」含 */* 成员，会遮蔽其后全部 1 个组'], path: '/tmp/x.json' }, CATALOG, '', '', '', { provider: '', model: '', result: null, busy: false }, null, null, {}]);
  assert.equal(byClass(tree, 'mgrp-warn').length, 1);
  assert.ok(textOf(tree).includes('遮蔽'));
});

await test('删除按钮存在且带二次确认（window.confirm 桩）', () => {
  let asked = 0;
  globalThis.window.confirm = () => { asked++; return false; };
  const tree = render();
  const del = buttonsIn(tree).filter((el) => textOf(el) === '删除');
  assert.equal(del.length, 2);
  del[0].props.onClick();
  assert.equal(asked, 1);
  assert.equal(stateLog.filter((entry) => entry.index === 0).length, 0, '取消时应不写 state');
  delete globalThis.window.confirm;
});

/* ------------------------------------------------- C1/C2/C3 回归 -------- */

section('C1/C2/C3 回归');

const LANES = () => [
  { uid: 'uid-a', id: 'lane-a', name: '甲', description: '', enabled: true, priority: 10, ignoreCase: false, members: [] },
  { uid: 'uid-b', id: 'lane-b', name: '乙', description: '', enabled: true, priority: 20, ignoreCase: false, members: [] },
];

await test('C1 回归：id 输入框连打 6 个字符，卡片 key 与节点身份恒定（不重挂载、不失焦）', () => {
  mountedNodes.clear();
  let tree = render(seedState(LANES()));
  let node = mountCard(0, tree);
  assert.equal(node.key, 'uid-a', '卡片 key 应取与可编辑字段无关的 uid，而不是 id');
  const typed = 'free-x';
  const keys = [];
  for (let at = 1; at <= 6; at++) {
    const idInput = inputIn(cardOf(tree, 0), 'mgrp-id');
    assert.ok(idInput !== undefined, '第 ' + at + ' 次输入前找不到 id 输入框');
    idInput.props.onChange({ target: { value: typed.slice(0, at) } });
    tree = render();
    keys.push(String(cardOf(tree, 0).props.key));
    node = mountCard(0, tree);
  }
  assert.deepEqual(keys, ['uid-a', 'uid-a', 'uid-a', 'uid-a', 'uid-a', 'uid-a'], 'key 不能随 id 输入变化');
  assert.equal(node.mounts, 1, '第 2..6 次输入必须复用同一个节点（重挂载即失焦）');
  assert.equal(byClass(tree, 'mgrp-card').length, 2, '打字不应增删卡片');
  assert.equal(cardOf(tree, 0).props['data-uid'], 'uid-a', 'DOM 上可见的稳定标识');
  assert.equal(inputIn(cardOf(tree, 0), 'mgrp-id').props.value, 'free-x', '六次输入都落在同一个输入框');
  assert.equal(state[0][0].id, 'free-x');
  assert.equal(state[0][0].uid, 'uid-a', 'uid 不随编辑变化');
  assert.equal(state[0][1].uid, 'uid-b', '另一张卡的 uid 不受影响');
});

await test('uid 回归：批量框 ref 跟着卡片走，「应用批量」不会把文本落到别的卡', () => {
  let tree = render(seedState(LANES()));
  // 把第 1 张卡下移：顺序变成 [乙, 甲]，uid 跟着对象走
  buttonsIn(cardOf(tree, 0)).find((el) => textOf(el) === '↓').props.onClick();
  tree = render();
  assert.deepEqual(state[0].map((group) => group.uid), ['uid-b', 'uid-a']);
  const boxes = [0, 1].map((slot) => findAll(cardOf(tree, slot), (el) => el.type === 'textarea' && el.props.className.includes('mgrp-batch'))[0]);
  assert.equal(boxes.length, 2, '每张卡一个批量框');
  boxes[0].props.ref({ value: '' });
  boxes[1].props.ref({ value: 'our-free-model/kimi-k3' });
  const applies = [0, 1].map((slot) => buttonsIn(cardOf(tree, slot)).find((el) => textOf(el) === '应用批量'));
  applies[1].props.onClick();
  const written = lastWriteOf(0);
  const target = written.find((group) => group.uid === 'uid-a');
  const other = written.find((group) => group.uid === 'uid-b');
  assert.ok(target.members.some((member) => member.model === 'kimi-k3'), '文本应落进本卡自己的组');
  assert.equal(other.members.length, 0, '不能串到别的卡');
});

await test('uid 回归：折叠状态按 uid 记账（改 id 不会自己展开）；用量列仍按落盘 id 取数', () => {
  const usage = { available: true, rows: { 'lane-b': { total: 1500, calls: 3, sessions: 1, label: '乙' } }, note: null };
  let tree = render(seedState(LANES(), { usage }));
  assert.ok(textOf(cardOf(tree, 1)).includes('用量 1.5k tokens · 3 次'), '用量列按落盘 id 取数（不是 uid）');
  collapseButton(cardOf(tree, 1)).props.onClick();
  tree = render();
  assert.deepEqual(state[9], { 'uid-b': true }, '折叠状态按 uid 记账');
  assert.equal(findAll(cardOf(tree, 1), (el) => el.type === 'textarea').length, 0, '收起后成员区隐藏');
  assert.equal(findAll(cardOf(tree, 1), (el) => el.type === 'input').length, 0, '收起后连 id / 名称输入框都没有（按设计不给修改入口）');
  // 改 id 得先展开（收起态没有输入框）；本地集合始终按 uid 记账，与 id 无关。
  collapseButton(cardOf(tree, 1)).props.onClick();
  tree = render();
  assert.equal(findAll(cardOf(tree, 1), (el) => el.type === 'textarea').length, 1, '箭头再点一次，成员区回来');
  inputIn(cardOf(tree, 1), 'mgrp-id').props.onChange({ target: { value: 'lane-b2' } });
  tree = render();
  assert.equal(state[9]['uid-b'], false, '展开后本地集合按 uid 记 false（键跟 uid 走）');
  collapseButton(cardOf(tree, 1)).props.onClick();
  tree = render();
  assert.equal(state[9]['uid-b'], true, '改 id 不该带走折叠状态（还是同一个 uid）');
  assert.equal(findAll(cardOf(tree, 1), (el) => el.type === 'textarea').length, 0, '改 id 后仍能收起');
});

await test('C2 回归：重复 id 在卡片上给红色提示，警告区写明「有 N 个分组用了同一个 id」', () => {
  const seed = LANES();
  seed[1].id = 'lane-a';
  const tree = render(seedState(seed));
  const hints = [0, 1].map((slot) => byClass(cardOf(tree, slot), 'mgrp-error').map((el) => textOf(el)).join(''));
  assert.ok(hints[0].includes('id 与第 2 个分组重复'), hints[0]);
  assert.ok(hints[1].includes('id 与第 1 个分组重复'), hints[1]);
  const warn = textOf(byClass(tree, 'mgrp-warn')[0]);
  assert.ok(warn.includes('有 2 个分组用了同一个 id「lane-a」'), warn);
});

await test('C2 回归：存在重复 id 时不发 POST，保存区显示未保存错误态而不是「已保存」', async () => {
  const seed = LANES();
  seed[1].id = 'lane-a';
  requests.length = 0;
  render(seedState(seed));
  effects[1]();                                  // 自动保存 effect
  assert.equal(timers.length, 0, '重复 id 不应排保存定时器');
  runTimers();
  await tick(); await tick();
  assert.equal(requests.filter((entry) => entry.method === 'POST').length, 0, '重复 id 时绝不能发 POST（host 会静默改名）');
  assert.equal(lastWriteOf(5), 'blocked', '保存态应为错误态');
  const head = textOf(byClass(render(), 'mgrp-head')[0]);
  assert.ok(head.includes('未保存'), head);
  assert.ok(head.includes('有 2 个分组用了同一个 id'), head);
  assert.ok(!head.includes('已保存并即时生效'), '不能显示「已保存」');
});

await test('C2 回归：host 返回了不同的 id 时按位置合并回本地并提示（界面不再显示旧 id）', async () => {
  postMutation = (rows) => rows.map((row, at) => (at === 1 ? Object.assign({}, row, { id: 'lane-b-2' }) : row));
  try {
    let tree = render(seedState(LANES()));
    effects[1]();                                // 基线：记「已保存」
    inputIn(cardOf(tree, 1), 'mgrp-name').props.onChange({ target: { value: '改过的名字' } });
    tree = render();
    effects[1]();
    assert.equal(timers.length, 1, '改名后应排保存定时器');
    runTimers();
    await tick(); await tick();
    assert.equal(state[0][1].id, 'lane-b-2', '界面必须显示 host 落盘后的 id');
    assert.equal(state[0][1].uid, 'uid-b', '合并不能换掉 uid（否则整卡重挂载）');
    assert.equal(state[0][1].name, '改过的名字', '合并不回滚用户正在编辑的其它字段');
    const notice = String(lastWriteOf(4));
    assert.ok(notice.includes('已被 host 调整为「lane-b-2」'), notice);
    assert.equal(lastWriteOf(5), 'saved', '落盘本身是成功的，仍然是已保存态');
  } finally {
    postMutation = null;
  }
});

await test('C3 回归：id 缺失 / 非法与重复一样阻止 POST，改好后自动恢复保存', async () => {
  const seed = LANES();
  seed[1].id = 'Bad ID';
  requests.length = 0;
  let tree = render(seedState(seed));
  assert.ok(textOf(tree).includes('第 2 个分组的 id「Bad ID」不合法'), textOf(tree));
  assert.ok(textOf(tree).includes('只允许小写字母或数字开头'), '文案要点明允许的字符集');
  effects[1]();
  assert.equal(timers.length, 0, '非法 id 时不排保存定时器');
  runTimers();
  await tick(); await tick();
  assert.equal(requests.filter((entry) => entry.method === 'POST').length, 0, '非法 id 时绝不能发 POST');
  assert.equal(lastWriteOf(5), 'blocked');
  assert.ok(textOf(byClass(render(), 'mgrp-head')[0]).includes('第 2 个分组的 id 不合法'), '保存区应写明原因');

  // 同一张卡上把 id 删空：同样阻止，文案换成「缺少 id」
  inputIn(cardOf(tree, 1), 'mgrp-id').props.onChange({ target: { value: '' } });
  tree = render();
  assert.ok(textOf(tree).includes('第 2 个分组缺少 id：id 是统计与重试规则引用分组的标识，不填无法保存'), textOf(tree));
  effects[1]();
  runTimers();
  await tick(); await tick();
  assert.equal(requests.filter((entry) => entry.method === 'POST').length, 0, '缺 id 时绝不能发 POST');

  // 改好后恢复自动保存（不会永久卡死）
  inputIn(cardOf(tree, 1), 'mgrp-id').props.onChange({ target: { value: 'lane-b-ok' } });
  tree = render();
  effects[1]();
  assert.equal(timers.length, 1, '修好 id 后应恢复自动保存');
  runTimers();
  await tick(); await tick();
  const post = requests.find((entry) => entry.method === 'POST' && entry.url === '/dsh-model-groups/groups');
  assert.ok(post !== undefined, '修好后应正常 POST');
  assert.deepEqual(post.body.groups.map((group) => group.id), ['lane-a', 'lane-b-ok']);
  assert.equal(post.body.groups[0].uid, undefined, 'POST body 不带 uid');
  assert.equal(lastWriteOf(5), 'saved');
});

/* --------------------------------------------- 折叠状态持久化（host 文件） --- */

section('折叠状态持久化（$DSH_HOME/model-groups-ui.json）');

/** /state 的响应：分组 + 折叠集合（host 侧 ui 字段）。 */
function loadedState(groups, collapsed, uiExtra = {}) {
  return {
    ok: true, schema: 1, revision: 1, path: '/tmp/model-groups.json', exists: true,
    groups, warnings: [], limits: {},
    ui: Object.assign({ schema: 1, path: '/tmp/model-groups-ui.json', exists: true, revision: 5, collapsed }, uiExtra),
  };
}

/** 挂载 → 拉一次 /state → 重渲染，并把每帧都会跑的两个 effect 也跑一遍（贴近浏览器）。 */
async function mountWith(groups, collapsed, extra = {}, uiExtra = {}) {
  statePayload = loadedState(groups, collapsed, uiExtra);
  requests.length = 0;
  render(seedState(groups, extra));
  effects[0]();
  await tick(); await tick();
  const tree = render();
  effects[1]();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  return tree;
}

const uiPosts = () => requests.filter((entry) => entry.method === 'POST' && entry.url === '/dsh-model-groups/ui');
const textareasIn = (node) => findAll(node, (el) => el.type === 'textarea').length;

await test('持久化：加载时按 ui.collapsed 还原（id → 当前行的 uid），无改动时不回写', async () => {
  const tree = await mountWith(LANES(), ['lane-b']);
  assert.equal(textareasIn(cardOf(tree, 0)), 1, '第一张卡展开');
  assert.equal(textareasIn(cardOf(tree, 1)), 0, '第二张卡按落盘状态收起');
  assert.equal(uiPosts().length, 0, '与落盘一致：不该产生回写');
  assert.equal(timers.length, 0, '不排写盘定时器');
  assert.equal(state[10], '', '无错误');
});

await test('持久化：收起一张卡 → 防抖后 POST /ui，body 是组 id（不是 uid）', async () => {
  let tree = await mountWith(LANES(), []);
  assert.equal(textareasIn(cardOf(tree, 1)), 1);
  collapseButton(cardOf(tree, 1)).props.onClick();
  tree = render();
  assert.deepEqual(state[9], { [state[0][1].uid]: true }, '内存折叠表仍按 uid 记账');
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  assert.equal(timers.length, 1, '应排一个防抖定时器');
  runTimers();
  await tick(); await tick();
  const posts = uiPosts();
  assert.equal(posts.length, 1, '应把折叠状态写回 host');
  assert.deepEqual(posts[0].body, { collapsed: ['lane-b'] }, '落盘的是组 id，不是 uid');
  assert.equal(posts[0].body.collapsed.indexOf(state[0][1].uid), -1);
});

await test('持久化：展开回去 → 落盘集合跟着清掉（不会残留）', async () => {
  const tree = await mountWith(LANES(), ['lane-b']);
  collapseButton(cardOf(tree, 1)).props.onClick();
  const next = render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  runTimers();
  await tick(); await tick();
  const posts = uiPosts();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { collapsed: [] });
  assert.equal(textareasIn(cardOf(next, 1)), 1, '界面已展开');
});

await test('持久化：改 id 再收起 → 落盘集合记的是新 id（键跟 id 走，不跟 uid）', async () => {
  const tree = await mountWith(LANES(), []);
  inputIn(cardOf(tree, 1), 'mgrp-id').props.onChange({ target: { value: 'lane-b2' } });
  const next = render();
  collapseButton(cardOf(next, 1)).props.onClick();
  render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  runTimers();
  await tick(); await tick();
  const posts = uiPosts();
  assert.equal(posts.length, 1, '键变了才写');
  assert.deepEqual(posts[0].body, { collapsed: ['lane-b2'] }, '落盘的是改后的新 id，不是旧 id / uid');
});

await test('持久化：分组本体不可落盘时冻结折叠写盘（解除阻止后补上）', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  runTimers();
  await tick(); await tick();
  assert.deepEqual(uiPosts()[0].body, { collapsed: ['lane-b'] });
  requests.length = 0;

  // 先展开（集合清空，合法写盘），这样后面「带病收起」时界面意图与落盘确实不同——
  // 否则冻结与否都看不出差别（这正是变异体 M2 一度活下来的原因）。
  collapseButton(cardOf(render(), 1)).props.onClick();
  render();
  runChangedEffects();
  runTimers();
  await tick(); await tick();
  assert.deepEqual(uiPosts().at(-1).body, { collapsed: [] }, '展开是合法写盘');
  requests.length = 0;

  // 把**另一张卡**（展开的那张）的 id 改成半截/非法值：整份分组进入「保存已阻止」，
  // 此时收起 lane-b 必须一并冻结——否则这一笔折叠会挂在一份没落盘的 id 表上。
  inputIn(cardOf(render(), 0), 'mgrp-id').props.onChange({ target: { value: 'Bad ID' } });
  render();
  runChangedEffects();
  runTimers();                        // 分组本体不可落盘（blocked）→ 连定时器都不该排
  await tick(); await tick();
  assert.equal(uiPosts().length, 0, '非法 id 期间分组本体就不落盘');
  collapseButton(cardOf(render(), 1)).props.onClick();
  render();
  runChangedEffects();
  runTimers();
  await tick(); await tick();
  assert.equal(uiPosts().length, 0, '分组本体不可落盘时冻结折叠写盘');
  requests.length = 0;

  // 改回合法 id：闸门打开，被冻结的那一笔立刻补上
  inputIn(cardOf(render(), 0), 'mgrp-id').props.onChange({ target: { value: 'lane-a9' } });
  render();
  runChangedEffects();
  runTimers();
  await tick(); await tick();
  const posts = uiPosts();
  assert.equal(posts.length, 1, '解除阻止后恢复写盘');
  assert.deepEqual(posts[0].body, { collapsed: ['lane-b'] }, '补上的是被冻结的那一笔');
});

await test('持久化：改名 / 改优先级 / 排序都不触发折叠写盘（键只由「收起集合 + id」决定）', async () => {
  let tree = await mountWith(LANES(), ['lane-b']);
  // 每一步都只看「折叠 effect 跑不跑」+「有没有 /ui POST」：分组本体该保存照旧保存
  //（改名/改优先级会走 900ms 的分组自动保存），这里断言的是**折叠**不被无谓写盘。
  // 注意：被收起的那张卡现在没有任何输入框（按设计不给修改入口），改的是展开的那张。
  inputIn(cardOf(tree, 0), 'mgrp-name').props.onChange({ target: { value: '甲改' } });
  let next = render();
  assert.equal(runChangedEffects().includes(2), false, '改名不该让折叠 effect 重跑');
  inputIn(cardOf(next, 0), 'mgrp-prio').props.onChange({ target: { value: '5' } });
  next = render();
  assert.equal(runChangedEffects().includes(2), false, '改优先级不该让折叠 effect 重跑');
  buttonsIn(cardOf(next, 0)).find((el) => textOf(el) === '↓').props.onClick();
  next = render();
  assert.equal(runChangedEffects().includes(2), false, '排序（uid 跟着卡片走）不该让折叠 effect 重跑');
  runTimers();
  await tick(); await tick();
  assert.equal(uiPosts().length, 0, '全程没有折叠写盘');
});

await test('折叠交互：最左侧无杆箭头（收起朝右 / 展开转 90°），收起态只留展示名称、不留任何修改入口', async () => {
  const tree = await mountWith(LANES(), []);
  const card = cardOf(tree, 1);
  const chevron = collapseButton(card);
  assert.ok(chevron, '每张卡都有一个箭头开关');
  assert.equal(chevron.props.children, '›', '箭头是无杆的 ›（不是 → 这种带杆箭头）');
  assert.equal(chevron.props['aria-expanded'], 'true');
  assert.equal(String(chevron.props.className).includes('open'), true, '展开时箭头转 90°（朝下）');
  assert.equal(String(chevron.props.className).includes('mgrp-btn'), false, '箭头不是旧的文字按钮');
  assert.equal(byClass(card, 'mgrp-card-head')[0].props.children[0], chevron, '箭头在卡片最左侧（头部第一个元素）');
  assert.equal(textOf(card).includes('收起'), false, '右上角不再有「收起」文字按钮');
  assert.equal(textOf(card).includes('展开'), false, '右上角不再有「展开」文字按钮');

  chevron.props.onClick();
  const collapsed = cardOf(render(), 1);
  const chev = collapseButton(collapsed);
  assert.equal(chev.props.children, '›');
  assert.equal(chev.props['aria-expanded'], 'false');
  assert.equal(String(chev.props.className).includes('open'), false, '收起时朝右');
  assert.equal(byClass(collapsed, 'mgrp-card-head')[0].props.children[0], chev, '收起态的箭头同样在最左侧');
  const titles = byClass(collapsed, 'mgrp-card-title');
  assert.equal(titles.length, 1, '收起态只有一个标题元素');
  assert.equal(textOf(titles[0]), '乙', '收起态显示的就是这一组的展示名称（name）');
  assert.equal(titles[0].props.title, 'id: lane-b', 'id 挂在 title 上，悬停仍看得到');
  assert.equal(findAll(collapsed, (el) => el.type === 'input').length, 0, '收起态没有任何输入框');
  assert.equal(findAll(collapsed, (el) => el.type === 'textarea').length, 0, '收起态没有成员编辑区');
  assert.equal(buttonsIn(collapsed).length, 1, '收起态唯一的按钮就是那个箭头');
  assert.equal(buttonsIn(collapsed)[0], chev);
  assert.equal(textOf(collapsed).includes('启用'), false, '收起态没有启停开关');
  assert.equal(textOf(collapsed).includes('复制'), false, '收起态没有复制');
  assert.equal(textOf(collapsed).includes('删除'), false, '收起态没有删除');
  assert.equal(textOf(collapsed).includes('优先级'), false, '收起态连优先级标签都不显示');

  // 名称缺失时退到 id，再缺就退到占位文案——收起态不会变成一片空白
  const unnamed = await mountWith([{ uid: 'u1', id: 'only-id', name: '', enabled: true, priority: 1, members: [] }], ['only-id']);
  assert.equal(textOf(byClass(cardOf(unnamed, 0), 'mgrp-card-title')[0]), 'only-id', '没有名称时退到 id');
  const blank = await mountWith([{ uid: 'u2', id: '', name: '', enabled: true, priority: 1, members: [] }], []);
  assert.equal(byClass(cardOf(blank, 0), 'mgrp-card-title').length, 0, '空 id 落不进折叠集合 → 卡片本来就是展开态');
});

await test('持久化：host 写失败 → 页面明确提示 + 界面里的折叠照旧 + 不自动重试', async () => {
  uiPostFailure = 'ui route missing';
  try {
    const tree = await mountWith(LANES(), []);
    collapseButton(cardOf(tree, 1)).props.onClick();
    render();
    runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
    runTimers();
    await tick(); await tick();
    assert.ok(String(state[10]).includes('折叠状态未能保存'), String(state[10]));
    assert.ok(String(state[10]).includes('ui route missing'), String(state[10]));
    const next = render();
    assert.equal(textareasIn(cardOf(next, 1)), 0, '写盘失败不该把卡展开');
    assert.ok(textOf(next).includes('折叠状态未能保存'), '错误要显示在页面上');
    assert.equal(uiPosts().length, 1, '失败后不自动重试（避免错误风暴）');
  } finally {
    uiPostFailure = null;
  }
});

await test('持久化：旧 host（/state 无 ui 字段）→ 加载不报错、不回写，首次收起才尝试写盘', async () => {
  statePayload = { ok: true, schema: 1, revision: 1, path: '/tmp/model-groups.json', exists: true, groups: LANES(), warnings: [], limits: {} };
  requests.length = 0;
  render(seedState(LANES()));
  effects[0]();
  await tick(); await tick();
  const tree = render();
  effects[1]();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  assert.equal(state[10], '', '旧 host 不该报错');
  assert.equal(timers.length, 0, '没有折叠集合要写');
  assert.equal(uiPosts().length, 0);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  runTimers();
  await tick(); await tick();
  assert.deepEqual(uiPosts()[0].body, { collapsed: ['lane-b'] }, '首次收起照常尝试写盘（旧 host 会失败 → 走失败提示）');
});

await test('持久化：收起后立刻刷新（pagehide）→ 未到点的写盘用 sendBeacon 冲出去', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）                                  // 仍在防抖窗口内
  assert.equal(timers.length, 1, '写盘还在防抖窗口里');
  const handler = windowListeners.get('pagehide');
  assert.equal(typeof handler, 'function', '挂载时应注册 pagehide 冲刷');
  beacons.length = 0;
  handler();
  assert.equal(beacons.length, 1, '有未落盘的改动时必须冲刷');
  assert.equal(beacons[0].url, '/dsh-model-groups/ui');
  assert.deepEqual(JSON.parse(await beacons[0].blob.text()), { collapsed: ['lane-b'] });
  handler();
  assert.equal(beacons.length, 1, '冲刷过一次后不该重复发（基线已对齐）');
  assert.equal(uiPosts().length, 0, 'beacon 走的是另一条通道，不该有 fetch POST');
});

await test('持久化：收起 → 防抖窗口内又展开 → pagehide 无待冲刷改动（发的是最终状态）', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  let next = render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  assert.equal(timers.length, 1);
  collapseButton(cardOf(next, 1)).props.onClick();
  next = render();
  runChangedEffects();   // 只跑依赖变了的（defer 语义忠实：deps 写错会红灯）
  beacons.length = 0;
  windowListeners.get('pagehide')();
  assert.equal(beacons.length, 0, '回到已落盘状态：没有待冲刷的改动');
  assert.equal(textareasIn(cardOf(next, 1)), 1);
});

/* -------------------------------------- 折叠持久化：边界与失败路径（ui-2） --- */

await test('持久化：文件里有「当前不存在的组 id」时，只打开设置页不写盘（加载不回写契约）', async () => {
  // 另一个标签页删过组 / 改过名，或有人手改过文件 → 文件里会留孤儿 id。
  // 基线若取「文件原样」，加载这一帧就会把孤儿项抹掉并吃掉一个 revision
  // ——纯加载不该产生写入（多标签页下更会互相覆盖）。
  const tree = await mountWith(LANES(), ['ghost-group', 'lane-b']);
  assert.equal(uiPosts().length, 0, '孤儿 id 不该触发回写');
  assert.equal(timers.length, 0, '不排写盘定时器');
  assert.equal(textareasIn(cardOf(tree, 1)), 0, '真实存在的组照常还原成收起');
  assert.equal(state[10], '', '孤儿项不是错误，不打扰用户');
});

await test('持久化：孤儿 id 不会被永久冻结——下一次真实改动会把整份集合写成「界面真值」', async () => {
  await mountWith(LANES(), ['ghost-group']);
  assert.equal(uiPosts().length, 0);
  collapseButton(cardOf(render(), 0)).props.onClick();
  render();
  runChangedEffects();
  runTimers();
  await tick(); await tick();
  assert.deepEqual(uiPosts()[0].body, { collapsed: ['lane-a'] }, '整份覆盖：孤儿项自然出局');
});

await test('持久化：host 回 200 但丢了项（issues）→ 页面提示，不假装已保存', async () => {
  uiPostIssues = ['折叠项 "x" 超长（>64），已忽略'];
  uiPostEcho = [];                      // host 只接受了空集合
  try {
    const tree = await mountWith(LANES(), []);
    collapseButton(cardOf(tree, 1)).props.onClick();
    render();
    runChangedEffects();
    runTimers();
    await tick(); await tick();
    assert.ok(String(state[10]).includes('1 项未被接受'), String(state[10]));
    assert.ok(String(state[10]).includes('超长'), '要把 host 的原因原样带出来');
  } finally { uiPostIssues = null; uiPostEcho = null; }
});

await test('持久化：折叠状态文件坏了（ui.warning）→ 页面说明原因，而不是静默全展开', async () => {
  await mountWith(LANES(), [], {}, { warning: '折叠状态文件不可用：Expected property name' });
  assert.ok(String(state[10]).includes('折叠状态文件不可用'), String(state[10]));
  assert.ok(String(state[10]).includes('全部展开'), String(state[10]));
  assert.equal(uiPosts().length, 0, '坏文件只是降级显示，不该顺手写盘');
});

await test('持久化：关设置弹层（组件卸载）时补发未落盘的折叠改动——200ms 防抖窗口内也不丢', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();
  assert.equal(timers.length, 1, '还在防抖窗口里');
  unmount();                            // 关弹层 / 切别的设置分节：组件卸载，页面没卸载
  await tick(); await tick();
  const posts = uiPosts();
  assert.equal(posts.length, 1, '卸载时要补发（普通 fetch，不会被取消）');
  assert.deepEqual(posts[0].body, { collapsed: ['lane-b'] });
});

await test('持久化：卸载时如果没有待落盘的改动，什么也不发', async () => {
  const tree = await mountWith(LANES(), ['lane-b']);
  assert.equal(textareasIn(cardOf(tree, 1)), 0);
  unmount();
  await tick(); await tick();
  assert.equal(uiPosts().length, 0);
});

await test('分组编辑：900ms 防抖窗口内关弹层（卸载）→ 补发这一笔编辑，不再静默丢', async () => {
  const tree = await mountWith(LANES(), []);
  inputIn(cardOf(tree, 1), 'mgrp-prio').props.onChange({ target: { value: '9' } });
  render();
  runChangedEffects();
  const groupPosts = () => requests.filter((entry) => entry.method === 'POST' && entry.url === '/dsh-model-groups/groups');
  assert.equal(groupPosts().length, 0, '还在防抖窗口里');
  unmount();
  await tick(); await tick();
  const posts = groupPosts();
  assert.equal(posts.length, 1, '卸载时补发分组编辑');
  assert.equal(posts[0].body.groups[1].priority, 9);
});

await test('分组编辑：pagehide（刷新/关标签页）时未落盘的编辑走 beacon', async () => {
  const tree = await mountWith(LANES(), []);
  inputIn(cardOf(tree, 1), 'mgrp-name').props.onChange({ target: { value: '乙改' } });
  render();
  runChangedEffects();
  beacons.length = 0;
  windowListeners.get('pagehide')();
  assert.equal(beacons.length, 1, 'beacon 冲一笔分组编辑');
  assert.equal(beacons[0].url, '/dsh-model-groups/groups');
  const payload = JSON.parse(await beacons[0].blob.text());
  assert.equal(payload.groups[1].name, '乙改');
});

await test('分组编辑：beacon 被拒（返回 false）时不标记已送出去——下一次 pagehide 还要再试', async () => {
  const tree = await mountWith(LANES(), []);
  inputIn(cardOf(tree, 1), 'mgrp-name').props.onChange({ target: { value: '乙改' } });
  render();
  runChangedEffects();
  const handler = windowListeners.get('pagehide');
  beacons.length = 0;
  try {
    navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); return false; };   // 队列满：没发出去
    handler();
    assert.equal(beacons.length, 1);
    handler();
    assert.equal(beacons.length, 2, '上一次没送出去：这次还要再冲（若已标记送出就永不再发）');
  } finally {
    navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); return true; };
  }
  // 送出去之后就不该再无脑重发（否则每次 pagehide 都白冲一笔）
  handler();
  assert.equal(beacons.length, 3, '成功那一笔仍然只发一次');
  handler();
  assert.equal(beacons.length, 3, '已送出：不再重复 beacon');
});

await test('持久化：visibilitychange→hidden 也冲刷（pagehide 不保证在切后台时触发）', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();
  const handler = documentListeners.get('visibilitychange');
  assert.equal(typeof handler, 'function', '挂载时应注册 visibilitychange');
  beacons.length = 0;
  documentStub.visibilityState = 'visible';
  handler();
  assert.equal(beacons.length, 0, '可见时不冲刷');
  documentStub.visibilityState = 'hidden';
  handler();
  assert.equal(beacons.length, 1, '隐藏时冲刷');
  assert.equal(beacons[0].url, '/dsh-model-groups/ui');
  documentStub.visibilityState = 'visible';
});

await test('持久化：sendBeacon 被拒（返回 false）时不标记已落盘——下一次还有机会补发', async () => {
  const tree = await mountWith(LANES(), []);
  collapseButton(cardOf(tree, 1)).props.onClick();
  render();
  runChangedEffects();
  const handler = windowListeners.get('pagehide');
  beacons.length = 0;
  let saved = true;
  try {
    navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); saved = false; return false; };
    handler();
    assert.equal(beacons.length, 1);
    assert.equal(saved, false);
    handler();
    assert.equal(beacons.length, 2, '上一次没送出去：这次还要再冲（若已标记落盘就永不再发）');
  } finally {
    navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); return true; };
  }
});

await test('跨端一致：客户端 id 尺子与 host（resolve.js）逐字符同源，长度上限同为 64', async () => {
  assert.equal(ui.GROUP_ID_RE.source, ID_RE.source, 'id 正则必须与 host 的 ID_RE 同源');
  assert.equal(UI_MAX_ID_CHARS, LIMITS.maxIdChars, '长度上限必须与 host 的 maxIdChars 相同');
  const long = 'a'.repeat(65);
  assert.deepEqual(ui.collapsedIdsOf([{ uid: 'u1', id: long }, { uid: 'u2', id: 'lane-b' }], { u1: true, u2: true }), ['lane-b'],
    '超长 id 不落盘（host 会丢，客户端先拦下）');
  assert.deepEqual(ui.collapsedIdsFromHost({ collapsed: [long, 'lane-b', 'LANE-B '] }), ['lane-b'],
    'host 回显的超长/重复项按同一把尺子归一');
  assert.deepEqual(ui.collapsedIdsOf([{ uid: 'u3', id: 'a'.repeat(64) }], { u3: true }), ['a'.repeat(64)],
    '64 字符正好是允许的上界');
});

/* ------------------------------------------------------------- 收尾 ---- */

process.stdout.write('\n');
if (failures.length > 0) {
  process.stdout.write(`\n失败 ${failures.length} 项：\n`);
  for (const failure of failures) {
    process.stdout.write(`  ✗ ${failure.name}\n    ${failure.error && failure.error.stack ? failure.error.stack.split('\n').slice(0, 4).join('\n    ') : failure.error}\n`);
  }
  process.stdout.write(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`SELFTEST PASS (${passed} checks)\n`);
}
