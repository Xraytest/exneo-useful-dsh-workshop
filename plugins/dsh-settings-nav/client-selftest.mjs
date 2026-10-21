/**
 * dsh-settings-nav 浏览器半边自测（无头，测真实行为而非形状）。
 *
 * 桩到什么程度：
 *   · 极小 hooks 运行时（useState/useRef/useEffect 带依赖比较）→ 组件真的重渲染；
 *   · 一台**够用的假 DOM**：Element / classList / style / closest / 事件冒泡 /
 *     getBoundingClientRect / querySelector(All)，可以让导航增强器真的去定位、插标题、
 *     设 order/display、接事件、算落点；
 *   · 假 host（可编程 fetch）：/state 与 /save 真实往返，含 409 冲突、500 与断网；
 *   · 可控定时器：防抖保存与 rAF 回退都由测试决定何时到点。
 *
 * 断言集中在用户实际要的两件事：
 *   ① **分组收纳**：左列出现分组标题，折叠后成员真的不显示；
 *   ② **即时改排序**：管理面动一下（拖放 / ↑↓ / 加入分组），左列 DOM 的 order 当场变。
 *
 * 运行：node plugins/dsh-settings-nav/client-selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

/**
 * 取出厂设置壳的 CSS 文本，用来**钉住前提**：`navScroll` 那一段断言「我们不需要接管
 * overflow」是建立在「出厂 `.navList` 自带 `overflow-y:auto`」之上的。换机器/换版本找不到
 * 安装树时返回 null，那一条就降级为跳过（它只是前提，不是功能断言）。
 */
const SHIPPED_CLIENT_RELATIVE = join('node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');
function findShippedSettingsCss() {
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, SHIPPED_CLIENT_RELATIVE);
    try {
      return { path: candidate, text: readFileSync(candidate, 'utf8') };
    } catch (error) {
      /* 这一层没有，继续往上 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let checks = 0;
const ok = (value, message) => {
  checks += 1;
  assert.ok(value, message);
};
const eq = (actual, expected, message) => {
  checks += 1;
  assert.equal(actual, expected, message);
};
const deepEq = (actual, expected, message) => {
  checks += 1;
  assert.deepEqual(actual, expected, message);
};
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

// ── 桩：可控定时器 ──────────────────────────────────────────────────────────
const timers = [];
const pendingTimers = () => timers.filter((timer) => timer.cancelled !== true && timer.done !== true);
globalThis.setTimeout = (fn, ms) => {
  timers.push({ fn, ms, cancelled: false, done: false });
  return timers.length;
};
globalThis.clearTimeout = (id) => {
  const timer = timers[id - 1];
  if (timer !== undefined) timer.cancelled = true;
};
/** 跑掉当前所有挂起计时器（含它们自己再排的，最多 20 轮）。 */
function runTimers() {
  for (let round = 0; round < 20; round += 1) {
    const due = pendingTimers();
    if (due.length === 0) return round;
    for (const timer of due) {
      timer.done = true;
      timer.fn();
    }
  }
  return 20;
}

/* ══════════════════════════════ 假 DOM ══════════════════════════════ */

/** 选择器匹配：`tag` / `[attr]` / `[attr="v"]` 及组合（覆盖本插件用到的全部）。 */
function matchesSelector(element, selector) {
  // 支持 tag / .class / tag.class / [attr] / [attr="v"] 的组合（覆盖本插件用到的全部）。
  const classNames = [];
  const rest = selector
    .trim()
    .replace(/\.([A-Za-z0-9_-]+)/g, (match, name) => {
      classNames.push(name);
      return '';
    });
  const head = /^([a-zA-Z]*)((?:\[[^\]]+\])*)$/.exec(rest);
  if (head === null) return false;
  const tag = head[1];
  if (tag !== '' && element.tagName !== tag.toUpperCase()) return false;
  for (const name of classNames) if (!element._classes().includes(name)) return false;
  for (const raw of head[2].match(/\[[^\]]+\]/g) ?? []) {
    const inner = raw.slice(1, -1);
    const at = inner.indexOf('=');
    if (at < 0) {
      if (element.getAttribute(inner) === null) return false;
      continue;
    }
    const name = inner.slice(0, at);
    const value = inner.slice(at + 1).replace(/^"|"$/g, '');
    if (element.getAttribute(name) !== value) return false;
  }
  return true;
}

function FakeElement(tag) {
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.parentNode = null;
  this.attrs = new Map();
  this.style = {};
  this.listeners = new Map();
  this._text = '';
  this.dataset = {};
  this.rect = { top: 0, left: 0, width: 200, height: 28 };
  const self = this;
  this.classList = {
    add(name) {
      const set = new Set(self._classes());
      set.add(name);
      self.setAttribute('class', Array.from(set).join(' '));
    },
    remove(name) {
      const set = new Set(self._classes());
      set.delete(name);
      self.setAttribute('class', Array.from(set).join(' '));
    },
    contains(name) {
      return self._classes().includes(name);
    },
  };
}
FakeElement.prototype._classes = function _classes() {
  const raw = this.getAttribute('class');
  return raw === null || raw === '' ? [] : raw.split(/\s+/);
};
Object.defineProperty(FakeElement.prototype, 'className', {
  get() {
    return this.getAttribute('class') ?? '';
  },
  set(value) {
    this.setAttribute('class', String(value));
  },
});
Object.defineProperty(FakeElement.prototype, 'textContent', {
  get() {
    let text = this._text;
    for (const child of this.children) text += child.textContent;
    return text;
  },
  set(value) {
    this.children = [];
    this._text = String(value);
  },
});
Object.defineProperty(FakeElement.prototype, 'isConnected', {
  get() {
    let node = this;
    while (node.parentNode !== null && node.parentNode !== undefined) node = node.parentNode;
    return node.tagName === 'BODY';
  },
});
FakeElement.prototype.appendChild = function appendChild(child) {
  if (child.parentNode !== null && child.parentNode !== undefined) child.parentNode.removeChild(child);
  this.children.push(child);
  child.parentNode = this;
  return child;
};
FakeElement.prototype.removeChild = function removeChild(child) {
  const at = this.children.indexOf(child);
  if (at >= 0) this.children.splice(at, 1);
  child.parentNode = null;
  return child;
};
FakeElement.prototype.setAttribute = function setAttribute(name, value) {
  this.attrs.set(name, String(value));
};
FakeElement.prototype.getAttribute = function getAttribute(name) {
  return this.attrs.has(name) ? this.attrs.get(name) : null;
};
FakeElement.prototype.removeAttribute = function removeAttribute(name) {
  this.attrs.delete(name);
};
FakeElement.prototype.addEventListener = function addEventListener(type, handler) {
  if (!this.listeners.has(type)) this.listeners.set(type, []);
  this.listeners.get(type).push(handler);
};
FakeElement.prototype.removeEventListener = function removeEventListener(type, handler) {
  const list = this.listeners.get(type);
  if (list === undefined) return;
  const index = list.indexOf(handler);
  if (index >= 0) list.splice(index, 1);
};
FakeElement.prototype.descendants = function descendants() {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  };
  walk(this);
  return out;
};
FakeElement.prototype.querySelector = function querySelector(selector) {
  for (const node of this.descendants()) if (matchesSelector(node, selector)) return node;
  return null;
};
FakeElement.prototype.closest = function closest(selector) {
  let node = this;
  while (node !== null && node !== undefined) {
    if (matchesSelector(node, selector)) return node;
    node = node.parentNode;
  }
  return null;
};
FakeElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return this.rect;
};
/** 事件冒泡派发（插件的监听全挂在 navList 上，靠 event.target.closest 定位）。 */
FakeElement.prototype.dispatch = function dispatch(type, props = {}) {
  const event = Object.assign({ type, target: this, clientY: 0, preventDefault() {}, stopPropagation() {} }, props);
  let node = this;
  while (node !== null && node !== undefined) {
    for (const handler of node.listeners.get(type) ?? []) handler(event);
    node = node.parentNode;
  }
  return event;
};

const body = new FakeElement('body');
body.setAttribute('data-root', '1');

const dialogs = [];

globalThis.document = {
  body,
  head: new FakeElement('head'),
  documentElement: new FakeElement('html'),
  visibilityState: 'visible',
  querySelector(selector) {
    if (selector.startsWith('[role=')) return dialogs[0] ?? null;
    if (selector.startsWith('style[')) return styleNodes[0] ?? null;
    return null;
  },
  querySelectorAll(selector) {
    return selector.startsWith('[role=') ? dialogs.slice() : [];
  },
  createElement(tag) {
    return new FakeElement(tag);
  },
  addEventListener() {},
  removeEventListener() {},
};

/** head.children 的活引用：appendChild 就地 push，断言始终反映当前注入的样式节点。 */
const styleNodes = document.head.children;

let observerCallback = null;
let observerDisconnects = 0;
globalThis.MutationObserver = function MutationObserver(callback) {
  observerCallback = callback;
};
globalThis.MutationObserver.prototype.observe = function observe() {};
globalThis.MutationObserver.prototype.disconnect = function disconnect() {
  observerDisconnects += 1;
};

/** 假 DOM 上「React 提交了一帧」的信号。 */
const pokeDom = () => {
  if (observerCallback !== null) observerCallback([]);
};

/* ── 桩：极小 hooks 运行时 ───────────────────────────────────────────────── */
let hookValues = [];
let hookDeps = [];
let cursor = 0;
let pendingEffects = [];
let rerenderRequested = false;

const react = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value;
      rerenderRequested = true;
    };
    return [hookValues[index], set];
  },
  useRef(value) {
    const index = cursor;
    cursor += 1;
    if (!(index in hookValues)) hookValues[index] = { current: value };
    return hookValues[index];
  },
  useEffect(fn, deps) {
    const index = cursor;
    cursor += 1;
    const previous = hookDeps[index];
    const same =
      previous !== undefined && Array.isArray(deps) && Array.isArray(previous) && previous.length === deps.length && deps.every((value, at) => Object.is(value, previous[at]));
    if (!same) {
      hookDeps[index] = Array.isArray(deps) ? deps.slice() : deps;
      pendingEffects.push(fn);
    }
  },
};

/* ── 桩：模块加载器 ──────────────────────────────────────────────────────── */
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.confirm = globalThis.window.confirm;

const requireStub = (moduleName) => {
  if (moduleName === 'react') return react;
  throw new Error('unexpected require: ' + moduleName);
};

/* ══════════════════════════ 假 host（可编程 fetch） ══════════════════════════ */

const NAV_LEDGER = [
  { id: 'general', order: 0, label: '通用' },
  { id: 'models', order: 10, label: '模型' },
  { id: 'plugins', order: 15, label: '插件' },
  { id: 'workspace-context', order: 20, label: '工作区常驻上下文' },
  { id: 'model-groups', order: 25, label: '模型分组' },
  { id: 'usage-stats', order: 905, label: '用量统计' },
];
const ledgerRows = NAV_LEDGER.map((row) => ({ id: row.id, order: row.order, label: row.label }));
/** 可变账本：测「插件改了 order / 新装插件」时，出厂壳重渲染后的账本与 DOM 一起变。 */
let currentRows = ledgerRows;

const requests = [];
let hostReachable = true;
let hostEnabled = true;
let hostDoc = { schema: 1, revision: 3, order: [] };
let hostWarnings = [];
let hostFailWrites = false;

const jsonResponse = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

const hostFetch = async (url, init) => {
  const target = String(url);
  const payload = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : null;
  requests.push({ url: target, body: payload });
  if (hostReachable !== true) throw new Error('TypeError: Failed to fetch');
  if (target.endsWith('/state')) {
    return jsonResponse({
      ok: true,
      schema: 1,
      build: 'nav-1',
      impl: 'index.js?v=nav-1',
      path: '/home/u/.dsh/settings-nav.json',
      exists: true,
      revision: hostDoc.revision,
      order: hostDoc.order,
      warnings: hostWarnings,
      limits: {},
      config: { enabled: hostEnabled },
      diag: {},
    });
  }
  if (target.endsWith('/save')) {
    if (hostFailWrites === true) return jsonResponse({ ok: false, error: '磁盘满了' }, 500);
    if (payload.baseRevision !== hostDoc.revision) return jsonResponse({ ok: false, conflict: true, revision: hostDoc.revision, order: hostDoc.order }, 409);
    hostDoc = { schema: 1, revision: hostDoc.revision + 1, order: payload.order };
    return jsonResponse({ ok: true, revision: hostDoc.revision, order: hostDoc.order, warnings: [], issues: [], issueCount: 0 });
  }
  return jsonResponse({ ok: false, error: 'not found' }, 404);
};

/* ══════════════════════════════ 载入模块 ══════════════════════════════ */

