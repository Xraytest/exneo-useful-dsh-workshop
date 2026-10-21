/**
 * dsh-message-branches 浏览器半边（client.js，v4）行为自测 —— 纯 node、无副作用。
 *
 * 在 node 里给 client.js 造一个**最小浏览器环境**：
 *   · global.window（setInterval/clearInterval/setTimeout/clearTimeout + __ModuleLoader__ 捕获 load）
 *   · global.document（querySelectorAll('style[data-plugin-css]')、createElement/head.appendChild/querySelector/body）
 *   · 按 URL 返回预置 JSON 并记录调用的 fetch（只认 /dsh-branches/{state,branch,select}）
 *   · 一个**极小的 hooks 运行时**（useState/useEffect/useRef/useCallback/useMemo/Fragment/createElement，
 *     带 hook 游标、按 index 复用的组件实例、依赖比较、提交后跑 effect、setState 后真的重渲染），
 *     组件因此能被当普通函数调用并支持「点一下 → 状态变 → 再渲染一次」的完整链路；
 *   · react-dom 用桩（createPortal(node, target) 原样返回并记录 target）；
 *   · require('@deepseek-ai/dsh-client-ui-primitives') 两条路径都测：返回桩 / 抛异常（降级）。
 *
 * 每个用例重新调用 __ModuleLoader__ 捕获到的 factory()，拿一份**隔离实例**
 * （模块级单例——editor/records/classesCache/primitives——都封在 factory 闭包里）。
 *
 * 硬约束：本文件只驱动 client.js，不 import host 半边（entry-v4.js），
 * 因此**不会读写 $DSH_HOME/message-branches/**（线上真实数据根）。
 *
 * **忠实环境**：全程不放 `globalThis.ctx`（出厂客户端模块由 `factory(require)` 单参调用，
 * 没有全局 ctx），也不 stub 任何出厂 CSS 类名——v1 的两个结构性缺陷正是被这两样掩盖的：
 *   ① HeaderEntry 引用未定义的自由变量 `ctx` → 渲染即抛 ReferenceError → 被出厂
 *      SlotErrorBoundary 永久除名 → 头部按钮与**唯一**的 EditorHost 一起消失
 *      ⇒「点笔 → 编辑框」点了没反应。
 *   ② 分叉的锚点永远是**我自己的消息**：v4 起入口只剩 user 键上的笔 + 消息下面的
 *      分支导航条，助手侧（turnTail）与会话头部面板一律不注册（P0 静态守卫钉住）。
 *
 * v4 覆盖重点：分支导航条的渲染/切换/乐观回滚、创建分支全链路、以及
 * **一个会话记录都不新建**（client 半边不再碰 sessions 服务）。
 *
 * 运行：node plugins/dsh-message-branches/client-selftest.mjs
 * 末行输出 CLIENT SELFTEST PASS n/n 或 CLIENT SELFTEST FAIL …，退出码 0/1。
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * 临时沙箱：整个自测只允许落在 /tmp 下由 mkdtemp 造出的目录里。
 * client 半边根本不接 stateDir（它只会 fetch /dsh-branches/*），这里显式造出来是为了
 * ① 满足「临时状态目录必须 mkdtemp 且显式传入」；
 * ② 断言它绝不出现在任何请求 URL / 渲染文本里（若哪天客户端把 host 路径透出去，这里就会红）。
 * 线上真实数据根 $DSH_HOME/message-branches 全程零接触（源码里没有 fs，也没有任何家目录字面量）。
 */
const SANDBOX_ROOT = mkdtempSync(join(tmpdir(), 'mb-client-selftest-'));
/** 全场（所有 world）发出去的 URL，供收尾用例断言「只打 /dsh-branches/」。 */
const ALL_URLS = [];

