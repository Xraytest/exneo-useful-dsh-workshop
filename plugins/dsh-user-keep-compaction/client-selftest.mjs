/**
 * dsh-user-keep-compaction 浏览器半边自测：在最小桩环境里跑 factory + apply，
 * 把**行为**走一遍（注册契约 → 取状态 → 点击 → 结果 → 头部标记）。
 * 不渲染真实 DOM、不联网、不起真定时器。
 *
 * 契约要点（逐条对应用户指令）：
 *   - 开关只有一处：输入框工具行左侧 `conversation.input.left`（id
 *     user-keep-compaction / order 24 ⇒ 紧挨 ultracode 右侧）；
 *   - **只在新会话出现**：快照不再是空白态、或 host 说属性已定死（canSet=false）
 *     就立刻不渲染；
 *   - 启用后另有**状态标记**：会话头部 `conversation.session.header.actions`
 *     （order -9 ⇒ 紧挨 Agent 预设标签「创造模式」右侧，预设标签 order -10）；
 *   - 视觉是浅灰金属压缩图标，**页面上不出现任何提示语**，全部只在 title（悬停），
 *     启用时悬停文案必须是「用户消息完全保留」；
 *   - 属性定死之后不再轮询（一次请求都不再发）。
 *
 * 运行：node plugins/dsh-user-keep-compaction/client-selftest.mjs
 *
 * @module dsh-user-keep-compaction/client-selftest
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

// ── 桩：定时器（不真跑，但让自测能手动触发一次「轮询」）────────────────────
let timerSeq = 0;
const scheduled = new Map();
globalThis.setInterval = () => ++timerSeq;
globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn) => {
  const id = ++timerSeq;
  scheduled.set(id, fn);
  return id;
};
globalThis.clearTimeout = (id) => { scheduled.delete(id); };
/** 只数某个会话的请求（其他会话的轮询定时器可能同时到点）。 */
const requestsFor = (sessionId) => requests.filter((entry) => entry.body !== null
  ? entry.body.sessionId === sessionId
  : entry.url.includes(encodeURIComponent(sessionId))).length;

/** 手动触发一次已排的轮询（模拟 POLL_MS 到点）。 */
const runPoll = async () => {
  const pending = [...scheduled.values()];
  scheduled.clear();
  for (const fn of pending) fn();
  await tick();
  await tick();
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 桩：host 状态表 + 可编程请求 ────────────────────────────────────────────
const states = new Map();
const failures = new Set();
const requests = [];

const baseStatus = (sessionId) => ({
  sessionId,
  enabled: false,
  canSet: true,
  decidedAt: null,
  live: true,
});

const programmableFetch = async (url, options) => {
  const target = String(url);
  const body = options !== undefined && options.body !== undefined ? JSON.parse(options.body) : null;
  requests.push({ url: target, body });
  const sessionId = body !== null
    ? body.sessionId
    : decodeURIComponent(target.slice(target.indexOf('sessionId=') + 'sessionId='.length));
  if (failures.has(sessionId)) throw new Error('selftest transport failure');
  if (target.includes('/set')) {
    const current = states.get(sessionId) ?? baseStatus(sessionId);
    // 与 host 一致：已定死的会话拒绝改动（HTTP 409）。
    if (current.canSet !== true) {
      return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: '该会话已经发过消息，压缩规则不可再改' }) };
    }
    const next = { ...current, enabled: body.enabled === true, decidedAt: Date.now() };
    states.set(sessionId, next);
    return { ok: true, status: 200, statusText: 'OK', json: async () => next };
  }
  return { ok: true, status: 200, statusText: 'OK', json: async () => states.get(sessionId) ?? baseStatus(sessionId) };
};

// ── 桩：模块加载器 / react（最小 hook 运行时）───────────────────────────────
let captured = null;
const styleNodes = [];
let hooks = [];
let cursor = 0;
let pendingEffects = [];
const cleanups = [];

const react = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor++;
    if (hooks.length <= index) hooks[index] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
    };
    return [hooks[index], set];
  },
  useEffect(fn) {
    cursor += 1;
    pendingEffects.push(fn);
  },
  useRef(value) {
    const index = cursor++;
    if (hooks.length <= index) hooks[index] = { current: value };
    return hooks[index];
  },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
};