new Function('window', 'document', 'require', 'fetch', source)(globalThis.window, globalThis.document, requireStub, hostFetch);

ok(captured !== null, 'client.js 通过 __ModuleLoader__ 注册');
eq(captured.id, 'dsh-settings-nav', '模块 id');
const exports_ = captured.factory(requireStub);
const ui = exports_.__ui;
eq(JSON.stringify(exports_.inject), JSON.stringify(['slots']), 'inject 只依赖 slots');
ok(typeof exports_.apply === 'function', '导出 apply');
ok(ui !== undefined && typeof ui.computePlan === 'function', '导出 __ui（纯函数可无头驱动）');

/* ══════════════════════════ 假设置模态（出厂结构） ══════════════════════════ */

const dom = (() => {
  const dialog = new FakeElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const nav = new FakeElement('nav');
  const title = new FakeElement('div');
  title.textContent = '设置';
  const spacer = new FakeElement('div');
  const list = new FakeElement('div');
  list.className = 'VOzbGW_navList';
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  const buttons = NAV_LEDGER.map((row) => {
    const button = new FakeElement('button');
    button.className = 'VOzbGW_navCell';
    button.textContent = row.label;
    list.appendChild(button);
    return button;
  });
  nav.appendChild(title);
  nav.appendChild(spacer);
  nav.appendChild(list);
  dialog.appendChild(nav);
  body.appendChild(dialog);
  dialogs.push(dialog);
  return { dialog, nav, list, buttons };
})();

/** 左列当前的实际视觉顺序（按 style.order 排，模拟 flex 布局）。 */
function visualOrder(list) {
  const rankOf = (node) => {
    const value = Number(node.style.order);
    return Number.isFinite(value) ? value : 0;
  };
  return list.children.slice().sort((left, right) => rankOf(left) - rankOf(right));
}

/** 左列里可见的设置项行标签（只算导航列表的直接子 button）。 */
function visibleRows(list) {
  return visualOrder(list)
    .filter((node) => node.tagName === 'BUTTON' && node.style.display !== 'none')
    .map((node) => node.textContent);
}

/** 左列里的分组标题。 */
function headersOf(list) {
  return visualOrder(list)
    .filter((node) => node.getAttribute('data-dsn-own') === 'header')
    .map((node) => ({
      gid: node.getAttribute('data-dsn-gid'),
      name: node.querySelector('.dsn-navheader-label').textContent,
      collapsed: node.getAttribute('data-dsn-collapsed') === '1',
      order: Number(node.style.order),
      node,
    }));
}

const ourNodes = (list) => list.children.filter((node) => node.getAttribute('data-dsn-own') !== null);

/**
 * 模拟出厂壳重渲染后把行按钮按新账本顺序重排（React 对 keyed 列表用的是 insertBefore，
 * 也就是「移动节点」而不是重建）。节点是同一批，只是顺序变了——映射必须跟着走。
 */
function reorderNav(labels) {
  const byLabel = new Map(dom.buttons.map((button) => [button.textContent, button]));
  const next = labels.map((label) => byLabel.get(label));
  for (const button of next) dom.list.appendChild(button);
  dom.buttons.length = 0;
  for (const button of next) dom.buttons.push(button);
  return next;
}

/** 把左列恢复成「出厂刚渲染完」的样子（含账本与行顺序）。 */
function resetDom() {
  currentRows = ledgerRows;
  for (const child of body.children.slice()) if (child !== dom.dialog) body.removeChild(child);
  if (!dialogs.includes(dom.dialog)) dialogs.push(dom.dialog);
  if (dom.dialog.parentNode !== body) body.appendChild(dom.dialog);
  for (const extra of dom.list.children.slice()) if (!dom.buttons.includes(extra)) dom.list.removeChild(extra);
  // 行顺序也要还原：上一个用例可能模拟过「React 把行重排了」，不还原就会让后面的用例
  // 在「DOM 顺序 ≠ 账本顺序」的假状态下跑（那正是失配兜底该生效的场景，不是默认状态）。
  const byLabel = new Map(dom.buttons.map((button) => [button.textContent, button]));
  const canonical = NAV_LEDGER.map((row) => byLabel.get(row.label)).filter((button) => button !== undefined);
  for (const button of canonical) dom.list.appendChild(button);
  dom.buttons.length = 0;
  for (const button of canonical) dom.buttons.push(button);
  for (const button of dom.buttons) {
    delete button.style.order;
    delete button.style.display;
    button.removeAttribute('draggable');
    button.removeAttribute('aria-current');
    button.setAttribute('class', 'VOzbGW_navCell');
  }
}

/* ── React 树工具 ───────────────────────────────────────────────────────── */
function nodesOf(node) {
  const out = [];
  const walk = (current) => {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (typeof current !== 'object') return;
    out.push(current);
    if (Array.isArray(current.children)) for (const child of current.children) walk(child);
  };
  walk(node);
  return out;
}
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('');
  return '';
}

/* ══════════════════════════ 1. 纯函数：归一化 ══════════════════════════ */

{
  deepEq(ui.normalizeDoc(null).order, [], 'null 文档 → 空');
  deepEq(ui.normalizeDoc({ order: 'x' }).order, [], 'order 不是数组 → 空');
  deepEq(ui.normalizeDoc([1, 2]).order, [], '数组根 → 空');

  const doc = ui.normalizeDoc({
    revision: 7.9,
    order: [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g1', name: '  模型   与 路由 ', collapsed: true, items: ['models', 'models', 'general'] },
      { type: 'group', id: 'g1', name: '重复', items: [] },
      { type: 'item', id: 'general' },
      { type: 'item', id: '   ' },
      { type: 'nope', id: 'x' },
      null,
    ],
  });
  eq(doc.revision, 7, 'revision 取整');
  deepEq(
    doc.order,
    [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g1', name: '模型 与 路由', collapsed: true, items: ['models'] },
    ],
    '重复 id / 空 id / 未知 type / 非对象项都被丢弃；成员与顶层共用一张去重账',
  );
  eq(ui.cleanName('  a\n\nb  '), 'a b', '名字折叠空白');
  eq(ui.cleanName('x'.repeat(200)).length, 60, '名字夹到 60 字');
  eq(ui.resolveLabel(() => 'thunk'), 'thunk', 'label 支持 thunk');
  eq(ui.resolveLabel(undefined), '', 'label 缺省为空串');

  const taken = new Set();
  const generated = new Set();
  for (let index = 0; index < 30; index += 1) {
    const id = ui.generateGroupId(taken);
    eq(generated.has(id), false, '生成的 group id 不重复');
    generated.add(id);
  }
}

/* ══════════════════════════ 2. 纯函数：导航计划 ══════════════════════════ */

{
  const plan = ui.computePlan(ui.emptyDoc(), ledgerRows);
  deepEq(plan.entries.map((entry) => (entry.kind === 'item' ? entry.id : 'H')), NAV_LEDGER.map((row) => row.id), '空布局 = 出厂顺序');
  eq(plan.loose.length, 6, '全部是未分组');
  deepEq(plan.orphans, [], '没有失联项');
  eq(plan.groupCount, 0, '没有分组');
}

{
  const doc = ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g1', name: '模型与路由', collapsed: false, items: ['models', 'model-groups'] },
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g2', name: '会话与数据', collapsed: true, items: ['usage-stats'] },
      { type: 'item', id: 'ghost-plugin' },
      { type: 'group', id: 'g3', name: '空组', collapsed: false, items: ['gone'] },
    ],
  });
  const plan = ui.computePlan(doc, ledgerRows);
  deepEq(
    plan.entries.map((entry) => (entry.kind === 'header' ? 'H:' + entry.gid : entry.id + (entry.hidden ? '(hidden)' : ''))),
    ['H:g1', 'models', 'model-groups', 'general', 'H:g2', 'usage-stats(hidden)', 'H:g3', 'plugins', 'workspace-context'],
    '分组→成员、独立项、折叠隐藏、空组仍出标题、没登记的行按账本顺序补在最后',
  );
  deepEq(plan.orphans, ['ghost-plugin', 'gone'], '失联项被识别（含分组内成员）');
  deepEq(plan.loose, ['plugins', 'workspace-context'], '未登记项');
  eq(plan.groupCount, 3, '分组数');
  eq(plan.byId.get('usage-stats').groupId, 'g2', '成员知道自己在哪一组');
  eq(plan.byId.get('usage-stats').hidden, true, '折叠组的成员被标隐藏');
  eq(plan.byId.get('general').groupId, null, '独立项没有分组');
  eq(plan.entries.find((entry) => entry.kind === 'header' && entry.gid === 'g3').count, 0, '空组数量为 0 但仍然出标题');
  const ranks = plan.entries.map((entry) => entry.rank);
  deepEq(ranks, ranks.slice().sort((a, b) => a - b), 'rank 单调递增');
  eq(new Set(ranks).size, ranks.length, 'rank 互不相同');
}

{
  const doc = ui.normalizeDoc({ order: [{ type: 'group', id: 'g', name: 'x', items: ['models'] }] });
  const a = ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 6, false, 1);
  const b = ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 6, false, 2);
  const c = ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 6, true, 1);
  const d = ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 5, false, 1);
  const e = ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 6, false, 1, 'models');
  ok(a !== b, 'revision 变则签名变');
  ok(a !== c, '整理模式切换则签名变');
  ok(a !== d, '行数变则签名变');
  ok(a !== e, '当前分节变则签名变（否则换页后收起态不会重算）');
  eq(a, ui.planSignature(ui.computePlan(doc, ledgerRows), ledgerRows, 6, false, 1), '同输入签名稳定');
}

/* ══════════════════════════ 3. 纯函数：拖放与编辑 ══════════════════════════ */

const ids = (doc) => doc.order.map((entry) => (entry.type === 'item' ? entry.id : entry.id + '[' + entry.items.join(',') + ']'));
const treeOf = (list) =>
  list
    .map((node) => {
      if (node !== null && typeof node === 'object' && node.type === 'group') {
        return node.id + '[' + treeOf(node.items) + ']' + (node.collapsed === true ? '~' : '');
      }
      return typeof node === 'string' ? node : node.id;
    })
    .join(' ');

{
  const base = ui.normalizeDoc({
    order: [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g1', name: 'A', items: ['models', 'plugins'] },
      { type: 'group', id: 'g2', name: 'B', items: ['usage-stats'] },
      { type: 'item', id: 'model-groups' },
    ],
  });
  const baseIds = ids(base);

  const A = (container, ref, side) => (side === undefined ? { container, ref } : { container, ref, side });
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A([], { kind: 'item', id: 'model-groups' }, 'after'))), ['g1[models,plugins]', 'g2[usage-stats]', 'model-groups', 'general'], '独立项 → 另一独立项后面');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A([], { kind: 'item', id: 'model-groups' }, 'before'))), ['g1[models,plugins]', 'g2[usage-stats]', 'general', 'model-groups'], '独立项 → 另一独立项前面');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A(['g1'], { kind: 'item', id: 'plugins' }, 'before'))), ['g1[models,general,plugins]', 'g2[usage-stats]', 'model-groups'], '独立项 → 分组内某成员前面');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A(['g1'], { kind: 'item', id: 'plugins' }, 'after'))), ['g1[models,plugins,general]', 'g2[usage-stats]', 'model-groups'], '独立项 → 分组内某成员后面');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A(['g1'], null))), ['g1[models,plugins,general]', 'g2[usage-stats]', 'model-groups'], '拖进这一组（ref=null → 追加到末尾）');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A([], { kind: 'group', id: 'g2' }, 'before'))), ['g1[models,plugins]', 'general', 'g2[usage-stats]', 'model-groups'], '拖到分组标题上半区 = 落成分组前的独立项');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'models' }, A([], { kind: 'item', id: 'model-groups' }, 'after'))), ['general', 'g1[plugins]', 'g2[usage-stats]', 'model-groups', 'models'], '成员拖出分组');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'models' }, A(['g1'], { kind: 'item', id: 'plugins' }, 'after'))), ['general', 'g1[plugins,models]', 'g2[usage-stats]', 'model-groups'], '组内换位（锚点在后）');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'plugins' }, A(['g1'], { kind: 'item', id: 'models' }, 'before'))), ['general', 'g1[plugins,models]', 'g2[usage-stats]', 'model-groups'], '组内换位（锚点在前）');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'plugins' }, A(['g1'], { kind: 'item', id: 'plugins' }, 'before'))), baseIds, '落点就是自己 → 空操作');
  deepEq(ids(ui.applyDrop(base, { kind: 'group', id: 'g1' }, A([], { kind: 'group', id: 'g2' }, 'after'))), ['general', 'g2[usage-stats]', 'g1[models,plugins]', 'model-groups'], '整组 → 另一组后面');
  deepEq(ids(ui.applyDrop(base, { kind: 'group', id: 'g2' }, A([], { kind: 'group', id: 'g1' }, 'before'))), ['general', 'g2[usage-stats]', 'g1[models,plugins]', 'model-groups'], '整组 → 另一组前面');
  deepEq(ids(ui.applyDrop(base, { kind: 'group', id: 'g1' }, A([], { kind: 'group', id: 'g1' }, 'before'))), baseIds, '整组拖到自己身上 → 空操作');
  deepEq(ids(ui.applyDrop(base, { kind: 'group', id: 'g1' }, A([], { kind: 'item', id: 'model-groups' }, 'after'))), ['general', 'g2[usage-stats]', 'model-groups', 'g1[models,plugins]'], '整组 → 独立项后面');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'nope' }, A([], { kind: 'item', id: 'general' }, 'after'))), ['general', 'nope', 'g1[models,plugins]', 'g2[usage-stats]', 'model-groups'], '布局外的新项也能落进来');
  deepEq(ids(ui.applyDrop(base, { kind: 'item', id: 'general' }, A(['nope'], null))), baseIds, '容器不存在 → 原样返回（绝不「只摘不插」）');
  eq(ui.applyDrop(base, null, null), base, '空参数原样返回');