/* ══════════════════════════ 断言计数 ══════════════════════════ */

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const deepEq = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks += 1; };
const step = (label) => console.log(`· ${label}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** 排空微任务：每一轮 setImmediate 都会跑完当前所有 promise 链，16 轮足够走完「请求 → setState → effect → 再请求」。 */
async function settle() { for (let round = 0; round < 16; round += 1) await tick(); }

/* ══════════════════════════ 假 DOM ══════════════════════════ */

/** dataset 在真实浏览器里就是 data-* 属性的 camelCase 视图；桩必须走同一映射，否则 getAttribute 拿不到。 */
const kebab = (name) => String(name).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);

function makeElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    attributes: {},
    textContent: '',
    childNodes: [],
    parentNode: null,
    style: {},
    setAttribute(name, value) { element.attributes[String(name)] = String(value); },
    getAttribute(name) { return element.attributes[String(name)] ?? null; },
    appendChild(child) { element.childNodes.push(child); child.parentNode = element; return child; },
    remove() {
      if (element.parentNode === null) return;
      const at = element.parentNode.childNodes.indexOf(element);
      if (at >= 0) element.parentNode.childNodes.splice(at, 1);
      element.parentNode = null;
    },
    querySelector(selector) { return matchSelector(element.childNodes, selector)[0] ?? null; },
    querySelectorAll(selector) { return matchSelector(element.childNodes, selector); },
  };
  // dataset.pluginCss = X 必须等价于 setAttribute('data-plugin-css', X)：
  // installStyles 用前者写、自测用 style[data-plugin-css=…] 选择器读。
  const dataName = (name) => `data-${kebab(name)}`;
  element.dataset = new Proxy({}, {
    set(target, name, value) { target[name] = value; element.setAttribute(dataName(name), String(value)); return true; },
    get(target, name) { return name in target ? target[name] : element.getAttribute(dataName(name)); },
  });
  return element;
}

const SELECTOR = /^([a-zA-Z]+)\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/;
function matchSelector(nodes, selector) {
  const match = SELECTOR.exec(selector);
  if (match === null) return [];
  const [, tag, attribute, value] = match;
  const out = [];
  const visit = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.tagName === tag.toUpperCase() && node.getAttribute(attribute) === (value === undefined ? null : value)) out.push(node);
    node.childNodes.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function makeDocument() {
  const head = makeElement('head');
  const body = makeElement('body');
  return { head, body, createElement: (tag) => makeElement(tag) };
}

function makeTimers() {
  const intervals = new Map();
  const timeouts = new Set();
  let nextId = 1;
  return {
    intervals,
    timeouts,
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = nextId++; timeouts.add(id); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    /** 只跑一次轮询回调（自测里不当真等待 30s）。 */
    runIntervals() { for (const { fn } of intervals.values()) fn(); },
  };
}

/* ══════════════════════════ 极简 React ══════════════════════════ */

const Fragment = Symbol('mb.Fragment');

function flattenChildren(input, out) {
  for (const child of Array.isArray(input) ? input : [input]) {
    if (child === null || child === undefined || typeof child === 'boolean') out.push(null);
    else if (Array.isArray(child)) flattenChildren(child, out);
    else out.push(child);
  }
  return out;
}

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props === null || props === undefined ? {} : props);
  merged.children = flattenChildren(children, []); // 保留 null 占位，索引位置才与 React 的 index-key 语义一致
  return { __element: true, type, props: merged };
}

const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, at) => Object.is(value, right[at]));

let currentInstance = null;
const hookError = (name) => { throw new Error(`${name} 只能在组件渲染中调用（桩运行时）`); };

const React = {
  createElement,
  Fragment,
  useState(initial) {
    if (currentInstance === null) hookError('useState');
    const inst = currentInstance;
    const slot = inst.cursor;
    inst.cursor += 1;
    if (!(slot in inst.hooks)) inst.hooks[slot] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const current = inst.hooks[slot];
      const value = typeof next === 'function' ? next(current) : next;
      if (Object.is(value, current)) return;
      inst.hooks[slot] = value;
      inst.renderer.markDirty(inst);
    };
    return [inst.hooks[slot], set];
  },
  useRef(initial) {
    if (currentInstance === null) hookError('useRef');
    const inst = currentInstance;
    const slot = inst.cursor;
    inst.cursor += 1;
    if (!(slot in inst.hooks)) inst.hooks[slot] = { current: initial };
    return inst.hooks[slot];
  },
  useCallback(fn, deps) {
    if (currentInstance === null) hookError('useCallback');
    const inst = currentInstance;
    const slot = inst.cursor;
    inst.cursor += 1;
    const previous = inst.hooks[slot];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
    inst.hooks[slot] = { deps: Array.isArray(deps) ? deps.slice() : undefined, value: fn };
    return fn;
  },
  useMemo(fn, deps) {
    if (currentInstance === null) hookError('useMemo');
    const inst = currentInstance;
    const slot = inst.cursor;
    inst.cursor += 1;
    const previous = inst.hooks[slot];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
    const value = fn();
    inst.hooks[slot] = { deps: Array.isArray(deps) ? deps.slice() : undefined, value: fn };
    return value;
  },
  useEffect(create, deps) {
    if (currentInstance === null) hookError('useEffect');
    const inst = currentInstance;
    const slot = inst.cursor;
    inst.cursor += 1;
    const previous = inst.hooks[slot];
    const hasDeps = Array.isArray(deps);
    const unchanged = previous !== undefined && hasDeps && sameDeps(previous.deps, deps);
    if (unchanged) return;
    const record = { inst, deps: hasDeps ? deps.slice() : undefined, create, cleanup: previous === undefined ? null : previous.cleanup };
    inst.hooks[slot] = record;
    inst.renderer.pendingEffects.push(record);
  },
};

class Renderer {
  constructor() {
    this.roots = [];
    this.dirty = new Set();
    this.pendingEffects = [];
    this.flushDepth = 0;
    this.portals = [];
    this.flushes = 0;
  }

  mount(component, props) {
    const root = this.reconcile(null, createElement(component, props));
    this.roots.push(root);
    this.flush();
    return root;
  }

  renderComponent(inst) {
    if (inst.alive !== true) return;
    const previous = currentInstance;
    currentInstance = inst;
    inst.cursor = 0;
    let output;
    try {
      output = inst.type(inst.props);
    } finally {
      currentInstance = previous;
    }
    if (Array.isArray(output)) output = createElement(Fragment, null, output);
    inst.child = this.reconcile(inst.child, output === undefined ? null : output);
  }

  reconcile(node, element) {
    if (element === null || element === undefined || typeof element === 'boolean') {
      if (node !== null && node !== undefined) this.unmount(node);
      return null;
    }
    if (typeof element === 'string' || typeof element === 'number') {
      if (node !== null && node !== undefined && node.kind === 'text') { node.text = String(element); return node; }
      if (node !== null && node !== undefined) this.unmount(node);
      return { kind: 'text', text: String(element) };
    }
    if (Array.isArray(element)) return this.reconcile(node, createElement(Fragment, null, element));
    if (element.type === Fragment) {
      let target = node;
      if (target === null || target === undefined || target.kind !== 'fragment') {
        if (target !== null && target !== undefined) this.unmount(target);
        target = { kind: 'fragment', children: [] };
      }
      target.children = this.reconcileList(target.children, element.props.children);
      return target;
    }
    if (typeof element.type === 'function') {
      let target = node;
      if (target === null || target === undefined || target.kind !== 'component' || target.type !== element.type) {
        if (target !== null && target !== undefined) this.unmount(target);
        target = { kind: 'component', type: element.type, props: {}, hooks: [], cursor: 0, child: null, alive: true, renderer: this };
      }
      target.props = element.props;
      this.renderComponent(target);
      return target;
    }
    let target = node;
    if (target === null || target === undefined || target.kind !== 'host' || target.tag !== element.type) {
      if (target !== null && target !== undefined) this.unmount(target);
      target = { kind: 'host', tag: element.type, props: {}, children: [] };
    }
    target.props = element.props;
    target.children = this.reconcileList(target.children, element.props.children);
    return target;
  }

  reconcileList(children, elements) {
    const list = Array.isArray(elements) ? elements : (elements === undefined || elements === null ? [] : elements);
    const out = [];
    for (let at = 0; at < list.length; at += 1) out.push(this.reconcile(children[at] === undefined ? null : children[at], list[at]));
    for (let at = list.length; at < children.length; at += 1) this.unmount(children[at]);
    return out;
  }

  markDirty(inst) {
    if (inst.alive !== true) return;
    this.dirty.add(inst);
    if (this.flushDepth === 0) this.flush();
  }

  /** 渲染 → 提交 effect →（effect 里 setState 就再来一轮），直到收敛。 */
  flush() {
    if (this.flushDepth > 0) return;
    this.flushDepth += 1;
    let guard = 0;
    try {
      while (this.dirty.size > 0 || this.pendingEffects.length > 0) {
        guard += 1;
        if (guard > 200) throw new Error('渲染未收敛（组件在渲染/提交里无限 setState）');
        const batch = [...this.dirty];
        this.dirty.clear();
        for (const inst of batch) this.renderComponent(inst);
        const effects = this.pendingEffects;
        this.pendingEffects = [];
        for (const record of effects) {
          if (record.inst.alive !== true) continue;
          if (typeof record.cleanup === 'function') {
            const cleanup = record.cleanup;
            record.cleanup = null;
            try { cleanup(); } catch { /* 桩里忽略清理异常 */ }
          }
          const output = record.create();
          record.cleanup = typeof output === 'function' ? output : null;
        }
      }
      this.flushes += 1;
    } finally {
      this.flushDepth -= 1;
    }
  }

  unmount(node) {
    if (node === null || node === undefined) return;
    if (node.kind === 'component') {
      node.alive = false;
      this.dirty.delete(node);
      for (const slot of node.hooks) {
        if (slot !== null && typeof slot === 'object' && typeof slot.cleanup === 'function') {
          const cleanup = slot.cleanup;
          slot.cleanup = null;
          try { cleanup(); } catch { /* 桩里忽略清理异常 */ }
        }
      }
      this.unmount(node.child);
      return;
    }
    if (Array.isArray(node.children)) for (const child of node.children) this.unmount(child);
  }

  unmountAll() {
    for (const root of this.roots) this.unmount(root);
    this.roots = [];
    this.dirty.clear();
    this.pendingEffects = [];
  }

  /* ── 查询helper ── */
  nodes() {
    const out = [];
    const visit = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      out.push(node);
      if (node.kind === 'component') { visit(node.child); return; }
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    this.roots.forEach(visit);
    return out;
  }

  textOf(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((item) => this.textOf(item)).join('');
    if (node.kind === 'text') return node.text;
    if (node.kind === 'component') return this.textOf(node.child);
    if (Array.isArray(node.children)) return node.children.map((item) => this.textOf(item)).join('');
    return '';
  }

  text() { return this.roots.map((root) => this.textOf(root)).join(''); }
  findAll(predicate) { return this.nodes().filter(predicate); }
  hosts() { return this.findAll((node) => node.kind === 'host'); }
  byTag(tag) { return this.hosts().filter((node) => node.tag === tag); }
  byClass(cls) { return this.hosts().filter((node) => String(node.props.className ?? '').split(/\s+/).includes(cls)); }
  byLabel(part) { return this.hosts().filter((node) => typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes(part)); }
  byText(text) { return this.hosts().filter((node) => this.textOf(node) === text); }
  buttonByLabel(part) { const hit = this.byLabel(part).filter((node) => node.tag === 'button'); return hit.length === 0 ? undefined : hit[0]; }
  buttonByText(text) { const hit = this.byText(text).filter((node) => node.tag === 'button'); return hit.length === 0 ? undefined : hit[0]; }
  textarea() { const hit = this.byTag('textarea'); return hit.length === 0 ? undefined : hit[0]; }
}

/* ══════════════════════════ react-dom 桩 ══════════════════════════ */

const makeReactDom = (renderer) => ({
  createPortal(node, target) {
    renderer.portals.push({ node, target });
    return node; // 桩：原样返回，编辑框内容因此仍留在渲染树里可查
  },
});

/* ══════════════════════════ 出厂 primitives 桩 ══════════════════════════ */

/**
 * 桩的导出名**严格照抄**出厂 `@deepseek-ai/dsh-client-ui-primitives` 里本插件会
 * 用到的那一批（名字在 lib/index.js 的导出里核对过）。v1 用的是 `Icon*16` 这种
 * 不存在的名字，在真机上「复制」按钮直接不渲染——桩只提供真名，这类回归因此
 * 在自测里就会红，而不是等到线上。**没有提供的名字**（MenuSurface / Checkbox /
 * Tag / useAnchoredPosition …）一旦被 client.js 引用就会在这里炸掉。
 */
function makePrimitives(recorder) {
  const stubIcon = (name) => function StubIcon(props) {
    return createElement('span', { className: 'stub-icon', 'data-icon': name, 'data-size': props?.size === undefined ? 'default' : String(props.size) });
  };
  const Tooltip = (props) => createElement('span', { className: 'stub-tooltip', 'data-tooltip': String(props.label) }, props.children);
  const Button = (props) => createElement('button', {
    type: 'button',
    className: `stub-button stub-${props.variant ?? 'ghost'}${props.size === undefined ? '' : ` stub-${props.size}`}`,
    disabled: props.disabled === true,
    onClick: props.onClick,
    'data-icon': props.icon === undefined || props.icon === null ? null : 'yes',
    'aria-expanded': props['aria-expanded'],
  }, props.children);
  const Modal = (props) => {
    recorder.modals.push({ open: props.open === true, title: props.title, closeLabel: props.closeLabel });
    if (props.open !== true) return null;
    return createElement('div', { className: 'stub-modal', role: 'dialog', 'aria-label': props.title, 'data-close-label': props.closeLabel },
      createElement('div', { className: 'stub-modal-body' }, props.children),
      props.footer === undefined || props.footer === null ? null : createElement('div', { className: 'stub-modal-footer' }, props.footer));
  };
  const JsonBlock = (props) => {
    recorder.jsonBlocks.push({ label: props.label, payload: props.payload, truncatedLabel: props.truncatedLabel });
    return createElement('pre', { className: 'stub-json', 'data-label': props.label }, JSON.stringify(props.payload));
  };
  return {
    Tooltip, Button, Modal, JsonBlock,
    IconEditOutlineRegular: stubIcon('edit'),
    IconCopyOutlineRegular: stubIcon('copy'),
    IconCheckOutlineRegular: stubIcon('check'),
    IconChevronLeftOutlineRegular: stubIcon('chevron-left'),
    IconChevronRightOutlineRegular: stubIcon('chevron-right'),
    FileTypeIcon: stubIcon('file'),
    projectUserText(text, sessionLabels, slashNames, slashKind, references) {
      recorder.projectUserText.push({
        text,
        sessionLabels: Array.from(sessionLabels ?? []),
        slashNames: Array.from(slashNames ?? []),
        slashKind: slashKind ?? null,
        references: references ?? null,
      });
      return `${text}${Array.isArray(sessionLabels) && sessionLabels.length > 0 ? `\n[引用] ${sessionLabels.join('、')}` : ''}`;
    },
    async writeClipboard(text) { recorder.clipboard.push(text); return true; },
    fileExtension(name) { const at = String(name).lastIndexOf('.'); return at < 0 ? '' : String(name).slice(at + 1); },
    fileSizeText(bytes) { return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`; },
  };
}

/* ══════════════════════════ 时间线与 fetch ══════════════════════════ */

function makeClock() {
  const events = [];
  const clock = {
    n: 0,
    events,
    next() { clock.n += 1; return clock.n; },
    push(label, detail) { const entry = { at: clock.next(), label, detail }; events.push(entry); return entry; },
    labels() { return events.map((entry) => entry.label); },
    mark() { return events.length; },
    since(mark) { return events.slice(mark).map((entry) => entry.label); },
  };
  return clock;
}

