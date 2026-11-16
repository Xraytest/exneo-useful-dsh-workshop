/**
 * client.js v4 自测：设置页「改动即自动保存」契约 + 外观相关结构。
 *
 * 与 v3 的差别：桩升级成「有状态的 React」——
 *   · useState 的值存在 store 里（setState 支持函数式更新），跨渲染保持；
 *   · useRef 按位置持久（v3 的桩每次渲染都新建，测不出防抖/基线）；
 *   · useEffect 收集后可显式执行；setTimeout 换成**虚拟队列**（可断言防抖、可取消）；
 *   · 渲染后断言 hook 数量，hook 结构一变就显式失败，而不是悄悄错位。
 */

import { readFileSync } from 'node:fs';
import { createContext, runInNewContext } from 'node:vm';

const CHECKS = [];
function ok(label) {
  CHECKS.push(label);
  console.log('ok  ', label);
}
function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
}

/* ------------------------------------------------------------ React 桩 */
const stateStore = [];
const refStore = [];
let hookIndex = 0;
let effects = [];
let hookCount = 0;

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { $$element: true, type, props: merged };
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = hookIndex++;
    hookCount += 1;
    if (!(index in stateStore)) stateStore[index] = initial;
    return [stateStore[index], (next) => {
      stateStore[index] = typeof next === 'function' ? next(stateStore[index]) : next;
    }];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!(index in refStore)) refStore[index] = { current: initial };
    return refStore[index];
  },
  useCallback(fn) { hookIndex++; return fn; },
  useMemo(fn) { hookIndex++; return fn(); },
  useEffect(fn) { hookIndex++; effects.push(fn); },
};
const ReactDOM = { createPortal(children) { return { $$element: true, type: 'portal', props: { children } }; } };

/* ------------------------------------------------------------ 定时器桩 */
let timerSeq = 0;
const timers = new Map();
function setTimeoutStub(fn, ms) {
  const id = ++timerSeq;
  timers.set(id, { fn, ms });
  return id;
}
function clearTimeoutStub(id) { timers.delete(id); }
function flushTimers() {
  let guard = 0;
  while (timers.size > 0) {
    if (guard++ > 50) throw new Error('定时器自激（防抖没有收敛）');
    const entry = timers.entries().next().value;
    timers.delete(entry[0]);
    entry[1].fn();
  }
}

/* ------------------------------------------------------------ fetch 桩 */
const FULL_SETTINGS = {
  cadence: 'all-prompts',
  targetWords: 6,
  targetCjkCharacters: 12,
  maxInputBytes: 65536,
  maxOutputTokens: 2048,
  timeoutMs: 120000,
  toolResultMaxBytes: 1200,
  includeSystemPrompt: false,
  includeInjectedContext: false,
  includeToolResults: true,
  logRequests: false,
  textFallback: true,
  autoRefreshOnTurnEnd: true,
  instructions: '用中文，别加书名号',
  globalModel: { mode: 'custom', provider: 'ds', model: 'deepseek-chat' },
  rules: [
    { id: 'rule-1', name: '数学会话', matchType: 'sessionId', matchValue: 'session-math', provider: 'ds', model: 'reasoner', enabled: true },
  ],
  scope: 'recentTurns',
  recentTurns: 2,
  recentMessages: 6,
};
const PROVIDERS = [{ id: 'ds', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }] }];

let requests = [];
function fetchStub(url, options) {
  const body = options !== undefined && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  requests.push({ url, method: (options && options.method) || 'GET', body });
  let payload;
  if (url.indexOf('/settings') >= 0 && (options && options.method) === 'POST') {
    // 模拟 host：归一化后整份回吐（trim、规则补 id/name）
    payload = { ok: true, settings: JSON.parse(JSON.stringify(body.settings)) };
  } else if (url.indexOf('/settings') >= 0) {
    payload = { ok: true, settings: FULL_SETTINGS };
  } else if (url.indexOf('/models') >= 0) {
    payload = { ok: true, providers: PROVIDERS };
  } else {
    payload = { ok: true };
  }
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)) });
}

const documentStub = {
  head: { appendChild() {} },
  documentElement: { appendChild() {} },
  body: {},
  getElementById: () => null,
  createElement: () => ({ set textContent(value) {}, setAttribute() {}, id: '' }),
  addEventListener() {},
  removeEventListener() {},
};