globalThis.window = {
  __ModuleLoader__: { load(entry) { captured = entry; } },
  addEventListener() {}, removeEventListener() {}, innerWidth: 1440,
};
globalThis.document = {
  head: {
    appendChild(node) {
      node.parentNode = {
        removeChild(target) {
          const at = styleNodes.indexOf(target);
          if (at >= 0) styleNodes.splice(at, 1);
        },
      };
      styleNodes.push(node);
    },
  },
  createElement() { return { setAttribute() {}, textContent: '', parentNode: null }; },
  addEventListener() {}, removeEventListener() {},
};

const require = (name) => {
  if (name === 'react') return react;
  throw new Error('unexpected require: ' + name);
};

// ── 执行 bundle：注册 + apply ───────────────────────────────────────────────
new Function('window', 'document', 'require', 'fetch', source)(
  globalThis.window, globalThis.document, require, programmableFetch,
);

assert.ok(captured !== null, 'factory 未注册到 __ModuleLoader__');
assert.equal(captured.id, 'dsh-user-keep-compaction', 'boot 图 id 必须与 package.json name 一致');

const exports = captured.factory(require);
assert.deepEqual(exports.inject, ['slots'], 'inject 应只要 slots');

const registrations = [];
const injectedNames = [];
const ctx = {
  slots: {
    inject(name, fn) { injectedNames.push(name); fn(); },
    register(meta, component) { registrations.push({ meta, component }); },
  },
  effect(factory, label) { cleanups.push(factory()); return label; },
};
exports.apply(ctx);

// ── 注册契约：两个座位，位次与左邻已钉死 ────────────────────────────────────
assert.deepEqual(injectedNames, ['conversation.input.left', 'conversation.session.header.actions'], '只应注册这两处座位');
assert.equal(registrations.length, 2, '应恰好注册两个槽位条目');
const [toggleSeat, badgeSeat] = registrations;
assert.equal(toggleSeat.meta.name, 'conversation.input.left');
assert.equal(toggleSeat.meta.id, 'user-keep-compaction', '槽位 id 必须用自己的（不能复用出厂 id）');
assert.equal(toggleSeat.meta.order, 24, 'order 24：紧挨 ultracode（23）右侧');
assert.equal(badgeSeat.meta.name, 'conversation.session.header.actions');
assert.equal(badgeSeat.meta.id, 'user-keep-compaction');
assert.equal(badgeSeat.meta.order, -9, 'order -9：紧挨 Agent 预设标签（-10，「创造模式」）右侧');
assert.equal(typeof toggleSeat.component, 'function', '开关座位内容应是组件');
assert.equal(typeof badgeSeat.component, 'function', '标记座位内容应是组件');

// ── 渲染夹具：首渲染跑 effect（真的去取状态），再渲染一次读结果 ─────────────
const mount = async (component, props, snapshot) => {
  hooks = [];
  cursor = 0;
  pendingEffects = [];
  const withSession = snapshot === undefined ? props : { ...props, useSession: (selector) => selector(snapshot) };
  component(withSession);
  for (const effect of pendingEffects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
  }
  await tick();
  await tick();
  cursor = 0;
  return component(withSession);
};

const blankSession = { blank: true, promptAttempted: false, running: false };
const startedSession = { blank: false, promptAttempted: true, running: false };

/** 把 SVG 路径的 M/L/Z（含隐式重复 L）解析成多边形顶点。 */
const parsePath = (d) => {
  const points = [];
  let cursor = [0, 0];
  for (const [, cmd, raw] of d.matchAll(/([MLZ])([^MLZ]*)/g)) {
    const nums = raw.trim() === '' ? [] : raw.trim().split(/[\s,]+/).map(Number);
    if (cmd === 'M') {
      cursor = [nums[0], nums[1]];
      points.push(cursor);
    } else if (cmd === 'L') {
      for (let i = 0; i < nums.length; i += 2) {
        cursor = [nums[i], nums[i + 1]];
        points.push(cursor);
      }
    } else if (cmd === 'Z') {
      points.push(points[0]);
    }
  }
  const closed = points.length >= 4 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1];
  assert.ok(closed, '路径必须能解析出闭合多边形');
  return points;
};

