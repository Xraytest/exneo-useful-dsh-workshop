// v2 动作条目专测（client 半边）。既有 client-selftest.mjs 的 statusPayload 没有
// actions 字段——它只证明了「旧 host 回包不崩」，从未渲染过动作行。本文件补：
//   1) actions 渲染（行/按钮/文案/disabled/badge/头部计数分母含动作）
//   2) available=false → 禁用 + 提示语
//   3) running=true → wb-stop 样式 + 徽标 + 「停止」文案
//   4) triggerAction 乐观翻转（挂起 POST 的同步帧）+ 请求体
//   5) 回包 running 真值合并（开/关两个方向）
//   6) 动作失败（无并发写）→ 回滚 + 红字
//   7) 旧 host（无 actions 键）不崩、分母不含动作、无 NaN
// 每个场景换一个全新 sessionId：statusCache 是模块级 Map，干净会话 = 确定性起点。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT = new URL('./client.js', import.meta.url);
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
const listeners = { mousedown: [], keydown: [] };
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ set textContent(v) { this._t = v; } }),
  addEventListener(kind, fn) { (listeners[kind] ??= []).push(fn); },
  removeEventListener(kind, fn) { (listeners[kind] ??= []).filter((f) => f !== fn); },
  getElementById: () => null,
};

let hookState = []; let hookIndex = 0; let pendingEffects = []; let rerender = false; let cleanups = [];
const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
  useState(init) { const i = hookIndex++; if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    const set = (next) => { const v = typeof next === 'function' ? next(hookState[i]) : next; if (!Object.is(v, hookState[i])) { hookState[i] = v; rerender = true; } };
    return [hookState[i], set]; },
  useMemo(fn, deps) { const i = hookIndex++; const prev = hookState[i]; if (prev !== undefined && eq(prev.deps, deps)) return prev.value; const v = fn(); hookState[i] = { deps, value: v }; return v; },
  useEffect(fn, deps) { const i = hookIndex++; const prev = hookState[i]; if (prev === undefined || !eq(prev.deps, deps)) pendingEffects.push(fn); hookState[i] = { deps }; },
};
React.useCallback = (fn, deps) => React.useMemo(() => fn, deps);

const ACTION = { id: 'dual-agent', label: '双主智能', description: '执行者=后台 subagent；挑刺者=主上下文评估人格', kind: 'switch', runningLabel: '运行中', idleLabel: '待命中' };
// 服务器应答的状态（由每个场景设置）：phase 是三态真值（off/armed/running）
let statusPhase = 'off';
let statusAvailable = true;
let statusHasActions = true;
let statusChecked = [];
let statusErrorText = '';
let statusHatchAt = null;   // running 中的孵化时刻（客户端每秒渲染时长的锚点）

const NOTE_BY_PHASE = {
  off: null,
  armed: '已武装：请键入本任务的初始指令（下一条你发出的消息就是任务）。',
  running: '执行者独立工作中，主对话已让位（保持安静是正常的）；你此时键入的补充会转达给执行者，交报告后挑刺者在主上下文评估。',
};

const statusPayload = () => ({
  sessionId: 'SID', family: 'SID', checked: statusChecked,
  entries: [
    { id: 'ultracode', label: 'Ultracode', description: '穷尽式多代理编排', checked: statusChecked.includes('ultracode') },
    { id: 'rea', label: 'REA', description: '逆向工程工具集', checked: statusChecked.includes('rea') },
  ],
  ...(statusHasActions
    ? {
      actions: [{
        ...ACTION,
        phase: statusPhase,
        running: statusPhase !== 'off',
        armed: statusPhase === 'armed',
        available: statusAvailable,
        note: NOTE_BY_PHASE[statusPhase] ?? undefined,
        ...(statusHatchAt !== null ? { hatchAt: statusHatchAt } : {}),
      }],
    }
    : {}),
  rea: { masterEnabled: statusChecked.includes('rea') },
  stateFile: '/tmp/wb.json', storeError: '', issues: [],
});
// 真实动作回包（dual-agent /action：statusOf() + action 字段）
const actionPayload = (phase) => ({
  sessionId: 'SID', phase, running: phase !== 'off', armed: phase === 'armed',
  childId: phase === 'running' ? 'child-1' : null, agentLive: true,
  note: NOTE_BY_PHASE[phase] ?? null, stateFile: '/x', storeError: '',
  action: phase === 'armed' ? 'armed' : phase === 'running' ? 'started' : 'disarmed',
});
// 服务器三态机：off→armed→running（armed 再点回 off；running 点回 armed）
const nextServerPhase = (current) => current === 'off' ? 'armed' : current === 'armed' ? 'off' : 'armed';