/* ------------------------------------------------------------ 载入模块 */
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const listeners = [];
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => listeners.push(registration) } },
  document: documentStub,
  fetch: fetchStub,
  setTimeout: setTimeoutStub,
  clearTimeout: clearTimeoutStub,
  setInterval: () => 0,
  clearInterval: () => {},
  console,
  Promise,
  Date,
  RegExp,
  JSON,
  Number,
  String,
  Object,
  Array,
  Blob: function Blob() {},
};
sandbox.globalThis = sandbox;
runInNewContext(source, createContext(sandbox), { filename: 'client.js' });

assert(listeners.length === 1 && listeners[0].id === 'dsh-session-title-context', '模块注册');
ok('client.js 以包名注册进模块表');

const moduleExports = listeners[0].factory((spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return ReactDOM;
  throw new Error('未预期 require ' + spec);
});
assert(typeof moduleExports.apply === 'function', 'apply 是函数');
assert(moduleExports.inject.includes('slots') && moduleExports.inject.includes('sessions'), 'inject 含 slots+sessions');
ok('导出 apply/inject');

/* ------------------------------------------------------------ 装配 */
const registrations = [];
const injections = [];
const fakeCtx = {
  sessions: { list: { getSnapshot: () => ({ byId: { 'session-math': { id: 'session-math', title: '高等数学讨论' } } }) } },
  slots: {
    inject(name, callback) { injections.push(name); callback(); },
    register(meta, component) { registrations.push({ meta, component }); },
  },
};
moduleExports.apply(fakeCtx);

assert(injections.length === 2 && injections[0] === 'settings.section' && injections[1] === 'conversation.session.header.utilities', '应注入 settings.section + conversation.session.header.utilities，实际=' + injections.join(','));
assert(injections.includes('conversation.session.header.utilities'), '标题栏槽位应注入（纯重算按钮）');
const reg = registrations[0];
assert(reg.meta.id === 'session-title-context' && reg.meta.order === 48, 'meta id/order');
assert(typeof reg.meta.label === 'function' && reg.meta.label() === '标题总结', 'section 标签＝标题总结');
ok('设置页注入 settings.section（id=session-title-context, order=48），标题栏保留纯重算按钮');

/* ------------------------------------------------------------ 渲染工具 */
const Page = reg.component;
const EXPECTED_HOOKS = 9; // 0 settings 1 providers 2 loading 3 save 4 showForm 5 draft 6 formError 7 editing 8 undo

function render() {
  hookIndex = 0;
  hookCount = 0;
  effects = [];
  const node = Page({ ctx: fakeCtx });
  assert(hookCount === EXPECTED_HOOKS, 'hook 数量变了（现在 ' + hookCount + '，期望 ' + EXPECTED_HOOKS + '）——同步更新 client-selftest.mjs 的顺序表');
  return node;
}

function runEffects() {
  for (const fn of effects) fn();
}

/** 一轮交互：清掉旧定时器 → 改状态 → 重渲染 → 跑 effect → 冲到点 → 收微任务。 */
async function step(mutate) {
  timers.clear();
  requests = [];
  if (mutate !== undefined) mutate();
  const node = render();
  runEffects();
  const before = timers.size;
  flushTimers();
  await new Promise((resolve) => setImmediate(resolve));
  // 再渲染一次：effect 里 setSave 之类的状态要反映到返回的树上（桩不会自动重渲染）
  const after = render();
  return { node: after, first: node, scheduled: before, requests: requests.slice() };
}

function nodes(node, out) {
  const acc = out === undefined ? [] : out;
  if (!node) return acc;
  if (Array.isArray(node)) { for (const item of node) nodes(item, acc); return acc; }
  if (typeof node === 'object' && node.$$element === true) {
    acc.push(node);
    const children = node.props ? node.props.children : undefined;
    nodes(children, acc);
  }
  return acc;
}

function textOf(node) {
  const parts = [];
  for (const element of nodes(node)) {
    const children = element.props ? element.props.children : undefined;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) if (typeof child === 'string') parts.push(child);
  }
  return parts.join(' | ');
}

const byField = (node, field) => nodes(node).filter((el) => el.props && el.props['data-field'] === field)[0];
const byValue = (node, value) => nodes(node).filter((el) => el.props && el.props['data-value'] === value)[0];
const byLabel = (node, label) => nodes(node).filter((el) => el.props && el.props['aria-label'] === label)[0];
const posts = (list) => list.filter((item) => item.method === 'POST' && item.url.indexOf('/settings') >= 0);