/* ══════════════════════════ 3b. 纯函数：多级（嵌套）结构 ══════════════════════════ */

{
  const nested = ui.normalizeDoc({
    order: [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g-top', name: '顶层组', collapsed: false, items: [
        'models',
        { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins', 'model-groups'] },
        'usage-stats',
      ] },
    ],
  });
  eq(treeOf(nested.order), 'general g-top[models g-in[plugins model-groups] usage-stats]', '归一化保留嵌套：设置项与子分组交错、顺序不变');

  // 深度上限：顶层分组第 0 层，所以第 5 层起整棵丢掉。
  let deep = { type: 'group', id: 'g5', name: 'x', items: [{ type: 'item', id: 'x5' }] };
  for (let level = 4; level >= 0; level -= 1) deep = { type: 'group', id: 'g' + level, name: 'x', items: [deep] };
  eq(ui.MAX_DEPTH, 5, '深度上限 5 层');
  eq(treeOf(ui.normalizeDoc({ order: [deep] }).order), 'g0[g1[g2[g3[g4[]]]]]', '超过 5 层的子分组被丢掉（保留到第 4 层）');
  const kept = ui.normalizeDoc({ order: [deep] });
  eq(ui.countGroups(kept.order), 5, '只留下 5 个分组节点');

  // 计划：深度优先 + 「折叠是子树级」。
  const folded = ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g-top', name: '顶层组', collapsed: true, items: [
        'models',
        { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins'] },
      ] },
      { type: 'item', id: 'general' },
    ],
  });
  const plan = ui.computePlan(folded, ledgerRows);
  deepEq(
    plan.entries.map((entry) => (entry.kind === 'header' ? 'H:' + entry.gid : entry.id + (entry.hidden ? '(hidden)' : ''))),
    ['H:g-top', 'models(hidden)', 'H:g-in', 'plugins(hidden)', 'general', 'workspace-context', 'model-groups', 'usage-stats'],
    '父组收起 → 整棵子树都 hidden（连子分组的标题也标 hidden）',
  );
  eq(plan.byId.get('plugins').path.join('/'), 'g-top/g-in', '成员带得出祖先链');
  eq(plan.byId.get('plugins').depth, 2, '成员的层级深度');
  eq(plan.byId.get('models').groupId, 'g-top', '成员知道自己的直接父组');
  eq(plan.entries.find((entry) => entry.kind === 'header' && entry.gid === 'g-in').hidden, true, '子分组标题被祖先收起连带隐藏');
  eq(plan.entries.find((entry) => entry.kind === 'header' && entry.gid === 'g-top').count, 2, '「N 项」数的是整棵子树里活着的设置项');
  eq(plan.entries.find((entry) => entry.kind === 'header' && entry.gid === 'g-top').depth, 0, '顶层组深度 0');
  eq(plan.groupCount, 2, '分组数含嵌套');

  const expanded = ui.setAllCollapsed(folded, false);
  eq(ui.computePlan(expanded, ledgerRows).byId.get('plugins').hidden, false, '全部展开后不再 hidden');
  const innerOnly = ui.computePlan(ui.setGroupCollapsed(expanded, 'g-in', true), ledgerRows);
  eq(innerOnly.byId.get('models').hidden, false, '收起子组不影响同级的其它成员');
  eq(innerOnly.byId.get('plugins').hidden, true, '子组自己的成员被隐藏');
  eq(innerOnly.entries.find((entry) => entry.kind === 'header' && entry.gid === 'g-in').hidden, false, '子组自己的标题不 hidden（只是它自己收起了）');

  // 拖放：分组进分组、进二级子组、成环拒绝。
  const A = (container, ref, side) => (side === undefined ? { container, ref } : { container, ref, side });
  eq(treeOf(ui.applyDrop(nested, { kind: 'group', id: 'g-in' }, A([], null)).order), 'general g-top[models usage-stats] g-in[plugins model-groups]', '子组拖到顶层末尾');
  eq(treeOf(ui.applyDrop(nested, { kind: 'item', id: 'general' }, A(['g-top', 'g-in'], { kind: 'item', id: 'plugins' }, 'after')).order), 'g-top[models g-in[plugins general model-groups] usage-stats]', '独立项拖进二级子组');
  eq(treeOf(ui.applyDrop(nested, { kind: 'group', id: 'g-top' }, A(['g-top'], null)).order), treeOf(nested.order), '分组落进自己 → 空操作');
  eq(ui.applyDrop(nested, { kind: 'group', id: 'g-top' }, A(['g-top', 'g-in'], null)), nested, '分组落进自己的后代 → 空操作（成环）');
  eq(ui.applyDrop(nested, { kind: 'group', id: 'nope' }, A([], null)), nested, '不存在的分组 → 原样返回');

  // 新建子分组 / 兄弟移动 / 移出 / 删组 / 递归清理。
  const made = ui.createGroup(nested, 'g-top');
  eq(ui.countGroups(made.order), 3, '新建子分组后分组数 +1');
  const madeTop = ui.findGroupNode(made.order, 'g-top');
  eq(madeTop.items.length, 4, '新子分组追加在该组末尾');
  eq(ui.isGroupNode(madeTop.items[3]), true, '追加的确实是分组节点');
  eq(madeTop.items[3].name, '新分组', '新子分组有默认名字');
  eq(made.order.length, 2, '顶层条目数不变');
  eq(ui.createGroup(nested, 'nope'), nested, '父分组不存在 → 不动');
  eq(treeOf(ui.moveSibling(nested, 'group', 'g-in', -1).order), 'general g-top[g-in[plugins model-groups] models usage-stats]', '子组在自己容器里上移（跨过设置项）');
  eq(treeOf(ui.moveOutOfGroup(nested, 'g-in', 'g-top').order), 'general g-top[models usage-stats] g-in[plugins model-groups]', '子组移出父组');
  eq(treeOf(ui.moveOutOfGroup(nested, 'models', 'g-top').order), 'general g-top[g-in[plugins model-groups] usage-stats] models', '设置项移出父组');
  eq(treeOf(ui.deleteGroup(nested, 'g-top').order), 'general models g-in[plugins model-groups] usage-stats', '删父组：整棵子分组保留并就地摊回顶层');
  eq(treeOf(ui.deleteGroup(nested, 'g-in').order), 'general g-top[models plugins model-groups usage-stats]', '删子组：成员摊回父组（仍是字符串成员）');

  const ghostly = ui.normalizeDoc({
    order: [{ type: 'group', id: 'g1', name: 'A', items: ['models', { type: 'group', id: 'g2', name: 'B', items: ['gone', 'plugins'] }] }],
  });
  eq(treeOf(ui.cleanupOrphans(ghostly, new Set(['models', 'plugins'])).order), 'g1[models g2[plugins]]', '递归清理失联项（子组里的也清）');
}
}

{
  const base = ui.normalizeDoc({
    order: [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g1', name: 'A', collapsed: false, items: ['models', 'plugins'] },
    ],
  });
  eq(ui.moveIntoGroup(base, 'general', 'g1').order[0].items.join(','), 'models,plugins,general', '加入分组（追加到末尾，独立项从顶层消失）');
  eq(ui.moveIntoGroup(base, 'models', 'g1'), base, '已在组里 → 不动');
  eq(ui.moveOutOfGroup(base, 'models', 'g1').order[1].items.join(','), 'plugins', '移出分组');
  deepEq(ids(ui.moveOutOfGroup(base, 'models', 'g1')), ['general', 'g1[plugins]', 'models'], '移出后落成紧跟该组之后的独立项');
  deepEq(ui.appendLoose(base, 'models').order.map((entry) => (entry.type === 'group' ? 'G' : entry.id)), ['general', 'G', 'models'], '「放到末尾」落成最后一个独立项');

  const made = ui.createGroup(base);
  eq(made.order.length, 3, '新建分组追加');
  eq(made.order[2].type, 'group', '新建的是分组');
  deepEq(made.order[2].items, [], '新分组是空的');
  eq(ui.renameGroup(base, 'g1', '  B  ').order[1].name, 'B', '重命名（去空白）');
  eq(ui.renameGroup(base, 'g1', '   ').order[1].name, '未命名分组', '空名字回落');
  eq(ui.setGroupCollapsed(base, 'g1', true).order[1].collapsed, true, '单组折叠');
  eq(ui.setAllCollapsed(base, true).order[1].collapsed, true, '全部收起');
  eq(ui.setAllCollapsed(ui.setAllCollapsed(base, true), false).order[1].collapsed, false, '全部展开');
  deepEq(ui.deleteGroup(base, 'g1').order.map((entry) => (entry.type === 'group' ? 'G' : entry.id)), ['general', 'models', 'plugins'], '删组不删项：成员就地摊回顶层');
  eq(ui.moveMember(base, 'g1', 'plugins', -1).order[1].items.join(','), 'plugins,models', '组内上移');
  eq(ui.moveMember(base, 'g1', 'models', -1), base, '已在首位 → 不动');
  eq(ui.moveMember(base, 'g1', 'plugins', 1), base, '已在末位 → 不动');
  eq(ui.moveMember(base, 'g1', 'ghost', 1), base, '不存在的成员 → 不动');
  eq(ui.moveTopLevel(base, 'g1', -1).order[0].id, 'g1', '顶层上移');
  eq(ui.moveTopLevel(base, 'general', -1), base, '已在首位 → 不动');
  eq(ui.moveTopLevel(base, 'general', 1).order[0].id, 'g1', '顶层下移');

  const withGhost = ui.normalizeDoc({
    order: [
      { type: 'item', id: 'general' },
      { type: 'item', id: 'gone' },
      { type: 'group', id: 'g', name: 'x', items: ['models', 'gone2'] },
    ],
  });
  deepEq(ids(ui.cleanupOrphans(withGhost, new Set(['general', 'models']))), ['general', 'g[models]'], '清理失联项（空组保留）');
  eq(ui.locate(base, 'plugins').type, 'group', 'locate 报告成员');
  eq(ui.locate(base, 'plugins').at, 1, 'locate 报告成员下标');
  eq(ui.locate(base, 'general').type, 'item', 'locate 报告独立项');
  eq(ui.locate(base, 'ghost'), null, 'locate 报告不存在');
}

/* ══════════════════════════ 4. 纯函数：预置方案 ══════════════════════════ */

{
  const preset = ui.suggestedLayout(ledgerRows);
  const groups = preset.order.filter((entry) => entry.type === 'group');
  ok(groups.length >= 2, '预置方案给出多于一个分组（否则没有意义）');
  eq(preset.order[0].id, 'general', '「通用」留在最上面当独立项');
  const members = groups.reduce((all, group) => all.concat(group.items), []);
  eq(members.length, 5, '每个设置项都被归入某一组');
  eq(new Set(members).size, members.length, '没有重复归属');
  ok(groups.some((group) => group.items.includes('models')), '模型相关项进同一组');
  eq(ui.suggestedLayout([]).order.filter((entry) => entry.type === 'group').length, 0, '只有一项时不硬造分组');
  deepEq(ui.suggestedLayout(ledgerRows), ui.suggestedLayout(ledgerRows), '预置方案确定（同输入同输出）');
}

/* ══════════════════════════ 5. 状态仓（真 fetch 桩） ══════════════════════════ */

