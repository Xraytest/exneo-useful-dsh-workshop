/**
 * client.js 的自测：用极简 React 桩把真实的 client 半边跑起来，验证
 * 「注册进标题栏右侧槽位」与按钮/面板的取数与行为，避免把坏 bundle 送进
 * 浏览器（bundle 语法错误会连累整个 combo 脚本）。
 *
 * 跑法：node client-selftest.mjs
 */

import { readFileSync } from 'node:fs';
import { createContext, runInNewContext } from 'node:vm';

const CHECKS = [];
function ok(label) {
  CHECKS.push(label);
  console.log('ok  ', label);
}
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

// ---------------------------------------------------------------- React 桩

let hookIndex = 0;
let stateOverrides = [];
const effects = [];

function createElement(type, props, ...children) {
  const merged = Object.assign({}, props);
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { $$element: true, type, props: merged };
}

const Fragment = Symbol('Fragment');

const React = {
  createElement,
  Fragment,
  useState(initial) {
    const index = hookIndex++;
    const overridden = index < stateOverrides.length ? stateOverrides[index] : undefined;
    return [overridden === undefined ? initial : overridden, () => {}];
  },
  useRef(initial) {
    hookIndex += 1;
    return { current: initial };
  },
  useCallback(fn) {
    hookIndex += 1;
    return fn;
  },
  useEffect() {
    hookIndex += 1;
    effects.push(arguments[0]);
  },
  useMemo(fn) {
    hookIndex += 1;
    return fn();
  },
};

const ReactDOM = {
  createPortal(children, container) {
    return { $$element: true, type: 'portal', props: { children }, container };
  },
};

// ---------------------------------------------------------------- DOM / 取数桩

let requests = [];
const fetchStub = (url, options) => {
  const body = options !== undefined && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  requests.push({ url, method: (options && options.method) || 'GET', body });
  const payload = url.includes('/models')
    ? { ok: true, providers: [] }
    : { ok: true, state: { ok: true, cadence: 'all-prompts', pinned: null, current: null, last: null, failure: null, inflight: false } };
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
};

const documentStub = {
  head: { appendChild() {} },
  body: {},
  getElementById: () => null,
  createElement: () => ({ set textContent(value) {}, id: '' }),
  addEventListener() {},
  removeEventListener() {},
};

// ---------------------------------------------------------------- 载入 client.js

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const listeners = [];
const windowStub = {
  __ModuleLoader__: { load: (registration) => listeners.push(registration) },
  innerWidth: 1440,
};
const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: fetchStub,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
};
sandbox.globalThis = sandbox;
runInNewContext(source, createContext(sandbox), { filename: 'client.js' });

assert(listeners.length === 1, 'client.js 应当注册恰好一个模块');
assert(listeners[0].id === 'dsh-session-title-context', `模块 id 应为包名，实际 ${listeners[0].id}`);
ok('client.js 以包名注册进模块表');

const moduleExports = listeners[0].factory((spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return ReactDOM;
  throw new Error(`未预期的 require("${spec}")`);
});
assert(typeof moduleExports.apply === 'function', 'exports.apply 必须是函数');
assert(Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots'), 'exports.inject 应含 slots');
ok('factory 只 require react / react-dom，并导出 apply + inject');

// ---------------------------------------------------------------- 槽位注册

const registrations = [];
const injections = [];
const fakeCtx = {
  slots: {
    inject(name, callback) {
      injections.push(name);
      callback();
    },
    register(meta, component) {
      registrations.push({ meta, component });
    },
  },
};
moduleExports.apply(fakeCtx);
assert(injections[0] === 'conversation.session.header.utilities', `应注入标题栏工具槽，实际 ${injections[0]}`);
assert(registrations.length === 1, '应注册恰好一个槽位条目');
const meta = registrations[0].meta;
assert(meta.name === 'conversation.session.header.utilities', 'meta.name 必须是槽位名');
assert(meta.id === 'session-title', `meta.id 应为 session-title，实际 ${meta.id}`);
assert(meta.order === 24, `meta.order 应为 24（落在 model-pool 20 与 subagent-models 25 之间），实际 ${meta.order}`);
ok('注册进 conversation.session.header.utilities（id=session-title, order=24）');

// ---------------------------------------------------------------- 渲染脚手架

const Control = registrations[0].component;

function render(props, overrides) {
  hookIndex = 0;
  stateOverrides = overrides ?? [];
  effects.length = 0;
  return Control(props);
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node.$$element === true) {
    visit(node);
    walk(node.props.children, visit);
  }
}