let fetchCalls = [];
let actionBehavior = 'toggle';   // 'toggle' | 'fail' | 'hang'
let hangingAction = null;        // hang 模式下的手动放行
globalThis.fetch = async (path, options) => {
  fetchCalls.push({ path: String(path), options });
  if (path.startsWith('/dsh-workbench/status')) {
    if (statusErrorText !== '') return { ok: false, status: 503, statusText: 'down', json: async () => ({ error: statusErrorText }) };
    return { ok: true, json: async () => statusPayload() };
  }
  if (path.startsWith('/dsh-workbench/set')) {
    statusChecked = JSON.parse(options.body).checked;
    return { ok: true, json: async () => statusPayload() };
  }
  if (path.startsWith('/dsh-workbench/action')) {
    if (actionBehavior === 'fail') return { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({ error: '动作属主未响应：boom' }) };
    if (actionBehavior === 'hang') return { ok: true, json: () => new Promise((resolve) => { hangingAction = resolve; }) };
    // 属主按**目标状态**推进（开关语义）；没有 enabled 的旧式请求才走三态循环。
    const sent = JSON.parse(options.body);
    statusPhase = typeof sent.enabled === 'boolean' ? (sent.enabled ? 'armed' : 'off') : nextServerPhase(statusPhase);
    return { ok: true, json: async () => actionPayload(statusPhase) };
  }
  throw new Error('unexpected ' + path);
};

await import(CLIENT.href);
const exports = captured.factory((name) => { if (name === 'react') return React; throw new Error('require ' + name); });
let registeredComponent = null;
const slotsCtx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: { inject(name, cb) { const r = cb(); } },
};
slotsCtx.slots.register = (meta, component) => { registeredComponent = component; return { ...meta, component }; };
exports.apply(slotsCtx);
if (registeredComponent === null) { console.log('FAIL no component registered'); process.exit(1); }

var tree = null;
async function settle(max = 14) {
  for (let round = 0; round < max; round += 1) {
    rerender = false; hookIndex = 0; pendingEffects = [];
    tree = registeredComponent({ sessionId: SID });
    for (const fn of pendingEffects) { const d = fn(); if (typeof d === 'function') cleanups.push(d); }
    await new Promise((r) => setTimeout(r, 1));
    if (!rerender) return;
  }
  throw new Error('render did not settle');
}
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { visit({ text: String(node) }); return; }
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  visit(node);
  if (node.props && node.props.children !== undefined) walk(node.props.children, visit);
}
const textOf = () => { const out = []; walk(tree, (n) => { if (n.text !== undefined) out.push(n.text); }); return out.join(' ').replace(/\s+/g, ' '); };
const findNodes = (pred) => { const out = []; walk(tree, (n) => { try { if (pred(n)) out.push(n); } catch { /* text node */ } }); return out; };
const actBtn = () => findNodes((n) => n.type === 'button' && String(n.props.className ?? '').includes('wb-act-btn'))[0];
// 动作行现在是开关：按钮带 role="switch"，aria-label 以动作名开头。
const actSwitch = () => findNodes((n) => n.type === 'button' && n.props.role === 'switch' && String(n.props['aria-label'] ?? '').startsWith('双主智能'))[0];
const switchOf = (label) => findNodes((n) => n.type === 'button' && n.props.role === 'switch' && String(n.props['aria-label'] ?? '').startsWith(label))[0];