function makeFetch(options, clock) {
  const given = options.fixtures ?? {};
  // 每个 world 一份**独立副本**：迷你 host 会原地改夹具，共享模块级常量会让
  // 后面的用例看到别例改过的账本（v4 修掉的这类跨用例污染）。
  const states = Object.fromEntries(
    Object.entries(given.states ?? {}).map(([key, group]) => [key, structuredClone(group)]),
  );
  const fail = given.fail ?? {};
  /** /state 失败开关：测试中途翻开，模拟 host 路由没起来/同源被拒。 */
  const failState = { on: false };
  /** 挂起开关：翻开后 /state 的响应被扣住不放行（载荷在扣住时定型），用于过期响应测试。 */
  const hold = { on: false };
  const held = [];
  const calls = [];
  const unexpected = [];
  const impl = async (url, init) => {
    const raw = String(url);
    const parsed = new URL(raw, 'http://localhost');
    const method = String((init ?? {}).method ?? 'GET').toUpperCase();
    const body = typeof (init ?? {}).body === 'string' ? JSON.parse(init.body) : null;
    const sessionId = parsed.searchParams.get('sessionId');
    const record = { url: raw, path: parsed.pathname, search: parsed.search, method, body, at: clock.next(), status: 200 };
    calls.push(record);
    let payload;
    if (method === 'GET' && parsed.pathname === '/dsh-branches/state') {
      if (failState.on === true) {
        record.status = 500;
        payload = { error: 'host 路由没起来' };
      } else {
        // 真机上每次响应都是新解析的对象：这里也每次给一份**深拷贝**，
        // 让「结构相等才跳过 emit」这条生产路径真的被走到（共享引用会掩盖它）。
        payload = { sessionId, group: states[sessionId] === undefined ? null : structuredClone(states[sessionId]) };
      }
      if (hold.on === true) {
        // 扣住：载荷已定型（这一刻的 host 真值），等 releaseHeld 放行。
        return new Promise((resolve) => { held.push({ resolve, status: record.status, payload }); });
      }
    } else if (method === 'POST' && parsed.pathname === '/dsh-branches/branch') {
      if (fail.branch !== undefined) {
        record.status = 500;
        payload = { error: fail.branch };
      } else {
        // 迷你 host：真的把分支写进夹具并选中它（否则随后的 /state 刷新会把界面打回旧值）。
        const group = states[body.sessionId] ?? (states[body.sessionId] = groupOf({}));
        const key = String(body.seq);
        const entry = group.messages[key] ?? (group.messages[key] = messageSet(body.seq, 1, 0, []));
        entry.variants = [...entry.variants, {
          id: `v${entry.variants.length + 1}`, kind: 'edit', label: body.text, preview: body.text,
          chars: body.text.length, text: body.text, createdAt: T_S1 + entry.variants.length,
        }];
        entry.total = entry.variants.length + 1;
        entry.selected = entry.total - 1;
        payload = { sessionId: body.sessionId, seq: body.seq, message: { ...entry, variants: [...entry.variants] }, group };
      }
    } else if (method === 'POST' && parsed.pathname === '/dsh-branches/select') {
      if (fail.select !== undefined) {
        record.status = 500;
        payload = { error: fail.select };
      } else {
        // 迷你 host：粘性选择落账（刷新后必须还是用户选的那个）。
        const entry = (states[body.sessionId]?.messages ?? {})[String(body.seq)];
        if (entry !== undefined) entry.selected = body.index;
        payload = {
          sessionId: body.sessionId,
          seq: body.seq,
          message: entry === undefined ? null : { ...entry },
          group: states[body.sessionId] ?? null,
        };
      }
    } else {
      record.status = 404;
      payload = { error: `自测桩未定义的路由：${method} ${parsed.pathname}` };
      unexpected.push(record);
    }
    ALL_URLS.push(`${method} ${parsed.pathname}${parsed.search}`);
    clock.push(`${method} ${parsed.pathname}${parsed.search}`, record);
    return { ok: record.status === 200, status: record.status, json: async () => payload };
  };
  return {
    impl,
    calls,
    unexpected,
    states,
    failState,
    hold,
    held,
    /** 放行前 n 个被扣住的 /state 响应（载荷是扣住那一刻定型的）。 */
    releaseHeld(count = 1) {
      const batch = held.splice(0, count);
      for (const item of batch) {
        item.resolve({ ok: item.status === 200, status: item.status, json: async () => item.payload });
      }
    },
    byPath: (path, query) => calls.filter((call) => call.path === path && (query === undefined || call.search.includes(query))),
    posts: () => calls.filter((call) => call.method !== 'GET'),
  };
}

/* ══════════════════════════ slots / locale / ctx 桩 ══════════════════════════ */

function makeSlots() {
  const registrations = [];
  const injections = [];
  const service = {
    inject(name, callback) {
      injections.push(name);
      return callback(); // 真实实现：槽位可挂载时回调注册；桩里立即执行
    },
    /**
     * 判重规则**照抄出厂 SlotCore.register**：keyed 槽同 key 同 priority 即抛，
     * list 槽同 id 同 priority 即抛。v4 的 user 键注册必须带负 priority 才能过——
     * 少了它，这里会红（真机同理会抛，且会一路穿过 apply 让整条 fiber 失败）。
     */
    register(spec, component) {
      const priority = spec.priority ?? 0;
      const occupantOf = (predicate) => registrations.find((entry) => entry.active && predicate(entry));
      if (spec.name === 'conversation.chat.node') {
        if (spec.key === undefined) throw new Error('keyed slot "conversation.chat.node" requires options.key');
        const occupant = occupantOf((entry) => entry.spec.key === spec.key && (entry.spec.priority ?? 0) === priority);
        if (occupant !== undefined) {
          throw new Error(`keyed slot "${spec.name}" already has an entry for key "${spec.key}" at priority ${priority} — register at a different priority to shadow it (lowest renders)`);
        }
      }
      if (spec.name === 'shell.overlay' && spec.id === undefined) throw new Error('list slot "shell.overlay" requires options.id');
      const entry = { spec, component, active: true };
      registrations.push(entry);
      return () => { entry.active = false; };
    },
  };
  return { service, registrations, injections };
}

/** 某个键当前的 winner（priority 最低且 active；与出厂「lowest renders」一致）。 */
function winnerOf(world, key) {
  const rows = world.slots.registrations
    .filter((entry) => entry.active && entry.spec.name === 'conversation.chat.node' && entry.spec.key === key)
    .sort((left, right) => (left.spec.priority ?? 0) - (right.spec.priority ?? 0));
  return rows.length === 0 ? undefined : rows[0];
}

