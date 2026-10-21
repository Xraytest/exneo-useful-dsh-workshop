/**
 * dsh-archived-sessions 浏览器半边自测（headless，不需要浏览器）。
 *
 *   node plugins/dsh-archived-sessions/client-selftest.mjs
 *
 * 做法：用 `new Function` 以脚本语义执行 client.js（只影子化 window / document /
 * require / fetch），捕获 __ModuleLoader__.load 注册，再用一个只实现
 * useState/useRef/useCallback/useEffect 的 react 桩「渲染」设置页那一节——
 * createElement 返回纯对象树，断言直接读树。零 DOM、零请求真发。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// ── 1. 定时器：自测里不需要真的跑，也不能挂住 event loop ────────────────────
let timerSeq = 0;
globalThis.setInterval = () => ++timerSeq;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => ++timerSeq;
globalThis.clearTimeout = () => {};
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── 2. fetch 桩：记录请求，按 URL 回放负载；manual 模式交测试手动 resolve ──
let listPayload = { workspaces: [], unassigned: [] };
let searchPayload = { results: [], scannedIds: [], pendingIds: [], engine: 'literal', elapsedMs: 1 };
let restorePayload = { restored: true };
let deletePayload = { requested: 0, deleted: [], skipped: [], failed: [] };
/** /dsh-device-mesh/drivers 回放负载（执行端判定；13c 注入 DRIVERS，别处默认 null）。 */
let driversPayload = null;
/** 临时换负载函数（13d 用；null = 用默认 payloadFor）。 */
let payloadForOverride = null;
const requests = [];
const pending = [];
let manualFetch = false;
/** 非 200 时按这个状态码回（用来验证「host 半边没生效」的 404 解释文案）。 */
let httpStatus = 200;
function payloadFor(target) {
  return target.indexOf('/dsh-arcsess/search') !== -1 ? searchPayload
    : (target.indexOf('/dsh-arcsess/restore') !== -1 ? restorePayload
      : (target.indexOf('/dsh-arcsess/delete') !== -1 ? deletePayload
        : (target.indexOf('/dsh-device-mesh/drivers') !== -1 ? driversPayload : listPayload)));
}
const resolveFetch = (entry, payloadOverride) => {
  const payload = payloadOverride !== undefined ? payloadOverride : payloadFor(entry.url);
  entry.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
};
const fetchStub = async (url, options) => {
  const target = String(url);
  const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : null;
  const entry = { url: target, method: (options && options.method) || 'GET', body, signal: options && options.signal, resolve: null };
  requests.push(entry);
  if (httpStatus !== 200) {
    return { ok: false, status: httpStatus, statusText: 'Not Found', json: async () => ({ error: 'Not Found' }) };
  }
  if (!manualFetch) return { ok: true, status: 200, statusText: 'OK', json: async () => payloadFor(target) };
  return new Promise((resolve) => { entry.resolve = resolve; pending.push(entry); });
};

// ── 3. react 桩：createElement 造纯对象树；useState 可写回并记账 ───────────
let hookIndex = 0;
let stateOverrides = [];
let stateLog = [];
let refSlots = [];
const effects = [];
function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { $$element: true, type, props: merged };
}
const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  /** 返回 [值, 写回函数]：写回按 useState 语义（支持函数式更新）更新本次渲染的
   *  state 数组并记入 stateLog，测试即可断言异步流程写了什么、顺序如何。 */
  useState(initial) {
    const index = hookIndex++;
    const seed = () => (typeof initial === 'function' ? initial() : initial);
    if (index >= stateOverrides.length) stateOverrides[index] = undefined;
    const current = stateOverrides[index] === undefined ? seed() : stateOverrides[index];
    const setter = (value) => {
      const previous = stateOverrides[index] === undefined ? seed() : stateOverrides[index];
      const next = typeof value === 'function' ? value(previous) : value;
      stateOverrides[index] = next;
      stateLog.push({ index, value: next });
      return next;
    };
    return [current, setter];
  },
  /** 与真实 React 一致：ref 挂在组件实例上，跨渲染保持同一个对象
   *  （inflight / searchSeq 这类换代守卫的语义全靠这一条）。 */
  useRef(initial) {
    const index = hookIndex++;
    if (refSlots[index] === undefined) refSlots[index] = { current: initial };
    return refSlots[index];
  },
  useCallback(fn) { hookIndex += 1; return fn; },
  useEffect(fn) { hookIndex += 1; effects.push(fn); },
  useMemo(fn) { hookIndex += 1; return fn(); },
};
const ReactDOM = { createPortal(children, container) { return { $$element: true, type: 'portal', props: { children }, container }; } };

// ── 4. document 桩（含 style 注入记账） ────────────────────────────────────
const styleNodes = [];
const documentStub = {
  head: {
    appendChild(node) {
      node.parentNode = { removeChild(target) { const at = styleNodes.indexOf(target); if (at >= 0) styleNodes.splice(at, 1); } };
      styleNodes.push(node);
    },
  },
  documentElement: { appendChild(node) { styleNodes.push(node); } },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', parentNode: null, setAttribute() {} }),
  addEventListener() {}, removeEventListener() {},
};
globalThis.document = documentStub;

// ── 5. 捕获 __ModuleLoader__.load ─────────────────────────────────────────
let captured = null;
globalThis.window = {
  __ModuleLoader__: { load(entry) { captured = entry; } },
  innerWidth: 1440, addEventListener() {}, removeEventListener() {},
};