const failures = [];
const check = (l, c) => { console.log((c ? 'ok   ' : 'FAIL ') + l); if (!c) failures.push(l); };

async function openFresh(sid) {
  SID = sid;
  hookState = []; hookIndex = 0; pendingEffects = []; cleanups = [];
  fetchCalls = [];
  await settle();
  const chip = findNodes((n) => n.type === 'button' && String(n.props.className ?? '').includes('wb-chip'))[0];
  chip.props.onClick();
  await settle();
}

var SID = null;

// ── 1. 开关式动作行渲染（关态） ─────────────────────────────────────────────
statusPhase = 'off'; statusAvailable = true; statusHasActions = true; statusChecked = [];
await openFresh('s-render');
check('action row rendered', findNodes((n) => n.type === 'div' && String(n.props.className ?? '').includes('wb-act-row')).length === 1);
check('action rendered as switch (not button)', actBtn() === undefined && actSwitch() !== undefined);
check('switch is off when phase off', actSwitch()?.props['aria-checked'] === 'false');
check('switch aria-label reads 已关闭', String(actSwitch()?.props['aria-label']).includes('已关闭'));
check('switch enabled when available', actSwitch()?.props.disabled !== true);
check('switch carries title hint', String(actSwitch()?.props.title).includes('打开后武装待命'));
check('no state badge when off', !textOf().includes('运行中') && !textOf().includes('待命中'));
check('header count denominator includes action (0/3)', textOf().includes('0/3'));
check('action label shown', textOf().includes('双主智能'));
check('action description常驻 (功能说明不被阶段说明覆盖)', textOf().includes('执行者=后台 subagent'));
check('row state dot is off', findNodes((n) => n.type === 'span' && String(n.props.className ?? '') === 'wb-dot').length >= 1);

// ── 2. available=false → 禁用 + 提示语 ──────────────────────────────────────
statusAvailable = false; statusPhase = 'off';
await openFresh('s-unavail');
check('switch disabled when owner absent', actSwitch()?.props.disabled === true);
check('switch title explains absence', String(actSwitch()?.props.title).includes('未响应'));
statusAvailable = true;

// ── 3. armed 态：开关为开 + 待命中徽标 + 阶段说明 ────────────────────────────
statusPhase = 'armed'; statusAvailable = true;
await openFresh('s-armed');
check('armed switch is on', actSwitch()?.props['aria-checked'] === 'true');
check('armed switch aria-label reads 已启用', String(actSwitch()?.props['aria-label']).includes('已启用'));
check('armed shows 待命中 badge', textOf().includes('待命中'));
check('armed shows nothing 运行中', !textOf().includes('运行中'));
check('armed phase note shown as separate state line', textOf().includes('已武装：请键入本任务的初始指令'));
check('row state dot is on', findNodes((n) => n.type === 'span' && String(n.props.className ?? '').includes('wb-dot') && String(n.props.className).includes('on')).length >= 1);

// ── 4. running 态：开关仍为开 + 运行中徽标 + 客户端每秒时长 ─────────────────
statusPhase = 'running';
statusHatchAt = Date.now() - 125_000;   // 孵化于 2 分 5 秒前
await openFresh('s-running');
check('running switch stays on', actSwitch()?.props['aria-checked'] === 'true');
check('running shows 运行中 badge', textOf().includes('运行中'));
check('running hint warns interrupt without critique', String(actSwitch()?.props.title).includes('中断执行者'));
check('running phase note shown', textOf().includes('执行者独立工作中'));
check('live elapsed rendered from hatchAt', textOf().includes('已工作 2 分'), textOf().slice(0, 200));
// 不足 1 分钟不显示（噪音阈值）。
statusHatchAt = Date.now() - 30_000;
await openFresh('s-running-short');
check('elapsed silent under 60s', !textOf().includes('已工作'));
// 没有 hatchAt（旧属主回包）：只有 note，没有时长，也不崩。
statusHatchAt = null;
await openFresh('s-running-noanchor');
check('running note without hatchAt renders elapsed-free', textOf().includes('执行者独立工作中') && !textOf().includes('已工作'));
statusPhase = 'armed';