/** locale 服务桩：重复注册即抛、disposer 真的摘掉（与出厂 dsh-client-locale 一致）。 */
function makeLocale() {
  const registrations = [];
  const service = {
    register(ns, dicts) {
      if (registrations.some((item) => item.ns === ns)) throw new Error(`locale namespace "${ns}" already has locale`);
      const entry = { ns, dicts };
      registrations.push(entry);
      return () => {
        const at = registrations.indexOf(entry);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
    bind(ns) {
      const hit = registrations.find((item) => item.ns === ns);
      const dict = hit === undefined ? {} : (hit.dicts.zh ?? hit.dicts.en ?? {});
      return (key, params) => {
        const template = dict[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (all, name) => (name in params ? String(params[name]) : all));
      };
    },
  };
  return { service, registrations };
}

function makeCtx(services) {
  const effects = [];
  const gets = [];
  const ctx = {
    effects,
    gets,
    get: (name) => { gets.push(name); return services[name]; },
    effect(callback, label) {
      const disposer = callback();
      effects.push({ label, disposer });
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    disposeAll() { for (const item of effects) if (typeof item.disposer === 'function') item.disposer(); },
  };
  // 真 Cordis 会把 inject 声明的服务挂成 ctx 上的属性（出厂插件就是 `ctx.locale.register` 这么写的）。
  for (const [name, service] of Object.entries(services)) ctx[name] = service;
  return ctx;
}

/* ══════════════════════════ 模块装载（执行一次，捕获 factory） ══════════════════════════ */

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

let currentWorld = null;
const delegateRequire = (id) => {
  if (currentWorld === null) throw new Error('自测尚未建立世界');
  return currentWorld.require(id);
};
const delegateFetch = (url, init) => {
  if (currentWorld === null) throw new Error('自测尚未建立世界');
  return currentWorld.fetch.impl(url, init);
};

const loaderEntries = [];
globalThis.window = {
  setInterval: (fn, ms) => currentWorld.timers.setInterval(fn, ms),
  clearInterval: (id) => currentWorld.timers.clearInterval(id),
  setTimeout: (fn, ms) => currentWorld.timers.setTimeout(fn, ms),
  clearTimeout: (id) => currentWorld.timers.clearTimeout(id),
  __ModuleLoader__: { load(entry) { loaderEntries.push(entry); } },
};
globalThis.document = {
  get head() { return currentWorld.doc.head; },
  get body() { return currentWorld.doc.body; },
  createElement: (tag) => currentWorld.doc.createElement(tag),
  // 真 document 的查询范围是整棵树；head 与 body 都算（installStyles 只往 head 写）。
  querySelector(selector) {
    return currentWorld.doc.head.querySelector(selector) ?? currentWorld.doc.body.querySelector(selector);
  },
  querySelectorAll(selector) {
    return [...currentWorld.doc.head.querySelectorAll(selector), ...currentWorld.doc.body.querySelectorAll(selector)];
  },
};

// 用 new Function 执行 client.js：window/document/require/fetch 都显式注入，
// 顶层 `window.__ModuleLoader__.load({id, factory})` 因此被捕获。
new Function('window', 'document', 'require', 'fetch', 'setTimeout', 'clearTimeout', SOURCE)(
  globalThis.window, globalThis.document, delegateRequire, delegateFetch, globalThis.setTimeout, globalThis.clearTimeout,
);

/* ══════════════════════════ 世界工厂 ══════════════════════════ */

function createWorld(options = {}) {
  const clock = makeClock();
  const doc = makeDocument();
  const timers = makeTimers();
  const recorder = { clipboard: [], projectUserText: [], jsonBlocks: [], images: [], modals: [] };
  const primitives = options.primitives === 'throw' ? null : makePrimitives(recorder);
  const slots = makeSlots();
  const locale = makeLocale();
  const fetch = makeFetch(options, clock);
  const renderer = new Renderer();
  const ctx = makeCtx({ slots: slots.service, locale: locale.service });
  const world = {
    clock, doc, timers, recorder, primitives, slots, locale, fetch, renderer, ctx,
    instance: null,
    require(id) {
      if (id === 'react') return React;
      if (id === 'react-dom') return makeReactDom(renderer);
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        if (primitives === null) throw new Error("Cannot find module '@deepseek-ai/dsh-client-ui-primitives'");
        return primitives;
      }
      throw new Error(`自测桩未提供的模块：${id}`);
    },
    slotComponent(name, key) {
      // 与出厂一致：同格多个条目时**priority 最低**的渲染（lowest renders）。
      const rows = slots.registrations
        .filter((entry) => entry.active && entry.spec.name === name && (key === undefined || entry.spec.key === key))
        .sort((left, right) => (left.spec.priority ?? 0) - (right.spec.priority ?? 0));
      if (rows.length === 0) throw new Error(`没有注册槽位 ${name}${key === undefined ? '' : ` key=${key}`}`);
      return rows[0].component;
    },
    mount(component, props) { return renderer.mount(component, props); },
    /** 该槽位条目声明的 locale 命名空间所绑定的 t（真实环境由出厂 renderer 注入）。 */
    translateFor(name, key) {
      const rows = slots.registrations
        .filter((entry) => entry.active && entry.spec.name === name && (key === undefined || entry.spec.key === key))
        .sort((left, right) => (left.spec.priority ?? 0) - (right.spec.priority ?? 0));
      const entry = rows[0];
      if (entry === undefined || entry.spec.locale === undefined) return undefined;
      return locale.service.bind(entry.spec.locale);
    },
    renderImages(args) {
      recorder.images.push(args);
      return createElement('div', { className: 'stub-images', 'data-count': String(args.images.length), 'data-compact': String(args.compact) });
    },
    assertNoUnexpectedRoute(message) {
      assert.deepStrictEqual(fetch.unexpected.map((call) => call.url), [], message);
      checks += 1;
    },
  };
  currentWorld = world;
  /*
   * 忠实环境：**不放** globalThis.ctx。出厂客户端模块由 <script> 以 factory(require)
   * 单参形式 materialize，没有全局 ctx；v1 的阻塞缺陷正是靠这一点被掩盖的，
   * 所以这里连"修复假设"的开关都不再保留。
   */
  delete globalThis.ctx;
  // factoryOccupied：先按出厂形状占掉 conversation.chat.node 的 user/steering 两格
  // （priority 0，与 ui-chat 的 registerChatNodeRenderers 逐字一致），再 apply 插件——
  // 这条路径专门钉「同 key 同 priority 会抛」这个真机不变式。
  if (options.factoryOccupied === true) {
    const FactoryUserView = () => null;
    slots.service.register({ name: 'conversation.chat.node', key: 'user', locale: 'chat' }, FactoryUserView);
    slots.service.register({ name: 'conversation.chat.node', key: 'steering', locale: 'chat' }, FactoryUserView);
  }
  world.instance = loaderEntries[0].factory(delegateRequire);
  return world;
}

/** 建一个世界并 apply（＝插件在浏览器里被装载）。 */
function boot(options = {}) {
  const world = createWorld(options);
  world.instance.apply(world.ctx);
  return world;
}

/* ══════════════════════════ 夹具 ══════════════════════════ */

const T_S1 = 1759900100000;

/** 分支集视图（host /state 的 messages[seq] 形状）。 */
const messageSet = (seq, total, selected, texts = []) => ({
  seq,
  total,
  selected,
  variants: texts.map((text, at) => ({ id: `v${at + 1}`, kind: 'edit', label: text, preview: text, chars: text.length, text, createdAt: T_S1 + at })),
});

const groupOf = (messages) => ({
  id: 'g1',
  rootSessionId: 's1',
  createdAt: T_S1 - 10000,
  updatedAt: T_S1,
  messages,
});

/** s1：seq 42 有 3 个分支（原文 + 两版改写），当前停在第 2 个。 */
const GROUP_S1 = groupOf({ '42': messageSet(42, 3, 1, ['第一版改写', '第二版改写']) });
/** s1：空账本（有组没分支）。 */
const GROUP_S1_EMPTY = groupOf({});
/** seq 7：只有原文（total=1）——导航条不该出现。 */
const GROUP_S1_SINGLE = groupOf({ '7': messageSet(7, 1, 0, []) });

const userNode = (data = {}) => ({
  kind: 'user',
  data: Object.assign({ content: [{ type: 'text', text: '你好' }], seq: 42, time: T_S1, source: { kind: 'user' } }, data),
});

const OPEN_FILE = (path) => ({ opened: path });
const OPEN_SKILL = (name) => ({ opened: name });

/** user 键条目 / 编辑框宿主各自的 t（真实环境由出厂 renderer 按 locale 声明注入）。 */
const userT = (world) => world.translateFor('conversation.chat.node', 'user');
const hostT = (world) => world.translateFor('shell.overlay');

function mountUserEntry(world, props = {}) {
  const component = world.slotComponent('conversation.chat.node', 'user');
  return world.mount(component, Object.assign({
    node: userNode(),
    sessionId: 's1',
    renderMessageImages: world.renderImages,
    openFile: OPEN_FILE,
    openSkill: OPEN_SKILL,
    t: userT(world),
  }, props));
}

/** 常驻的编辑框宿主（与线上一样：先挂上，再点入口）。 */
function mountEditorHost(world) {
  return world.mount(world.slotComponent('shell.overlay'), { t: hostT(world) });
}

/** 点右下角那支笔（aria-label 取自词典，不能用字面量赌实现）。 */
function clickPencil(world) {
  const label = userT(world)('branch.pencil');
  const pencil = world.renderer.buttonByLabel(label.slice(0, 4));
  assert.ok(pencil !== undefined, '没有找到用户气泡里的「笔」按钮');
  pencil.props.onClick();
}

/** 取某个函数体（按大括号配平），给静态守卫用。 */
function bodyOf(name) {
  const at = SOURCE.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = SOURCE.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < SOURCE.length; index += 1) {
    const ch = SOURCE[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(open, index + 1);
    }
  }
  return null;
}

/* ══════════════════════════ P0：结构性缺陷的静态守卫 ══════════════════════════ */

async function caseStaticGuards() {
  const lines = SOURCE.split('\n');
  eq(lines.filter((line) => /\b(const|let|var)\s+ctx\b/.test(line)).length, 0, 'P0 静态：client.js 没有任何 `const/let/var ctx` 声明（闭包载体叫 ctxRef）');
  eq(SOURCE.includes('globalThis.ctx'), false, 'P0 静态：客户端半边不依赖、也不制造全局 ctx');

  // 每个组件体内都不许出现自由变量 ctx（v1 的阻塞缺陷：HeaderEntry 里裸用 ctx）。
  for (const name of ['EditorHost', 'UserNodeEntry', 'EditBranchModal', 'BranchNav', 'IconAction']) {
    const body = bodyOf(name);
    ok(typeof body === 'string' && body.length > 0, `P0 静态：定位到 ${name} 的函数体`);
    eq(/ctx/.test(body.replace(/ctxRef/g, 'REF')), false, `P0 静态：${name} 体内没有自由变量 ctx`);
  }

  // 编辑框宿主与任何"会崩的"会话条目解耦：user 键条目不许挂它。
  for (const name of ['UserNodeEntry', 'EditBranchModal', 'BranchNav']) {
    eq(bodyOf(name).includes('EditorHost'), false, `P0 静态：${name} 不挂载 EditorHost（否则该条目被除名时编辑框一起消失）`);
  }
  const hostBody = bodyOf('EditorHost');
  ok(hostBody.includes('EditBranchModal'), 'P0 静态：EditorHost 才是编辑框的唯一宿主');

  // 视觉构造：不扫别包的 CSS-module 哈希类名，不使用不存在的 --dsh-* 变量。
  eq(SOURCE.includes('MessageItem.module.css'), false, 'P0 静态：不再读出厂 ui-chat 的样式表去找类名前缀');
  eq(/querySelectorAll\(\s*['"]style\[data-plugin-css/.test(SOURCE), false, 'P0 静态：不再扫 <style data-plugin-css> 标签');
  eq(/Sixlwa|xzv4MW/.test(SOURCE), false, 'P0 静态：源码里没有出厂构建的哈希类名前缀');
  for (const bogus of ['--dsh-bg', '--dsh-border', '--dsh-text', '--dsh-accent']) {
    eq(SOURCE.includes(bogus), false, `P0 静态：不再使用不存在的主题变量 ${bogus}*`);
  }
  ok(SOURCE.includes('--dsw-alias-'), 'P0 静态：自写样式只用 --dsw-alias-* 主题变量');

  // v4 语义边界：分支只长在我的消息上；不碰出厂 fork 能力；不建会话。
  eq(SOURCE.includes("name: 'conversation.chat.turnTail'"), false, 'P0 静态：没有 conversation.chat.turnTail 的注册行（助手回复后面没有入口）');
  eq(SOURCE.includes('conversation.session.header.utilities'), false, 'P0 静态：没有会话头部分局面板（v3 的「分支组 + 任意历史会话」整体删除）');
  eq(SOURCE.includes('forkAt'), false, 'P0 静态：不使用出厂 owner props 里的 forkAt（原版分支能力与本插件无关）');
  for (const forbidden of ['sessions.fork', 'sessions.create', 'openSession', 'bindingFor', 'uiWorkspace', '/dsh-branches/register', '/dsh-branches/rollback', '/dsh-branches/targets']) {
    eq(SOURCE.includes(forbidden), false, `P0 静态：不再引用 ${forbidden}（分支不建会话、不回退文件）`);
  }
  ok(SOURCE.includes('mb-branchNav'), 'P0 静态：分支导航条样式类在场');

  // 出厂 primitives 的导出名必须是真的（v1 用了不存在的 Icon*16 ⇒ 复制按钮不渲染）。
  eq(/Icon[A-Za-z]+Outline16\b/.test(SOURCE), false, 'P0 静态：不再引用不存在的 Icon*16 图标名');
  for (const icon of ['IconCopyOutlineRegular', 'IconEditOutlineRegular', 'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular']) {
    ok(SOURCE.includes(icon), `P0 静态：使用出厂真实图标 ${icon}`);
  }
  ok(SOURCE.includes('ui.Modal'), 'P0 静态：编辑框用出厂 Modal（自带 mask/Esc/焦点归还/portal）');

  // v4 的槽位纪律：同 key 必须用负 priority 顶掉出厂渲染器（同 priority 会抛）。
  ok(/SHADOW_PRIORITY\s*=\s*-\d/.test(SOURCE), 'P0 静态：接管键的 priority 常量为负（顶掉出厂同键渲染器）');
  ok(SOURCE.includes('priority: SHADOW_PRIORITY'), 'P0 静态：注册行带上该负 priority（不是只在注释里说说）');
  ok(/MESSAGE_KEYS/.test(SOURCE), 'P0 静态：steering（我中途插的话）也在接管列表里');
  eq(/require\(['"]react-dom['"]\)/.test(SOURCE), false, 'P0 静态：不 require react-dom（portal 走出厂 Modal，那是死代码）');
}

/* ══════════════════════════ P0b：忠实环境下的点击链路 ══════════════════════════ */

async function caseClickChain() {
  const w = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  eq('ctx' in globalThis, false, 'P0b 环境：全局没有 ctx（出厂客户端模块由 factory(require) 单参调用）');
  deepEq(w.instance.inject, ['slots', 'locale'], 'P0b：client 半边依赖 slots + locale 两个服务');
  // 运行期取服务只走 ctx.get('slots') 与（兜底翻译席）ctx.get('locale')；
  // **绝不**出现 sessions / uiWorkspace——那正是 v3 建新会话的入口。
  deepEq([...new Set(w.ctx.gets)], ['slots'], 'P0b：运行期只向 ctx 要过 slots（locale 走 ctx.locale 属性）');

  const host = mountEditorHost(w);
  eq(w.renderer.byClass('stub-modal').length, 0, 'P0b：没点之前没有编辑框');
  eq(w.slotComponent('shell.overlay') !== undefined, true, 'P0b：编辑框宿主注册在常驻的 shell.overlay 上');
  // 出厂已经占了 user 键（priority 0）：我们的注册必须活下来并且成为 winner。
  eq(winnerOf(w, 'user').spec.id, 'message-branches-user-edit', 'P0b：出厂占位之下我们的 user 条目仍是 winner（负 priority）');
  eq(winnerOf(w, 'steering').spec.id, 'message-branches-steering-edit', 'P0b：steering 键同样被我们接管');

  // ① 点笔 → 编辑框真的出现（v1：状态置位但没有任何订阅者渲染）
  mountUserEntry(w);
  clickPencil(w);
  await settle();
  eq(w.renderer.byClass('stub-modal').length, 1, 'P0b：点笔之后编辑框渲染出来了（v1 是「点了没反应」）');
  eq(w.recorder.modals.at(-1).open, true, 'P0b：出厂 Modal 以 open 状态被调用');
  eq(w.renderer.byClass('mb-input').length, 1, 'P0b：编辑框里是改写输入框（已预填当前分支文本）');
  eq(w.renderer.textarea().props.value, '你好', 'P0b：输入框预填的是这条消息当前的文本');
  eq(w.renderer.text().includes('✎'), false, 'P0b：笔是真图标，不是 v1 那个字体字符 ✎');
  w.renderer.unmountAll();
  w.renderer.dirty.clear();
  w.renderer.pendingEffects = [];
  w.assertNoUnexpectedRoute('P0b 不该有未预期路由');

  // ② 翻译席缺失也不许让编辑框静默消失（兜底走 locale.bind(NS)）。
  const w2 = boot({ factoryOccupied: true, fixtures: { states: {} } });
  w2.mount(w2.slotComponent('shell.overlay'), {});
  mountUserEntry(w2);
  clickPencil(w2);
  await settle();
  eq(w2.renderer.byClass('stub-modal').length, 1, 'P0b：条目没拿到 t 时编辑框仍渲染（不因一个函数缺失而整条入口失效）');
  ok(w2.renderer.text().includes(w2.translateFor('shell.overlay')('branch.confirm')), 'P0b：兜底翻译席来自 locale.bind(NS)，文案照样可读');
  w2.assertNoUnexpectedRoute('P0b 不该有未预期路由');
}

/* ══════════════════════════ P1：apply 的注册与词典 ══════════════════════════ */

async function caseApply() {
  const w = boot({ factoryOccupied: true });
  eq(w.instance.name, 'dsh-message-branches', 'P1：插件名 = locale 命名空间');
  deepEq(w.instance.inject, ['slots', 'locale'], 'P1：client 半边依赖 slots + locale');

  const styles = w.doc.head.childNodes.filter((node) => node.getAttribute('data-plugin-css') === 'dsh-message-branches/client.css');
  eq(styles.length, 1, 'P1：apply 注入一个 <style data-plugin-css> 节点');
  eq(styles[0].dataset.plugin, 'dsh-message-branches', 'P1：样式节点带插件标记');
  ok(String(styles[0].textContent).includes('.mb-branchNav'), 'P1：样式内容真的写进了节点（含分支导航条）');

  deepEq(w.slots.injections, ['shell.overlay', 'conversation.chat.node', 'conversation.chat.node'], 'P1：三条槽位注入（编辑框宿主 + 我的消息两格），助手侧/头部都不在其中');
  eq(w.slots.registrations.length, 5, 'P1：五条注册（出厂两格占位 + 宿主 + user + steering）');
  const byId = (id) => w.slots.registrations.find((entry) => entry.spec.id === id);
  const hostEntry = byId('message-branches-editor');
  const userEntry = byId('message-branches-user-edit');
  const steeringEntry = byId('message-branches-steering-edit');
  eq(hostEntry.spec.id, 'message-branches-editor', 'P1：宿主条目 id');
  eq(userEntry.spec.id, 'message-branches-user-edit', 'P1：user 键条目 id');
  eq(userEntry.spec.priority, -1, 'P1：user 键用负 priority 顶掉出厂渲染器（同 priority 会抛）');
  eq(steeringEntry.spec.id, 'message-branches-steering-edit', 'P1：steering 键同样接管（那也是我发出的消息）');
  eq(steeringEntry.spec.priority, -1, 'P1：steering 键同样负 priority');
  for (const entry of [hostEntry, userEntry, steeringEntry]) {
    eq(entry.spec.locale, 'dsh-message-branches', `P1：${entry.spec.id} 声明了 locale 命名空间（否则出厂 renderer 不注入 t）`);
  }
  // 出厂那两格必须还在（卸载我们之后自动回退），并且都被我们压在下面。
  eq(winnerOf(w, 'user').spec.id, 'message-branches-user-edit', 'P1：user 格 winner 是我们');
  eq(winnerOf(w, 'steering').spec.id, 'message-branches-steering-edit', 'P1：steering 格 winner 是我们');

  eq(w.locale.registrations.length, 1, 'P1：注册了一份浏览器词典');
  eq(w.locale.registrations[0].ns, 'dsh-message-branches', 'P1：词典命名空间 = 插件名');
  const zhKeys = Object.keys(w.locale.registrations[0].dicts.zh).sort();
  const enKeys = Object.keys(w.locale.registrations[0].dicts.en).sort();
  ok(zhKeys.length > 20, `P1：词典有 ${zhKeys.length} 条文案`);
  deepEq(zhKeys, enKeys, 'P1：zh / en 键集完全一致（缺一条就会在另一种语言里显示原始 key）');
  const t = hostT(w);
  eq(t('branch.navPrev'), '上一个分支', 'P1：中文词典可解析');
  eq(t('branch.navLabel', { current: 2, total: 3 }), '第 2 个分支，共 3 个', 'P1：带参数的文案可解析');
  eq(w.locale.registrations[0].dicts.en['branch.navNext'], 'Next branch', 'P1：英文词典在场');
  eq(w.locale.registrations[0].dicts.en['branch.navPrev'], 'Previous branch', 'P1：英文「上一个分支」');
  eq(w.locale.registrations[0].dicts.en['branch.clockMd'], '{m}/{d}', 'P1：英文时钟模板与出厂一致（M/D）');
  eq(w.locale.registrations[0].dicts.en['branch.clockYmd'], '{y}-{m}-{d}', 'P1：英文跨年模板与出厂一致（Y-M-D）');
  eq(w.locale.registrations[0].dicts.en['branch.referenceSeparator'], ', ', 'P1：英文引用分隔符与出厂一致');
  eq(w.locale.registrations[0].dicts.zh['branch.clockMd'], '{m}月{d}日', 'P1：中文时钟模板与出厂一致（M月D日）');
  eq(w.ctx.effects.length, 5, 'P1：五条 effect（样式 + 词典 + 三条槽位）');

  // 客户端热换的**真实**顺序（出厂 locale 服务对重复注册是抛错，所以只可能是
  // 先卸载旧 fiber 再装载新模块）：旧实例全摘 → 新实例装上 → 样式/词典都恰好一份。
  const styleOf = () => w.doc.head.childNodes.filter((node) => node.getAttribute('data-plugin-css') === 'dsh-message-branches/client.css');
  ok(String(w.ctx.effects[0].label).includes('styles'), 'P1：第一条 effect 是样式');
  for (const effect of w.ctx.effects) if (typeof effect.disposer === 'function') effect.disposer();
  eq(styleOf().length, 0, 'P1：卸载后样式节点清零');
  eq(w.locale.registrations.length, 0, 'P1：卸载后词典也摘掉（与出厂一致）');
  w.instance.apply(w.ctx);
  eq(styleOf().length, 1, 'P1：重新 apply 后样式恰好一份（stale 节点先被摘掉）');
  eq(w.locale.registrations.length, 1, 'P1：重新 apply 后词典恰好一份（旧实例已卸，不会重复注册）');
  ok(String(styleOf()[0].textContent).includes('.mb-branchNav'), 'P1：幸存的样式节点内容是当前这一份');
  w.assertNoUnexpectedRoute('P1 不该有未预期路由');
}

/** 顶格语义：卸载我们之后，出厂渲染器必须自动回到 winner（不把出厂挤掉）。 */
async function caseShadowPriority() {
  const w = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  const factoryUser = winnerOf(w, 'user');
  eq(factoryUser.spec.id, 'message-branches-user-edit', 'S：装上后 winner 是我们');
  const shipped = w.slots.registrations.find((entry) => entry.spec.name === 'conversation.chat.node'
    && entry.spec.key === 'user' && entry.spec.id === undefined && entry.spec.locale === 'chat');
  ok(shipped !== undefined && shipped.active, 'S：出厂那条仍在账本里（priority 0，只是被我们压住）');
  // 卸掉我们的 user 条目 → 出厂那条成为 winner。
  const ours = w.slots.registrations.find((entry) => entry.spec.id === 'message-branches-user-edit');
  ours.active = false;
  eq(winnerOf(w, 'user').spec.id, undefined, 'S：卸载我们后 user 格没有我们的条目了');
  eq(winnerOf(w, 'user'), shipped, 'S：出厂渲染器自动回位（插件走了也不留空白格）');
  w.assertNoUnexpectedRoute('S 不该有未预期路由');
}

/* ══════════════════════════ P2：用户气泡（复制 / 时间 / 引用 / 附件） ══════════════════════════ */

async function caseBubble() {
  const w = boot({ fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  const t = userT(w);
  mountUserEntry(w, {
    node: userNode({
      content: [
        { type: 'text', text: '看一下 @a.ts 和 /plan' },
        { type: 'image', attachment: { id: 'att-1' } },
        { type: 'file', attachment: { name: 'report.pdf', bytes: 2048 } },
        { type: 'thinking', text: 'x' },
      ],
      referenceLabels: ['上一条消息'],
      skillNames: ['plan'],
      time: Date.now(),
      seq: 42,
    }),
  });

  // 复制按钮：v1 因为用了不存在的 IconCopyOutline16 而完全不渲染。
  const copy = w.renderer.buttonByLabel('复制');
  ok(copy !== undefined, 'P2：出厂那套「复制」按钮在场（v1 一个都没有）');
  eq(w.renderer.byClass('mb-action').length, 2, 'P2：动作行 = 时间/复制 + 笔，正好两个按钮');
  deepEq(w.renderer.findAll((node) => node.kind === 'host' && node.props['data-icon'] === 'copy').length, 1, 'P2：复制按钮里是出厂 IconCopyOutlineRegular');
  eq(w.renderer.findAll((node) => node.kind === 'host' && node.props['data-icon'] === 'edit').length, 1, 'P2：笔里是出厂 IconEditOutlineRegular');
  copy.props.onClick();
  await settle();
  eq(w.recorder.clipboard.length, 1, 'P2：复制走的是出厂 writeClipboard');
  eq(w.recorder.clipboard[0], '看一下 @a.ts 和 /plan', 'P2：复制的是纯文本');

  // projectUserText：必须带上第 4/5 参（v1 少传 ⇒ @文件/技能链接失去导航）。
  ok(w.recorder.projectUserText.length >= 1, 'P2：projectUserText 被调用（每次重渲染都会投影一次）');
  const projection = w.recorder.projectUserText.at(-1);
  eq(projection.slashKind, 'skill', 'P2：第 4 参 slashKind=skill');
  eq(projection.references.openFile, OPEN_FILE, 'P2：第 5 参 references.openFile 原样传出');
  eq(projection.references.openSkill, OPEN_SKILL, 'P2：第 5 参 references.openSkill 原样传出');
  deepEq(projection.sessionLabels, ['上一条消息'], 'P2：引用标签原样传出');

  // 引用摘要与额外块走词典（v1 硬编码中文）。多个标签用出厂同款分隔符「、」。
  ok(w.renderer.text().includes(t('branch.referenceSummary', { labels: '上一条消息' })), 'P2：引用摘要用词典文案');
  const wLabels = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  mountUserEntry(wLabels, { node: userNode({ referenceLabels: ['甲', '乙'], seq: 42 }) });
  ok(wLabels.renderer.text().includes(t('branch.referenceSummary', { labels: ['甲', '乙'].join(t('branch.referenceSeparator')) })),
    'P2：多个引用标签之间用出厂同款分隔符（zh「、」）');
  eq(w.renderer.byClass('stub-json').length, 1, 'P2：非文本块交给出厂 JsonBlock');
  eq(w.recorder.jsonBlocks.at(-1).label, t('branch.extraBlock'), 'P2：JsonBlock 的标题也走词典');

  // 附件：图片交给出厂 renderMessageImages，文件用出厂 FileTypeIcon/扩展名/体积。
  ok(w.recorder.images.length >= 1, 'P2：图片走出厂图片渲染器');
  eq(w.recorder.images.at(-1).align, 'end', 'P2：图片右对齐');
  eq(w.recorder.images.at(-1).compact, true, 'P2：附件≥2 时压缩图片（与出厂 UserStyleBubble 同口径）');
  const fileCard = w.renderer.byClass('mb-fileCard')[0];
  ok(fileCard !== undefined, 'P2：文件卡片渲染出来了');
  ok(w.renderer.textOf(fileCard).includes('report.pdf'), 'P2：文件卡片显示文件名');
  ok(w.renderer.textOf(fileCard).includes('2.0 KB'), 'P2：文件卡片显示出厂体积文案');
  ok(w.renderer.textOf(fileCard).includes('PDF'), 'P2：文件卡片显示扩展名');

  // 没有分支时不出现导航条（1/1 没有导航价值）。
  eq(w.renderer.byClass('mb-branchNav').length, 0, 'P2：没有分支的消息不出导航条');
  eq(w.renderer.byClass('mb-bubble')[0].props['data-message-branch'], 'original', 'P2：无分支时气泡标记为原文');

  // 时间：今天只给 HH:mm；跨天给 M月D日 HH:mm；跨年给 Y年M月D日 HH:mm
  // （与出厂 formatMessageClock 的中文模板逐字一致，不再自己发明 M/D）。
  const timeTextOf = (world) => world.renderer.textOf(world.renderer.byClass('mb-time')[0]);
  const clock = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  eq(timeTextOf(w), clock(now), 'P2：今天的消息只显示 HH:mm（24 小时制，与出厂一致）');
  const earlier = new Date(now.getFullYear(), now.getMonth() - 2, 3, 9, 7);
  const w2 = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  mountUserEntry(w2, { node: userNode({ time: earlier.getTime(), seq: 42 }) });
  eq(timeTextOf(w2), `${earlier.getMonth() + 1}月${earlier.getDate()}日 ${clock(earlier)}`, 'P2：今年的旧消息显示 M月D日 HH:mm');
  const past = new Date(now.getFullYear() - 2, 4, 6, 18, 5);
  const w3 = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  mountUserEntry(w3, { node: userNode({ time: past.getTime(), seq: 42 }) });
  eq(timeTextOf(w3), `${past.getFullYear()}年${past.getMonth() + 1}月${past.getDate()}日 ${clock(past)}`, 'P2：跨年消息显示 Y年M月D日 HH:mm');
  eq(w2.renderer.byClass('mb-action').length, 2, 'P2：旧消息同样有复制与笔');

  // 单图不压缩。
  const w5 = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  mountUserEntry(w5, { node: userNode({ content: [{ type: 'image', attachment: { id: 'att-9' } }], seq: 42 }) });
  eq(w5.recorder.images.at(-1).compact, false, 'P2：只有一个附件时不压缩');

  // 没有文本也没有块时不出气泡（与出厂 UserStyleBubble 一致）。
  const w4 = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1_EMPTY } } });
  mountUserEntry(w4, { node: userNode({ content: [], seq: 42 }) });
  eq(w4.renderer.byClass('mb-bubble').length, 0, 'P2：空内容不出气泡');
  eq(w4.renderer.byClass('mb-action').length, 2, 'P2：但动作行仍在');
  w.assertNoUnexpectedRoute('P2 不该有未预期路由');
}

/* ══════════════════════════ P3：分支导航条（渲染 / 原文 / 单分支） ══════════════════════════ */

async function caseNavRender() {
  const w = boot({ fixtures: { states: { s1: GROUP_S1 } } });
  const t = userT(w);
  mountEditorHost(w);
  mountUserEntry(w);
  await settle();

  eq(w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length, 1, 'P3：挂载即拉一次分支账本');
  const nav = w.renderer.byClass('mb-branchNav');
  eq(nav.length, 1, 'P3：有 ≥2 个分支时导航条渲染出来');
  eq(w.renderer.byClass('mb-branchCount').length, 1, 'P3：计数在位');
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P3：计数 = 当前序号/总数（1 基）');
  eq(w.renderer.byClass('mb-branchCount')[0].props['aria-label'], t('branch.navLabel', { current: 2, total: 3 }), 'P3：计数带可读的 aria-label');

  const prev = w.renderer.buttonByLabel(t('branch.navPrev'));
  const next = w.renderer.buttonByLabel(t('branch.navNext'));
  ok(prev !== undefined && next !== undefined, 'P3：上一个/下一个两个按钮都在（文案取自词典）');
  eq(prev.props.disabled, false, 'P3：第 2/3 个时「上一个」可点');
  eq(next.props.disabled, false, 'P3：第 2/3 个时「下一个」可点');
  eq(w.renderer.findAll((node) => node.kind === 'host' && node.props['data-icon'] === 'chevron-left').length, 1, 'P3：上一个用出厂左 chevron');
  eq(w.renderer.findAll((node) => node.kind === 'host' && node.props['data-icon'] === 'chevron-right').length, 1, 'P3：下一个用出厂右 chevron');

  // 当前不是原文 → 气泡显示改写版文本；projectUserText 收到的也是改写版。
  eq(w.renderer.byClass('mb-bubble')[0].props['data-message-branch'], 'edited', 'P3：当前分支是改写版时气泡打 edited 标');
  eq(w.recorder.projectUserText.at(-1).text, '第一版改写', 'P3：气泡渲染的是改写版文本，不是日志原文');
  ok(w.renderer.text().includes('第一版改写'), 'P3：页面上看得到改写版');

  // 粘性：刷新（重新挂载）后还是第 2 个（host 记账，客户端不推导）。
  const w2 = boot({ fixtures: { states: { s1: GROUP_S1 } } });
  mountUserEntry(w2);
  await settle();
  eq(w2.renderer.textOf(w2.renderer.byClass('mb-branchCount')[0]), '2/3', 'P3：重挂后仍停在 host 记的选择上（不自动切回最新）');
  w.assertNoUnexpectedRoute('P3 不该有未预期路由');
}

async function caseNavOriginal() {
  // selected=0：显示原文、计数 1/3、上一个禁用。
  const group = groupOf({ '42': messageSet(42, 3, 0, ['第一版改写', '第二版改写']) });
  const w = boot({ fixtures: { states: { s1: group } } });
  const t = userT(w);
  mountUserEntry(w);
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '1/3', 'P3b：原文分支计数 1/3');
  eq(w.renderer.buttonByLabel(t('branch.navPrev')).props.disabled, true, 'P3b：第 1 个时「上一个」禁用');
  eq(w.renderer.buttonByLabel(t('branch.navNext')).props.disabled, false, 'P3b：第 1 个时「下一个」仍可点');
  eq(w.renderer.byClass('mb-bubble')[0].props['data-message-branch'], 'original', 'P3b：气泡标记为原文');
  eq(w.recorder.projectUserText.at(-1).text, '你好', 'P3b：气泡渲染日志原文');
  w.assertNoUnexpectedRoute('P3b 不该有未预期路由');
}

async function caseNavSingle() {
  // total=1（只有原文）：不渲染导航条，但笔还在。
  const w = boot({ fixtures: { states: { s1: GROUP_S1_SINGLE } } });
  mountUserEntry(w, { node: userNode({ seq: 7 }) });
  await settle();
  eq(w.renderer.byClass('mb-branchNav').length, 0, 'P3c：只有 1 个分支时不渲染导航条（不给每条消息添噪）');
  eq(w.renderer.byClass('mb-action').length, 2, 'P3c：笔与复制照旧');
  w.assertNoUnexpectedRoute('P3c 不该有未预期路由');
}

/* ══════════════════════════ P4：切换分支（乐观 + 失败回滚） ══════════════════════════ */

async function caseNavStep() {
  const states = { s1: GROUP_S1 };
  const w = boot({ fixtures: { states } });
  const t = userT(w);
  mountUserEntry(w);
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P4：起点 2/3');

  // 点「下一个」：先乐观切到 3/3（同步生效，不用等网络）。
  w.renderer.buttonByLabel(t('branch.navNext')).props.onClick();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'P4：点击后立刻乐观切成 3/3');
  eq(w.recorder.projectUserText.at(-1).text, '第二版改写', 'P4：气泡同步换成第二版改写');
  eq(w.renderer.buttonByLabel(t('branch.navNext')).props.disabled, true, 'P4：最后一个分支时「下一个」禁用');

  await settle();
  const select = w.fetch.byPath('/dsh-branches/select');
  eq(select.length, 1, 'P4：发了一次显式切换');
  deepEq(select[0].body, { sessionId: 's1', seq: 42, index: 2 }, 'P4：切换请求带 sessionId/seq/index');
  eq(w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length, 2, 'P4：切换成功后刷新一次 host 真值');
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'P4：刷新后仍是 3/3');

  // 再点「上一个」回 2/3。
  w.renderer.buttonByLabel(t('branch.navPrev')).props.onClick();
  await settle();
  eq(w.fetch.byPath('/dsh-branches/select')[1].body.index, 1, 'P4：回切请求 index=1');
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P4：界面回到 2/3');
  eq(w.renderer.byClass('mb-branchError').length, 0, 'P4：无错误提示');
  w.assertNoUnexpectedRoute('P4 不该有未预期路由');
}

async function caseNavStepFailure() {
  // host 拒绝切换：界面先乐观变，随后必须回滚到 host 真值并给出可读错误。
  const states = { s1: GROUP_S1 };
  const w = boot({ fixtures: { states, fail: { select: '分支序号越界：9' } } });
  const t = userT(w);
  mountUserEntry(w);
  await settle();
  w.renderer.buttonByLabel(t('branch.navNext')).props.onClick();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'P4b：失败前也先乐观（点击立刻有反馈）');
  await settle();
  eq(w.fetch.byPath('/dsh-branches/select').length, 1, 'P4b：确实发了请求');
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P4b：失败后回滚到 host 真值（绝不说谎）');
  eq(w.recorder.projectUserText.at(-1).text, '第一版改写', 'P4b：气泡文本也回到真值');
  ok(w.renderer.text().includes(t('branch.switchFailed', { message: '分支序号越界：9' })), 'P4b：给出可读的失败原因');
  w.assertNoUnexpectedRoute('P4b 不该有未预期路由');
}

/* ══════════════════════════ P5：创建分支全链路 ══════════════════════════ */

async function caseCreateBranch() {
  const states = { s1: GROUP_S1 };
  const w = boot({ factoryOccupied: true, fixtures: { states } });
  const t = userT(w);
  mountEditorHost(w);
  mountUserEntry(w);
  await settle();

  clickPencil(w);
  await settle();
  eq(w.renderer.byClass('stub-modal').length, 1, 'P5：点笔打开编辑框');
  eq(w.renderer.textarea().props.value, '第一版改写', 'P5：预填**当前分支**的文本（可在其上继续改）');
  ok(w.renderer.text().includes(t('branch.metaSeq', { seq: 42 })), 'P5：元信息带 seq');
  ok(w.renderer.text().includes(t('branch.metaBranches', { current: 2, total: 3 })), 'P5：元信息带当前分支序号');

  // 一字不差就建分支只会得到重复项：确认禁用 + 明说原因。
  eq(w.renderer.buttonByText(t('branch.confirm')).props.disabled, true, 'P5：文本没改时确认按钮禁用');
  ok(w.renderer.text().includes(t('branch.sameText')), 'P5：说明「与当前版本一字不差」');

  w.renderer.textarea().props.onChange({ target: { value: '第三版改写' } });
  eq(w.renderer.buttonByText(t('branch.confirm')).props.disabled, false, 'P5：改字后恢复可点');
  w.renderer.buttonByText(t('branch.confirm')).props.onClick();
  await settle();

  const branch = w.fetch.byPath('/dsh-branches/branch');
  eq(branch.length, 1, 'P5：确认才发一次创建请求');
  deepEq(branch[0].body, { sessionId: 's1', seq: 42, text: '第三版改写' }, 'P5：请求体 = sessionId/seq/trim 后的文本');
  eq(w.fetch.byPath('/dsh-branches/select').length, 0, 'P5：创建分支不走 /select（host 侧自动选中新分支）');

  // 结果态：host 返回的 message 决定文案（total=4, selected=3）。
  ok(w.renderer.text().includes(t('branch.done', { current: 4, total: 4 })), 'P5：结果态显示新的分支位置');
  ok(w.renderer.text().includes(t('branch.doneNote')), 'P5：结果态说明分支已存本地、刷新不丢');
  eq(w.renderer.byClass('mb-input').length, 0, 'P5：结果态不再是输入框');
  eq(w.renderer.byClass('mb-error').length, 0, 'P5：全程无错误');
  eq(w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length, 2, 'P5：创建成功后刷新账本');

  // 刷新拿到的是**结构相等的新对象**：导航条必须推进到 4/4、气泡换成新文本。
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '4/4', 'P5：创建后导航条推进到 4/4（不等下一轮轮询）');
  eq(w.recorder.projectUserText.at(-1).text, '第三版改写', 'P5：气泡同步换成新分支文本');
  eq(w.renderer.buttonByLabel(t('branch.navNext')).props.disabled, true, 'P5：最后一个分支时「下一个」禁用');

  w.renderer.buttonByText(t('branch.ok')).props.onClick();
  await settle();
  eq(w.renderer.byClass('stub-modal').length, 0, 'P5：「好」关闭编辑框');
  w.assertNoUnexpectedRoute('P5 不该有未预期路由');
}