// ── 6. 以脚本语义执行 bundle（不经 ESM） ──────────────────────────────────
const require = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('unexpected require: ' + name);
};
new Function('window', 'document', 'require', 'fetch', source)(
  globalThis.window, documentStub, require, fetchStub,
);

assert.ok(captured !== null, 'factory 未注册到 __ModuleLoader__');
assert.equal(captured.id, 'dsh-archived-sessions');
const exports = captured.factory(require);
assert.deepEqual(exports.inject, ['slots', 'uiWorkspace']);
assert.equal(typeof exports.apply, 'function');

// ── 7. 假 cordis ctx（slots + uiWorkspace） ───────────────────────────────
const opened = [];
const registrations = [];
const injectedNames = [];
const ctxEffects = [];
const ctx = {
  slots: {
    inject(name, fn) { injectedNames.push(name); fn(); },
    register(meta, component) { registrations.push({ meta, component }); },
  },
  effect(factory, label) { ctxEffects.push({ factory, label }); },
  uiWorkspace: { openSession(id) { opened.push(id); } },
  get(name) { return undefined; },
};
exports.apply(ctx);

assert.deepEqual(injectedNames, ['settings.section']);
assert.equal(registrations.length, 1);
assert.equal(registrations[0].meta.name, 'settings.section');
assert.equal(registrations[0].meta.id, 'arcsess');
assert.equal(registrations[0].meta.order, 900);
assert.equal(registrations[0].meta.label, '归档会话');
assert.equal(styleNodes.length, 1, '样式应只注入一次');

// ── 8. 渲染 + 遍历辅助 ────────────────────────────────────────────────────
/** hook 次序：0 data 1 loading 2 error 3 busy 4 notice 5 query 6 mode
 *  7 includeTools 8 workspaceFilter 9 sortKey 10 collapsed 11 contentResults
 *  12 searching 13 searchInfo 14 scannedIds 15 tick */
function renderSection(overrides) {
  hookIndex = 0;
  stateOverrides = (overrides ?? []).slice();
  stateLog = [];
  effects.length = 0;
  const wrapper = registrations[0].component({ close: () => {} }); // 外层箭头 → 元素
  return wrapper.type(wrapper.props);                             // 真正跑 ArchivedSessions
}
/** 某次渲染后，最后一次写入该 state 槽的值（没写过则 undefined）。 */
const lastWrite = (index) => {
  for (let at = stateLog.length - 1; at >= 0; at -= 1) if (stateLog[at].index === index) return stateLog[at].value;
  return undefined;
};
const wroteIndex = (index) => stateLog.some((entry) => entry.index === index);
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item, visit); return; }
  if (node.$$element === true) { visit(node); walk(node.props.children, visit); }
}
/** 递归收集元素树里的全部文本（highlight() 这类返回「字符串 + 元素」混合数组，
 *  所以必须按数组递归，不能只看元素的一级 children）。 */
function collectText(node) {
  const parts = [];
  const visit = (value) => {
    if (typeof value === 'string') { parts.push(value); return; }
    if (typeof value === 'number') { parts.push(String(value)); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value !== null && typeof value === 'object' && value.$$element === true) visit(value.props.children);
  };
  visit(node);
  return parts.join(' | ');
}
function findAll(node, predicate) { const out = []; walk(node, (el) => { if (predicate(el)) out.push(el); }); return out; }
const buttonsIn = (node) => findAll(node, (el) => el.type === 'button');
const byClass = (node, cls) => findAll(node, (el) => typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls));

const S1 = { id: 's1', title: '龙门菜馆墙面修复', cwd: '/root/nas/ArkTower', createdAt: 1750000000000, live: false, persisted: true, origin: 'interactive' };
const S2 = { id: 's2', title: null, cwd: '/root/nas/ArkTower', createdAt: null, live: true, persisted: true };
const S3 = { id: 's3', title: '孤零零', cwd: null, createdAt: 1740000000000, live: false, persisted: false };
const DATA = {
  workspaces: [{ id: 'w1', title: 'ArkTower', path: '/root/nas/ArkTower', sessions: [S1, S2] }],
  unassigned: [S3],
  sessions: [S1, S2, S3],
};
const BASE = [DATA, false, null, null, null];
const withUi = (patch) => Object.assign(BASE.slice(), patch);

// ── 9. 分组契约 ───────────────────────────────────────────────────────────
let tree = renderSection(BASE);
assert.equal(byClass(tree, 'arcsess-group').length, 2, '工作区分组 + 未归入分组');
let text = collectText(tree);
assert.ok(text.includes('ArkTower'), '工作区名');
assert.ok(text.includes('/root/nas/ArkTower'), '工作区路径');
assert.ok(text.includes('未归入工作区'), '未归入桶');
assert.ok(text.includes('龙门菜馆墙面修复'), '会话标题');
assert.ok(text.includes('s2'), '无标题回落 id');
assert.ok(text.includes('运行中'), 'live 标记');
assert.ok(text.includes('日志已删除'), 'persisted=false 标记');
assert.ok(text.includes('共 3 个归档会话'), '状态行');

