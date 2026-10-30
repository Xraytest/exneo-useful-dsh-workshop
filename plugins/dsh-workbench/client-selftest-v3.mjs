// 「已停止 → 执行中」标签改写专测（client 半边）。
//
// 背景：双主智能的阻塞语义让主 Agent 的任务回合被 cancel → 内核记
// `turn/end reason.kind='aborted'` → dsh-client-ui-chat 的 `message.stopped`
// （zh「已停止」）就是渲染给这种回合的标签。用户要求主页面改显示「执行中」。
//
// 本测试用假 locale runtime（复刻 LocaleRuntime 的 dicts 结构：Map<ns, Map<locale, dict>>，
// 且 lookup 按引用读 dict[key]）+ 假 fetch，驱动真实的 refresh/triggerAction 路径：
//   1) armed/running 状态 → chat ns 的 message.stopped 被改成「执行中」（zh+en）；
//   2) off 状态        → 还原成原始文案（用户自己按停止键仍看到「已停止」）；
//   3) 改写-还原-改写 循环不漂移（原始值只快照一次）；
//   4) 宿主结构异常（无 locale / dicts 非 Map / ns 缺失）→ 静默不抛；
//   5) 其它 key 不受影响。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLIENT = new URL('./client.js', import.meta.url);
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ set textContent(v) { this._t = v; } }),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null,
};
let pendingEffects = [];
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useMemo(fn) { return fn(); },
  useEffect(fn) { pendingEffects.push(fn); },
};
React.useCallback = (fn) => fn;

await import(CLIENT.href);
const exports = captured.factory((name) => { if (name === 'react') return React; throw new Error('require ' + name); });

const failures = [];
const check = (label, cond, detail) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + label + (cond ? '' : ` :: ${detail ?? ''}`));
  if (!cond) failures.push(label);
};

const ACTION = { id: 'dual-agent', label: '双主智能', description: 'd', kind: 'switch', runningLabel: '运行中', idleLabel: '待命中' };

// 每个场景一套独立的假 locale + fetch，互不污染。
function makeWorld(phase) {
  const zh = { 'message.stopped': '已停止', 'message.turnProcess.worked': '已完成' };
  const en = { 'message.stopped': 'Stopped', 'message.turnProcess.worked': 'Completed' };
  const locale = { dicts: new Map([['chat', new Map([['zh', zh], ['en', en]])]]) };
  const status = () => ({
    sessionId: 'SID', family: 'SID', checked: [], entries: [],
    actions: [{ ...ACTION, phase, running: phase !== 'off', armed: phase === 'armed', available: true }],
    rea: { masterEnabled: false }, stateFile: '/x', storeError: '', issues: [],
  });
  globalThis.fetch = async (path) => {
    if (String(path).startsWith('/dsh-workbench/status')) return { ok: true, json: async () => status() };
    throw new Error('unexpected ' + path);
  };
  return { locale, zh, en };
}

function applyWith(locale) {
  let registered = null;
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    get: (k) => (k === 'locale' ? locale : undefined),
    slots: { inject(name, cb) { cb(); }, register: (meta, component) => { registered = component; return { ...meta, component }; } },
  };
  exports.apply(ctx);
  return registered;
}

async function driveRefresh(component) {
  // 组件挂载即 refresh → syncStoppedLabel：渲染后把排队的 effect 真跑掉，
  // 再给足异步链路（fetch → await api → syncStoppedLabel）落地的时间。
  pendingEffects = [];
  component({ sessionId: 'SID' });
  for (const fn of pendingEffects) { const d = fn(); if (typeof d === 'function') d(); }
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 2));
}

// 场景 1：armed → 改写。
{
  const w = makeWorld('armed');
  const comp = applyWith(w.locale);
  await driveRefresh(comp);
  check('armed patches label to 执行中 (zh+en)',
    w.zh['message.stopped'] === '执行中' && w.en['message.stopped'] === '执行中',
    `zh=${w.zh['message.stopped']} en=${w.en['message.stopped']}`);
  check('original snapshotted for restore',
    w.zh.__wbOrigStopped === '已停止' && w.en.__wbOrigStopped === 'Stopped');
  check('other keys untouched', w.zh['message.turnProcess.worked'] === '已完成');
}

// 场景 2：off → 不改写（保持原始文案）。
{
  const w = makeWorld('off');
  const comp = applyWith(w.locale);
  await driveRefresh(comp);
  check('off leaves original label', w.zh['message.stopped'] === '已停止', w.zh['message.stopped']);
}

// 场景 3：running → 改写。
{
  const w = makeWorld('running');
  const comp = applyWith(w.locale);
  await driveRefresh(comp);
  check('running patches label to 执行中', w.zh['message.stopped'] === '执行中', w.zh['message.stopped']);
}

// 场景 3b：armed → off 的**还原**（用户手动停止后仍须看到「已停止」）。
// 同一个 locale 实例上切换 status 的 phase，走两次 refresh。
{
  const zh = { 'message.stopped': '已停止' };
  const en = { 'message.stopped': 'Stopped' };
  const locale = { dicts: new Map([['chat', new Map([['zh', zh], ['en', en]])]]) };
  let phase = 'armed';
  globalThis.fetch = async (path) => {
    if (String(path).startsWith('/dsh-workbench/status')) {
      return { ok: true, json: async () => ({
        sessionId: 'SID', family: 'SID', checked: [], entries: [],
        actions: [{ ...ACTION, phase, running: phase !== 'off', armed: phase === 'armed', available: true }],
        rea: { masterEnabled: false }, stateFile: '/x', storeError: '', issues: [],
      }) };
    }
    throw new Error('unexpected ' + path);
  };
  const comp = applyWith(locale);
  await driveRefresh(comp);
  check('armed patched', zh['message.stopped'] === '执行中', zh['message.stopped']);
  phase = 'off';
  await driveRefresh(comp);
  check('off restores original label (manual stop still reads 已停止)',
    zh['message.stopped'] === '已停止' && en['message.stopped'] === 'Stopped',
    `zh=${zh['message.stopped']} en=${en['message.stopped']}`);
  // 再开一次：不应漂移（快照未被覆盖成「执行中」）。
  phase = 'running';
  await driveRefresh(comp);
  check('re-patch after restore is still 执行中', zh['message.stopped'] === '执行中', zh['message.stopped']);
  check('snapshot still holds the true original', zh.__wbOrigStopped === '已停止', String(zh.__wbOrigStopped));
  phase = 'off';
  await driveRefresh(comp);
  check('second restore is exact (no drift)', zh['message.stopped'] === '已停止', zh['message.stopped']);
}
for (const [label, locale] of [
  ['missing locale service', undefined],
  ['locale without dicts', {}],
  ['dicts of wrong type', { dicts: 'nope' }],
  ['ns missing', { dicts: new Map() }],
]) {
  let threw = null;
  try { applyWith(locale); } catch (e) { threw = e; }
  check(`${label} does not throw`, threw === null, String(threw));
}

console.log(failures.length === 0 ? '\nSTOPPED-LABEL SELFTEST PASS' : `\nSTOPPED-LABEL SELFTEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