async function caseCreateFailure() {
  const w = boot({ fixtures: { states: { s1: GROUP_S1 }, fail: { branch: '分支文本过长' } } });
  const t = userT(w);
  mountEditorHost(w);
  mountUserEntry(w);
  await settle();
  clickPencil(w);
  await settle();
  w.renderer.textarea().props.onChange({ target: { value: '改不动的' } });
  w.renderer.buttonByText(t('branch.confirm')).props.onClick();
  await settle();
  eq(w.fetch.byPath('/dsh-branches/branch').length, 1, 'P5b：请求发了');
  ok(w.renderer.text().includes(t('branch.errorFailed', { message: '分支文本过长' })), 'P5b：host 拒绝时给出可读原因');
  eq(w.renderer.byClass('mb-input').length, 1, 'P5b：留在改写态（写好的文本不丢）');
  eq(w.renderer.textarea().props.value, '改不动的', 'P5b：输入框内容保留');
  w.assertNoUnexpectedRoute('P5b 不该有未预期路由');
}

async function caseCreateValidation() {
  const w = boot({ fixtures: { states: { s1: GROUP_S1 } } });
  const t = userT(w);
  mountEditorHost(w);
  mountUserEntry(w);
  await settle();
  clickPencil(w);
  await settle();
  w.renderer.textarea().props.onChange({ target: { value: '   \n  ' } });
  w.renderer.buttonByText(t('branch.confirm')).props.onClick();
  await settle();
  ok(w.renderer.text().includes(t('branch.errorEmpty')), 'P7：空文本给出可读错误');
  eq(w.fetch.byPath('/dsh-branches/branch').length, 0, 'P7：不发创建请求');
  eq(w.renderer.byClass('mb-input').length, 1, 'P7：留在改写态');
  w.assertNoUnexpectedRoute('P7 不该有未预期路由');
}