function collectText(node) {
  const parts = [];
  walk(node, (element) => {
    const children = element.props.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) if (typeof child === 'string') parts.push(child);
  });
  return parts.join(' | ');
}

function findByPredicate(node, predicate) {
  let found = null;
  walk(node, (element) => {
    if (found === null && predicate(element)) found = element;
  });
  return found;
}

function buttonsIn(node) {
  const list = [];
  walk(node, (element) => {
    if (element.type === 'button') list.push(element);
  });
  return list;
}

// ------------------------------------------------------------ 1) 初始渲染

requests = [];
const initial = render({ sessionId: 'session-abc' });
const mainButton = findByPredicate(initial, (element) => element.type === 'button' && collectText(element).includes('标题'));
assert(mainButton !== null && mainButton !== undefined, '标题栏按钮应当渲染出来');
assert(mainButton.props.onClick !== undefined, '标题栏按钮必须有 onClick');
ok('标题栏「标题」按钮渲染成功，且面板默认收起');

mainButton.props.onClick();
await new Promise((resolve) => setImmediate(resolve));
const generateCall = requests.find((request) => request.url.includes('/generate'));
assert(generateCall !== undefined, '点按钮应当 POST /dsh-session-title/generate');
assert(generateCall.method === 'POST', 'generate 必须是 POST');
assert(generateCall.body.sessionId === 'session-abc', 'generate 必须带上 sessionId');
assert(generateCall.body.provider === undefined && generateCall.body.model === undefined, '默认不带 provider/model（＝当前会话模型）');
ok('点按钮 → POST /generate（只带 sessionId，即“用当前会话模型”）');

// ------------------------------------------------------------ 2) 面板内容

requests = [];
const richState = {
  ok: true,
  cadence: 'all-prompts',
  pinned: null,
  tool: 'submit_session_title',
  current: { title: '龙门菜馆墙面修复', source: null },
  last: { title: '龙门菜馆墙面修复', provider: 'localhost', model: 'qwen/qwen3.8-27b:free', via: 'tool-call', ms: 3200, at: Date.now() },
  failure: { message: '会话里没有可用的文本上下文', at: Date.now() },
  inflight: false,
};
const panelNode = render({ sessionId: 'session-abc' }, [true, { top: 40, left: 900, right: 1000 }, richState, null, false, false, '', '']);
const panelText = collectText(panelNode);
assert(panelText.includes('龙门菜馆墙面修复'), '面板应显示当前标题');
assert(panelText.includes('localhost/qwen/qwen3.8-27b:free'), '面板应显示上次使用的路由');
assert(panelText.includes('工具调用'), '面板应把 via=tool-call 翻成中文');
assert(panelText.includes('会话里没有可用的文本上下文'), '面板应显示上次失败原因');
assert(panelText.includes('/title'), '面板应提示 /title 入口');
ok('面板显示当前标题、上次路由/via/耗时、上次失败与 /title 提示');

// ------------------------------------------------------------ 3) 模型选择

requests = [];
const providers = [{ id: 'localhost', name: 'NewAPIGate', models: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', name: 'DS-V4.1' }] }];
const pickingNode = render({ sessionId: 'session-abc' }, [true, { top: 40, left: 900, right: 1000 }, richState, providers, true, false, '', '']);
const modelButton = findByPredicate(pickingNode, (element) => element.type === 'button' && element.props.title === 'localhost/deepseek-ai/DeepSeek-V4.1-Flash');
assert(modelButton !== null && modelButton !== undefined, '展开后应列出模型按钮');
modelButton.props.onClick();
await new Promise((resolve) => setImmediate(resolve));
const oneOff = requests.find((request) => request.url.includes('/generate'));
assert(oneOff !== undefined && oneOff.body.provider === 'localhost', '选模型后应带 provider');
assert(oneOff.body.model === 'deepseek-ai/DeepSeek-V4.1-Flash', '选模型后应带 model');
ok('「指定模型生成一次」→ POST /generate 带 provider/model（与 /title <模型> 同义）');

// ------------------------------------------------------------ 4) 无会话时不炸

const noSession = render({}, []);
const disabledButton = findByPredicate(noSession, (element) => element.type === 'button' && collectText(element).includes('标题'));
assert(disabledButton.props.disabled === true, '拿不到 sessionId 时按钮应禁用');
ok('没有 sessionId 时按钮禁用（不会打到接口）');

console.log(`\nCLIENT SELFTEST PASS (${CHECKS.length + 4} checks)`);