// 多个工作区：按后端给的顺序渲染，未登记会话按 cwd 兜底成独立分组
const S4 = { id: 's4', title: '另一处', cwd: '/root/code/rustdesk_server', createdAt: 1730000000000, live: false, persisted: true };
const S5 = { id: 's5', title: '第二处', cwd: '/root/code/rustdesk_server', createdAt: 1720000000000, live: false, persisted: true };
tree = renderSection([{
  workspaces: [
    { id: 'w1', title: 'ArkTower', path: '/root/nas/ArkTower', sessions: [S1] },
    { id: 'w2', title: 'rustdesk_server', path: '/root/code/rustdesk_server', sessions: [S4, S5] },
  ],
  unassigned: [S3],
  sessions: [S1, S3, S4, S5],
}, false, null, null, null]);
assert.equal(byClass(tree, 'arcsess-group').length, 3, '两个工作区 + 未归入桶');
const groupTitles = byClass(tree, 'arcsess-groupname').map((el) => collectText(el));
assert.equal(groupTitles.length, 3);
assert.ok(groupTitles[0].includes('ArkTower') && groupTitles[1].includes('rustdesk_server'), '分组顺序按后端');
assert.ok(groupTitles[2].includes('未归入工作区'), '第三个分组是未归入桶');

// 未登记桶里再按 cwd 兜底分组（临时目录会话不混在一起）
tree = renderSection([{
  workspaces: [],
  unassigned: [S4, S5, S3],
  sessions: [S3, S4, S5],
}, false, null, null, null]);
assert.equal(byClass(tree, 'arcsess-group').length, 2, 'unassigned 内部按 cwd 再分组');

// ── 10. 标题/路径即时筛选：纯前端，零请求 ─────────────────────────────────
requests.length = 0;
tree = renderSection(withUi({ 5: '龙门' }));
assert.equal(byClass(tree, 'arcsess-group').length, 1);
assert.equal(byClass(tree, 'arcsess-row').length, 1);
assert.equal(requests.length, 0, '即时筛选不得发请求');

// 路径也算元数据命中
tree = renderSection(withUi({ 5: 'rustdesk' }));
assert.equal(byClass(tree, 'arcsess-row').length, 0, '样例数据里没有该路径的会话');

// ── 11. 折叠 ──────────────────────────────────────────────────────────────
tree = renderSection(withUi({ 10: new Set(['ws:w1']) }));
assert.equal(byClass(tree, 'arcsess-row').length, 1, '折叠分组隐藏其会话');

// ── 12. 内容检索 → GET /dsh-arcsess/search ───────────────────────────────
requests.length = 0;
searchPayload = {
  results: [{ id: 's1', matchCount: 7, matches: [{ type: 'assistant/message', snippet: '墙面修复完成', highlightStart: 0, highlightEnd: 2 }] }],
  scannedIds: ['s1'], pendingIds: [], engine: 'fts', elapsedMs: 12,
};
tree = renderSection(withUi({ 5: '墙面', 6: 'content' }));
const searchBtn = buttonsIn(tree).find((b) => collectText(b) === '检索内容');
assert.ok(searchBtn !== undefined, '内容模式下有「检索内容」按钮');
searchBtn.props.onClick();
await tick(); await tick();
const searchReq = requests.find((r) => r.url.indexOf('/dsh-arcsess/search') !== -1);
assert.ok(searchReq !== undefined);
assert.ok(searchReq.url.includes('q=' + encodeURIComponent('墙面')));
assert.ok(searchReq.url.includes('limit=3'));
assert.ok(searchReq.url.includes('includeTools=0'));
requests.length = 0;
buttonsIn(renderSection(withUi({ 5: '墙面', 6: 'content', 7: true })))
  .find((b) => collectText(b) === '检索内容').props.onClick();
await tick(); await tick();
assert.ok(requests.find((r) => r.url.indexOf('/dsh-arcsess/search') !== -1).url.includes('includeTools=1'),
  '含工具输出开关要真的传到请求里');

tree = renderSection(withUi({ 5: 'zzz', 6: 'content' }));
assert.ok(collectText(tree).includes('需要点「检索内容」或回车'), '内容模式空态提示');

// 命中信息 + 退化引擎 tooltip
const engineSpan = byClass(renderSection(withUi({
  5: '墙面',
  6: 'content',
  11: new Map([['s1', { id: 's1', matchCount: 7, matches: [{ type: 'assistant/message', snippet: '墙面修复完成', highlightStart: 0, highlightEnd: 2 }] }]]),
  13: { engine: 'literal', reason: '部署未启用全文索引（openAt: "never"）', scanned: 3, pending: 1, hits: 1, errors: 0, elapsedMs: 1234, truncated: true, keyword: '墙面' },
  14: ['s1', 's2', 's3'],
})), 'arcsess-engine');
assert.equal(engineSpan.length, 1, '引擎标签单独成元素');
assert.equal(collectText(engineSpan[0]), '逐条扫描');
assert.equal(engineSpan[0].props.title, '部署未启用全文索引（openAt: "never"）', '退化原因挂在 title');
assert.ok(collectText(renderSection(withUi({
  5: '墙面',
  6: 'content',
  13: { engine: 'literal', reason: 'x', scanned: 3, pending: 1, hits: 1, errors: 0, elapsedMs: 1234, truncated: true, keyword: '墙面' },
  14: ['s1', 's2', 's3'],
}))).includes('还有 1 个未扫描'), '截断提示');
const resume = buttonsIn(renderSection(withUi({
  5: '墙面',
  6: 'content',
  13: { engine: 'literal', reason: 'x', scanned: 3, pending: 1, hits: 1, errors: 0, elapsedMs: 1234, truncated: true, keyword: '墙面' },
  14: ['s1', 's2', 's3'],
}))).find((b) => collectText(b) === '继续检索');
assert.ok(resume !== undefined, '截断时可续检');
requests.length = 0;
resume.props.onClick();
await tick(); await tick();
const resumeReq = requests.find((r) => r.url.indexOf('/dsh-arcsess/search') !== -1);
assert.ok(resumeReq.url.includes('skip=' + encodeURIComponent('s1,s2,s3')), '续检带已扫 id');