/** 两条线段是否真正相交（不含仅端点相接的情况，那种由下面的距离断言兜住）。 */
const crosses = (a, b, c, d) => {
  const side = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  return ((side(c, d, a) > 0) !== (side(c, d, b) > 0)) && ((side(a, b, c) > 0) !== (side(a, b, d) > 0));
};

/** 取按钮里那个唯一的 svg 图标（页面上不得有文字），并校验它的形状契约。 */
const iconOf = (element) => {
  assert.equal(element.children.length, 1, '按钮/标记里只能有一个子节点（图标）');
  const icon = element.children[0];
  assert.equal(icon.type, 'svg', '子节点必须是内联 svg 图标');
  assert.equal(icon.props.width, icon.props.height, '图标必须正方形');
  assert.equal(icon.props.viewBox, '0 0 16 16', '图标必须按出厂的 16×16 网格画');
  const paths = icon.children.filter((child) => child.type === 'path');
  assert.equal(paths.length, 2, '图标应由两支对向人字组成（上下各一段填充路径）');
  assert.equal(icon.children.length, 2, '除两支人字外不得有别的子节点（不要渐变 defs，本部署是平涂）');
  for (const path of paths) {
    assert.equal(path.props.fill, 'currentColor', '填充必须走 currentColor（浅灰交给 CSS，主题自适应）');
  }

  const polys = paths.map((path) => parsePath(path.props.d));
  const tips = polys.map((poly) => poly[0][1]);

  /* 反证一：箭尖绝不能接触 —— 顶点重合就是两个 V 叠成一个叉（真画成过那样）。
   * 光断言间距还不够，所以再补一条几何断言：两支人字的所有边都不得相交。 */
  const gap = Math.abs(tips[0] - tips[1]);
  assert.ok(gap >= 4, `两支人字的尖端间距必须足够大（否则会读成叉/沙漏），实际 ${gap}`);
  assert.equal((tips[0] + tips[1]) / 2, 8, '两支人字必须关于图标中心线 y=8 镜像，否则重心会偏');
  let intersections = 0;
  for (let i = 0; i < polys[0].length - 1; i += 1) {
    for (let j = 0; j < polys[1].length - 1; j += 1) {
      if (crosses(polys[0][i], polys[0][i + 1], polys[1][j], polys[1][j + 1])) intersections += 1;
    }
  }
  assert.equal(intersections, 0, '两支人字绝不允许相交（相交即读成叉）');

  /* 反证二：每支都必须是「V 形带」而不是一根头发丝或一坨实心块。 */
  polys.forEach((poly, index) => {
    assert.equal(poly.length, 7, `第 ${index + 1} 支人字应有 6 个顶点（尖端 + 两翼尖 + 两侧内角 + 内尖）`);
    const ys = poly.slice(0, 6).map(([, y]) => y);
    const band = Math.max(...ys) - Math.min(...ys);
    assert.ok(band > 4, `第 ${index + 1} 支人字的张角太小，读不出箭头（跨高 ${band}）`);
    const xs = poly.slice(0, 6).map(([x]) => x);
    assert.ok(Math.max(...xs) - Math.min(...xs) >= 8, `第 ${index + 1} 支人字必须足够宽（实际 ${Math.max(...xs) - Math.min(...xs)}）`);
    assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= 16, '形状不得越出 16 网格');
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 16, '形状不得越出 16 网格');
  });
  return icon;
};

/* ── ① 开关：host 说属性已定死 ⇒ 不渲染 ──────────────────────────────────── */
states.set('s-locked', { ...baseStatus('s-locked'), canSet: false, enabled: true });
assert.equal(await mount(toggleSeat.component, { sessionId: 's-locked' }, blankSession), null,
  '属性定死后开关必须消失');

