// Headless render harness for the workbench chip: fake React hooks + fake fetch.
// Renders the real component, drives open/toggle/save, asserts visible structure.
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
  removeEventListener(kind, fn) { listeners[kind] = (listeners[kind] ?? []).filter((f) => f !== fn); },
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

const statusPayload = (checked) => ({
  sessionId: 's1', family: 's1', checked,
  entries: [
    { id: 'ultracode', label: 'Ultracode', description: '穷尽式多代理编排', checked: checked.includes('ultracode') },
    { id: 'rea', label: 'REA', description: '逆向工程工具集', checked: checked.includes('rea') },
  ],
  rea: { masterEnabled: checked.includes('rea') },
  stateFile: '/tmp/wb.json', storeError: '', issues: [],
});
let serverChecked = [];
let fetchCalls = [];
globalThis.fetch = async (path, options) => {
  fetchCalls.push({ path: String(path), options });
  if (path.startsWith('/dsh-workbench/status')) return { ok: true, json: async () => statusPayload(serverChecked) };
  if (path.startsWith('/dsh-workbench/set')) { serverChecked = JSON.parse(options.body).checked; return { ok: true, json: async () => statusPayload(serverChecked) }; }
  throw new Error('unexpected ' + path);
};

await import(CLIENT.href);
const exports = captured.factory((name) => { if (name === 'react') return React; throw new Error('require ' + name); });

let registeredMeta = null;
let registeredComponent = null;
const slotsCtx = {
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: { inject(name, cb) { const r = cb(); registeredMeta = { name: r.name, id: r.id, order: r.order }; } },
};
// client.js calls ctx.slots.register(meta, Component); mimic register returning meta+component
slotsCtx.slots.register = (meta, component) => { registeredMeta = meta; registeredComponent = component; return { ...meta, component }; };
exports.apply(slotsCtx);
if (registeredComponent === null) { console.log('FAIL no component registered'); process.exit(1); }

var tree = null;
async function settle(max = 10) {
  for (let round = 0; round < max; round += 1) {
    rerender = false; hookIndex = 0; pendingEffects = [];
    tree = registeredComponent({ sessionId: 's1' });
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

const failures = [];
const check = (l, c) => { console.log((c ? 'ok   ' : 'FAIL ') + l); if (!c) failures.push(l); };

// 1. renders closed chip with icon and no list
await settle();
check('chip rendered', findNodes((n) => n.type === 'button' && n.props.className === 'wb-chip').length === 1);
// 图案（2026-10-22「改一下图标图案」）：电源符号——两段 stroke path（弧 + 顶杆），
// 不再是旧版工具箱的 rect + 提手。
const iconPaths = findNodes((n) => n.type === 'path');
check('icon is power glyph (2 stroked paths)', iconPaths.length === 2 && iconPaths.every((p) => p.props.stroke === 'currentColor'));
check('no toolbox rect left', findNodes((n) => n.type === 'rect').length === 0);
check('arc path present', iconPaths.some((p) => String(p.props.d).startsWith('M5.81')));
check('stem path present', iconPaths.some((p) => String(p.props.d) === 'M8 3.4v3.2'));
check('no popover when closed', findNodes((n) => n.type === 'div' && n.props.className === 'wb-pop').length === 0);
check('order 23 in meta', registeredMeta.order === 23);
check('seat is conversation.input.left', registeredMeta.name === 'conversation.input.left');
check('id is workbench', registeredMeta.id === 'workbench');

// 2. open the popover: header + entries visible as switches (off)
const chip = findNodes((n) => n.type === 'button' && n.props.className === 'wb-chip')[0];
chip.props.onClick();
await settle();
const popNode = findNodes((n) => n.type === 'div' && n.props.className === 'wb-pop')[0];
check('popover open', popNode !== undefined);
// 「点击秒开」：浮层没有入场动画类——点开第一帧就是最终画面。
check('popover opens with no animation classes', popNode !== undefined && popNode.props.className === 'wb-pop');
check('header title', textOf().includes('工作列表'));
check('header count 0/2', textOf().includes('0/2'));
check('clear hidden when none on', !textOf().includes('全关'));
// 2026-10-30 用户指令「去掉工具箱插件页面底部的文本描述」：底注整段移除，
// 浮层里不再有任何常驻说明文字（说明只在各条目自己的 wb-row-desc 里）。
check('footer note removed', !textOf().includes('拨动开关即时生效'));
check('no wb-note node', findNodes((n) => n.type === 'div' && n.props.className === 'wb-note').length === 0);
const chipAfterOpen = findNodes((n) => n.type === 'button' && String(n.props.className).includes('wb-chip'))[0];
check('chip gains open class on expand', String(chipAfterOpen?.props.className ?? '').includes('wb-open'));
const rows = findNodes((n) => n.type === 'div' && n.props.className === 'wb-row');
check('two rows', rows.length === 2);
check('labels shown', textOf().includes('Ultracode') && textOf().includes('REA'));
const switches = () => findNodes((n) => n.type === 'button' && n.props.role === 'switch' && n.props.className === 'wb-switch');
check('two switch toggles', switches().length === 2);
check('all off initially', switches().every((sw) => sw.props['aria-checked'] === 'false'));
check('switch has thumb', switches().every((sw) => Array.isArray(sw.props.children) ? sw.props.children.some((c) => c.type === 'i') : sw.props.children.type === 'i'));

// 3. flip REA's switch on → save posts and count badge appears
const reaSwitch = switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0];
reaSwitch.props.onClick({ stopPropagation() {} });
await settle();
const setCall = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/set')).pop();
check('save posted once', setCall !== undefined);
check('rea in posted body', JSON.parse(setCall.options.body).checked.includes('rea'));
check('count badge 1', findNodes((n) => n.props.className === 'wb-count wb-count-enter').length === 1);
check('rea switch now on', switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0].props['aria-checked'] === 'true');
check('green dot on REA row', findNodes((n) => n.props.className === 'wb-dot on').length === 1);
check('clear now visible', textOf().includes('全关'));
check('header count 1/2', textOf().includes('1/2'));

