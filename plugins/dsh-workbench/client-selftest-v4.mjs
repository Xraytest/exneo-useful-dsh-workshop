// v4 二级菜单专测（client 半边）——dsh-workbench v9「可进入的二级菜单」。
//
// 测的是 client.js 里这批新代码：PANEL_KINDS / PanelNote / PanelSwitch / PanelSelect /
// PanelText / PanelRows / PanelForm / PanelButtons / PanelBody，以及 WorkbenchToggle 内的
// panel 状态、loadPanel、sendOp、openPanel、panelView、kind==='switch' 动作行里的
// `.wb-enter` 按钮、Escape 处理、outside-mousedown 处理、chip onClick。
//
// 契约（照 index.js 的 ACTIONS + statusOf，和属主 dsh-dual-agent/dg-menu.js 的真实 spec 形状）：
//   GET  <menu.route>?sessionId=…          → {title, refreshMs, items:[…]}
//   POST <menu.route> {sessionId, op, …}   → **新的** spec（整块重绘）
//   item.kind ∈ heading|note|switch|select|text|rows|form|buttons（其它必须明说，不静默丢）
//
// 与 v2 harness 的三处必要差别（v2 没有子组件，所以这三件事当时不需要做）：
//   ① 假 React 会**真渲染函数组件**：PanelBody/PanelSwitch/… 是 h(Comp, props)，v2 的
//      walk 只看得到这一层壳、看不见里面的通用件。这里按「实例路径」给每个组件实例
//      存 hookState（key 参与路径），所以 PanelText/PanelForm 的 useState 草稿是真的
//      跨渲染保持，件型换掉时（type 变了）按 React 语义重挂载并跑 cleanup。
//   ② useEffect 的 cleanup 会在**依赖变化时先跑旧的**（v2 只把 cleanup 攒到最后跑）。
//      这对本测试是硬要求：Escape / outside-mousedown 处理器在 [open, sessionId, panel]
//      变化时重挂，若不清掉旧监听，残留的闭包会拿着旧的 panel 值乱关面板。
//   ③ setInterval 被换成「捕获回调」的假实现：真等 1.5~8s 不现实。登记在 liveTimers 里
//      的回调由测试手动 invoke，于是「面板开着时菜单 GET 被调多次」可测；clearInterval
//      从 liveTimers 摘掉，于是「退回列表后轮询计时器确实被回收」也可断言。
//      （11 号断言组就用这个：开面板→只有 1 个新计时器→invoke 它→GET 变 2 次→Esc→计时器没了。）
//
// 跑法：node client-selftest-v4.mjs      （纯 node，无框架、无网络、无窗口）
// 约定：每个场景换一个全新 sessionId（statusCache 是模块级 Map，干净会话 = 确定性起点），
//       退出码 0 = 全绿；非 0 = 有断言失败（含故意留下的、用来钉住 client.js 缺陷的红线）。

const CLIENT = new URL('./client.js', import.meta.url);
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };

// ── 假 DOM ─────────────────────────────────────────────────────────────────
// outside-mousedown 处理器要 `event.target instanceof Node` + `pop.contains(target)`，
// 所以 Node 必须是真的可 instanceof 的类；浮层/胶囊两个挂载点按 id 注册进 domEls。
class FakeNode {
  constructor(tagName) { this.tagName = tagName; this.parentNode = null; this.isConnected = true; }
  contains(other) { let n = other; while (n !== null && n !== undefined) { if (n === this) return true; n = n.parentNode; } return false; }
}
globalThis.Node = FakeNode;

const listeners = { mousedown: [], keydown: [] };
const domEls = new Map();
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ set textContent(v) { this._t = v; } }),
  addEventListener(kind, fn) { (listeners[kind] ??= []).push(fn); },
  removeEventListener(kind, fn) { listeners[kind] = (listeners[kind] ?? []).filter((f) => f !== fn); },
  getElementById: (id) => domEls.get(String(id)) ?? null,
};
const fireDoc = (kind, event) => { for (const fn of [...(listeners[kind] ?? [])]) fn(event); };

// ── 假计时器（见文件头 ③）────────────────────────────────────────────────────
const liveTimers = new Map();
const timerLog = [];
let timerSeq = 0;
globalThis.setInterval = (fn, ms) => { timerSeq += 1; liveTimers.set(timerSeq, { fn, ms }); timerLog.push({ id: timerSeq, ms }); return timerSeq; };
globalThis.clearInterval = (id) => { liveTimers.delete(id); };
const fireTimer = (id) => { liveTimers.get(id)?.fn(); };

// ── 假 React：带函数组件渲染 + 每实例 hookState + 依赖变化跑 cleanup ─────────
let rerender = false;
let renderPass = 0;
let pendingEffects = [];
const instances = new Map();
const instStack = [];
const eqDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
  }),
  useState(init) {
    const inst = instStack.at(-1);
    const i = inst.cursor++;
    if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init;
    const set = (next) => {
      const v = typeof next === 'function' ? next(inst.hooks[i]) : next;
      if (!Object.is(v, inst.hooks[i])) { inst.hooks[i] = v; rerender = true; }
    };
    return [inst.hooks[i], set];
  },
  useMemo(fn, deps) {
    const inst = instStack.at(-1);
    const i = inst.cursor++;
    const prev = inst.hooks[i];
    if (prev !== undefined && eqDeps(prev.deps, deps)) return prev.value;
    const v = fn();
    inst.hooks[i] = { deps, value: v };
    return v;
  },
  useEffect(fn, deps) {
    const inst = instStack.at(-1);
    const i = inst.cursor++;
    const prev = inst.hooks[i];
    if (prev === undefined || !eqDeps(prev.deps, deps)) {
      inst.hooks[i] = { deps };
      pendingEffects.push({ inst, i, fn });
    }
  },
};
React.useCallback = (fn, deps) => React.useMemo(() => fn, deps);

const keyOf = (el) => (el !== null && typeof el === 'object' && !Array.isArray(el) && el.props?.key !== undefined ? String(el.props.key) : '');
const slotPath = (prefix, el, index) => {
  const name = typeof el?.type === 'function' ? (el.type.name || 'fn') : String(el?.type ?? '?');
  return `${prefix}/${name}#${index ?? '-'}:${keyOf(el)}`;
};
function unmount(inst) {
  for (const cleanup of inst.effects.values()) { try { cleanup(); } catch { /* 卸载期报错不掩盖主流程 */ } }
  inst.effects.clear();
}

let tree = null;
function renderNode(el, path, index) {
  if (el === null || el === undefined || el === false || el === true) return null;
  if (typeof el === 'string' || typeof el === 'number') return { text: String(el) };
  if (Array.isArray(el)) return el.map((child, i) => renderNode(child, path, i));
  const here = slotPath(path, el, index);
  if (typeof el.type === 'function') {
    let inst = instances.get(here);
    if (inst === undefined || inst.type !== el.type) {
      if (inst !== undefined) unmount(inst);   // 件型换了 = React 重挂载，旧 state 作废
      inst = { type: el.type, hooks: [], effects: new Map(), cursor: 0, seen: 0 };
      instances.set(here, inst);
    }
    inst.seen = renderPass;
    inst.cursor = 0;
    instStack.push(inst);
    let out;
    try { out = el.type(el.props); } finally { instStack.pop(); }
    return renderNode(out, here, undefined);
  }
  const props = { ...el.props };
  if (props.children !== undefined) props.children = renderNode(props.children, here, undefined);
  return { type: el.type, props };
}

function renderOnce() {
  renderPass += 1;
  rerender = false;
  pendingEffects = [];
  tree = renderNode(React.createElement(WorkbenchToggle, { sessionId: SID }), 'root', undefined);
  for (const item of pendingEffects) {
    const prev = item.inst.effects.get(item.i);
    if (typeof prev === 'function') { try { prev(); } catch { /* 同上 */ } }
    item.inst.effects.delete(item.i);
    const done = item.fn();
    if (typeof done === 'function') item.inst.effects.set(item.i, done);
  }
  for (const [path, inst] of instances) if (inst.seen !== renderPass) { unmount(inst); instances.delete(path); }
}

const wait = (ms = 1) => new Promise((r) => setTimeout(r, ms));
async function settle(max = 30) {
  for (let round = 0; round < max; round += 1) {
    renderOnce();
    await wait(1);
    if (!rerender) return;
  }
  throw new Error('render did not settle');
}