/* ══════════════════════════ P6：没有 sessionId 时不打扰 ══════════════════════════ */

async function caseNoSession() {
  const w = boot({ fixtures: { states: { s1: GROUP_S1 } } });
  mountUserEntry(w, { sessionId: undefined });
  await settle();
  eq(w.fetch.calls.length, 0, 'P6：没有 sessionId 时一个请求都不发（不轮询、不报错刷屏）');
  eq(w.renderer.byClass('mb-branchNav').length, 0, 'P6：没有导航条');
  eq(w.renderer.byClass('mb-action').length, 2, 'P6：气泡本身照常渲染');
  clickPencil(w);
  await settle();
  eq(w.renderer.byClass('stub-modal').length, 0, 'P6：没有 sessionId 时笔是空操作（不会发出残缺请求）');
  w.assertNoUnexpectedRoute('P6 不该有未预期路由');
}

/* ══════════════════════════ P6b：过期响应 / 换会话 / 首次加载失败 ══════════════════════════ */

/** 在途的旧响应落在乐观更新之后：必须被票号作废，绝不打回用户刚切的分支。 */
async function caseStaleResponse() {
  const w = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1 } } });
  const t = userT(w);
  mountUserEntry(w);
  await settle();
  const stateCalls = () => w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length;

  // 扣住一次轮询响应（载荷定型为旧真值：2/3）。
  w.fetch.hold.on = true;
  w.timers.runIntervals();
  await settle();
  eq(stateCalls(), 2, 'S：轮询请求已发出并被扣住');

  // 点下一个：乐观 3/3 → POST 成功 → 强制刷新（也被扣住，载荷是新真值）。
  w.renderer.buttonByLabel(t('branch.navNext')).props.onClick();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'S：点击后立刻乐观成 3/3');
  await settle();
  eq(stateCalls(), 3, 'S：切换后的强制刷新也发出去了');

  // 放行**旧**响应：票号过期 → 丢弃，界面保持 3/3。
  w.fetch.releaseHeld(1);
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'S：过期响应被丢弃（不打回旧值）');
  eq(w.recorder.projectUserText.at(-1).text, '第二版改写', 'S：气泡仍是用户选的那版');

  // 放行新响应：host 真值也是 3/3，界面不变。
  w.fetch.releaseHeld(1);
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '3/3', 'S：新响应落地后仍是 3/3');
  w.assertNoUnexpectedRoute('S 不该有未预期路由');
}