{
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'item', id: 'general' }] };
  hostReachable = true;
  hostEnabled = true;
  hostWarnings = [];
  requests.length = 0;

  const store = ui.createStore({ fetchImpl: hostFetch });
  const seen = [];
  store.subscribe(() => seen.push(store.get().revision));
  await store.load();
  eq(store.get().persist, 'ok', '装载成功');
  eq(store.get().revision, 3, '采纳 host revision');
  eq(store.get().doc.order.length, 1, '采纳 host 布局');
  eq(store.get().enabled, true, '采纳 enabled');
  eq(store.get().path, '/home/u/.dsh/settings-nav.json', '采纳文件路径');
  eq(store.get().hostBuild, 'nav-1', '采纳 host build');
  eq(store.get().hostImpl, 'index.js?v=nav-1', '采纳 host impl 身份（含 ?v= 标记）');

  store.mutate((doc) => ui.createGroup(doc));
  eq(store.get().dirty, true, '改动先标脏');
  eq(store.get().doc.order.length, 2, '内存里立刻有分组');
  eq(requests.filter((item) => item.url.endsWith('/save')).length, 0, '防抖窗口内不发请求');
  runTimers();
  await tick();
  await tick();
  const save = requests.filter((item) => item.url.endsWith('/save')).pop();
  ok(save !== undefined, '防抖到点后发出 POST /save');
  eq(save.body.baseRevision, 3, 'save 带上 baseRevision');
  eq(save.body.order.length, 2, 'save 提交整份文档');
  eq(store.get().revision, 4, '采纳新 revision');
  eq(store.get().dirty, false, '落盘后清脏');

  // 冲突：host 被别人改了 → 采用 host 版本并提示，绝不覆盖。
  hostDoc = { schema: 1, revision: 9, order: [{ type: 'item', id: 'plugins' }] };
  store.mutate((doc) => ui.setAllCollapsed(doc, true));
  runTimers();
  await tick();
  await tick();
  eq(hostDoc.revision, 9, '冲突时 host 文档没被覆盖');
  deepEq(hostDoc.order, [{ type: 'item', id: 'plugins' }], '冲突时 host 布局没被覆盖');
  eq(store.get().revision, 9, '冲突后采用 host 的 revision');
  deepEq(store.get().doc.order, [{ type: 'item', id: 'plugins' }], '冲突后采用 host 的布局');
  ok(store.get().notice !== null, '冲突给出提示');
  eq(store.get().dirty, false, '冲突后不再假装有挂起改动');

  // 写失败（500）
  hostFailWrites = true;
  store.mutate((doc) => ui.createGroup(doc));
  runTimers();
  await tick();
  await tick();
  ok(String(store.get().error).includes('磁盘满了'), '写失败把 host 的错误原文带出来');
  hostFailWrites = false;

  store.mutate((doc) => ui.createGroup(doc));
  runTimers();
  await tick();
  await tick();
  eq(store.get().error, null, '成功写清掉上一次的错误');

  store.mutate((doc) => ui.setAllCollapsed(doc, false));
  await store.flush();
  await tick();
  eq(store.get().dirty, false, 'flush 立刻落盘');

  store.replace(ui.emptyDoc());
  await store.flush();
  await tick();
  eq(store.get().doc.order.length, 0, 'replace 清空布局');
  eq(hostDoc.order.length, 0, 'replace 已落盘到 host');
  store.dispose();
  ok(seen.length > 5, '状态变化都通知了订阅者');
}

/* ── 保存在途时又改一次：那次编辑必须最终落盘（曾被 dirty=false 静默吞掉） ── */
{
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'item', id: 'general' }, { type: 'item', id: 'models' }, { type: 'item', id: 'plugins' }] };
  hostReachable = true;
  hostEnabled = true;
  hostFailWrites = false;
  requests.length = 0;
  const base = timers.length;
  const ours = () => pendingTimers().filter((timer) => timers.indexOf(timer) >= base);
  const fireOurs = () => {
    const due = ours();
    if (due.length === 0) return false;
    due[0].done = true;
    due[0].fn();
    return true;
  };
  const gate = [];
  let saves = 0;
  const slowFetch = async (url, init) => {
    const target = String(url);
    const payload = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : null;
    requests.push({ url: target, body: payload });
    if (target.endsWith('/state')) return hostFetch(url, init);
    saves += 1;
    if (saves === 1) await new Promise((resolve) => { gate.push(resolve); });
    if (payload.baseRevision !== hostDoc.revision) return jsonResponse({ ok: false, conflict: true, revision: hostDoc.revision, order: hostDoc.order }, 409);
    hostDoc = { schema: 1, revision: hostDoc.revision + 1, order: payload.order };
    return jsonResponse({ ok: true, revision: hostDoc.revision, order: hostDoc.order, warnings: [], issues: [], issueCount: 0 });
  };
  const store = ui.createStore({ fetchImpl: slowFetch });
  await store.load();
  store.mutate((doc) => ui.moveTopLevel(doc, 'general', 1)); // A → [models, general, plugins]
  fireOurs();                                                // 防抖到期 → 第一次保存卡在网关里
  await tick();
  eq(saves, 1, '第一次保存在途');
  store.mutate((doc) => ui.moveTopLevel(doc, 'general', 1)); // B → [models, plugins, general]
  fireOurs();                                                // 防抖到期 → 排队（inFlight）
  await tick();
  eq(ours().length, 0, '在途期间的编辑走排队而不是再起一个计时器');
  gate.forEach((resolve) => resolve());
  for (let i = 0; i < 12; i += 1) await tick();
  eq(saves, 2, '在途期间的编辑会再写一次（不是被 dirty=false 吞掉）');
  eq(hostDoc.order.map((entry) => entry.id).join(','), 'models,plugins,general', '磁盘上是最后一次编辑的结果');
  eq(store.get().dirty, false, '两次都写完了才算干净');
  store.dispose();
}

/* ── 409 时用户又改了：不能拿磁盘版本把更新的本地编辑盖掉 ── */
{
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'item', id: 'general' }, { type: 'item', id: 'models' }] };
  requests.length = 0;
  const base = timers.length;
  const ours = () => pendingTimers().filter((timer) => timers.indexOf(timer) >= base);
  const fireOurs = () => {
    const due = ours();
    if (due.length === 0) return false;
    due[0].done = true;
    due[0].fn();
    return true;
  };
  const gate = [];
  let saves = 0;
  const conflictFirst = async (url, init) => {
    const target = String(url);
    const payload = init !== undefined && init.body !== undefined ? JSON.parse(init.body) : null;
    requests.push({ url: target, body: payload });
    if (target.endsWith('/state')) return hostFetch(url, init);
    saves += 1;
    if (saves === 1) {
      await new Promise((resolve) => { gate.push(resolve); });
      // 别人在这期间把磁盘改成了 revision 9：第一次保存一定 409。
      hostDoc = { schema: 1, revision: 9, order: [{ type: 'item', id: 'account' }] };
      return jsonResponse({ ok: false, conflict: true, revision: 9, order: [{ type: 'item', id: 'account' }] }, 409);
    }
    if (payload.baseRevision !== hostDoc.revision) return jsonResponse({ ok: false, conflict: true, revision: hostDoc.revision, order: hostDoc.order }, 409);
    hostDoc = { schema: 1, revision: hostDoc.revision + 1, order: payload.order };
    return jsonResponse({ ok: true, revision: hostDoc.revision, order: hostDoc.order, warnings: [], issues: [], issueCount: 0 });
  };
  const store = ui.createStore({ fetchImpl: conflictFirst });
  await store.load();
  store.mutate((doc) => ui.moveTopLevel(doc, 'general', 1)); // A → [models, general]
  fireOurs();
  await tick();
  eq(saves, 1, '第一次保存在途');
  store.mutate((doc) => ui.moveTopLevel(doc, 'models', 1));  // B → [general, models]（比磁盘版本更新）
  fireOurs();
  await tick();
  gate.forEach((resolve) => resolve());
  for (let i = 0; i < 12; i += 1) await tick();
  eq(store.get().dirty, false, '基线挪到磁盘版本后重投，最终写成');
  eq(hostDoc.order.map((entry) => entry.id).join(','), 'general,models', '等待期间那次编辑没有被磁盘版本盖掉');
  eq(hostDoc.revision, 10, '在磁盘版本的基础上前进一格');
  store.dispose();
}

/* ── 卸载时把最后一次编辑送出去（清计时器不等于扔掉） ── */
{
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'item', id: 'general' }] };
  requests.length = 0;
  const store = ui.createStore({ fetchImpl: hostFetch });
  await store.load();
  store.mutate(() => ({ schema: 1, revision: 0, order: [{ type: 'item', id: 'general' }, { type: 'item', id: 'models' }] }));
  eq(store.get().dirty, true, '编辑后待写');
  store.dispose(); // 防抖还没到期就卸载
  await tick();
  await tick();
  eq(requests.filter((item) => item.url.endsWith('/save')).length, 1, '卸载前把这次编辑送了出去');
  eq(hostDoc.order.length, 2, '磁盘上确实有这次编辑');
}

/* ── 写失败后自己重试（不是一直卡在内存里等下次动手） ── */
{
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'item', id: 'general' }] };
  hostFailWrites = true;
  requests.length = 0;
  const base = timers.length;
  const ours = () => pendingTimers().filter((timer) => timers.indexOf(timer) >= base);
  const fireOurs = () => {
    const due = ours();
    if (due.length === 0) return false;
    due[0].done = true;
    due[0].fn();
    return true;
  };
  const store = ui.createStore({ fetchImpl: hostFetch });
  await store.load();
  store.mutate(() => ({ schema: 1, revision: 0, order: [{ type: 'item', id: 'general' }, { type: 'item', id: 'models' }] }));
  fireOurs();
  await tick();
  eq(requests.filter((item) => item.url.endsWith('/save')).length, 1, '第一次写失败');
  eq(store.get().dirty, true, '失败后仍然算脏（否则这次编辑永远不会再被写）');
  ok(store.get().error !== null, '把错误如实报出来');
  eq(ours().length >= 1, true, '失败后自己排了重试计时器');
  hostFailWrites = false;
  fireOurs();
  await tick();
  eq(store.get().dirty, false, '重试把它写成了');
  eq(hostDoc.order.length, 2, '磁盘上确有这次编辑');
  store.dispose();
}

{
  hostReachable = false;
  requests.length = 0;
  const store = ui.createStore({ fetchImpl: hostFetch });
  await store.load();
  eq(store.get().persist, 'unavailable', '读不到 host → 标记不可用');
  eq(store.get().loaded, true, '仍然算装载完成（页面可编辑）');
  store.mutate((doc) => ui.createGroup(doc));
  runTimers();
  await tick();
  eq(requests.filter((item) => item.url.endsWith('/save')).length, 0, '不可用时绝不发写请求');
  eq(store.get().doc.order.length, 1, '内存里照旧可编辑');
  hostReachable = true;
}

{
  // fetchImpl 不是函数 → 回退到运行环境里的 fetch（真实浏览器里就是全局 fetch）。
  const store = ui.createStore({ fetchImpl: null });
  await store.load();
  eq(store.get().persist, 'ok', 'fetchImpl 非函数时回退到环境 fetch（本桩里就是 hostFetch）');
}

{
  // fetch 直接抛错（不是 reject）也不能把插件炸掉。
  const store = ui.createStore({
    fetchImpl: () => {
      throw new Error('boom');
    },
  });
  await store.load();
  eq(store.get().persist, 'unavailable', 'fetch 同步抛错 → 降级为不可用而不是炸掉');
  eq(String(store.get().error).includes('boom'), true, '把异常原文留在状态里');
}

/* ══════════════════════════ 6. 导航增强器（假 DOM） ══════════════════════════ */

/** 造一台装好增强器的 store + enhancer（不经过 apply，专测 DOM 行为）。 */
async function setupNav(options = {}) {
  resetDom();
  hostDoc = { schema: 1, revision: 3, order: options.order === undefined ? [] : options.order };
  hostEnabled = options.enabled !== false;
  hostReachable = true;
  hostWarnings = [];
  const store = ui.createStore({ fetchImpl: hostFetch });
  await store.load();
  const enhancer = ui.createNavEnhancer({ store, getRows: () => currentRows });
  const uninstall = enhancer.install();
  enhancer.tick();
  return { store, enhancer, uninstall };
}