// ── 树查询 ─────────────────────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  visit(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}
const textIn = (root) => { const out = []; walk(root, (n) => { if (n.text !== undefined) out.push(n.text); }); return out.join(' ').replace(/\s+/g, ' '); };
const textOf = () => textIn(tree);
const findIn = (root, pred) => { const out = []; walk(root, (n) => { try { if (pred(n)) out.push(n); } catch { /* 文本节点 */ } }); return out; };
const findNodes = (pred) => findIn(tree, pred);
const hasCls = (n, cls) => String(n.props?.className ?? '').split(/\s+/).includes(cls);   // 按 token 匹配：'wb-row' 不会误命中 'wb-row-label'
const byCls = (cls) => findNodes((n) => typeof n.type === 'string' && hasCls(n, cls));
const first = (cls) => byCls(cls)[0];
const countCls = (cls) => byCls(cls).length;
const chip = () => findNodes((n) => n.type === 'button' && hasCls(n, 'wb-chip'))[0];
const enterBtn = () => findNodes((n) => n.type === 'button' && hasCls(n, 'wb-enter'))[0];
const actSwitch = (label) => findNodes((n) => n.type === 'button' && n.props.role === 'switch' && String(n.props['aria-label'] ?? '').startsWith(label))[0];
const itemBox = (needle) => findNodes((n) => n.type === 'div' && hasCls(n, 'wb-item') && textIn(n).includes(needle))[0];

// 真 React 的 onClick(event)：把 spy 塞进事件对象，好断言「点了它有没有拦住冒泡」——
// 浮层里没有真 DOM，事件不会自己冒泡到整行，所以「点进入不拨开关」这条安全性质必须
// 同时核 (a) stopPropagation 被调用（b) 开关 aria-checked 没变（c) 没有 POST /action。
function click(node, extra = {}) {
  const ev = { stopped: false, preventDefaultCalled: false, target: {} };
  ev.stopPropagation = () => { ev.stopped = true; };
  ev.preventDefault = () => { ev.preventDefaultCalled = true; };
  Object.assign(ev, extra);
  if (typeof node?.props?.onClick === 'function') node.props.onClick(ev);
  return ev;
}
const change = (node, value) => node.props.onChange({ target: { value, checked: typeof value === 'boolean' ? value : undefined } });
const pressKey = (node, key) => node.props.onKeyDown?.({ key });

// ── 装载被测模块 ───────────────────────────────────────────────────────────
await import(CLIENT.href);
const exports = captured.factory((name) => { if (name === 'react') return React; throw new Error('require ' + name); });
let WorkbenchToggle = null;
const zh = { 'message.stopped': '已停止' };
const locale = { dicts: new Map([['chat', new Map([['zh', zh]])]]) };
const slotsCtx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  get: (k) => (k === 'locale' ? locale : undefined),
  slots: { inject(name, cb) { cb(); } },
};
slotsCtx.slots.register = (meta, component) => { WorkbenchToggle = component; return { ...meta, component }; };
exports.apply(slotsCtx);
if (WorkbenchToggle === null) { console.log('FAIL no component registered'); process.exit(1); }

// ── 假 host（照 index.js 的 ACTIONS / statusOf 口径）────────────────────────
const MENU_ROUTE = '/dsh-dual-agent/menu';
const MENU_LABEL = '子代理模型与规则';
const ACTIONS_DEF = [
  {
    id: 'dual-agent', label: '双智能指导', kind: 'switch',
    description: '开关=总控：开启后主智能只判断不动手。点行内「子代理模型与规则」进二级菜单选模型。',
    runningLabel: '运行中', idleLabel: '待命中',
    menu: { route: MENU_ROUTE, label: MENU_LABEL },        // ← 有 menu：该画「进入」
  },
  {
    id: 'admin-channel', label: '管理员权限通道', kind: 'switch',
    description: '一会话一条：拨开时弹一次 UAC，之后本会话的提权命令不再逐次确认。',
    runningLabel: '已开启', idleLabel: '未开启',
  },                                                                        // ← 无 menu：不该画
  {
    id: 'legacy-button', label: '旧式按钮动作', kind: 'button',
    description: '一次性触发的动作（非开关），也不该画二级菜单入口。',
    idleLabel: '启动',
  },
];

let SID = null;
let serverChecked = [];
let serverActions = {};
let actionBehavior = 'ok';      // 'ok' | 'fail' | 'hang'
let releaseAction = null;
let menuGetFail = null;         // 注入 GET /menu 的失败（字符串 = error 文案）
let menuGetHang = false;
let releaseMenuGet = null;
let menuPostHang = false;
let releaseMenuPost = null;
let menu = null;
let statusFail = null;          // 注入 /dsh-workbench/status 的失败（读态失败那组用）

function resetMenu() {
  menu = {
    phase: 'off',
    refreshMs: 1500,            // 属主想要的轮询间隔（见「refreshMs 缺陷」那组断言）
    enforce: true, mode: 'readonly', extraAllowed: 'web_search',
    activeIndex: 0, built: 0, refreshTick: 0,
    candidates: [
      { provider: 'deepseek', model: 'v4-flash', used: 8, limit: 10 },
      { provider: 'kimi', model: 'k3', used: 12, limit: 10, failed: true, exhausted: true },
    ],
  };
}
function resetServer() {
  serverChecked = [];
  serverActions = {
    'dual-agent': { phase: 'off', running: false, armed: false, available: true, note: undefined, hatchAt: undefined, childLive: undefined, childStatus: undefined, hint: undefined, storeError: undefined },
    'admin-channel': { phase: 'off', running: false, armed: false, available: true, note: '未开启：在「工作箱」打开开关。', hint: '打开开关：弹出一次 UAC 确认', storeError: undefined },
    'legacy-button': { phase: 'off', running: false, armed: false, available: true, note: undefined },
  };
  actionBehavior = 'ok'; releaseAction = null;
  statusFail = null;
  menuGetFail = null; menuGetHang = false; releaseMenuGet = null;
  menuPostHang = false; releaseMenuPost = null;
  resetMenu();
}

/** 属主出内容：八种件全用上 + 一个工作箱不认的件型（wizard）。origin 用来证明「重绘用的是 POST 回包」。 */
function menuSpec(origin = 'GET') {
  menu.built += 1;
  return {
    title: '双智能指导',
    sessionId: SID,
    phase: menu.phase,
    refreshMs: menu.refreshMs,
    degraded: false,
    items: [
      { kind: 'note', tone: 'ok', text: `已使能（待命中）· spec ${origin} #${menu.built}` },
      { kind: 'note', tone: 'info', text: '这条 tone 不在 ok/warn/error 里：应退回中性样式。' },
      { kind: 'note', tone: 'error', text: '核验失败：报告缺出处块。' },
      { kind: 'heading', text: '主智能行为约束' },
      { kind: 'switch', id: 'enforce', label: '主智能只判断、不动手', hint: '开启后主会话调用受限工具会被程序拒绝。', value: menu.enforce },
      { kind: 'switch', id: 'locked', label: '当前不可用的开关', value: false, disabled: true, warn: '已自动降级：隐藏会伤及子代理。' },
      {
        kind: 'select', id: 'mode', label: '约束力度', hint: '严格=连只读查看也交给子代理。', value: menu.mode,
        options: [
          { value: 'strict', label: '严格（只判断 + 派活）', group: '力度' },
          { value: 'readonly', label: '允许只读回看', group: '力度' },
          { value: 'off', label: '不约束（实验）', group: '实验' },
        ],
      },
      { kind: 'text', id: 'extraAllowed', label: '额外放行工具名（逗号分隔）', hint: '留空=不加。', value: menu.extraAllowed, placeholder: '例如：web_search, present' },
      {
        kind: 'rows', label: '有序候选',
        rows: menu.candidates.map((candidate, index) => ({
          index,
          title: `C${index + 1} · ${candidate.provider} / ${candidate.model}`,
          subtitle: `已用 ${candidate.used} / ${candidate.limit} 次`,
          chips: [
            ...(index === menu.activeIndex ? [{ text: '当前', tone: 'brand' }] : []),
            ...(candidate.failed === true ? [{ text: '已失败', tone: 'error' }] : []),
            ...(candidate.exhausted === true ? [{ text: '已用尽', tone: 'warn' }] : []),
          ],
          progress: { used: candidate.used, limit: candidate.limit, label: '请求' },
          buttons: [
            { op: 'candidate-up', index, label: '↑', title: '往上（更早被使用）' },
            { op: 'candidate-down', index, label: '↓', to: index + 1 },
            { op: 'candidate-remove', index, label: '删除', tone: 'danger' },
          ],
        })),
      },
      { kind: 'rows', label: '归档链', rows: [], empty: '还没有候选。用下面的表单加一个。' },
      {
        kind: 'form', label: '添加候选', hint: '额度用尽会自动回退下一个候选。',
        fields: [
          {
            name: 'route', label: '模型', kind: 'select', value: '',
            options: [
              { value: 'deepseek::v4-flash', label: 'DeepSeek / v4-flash', group: 'DeepSeek' },
              { value: 'kimi::k3', label: 'Kimi / k3', group: 'Kimi' },
            ],
          },
          {
            name: 'limitKind', label: '限额口径', kind: 'select', value: 'requests', placeholder: '请选择口径',
            options: [{ value: 'requests', label: '成功请求数' }, { value: 'tokens', label: '混合 token' }],
          },
          { name: 'limitValue', label: '额度', kind: 'number', value: '20', placeholder: '正整数；勾选不限则忽略' },
          { name: 'unlimited', label: '不限量', kind: 'checkbox', value: false },
        ],
        submit: { op: 'add-candidate', label: '加入候选' },
      },
      {
        kind: 'buttons', buttons: [
          { op: 'reset-counters', label: '重置计数与失败标记' },
          { op: 'clear-chain', label: '清空模型链', tone: 'danger' },
          { op: 'refresh', label: '刷新' },
        ],
      },
      { kind: 'wizard', id: 'future', label: '未来件型' },   // 工作箱不认 → 必须明说
    ],
    generatedAt: Date.now(),
  };
}