// ── 5. 乐观翻转：off→on 的同步帧开关即勾上，POST 带上送目标状态 ───────────────
actionBehavior = 'hang';
statusPhase = 'off';
await openFresh('s-optimistic');
const beforeCount = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action')).length;
actSwitch().props.onClick({ stopPropagation() {} });
hookIndex = 0; pendingEffects = [];
tree = registeredComponent({ sessionId: SID });   // 同步帧：不等任何网络
check('optimistic switch flips on before server word', actSwitch()?.props['aria-checked'] === 'true');
const actionCalls = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action'));
check('action POSTed exactly once', actionCalls.length === beforeCount + 1);
const sentBody = JSON.parse(actionCalls.at(-1).options.body);
check('action body carries sessionId+actionId', sentBody.actionId === 'dual-agent' && sentBody.sessionId === SID);
check('action body carries target enabled=true', sentBody.enabled === true);
await new Promise((r) => setTimeout(r, 1));
statusPhase = 'armed';
hangingAction(actionPayload('armed'));   // 属主回包：armed
await settle();
check('server truth merged (armed keeps switch on)', actSwitch()?.props['aria-checked'] === 'true');
check('phase note merged from server', textOf().includes('已武装：请键入本任务的初始指令'));

// ── 6. on→off：回包 phase=off 合并回落 ─────────────────────────────────────
actionBehavior = 'toggle';
actSwitch().props.onClick({ stopPropagation() {} });
await settle();
check('switch off truth merged back', actSwitch()?.props['aria-checked'] === 'false' && !textOf().includes('待命中'));
check('switch off POSTs enabled=false', JSON.parse(fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/action')).at(-1).options.body).enabled === false);

// ── 7. 连续两次开关 = 开→关（目标状态驱动，不靠服务端猜下一态） ──────────────
actSwitch().props.onClick({ stopPropagation() {} });   // off→on
await settle();
check('click 1 turns switch on (armed)', actSwitch()?.props['aria-checked'] === 'true' && statusPhase === 'armed');
actSwitch().props.onClick({ stopPropagation() {} });   // on→off
await settle();
check('click 2 turns switch off', actSwitch()?.props['aria-checked'] === 'false' && statusPhase === 'off');

// ── 8. 动作失败（无并发写）→ 回滚 + 红字 ────────────────────────────────────
actionBehavior = 'fail';
actSwitch().props.onClick({ stopPropagation() {} });   // 乐观 on → 502
await settle();
check('failed action rolls switch back off', actSwitch()?.props['aria-checked'] === 'false' && !textOf().includes('待命中'));
check('action failure surfaces red text', textOf().includes('保存失败'));
check('action failure text names cause', textOf().includes('boom'));
actionBehavior = 'toggle';

// ── 9. 旧 host 回包（无 actions 键）不崩、分母正确、无 NaN ──────────────────
statusHasActions = false; statusPhase = 'off';
await openFresh('s-oldhost');
const popText = textOf();
check('old-host status renders without crash', popText.includes('工作列表'));
check('old-host header count is entries only (0/2)', popText.includes('0/2'));
check('old-host renders no action rows', findNodes((n) => n.type === 'div' && String(n.props.className ?? '').includes('wb-act-row')).length === 0);
check('no NaN in count', !popText.includes('NaN'));
statusHasActions = true;

for (const fn of cleanups.splice(0)) fn();
console.log(failures.length === 0 ? '\nSELFTEST V2 PASS' : `\nSELFTEST V2 FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