{
  const { store, enhancer, uninstall } = await setupNav();
  eq(enhancer.diag.locates, 1, '定位到导航列表');
  eq(enhancer.diag.errors, 0, '定位过程没有异常');
  deepEq(visibleRows(dom.list), NAV_LEDGER.map((row) => row.label), '空布局下左列顺序 = 出厂顺序');
  eq(ourNodes(dom.list).length, 1, '只插了工具条');
  const taskbar = ourNodes(dom.list)[0];
  eq(taskbar.getAttribute('data-dsn-own'), 'taskbar', '插入的是工具条');
  eq(taskbar.style.order, '-1000', '工具条排在最前');
  ok(taskbar.textContent.includes('整理'), '工具条上有「整理」按钮');
  eq(headersOf(dom.list).length, 0, '没有布局就没有分组标题');

  // 折叠：点标题 → 成员不显示；再点 → 回来。
  store.mutate((doc) => ui.createGroup(doc));
  const gid = store.get().doc.order[0].id;
  store.mutate((doc) => ui.moveIntoGroup(ui.moveIntoGroup(doc, 'models', gid), 'model-groups', gid));
  enhancer.tick();
  let header = headersOf(dom.list)[0];
  eq(headersOf(dom.list).length, 1, '左列出现一个分组标题');
  eq(header.name, '新分组', '标题用分组名');
  eq(header.collapsed, false, '默认展开');
  deepEq(visibleRows(dom.list), ['模型', '模型分组', '通用', '插件', '工作区常驻上下文', '用量统计'], '成员排在标题之后，其余按出厂顺序跟随');

  header.node.querySelector('button').dispatch('click', { target: header.node.querySelector('button') });
  eq(store.get().doc.order[0].collapsed, true, '点标题 → 文档里该组折叠');
  enhancer.tick();
  header = headersOf(dom.list)[0];
  eq(header.collapsed, true, '标题进入折叠态');
  eq(header.node.getAttribute('data-dsn-collapsed'), '1', '标题带折叠标记（供 CSS 转箭头）');
  deepEq(visibleRows(dom.list), ['通用', '插件', '工作区常驻上下文', '用量统计'], '收起的成员不再显示');
  eq(dom.buttons[1].style.display, 'none', '成员行是 display:none');

  header.node.querySelector('button').dispatch('click', { target: header.node.querySelector('button') });
  enhancer.tick();
  ok(visibleRows(dom.list).includes('模型'), '再点一次展开，成员回来');
  eq(dom.buttons[1].style.display, '', 'display 被清掉（回到 CSS 决定）');
  ok(enhancer.diag.toggles >= 2, '折叠交互计数');

  // 当前分节落在收起的组里：出厂壳把高亮标在行自己身上，隐藏它 = 用户不知道在哪一页。
  activeSection: {
    store.replace(ui.normalizeDoc({
      order: [
        { type: 'item', id: 'general' },
        { type: 'group', id: 'g-hidden', name: '收起的组', collapsed: true, items: ['models', 'model-groups'] },
      ],
    }));
    enhancer.tick();
    const modelsButton = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'models')];
    eq(modelsButton.style.display, 'none', '基线：收起组里的成员被隐藏');
    eq(headersOf(dom.list)[0].node.classList.contains('dsn-navheader-active'), false, '基线：没有分组被标成当前所在组');

    modelsButton.setAttribute('aria-current', 'true'); // 出厂壳切换分节时就是这么标的
    enhancer.tick();
    eq(modelsButton.style.display, '', '当前分节即使在收起的组里也保持可见（「我在哪」不会被藏掉）');
    eq(dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'model-groups')].style.display, 'none', '同组的其它成员仍然收起');
    eq(headersOf(dom.list)[0].node.classList.contains('dsn-navheader-active'), true, '包含当前分节的分组标题被标出来');
    ok(visibleRows(dom.list).includes('模型'), '当前分节出现在可见行里');

    modelsButton.removeAttribute('aria-current');
    enhancer.tick();
    eq(modelsButton.style.display, 'none', '离开这一节后，收起组里的行重新隐藏');
    eq(headersOf(dom.list)[0].node.classList.contains('dsn-navheader-active'), false, '标题标记被撤掉');
  }

  // 即时排序：同一个纯函数改文档 → tick 一帧 → 左列顺序当场变。
  store.replace(ui.normalizeDoc({ order: [{ type: 'item', id: 'usage-stats' }, { type: 'item', id: 'general' }] }));
  enhancer.tick();
  deepEq(visibleRows(dom.list), ['用量统计', '通用', '模型', '插件', '工作区常驻上下文', '模型分组'], '布局里登记的两项排在最前');
  store.mutate((doc) => ui.moveTopLevel(doc, 'usage-stats', 1));
  enhancer.tick();
  deepEq(visibleRows(dom.list).slice(0, 2), ['通用', '用量统计'], '上/下移一帧内反映到左列');
  const ranks = dom.buttons.map((button) => Number(button.style.order));
  eq(new Set(ranks).size, ranks.length, '每行的 order 互不相同');

  // 普通态（还没点「整理」）就必须能拖：整理模式只多出按钮，**不再是拖拽的开关**。
  {
    eq(dom.list.classList.contains('dsn-navlist-organizing'), false, '基线：还没进整理模式');
    store.replace(ui.normalizeDoc({ order: [
      { type: 'group', id: 'g-pre', name: '预置组', collapsed: false, items: ['models'] },
      { type: 'item', id: 'usage-stats' },
      { type: 'item', id: 'general' },
    ] }));
    enhancer.tick();
    eq(dom.buttons.every((button) => button.getAttribute('draggable') === 'true'), true, '普通态下每一行都可拖');
    eq(headersOf(dom.list).length, 1, '有分组标题可用于断言');
    eq(headersOf(dom.list)[0].node.getAttribute('draggable'), 'true', '普通态下分组标题也可拖');
    const dt = { effectAllowed: '', setData() {} };
    const from = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'usage-stats')];
    const onto = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'general')];
    from.dispatch('dragstart', { target: from, dataTransfer: dt, clientY: 0 });
    onto.dispatch('dragover', { target: onto, dataTransfer: dt, clientY: 20 });
    eq(onto.classList.contains('dsn-drop-after'), true, '普通态下 dragover 照样给出落点标记');
    onto.dispatch('drop', { target: onto, dataTransfer: dt, clientY: 20 });
    enhancer.tick();
    const ids = store.get().doc.order.filter((entry) => entry.type === 'item').map((entry) => entry.id);
    eq(ids.indexOf('usage-stats') > ids.indexOf('general'), true, '普通态下真的完成了一次排序（不点「整理」也能拖）');
    eq(onto.classList.contains('dsn-drop-after'), false, '落点标记被清掉');
  }

  // 整理模式：行保持在可拖拽，工具条多出按钮。
  const organizeButton = taskbar.children.find((node) => node.getAttribute('data-dsn-act') === 'organize');
  dom.list.dispatch('click', { target: organizeButton });
  enhancer.tick();
  eq(dom.buttons[0].getAttribute('draggable'), 'true', '整理模式下行可拖拽');
  ok(dom.list.classList.contains('dsn-navlist-organizing'), '列表打上整理态类名');
  ok(taskbar.textContent.includes('完成'), '工具条换成「完成」');
  ok(taskbar.textContent.includes('新建分组'), '整理模式多出「新建分组」');

  // 拖一个独立项进分组。
  store.replace(ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g-model', name: '模型组', collapsed: false, items: ['models', 'model-groups'] },
      { type: 'item', id: 'general' },
    ],
  }));
  enhancer.tick();
  const dataTransfer = { effectAllowed: '', setData() {} };
  const general = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'general')];
  const models = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'models')];
  general.dispatch('dragstart', { target: general, dataTransfer, clientY: 0 });
  models.dispatch('dragover', { target: models, dataTransfer, clientY: 20 });
  ok(models.classList.contains('dsn-drop-after'), '拖到下半区 → 显示「放到后面」标记');
  models.dispatch('drop', { target: models, dataTransfer, clientY: 20 });
  enhancer.tick();
  const group = store.get().doc.order.find((entry) => entry.type === 'group' && entry.id === 'g-model');
  deepEq(group.items, ['models', 'general', 'model-groups'], '拖放把「通用」插进分组（落在目标行之后）');
  eq(store.get().doc.order.some((entry) => entry.type === 'item' && entry.id === 'general'), false, '它不再是独立项');
  ok(enhancer.diag.drops >= 1, '拖放计数');
  eq(models.classList.contains('dsn-drop-after'), false, '落点标记被清掉');
  eq(headersOf(dom.list).find((item) => item.gid === 'g-model').node.getAttribute('draggable'), 'true', '标题也可拖拽');

  // 拖动整个分组标题。
  store.replace(ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g-model', name: '模型组', collapsed: false, items: ['models'] },
      { type: 'group', id: 'g-sess', name: '会话组', collapsed: false, items: ['usage-stats'] },
      { type: 'item', id: 'general' },
    ],
  }));
  enhancer.tick();
  const headerModel = headersOf(dom.list).find((item) => item.gid === 'g-model').node;
  const headerSess = headersOf(dom.list).find((item) => item.gid === 'g-sess').node;
  headerModel.dispatch('dragstart', { target: headerModel, dataTransfer, clientY: 0 });
  headerSess.dispatch('dragover', { target: headerSess, dataTransfer, clientY: 20 });
  headerSess.dispatch('drop', { target: headerSess, dataTransfer, clientY: 20 });
  enhancer.tick();
  deepEq(store.get().doc.order.map((entry) => entry.id), ['g-sess', 'g-model', 'general'], '整组被拖到另一组之后');
  deepEq(store.get().doc.order.filter((entry) => entry.type === 'group').map((entry) => entry.id), headersOf(dom.list).map((item) => item.gid), '左列标题顺序与文档一致');

  // ── 嵌套分组在左列上的真实行为（v4）──
  store.replace(ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g-top', name: '顶层组', collapsed: false, items: [
        'models',
        { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins'] },
      ] },
      { type: 'item', id: 'general' },
    ],
  }));
  enhancer.tick();
  {
    const headers = headersOf(dom.list);
    eq(headers.length, 2, '子分组也有自己的标题');
    const top = headers.find((item) => item.gid === 'g-top');
    const inner = headers.find((item) => item.gid === 'g-in');
    eq(top.order < inner.order, true, '子分组标题排在顶层组之后、成员穿插其间（深度优先）');
    eq(Number(top.node.getAttribute('data-dsn-depth')), 0, '顶层标题带深度 0');
    eq(Number(inner.node.getAttribute('data-dsn-depth')), 1, '子分组标题带深度 1');
    eq(top.node.style.paddingLeft, '12px', '顶层标题缩进 12px');
    eq(inner.node.style.paddingLeft, '22px', '子分组标题多缩进一级（12 + 1×10）');
    const modelsBtn = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'models')];
    const pluginsBtn = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'plugins')];
    const generalBtn = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'general')];
    eq(modelsBtn.style.marginLeft, '22px', '顶层组成员右移一级');
    eq(pluginsBtn.style.marginLeft, '32px', '子组成员右移两级');
    eq(generalBtn.style.marginLeft, '', '独立项不缩进');

    // 父组收起：整棵子树（含子分组标题）都藏。
    dom.list.dispatch('click', { target: top.node.querySelector('button') });
    enhancer.tick();
    eq(modelsBtn.style.display, 'none', '父组收起 → 直接成员隐藏');
    eq(pluginsBtn.style.display, 'none', '父组收起 → 子组里的成员也隐藏');
    eq(inner.node.style.display, 'none', '父组收起 → 子分组标题本身也隐藏');
    eq(generalBtn.style.display, '', '组外的独立项不受影响');
    // 只收子组：父组其它成员照旧。
    dom.list.dispatch('click', { target: top.node.querySelector('button') });
    enhancer.tick();
    dom.list.dispatch('click', { target: inner.node.querySelector('button') });
    enhancer.tick();
    eq(modelsBtn.style.display, '', '收子组不影响父组的其它成员');
    eq(pluginsBtn.style.display, 'none', '子组自己的成员隐藏');
    eq(inner.node.style.display, '', '子组标题自己不隐藏（只是收起）');
    dom.list.dispatch('click', { target: inner.node.querySelector('button') });
    enhancer.tick();

    // 分组标题三段落点：中段 = 放进这一组（标记是描边类）。
    headerSess: {
      store.replace(ui.normalizeDoc({
        order: [
          { type: 'group', id: 'g-top', name: '顶层组', collapsed: false, items: [
            { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins'] },
          ] },
          { type: 'group', id: 'g-out', name: '外部组', collapsed: false, items: ['models'] },
        ],
      }));
      enhancer.tick();
      const out = headersOf(dom.list).find((item) => item.gid === 'g-out').node;
      generalBtn.dispatch('dragstart', { target: generalBtn, dataTransfer, clientY: 0 });
      out.rect = { top: 0, left: 0, width: 200, height: 28 }; // clientY=14 → 中段
      out.dispatch('dragover', { target: out, dataTransfer, clientY: 14 });
      eq(out.classList.contains('dsn-drop-into'), true, '标题中段拖放给出「放进这一组」的描边标记');
      out.dispatch('drop', { target: out, dataTransfer, clientY: 14 });
      enhancer.tick();
      const outGroup = store.get().doc.order.find((entry) => entry.id === 'g-out');
      deepEq(outGroup.items, ['models', 'general'], '中段落下 → 追加成该组最后一个成员');
      eq(outGroup.collapsed, false, '该组保持展开');
      // 下段 = 落到它后面；上段 = 落到它前面（与旧行为一致，只是分段变细）。
      generalBtn.dispatch('dragstart', { target: generalBtn, dataTransfer, clientY: 0 });
      out.rect = { top: 0, left: 0, width: 200, height: 28 };
      out.dispatch('dragover', { target: out, dataTransfer, clientY: 27 }); // 27/28 > 0.7 → after
      eq(out.classList.contains('dsn-drop-after'), true, '标题下段仍是「放到后面」');
      out.classList.remove('dsn-drop-after');
      out.classList.remove('dsn-drop-into');
    }

    // 落进一个**已收起**的组：自动展开，不让刚放进去的东西立刻消失。
    intoCollapsed: {
      store.replace(ui.normalizeDoc({
        order: [
          { type: 'group', id: 'g-shut', name: '收着的组', collapsed: true, items: [] },
          { type: 'item', id: 'general' },
        ],
      }));
      enhancer.tick();
      const shut = headersOf(dom.list).find((item) => item.gid === 'g-shut').node;
      eq(shut.getAttribute('data-dsn-collapsed'), '1', '基线：组确实是收起的');
      generalBtn.dispatch('dragstart', { target: generalBtn, dataTransfer, clientY: 0 });
      shut.rect = { top: 0, left: 0, width: 200, height: 28 };
      shut.dispatch('dragover', { target: shut, dataTransfer, clientY: 14 });
      shut.dispatch('drop', { target: shut, dataTransfer, clientY: 14 });
      enhancer.tick();
      const shutGroup = store.get().doc.order.find((entry) => entry.id === 'g-shut');
      deepEq(shutGroup.items, ['general'], '收起的组也能收进新成员');
      eq(shutGroup.collapsed, false, '落进去后自动展开');
      eq(generalBtn.style.display, '', '新成员立刻可见');
    }

    // 分组拖进自己的后代：空操作（成环拒绝在左列也成立）。
    cycleRail: {
      store.replace(ui.normalizeDoc({
        order: [
          { type: 'group', id: 'g-top', name: '顶层组', collapsed: false, items: [
            { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins'] },
          ] },
        ],
      }));
      enhancer.tick();
      const before = JSON.stringify(ui.normalizeDoc(store.get().doc).order);
      const topNode = headersOf(dom.list).find((item) => item.gid === 'g-top').node;
      const innerNode = headersOf(dom.list).find((item) => item.gid === 'g-in').node;
      topNode.dispatch('dragstart', { target: topNode, dataTransfer, clientY: 0 });
      innerNode.rect = { top: 0, left: 0, width: 200, height: 28 };
      innerNode.dispatch('dragover', { target: innerNode, dataTransfer, clientY: 14 });
      innerNode.dispatch('drop', { target: innerNode, dataTransfer, clientY: 14 });
      enhancer.tick();
      eq(JSON.stringify(ui.normalizeDoc(store.get().doc).order), before, '父组拖进自己的子组 → 文档原样（成环拒绝）');
    }

    // 拆卸后层级缩进的内联样式也被还原。
    store.replace(ui.normalizeDoc({ order: [{ type: 'item', id: 'general' }] }));
    enhancer.tick();
  }

  // 账本顺序变了（插件改了自己的 order）+ 出厂壳把行按钮重排 → 映射与视觉顺序都要跟对。
  ledgerShift: {
    store.replace(ui.normalizeDoc({
      order: [
        { type: 'group', id: 'g-a', name: '组 A', collapsed: false, items: ['plugins'] },
        { type: 'item', id: 'general' },
      ],
    }));
    enhancer.tick();
    const mismatchBefore = enhancer.diag.mismatch;
    // 新账本：只把「插件」的 order 从 15 挪到 30（其余不变）。
    currentRows = ledgerRows
      .map((row) => (row.id === 'plugins' ? Object.assign({}, row, { order: 30 }) : row))
      .sort((left, right) => left.order - right.order);
    const newLabels = currentRows.map((row) => row.label);
    deepEq(newLabels, ['通用', '模型', '工作区常驻上下文', '模型分组', '插件', '用量统计'], '新账本顺序');
    reorderNav(newLabels);
    enhancer.tick();
    eq(enhancer.diag.mismatch, mismatchBefore, '位置对应仍然成立（标签逐位一致），没有触发失配兜底');
    deepEq(visibleRows(dom.list), ['插件', '通用', '模型', '工作区常驻上下文', '模型分组', '用量统计'], '重排后按新账本重新rank，且分组仍在最前');
    // 独立重算一份计划，逐行核对内联 order 恰好等于计划里的 rank×10（不是「看起来对」）。
    const expectOrder = new Map(
      ui.computePlan(store.get().doc, currentRows)
        .entries.filter((entry) => entry.kind === 'item')
        .map((entry) => [entry.id, entry.rank * 10]),
    );
    eq(
      dom.buttons.every((button, index) => Number(button.style.order) === expectOrder.get(currentRows[index].id)),
      true,
      '每一行的内联 order 恰好等于新计划里的 rank×10（没有残留上一次的样式）',
    );
    deepEq(dom.buttons.map((button) => button.textContent), newLabels, 'DOM 里的按钮顺序 = 新账本顺序');
    resetDom();
    enhancer.tick();
  }

  // 左列滚动：出厂 `.VOzbGW_navList` **本来就带 `overflow-y:auto`**，`nav` 又是面板里
  // `align-items:stretch` 的行向 flex 子项（高度拉伸到面板的确定高度），flex 项的自动最小
  // 尺寸是 0 —— 出厂就滚得动，末行永远够得着。所以**不该**去接管 overflow/flex。
  // （早先那版接管了，前提来自一次被管道截断的 grep，是错的。）
  navScroll: {
    // 口径：只断言「不是我们设的值」，不硬编码 ''/undefined——上一个用例 detach 时可能留下 ''。
    ok(dom.list.style.overflowY !== 'auto', '不接管列表的 overflow-y（出厂本来就是 auto）');
    ok(dom.list.style.overflowX !== 'hidden', '不接管 overflow-x');
    ok(dom.list.style.flex !== '1 1 auto', '不接管列表的 flex');
    ok(dom.list.style.minHeight !== '0', '不接管列表的 min-height');
    ok(dom.nav.style.minHeight !== '0', '不动 nav 的 min-height');
    eq(dom.list.style.paddingBottom, '12px', '只补底部留白：滚到底时末行不贴面板底边');

  }

  // 真正要补的是**吸顶标题**：出厂没有 sticky，列表一滚就分不清「现在在哪一组」。
  // （样式节点由 apply 注入，所以这几条放在 apply 那个块里断言。）

  // 钉住前提：出厂 `.navList` 自带 overflow-y:auto。哪天 DSH 升级把它拿掉，这里会失败，
  // 提醒接手的人重新考虑「要不要接管滚动」——而不是又靠猜。
  {
    const shipped = findShippedSettingsCss();
    if (shipped === null) {
      ok(true, '（跳过）安装树里没找到出厂设置壳，无法核对 navList 的 overflow 前提');
    } else {
      const rule = (shipped.text.match(/\.VOzbGW_navList\{[^}]*\}/) || [''])[0];
      ok(rule !== '', '找到出厂的 .navList 规则');
      ok(/overflow-y:\s*auto/.test(rule), '前提成立：出厂 .navList 自带 overflow-y:auto（所以不需要我们接管）');
      ok(/display:\s*flex/.test(rule), '出厂 .navList 是 flex 列（行间靠 gap:4px）');
    }
  }

  // 卸载：我们插的节点全摘、行上的内联样式清掉。
  // 先造一份**真实的**拖放残留：dragstart 加了类，而这次故意不补 dragend（真实场景就是
  // 拖到一半面板被关掉）。不先确认残留存在，下面那条「卸载时擦掉」就是句空话。
  const residualSource = dom.buttons[NAV_LEDGER.findIndex((row) => row.id === 'models')];
  residualSource.dispatch('dragstart', { target: residualSource, dataTransfer: { effectAllowed: '', setData() {} }, clientY: 0 });
  eq(residualSource.classList.contains('dsn-navdragging'), true, '基线：拖放残留确实挂上了（否则下面的断言没意义）');

  const disconnectBefore = observerDisconnects;
  uninstall();
  eq(observerDisconnects, disconnectBefore + 1, '卸载时断开 MutationObserver');
  eq(ourNodes(dom.list).length, 0, '卸载后我们插的节点全没了');
  eq(dom.buttons.every((button) => button.style.order === '' && button.style.display === '' && button.getAttribute('draggable') === null), true, '卸载后行上的内联样式（置空而非留值）与 draggable 清干净');
  eq(dom.list.classList.contains('dsn-navlist-organizing'), false, '卸载后整理态类名也被摘掉');
  ok(dom.list.style.overflowY !== 'auto', '卸载后列表的 overflow-y 不是我们设的值（本来就没接管）');
  eq(dom.list.style.paddingBottom, '', '卸载后列表的 padding-bottom 还原（置空而非留值）');
  ok(dom.nav.style.minHeight !== '0', '卸载后 nav 的 min-height 不是我们设的值');
  eq(dom.buttons.filter((button) => button.classList.contains('dsn-navdragging')).length, 0, '卸载时把拖拽残留类名擦掉（dragend 不会再来）');
  eq(headersOf(dom.list).length, 0, '标题节点已全摘');
  eq(dom.list.listeners.get('click').length, 0, '卸载后 click 监听全摘（不摘的话下一个用例会叠加一套）');
  eq(dom.list.listeners.get('drop').length, 0, '卸载后 drop 监听全摘');
}