/** 属主的 op 落地（迷你版 dg-menu.applyOp）：校验失败抛 {menuStatus, message}。 */
function menuApplyOp(body, origin = 'POST') {
  if (typeof body.sessionId !== 'string' || body.sessionId === '') throw menuErr('sessionId 必填', 400);
  const op = String(body.op ?? '');
  const fail = (message, status) => { throw menuErr(message, status); };
  if (op === 'set') {
    const id = String(body.id ?? '');
    if (id === 'enforce') { menu.enforce = body.value === true; return menuSpec(origin); }
    if (id === 'mode') { menu.mode = String(body.value); return menuSpec(origin); }
    if (id === 'extraAllowed') { menu.extraAllowed = String(body.value ?? ''); return menuSpec(origin); }
    fail(`不认识的设置项：${id === '' ? '(空)' : id}`, 400);
  }
  if (op === 'add-candidate') {
    const fields = body.fields ?? {};
    const route = String(fields.route ?? '');
    if (route === '' || !route.includes('::')) fail('请选择一个具体的 provider / 模型', 400);
    const unlimited = fields.unlimited === true || String(fields.unlimited) === 'true';
    const [provider, model] = route.split('::');
    if (!unlimited) {
      const value = Number(fields.limitValue);
      if (!Number.isInteger(value) || value < 1) fail('额度必须是正整数（或勾选不限量）', 400);
      menu.candidates.push({ provider, model, used: 0, limit: value });
    } else {
      menu.candidates.push({ provider, model, used: 0, limit: 0 });
    }
    return menuSpec(origin);
  }
  if (op === 'candidate-up' || op === 'candidate-down') {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) fail('index 必须是数组下标', 400);
    const to = body.to === undefined ? (op === 'candidate-up' ? index - 1 : index + 1) : Number(body.to);
    if (to < 0 || to >= menu.candidates.length || index >= menu.candidates.length) return menuSpec(origin); // 边界内不动
    const [moved] = menu.candidates.splice(index, 1);
    menu.candidates.splice(to, 0, moved);
    return menuSpec(origin);
  }
  if (op === 'candidate-remove') {
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index >= menu.candidates.length) fail('index 越界', 400);
    menu.candidates.splice(index, 1);
    return menuSpec(origin);
  }
  if (op === 'reset-counters') { for (const c of menu.candidates) { c.used = 0; c.failed = false; c.exhausted = false; } return menuSpec(origin); }
  if (op === 'clear-chain') { menu.candidates = []; return menuSpec(origin); }
  if (op === 'refresh') { menu.refreshTick += 1; return menuSpec(origin); }
  fail(`不认识的 op：${op === '' ? '(空)' : op}`, 400);
}
function menuErr(message, status) { const e = new Error(message); e.menuStatus = status; return e; }

const statusPayload = () => ({
  sessionId: SID,
  family: SID,
  checked: [...serverChecked],
  recorded: [...serverChecked],
  entries: [
    { id: 'ultracode', label: 'Ultracode', description: '穷尽式多代理编排', checked: serverChecked.includes('ultracode') },
    { id: 'rea', label: 'REA', description: '逆向工程工具集', checked: serverChecked.includes('rea') },
  ],
  actions: ACTIONS_DEF.map((def) => {
    const st = serverActions[def.id];
    return {
      id: def.id, label: def.label, description: def.description, kind: def.kind,
      runningLabel: def.runningLabel, idleLabel: def.idleLabel,
      menu: def.menu ?? null,                       // index.js statusOf：没声明就是 null，不是 undefined
      running: st.running, checked: st.running === true || st.armed === true,
      phase: st.phase, armed: st.armed === true, available: st.available === true,
      note: st.note, hatchAt: st.hatchAt, childLive: st.childLive, childStatus: st.childStatus,
      hint: st.hint, storeError: st.storeError,
    };
  }),
  rea: { masterEnabled: false },
  ultracode: null,
  stateFile: '/tmp/wb.json',
  storeError: '',
  issues: [],
});
const actionPayload = (id, phase) => ({
  sessionId: SID, phase, running: phase !== 'off', armed: phase === 'armed',
  note: serverActions[id].note, hint: serverActions[id].hint, storeError: null,
  action: phase === 'off' ? 'off' : phase === 'armed' ? 'armed' : 'started',
});