// 4. flip ultracode's switch too → both on
const ultraSwitch = switches().filter((sw) => sw.props['aria-label'].startsWith('Ultracode'))[0];
ultraSwitch.props.onClick({ stopPropagation() {} });
await settle();
const lastSet = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/set')).pop();
check('both posted', JSON.parse(lastSet.options.body).checked.includes('ultracode') && JSON.parse(lastSet.options.body).checked.includes('rea'));
// 角标已是纯圆点（2026-10-22「圆点角标而不是方形」）：元素在，但没有文字子节点。
check('badge is a bare dot (no number)', findNodes((n) => String(n.props.className).includes('wb-count'))[0]?.props.children === undefined);
check('no checkboxes left', findNodes((n) => n.type === 'input' && n.props.type === 'checkbox').length === 0);
check('two green dots', findNodes((n) => n.props.className === 'wb-dot on').length === 2);
check('header count 2/2', textOf().includes('2/2'));

// 5. clear-all button empties everything
const clear = findNodes((n) => n.type === 'button' && String(n.props.className) === 'wb-clear')[0];
check('clear button exists', clear !== undefined);
clear.props.onClick({ stopPropagation() {} });
await settle();
const clearSet = fetchCalls.filter((c) => c.path.startsWith('/dsh-workbench/set')).pop();
check('clear posted empty', Array.isArray(JSON.parse(clearSet.options.body).checked) && JSON.parse(clearSet.options.body).checked.length === 0);
check('dots all off after clear', findNodes((n) => n.props.className === 'wb-dot on').length === 0);

// 4b. 「点击秒开」的硬保证：把 /set 挂成暂不返回的请求，开关也必须立刻翻过去。
let releaseSet = null;
let hangingSets = 0;
globalThis.fetch = async (path, options) => {
  fetchCalls.push({ path: String(path), options });
  if (path.startsWith('/dsh-workbench/set')) { hangingSets += 1; return { ok: true, json: () => new Promise((resolve) => { releaseSet = resolve; }) }; }
  if (path.startsWith('/dsh-workbench/status')) return { ok: true, json: async () => statusPayload(serverChecked) };
  throw new Error('unexpected ' + path);
};
const reaSw2 = switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0];
reaSw2.props.onClick({ stopPropagation() {} });
hookIndex = 0; pendingEffects = [];   // 同步重渲染：不跑微任务、完全不等网络
tree = registeredComponent({ sessionId: 's1' });
check('optimistic flip before any server word', switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0].props['aria-checked'] === 'true');
check('save posted exactly once', hangingSets === 1);
check('dot badge already up', findNodes((n) => String(n.props.className).includes('wb-count')).length === 1);
await new Promise((r) => setTimeout(r, 1));   // 放行微任务：让 api() 走到 json()、挂起兑现
releaseSet(statusPayload(['rea'])); serverChecked = ['rea'];
await settle();
check('stays on once server truth lands', switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0].props['aria-checked'] === 'true');