{
  // enabled=false：左列一字不改。
  const { enhancer, store, uninstall } = await setupNav({ enabled: false });
  enhancer.tick();
  eq(ourNodes(dom.list).length, 0, '禁用时不插任何节点');
  eq(dom.buttons.every((button) => button.style.order === undefined), true, '禁用时不设 order');
  // 用「不等于被接管后的值」而不是「等于 undefined」：此前用例 detach 后会把样式置为 ''，
  // 硬编码 undefined 会因残留而误报；这里只关心「禁用态没有接管」这一件事。
  ok(dom.list.style.overflowY !== 'auto', '禁用时不接管滚动（「一字不改」包括 overflow/flex）');
  ok(dom.list.style.flex !== '1 1 auto', '禁用时不改 flex');
  ok(dom.nav.style.minHeight !== '0', '禁用时不改 nav 的 min-height');
  store.mutate((doc) => ui.createGroup(doc));
  enhancer.tick();
  eq(ourNodes(dom.list).length, 0, '禁用状态下改布局也不碰左列');
  uninstall();
}

{
  // detach() 之后重新定位到**同一个**元素（enabled false→true 就是这条路）时，监听不能叠加：
  // 叠加了就会「点一下分组标题被处理两次」——收起又被展开，用户看到的是点了没反应。
  const { enhancer, store, uninstall } = await setupNav();
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'group', id: 'g-x', name: 'X', collapsed: false, items: ['models'] }] };
  await store.load();
  enhancer.tick();
  const toggleButton = () => dom.list.children.find((node) => node.getAttribute('data-dsn-own') === 'header').querySelector('button');
  // 用「本块自己挂上后的基线」而不是硬编码 1：这样断言精确指向「一趟 detach→重定位有没有叠加」，
  // 不受此前用例残留影响；真正的「残留」由上面卸载用例的 0 断言负责。
  const boundClick = dom.list.listeners.get('click').length;
  const boundDrop = dom.list.listeners.get('drop').length;
  eq(boundClick >= 1, true, '本块的 click 监听已挂上');

  // 关掉再打开：apply → detach（摘监听 + navList=null）→ 下一次 tick 重新定位同一元素。
  hostEnabled = false;
  await store.load();
  enhancer.tick();
  eq(ourNodes(dom.list).length, 0, '禁用后自插节点撤走');
  hostEnabled = true;
  await store.load();
  enhancer.tick();
  eq(dom.list.listeners.get('click').length, boundClick, 'detach → 重定位同一元素后 click 监听没有叠加');
  eq(dom.list.listeners.get('drop').length, boundDrop, 'drop 监听没有叠加');

  const clicks = enhancer.diag.toggles;
  const collapsedBefore = store.get().doc.order.find((entry) => entry.id === 'g-x').collapsed;
  const button = toggleButton();
  button.dispatch('click', { target: button });
  eq(enhancer.diag.toggles, clicks + 1, '一次点击只被处理一次（监听没叠加）');
  eq(store.get().doc.order.find((entry) => entry.id === 'g-x').collapsed, collapsedBefore !== true, '折叠状态恰好翻转一次');
  uninstall();
}