// ── 13. 恢复 + 打开 ───────────────────────────────────────────────────────
requests.length = 0;
opened.length = 0;
listPayload = {
  workspaces: [{ id: 'w2', title: 'rustdesk_server', path: '/root/code/rustdesk_server', sessions: [S4] }],
  unassigned: [S3],
  sessions: [S4, S3],
};
const restoreState = withUi({ 8: 'ws:w1' });        // 恢复后重载的清单里没有 ws:w1
renderSection(restoreState);
tree = renderSection(restoreState);
const openBtn = buttonsIn(tree).find((b) => collectText(b) === '恢复并打开');
assert.ok(openBtn !== undefined);
openBtn.props.onClick();
await tick(); await tick(); await tick();
const post = requests.find((r) => r.url.indexOf('/dsh-arcsess/restore') !== -1);
assert.equal(post.method, 'POST');
assert.deepEqual(post.body, { sessionId: 's1' });
assert.deepEqual(opened, ['s1'], 'uiWorkspace.openSession 被调用');
// 多机会话状态同步（2026-10-19）：恢复落地后必须把 unarchive 送设备网格 propose，
// 否则副本侧的 30 s 权威同步会把这次恢复撤销（见 client.js 头注释 ①）。
const propose = requests.find((r) => r.url.indexOf('/dsh-device-mesh/session-state/propose') !== -1);
assert.ok(propose !== undefined, '恢复后要送 mesh propose');
assert.equal(propose.method, 'POST');
assert.deepEqual(propose.body, { sessionId: 's1', action: 'unarchive' });
assert.ok(requests.some((r) => r.url.indexOf('/dsh-arcsess/list?fresh=1') !== -1), '恢复后带 fresh=1 重取');
assert.equal(lastWrite(8), 'all', '恢复后的刷新同样要回落失效的工作区筛选（与「刷新」走同一条入口）');
assert.deepEqual(lastWrite(0).workspaces.map((w) => w.id), ['w2'], '恢复后的刷新真的落了新清单');

// 已被别人恢复过的会话：提示而不是假装成功
requests.length = 0;
restorePayload = { restored: false };
const staleTree = renderSection(BASE);
buttonsIn(staleTree).find((b) => collectText(b) === '恢复').props.onClick();
await tick(); await tick(); await tick();
assert.ok(String(lastWrite(4)).includes('已不在归档集'), '后端说 restored:false 时必须提示');
restorePayload = { restored: true };

// ── 13b. 远程行：说明而不是假按钮 ─────────────────────────────────────────
// host 半边（v4/v5）会把网格里其它设备的归档会话并进清单（remote: true）。本机
// /restore 改不了那台设备的归档集，按钮只会 restored:false——所以远程行给说明。
// 组件的清单来自 state 槽 0（host 的 /list 落进 setData 之后的样子），这里直接
// 用带 remote 行的快照渲染。
const REMOTE_S2 = { ...S2, remote: true, deviceName: 'orangepi5' };
const REMOTE_DATA = {
  workspaces: [{ id: 'w1', title: 'ArkTower', path: '/root/nas/ArkTower', sessions: [S1, REMOTE_S2] }],
  unassigned: [],
  sessions: [S1, REMOTE_S2],
};
requests.length = 0;
const remoteTree = renderSection([REMOTE_DATA, false, null, null, null]);
const remoteText = collectText(remoteTree);
assert.ok(remoteText.includes('归档于 orangepi5'), '远程行的动作区给「归档于 设备名」说明');
const remoteRowButtons = buttonsIn(remoteTree).filter((b) => collectText(b) === '恢复' || collectText(b) === '恢复并打开');
// 全树只剩本机行（S1）的「恢复 + 恢复并打开」两个按钮；远程行（REMOTE_S2）不给按钮。
assert.equal(remoteRowButtons.length, 2, '本机行保留恢复两按钮，远程行不给按钮');
assert.ok(buttonsIn(remoteTree).some((b) => collectText(b) === '恢复'), '本机行照常有恢复按钮');
assert.ok(requests.length === 0, '渲染远程行本身不发起任何请求');