/* ── ② 开关：新会话（空白态 + canSet）⇒ 熄灭态按钮 ─────────────────────── */
states.set('s-new', baseStatus('s-new'));
const offToggle = await mount(toggleSeat.component, { sessionId: 's-new' }, blankSession);
assert.ok(offToggle !== null && offToggle !== undefined, '新会话应渲染开关');
assert.equal(offToggle.type, 'button');
assert.equal(offToggle.props.type, 'button');
assert.equal(offToggle.props['aria-pressed'], 'false', '未启用时 aria-pressed=false');
assert.equal(offToggle.props.disabled, false, '可用时不得禁用');
assert.equal(String(offToggle.props.className).includes('ukc-on'), false, '未启用时不应是点亮态');
assert.equal(offToggle.props.title.includes('点击开启'), true, '熄灭态悬停应说明点击开启');
iconOf(offToggle);
// 与同排出厂控件一致：按下时 preventDefault，保住输入框焦点。
let prevented = false;
offToggle.props.onMouseDown({ preventDefault() { prevented = true; } });
assert.equal(prevented, true, 'onMouseDown 必须真的调用 preventDefault');

/* ── ③ 点击 ⇒ 写入 enabled:true，转点亮态，悬停文案是用户指定的那句 ─────── */
requests.length = 0;
offToggle.props.onClick();
await tick();
await tick();
assert.equal(requests.length, 1, '点击应恰好发一次写请求');
assert.equal(requests[0].url, '/dsh-ukc/set');
assert.deepEqual(requests[0].body, { sessionId: 's-new', enabled: true }, '写请求载荷应是 {sessionId, enabled}');

const onToggle = await mount(toggleSeat.component, { sessionId: 's-new' }, blankSession);
assert.equal(String(onToggle.props.className).includes('ukc-on'), true, '启用后应是点亮态');
assert.equal(onToggle.props['aria-pressed'], 'true', '启用后 aria-pressed=true');
assert.equal(onToggle.props.title, '用户消息完全保留', '启用后悬停文案必须是「用户消息完全保留」');
iconOf(onToggle);

/* ── ④ 再点一次 ⇒ 关回去 ──────────────────────────────────────────────── */
onToggle.props.onClick();
await tick();
await tick();
const backOff = await mount(toggleSeat.component, { sessionId: 's-new' }, blankSession);
assert.equal(String(backOff.props.className).includes('ukc-on'), false, '再点一次应变回熄灭态');
assert.equal(backOff.props['aria-pressed'], 'false');

/* ── ⑤ 开关：快照已非空白（消息已发出）⇒ 立刻消失，不等轮询 ─────────────── */
states.set('s-sent', baseStatus('s-sent'));
assert.equal(await mount(toggleSeat.component, { sessionId: 's-sent' }, startedSession), null,
  '消息发出后开关必须立刻消失');

/* ── ⑥ 头部标记：未启用不出现，启用后带用户指定的悬停文案 ───────────────── */
states.set('s-off', baseStatus('s-off'));
assert.equal(await mount(badgeSeat.component, { sessionId: 's-off' }, startedSession), null,
  '未启用时头部不应有标记');

states.set('s-on', { ...baseStatus('s-on'), enabled: true, canSet: false });
const badge = await mount(badgeSeat.component, { sessionId: 's-on' }, startedSession);
assert.ok(badge !== null && badge !== undefined, '启用后头部应有标记');
assert.equal(badge.type, 'span', '标记应是静态 span，不是按钮（属性已定死，不提供入口）');
assert.equal(badge.props.onClick, undefined, '标记不可点击');
assert.equal(badge.props.title, '用户消息完全保留', '标记悬停文案必须是「用户消息完全保留」');
assert.equal(badge.props['aria-label'], '用户消息完全保留', '标记需给读屏同样的名字');
iconOf(badge);

/* ── ⑦ 属性定死后不再轮询（一次请求都不再发）───────────────────────────── */
requests.length = 0;
scheduled.clear();
await mount(badgeSeat.component, { sessionId: 's-on' }, startedSession);
await mount(toggleSeat.component, { sessionId: 's-on' }, startedSession);
assert.equal(requests.length, 0, '定死的会话再次挂载时不得发任何请求');
assert.equal(scheduled.size, 0, '定死的会话不得再排任何轮询定时器');