{
  // 拆卸时已经排在外面那一帧，不能把增强器复活：面板开着时卸载/重载插件就是这条路。
  const base = timers.length;
  const ours = () => pendingTimers().filter((timer) => timers.indexOf(timer) >= base);
  const { enhancer, store, uninstall } = await setupNav();
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'group', id: 'g-x', name: 'X', collapsed: false, items: ['models'] }] };
  await store.load();
  enhancer.tick();
  ok(ourNodes(dom.list).length > 0, '基线：插了我们的节点');
  eq(ours().length >= 1, true, 'install 排了一帧在外面');
  uninstall();
  eq(ours().length, 0, '拆卸时把那一帧取消了');
  eq(ourNodes(dom.list).length, 0, '节点都撤了');
  runTimers();
  eq(ourNodes(dom.list).length, 0, '放行残留的帧也没把节点插回来');
  eq(dom.list.listeners.get('click').length, 0, '也没把监听挂回去');
  const locates = enhancer.diag.locates;
  enhancer.tick(); // 直接模拟「拆卸之后才轮到的 tick」
  eq(enhancer.diag.locates, locates, '拆卸后的 tick 直接返回，不重新定位');
  eq(ourNodes(dom.list).length, 0, '也没有插回节点');
  eq(dom.list.listeners.get('click').length, 0, '也没有挂回监听');
}

{
  // 切语言：账本、文档、revision 都没变，只有 t() 的结果变了 —— 语言必须进计划签名，
  // 否则分组计数和工具条会一直停在旧语言，直到用户碰一下布局。
  const { enhancer, store, uninstall } = await setupNav();
  hostDoc = { schema: 1, revision: 3, order: [{ type: 'group', id: 'g-x', name: 'X', collapsed: false, items: ['models'] }] };
  await store.load();
  enhancer.tick();
  const taskbar = () => ourNodes(dom.list).find((node) => node.getAttribute('data-dsn-own') === 'taskbar');
  const countText = () => headersOf(dom.list)[0].node.querySelector('.dsn-navheader-count').textContent;
  const zhOrganize = ui.t('organize');
  const zhEntries = ui.t('entries');
  ok(taskbar().textContent.includes(zhOrganize), '基线：工具条是中文');
  ok(countText().includes(zhEntries), '基线：分组计数是中文');

  const appliesBefore = enhancer.diag.applies;
  ui.setLocale('en');
  const enOrganize = ui.t('organize');
  const enEntries = ui.t('entries');
  ok(enOrganize !== zhOrganize, '英中文案确实不同（否则这条测不出东西）');
  enhancer.tick();
  ok(taskbar().textContent.includes(enOrganize), '切英文后工具条文案跟着变');
  ok(countText().includes(enEntries), '切英文后分组计数跟着变');
  ok(enhancer.diag.applies > appliesBefore, '语言变化触发了重刷');

  ui.setLocale('zh');
  enhancer.tick();
  ok(taskbar().textContent.includes(zhOrganize), '切回中文也生效');
  eq(store.get().doc.order.length, 1, '整个过程文档没被动过');
  uninstall();
}

{
  // 账本里有、文档里没提到的设置项**确实画在左列上**（computePlan 当未分组项追加），
  // 所以它必须是有效落点；否则拖到它身上会静默不动，用户以为拖放坏了。
  const { enhancer, store, uninstall } = await setupNav();
  store.replace(ui.normalizeDoc({
    order: [
      { type: 'group', id: 'g-x', name: 'X', collapsed: false, items: ['models'] },
      { type: 'item', id: 'general' },
      { type: 'item', id: 'plugins' },
    ],
  }));
  enhancer.tick();
  const indexOf = (id) => currentRows.findIndex((row) => row.id === id);
  const implicit = dom.buttons[indexOf('usage-stats')];
  const general = dom.buttons[indexOf('general')];
  const inDoc = (id) => store.get().doc.order.some((entry) => entry.id === id || (entry.items || []).indexOf(id) >= 0);
  eq(inDoc('usage-stats'), false, '基线：usage-stats 不在文档里');
  ok(visibleRows(dom.list).includes('用量统计'), '但它确实是可见的一行');

  const taskbar = ourNodes(dom.list).find((node) => node.getAttribute('data-dsn-own') === 'taskbar');
  const organizeButton = taskbar.children.find((node) => node.getAttribute('data-dsn-act') === 'organize');
  dom.list.dispatch('click', { target: organizeButton });
  enhancer.tick();
  const dataTransfer = { effectAllowed: '', setData() {} };
  general.dispatch('dragstart', { target: general, dataTransfer, clientY: 0 });
  implicit.dispatch('dragover', { target: implicit, dataTransfer, clientY: 20 });
  implicit.dispatch('drop', { target: implicit, dataTransfer, clientY: 20 });
  enhancer.tick();
  deepEq(store.get().doc.order.map((entry) => entry.id), ['g-x', 'plugins', 'general'], '拖到隐式行上真的动了（被拖项落到末尾，不是静默不动）');
  uninstall();
}

{
  // 定位不到导航：静默，不抛；面板重开后重新定位。
  const { enhancer, uninstall } = await setupNav();
  const locatesBefore = enhancer.diag.locates;
  dialogs.length = 0;
  body.removeChild(dom.dialog);
  pokeDom();
  runTimers();
  enhancer.tick();
  eq(enhancer.diag.errors, 0, '导航消失后重定位失败但不抛错');
  body.appendChild(dom.dialog);
  dialogs.push(dom.dialog);
  pokeDom();
  runTimers();
  enhancer.tick();
  eq(enhancer.diag.locates, locatesBefore + 1, '面板重开后重新定位');
  uninstall();
}

/* ══════════════════════════ 7. apply：装配契约 ══════════════════════════ */

const registered = [];
const effectLabels = [];
const slotListeners = [];

const fakeCtx = {
  effect(fn, label) {
    effectLabels.push(label);
    const disposer = fn();
    return () => (typeof disposer === 'function' ? disposer() : undefined);
  },
  get(key) {
    if (key === 'locale') {
      return {
        getSnapshot: () => ({ active: 'zh', locales: ['zh', 'en'], revision: 1 }),
        subscribe: () => () => {},
      };
    }
    return undefined;
  },
  slots: {
    inject(slotName, callback) {
      registered.push({ slotName, viaInject: true });
      return callback();
    },
    register(spec, component) {
      registered.push({ spec, component });
      return () => {};
    },
    entries(key) {
      return key === 'settings.section' ? NAV_LEDGER.map((row) => ({ options: { id: row.id, order: row.order, label: row.label } })) : [];
    },
    subscribe(key, listener) {
      slotListeners.push({ key, listener });
      return () => {};
    },
  },
};

{
  // 账本投影（与出厂壳同口径）。
  eq(ui.ledgerRows(fakeCtx).length, 6, '账本投影出行');
  eq(ui.ledgerRows(fakeCtx)[0].id, 'general', '账本按 order 排序');
  eq(ui.ledgerRows({ slots: {} }).length, 0, '没有 entries 面 → 空账本（静默降级）');
  const withThunk = { slots: { entries: () => [
    { options: { id: 'a', order: 2, label: () => 'X' } },
    { options: { id: 'b', order: 1, label: 'Y' } },
    { options: { order: 0 } },
  ] } };
  deepEq(ui.ledgerRows(withThunk).map((row) => row.id), ['b', 'a'], 'thunk 标签被求值，缺 id 的行被丢弃');
  eq(ui.ledgerRows(withThunk)[0].label, 'Y', '标签取到');
}

resetDom();
hostDoc = { schema: 1, revision: 3, order: [] };
hostEnabled = true;
hostReachable = true;
hostWarnings = [];
requests.length = 0;

exports_.apply(fakeCtx);

{
  eq(styleNodes.length, 1, '注入一个 <style>');
  eq(styleNodes[0].dataset.plugin, 'dsh-settings-nav', '样式节点带插件标记');
  ok(styleNodes[0].textContent.includes('.dsn-root'), '样式含页面类名');
  ok(styleNodes[0].textContent.includes('.dsn-navheader'), '样式含左列分组标题类名');
  {
    const stickyRule = (styleNodes[0].textContent.match(/\.dsn-navheader \{[^}]*\}/) || [''])[0];
    ok(/position:\s*sticky/.test(stickyRule), '分组标题是 sticky（左列滚起来也知道在哪一组）');
    ok(/top:\s*0/.test(stickyRule), 'sticky 贴顶');
    ok(/background:\s*var\(--dsw-alias-bg-layer-2\)/.test(stickyRule), '用面板同色背景挡住滚过去的行');
    ok(/padding:\s*6px 12px 0/.test(stickyRule), '6px 间隔做在 padding 里（margin 会露出看见行滚过去的缝）');
    ok(!/margin-top/.test(stickyRule), 'sticky 盒子上不放 margin-top');
  }
  ok(effectLabels.some((label) => label.includes('page css')), '样式卸载挂在 effect 上');
  ok(effectLabels.some((label) => label.includes('nav enhancer')), '增强器挂载在 effect 上');
  ok(effectLabels.some((label) => label.includes('state → nav')), '状态变化驱动导航重刷');
  ok(effectLabels.some((label) => label.includes('ledger → nav')), '账本变化驱动导航重刷');
  ok(effectLabels.some((label) => label.includes('flush on hide')), '切后台 / 关页面时冲刷挂起写');

  ok(registered.some((item) => item.slotName === 'settings.section' && item.viaInject === true), '用 slots.inject 声明依赖');
  const registration = registered.find((item) => item.spec !== undefined);
  eq(registration.spec.name, 'settings.section', '槽位名');
  eq(registration.spec.id, 'settings-nav', '槽位 id');
  eq(registration.spec.order, ui.SECTION_ORDER, '槽位顺序');
  eq(registration.spec.label(), '设置导航', '槽位标签（thunk，跟语言变）');
  eq(typeof registration.component, 'function', '注册的是组件');
  const element = registration.component({ close() {} });
  eq(element.type, ui.Page, '注册的是管理页组件本身');
  ok(element.props.store !== undefined, '注册时把状态仓注进去（页面与左列共用同一份真相）');
  eq(typeof element.props.getRows, 'function', '注册时注入账本读取函数');
  ok(element.props.enhancerDiag !== undefined, '注册时注入增强器诊断');
  eq(slotListeners.length, 1, '订阅了账本变化');

  await tick();
  await tick();
  ok(requests.some((item) => item.url.endsWith('/state')), 'apply 后自动拉一次 host 状态');
  // install() 只排了一帧（rAF / 16ms 回退），到这里才真正跑定位。
  runTimers();
  await tick();

  const active = ui.active();
  ok(active !== null, 'apply 暴露当前实例（供自测 / 排障）');
  ok(active.store !== undefined && active.enhancer !== undefined, '实例里有 store 与 enhancer');
  eq(active.enhancer.diag.locates >= 1, true, '实例的增强器已定位导航');

  ui.setLocale('en');
  eq(registration.spec.label(), 'Settings nav', '英文标签');
  eq(ui.t('navLabel'), 'Settings nav', '英文文案');
  ui.setLocale('zh');
  eq(registration.spec.label(), '设置导航', '切回中文');
}

/* ══════════════════════════ 8. 管理页组件 ══════════════════════════ */