/** 同实例换 sessionId（不重挂的 rare 路径）：绝不显示上一个会话的分支。 */
async function caseSessionSwitch() {
  const w = boot({
    factoryOccupied: true,
    fixtures: { states: { s1: GROUP_S1, s2: groupOf({ '9': messageSet(9, 2, 1, ['s2 的改写']) }) } },
  });
  const component = w.slotComponent('conversation.chat.node', 'user');
  let session = 's1';
  const make = () => React.createElement(component, {
    node: userNode(),
    sessionId: session,
    renderMessageImages: w.renderImages,
    openFile: OPEN_FILE,
    openSkill: OPEN_SKILL,
    t: userT(w),
  });
  const Wrapper = () => make();
  w.mount(Wrapper, {});
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'K：s1 的分支正常显示');

  session = 's2';
  const root = w.renderer.roots[w.renderer.roots.length - 1];
  w.renderer.markDirty(root); // 强制重渲染 wrapper（等价于 props 变化）
  await settle();
  eq(w.fetch.byPath('/dsh-branches/state', 'sessionId=s2').length, 1, 'K：换会话后去拉新会话的账');
  eq(w.renderer.byClass('mb-branchNav').length, 0, 'K：新会话这条消息没有分支 → 没有导航条');
  ok(!w.renderer.text().includes('第一版改写'), 'K：绝不显示上一个会话的改写版文本');
  w.assertNoUnexpectedRoute('K 不该有未预期路由');
}

