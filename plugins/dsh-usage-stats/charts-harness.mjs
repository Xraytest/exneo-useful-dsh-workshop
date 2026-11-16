/**
 * dsh-usage-stats / charts-harness — 无头渲染工具（selftest 与 preview 共用）。
 *
 * 本部署没有可 `require` 的 React（React 被打进 web bundle），所以：
 *   1. 用假 `window.__ModuleLoader__` 装载 client.js，取回图表组件；
 *   2. 用最小 `createElement` 桩产出「元素树」（图表组件都不使用 hooks，
 *      可当纯函数直接调用）；
 *   3. 提供元素树遍历（断言用）与元素树 → HTML 字符串（静态预览用）。
 *
 * 生产运行时不经过这里；它只服务于自检与离线预览。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

/** 装载 client.js，返回 { charts, apply }。 */
export function loadClientCharts() {
  const src = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  let captured = null;
  const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def; } } };
  new Function('window', src)(fakeWindow); // eslint-disable-line no-new-func
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-usage-stats');
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: Object.assign({}, props || {}, { children: children.flat(Infinity) }),
      key: (props && props.key) || null,
    }),
  };
  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`意外的 require：${name}`);
  });
  assert.equal(typeof mod.apply, 'function', 'client.js 必须导出 apply');
  assert.deepEqual(mod.inject, ['slots'], 'client.js 必须 inject slots');
  assert.ok(mod.__charts, 'client.js 缺少 __charts 测试钩子');
  return { charts: mod.__charts, apply: mod.apply };
}

/** 深度遍历元素树。 */
export function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean'
    || typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node === 'object' && node.type !== undefined) {
    visit(node);
    walk(node.props ? node.props.children : null, visit);
  }
}

export function findAll(root, type) {
  const out = [];
  walk(root, (n) => { if (n.type === type) out.push(n); });
  return out;
}

/** 收集所有非有限数字属性（NaN / Infinity 会画坏图）。 */
export function nonFiniteNumbers(root) {
  const bad = [];
  walk(root, (n) => {
    for (const [k, v] of Object.entries(n.props || {})) {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${String(n.type)}.${k}=${v}`);
    }
  });
  return bad;
}

/** 元素树里用到的 class 集合（用于核对 PAGE_CSS 覆盖）。 */
export function classesUsed(root) {
  const set = new Set();
  walk(root, (n) => {
    const cls = n.props && n.props.className;
    if (typeof cls !== 'string') return;
    for (const c of cls.split(/\s+/)) if (c !== '') set.add(c);
  });
  return set;
}

/* ------------------------------------------------------- 元素树 → HTML ---- */

// SVG 里大小写敏感、必须原样输出的属性
const KEEP_CASE = new Set(['viewBox', 'preserveAspectRatio', 'patternUnits', 'gradientUnits']);
const VOID_TAGS = new Set(['rect', 'circle', 'line', 'path', 'polyline', 'polygon', 'use', 'br', 'hr', 'img', 'input']);

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

const kebab = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function styleToCss(style) {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${kebab(k)}:${v}`)
    .join(';');
}

function attrsToString(props) {
  const out = [];
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'children' || key === 'key' || value === undefined || value === null) continue;
    if (typeof value === 'function') continue;                 // 事件处理器在静态预览里没有意义
    if (value === false) continue;
    if (key === 'className') { if (value !== '') out.push(`class="${escapeAttr(value)}"`); continue; }
    if (key === 'style') { const css = styleToCss(value); if (css !== '') out.push(`style="${escapeAttr(css)}"`); continue; }
    if (key === 'dangerouslySetInnerHTML') continue;
    const name = KEEP_CASE.has(key) ? key : kebab(key);
    out.push(`${name}="${escapeAttr(value === true ? 'true' : value)}"`);
  }
  return out.length > 0 ? ' ' + out.join(' ') : '';
}

/** 元素树 → HTML 字符串（静态、无交互）。 */
export function toHtml(node, indent = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map((n) => toHtml(n, indent)).join('');
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node);
  if (typeof node !== 'object' || node.type === undefined) return '';
  const tag = String(node.type);
  const attrs = attrsToString(node.props);
  const kids = node.props ? node.props.children : null;
  if (VOID_TAGS.has(tag) && (kids === null || kids === undefined || kids === '' || (Array.isArray(kids) && kids.length === 0))) {
    return `<${tag}${attrs}/>`;
  }
  return `<${tag}${attrs}>${toHtml(kids, indent + 1)}</${tag}>`;
}

/** 直接渲染一个组件（纯函数调用）为 HTML。 */
export function renderToHtml(component, props) {
  return toHtml(component(props));
}