{
  const registration = registered.find((item) => item.spec !== undefined);
  const { store, enhancer } = ui.active();

  let tree = null;
  const effectCleanups = [];
  function renderPage() {
    cursor = 0;
    pendingEffects = [];
    rerenderRequested = false;
    tree = ui.Page({ store, getRows: () => ledgerRows, enhancerDiag: enhancer.diag, close() {} });
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
    }
    return tree;
  }
  async function settle() {
    for (let round = 0; round < 12; round += 1) {
      await tick();
      if (!rerenderRequested) {
        await tick();
        if (!rerenderRequested) return;
      }
      renderPage();
    }
  }
  const findAll = (predicate) => nodesOf(tree).filter(predicate);
  const findButton = (label) => findAll((node) => node.type === 'button' && textOf(node) === label)[0];
  const bodyText = () => textOf(tree);

  hostDoc = {
    schema: 1,
    revision: 5,
    order: [
      { type: 'item', id: 'general' },
      { type: 'group', id: 'g-model', name: '模型与路由', collapsed: false, items: ['models', 'model-groups'] },
      { type: 'item', id: 'ghost-plugin' },
    ],
  };
  hostWarnings = ['order[3] 的 type「wat」未知，已丢弃'];
  await store.load();
  enhancer.tick();
  renderPage();
  await settle();

  const first = bodyText();
  ok(first.includes('设置导航分组收纳'), '页面标题');
  ok(first.includes('/home/u/.dsh/settings-nav.json'), '显示落盘路径');
  ok(first.includes('模型与路由'), '列出已有分组');
  ok(first.includes('通用'), '列出独立项');
  ok(first.includes('失联项'), '有失联项区块');
  ok(first.includes('ghost-plugin'), '失联项内容');
  ok(first.includes('wat'), '把 host 的告警显示出来');
  ok(first.includes('导航增强'), '诊断里显示左列增强状态');
  ok(first.includes('未分组（还在出厂位置）'), '有未分组区块');
  ok(first.includes('插件'), '未分组池里有「插件」');
  eq(store.get().doc.order.length, 3, '页面不改文档（渲染本身没有副作用）');

  // ① 新建分组 → 左列立刻多一个标题（**即时生效**）。
  const headersBefore = headersOf(dom.list).length;
  findButton('＋ 新建分组').props.onClick();
  await settle();
  enhancer.tick();
  eq(store.get().doc.order.filter((entry) => entry.type === 'group').length, 2, '点一下 → 文档多一个分组');
  eq(headersOf(dom.list).length, headersBefore + 1, '左列立刻多出一个分组标题');

  // ② 重命名。
  findAll((node) => node.type === 'button' && textOf(node) === '重命名')[0].props.onClick();
  await settle();
  const input = findAll((node) => node.type === 'input')[0];
  ok(input !== undefined, '出现重命名输入框');
  input.props.onChange({ target: { value: '我的分组' } });
  await settle();
  findButton('保存').props.onClick();
  await settle();
  enhancer.tick();
  ok(store.get().doc.order.some((entry) => entry.type === 'group' && entry.name === '我的分组'), '改名写入文档');
  ok(headersOf(dom.list).some((header) => header.name === '我的分组'), '左列标题跟着改名');

  // ③ 加入分组（下拉）。
  const selects = findAll((node) => node.type === 'select');
  ok(selects.length >= 1, '有「加入分组…」下拉');
  selects[0].props.onChange({ target: { value: 'g-model' } });
  await settle();
  enhancer.tick();
  ok(store.get().doc.order.find((entry) => entry.id === 'g-model').items.includes('general'), '下拉把首个未分组项加进「模型与路由」');

  // ④ 上下移动（即时排序）。用一份两个「会渲染出来的」独立项的布局，避免测到孤儿项。
  store.replace(ui.normalizeDoc({ order: [
    { type: 'item', id: 'usage-stats' },
    { type: 'item', id: 'general' },
    { type: 'group', id: 'g-x', name: 'X', collapsed: false, items: ['models'] },
  ] }));
  await settle();
  enhancer.tick();
  deepEq(visibleRows(dom.list), ['用量统计', '通用', '模型', '插件', '工作区常驻上下文', '模型分组'], '按布局顺序排列');
  findAll((node) => node.type === 'button' && textOf(node) === '↓')[0].props.onClick();
  await settle();
  enhancer.tick();
  deepEq(visibleRows(dom.list).slice(0, 2), ['通用', '用量统计'], '点「↓」后左列顺序立刻变化');

  // ⑤ 收起（页面里的那个）。
  const collapseButton = findAll((node) => node.type === 'button' && textOf(node) === '收起')[0];
  ok(collapseButton !== undefined, '页面里有「收起」按钮');
  collapseButton.props.onClick();
  await settle();
  enhancer.tick();
  ok(store.get().doc.order.some((entry) => entry.type === 'group' && entry.collapsed === true), '页面里点「收起」写入折叠态');
  eq(headersOf(dom.list).some((header) => header.collapsed === true), true, '左列同步进入折叠');

  // ⑥ 不会把设置项弄丢：移出分组。
  const countIds = () => store.get().doc.order.reduce((total, entry) => total + (entry.type === 'item' ? 1 : entry.items.length), 0);
  const beforeCount = countIds();
  findAll((node) => node.type === 'button' && textOf(node) === '移出分组')[0].props.onClick();
  await settle();
  eq(countIds(), beforeCount, '「移出分组」不丢项');

  // ⑦ 删除分组同样不丢项。
  const beforeDelete = countIds();
  findAll((node) => node.type === 'button' && textOf(node) === '删除分组')[0].props.onClick();
  await settle();
  eq(countIds(), beforeDelete, '「删除分组」不丢项（成员摊回顶层）');

  // ⑧ 预置方案 / 恢复出厂顺序。
  findButton('预置方案').props.onClick();
  await settle();
  enhancer.tick();
  ok(store.get().doc.order.filter((entry) => entry.type === 'group').length >= 2, '预置方案铺开成多个分组');
  ok(headersOf(dom.list).length >= 2, '左列立刻铺开这些分组');

  findButton('恢复出厂顺序').props.onClick();
  await settle();
  enhancer.tick();
  eq(store.get().doc.order.length, 0, '恢复出厂顺序清空布局');
  eq(headersOf(dom.list).length, 0, '左列分组标题全部消失');
  deepEq(visibleRows(dom.list), NAV_LEDGER.map((row) => row.label), '左列回到出厂顺序');

  // ⑨ 失联项清理。
  store.replace(ui.normalizeDoc({ order: [{ type: 'item', id: 'general' }, { type: 'item', id: 'ghost-plugin' }] }));
  await settle();
  findButton('清理').props.onClick();
  await settle();
  eq(store.get().doc.order.some((entry) => entry.type === 'item' && entry.id === 'ghost-plugin'), false, '「清理」移除失联项');

  // ⑩ 全部收起 / 展开。
  store.replace(ui.normalizeDoc({ order: [
    { type: 'group', id: 'g-a', name: 'A', items: ['models'] },
    { type: 'group', id: 'g-b', name: 'B', items: ['plugins'] },
  ] }));
  await settle();
  findButton('全部收起').props.onClick();
  await settle();
  eq(store.get().doc.order.every((entry) => entry.type !== 'group' || entry.collapsed === true), true, '「全部收起」');
  findButton('全部展开').props.onClick();
  await settle();
  eq(store.get().doc.order.every((entry) => entry.type !== 'group' || entry.collapsed === false), true, '「全部展开」');

  // ⑪ 页面内拖拽（React 侧）。
  store.replace(ui.normalizeDoc({ order: [{ type: 'item', id: 'general' }, { type: 'group', id: 'g-a', name: 'A', items: ['models'] }] }));
  await settle();
  const dragEntries = findAll((node) => node.type === 'div' && node.props.draggable === true && typeof node.props.onDrop === 'function');
  eq(dragEntries.length, 7, '独立项 + 分组标题 + 成员 + 未分组池的 4 项都可拖（此前未分组池一项都不可拖）');
  eq(dragEntries.filter((node) => String(node.props.key).startsWith('l:')).length, 4, '未分组池每一项都带拖拽属性');
  const transfer = { effectAllowed: '', setData() {} };
  const rect = { getBoundingClientRect: () => ({ top: 0, height: 20 }) };
  dragEntries[0].props.onDragStart({ dataTransfer: transfer });
  dragEntries[1].props.onDragOver({ preventDefault() {}, currentTarget: rect, clientY: 18 });
  dragEntries[1].props.onDrop({ preventDefault() {}, currentTarget: rect, clientY: 18 });
  await settle();
  enhancer.tick();
  deepEq(store.get().doc.order.map((entry) => entry.id), ['g-a', 'general'], '页面内拖拽把独立项落到分组之后');

  // ⑪b 未分组池 → 空分组：池里的项能拖，空分组占位条能落（此前两者都没有任何拖拽处理）。
  store.replace(ui.normalizeDoc({ order: [
    { type: 'group', id: 'g-empty', name: '空组', collapsed: false, items: [] },
    { type: 'item', id: 'general' },
  ] }));
  await settle();
  const poolItems = findAll((node) => node.type === 'div' && node.props.draggable === true && String(node.props.key).startsWith('l:'));
  ok(poolItems.length >= 1, '未分组池里有可拖的项');
  const emptySlot = findAll((node) => node.type === 'div' && node.props.key === 'g:g-empty:empty' && typeof node.props.onDrop === 'function')[0];
  ok(emptySlot !== undefined, '空分组占位条注册了落点');
  eq(emptySlot.props.draggable === undefined, true, '占位条只作落点、本身不可拖');
  const poolId = String(poolItems[0].props.key).slice(2);
  const transfer2 = { effectAllowed: '', setData() {} };
  const rect2 = { getBoundingClientRect: () => ({ top: 0, height: 20 }) };
  poolItems[0].props.onDragStart({ dataTransfer: transfer2 });
  emptySlot.props.onDragOver({ preventDefault() {}, currentTarget: rect2, clientY: 10 });
  emptySlot.props.onDrop({ preventDefault() {}, currentTarget: rect2, clientY: 10 });
  await settle();
  enhancer.tick();
  const emptied = store.get().doc.order.find((entry) => entry.id === 'g-empty');
  deepEq(emptied.items, [poolId], '拖到空分组占位条 → 成为该分组的第一个成员');
  eq(store.get().doc.order.some((entry) => entry.type === 'item' && entry.id === poolId), false, '它不再是独立项');

  // ⑪c 多级结构：子分组整棵渲染，层级用缩进表达，能现建更深一层。
  store.replace(ui.normalizeDoc({ order: [
    { type: 'group', id: 'g-top', name: '顶层', collapsed: false, items: [
      'models',
      { type: 'group', id: 'g-in', name: '子组', collapsed: false, items: ['plugins'] },
    ] },
  ] }));
  await settle();
  const topRow = findAll((node) => node.type === 'div' && node.props.key === 'g:g-top')[0];
  const inRow = findAll((node) => node.type === 'div' && node.props.key === 'g:g-in')[0];
  const memberRow = findAll((node) => node.type === 'div' && node.props.key === 'm:plugins')[0];
  ok(topRow !== undefined && inRow !== undefined && memberRow !== undefined, '子分组与它的成员都渲染出来了');
  eq(topRow.props.style.marginLeft, '0px', '顶层分组不缩进');
  eq(inRow.props.style.marginLeft, '16px', '子分组缩进一级');
  eq(memberRow.props.style.marginLeft, '32px', '子组的成员缩进两级');
  const subButton = findAll((node) => node.type === 'button' && textOf(node) === '＋ 子分组')[0];
  ok(subButton !== undefined, '分组行有「＋ 子分组」按钮');
  const groupsBefore = ui.countGroups(store.get().doc.order);
  subButton.props.onClick();
  await settle();
  eq(ui.countGroups(store.get().doc.order), groupsBefore + 1, '点一下就多了一个分组');
  eq(ui.findGroupNode(store.get().doc.order, 'g-top').items.filter((child) => ui.isGroupNode(child)).length, 2, '新分组挂在顶层组里（不是顶层）');
  eq(store.get().doc.order.length, 1, '顶层条目数不变');

  // ⑫ 持久化：防抖到点后真的写回 host。
  requests.length = 0;
  store.mutate((doc) => ui.createGroup(doc));
  runTimers();
  await tick();
  await tick();
  ok(requests.some((item) => item.url.endsWith('/save')), '页面改动最终落盘');
}

/* ══════════════════════════ 9. 降级：断网的页面 ══════════════════════════ */

{
  hostReachable = false;
  const { store, enhancer } = ui.active();
  await store.load();
  cursor = 0;
  pendingEffects = [];
  const tree = ui.Page({ store, getRows: () => ledgerRows, enhancerDiag: enhancer.diag, close() {} });
  const text = textOf(tree);
  ok(text.includes('只在当前页面有效'), '断网时页面明确提示改动不会持久化');
  ok(text.includes('不可用'), '状态行显示持久化不可用');
  hostReachable = true;
}

{
  // 注册设置项节失败（同 priority 下 id 撞车）不能拖垮整个 Web UI：`slots.inject` 会把异常
  // 直接抛到 apply 外面，出厂壳的启动审计随即抛「web boot: N entries did not activate」，
  // 整个设置界面都起不来。代价一比就清楚——宁可这一节不出现，也不能让页面挂掉。
  const colliding = Object.assign({}, fakeCtx, {
    slots: Object.assign({}, fakeCtx.slots, {
      register() {
        throw new Error('list slot "settings.section" already has an entry with id "settings-nav" at priority 6');
      },
    }),
  });
  let threw = null;
  try {
    exports_.apply(colliding);
  } catch (error) {
    threw = error;
  }
  eq(threw, null, 'apply 不再把注册冲突抛出去（抛出去 = 整个页面启动失败）');
  ok(String(ui.registrationFailure()).includes('already has an entry'), '把失败原因记下来可查');
}

console.log(`dsh-settings-nav client selftest: ${checks} 项全过`);
