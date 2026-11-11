/**
 * Offline DOM test for the sidebar menu injection in `client.js`.
 *
 * The shipped menu is a portaled `div[role="menu"]` whose items are
 * `div.itemWrap > button[role="menuitem"]`; the first version of this plugin
 * inserted a bare button before the next item's button and threw
 * `NotFoundError` — silently, inside a MutationObserver. This test pins the real
 * structure so that class of bug cannot come back without a red test.
 *
 * Run: node plugins/workspace-plus/uitest.mjs
 */

import assert from 'node:assert/strict';

// ---- a minimal DOM, just enough for the injection path --------------------

class El {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tag = String(tag).toLowerCase();
    this.attrs = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
    this.children = [];
    this.parentElement = null;
    this.text = undefined;
    this.listeners = new Map();
    for (const child of children) this.appendChild(child);
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(node, reference) {
    const at = this.children.indexOf(reference);
    // Real DOM: throws NotFoundError when the reference is not a child.
    if (at < 0) throw new Error('NotFoundError: insertBefore reference is not a child of this node');
    node.parentElement = this;
    this.children.splice(at, 0, node);
    return node;
  }
  get childNodes() {
    return this.children;
  }
  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at < 0) throw new Error('NotFoundError: removeChild node is not a child of this node');
    this.children.splice(at, 1);
    node.parentElement = null;
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at >= 0) parent.children.splice(at, 1);
    this.parentElement = null;
  }
  replaceWith(node) {
    const parent = this.parentElement;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at < 0) return;
    parent.children[at] = node;
    node.parentElement = parent;
    this.parentElement = null;
  }
  cloneNode() {
    const copy = new El(this.tag, Object.fromEntries(this.attrs));
    if (this.text !== undefined) copy.text = this.text;
    for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  get textContent() {
    if (this.children.length === 0) return this.text === undefined ? '' : this.text;
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.children.length = 0;
    this.text = String(value);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  fire(type, event = {}) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) handler(event);
    return handlers.length;
  }
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
  matches(selector) {
    const parsed = parseSelector(selector);
    if (!parsed) return false;
    if (parsed.tag && parsed.tag !== this.tag) return false;
    for (const [name, value] of parsed.attrs) {
      if (!this.attrs.has(name)) return false;
      if (value !== null && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const parsed = parseSelector(selector);
    if (!parsed) throw new Error(`unsupported selector: ${selector}`);
    const found = [];
    for (const node of this.walk()) {
      if (node !== this && node.matches(selector)) found.push(node);
    }
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.nodeType === 1 && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function parseSelector(selector) {
  const match = /^([a-z0-9-]*)((?:\[[^\]]+\])*)$/i.exec(String(selector).trim());
  if (!match) return null;
  const attrs = [];
  const attrPattern = /\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi;
  let attr;
  while ((attr = attrPattern.exec(match[2] || '')) !== null) attrs.push([attr[1], attr[2] === undefined ? null : attr[2]]);
  return { tag: match[1] ? match[1].toLowerCase() : null, attrs };
}

const textNodeWalker = (root) => {
  const nodes = [];
  const visit = (node) => {
    if (node.children.length === 0) {
      if (node.text !== undefined && String(node.text).trim().length > 0) {
        nodes.push({ nodeType: 3, nodeValue: node.text, parentElement: node });
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
};

const documentStub = {
  createElement: (tag) => new El(tag),
  createElementNS: (_ns, tag) => new El(tag),
  createTreeWalker: (root) => {
    const nodes = textNodeWalker(root);
    let index = -1;
    return { nextNode: () => (++index < nodes.length ? nodes[index] : null) };
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  querySelectorAll: () => [],
  querySelector: () => null,
  head: new El('head'),
  body: new El('body'),
};

// ---- load client.js the way the browser does -----------------------------

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (descriptor) => {
      const module = { exports: {} };
      captured = descriptor.factory(makeRequire());
      return module.exports;
    },
  },
};
globalThis.document = documentStub;
// Node 24 exposes `navigator` as a getter-only global.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
globalThis.KeyboardEvent = class KeyboardEvent {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: false }, init);
  }
};
globalThis.fetch = () => Promise.reject(new Error('offline test'));

function makeRequire() {
  const fakeReact = new Proxy(
    {
      createElement: (type, props, ...children) => ({ type, props: Object.assign({}, props, { children }) }),
      useReducer: (value) => [value, () => {}],
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useLayoutEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useId: () => 'id',
      Fragment: 'fragment',
    },
    { get: (target, key) => (key in target ? target[key] : () => null) },
  );
  return (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  };
}

await import('./client.js');

const api = captured && captured.__test;
assert.ok(api, 'client.js did not expose __test');

// ---- fixtures ------------------------------------------------------------

const item = (label) =>
  new El('div', { class: 'itemWrap' }, [
    new El('button', { type: 'button', role: 'menuitem', class: 'item' }, [
      new El('span', { class: 'itemIcon' }, [new El('svg', { viewBox: '0 0 16 16', fill: 'none', 'stroke-width': '1', 'aria-hidden': 'true' }, [new El('path', { d: 'M3 3h10v10H3z' })])]),
      Object.assign(new El('span', { class: 'itemLabel' }), { text: label }),
    ]),
  ]);

const buildMenu = () => {
  const viewport = new El('div', { role: 'presentation' }, [item('重命名'), item('删除工作区')]);
  const surface = new El('div', { 'data-menu-material': 'translucent' }, [new El('div', { 'aria-hidden': 'true' }), viewport]);
  const menu = new El('div', { role: 'menu', 'data-menu-material': 'translucent' }, [surface]);
  return { menu, viewport };
};

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error });
  }
};