/** 第一次加载就失败：也要给出可读原因（不能和「没有分支」长得一样）。 */
async function caseFirstLoadFailure() {
  const w = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1 } } });
  const t = userT(w);
  w.fetch.failState.on = true;
  mountUserEntry(w);
  await settle();
  eq(w.renderer.byClass('mb-branchNav').length, 0, 'F：没有拿到账本，不渲染导航条');
  ok(w.renderer.text().includes(t('branch.stateFailed', { message: 'host 路由没起来' })), 'F：首次加载失败也给出可读原因');
  w.assertNoUnexpectedRoute('F 不该有未预期路由');
}

/* ══════════════════════════ P6：轮询 / 状态失败 / 定时器生命周期 ══════════════════════════ */

async function casePollAndStateFailure() {
  const w = boot({ factoryOccupied: true, fixtures: { states: { s1: GROUP_S1 } } });
  const t = userT(w);
  mountUserEntry(w);
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P6：起点 2/3');
  const before = w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length;
  const flushes = w.renderer.flushes;

  // 30s 轮询：真的会去打一次 /state（强制刷新）。
  w.timers.runIntervals();
  await settle();
  eq(w.fetch.byPath('/dsh-branches/state', 'sessionId=s1').length, before + 1, 'P6：轮询触发一次强制刷新');
  eq(w.renderer.flushes, flushes, 'P6：账本没变时不惊动渲染树（不做无谓重渲染）');
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P6：界面不变');

  // host 挂了：导航条还在（用缓存的那份账），但下方给出可读原因。
  w.fetch.failState.on = true;
  w.timers.runIntervals();
  await settle();
  eq(w.renderer.textOf(w.renderer.byClass('mb-branchCount')[0]), '2/3', 'P6：刷新失败也不把界面清空（缓存账本照常显示）');
  ok(w.renderer.text().includes(t('branch.stateFailed', { message: 'host 路由没起来' })), 'P6：失败给出可读原因（不再静默）');
  eq(w.renderer.byClass('mb-branchNav').length, 1, 'P6：导航条仍在');

  // 最后一个订阅者退订 → 轮询定时器必须清掉（不泄漏）。
  w.renderer.unmountAll();
  eq(w.timers.intervals.size, 0, 'P6：退订后轮询定时器清零');
  w.assertNoUnexpectedRoute('P6 不该有未预期路由');
}

/* ══════════════════════════ H：隔离与卫生（收尾用例） ══════════════════════════ */

async function caseHygiene() {
  eq(SANDBOX_ROOT.startsWith(tmpdir()), true, 'H 沙箱根由 fs.mkdtempSync 造在 os.tmpdir() 下');
  eq(SANDBOX_ROOT.includes('mb-client-selftest-'), true, 'H 沙箱根带自测前缀，便于识别');

  eq(/require\(\s*['"](node:)?fs['"]\s*\)/.test(SOURCE), false, 'H client.js 不 require fs');
  eq(SOURCE.includes('/root/'), false, 'H client.js 里没有任何 /root/ 绝对路径');
  eq(/message-branches\/(state|journal|index)\.json/.test(SOURCE), false, 'H client.js 里没有任何 stateDir 数据文件名');
  eq(/stateDir/.test(SOURCE), false, 'H client.js 连 stateDir 这个概念都不认识（那是 host 半边的事）');

  ok(ALL_URLS.length > 0, `H 整轮共记录 ${ALL_URLS.length} 次请求`);
  const strays = ALL_URLS.filter((url) => !url.includes(' /dsh-branches/'));
  deepEq(strays, [], 'H 所有请求都在 /dsh-branches/ 下（没有 /plugins、/api、file:// 之类的旁路）');
  eq(ALL_URLS.some((url) => url.includes(SANDBOX_ROOT)), false, 'H 没有任何请求把临时 stateDir 路径带出去');
  const outsideReads = ALL_URLS.filter((url) => url.startsWith('GET ') && !/\/state\?/.test(url));
  deepEq(outsideReads, [], 'H 只读请求只有 /state 一种');
  const outsideWrites = ALL_URLS.filter((url) => url.startsWith('POST ') && !/\/(branch|select)$/.test(url));
  deepEq(outsideWrites, [], 'H 写请求只有 /branch 与 /select 两种（不建会话、不回退文件）');
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main() {
  step('P0 静态：无自由 ctx / 宿主与条目解耦 / 无假主题变量 / 图标名正确 / v4 语义边界');
  await caseStaticGuards();
  step('P0b 忠实环境：出厂占位之下点笔编辑框真的出现，翻译席缺失也不消失，运行期不碰 sessions');
  await caseClickChain();
  step('P1 apply：注册 + locale 声明 + 词典 + 热换（真实顺序）+ 顶格语义');
  await caseApply();
  await caseShadowPriority();
  step('P2 气泡：复制（真图标）/ 时间分档 / 引用投影 / 附件 / 空内容');
  await caseBubble();
  step('P3 导航条：k/n 渲染、原文态、单分支不渲染、粘性');
  await caseNavRender();
  await caseNavOriginal();
  await caseNavSingle();
  step('P4 切换：乐观更新、显式 /select、失败回滚到 host 真值');
  await caseNavStep();
  await caseNavStepFailure();
  step('P5 创建分支：预填当前文本 → /branch → 结果态；失败保留输入');
  await caseCreateBranch();
  await caseCreateFailure();
  await caseCreateValidation();
  step('P6 没有 sessionId：零请求、笔是空操作');
  await caseNoSession();
  step('P6a 过期响应作废 / 换会话重置 / 首次加载失败可读');
  await caseStaleResponse();
  await caseSessionSwitch();
  await caseFirstLoadFailure();
  step('P6b 轮询 / 状态失败可读 / 定时器退订清零');
  await casePollAndStateFailure();
  step('H 隔离与卫生：只打 /dsh-branches/，写请求只有 branch/select');
  await caseHygiene();
  eq(existsSync(SANDBOX_ROOT), true, 'H 沙箱在收尾前仍在（收尾后由 finally 删除）');
  eq(SANDBOX_ROOT.startsWith(tmpdir()), true, 'H 沙箱根始终在 os.tmpdir() 下');
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
} finally {
  /* 临时产物只留 /tmp，收尾连目录一起删（失败路径也删）。 */
  try { rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

if (failure === null) {
  try {
    eq(existsSync(SANDBOX_ROOT), false, 'H 收尾后临时沙箱已删除（/tmp 不留残片，线上数据根从未被提及）');
  } catch (error) {
    failure = error;
  }
}

if (failure === null) {
  console.log(`CLIENT SELFTEST PASS ${checks}/${checks}`);
} else {
  console.log(failure !== null && failure.stack !== undefined ? failure.stack : String(failure));
  console.log(`CLIENT SELFTEST FAIL 前 ${checks} 项断言通过后中断：${failure !== null && failure.message !== undefined ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