// ── 13d. 未登记分组的「删除历史」按钮 ───────────────────────────────────────
// 删除只给 fromHost=false（cwd 兜底）的未登记分组；已登记分组不给（删槽位要动
// sessionIds，不归本面板管）。点击 → POST /dsh-arcsess/delete {sessionIds}，
// 成功后逐条送 mesh propose unarchive，最后 fresh 重取。
const DELETE_DATA = {
  workspaces: [{ id: 'w1', title: 'ArkTower', path: '/root/nas/ArkTower', sessions: [S1] }],
  unassigned: [S3],           // → cwd 兜底组（S3 cwd=null → key 'none'）
  sessions: [S1, S3],
};
const delState = [DELETE_DATA, false, null, null, null, '', 'meta', false, 'all', 'created-desc', new Set(), new Map(), false, null, [], null];
requests.length = 0;
deletePayload = { requested: 1, deleted: ['s3'], skipped: [], failed: [] };
payloadForOverride = (target) => (target.indexOf('/dsh-arcsess/delete') !== -1 ? deletePayload : payloadFor(target));
const delTree = renderSection(delState);
const delButtons = buttonsIn(delTree).filter((b) => collectText(b) === '删除历史');
assert.equal(delButtons.length, 1, '未登记分组给「删除历史」按钮，已登记分组不给');
// 窗口确认桩：直接放行。
const confirmBackup = globalThis.window?.confirm;
const confirmCalls = [];
globalThis.window.confirm = (text) => { confirmCalls.push(text); return true; };
try {
  delButtons[0].props.onClick({ stopPropagation() {} });
  await tick(); await tick(); await tick(); await tick();
} finally {
  if (confirmBackup === undefined) delete globalThis.window.confirm;
  else globalThis.window.confirm = confirmBackup;
}
const delPost = requests.find((r) => r.url.indexOf('/dsh-arcsess/delete') !== -1);
assert.ok(delPost !== undefined, '点击后要 POST /dsh-arcsess/delete');
assert.equal(delPost.method, 'POST');
assert.deepEqual(delPost.body, { sessionIds: ['s3'] }, 'body 是该组全部本机会话 id');
assert.ok(confirmCalls.length === 1 && confirmCalls[0].includes('1'), '删除前要确认且报出条数');
// 删完逐条 propose unarchive（与恢复同套路：权威 30s 同步否则盖回幽灵行）。
const delPropose = requests.filter((r) => r.url.indexOf('/dsh-device-mesh/session-state/propose') !== -1);
assert.equal(delPropose.length, 1, '每个删掉的会话送一次 propose');
assert.deepEqual(delPropose[0].body, { sessionId: 's3', action: 'unarchive' });
assert.ok(String(lastWrite(4)).includes('已删除 1 条历史记录'), '删除结果要提示：' + String(lastWrite(4)));
assert.ok(requests.some((r) => r.url.indexOf('/dsh-arcsess/list?fresh=1') !== -1), '删除后带 fresh=1 重取');
payloadForOverride = null;

// ── 13c. 分组区分本地/远程工作区 ──────────────────────────────────────────
// 三种组（host mergeRemoteViews 的口径）都要在组头上有可分辨的标识：
//   ① 纯本机组 → 「本机工作区」；② 远程独有组（remote:true + deviceName）
//   → 「远程工作区 · 设备名」；③ 同名合并组（mixed 或组内混有 remote 行）
//   → 「本机 + 设备名（本机 X / 远程 Y）」。
// 2026-10-19 第三轮修正：「本地/远程」的真相是**执行端（属主）**，来自
// /dsh-device-mesh/drivers（与侧边栏 🌐 同源）——按 workspaceId 匹配分组。
// 本机 registry 记的「本机工作区」可能其实执行在属主那台（互联会话），必须
// 标「执行于 <属主>」而不是「本机工作区」。drivers 经 state 槽 15 注入
// （fetch 桩也回放，见 payloadFor 的 drivers 分支）。
const DRIVERS = {
  workspaces: [
    { workspaceId: 'w-local', path: '/home/x/AgentsWorkspace', owner: { isSelf: true, name: 'xray4668' } },
    { workspaceId: 'w-mixed', path: '/root/nas/ArkTower', owner: { isSelf: false, name: 'orangepi5' } },
  ],
};
const LOCAL_WS = { id: 'w-local', title: 'AgentsWorkspace', path: '/home/x/AgentsWorkspace', sessions: [S1] };
const REMOTE_WS = {
  id: 'remote:dev1:/root/only-there', title: 'OnlyOnPi', path: '/root/only-there',
  sessions: [{ id: 's-r1', title: '只在橙派', cwd: '/root/only-there', createdAt: 1750000000000, live: false, persisted: true, remote: true, deviceName: 'orangepi5' }],
  remote: true, deviceId: 'dev1', deviceName: 'orangepi5',
};
const MIXED_WS = {
  id: 'w-mixed', title: 'ArkTower', path: '/root/nas/ArkTower',
  sessions: [S2, { id: 's-r2', title: '橙派那半', cwd: '/root/nas/ArkTower', createdAt: 1750000500000, live: false, persisted: true, remote: true, deviceName: 'orangepi5' }],
  mixed: true,
};
const SCOPE_DATA = { workspaces: [LOCAL_WS, REMOTE_WS, MIXED_WS], unassigned: [], sessions: [] };
requests.length = 0;
const scopeState = [SCOPE_DATA, false, null, null, null, '', 'meta', false, 'all', 'created-desc', new Set(), new Map(), false, null, [], DRIVERS];
const scopeTree = renderSection(scopeState);
const scopeText = collectText(scopeTree);
assert.ok(scopeText.includes('本机工作区'), '属主是本机的工作区标「本机工作区」');
assert.ok(scopeText.includes('执行于 orangepi5'), '属主在别台的工作区标「执行于 属主」——互联工作区不得再错标「本机工作区」');
assert.ok(scopeText.includes('归档记录在 orangepi5'), '远程独有组另标「归档记录在 设备名」');
assert.ok(scopeText.includes('归档记录 本机+orangepi5（本机 1 / 远程 1）'), '合并组另标「归档记录 本机+设备（本机 X / 远程 Y）」');
// 状态行分组账目按执行端分开数：
assert.ok(scopeText.includes('3 个分组（本机执行 1 · 远程执行 1）'), '状态行按执行端分开计分组数');
// 工作区筛选下拉：执行端后缀（属主在别台）+ 归档记录后缀：
assert.ok(scopeText.includes('ArkTower · orangepi5 · 归档本机+orangepi5'), '下拉带执行端与归档记录双后缀');
// drivers 缺席（网格不在 / 还没回来）：不标执行端——宁可不标也不错标。
requests.length = 0;
const noDrvTree = renderSection([SCOPE_DATA, false, null, null, null, '', 'meta', false, 'all', 'created-desc', new Set(), new Map(), false, null, [], null]);
const noDrvText = collectText(noDrvTree);
assert.ok(!noDrvText.includes('本机工作区'), '无 drivers 判定时不得标「本机工作区」');
assert.ok(!noDrvText.includes('执行于'), '无 drivers 判定时不得标「执行于」');
assert.ok(noDrvText.includes('归档记录在 orangepi5'), '归档记录标识不依赖 drivers（来自 /list 本身）');