/* ------------------------------------------------------------ 1. 首帧 */
const loadingNode = render();
assert(textOf(loadingNode).indexOf('正在读取标题总结设置') >= 0, 'loading 帧');
ok('首帧显示读取中状态');

// 挂载：跑一次 effect（load 有 startedRef 闸门，重渲染不会再拉），等 fetch 落地后再渲染。
runEffects();
await new Promise((resolve) => setImmediate(resolve));
render();

/* ------------------------------------------------------------ 2. 就绪帧 */
const ready = await step();
const text = textOf(ready.node);
assert(text.indexOf('标题总结') >= 0, '页面标题');
assert(text.indexOf('会话专用模型规则') >= 0, '规则卡片');
assert(text.indexOf('喂给标题模型的上下文') >= 0, '上下文卡片');
assert(text.indexOf('生成节奏与标题长度') >= 0, '节奏卡片');
assert(text.indexOf('数学会话') >= 0, '规则行渲染');
assert(text.indexOf('session-math') >= 0, '规则匹配值渲染');
assert(text.indexOf('ds/reasoner') >= 0, '规则模型渲染');
assert(text.indexOf('/title') >= 0, '设置页里说明 /title');
assert(text.indexOf('改动会自动保存') >= 0, '状态胶囊说明自动保存');
assert(posts(ready.requests).length === 0, '首次加载不得回写（基线只记账）');
ok('首帧渲染完整：四张卡片 + 规则行 + /title 提示 + 自动保存胶囊');
ok('首次加载只记基线，不发 POST（不会把磁盘配置重写一遍）');

/* ------------------------------------------------------------ 3. 没有保存按钮 */
const buttons = nodes(ready.node).filter((el) => el.type === 'button');
const buttonText = buttons.map((el) => textOf(el)).join(' | ');
assert(buttonText.indexOf('保存全部设置') < 0, '不应再有「保存全部设置」按钮');
assert(source.indexOf("'" + '保存全部设置' + "'") < 0, '源码里不应残留保存按钮文案（注释里提到不算）');
ok('底部「保存全部设置」按钮已移除（' + buttons.length + ' 个按钮，均非保存）');

/* ------------------------------------------------------------ 4. 改动即自动保存 */
const cadenceBtn = byValue(ready.node, 'first-prompt');
assert(cadenceBtn !== undefined && cadenceBtn.type === 'button', '找到节奏分段按钮');
const afterCadence = await step(() => { cadenceBtn.props.onClick(); });
assert(posts(afterCadence.requests).length === 1, '一次改动应产生恰好一笔 POST，实际 ' + posts(afterCadence.requests).length);
const body1 = posts(afterCadence.requests)[0].body.settings;
assert(body1.cadence === 'first-prompt', '提交带上新 cadence');
assert(body1.rules.length === 1 && body1.rules[0].id === 'rule-1', '整份回传：规则不能丢');
assert(body1.instructions === FULL_SETTINGS.instructions, '整份回传：页面无控件的 instructions 必须原样带回');
assert(body1.timeoutMs === 120000 && body1.maxOutputTokens === 2048, '整份回传：隐藏键（timeoutMs/maxOutputTokens）不能回落默认');
assert(body1.scope === 'recentTurns' && body1.recentTurns === 2, '整份回传：上下文量原样');
assert(afterCadence.scheduled === 1, '改动后应恰好排一个防抖定时器');
ok('改一下节奏 → 防抖 1 个定时器 → POST 整份设置（规则/隐藏键全带上）');

const idleAgain = await step();
assert(posts(idleAgain.requests).length === 0, '没有改动时不得重复 POST');
ok('没有改动时不再发请求（值与已落盘一致就静默）');

/* ------------------------------------------------------------ 5. 半成品不提交 */
const blockedStep = await step(() => {
  stateStore[0] = Object.assign({}, stateStore[0], { globalModel: { mode: 'custom', provider: '', model: '' } });
});
assert(posts(blockedStep.requests).length === 0, 'globalModel 半成品不得提交（host 会 400）');
assert(textOf(blockedStep.node).indexOf('待完善后自动保存') >= 0, '胶囊应显示待完善');
assert(textOf(blockedStep.node).indexOf('先不提交') >= 0, '字段下方应有说明');
ok('选了「指定全局标题模型」但没选模型 → 不提交，胶囊显示待完善');