/* ── ⑧ 属性还可改时确实在轮询（不是「永远不轮询」）─────────────────────── */
states.set('s-poll', baseStatus('s-poll'));
requests.length = 0;
await mount(toggleSeat.component, { sessionId: 's-poll' }, blankSession);
const firstFetch = requests.length;
assert.equal(firstFetch >= 1, true, '挂载时应立刻取一次状态');
const pollBaseline = requestsFor('s-poll');
states.set('s-poll', { ...baseStatus('s-poll'), enabled: true });
await runPoll();
assert.equal(requestsFor('s-poll'), pollBaseline + 1, '属性还可改时应按时轮询');
const polledOn = await mount(toggleSeat.component, { sessionId: 's-poll' }, blankSession);
assert.equal(String(polledOn.props.className).includes('ukc-on'), true, '轮询到的启用态应反映到开关上');

/* ── ⑨ 写入失败：网络类只提示（留在页面上说明原因），409 视为权威（立刻收起）── */

// (a) 传输失败：本地面不变（仍可再点），原因只写进 title。
states.set('s-net', baseStatus('s-net'));
const netToggle = await mount(toggleSeat.component, { sessionId: 's-net' }, blankSession);
failures.add('s-net');
requests.length = 0;
netToggle.props.onClick();
await tick();
await tick();
assert.equal(requestsFor('s-net') >= 1, true, '点击会尝试写请求');
const afterNet = await mount(toggleSeat.component, { sessionId: 's-net' }, blankSession);
assert.ok(afterNet !== null, '传输失败不该让按钮消失');
assert.equal(afterNet.props.title.includes('selftest transport failure'), true,
  `传输失败原因应只在 title 里说明，实际 title=${afterNet.props.title}`);
failures.delete('s-net');

// (b) 409（host 说属性已定死）：这是权威答复，按钮必须立刻收起，不再让人点第二次。
states.set('s-reject', { ...baseStatus('s-reject'), enabled: true });
const rejected = await mount(toggleSeat.component, { sessionId: 's-reject' }, blankSession);
assert.equal(String(rejected.props.className).includes('ukc-on'), true, '点之前是点亮态');
states.set('s-reject', { ...baseStatus('s-reject'), canSet: false, enabled: false });
rejected.props.onClick();
await tick();
await tick();
assert.equal(await mount(toggleSeat.component, { sessionId: 's-reject' }, blankSession), null,
  '409 之后开关必须立刻消失（host 已定死，不必等下一次轮询）');

/* ── ⑩ 别处把属性定死：下一次轮询看到 canSet=false ⇒ 开关自动消失 ──────── */
states.set('s-later', baseStatus('s-later'));
const laterToggle = await mount(toggleSeat.component, { sessionId: 's-later' }, blankSession);
assert.ok(laterToggle !== null, '新会话先有开关');
// 模拟「同一个会话在别处发出了第一条消息」：host 侧变成不可改。
states.set('s-later', { ...baseStatus('s-later'), canSet: false });
const laterBaseline = requestsFor('s-later');
await runPoll();
assert.equal(requestsFor('s-later'), laterBaseline + 1, '轮询应再取一次状态');
assert.equal(await mount(toggleSeat.component, { sessionId: 's-later' }, blankSession), null,
  '轮询到 canSet=false 后开关必须消失（属性定死即不可再改）');

/* ── ⑪ 样式只注入一次，卸载时带走 ──────────────────────────────────────── */
assert.equal(styleNodes.length, 1, '应只注入一份 <style>');
assert.equal(styleNodes[0].textContent.includes('.ukc-toggle'), true, '样式应包含开关类');
assert.equal(styleNodes[0].textContent.includes('.ukc-badge'), true, '样式应包含标记类');
assert.equal(styleNodes[0].textContent.includes('ukc-breathe'), true, '样式应包含忙碌动画');
const dispose = cleanups[0];
assert.equal(typeof dispose, 'function', 'apply 应登记样式清理');
dispose();
assert.equal(styleNodes.length, 0, '卸载后 <style> 必须被移除');

process.stdout.write('CLIENT SELFTEST PASS（2 处座位契约 + 开关/标记行为 + 轮询起停语义）\n');