// ── 14. __test 纯函数缝 ───────────────────────────────────────────────────
const T = exports.__test;
assert.ok(T !== undefined, '__test 缝存在');
assert.deepEqual(T.termsOf('  Foo  BAR '), ['foo', 'bar']);
assert.equal(T.termsOf(null).length, 0);
assert.equal(T.matchSession({ title: '龙门菜馆', id: 's1', cwd: '/a/b' }, ['龙门', '菜馆']), true);
assert.equal(T.matchSession({ title: '龙门菜馆', id: 's1' }, ['龙门', 'zzz']), false);
assert.equal(T.matchSession({ title: 'x' }, []), true, '空词匹配一切');
assert.equal(T.matchSession({ id: 's1', cwd: '/root/nas/ArkTower' }, ['arktower']), true, '路径也参与元数据匹配');
assert.equal(T.matchSession({ id: 's1', workspaceTitle: 'ArkTower' }, ['arktower']), true, '工作区名参与匹配');
assert.equal(T.matchSession({ id: 's1', workspacePath: '/root/code/x' }, ['code']), true, '工作区路径参与匹配');
assert.equal(T.matchSession({ id: 's1', cwd: '/root/nas' }, ['arktower']), false);
assert.equal(T.baseName('/root/nas/ArkTower/'), 'ArkTower');
assert.equal(T.baseName('C:\\Users\\xray\\ArkTower'), 'ArkTower');
assert.equal(T.baseName(''), '');
assert.equal(T.groupKeyOf({ workspaceId: 'w1', cwd: '/x' }), 'ws:w1');
assert.equal(T.groupKeyOf({ cwd: '/x' }), 'cwd:/x');
assert.equal(T.groupKeyOf({}), 'none');
assert.deepEqual(T.buildGroups({ workspaces: [], unassigned: [S3] }).map((g) => g.key), ['none']);
assert.deepEqual(T.buildGroups(null), []);
assert.deepEqual(T.buildGroups({ sessions: [S1] }).map((g) => g.key), ['cwd:/root/nas/ArkTower']);
// buildGroups 的本地/远程三态分类：remote 只认「远程独有组」（host 声明 + 行全远程），
// 行混有本机行时降为 mixed；组上没声明时按行补齐（未登记兜底组同规则）。
const bgScope = T.buildGroups({
  workspaces: [
    { id: 'w-local', title: 'L', path: '/l', sessions: [S1] },
    { id: 'remote:d1:/r', title: 'R', path: '/r', sessions: [{ id: 'sr', remote: true, deviceName: 'pi' }], remote: true, deviceId: 'd1', deviceName: 'pi' },
    { id: 'w-mixed', title: 'M', path: '/m', sessions: [S1, { id: 'sm', remote: true, deviceName: 'pi' }], mixed: true },
    { id: 'w-undeclared', title: 'U', path: '/u', sessions: [S1, { id: 'su', remote: true, deviceName: 'pi' }] },
  ],
  unassigned: [], sessions: [],
});
assert.equal(bgScope[0].remote, false, '纯本机组 remote=false');
assert.equal(bgScope[0].mixed, false, '纯本机组 mixed=false');
assert.equal(bgScope[1].remote, true, '远程独有组 remote=true');
assert.equal(bgScope[1].mixed, false, '远程独有组 mixed=false');
assert.equal(bgScope[2].remote, false, '合并组（host 声明 mixed）remote=false');
assert.equal(bgScope[2].mixed, true, '合并组 mixed=true');
assert.equal(bgScope[2].devices.length, 1, '合并组按行统计设备账目');
assert.equal(bgScope[3].mixed, true, '组上未声明时按行补齐 mixed');
assert.equal(bgScope[3].remote, false, '未声明的合并组不得判成远程独有');
assert.deepEqual(bgScope[1].devices, [{ name: 'pi', count: 1 }], '设备账目带计数');
const vis = T.visibleGroups(T.buildGroups(DATA), { query: '', mode: 'meta', workspaceFilter: 'all', sortKey: 'created-desc' });
assert.equal(vis.length, 2);
assert.deepEqual(vis[0].sessions.map((s) => s.id), ['s1', 's2'], '默认最近创建在前');
assert.equal(T.visibleGroups(T.buildGroups(DATA), { query: '', mode: 'meta', workspaceFilter: 'none', sortKey: 'title' }).length, 1, '工作区筛选');
assert.ok(Array.isArray(T.highlight('abcdef', 1, 3)), '高亮切三段');
assert.equal(T.highlight('abcdef', -1, 3), 'abcdef', '越界区间退化为纯文本');
const joined = (parts) => [].concat(parts)
  .map((part) => (typeof part === 'string' ? part : String(part.props.children)))
  .join('');