// ---- assertions ---------------------------------------------------------

check('injectIntoMenu does not throw on the shipped wrapper markup', () => {
  const { menu } = buildMenu();
  assert.equal(api.injectIntoMenu(menu, 'ws-1'), true);
});

check('the item lands between rename and delete, inside the viewport', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  assert.equal(viewport.children.length, 3, 'expected three wrappers');
  assert.equal(viewport.children[1].getAttribute(api.MENU_MARK), '1', 'our wrapper must sit in the middle');
  assert.equal(viewport.children[0].querySelector('button').textContent.trim(), '重命名');
  assert.equal(viewport.children[2].querySelector('button').textContent.trim(), '删除工作区');
});

check('the cloned item is a whole wrapper with one menuitem button', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  const clone = viewport.children[1];
  assert.equal(clone.querySelectorAll('button[role="menuitem"]').length, 1);
  assert.equal(clone.querySelector('button').parentElement, clone);
});

check('the label is replaced with the plugin string', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  const button = viewport.children[1].querySelector('button');
  assert.equal(button.textContent.trim(), api.STRINGS.zh.menuItem);
});

check('the edit glyph is replaced by the shipped two-path settings icon', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  const svg = viewport.children[1].querySelector('svg');
  // Geometry of the template is kept: same 16×16 stroked style as the native icons.
  assert.equal(svg.getAttribute('viewBox'), '0 0 16 16');
  assert.equal(svg.getAttribute('fill'), 'none');
  assert.equal(svg.getAttribute('stroke-width'), '1');
  const paths = svg.querySelectorAll('path');
  assert.equal(paths.length, 2, 'the settings glyph has two paths (ring + gear body)');
  assert.equal(paths[0].getAttribute('stroke'), 'currentColor');
  assert.equal(paths[1].getAttribute('stroke'), 'currentColor');
  assert.equal(paths[1].getAttribute('d').length > 500, true);
});

check('stale aria attributes from the template are dropped', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  const button = viewport.children[1].querySelector('button');
  assert.equal(button.getAttribute('aria-haspopup'), null);
  assert.equal(button.getAttribute('aria-expanded'), null);
  assert.equal(button.getAttribute('aria-current'), null);
});

check('a second injection into the same menu is a no-op', () => {
  const { menu, viewport } = buildMenu();
  assert.equal(api.injectIntoMenu(menu, 'ws-1'), true);
  assert.equal(api.injectIntoMenu(menu, 'ws-1'), false);
  assert.equal(viewport.children.length, 3);
});

check('a menu with fewer than two items is left alone', () => {
  const viewport = new El('div', { role: 'presentation' }, [item('重命名')]);
  const menu = new El('div', { role: 'menu' }, [viewport]);
  assert.equal(api.injectIntoMenu(menu, 'ws-1'), false);
  assert.equal(viewport.children.length, 1);
});

check('an extra host item does not disable the injection', () => {
  const viewport = new El('div', { role: 'presentation' }, [item('重命名'), item('派生'), item('删除工作区')]);
  const menu = new El('div', { role: 'menu' }, [viewport]);
  assert.equal(api.injectIntoMenu(menu, 'ws-1'), true);
  assert.equal(viewport.children.length, 4, 'ours is added, nothing is dropped');
  assert.equal(viewport.children[2].getAttribute(api.MENU_MARK), '1', 'ours sits before the last item');
  assert.equal(viewport.children[3].querySelector('button').textContent.trim(), '删除工作区');
});

check('clicking the item closes the menu and opens the editor for that workspace', () => {
  const { menu, viewport } = buildMenu();
  api.injectIntoMenu(menu, 'ws-1');
  const button = viewport.children[1].querySelector('button');
  let defaultPrevented = false;
  let stopped = false;
  const fired = button.fire('click', {
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.equal(fired, 1, 'exactly one click handler');
  assert.equal(defaultPrevented, true);
  assert.equal(stopped, true);
  const state = api.store.get();
  assert.equal(state.open, true);
  assert.equal(state.target.workspaceId, 'ws-1');
  api.store.close();
});

check('close() invalidates an in-flight load', () => {
  const before = api.store.get().seq;
  api.store.close();
  assert.equal(api.store.get().seq, before + 1);
});

check('the fixture rejects the old bare-button insertion (why B1 happened)', () => {
  const { viewport } = buildMenu();
  const buttons = viewport.querySelectorAll('button[role="menuitem"]');
  // This is exactly what the first implementation did: insert a button before
  // the *next item's* button, which lives in a sibling wrapper.
  assert.throws(() => viewport.insertBefore(buttons[0], buttons[1]), /NotFoundError/);
});

// ---- report -------------------------------------------------------------

let failed = 0;
for (const result of results) {
  if (result.ok) {
    console.log(`  ok  - ${result.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${result.name}\n         ${result.error && result.error.message}`);
  }
}
console.log(`\nRESULT: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