// 4c. 保存失败：乐观态回滚到服务器真值，浮层给出红字。
globalThis.fetch = async (path, options) => {
  fetchCalls.push({ path: String(path), options });
  if (path.startsWith('/dsh-workbench/set')) return { ok: false, status: 500, statusText: 'boom', json: async () => ({ error: 'boom' }) };
  if (path.startsWith('/dsh-workbench/status')) return { ok: true, json: async () => statusPayload(serverChecked) };
  throw new Error('unexpected ' + path);
};
const reaSw3 = switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0];
reaSw3.props.onClick({ stopPropagation() {} });   // 乐观关 → 失败 → 应回滚成开
await settle();
check('failed save rolls back to server truth', switches().filter((sw) => sw.props['aria-label'].startsWith('REA'))[0].props['aria-checked'] === 'true');
check('save error surfaced in popover', textOf().includes('保存失败'));

// 6. error state shows retry inside the popover (fetch fails)
globalThis.fetch = async (path) => {
  if (path.startsWith('/dsh-workbench/status')) return { ok: false, status: 503, statusText: 'down', json: async () => ({ error: 'host down' }) };
  if (path.startsWith('/dsh-workbench/set')) throw new Error('offline');
  throw new Error('unexpected ' + path);
};
// 首载失败路径：换一个全新 sessionId（status 缓存为空）→ popover 应显示错误 + 重试。
// 首载失败：全新 sessionId，模块内的 statusCache 没有它的记录 → refresh 被拒绝、
// status 停在 null。挂载效果会在每次渲染时触发 refresh，靠重渲染轮到错误落地。
hookState = []; hookIndex = 0; pendingEffects = []; cleanups = [];
let errText = '';
let retrySeen = false;
for (let round = 0; round < 14; round += 1) {
  rerender = false; hookIndex = 0; pendingEffects = [];
  tree = registeredComponent({ sessionId: 's-error' });
  for (const fn of pendingEffects) { const d = fn(); if (typeof d === 'function') cleanups.push(d); }
  await new Promise((r) => setTimeout(r, 3));
  const out = []; walk(tree, (n) => { if (n.text !== undefined) out.push(n.text); });
  errText = out.join(' ').replace(/\s+/g, ' ');
  retrySeen = findNodes((n) => String(n.props.className) === 'wb-retry').length > 0;
  if (errText.includes('host down') && retrySeen) break;
}
// 点开浮层是必须的一步：closed 态只有胶囊。上面循环里渲染的是 closed 树，
// 所以这里在「有错误文本」后手动点开再验一次浮层内容。
if (!errText.includes('host down')) {
  const chipErr = findNodes((n) => n.type === 'button' && String(n.props.className ?? '').includes('wb-chip'))[0];
  chipErr?.props.onClick?.();
  hookIndex = 0; pendingEffects = [];
  tree = registeredComponent({ sessionId: 's-error' });
  for (const fn of pendingEffects) { const d = fn(); if (typeof d === 'function') cleanups.push(d); }
  const out = []; walk(tree, (n) => { if (n.text !== undefined) out.push(n.text); });
  errText = out.join(' ').replace(/\s+/g, ' ');
  retrySeen = findNodes((n) => String(n.props.className) === 'wb-retry').length > 0;
}
check('error surfaces in popover', errText.includes('host down'));
check('retry offered on failure', retrySeen);

for (const fn of cleanups.splice(0)) fn();
console.log(failures.length === 0 ? '\nSELFTEST PASS' : `\nSELFTEST FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