assert.equal(joined(T.highlight('abcdef', 1, 3)), 'abcdef', '高亮只切分不改字');
assert.equal(joined(T.highlight('会话内容', 0, 2)), '会话内容');
assert.equal(joined(T.highlight('abcdef', 0, 6)), 'abcdef');
assert.ok(T.PAGE_CSS.includes('.arcsess-input'));
assert.ok(/\.arcsess-group \{/.test(T.PAGE_CSS));

// ── 15. 续检门禁：换了检索词就不给续检按钮 / FTS 用游标续检 ────────────────
const searched = (patch) => Object.assign({
  engine: 'literal', reason: '', scanned: 2, pending: 1, hits: 1, errors: 0, elapsedMs: 10, truncated: true, cursor: '', keyword: '龙门',
}, patch);
const continueButton = (tree) => buttonsIn(tree).find((b) => collectText(b) === '继续检索');

assert.equal(continueButton(renderSection(withUi({
  5: '换了个词', 6: 'content', 13: searched({ keyword: '龙门' }), 14: ['s1'],
}))), undefined, '检索词与上一轮不同：不给续检按钮（否则会跳过真正命中的会话）');
assert.ok(continueButton(renderSection(withUi({
  5: '龙门', 6: 'content', 13: searched({}), 14: ['s1'],
}))) !== undefined, '同一个词才给续检');

requests.length = 0;
continueButton(renderSection(withUi({
  5: '龙门', 6: 'content', 13: searched({ engine: 'fts', cursor: 'CUR1' }), 14: ['s1'],
}))).props.onClick();
await tick(); await tick();
const ftsResumeUrl = requests.find((r) => r.url.indexOf('/dsh-arcsess/search') !== -1).url;
assert.ok(ftsResumeUrl.includes('cursor=CUR1'), '全文索引续检带游标');
assert.ok(!ftsResumeUrl.includes('skip='), '全文索引续检不传 skip（那是字面量扫描的语义）');

// 续检是「合并」而不是「覆盖」：上一轮的命中不能因为翻页丢掉（两条引擎都要）
requests.length = 0;
searchPayload = {
  results: [{ id: 's2', matchCount: 1, matches: [{ snippet: '第二页命中' }] }],
  scannedIds: ['s2'], pendingIds: [], engine: 'literal', elapsedMs: 8,
};
const carriedHits = new Map([['s1', { matchCount: 1, matches: [{ snippet: '第一页命中' }] }]]);
continueButton(renderSection(withUi({
  5: '龙门', 6: 'content', 11: carriedHits, 13: searched({}), 14: ['s1'],
}))).props.onClick();
await tick(); await tick();
assert.deepEqual([...lastWrite(11).keys()].sort(), ['s1', 's2'], '字面量续检把新命中并进已有命中，不覆盖');
assert.deepEqual(lastWrite(14).sort(), ['s1', 's2'], '已扫名单同样累加');

// FTS 续检只带游标（skip 为空），也必须走合并分支——否则第一页的命中整片消失
requests.length = 0;
searchPayload = {
  results: [{ id: 's2', matchCount: 1, matches: [{ snippet: '第二页命中' }] }],
  scannedIds: [], pendingIds: [], engine: 'fts', elapsedMs: 9, nextCursor: null, truncated: false,
};
continueButton(renderSection(withUi({
  5: '龙门', 6: 'content', 11: carriedHits, 13: searched({ engine: 'fts', cursor: 'CUR1' }), 14: ['s1'],
}))).props.onClick();
await tick(); await tick();
assert.deepEqual([...lastWrite(11).keys()].sort(), ['s1', 's2'], '全文索引续检同样合并（游标翻页不得抹掉上一页）');
assert.equal(lastWrite(13).cursor, '', '末页之后不再给游标');
assert.equal(lastWrite(13).truncated, false);

// 换了检索词＝新一轮：已扫名单必须清零（否则续检会跳过本次真正命中的会话）
requests.length = 0;
searchPayload = {
  results: [{ id: 'sNEW', matchCount: 1, matches: [{ snippet: '新词命中' }] }],
  scannedIds: ['sNEW'], pendingIds: [], engine: 'literal', elapsedMs: 3,
};
renderSection(withUi({ 5: '新词', 6: 'content', 14: ['sOLD'] }));
buttonsIn(renderSection(withUi({ 5: '新词', 6: 'content', 14: ['sOLD'] })))
  .find((b) => collectText(b) === '检索内容').props.onClick();
await tick(); await tick();
assert.deepEqual(lastWrite(14), ['sNEW'], '全新一轮检索不得继承上一轮的已扫名单');

// ── 16. 换代保护：被取代的一代不得写状态 ──────────────────────────────────
manualFetch = true;
pending.length = 0;
requests.length = 0;
searchPayload = { results: [], scannedIds: [], pendingIds: [], engine: 'literal', elapsedMs: 1 };
const liveState = withUi({ 5: '龙门', 6: 'content' });
const clickSearchNow = () => {
  const tree2 = renderSection(liveState);
  const button = buttonsIn(tree2).find((b) => collectText(b) === '检索内容');
  assert.ok(button !== undefined && button.props.disabled === false, '检索按钮可点');
  button.props.onClick();
};
clickSearchNow();
await tick();
const firstReq = pending[0];
assert.ok(firstReq !== undefined, '第一代请求已发出');
clickSearchNow();                                   // 用户连点 / 又按了一次回车
await tick();
const secondReq = pending[1];
assert.ok(secondReq !== undefined, '第二代请求已发出');
assert.equal(firstReq.signal.aborted, true, '新一代取消旧一代');
const mark = stateLog.length;
resolveFetch(firstReq, {
  results: [{ id: 's1', matchCount: 1, matches: [{ snippet: '旧一代命中', highlightStart: 0, highlightEnd: 1 }] }],
  scannedIds: ['s1'], pendingIds: [], engine: 'literal', elapsedMs: 5,
});
await tick(); await tick(); await tick();
const afterFirst = stateLog.slice(mark);
assert.equal(afterFirst.some((entry) => entry.index === 12), false, '被取代的一代不得结束「检索中」');
assert.equal(afterFirst.some((entry) => entry.index === 11), false, '被取代的一代不得写入命中');
assert.equal(afterFirst.some((entry) => entry.index === 14), false, '被取代的一代不得写入已扫名单');
assert.equal(afterFirst.some((entry) => entry.index === 13), false, '被取代的一代不得写入检索信息');
assert.equal(afterFirst.length, 0, '被取代的一代一个状态都不许写');
resolveFetch(secondReq, {
  results: [{ id: 's2', matchCount: 2, matches: [{ snippet: '新一代命中', highlightStart: 0, highlightEnd: 1 }] }],
  scannedIds: ['s2'], pendingIds: [], engine: 'literal', elapsedMs: 6,
});
await tick(); await tick(); await tick();
assert.equal(wroteIndex(11), true, '最新一代写入命中');
assert.equal(lastWrite(12), false, '最新一代收尾时把「检索中」置回 false');
assert.deepEqual([...lastWrite(11).keys()], ['s2'], '只留最新一代的命中');
assert.deepEqual(lastWrite(14), ['s2'], '已扫名单来自 scannedIds（不是 pendingIds）');
assert.equal(lastWrite(13).truncated, false);
assert.equal(lastWrite(13).engine, 'literal', '引擎标签按后端回报，不硬编码');
manualFetch = false;

// ── 17. 工作区筛选 key 消失后回落 all（否则列表静默变空） ─────────────────
listPayload = DATA;
const staleFilterState = withUi({ 8: 'ws:gone' });
const refreshTree = renderSection(staleFilterState);
const refreshBtn = buttonsIn(refreshTree).find((b) => collectText(b) === '刷新');
const freshTree = renderSection(staleFilterState);
buttonsIn(freshTree).find((b) => collectText(b) === '刷新').props.onClick();
await tick(); await tick();
assert.equal(lastWrite(8), 'all', '重建选项后失效的筛选 key 必须退回 all');
assert.ok(refreshBtn !== undefined);

// ── 18. 命中片段只在内容检索模式下、且检索词没变时才贴出来 ────────────────
const hitMap = new Map([['s1', { matchCount: 1, matches: [{ snippet: '只属于内容模式的片段' }] }]]);
assert.ok(!collectText(renderSection(withUi({ 6: 'meta', 11: hitMap, 13: searched({ keyword: '' }) })))
  .includes('只属于内容模式的片段'), '标题/路径模式不带上一轮检索的片段');
assert.ok(collectText(renderSection(withUi({ 6: 'content', 11: hitMap, 13: searched({ keyword: '' }) })))
  .includes('只属于内容模式的片段'), '内容模式且检索词未变：照常展示片段');
assert.ok(!collectText(renderSection(withUi({ 6: 'content', 11: hitMap, 13: searched({ keyword: '上一轮的词' }) })))
  .includes('只属于内容模式的片段'), '输入框换了词：旧片段与「只靠内容命中」的行都不该再露出来（它们属于上一轮的词）');
const staleHitsTree = renderSection(withUi({ 5: '完全不同', 6: 'content', 11: hitMap, 13: searched({ keyword: '上一轮的词' }) }));
assert.equal(byClass(staleHitsTree, 'arcsess-row').length, 0, '旧命中不得把不匹配当前检索词的会话留在列表里');

// ── 19. Escape：先清检索词，输入框已空才让面板关 ──────────────────────────
const inputOf = (tree) => findAll(tree, (el) => el.type === 'input' && el.props.className === 'arcsess-input')[0];
let stopped = 0;
inputOf(renderSection(withUi({ 5: '龙门' })))
  .props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped += 1; } });