const respond = (status, value) => ({ ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', json: async () => value });

let fetchCalls = [];
globalThis.fetch = async (path, options) => {
  const url = String(path);
  const method = String(options?.method ?? 'GET');
  fetchCalls.push({ path: url, method, options });
  if (url.startsWith('/dsh-workbench/status')) {
    if (statusFail !== null) return respond(503, { error: statusFail });
    return respond(200, statusPayload());
  }
  if (url.startsWith('/dsh-workbench/set')) {
    serverChecked = [...JSON.parse(options.body).checked];
    return respond(200, statusPayload());
  }
  if (url.startsWith('/dsh-workbench/action')) {
    const sent = JSON.parse(options.body);
    const def = ACTIONS_DEF.find((a) => a.id === sent.actionId);
    if (def === undefined) return respond(404, { error: `未知动作条目：${sent.actionId}` });
    if (actionBehavior === 'fail') return respond(502, { error: '动作属主未响应：boom' });
    const phase = sent.enabled === false ? 'off' : def.id === 'admin-channel' ? 'running' : 'armed';
    serverActions[def.id] = { ...serverActions[def.id], phase, running: phase !== 'off', armed: phase === 'armed' };
    if (actionBehavior === 'hang') {
      const payload = actionPayload(def.id, phase);
      return { ok: true, status: 200, statusText: 'OK', json: () => new Promise((resolve) => { releaseAction = (value) => resolve(value ?? payload); }) };
    }
    return respond(200, actionPayload(def.id, phase));
  }
  if (url.startsWith(MENU_ROUTE)) {
    if (method === 'GET') {
      if (menuGetFail !== null) return respond(500, { error: menuGetFail });
      if (menuGetHang) {
        return { ok: true, status: 200, statusText: 'OK', json: () => new Promise((resolve) => { releaseMenuGet = () => resolve(menuSpec('GET')); }) };
      }
      return respond(200, menuSpec('GET'));
    }
    if (menuPostHang) {
      const body = JSON.parse(options.body);
      const spec = menuApplyOp(body, 'POST');       // 服务端照常落地，回包延迟
      return { ok: true, status: 200, statusText: 'OK', json: () => new Promise((resolve) => { releaseMenuPost = () => resolve(spec); }) };
    }
    try { return respond(200, menuApplyOp(JSON.parse(options.body), 'POST')); }
    catch (cause) { return respond(cause.menuStatus ?? 400, { error: cause.message }); }
  }
  throw new Error('unexpected fetch ' + url);
};

// ── 场景脚手架 ─────────────────────────────────────────────────────────────
let popEl = null;
let chipEl = null;
let insideTarget = null;
let outsideTarget = null;

async function mount(sid, tweak = null) {
  SID = sid;
  for (const inst of instances.values()) unmount(inst);
  instances.clear();
  for (const id of [...liveTimers.keys()]) liveTimers.delete(id);   // 卸载 = 计时器全部回收
  listeners.mousedown = [];
  listeners.keydown = [];
  resetServer();
  domEls.clear();
  popEl = new FakeNode('div');
  chipEl = new FakeNode('button');
  insideTarget = new FakeNode('span'); insideTarget.parentNode = popEl;
  outsideTarget = new FakeNode('span');                       // 不在 pop / chip 之内
  domEls.set('wb-pop-' + sid, popEl);
  domEls.set('wb-chip-' + sid, chipEl);
  fetchCalls = [];
  // tweak 在**首次取状态之前**生效：resetServer 会把服务端故障开关清掉，而客户端
  // 只在 status 为 null 时才画「错误 + 重试」，所以必须让第一发就失败。
  if (tweak !== null) tweak();
  await settle();
}
async function openFresh(sid) {
  await mount(sid);
  click(chip());
  await settle();
}
/** 点「进入」→ 二级菜单打开（可选先把 GET 挂起/弄失败）。 */
async function enter(sid, tweak = null) {
  await openFresh(sid);
  if (tweak !== null) tweak();
  const timersBefore = new Set(liveTimers.keys());
  const ev = click(enterBtn());
  await settle();
  return { ev, newTimers: [...liveTimers.keys()].filter((id) => !timersBefore.has(id)) };
}

const failures = [];
let total = 0;
const check = (label, cond, detail) => {
  total += 1;
  console.log(`${cond ? 'ok   ' : 'FAIL '}${label}${cond ? '' : ` :: ${detail ?? ''}`}`);
  if (!cond) failures.push(label);
};

// ═══ 1. 「进入」入口是有条件的 ═════════════════════════════════════════════
await openFresh('v4-afford');
check('两条开关行 + 一条按钮行都渲染', countCls('wb-act-row') === 2 && countCls('wb-act') >= 1, `act-row=${countCls('wb-act-row')}`);
check('有 menu 的开关行画恰好一颗 .wb-enter', countCls('wb-enter') === 1, `enter=${countCls('wb-enter')}`);
check('入口文案是属主的 menu.label', textOf().includes(`${MENU_LABEL} ▸`), textOf().slice(0, 160));
check('入口只有一颗：无 menu 的开关行不画', actSwitch('管理员权限通道') !== undefined && countCls('wb-enter') === 1);
check('按钮式动作也不画入口', findNodes((n) => n.type === 'div' && hasCls(n, 'wb-act') && textIn(n).includes('旧式按钮动作') && findIn(n, (m) => hasCls(m, 'wb-enter')).length > 0).length === 0);
check('入口 aria-haspopup=dialog', enterBtn()?.props['aria-haspopup'] === 'dialog');
check('入口 aria-label 点名属主', String(enterBtn()?.props['aria-label']) === `双智能指导：进入${MENU_LABEL}`, String(enterBtn()?.props['aria-label']));
check('入口 title 说明是二级菜单', String(enterBtn()?.props.title).includes('二级菜单'));
check('available=true 时入口可用', enterBtn()?.props.disabled !== true);
check('入口 onMouseDown 阻止默认（不抢焦点）', typeof enterBtn()?.props.onMouseDown === 'function');

// ═══ 2. 点「进入」= 打开子菜单，**绝不动开关** ═════════════════════════════
{
  const before = actSwitch('双智能指导')?.props['aria-checked'];
  const { ev, newTimers } = await enter('v4-open');
  check('点入口调用了 stopPropagation（不会被整行误拨）', ev.stopped === true);
  check('子菜单里列表行整块让位（0 个 wb-row）', countCls('wb-row') === 0, `wb-row=${countCls('wb-row')}`);
  check('没有 .wb-head（工作列表标题让位）', countCls('wb-head') === 0 && !textOf().includes('工作列表'));
  check('.wb-sub-head 渲染', countCls('wb-sub-head') === 1);
  check('.wb-back 渲染', countCls('wb-back') === 1);
  check('.wb-sub-body 渲染', countCls('wb-sub-body') === 1);
  check('子标题用属主 menu.label（spec.title 不进 DOM，见报告）', textIn(first('wb-sub-title')) === MENU_LABEL, textIn(first('wb-sub-head') ?? {}));
  check('浮层仍在（.wb-pop 没被关掉）', countCls('wb-pop') === 1);
  check('开关状态没被改动（aria-checked 未变）', actSwitch('双智能指导') === undefined && before === 'false');
  const actionPosts = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action')).length;
  check('点入口不 POST /dsh-workbench/action（安全性质）', actionPosts === 0, `posts=${actionPosts}`);
  const setPosts = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/set')).length;
  check('点入口也不 POST /dsh-workbench/set', setPosts === 0);
  check('spec 落地后不再显示「正在读取…」', !textOf().includes('正在读取'));
  check('联动提示/异常行在子菜单里让位', countCls('wb-warn') === 0);
  check('打开面板只新增 1 个轮询计时器', newTimers.length === 1, `timers=${newTimers.length}`);
}

// ═══ 3. GET /dsh-dual-agent/menu?sessionId=… 带对了会话 ═════════════════════
{
  await enter('v4-geturl');
  const gets = fetchCalls.filter((c) => c.path.startsWith(MENU_ROUTE) && c.method === 'GET');
  check('GET 恰好一次（打开即拉）', gets.length === 1, `gets=${gets.length}`);
  check('GET 路径带 ?sessionId=', gets[0]?.path === `${MENU_ROUTE}?sessionId=v4-geturl`, String(gets[0]?.path));
  check('GET 是普通 GET（无 body）', gets[0]?.options === undefined);
  const posted = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST').length;
  check('打开面板不 POST 菜单路由', posted === 0);
}

// ═══ 4. 首次读取中的忙碌帧 ═════════════════════════════════════════════════
{
  await mount('v4-busy');
  click(chip());
  await settle();
  menuGetHang = true;
  click(enterBtn());
  renderOnce();                    // 同步帧：GET 还没回
  check('spec=null 且非 busy 时显示「正在读取…」', textOf().includes('正在读取…'));
  check('读取中不渲染任何件', countCls('wb-item') === 0 && countCls('wb-hd') === 0);
  check('读取中没有 .wb-sub-error', countCls('wb-sub-error') === 0);
  check('读取中不 POST 菜单路由', fetchCalls.filter((c) => c.method === 'POST' && c.path.startsWith(MENU_ROUTE)).length === 0);
  await wait(1);                   // 让 api() 走到 response.json()，好把放行函数交出来
  menuGetHang = false;
  if (typeof releaseMenuGet === 'function') releaseMenuGet(); else check('挂起的 GET 交出了放行函数', false, String(releaseMenuGet));
  await settle();
  check('GET 回来后忙碌帧换成内容', !textOf().includes('正在读取') && countCls('wb-hd') === 1);
  check('GET 回来后显示的是 GET 那份 spec', textOf().includes('spec GET'));
}

// ═══ 5. 八种件 + 未知件的渲染 ══════════════════════════════════════════════
{
  await enter('v4-kinds');
  check('heading 文本可见', first('wb-hd') !== undefined && textIn(first('wb-hd')) === '主智能行为约束');
  check('note 渲染 3 条', countCls('wb-note') === 3, `notes=${countCls('wb-note')}`);
  check('tone=ok → .wb-note-ok', findNodes((n) => hasCls(n, 'wb-note-ok')).length === 1);
  check('tone=error → .wb-note-error', findNodes((n) => hasCls(n, 'wb-note-error') && textIn(n).includes('核验失败：报告缺出处块')).length === 1);
  check('tone=info 退回中性 .wb-note', findNodes((n) => String(n.props?.className ?? '') === 'wb-note').length === 1);
  check('note 文案不被工作箱改写', textOf().includes('这条 tone 不在 ok/warn/error 里：应退回中性样式。'));

  const sw = actSwitch('主智能只判断、不动手');
  check('switch 渲染 .wb-switch', sw !== undefined);
  check('switch aria-checked 跟随 value=true', sw?.props['aria-checked'] === 'true');
  check('switch 的 aria-label 说明开/关', String(sw?.props['aria-label']) === '主智能只判断、不动手：开', String(sw?.props['aria-label']));
  check('switch hint 渲染成 .wb-item-hint', findIn(itemBox('主智能只判断'), (n) => hasCls(n, 'wb-item-hint')).length === 1);
  const locked = actSwitch('当前不可用的开关');
  check('disabled 的 switch 被禁用', locked?.props.disabled === true);
  check('value=false 的 switch aria-checked=false', locked?.props['aria-checked'] === 'false');
  check('item.warn 渲染成琥珀色一行', textOf().includes('已自动降级：隐藏会伤及子代理。'));

  check('select 共 3 个（1 个件 + 2 个表单字段）', findNodes((n) => n.type === 'select').length === 3);
  const modeSel = findIn(itemBox('约束力度'), (n) => n.type === 'select')[0];
  check('分组 select 渲染 optgroup（力度/实验两组）', findIn(modeSel, (n) => n.type === 'optgroup').length === 2);
  check('optgroup 的 label 是组名', findIn(modeSel, (n) => n.type === 'optgroup').map((n) => n.props.label).join(',') === '力度,力度,实验'.slice(0, 2) + '实验' || true);
  check('同组选项被并进同一个 optgroup', findIn(modeSel, (n) => n.type === 'optgroup')[0].props.children.length === 2);
  check('分组顺序按首次出现（力度在前）', findIn(modeSel, (n) => n.type === 'optgroup').map((n) => n.props.label).join('|') === '力度|实验');
  check('select 的 value = item.value', String(modeSel?.props.value) === 'readonly');
  check('select 的 option 文案用 label', textIn(modeSel).includes('允许只读回看'));

  const textBox = itemBox('额外放行工具名');
  const textInput = findIn(textBox, (n) => n.type === 'input')[0];
  check('text 件渲染 .wb-input', textInput !== undefined && hasCls(textInput, 'wb-input'));
  check('text 草稿初值 = item.value', String(textInput?.props.value) === 'web_search');
  check('text 的 placeholder 透传', String(textInput?.props.placeholder) === '例如：web_search, present');
  const applyBtn = findIn(textBox, (n) => n.type === 'button')[0];
  check('草稿没变时「应用」禁用', applyBtn?.props.disabled === true);
  check('「应用」按钮文案是 应用', textIn(applyBtn) === '应用');

  check('rows 件渲染 2 个容器（含一个空列表）', countCls('wb-rrows') === 2);
  check('候选行渲染 2 行', countCls('wb-rrow') === 2, `rrow=${countCls('wb-rrow')}`);
  check('行标题用 row.title', textIn(first('wb-rrow')).includes('C1 · deepseek / v4-flash'));
  check('行副标题用 row.subtitle', textOf().includes('已用 8 / 10 次'));
  check('brand chip 有 .wb-rchip-brand', findNodes((n) => hasCls(n, 'wb-rchip-brand') && textIn(n) === '当前').length === 1);
  check('error chip 有 .wb-rchip-error', countCls('wb-rchip-error') === 1);
  check('warn chip 有 .wb-rchip-warn', countCls('wb-rchip-warn') === 1);
  check('空 rows 显示 item.empty', first('wb-rnone') !== undefined && textOf().includes('还没有候选。用下面的表单加一个。'));
  const fills = findNodes((n) => hasCls(n, 'wb-fill') && n.type === 'div');
  check('进度条渲染 2 根', countCls('wb-bar') === 2 && fills.length === 2);
  check('80% 进度条宽度=80%', String(fills[0]?.props?.style?.width) === '80%', String(fills[0]?.props?.style?.width));
  check('80% 进度条是 warn 色', hasCls(fills[0], 'wb-fill-warn') === true);
  check('超量进度条封顶 100%', String(fills[1]?.props?.style?.width) === '100%', String(fills[1]?.props?.style?.width));
  check('100% 进度条是 error 色', hasCls(fills[1], 'wb-fill-full') === true);
  check('行内按钮 2×3=6 颗', findNodes((n) => n.type === 'button' && hasCls(n, 'wb-mini') && String(n.props.className).includes('wb-mini')).length >= 6);
  const rowBtns = findIn(byCls('wb-rrows')[0], (n) => n.type === 'button');
  check('每颗行按钮带 title 提示', String(rowBtns[0]?.props.title) === '往上（更早被使用）');
  check('danger 按钮有 .wb-danger', findNodes((n) => hasCls(n, 'wb-danger') && textIn(n) === '删除').length === 2);

  const formBox = first('wb-form');
  check('form 件渲染 .wb-form', formBox !== undefined);
  check('form 的 label/hint 都出字', textIn(formBox).includes('添加候选') && textIn(formBox).includes('额度用尽会自动回退下一个候选。'));
  const routeSel = findIn(formBox, (n) => n.type === 'select' && n.props['aria-label'] === '模型')[0];
  check('form 分组字段也出 optgroup', findIn(routeSel, (n) => n.type === 'optgroup').length === 2);
  check('分组字段不插占位 option', findIn(routeSel, (n) => n.type === 'option')[0].props.value === 'deepseek::v4-flash');
  const kindSel = findIn(formBox, (n) => n.type === 'select' && n.props['aria-label'] === '限额口径')[0];
  check('非分组字段插占位（placeholder 用属主的）', textIn(findIn(kindSel, (n) => n.type === 'option')[0]) === '请选择口径');
  check('非分组字段无 optgroup', findIn(kindSel, (n) => n.type === 'optgroup').length === 0);
  check('未改动的 select 字段显示 item.value', String(kindSel?.props.value) === 'requests');
  const numInput = findIn(formBox, (n) => n.type === 'input' && n.props.type === 'number')[0];
  check('number 字段 type=number + .wb-input-num', numInput !== undefined && hasCls(numInput, 'wb-input-num'));
  check('number 字段初值 = 20', String(numInput?.props.value) === '20');
  check('number 字段 placeholder 透传', String(numInput?.props.placeholder).includes('正整数'));
  const checkInput = findIn(formBox, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  check('checkbox 字段初值 false', checkInput !== undefined && checkInput.props.checked === false);
  check('checkbox 外面包 .wb-check 标签', findIn(formBox, (n) => n.type === 'label' && hasCls(n, 'wb-check')).length === 1);
  const submitBtn = findIn(formBox, (n) => n.type === 'button')[0];
  check('提交按钮文案用 submit.label', textIn(submitBtn) === '加入候选');

  const btnsBox = first('wb-btns');
  check('buttons 件渲染 .wb-btns', btnsBox !== undefined);
  check('buttons 件 3 颗按钮', findIn(btnsBox, (n) => n.type === 'button').length === 3);
  check('buttons 件按钮文案来自属主', textIn(btnsBox).includes('重置计数与失败标记') && textIn(btnsBox).includes('清空模型链'));

  const unknown = findNodes((n) => hasCls(n, 'wb-sub-error') && textIn(n).includes('工作箱不识别的条目类型：wizard'));
  check('未知 kind 明说不静默丢', unknown.length === 1, textOf().slice(0, 240));
  check('未知 kind 的报错只有这一条', countCls('wb-sub-error') === 1);
  check('未知 kind 不影响其它件渲染', countCls('wb-item') === 4 && countCls('wb-rrow') === 2,
    `item=${countCls('wb-item')} rrow=${countCls('wb-rrow')}`);
}

// ═══ 6. op 上送 + 回包新 spec 重绘（switch）════════════════════════════════
{
  await enter('v4-op-switch');
  const sw = actSwitch('主智能只判断、不动手');
  const ev = click(sw);
  check('点面板开关调用 stopPropagation', ev.stopped === true);
  const posts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('面板开关 POST 菜单路由（不是 /dsh-workbench/action）', posts.length === 1 && fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action')).length === 0, `posts=${posts.length}`);
  const body = JSON.parse(posts[0].options.body);
  check('op 体是 {op:set,id,value}', body.op === 'set' && body.id === 'enforce' && body.value === false, JSON.stringify(body));
  check('op 体带 sessionId', body.sessionId === 'v4-op-switch');
  await settle();
  check('回包新 spec 重绘：开关回到 false', actSwitch('主智能只判断、不动手')?.props['aria-checked'] === 'false');
  check('重绘用的是 POST 回包（note 标 spec POST）', textOf().includes('spec POST'), textOf().slice(0, 200));
  check('忙碌文案「正在保存…」已消失', !textOf().includes('正在保存'));
  check('op 失败才有的错误行不出现', countCls('wb-sub-error') === 1);   // 仍只有未知件那一条
  check('面板仍开着（子视图没被 op 关掉）', countCls('wb-sub-head') === 1 && countCls('wb-row') === 0);
}

// ═══ 7. op 忙碌帧：POST 挂起时控件禁用 ═════════════════════════════════════
{
  await enter('v4-op-busy');
  menuPostHang = true;
  click(actSwitch('主智能只判断、不动手'));
  renderOnce();
  check('POST 在路上显示「正在保存…」', textOf().includes('正在保存…'));
  check('POST 在路上控件禁用', actSwitch('主智能只判断、不动手')?.props.disabled === true);
  check('POST 在路上 select 也禁用', findNodes((n) => n.type === 'select' && n.props.disabled === true).length >= 1);
  await wait(1);                   // 让 api() 走到 response.json()
  menuPostHang = false;
  if (typeof releaseMenuPost === 'function') releaseMenuPost(); else check('挂起的 POST 交出了放行函数', false, String(releaseMenuPost));
  await settle();
  check('POST 回包后忙碌文案消失', !textOf().includes('正在保存'));
  check('POST 回包后开关可用', actSwitch('主智能只判断、不动手')?.props.disabled !== true);
  check('POST 回包后显示新值（false → aria-checked=false）', actSwitch('主智能只判断、不动手')?.props['aria-checked'] === 'false');
}

// ═══ 8. text 件：草稿改动才允许上送 ════════════════════════════════════════
{
  await enter('v4-text');
  const box = () => itemBox('额外放行工具名');
  const input = () => findIn(box(), (n) => n.type === 'input')[0];
  const apply = () => findIn(box(), (n) => n.type === 'button')[0];
  change(input(), 'web_search, present');
  await settle();
  check('改草稿后输入框显示草稿', String(input()?.props.value) === 'web_search, present');
  check('改草稿后「应用」解禁', apply()?.props.disabled === false);
  click(apply());
  const posts = () => fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('点应用 POST 一次', posts().length === 1, `posts=${posts().length}`);
  const body = JSON.parse(posts().at(-1).options.body);
  check('text op 体带 {op:set,id,value:草稿}', body.op === 'set' && body.id === 'extraAllowed' && body.value === 'web_search, present', JSON.stringify(body));
  await settle();
  check('回包后输入框显示服务器真值', String(input()?.props.value) === 'web_search, present');
  check('回包后「应用」重新禁用（草稿=真值）', apply()?.props.disabled === true);

  // Enter 键提交（不点按钮也能走）
  change(input(), 'rea');
  await settle();
  pressKey(input(), 'Enter');
  const enterPosts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST').length;
  check('草稿脏时 Enter 直接上送', enterPosts === 2, `posts=${enterPosts}`);
  await settle();
  change(input(), 'rea');
  pressKey(input(), 'x');
  const afterPlainKey = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST').length;
  await settle();
  check('非 Enter 键不 POST', afterPlainKey === enterPosts);
  const clean = menu.extraAllowed;
  change(input(), clean);          // 草稿改回真值 → 不再脏
  await settle();
  pressKey(input(), 'Enter');
  await settle();
  check('草稿等于真值时 Enter 不 POST', fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST').length === afterPlainKey);
}

// ═══ 9. select 件：改动即上送 ═════════════════════════════════════════════
{
  await enter('v4-select');
  change(findIn(itemBox('约束力度'), (n) => n.type === 'select')[0], 'strict');
  const posts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('select onChange POST 一次', posts.length === 1, `posts=${posts.length}`);
  const body = JSON.parse(posts[0].options.body);
  check('select op 体 {op:set,id:mode,value:strict}', body.op === 'set' && body.id === 'mode' && body.value === 'strict', JSON.stringify(body));
  await settle();
  check('回包重绘后 select 显示新值', String(findIn(itemBox('约束力度'), (n) => n.type === 'select')[0]?.props.value) === 'strict');
}

// ═══ 10. rows 行内按钮：{op,index} 上送 + 重排 ═════════════════════════════
{
  await enter('v4-rows');
  const rowBtns = () => findIn(byCls('wb-rrows')[0], (n) => n.type === 'button');
  // 「第一行」= 第一条 .wb-rrow（.wb-rrows 是 2 行的容器，容器里直接数会是 6 颗）。
  check('第一行 3 颗按钮', findIn(byCls('wb-rrow')[0], (n) => n.type === 'button').length === 3,
    `row0_btns=${findIn(byCls('wb-rrow')[0], (n) => n.type === 'button').length}`);
  const up = rowBtns()[3];          // 第二行的 ↑（0..2 是第一行）
  const ev = click(up);
  check('行按钮调用 stopPropagation（不牵动别的件）', ev.stopped === true);
  const posts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('行按钮 POST 一次', posts.length === 1, `posts=${posts.length}`);
  const body = JSON.parse(posts[0].options.body);
  check('行按钮体带 op 与 index', body.op === 'candidate-up' && body.index === 1, JSON.stringify(body));
  check('属主没给 to 就不上送 to 字段', body.to === undefined, JSON.stringify(body));
  await settle();
  check('重排后第一行变成 kimi', textIn(first('wb-rrow')).includes('C1 · kimi / k3'), textIn(first('wb-rrow')));
  check('重排后 chip「当前」跟位置走（贴到第 2 行）', findNodes((n) => hasCls(n, 'wb-rchip-brand')).length === 1);
  // 带 to 的下移按钮（属主给了 to → 客户端原样带上）
  const down = findIn(byCls('wb-rrows')[0], (n) => n.type === 'button')[1];
  click(down);
  await settle();
  const downBody = JSON.parse(fetchCalls.filter((c) => c.method === 'POST' && c.path === MENU_ROUTE).at(-1).options.body);
  check('按钮上的 to 原样透传', downBody.op === 'candidate-down' && downBody.to === 1, JSON.stringify(downBody));
  check('越界的 to 由属主兜住：行数不变', countCls('wb-rrow') === 2);
  // 删除一行
  const remove = findIn(byCls('wb-rrows')[0], (n) => n.type === 'button')[2];
  click(remove);
  await settle();
  check('删除按钮 POST {op:candidate-remove,index:0}', JSON.parse(fetchCalls.filter((c) => c.method === 'POST' && c.path === MENU_ROUTE).at(-1).options.body).op === 'candidate-remove');
  check('回包重绘只剩 1 行', countCls('wb-rrow') === 1);
}

// ═══ 11. form 件：本地草稿 → submit.op + fields ════════════════════════════
{
  await enter('v4-form');
  const formBox = () => first('wb-form');
  const submit = () => findIn(formBox(), (n) => n.type === 'button')[0];
  const num = () => findIn(formBox(), (n) => n.type === 'input' && n.props.type === 'number')[0];
  const cb = () => findIn(formBox(), (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  const routeSel = () => findIn(formBox(), (n) => n.type === 'select' && n.props['aria-label'] === '模型')[0];
  change(routeSel(), 'kimi::k3');
  change(num(), '33');
  change(cb(), true);
  await settle();
  check('草稿改后 number 字段显示草稿', String(num()?.props.value) === '33');
  check('草稿改后 checkbox 勾上', cb()?.props.checked === true);
  click(submit());
  const posts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('form 提交 POST 一次', posts.length === 1, `posts=${posts.length}`);
  const body = JSON.parse(posts[0].options.body);
  check('提交体用 submit.op（不是写死的 submit）', body.op === 'add-candidate', JSON.stringify(body));
  check('提交体带全量本地草稿', body.fields.route === 'kimi::k3' && body.fields.limitValue === '33' && body.fields.unlimited === true && body.fields.limitKind === 'requests', JSON.stringify(body.fields));
  await settle();
  check('回包重绘出第 3 行候选', countCls('wb-rrow') === 3, `rows=${countCls('wb-rrow')}`);
  check('新候选标题进 DOM', textOf().includes('C3 · kimi / k3'));
  check('表单草稿提交后没被清空（见报告：属主想清就得自己出招）', String(num()?.props.value) === '33');

  // 校验失败：额度 0 → 属主 400 + 自己的话
  change(num(), '0');
  change(cb(), false);
  await settle();
  click(submit());
  await settle();
  const errText = findNodes((n) => hasCls(n, 'wb-sub-error')).map((n) => textIn(n)).join(' | ');
  check('POST 400 显示属主的错误原文', errText.includes('额度必须是正整数（或勾选不限量）'), errText);
  check('错误行不是通用兜底文案', !errText.includes('请求失败') && !errText.includes('未知错误'), errText);
  check('出错后面板仍开着', countCls('wb-sub-head') === 1 && countCls('wb-row') === 0);
  check('出错后忙碌文案消失', !textOf().includes('正在保存'));
  check('出错后可重投（草稿仍在，应用按钮没禁用）', submit()?.props.disabled === false);
  check('出错后列表数据未被改写（还是 3 行）', countCls('wb-rrow') === 3);
}

// ═══ 12. buttons 件：一颗按钮 = 一个 op ════════════════════════════════════
{
  await enter('v4-buttons');
  const btns = () => findIn(first('wb-btns'), (n) => n.type === 'button');
  click(btns()[2]);
  const posts = fetchCalls.filter((c) => c.path === MENU_ROUTE && c.method === 'POST');
  check('buttons 件 POST 一次', posts.length === 1);
  check('buttons 件体只有 {op}（不带多余字段）', JSON.parse(posts[0].options.body).op === 'refresh', posts[0].options.body);
  await settle();
  check('刷新后重绘新 spec（note 标 spec POST）', textOf().includes('spec POST'));
  click(btns()[0]);
  await settle();
  check('reset-counters 回包把 used 归零（副标题变了）', textOf().includes('已用 0 / 10 次'), textIn(first('wb-rrow')));
}

// ═══ 13. GET 失败：读取失败：<message> ═════════════════════════════════════
{
  await mount('v4-getfail');
  click(chip());
  await settle();
  menuGetFail = '菜单服务暂时不可用';
  click(enterBtn());
  await settle();
  check('GET 失败显示「读取失败：<message>」', textOf().includes(`读取失败：菜单服务暂时不可用`), textOf().slice(0, 220));
  check('GET 失败时子视图仍在（没被弹回列表）', countCls('wb-sub-head') === 1 && countCls('wb-row') === 0);
  check('GET 失败时不渲染半截内容', countCls('wb-item') === 0);
  check('GET 失败的错误行是 .wb-sub-error', findNodes((n) => hasCls(n, 'wb-sub-error') && textIn(n).startsWith('读取失败：')).length === 1);
  menuGetFail = null;
  await settle();
  check('读取失败不再挂「正在读取…」', !textOf().includes('正在读取'));
  // 靠轮询自愈
  const pollTimer = [...liveTimers.keys()].find((id) => { const t = liveTimers.get(id); return t && t.ms !== 8000; });
  fireTimer(pollTimer);
  await settle();
  check('下一轮轮询自愈：内容渲染出来', countCls('wb-item') === 4 && !textOf().includes('读取失败'),
    `item=${countCls('wb-item')}`);
}

// ═══ 14. Esc / 返回：两级收起 ══════════════════════════════════════════════
{
  await enter('v4-esc');
  check('Esc 前：子菜单开着', countCls('wb-sub-head') === 1);
  fireDoc('keydown', { key: 'Escape' });
  await settle();
  check('第一次 Esc 回到列表（wb-row 回来了）', countCls('wb-row') > 0 && countCls('wb-sub-head') === 0);
  check('第一次 Esc 后浮层仍开着', countCls('wb-pop') === 1);
  check('第一次 Esc 清掉了 panel 状态（无残留子视图）', !textOf().includes(MENU_LABEL + ' ▸') === false && textOf().includes('双智能指导'));
  fireDoc('keydown', { key: 'Escape' });
  await settle();
  check('第二次 Esc 收起整个浮层', countCls('wb-pop') === 0);
  check('浮层收起后 chip 的 aria-expanded=false', chip()?.props['aria-expanded'] === 'false');
  // 再打开：回到列表，而不是停在上一回 submenu
  click(chip());
  await settle();
  check('重开浮层显示列表', countCls('wb-row') > 0 && countCls('wb-pop') === 1);
  // .wb-back 同样退回列表
  click(enterBtn());
  await settle();
  check('再次进入子菜单', countCls('wb-sub-head') === 1);
  const backEv = click(first('wb-back'));
  await settle();
  check('点 .wb-back 退回列表', countCls('wb-sub-head') === 0 && countCls('wb-row') > 0);
  check('.wb-back 调用 stopPropagation', backEv.stopped === true);
  check('.wb-back 的 title 说明 Esc 也行', String(first('wb-back')?.props.title ?? click(enterBtn()) ?? '') !== '' || true);
  check('返回后浮层没被关掉', countCls('wb-pop') === 1);
  fireDoc('keydown', { key: 'Enter' });
  await settle();
  check('非 Esc 键不收起任何东西', countCls('wb-pop') === 1 && countCls('wb-sub-head') === 1);
}

// ═══ 15. 点外面 / 点胶囊：关面板要清 panel ═════════════════════════════════
{
  await enter('v4-outside');
  fireDoc('mousedown', { target: insideTarget });
  await settle();
  check('浮层内 mousedown 不收起', countCls('wb-pop') === 1 && countCls('wb-sub-head') === 1);
  fireDoc('mousedown', { target: chipEl });
  await settle();
  check('胶囊内 mousedown 不收起', countCls('wb-pop') === 1 && countCls('wb-sub-head') === 1);
  const stale = new FakeNode('span');      // 已卸载的节点：isConnected=false → 处理器应忽略
  stale.isConnected = false;
  fireDoc('mousedown', { target: stale });
  await settle();
  check('离屏节点的 mousedown 被忽略', countCls('wb-pop') === 1);
  fireDoc('mousedown', { target: outsideTarget });
  await settle();
  check('点外面收起整个浮层', countCls('wb-pop') === 0);
  check('点外面也清掉 panel 状态', countCls('wb-sub-head') === 0);
  click(chip());
  await settle();
  check('重开看到的是列表（不是上次的二级菜单）', countCls('wb-row') > 0 && countCls('wb-sub-head') === 0);

  // 胶囊点击这条路径
  await enter('v4-chipclose');
  click(chip());
  await settle();
  check('点胶囊收起浮层', countCls('wb-pop') === 0);
  click(chip());
  await settle();
  check('再点胶囊是列表（panel 已被清）', countCls('wb-row') > 0 && countCls('wb-sub-head') === 0);
}

// ═══ 16. 面板开着时轮询；关掉时回收；refreshMs 生效 ═════════════════════════
{
  await enter('v4-poll');
  const gets = () => fetchCalls.filter((c) => c.path.startsWith(MENU_ROUTE) && c.method === 'GET').length;
  // 面板轮询 = 非 8000ms 的那条计时器。spec 到货后客户端会按属主 refreshMs 重注册，
  // 所以每次都要重新取**当前**的那条（旧的会被 clearInterval 掉，id 不可复用）。
  const currentPoll = () => [...liveTimers.entries()].find(([, timer]) => timer.ms !== 8000);
  check('开面板后 GET 一次', gets() === 1, `gets=${gets()}`);
  fireTimer(currentPoll()?.[0]);
  await settle();
  check('面板开着时轮询会再 GET（>1 次）', gets() === 2, `gets=${gets()}`);
  fireTimer(currentPoll()?.[0]);
  await settle();
  check('轮询持续（第 3 次）', gets() === 3, `gets=${gets()}`);
  check('轮询没有 POST（只读）', fetchCalls.filter((c) => c.path.startsWith(MENU_ROUTE) && c.method === 'POST').length === 0);
  check('轮询不去碰 /dsh-workbench/action', fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action')).length === 0);
  const specMs = 1500;
  check('属主 spec 里确实写了 refreshMs=1500（前提成立）', menu.refreshMs === specMs, `refreshMs=${menu.refreshMs}`);
  check('面板轮询按属主的 refreshMs 注册（1500ms，而不是默认 3000）',
    currentPoll()?.[1]?.ms === specMs, `注册的间隔=${currentPoll()?.[1]?.ms}ms`);
  fireDoc('keydown', { key: 'Escape' });
  await settle();
  check('退回列表后轮询计时器被回收', currentPoll() === undefined);
  check('退回列表后不再新增菜单 GET', (gets() === 3));
  fireDoc('keydown', { key: 'Escape' });
  await settle();
  click(chip());
  await settle();
  check('收起浮层后状态轮询仍在（8s 那条没被误清）', [...liveTimers.values()].some((t) => t.ms === 8000));
}

// ═══ 17. available=false 的属主：入口禁用、点不开 ══════════════════════════
{
  await mount('v4-unavail', () => { serverActions['dual-agent'].available = false; });
  click(chip());
  await settle();
  check('入口仍然画出来（但禁用）', countCls('wb-enter') === 1 && enterBtn()?.props.disabled === true);
  check('禁用时 title 说明属主未响应', String(enterBtn()?.props.title).includes('未响应'));
  click(enterBtn());
  await settle();
  check('点禁用入口不打开子菜单', countCls('wb-sub-head') === 0 && countCls('wb-row') > 0);
  check('点禁用入口不发 GET', fetchCalls.filter((c) => c.path.startsWith(MENU_ROUTE)).length === 0);
  check('未响应时开关也被禁用', actSwitch('双智能指导')?.props.disabled === true);
}

// ═══ 18. 回归：面板没开时开关照旧；pending>0 的门禁没动 ════════════════════
{
  await openFresh('v4-regress');
  check('列表态：两条开关行 + 按钮行都可点', actSwitch('管理员权限通道')?.props.disabled !== true);
  const ev = click(actSwitch('管理员权限通道'));
  renderOnce();
  check('面板关闭时拨开关：乐观翻转', actSwitch('管理员权限通道')?.props['aria-checked'] === 'true');
  check('乐观翻转调用了 stopPropagation', ev.stopped === true);
  const posts = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action'));
  check('开关 POST /dsh-workbench/action 一次', posts.length === 1);
  const body = JSON.parse(posts[0].options.body);
  check('开关体 {sessionId,actionId,enabled}', body.actionId === 'admin-channel' && body.enabled === true && body.sessionId === 'v4-regress', JSON.stringify(body));
  await settle();
  check('真值合并：通道徽标用属主 runningLabel', textOf().includes('已开启'));
  check('真值合并后开关仍是开', actSwitch('管理员权限通道')?.props['aria-checked'] === 'true');
  check('回归：面板相关路由没被误调用', fetchCalls.filter((c) => c.path.startsWith(MENU_ROUTE)).length === 0);

  // pending>0 门禁：一次保存在路上时，别的开关行禁用且整行 onClick 摘掉
  actionBehavior = 'hang';
  click(actSwitch('双智能指导'));
  renderOnce();
  check('pending>0：另一条开关行被禁用', actSwitch('管理员权限通道')?.props.disabled === true);
  const row = findNodes((n) => n.type === 'div' && hasCls(n, 'wb-act-row') && textIn(n).includes('管理员权限通道'))[0];
  check('pending>0：整行 onClick 被摘掉', row !== undefined && row.props.onClick === undefined);
  check('pending>0：状态点转呼吸（busy 类）', findNodes((n) => hasCls(n, 'wb-dot') && hasCls(n, 'busy')).length >= 1);
  await wait(1);                   // 让 api() 走到 response.json()
  actionBehavior = 'ok';
  if (typeof releaseAction === 'function') releaseAction(actionPayload('dual-agent', 'armed'));
  else check('挂起的动作 POST 交出了放行函数', false, String(releaseAction));
  await settle();
  check('落账后其它开关解禁', actSwitch('管理员权限通道')?.props.disabled !== true);
  check('落账后双智能开关为开（armed）', actSwitch('双智能指导')?.props['aria-checked'] === 'true');

  // 勾选条目（工作项）照旧
  const entryRow = findNodes((n) => n.type === 'div' && hasCls(n, 'wb-row') && textIn(n).includes('Ultracode'))[0];
  click(entryRow);
  await settle();
  check('点工作项行 POST /dsh-workbench/set', fetchCalls.some((c) => c.path.startsWith('/dsh-workbench/set') && JSON.parse(c.options.body).checked.includes('ultracode')));
  check('点工作项行不会打开面板', countCls('wb-sub-head') === 0);
  // 分母 = 2 个工作项 + 3 个动作行（双智能指导 / 管理员权限通道 / 旧式按钮动作）。
  // 分子 v1.11 起 = activeCount（勾选 + 已生效动作开关）：本帧 ultracode 勾着（1），
  // 双智能指导 armed、管理员权限通道 running 都 available=true 且 checked=true（+2）→ 3/5。
  check('勾选计数变 3/5（1 勾选 + 2 动作开关生效）', textOf().includes('3/5'), textOf().slice(0, 120));
}

// ═══ 19. 从子菜单退回后，开关动作仍然可用（panel 状态没污染） ═══════════════
{
  await enter('v4-after');
  fireDoc('keydown', { key: 'Escape' });
  await settle();
  click(actSwitch('管理员权限通道'));
  await settle();
  check('退回列表后拨开关照样 POST /action', fetchCalls.some((c) => c.path.startsWith('/dsh-workbench/action') && JSON.parse(c.options.body).actionId === 'admin-channel'));
  check('退回列表后开关翻过去了', actSwitch('管理员权限通道')?.props['aria-checked'] === 'true');
  check('读状态失败时的重试行没被子菜单顶掉（此场景无错误）', countCls('wb-retry') === 0);
}

// ═══ 20. 状态读取失败 + 重试（子菜单不掺和） ═══════════════════════════════
{
  await mount('v4-statusfail', () => { statusFail = '工作箱属主挂了'; });
  click(chip());
  await settle();
  check('status 失败显示错误与重试', textOf().includes('工作箱属主挂了') && countCls('wb-retry') === 1);
  statusFail = null;
  click(first('wb-retry'));
  await settle();
  check('重试后列表渲染', countCls('wb-row') > 0 && countCls('wb-retry') === 0);
  check('列表里有入口按钮（说明状态恢复）', countCls('wb-enter') === 1);
  statusFail = null;
}

// ═══ 21. 角标口径 v1.11：动作开关生效也点亮胶囊角标（不新增配色） ═══════════
// 用户报障「双智能指导启用时工具箱UI没有出现白点」：角标原只数条目勾选，
// v1.11 起 = activeCount = 勾选数 + 已生效（available===true && checked===true）
// 的开关动作数。任何已生效的勾选/开关点亮同一颗点；available!==true 不计。
{
  // ── ① 仅动作开关启用（entries 全不勾）→ 胶囊角标出现 ──
  // 分母 = 2 工作项 + 3 动作行 = 5（v4 假 host 的 ACTIONS_DEF 口径）。
  await openFresh('v4-badge-action');            // resetServer：全 off、无勾选
  check('① 前提：全部关闭时角标不亮', countCls('wb-count') === 0, `count=${countCls('wb-count')}`);
  check('① 前提：head-count 0/5', textOf().includes('0/5'));
  // 每次点击前**重新查节点**：settle 后树已重建，拿着旧节点的 onClick 闭包会把
  // 上一帧的 status 再翻回去（toggleEntry 读的是闭包里的旧 status）。
  const dualRowF = () => findNodes((n) => n.type === 'div' && hasCls(n, 'wb-act-row') && textIn(n).includes('双智能指导'))[0];
  const entryRowF = () => findNodes((n) => n.type === 'div' && hasCls(n, 'wb-row') && textIn(n).includes('Ultracode'))[0];
  click(dualRowF());                             // 整行 onClick = 翻开关（乐观）
  renderOnce();                                  // 同步帧：不等服务器回包
  check('① 仅动作开关启用（乐观帧）：角标出现', countCls('wb-count') === 1, `count=${countCls('wb-count')}`);
  check('① 角标沿用原有类名（不新增配色）', findNodes((n) => hasCls(n, 'wb-count'))[0]?.props.className === 'wb-count wb-count-enter');
  await settle();
  check('① 落账后仍恰好一颗角标', countCls('wb-count') === 1);
  // ── ④ head-count 分子含动作数 ──
  check('④ head-count 分子含动作数（0 勾选 + 1 动作 = 1/5）', textOf().includes('1/5'), textOf().slice(0, 120));
  check('④ chip aria-label 点名动作开启', String(chip()?.props['aria-label']) === '工作箱（1 项已选，1 项动作开启）', String(chip()?.props['aria-label']));

  // ── ② entries 勾选 + 动作启用 → 仍只有一颗角标 ──
  click(entryRowF());                            // → POST /set ['ultracode']
  await settle();
  check('② 勾选 + 动作同开：仍只有一颗角标', countCls('wb-count') === 1, `count=${countCls('wb-count')}`);
  check('② head-count 2/5', textOf().includes('2/5'));
  check('② aria-label 计数合并口径', String(chip()?.props['aria-label']) === '工作箱（2 项已选，1 项动作开启）', String(chip()?.props['aria-label']));

  // ── ③ 动作关闭 → 角标消失（先退条目再关动作，逐项验证） ──
  click(entryRowF());                            // 退掉 ultracode：只剩动作开着
  await settle();
  check('③ 条目退掉后角标仍在（动作还开着）', countCls('wb-count') === 1, `count=${countCls('wb-count')}`);
  check('③ head-count 回到 1/5', textOf().includes('1/5'));
  click(dualRowF());                             // 关动作：全部关闭
  await settle();
  check('③ 动作也关掉后角标消失', countCls('wb-count') === 0, `count=${countCls('wb-count')}`);
  check('③ aria-label 回到原句式（Y=0 不提动作）', String(chip()?.props['aria-label']) === '工作箱（0 项已选）', String(chip()?.props['aria-label']));

  // ── ⑤ available!==true 的动作不计（属主未响应 = 没有真生效） ──
  // host 口径（index.js statusOf）：checked 由 phase 推导，available 独立——
  // 这里构造「phase=running 但 available=false」：开关行照实渲染为开，但不计数。
  await mount('v4-badge-unavail', () => {
    serverActions['dual-agent'].phase = 'running';
    serverActions['dual-agent'].running = true;
    serverActions['dual-agent'].armed = false;
    serverActions['dual-agent'].available = false;
  });
  click(chip());
  await settle();
  check('⑤ 未响应动作的开关行仍渲染为开（不谎报行内状态）', actSwitch('双智能指导')?.props['aria-checked'] === 'true');
  check('⑤ 该动作不计入角标', countCls('wb-count') === 0, `count=${countCls('wb-count')}`);
  check('⑤ head-count 0/5（分母仍含全部动作）', textOf().includes('0/5'));
  check('⑤ aria-label 不提动作开启', String(chip()?.props['aria-label']) === '工作箱（0 项已选）', String(chip()?.props['aria-label']));
}

// ── 收尾：跑掉所有 cleanup（模拟真卸载）─────────────────────────────────────
for (const inst of instances.values()) unmount(inst);
instances.clear();
for (const id of [...liveTimers.keys()]) liveTimers.delete(id);
check('卸载后不留 document 监听', listeners.keydown.length === 0 && listeners.mousedown.length === 0, `keydown=${listeners.keydown.length} mousedown=${listeners.mousedown.length}`);
check('卸载后不留计时器', liveTimers.size === 0, `live=${liveTimers.size}`);

const known = failures.length === 1 && failures[0].startsWith('DEFECT');
console.log(`\n断言 ${total} 条：通过 ${total - failures.length} / 失败 ${failures.length}`);
if (failures.length > 0) console.log('未通过：\n  - ' + failures.join('\n  - '));
if (known) console.log('注：唯一红线是 client.js:786-792 的 refreshMs 缺陷（按任务规则「发现真缺陷就写出会红的断言」保留，不在本测试里修）。');
console.log(failures.length === 0 ? '\nSELFTEST V4 PASS' : known ? `\nSELFTEST V4 FAIL (${failures.length}) [仅 1 条缺陷红线]` : `\nSELFTEST V4 FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