const pickedStep = await step(() => {
  stateStore[0] = Object.assign({}, stateStore[0], { globalModel: { mode: 'custom', provider: 'ds', model: 'reasoner' } });
});
assert(posts(pickedStep.requests).length === 1, '选好模型后应立刻落盘');
assert(posts(pickedStep.requests)[0].body.settings.globalModel.model === 'reasoner', '提交带上新模型');
ok('模型一选好立刻自动保存');

/* ------------------------------------------------------------ 6. 删除规则 + 撤销 */
const delBtn = byLabel(pickedStep.node, '删除规则');
assert(delBtn !== undefined, '找到删除按钮');
const deletedStep = await step(() => { delBtn.props.onClick(); });
assert(posts(deletedStep.requests).length === 1, '删除应即时保存');
assert(posts(deletedStep.requests)[0].body.settings.rules.length === 0, '提交里规则已删');
const deletedText = textOf(deletedStep.node);
assert(deletedText.indexOf('已删除规则') >= 0 && deletedText.indexOf('撤销') >= 0, '顶部应出现撤销条');
ok('删除规则 → 立即保存 + 顶部可撤销');

/* ------------------------------------------------------------ 7. 数字输入 */
const recentInput = byField(deletedStep.node, 'recentTurns');
assert(recentInput !== undefined, '找到最近轮数输入框');
const badNumber = await step(() => { recentInput.props.onChange({ target: { value: 'abc' } }); });
assert(posts(badNumber.requests).length === 0, '非法数字不得落盘');
assert(textOf(badNumber.node).indexOf('需为 1–50 的整数') >= 0, '字段下方应提示取值范围');
const badInputAgain = byField(badNumber.node, 'recentTurns');
assert(badInputAgain.props.value === 'abc', '编辑态保留用户原文，不被拍成默认值');
ok('非法数字：保留原文 + 提示 + 不落盘（不再被 Number("")||1 吞掉）');

const goodInput = byField(badNumber.node, 'recentTurns');
const goodNumber = await step(() => { goodInput.props.onChange({ target: { value: '7' } }); });
assert(posts(goodNumber.requests).length === 1, '合法整数应落盘');
assert(posts(goodNumber.requests)[0].body.settings.recentTurns === 7, '提交 7');
ok('改成合法整数 → 自动保存 7');

/* ------------------------------------------------------------ 8. 纯函数 */
const internals = moduleExports.__internals;
assert(internals !== undefined, '导出纯函数');
assert(internals.intOf('') === null && internals.intOf('1.5') === null && internals.intOf('-3') === null, 'intOf 拒绝空/小数/负数');
assert(internals.intOf('03') === 3 && internals.intOf(' 12 ') === 12, 'intOf 接受整数与空白');
assert(internals.ruleProblem({ matchValue: '', provider: 'a', model: 'b', matchType: 'sessionId' }) !== '', '空匹配值应报错');
assert(internals.ruleProblem({ matchValue: 'x', provider: '', model: '', matchType: 'sessionId' }) !== '', '缺模型应报错');
assert(internals.ruleProblem({ matchValue: '[', provider: 'a', model: 'b', matchType: 'regex' }) !== '', '坏正则应报错');
assert(internals.ruleProblem({ matchValue: 'x', provider: 'a', model: 'b', matchType: 'regex' }) === '', '合法规则应通过');
const payloadA = internals.payloadOf(FULL_SETTINGS);
const payloadB = internals.payloadOf(Object.assign({}, FULL_SETTINGS, { rules: FULL_SETTINGS.rules.slice() }));
assert(payloadA === payloadB, 'payload 序列化稳定（顺序无关、只比内容）');
ok('纯函数：intOf / ruleProblem / payloadOf 行为正确且稳定');

/* ------------------------------------------------------------ 9. 源码体检 */
assert(source.includes('conversation.session.header.utilities') && source.includes('function TitleBarButton'), '标题栏槽位与 TitleBarButton 组件在源码中');
assert(!/titleBtn[\s\S]{0,400}\.dstc-panel|titleBtn[\s\S]{0,400}position:\s*fixed/.test(source), '标题按钮不得有浮层/弹出设置面板');
assert(source.indexOf('AUTOSAVE_MS') >= 0, '防抖常量在场');
ok('确认：标题栏控件仍已移除，自动保存路径在位');

console.log('\nCLIENT SELFTEST PASS (' + CHECKS.length + ' checks)');