assert.equal(stopped, 1, '有检索词时吃掉 Escape（一次 Escape 不连面板一起关）');
assert.equal(lastWrite(5), '', 'Escape 清空检索词');
stopped = 0;
inputOf(renderSection(withUi({ 5: '' })))
  .props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped += 1; } });
assert.equal(stopped, 0, '输入框已空时 Escape 继续冒泡');

// ── 20. 无鼠标可达：引擎退化原因 + 模式选中态 ─────────────────────────────
const engineNode = byClass(renderSection(withUi({
  5: '墙面', 6: 'content', 13: searched({ engine: 'literal', reason: '部署未启用全文索引' }),
})), 'arcsess-engine')[0];
assert.equal(engineNode.props.tabIndex, 0, '引擎标签可聚焦（原因不只靠 hover）');
assert.ok(String(engineNode.props['aria-label']).includes('部署未启用全文索引'), '原因进 aria-label');
const modeNodes = byClass(renderSection(withUi({ 6: 'content' })), 'arcsess-mode');
assert.equal(modeNodes.filter((node) => node.props['aria-pressed'] === true).length, 1, '模式选中态有 aria-pressed');

// host 半边没生效（旧实现 / 插件被停用）时 /search 是 404：给出人话解释而不是原始状态码
httpStatus = 404;
requests.length = 0;
buttonsIn(renderSection(withUi({ 5: '墙面', 6: 'content' })))
  .find((b) => collectText(b) === '检索内容').props.onClick();
await tick(); await tick(); await tick();
assert.ok(String(lastWrite(2)).includes('host 半边还是旧版本'), '404 要说清是 host 半边没生效');
assert.equal(lastWrite(12), false, '失败也要把「检索中」放掉');
httpStatus = 200;

console.log('CLIENT SELFTEST PASS');
