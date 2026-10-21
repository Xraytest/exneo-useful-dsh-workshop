/**
 * dsh-workspace-context 浏览器半边自测：在最小桩环境里跑 factory + apply，
 * 确认槽位注册契约、样式注入与组件**行为**（装载 → 选中 → 改字 → 保存/停用/收编）。
 *
 * 桩里实现了一个极小的 hooks 运行时（useState/useRef/useCallback/useEffect 带依赖
 * 比较），因此组件真的会重渲染、事件处理器真的会改状态并发出请求——不是只看形状。
 *
 * 运行：node plugins/dsh-workspace-context/client-selftest.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

let checks = 0;
const ok = (value, message) => {
  checks += 1;
  assert.ok(value, message);
};
const eq = (actual, expected, message) => {
  checks += 1;
  assert.equal(actual, expected, message);
};
const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

// ── 桩：定时器（防抖保存的计时器要能被测试确定性地触发） ──────────────────────
const timers = [];
globalThis.setTimeout = (fn, ms) => {
  timers.push({ fn, ms, cancelled: false });
  return timers.length;
};
globalThis.clearTimeout = (id) => {
  const timer = timers[id - 1];
  if (timer !== undefined) timer.cancelled = true;
};
globalThis.confirm = () => true;

// ── 桩：可编程 host 状态与请求记录 ────────────────────────────────────────────
const WORKSPACE_A = '/ws/a';
const WORKSPACE_B = '/ws/b';

const baseState = (patch = {}) => Object.assign({
  ok: true,
  version: 1,
  schema: 1,
  dir: '/home/u/.dsh/workspace-context',
  contextsDir: '/home/u/.dsh/workspace-context/contexts',
  trashDir: '/home/u/.dsh/workspace-context/trash',
  revision: 'abc123',
  config: { enabled: true, ttlMs: 1000, maxBytes: 32768, inheritFromAncestor: true, sectionName: 'workspace:context', dshHome: '/home/u/.dsh' },
  entries: [
    {
      path: WORKSPACE_A,
      title: 'proj-a',
      enabled: true,
      file: '/home/u/.dsh/workspace-context/contexts/proj-a--aaaa1111.md',
      name: 'proj-a--aaaa1111.md',
      bytes: 40,
      textBytes: 12,
      digest: 'd1',
      updatedAt: '2026-10-09T00:00:00.000Z',
      updatedBy: 'human',
      exists: true,
      text: 'A 的常驻正文',
    },
    {
      path: WORKSPACE_B,
      title: 'proj-b',
      enabled: false,
      file: '/home/u/.dsh/workspace-context/contexts/proj-b--bbbb2222.md',
      name: 'proj-b--bbbb2222.md',
      bytes: 30,
      textBytes: 8,
      digest: 'd2',
      updatedAt: '2026-10-09T01:00:00.000Z',
      updatedBy: 'tool',
      exists: true,
      text: 'B 的正文',
    },
  ],
  unbound: [{ file: '/home/u/.dsh/workspace-context/contexts/hand.md', name: 'hand.md', bytes: 20, reason: 'missing-header', preview: '手写' }],
  errors: [],
  workspaces: [
    { path: WORKSPACE_A, title: 'proj-a', source: 'entry', hasEntry: true, enabled: true, textBytes: 12 },
    { path: WORKSPACE_B, title: 'proj-b', source: 'entry', hasEntry: true, enabled: false, textBytes: 8 },
    { path: '/ws/empty', title: '还没配置', source: 'registry', hasEntry: false, enabled: false, textBytes: 0 },
  ],
  current: { cwd: WORKSPACE_A, hit: true, via: 'exact', path: WORKSPACE_A, title: 'proj-a', enabled: true, textBytes: 12 },
  diag: {
    version: 1,
    enabled: true,
    storeDir: '/home/u/.dsh/workspace-context',
    assemblies: 7,
    injected: 5,
    skipped: { noSession: 1, noEntry: 2, disabled: 1, empty: 0 },
    lastInjection: { at: '2026-10-09T02:00:00.000Z', cwd: WORKSPACE_A, path: WORKSPACE_A, via: 'exact', title: 'proj-a', textBytes: 12, injectedBytes: 240, truncated: false, sectionName: 'workspace:context' },
    lastSkip: { at: '2026-10-09T02:00:01.000Z', reason: 'no-entry', cwd: '/ws/empty' },
    toolCalls: 3,
    routeErrors: 0,
    routes: true,
    seenCwds: ['/ws/empty', WORKSPACE_A],
  },
}, patch);

let currentState = baseState();
let failNext = false;
const requests = [];

const programmableFetch = async (url, options) => {
  const target = String(url);
  const body = options !== undefined && options.body !== undefined ? JSON.parse(options.body) : null;
  requests.push({ url: target, body });
  if (failNext === true) {
    failNext = false;
    return { ok: false, status: 500, statusText: 'Server Error', json: async () => ({ error: 'host 拒绝' }) };
  }
  if (body !== null && target.includes('/save')) {
    const rows = currentState.entries.slice();
    const at = rows.findIndex((entry) => entry.path === body.path);
    const row = {
      path: body.path,
      title: 'proj',
      enabled: true,
      file: '/home/u/.dsh/workspace-context/contexts/' + body.path.replace(/\W+/g, '-') + '.md',
      name: 'x.md',
      bytes: 10,
      textBytes: body.text.length,
      digest: 'd9',
      updatedAt: '2026-10-09T03:00:00.000Z',
      updatedBy: 'human',
      exists: true,
      text: body.text,
    };
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    currentState = baseState({ entries: rows });
  }
  if (body !== null && target.includes('/enabled')) {
    const rows = currentState.entries.map((entry) => (entry.path === body.path ? Object.assign({}, entry, { enabled: body.enabled }) : entry));
    currentState = baseState({ entries: rows });
  }
  if (body !== null && target.includes('/bind')) {
    currentState = baseState({ unbound: [] });
  }
  if (body !== null && target.includes('/trash')) {
    currentState = baseState({ entries: currentState.entries.filter((entry) => entry.path !== body.path) });
  }
  return { ok: true, status: 200, statusText: 'OK', json: async () => currentState };
};

// ── 桩：极小 hooks 运行时 ───────────────────────────────────────────────────
let hookValues = [];
let hookDeps = [];
let cursor = 0;
let pendingEffects = [];
let rerenderRequested = false;

const react = {
  createElement(type, props, ...children) {
    return { type, props: props === null || props === undefined ? {} : props, children };
  },
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value;
      rerenderRequested = true;
    };
    return [hookValues[index], set];
  },
  useRef(value) {
    const index = cursor;
    cursor += 1;
    if (!(index in hookValues)) hookValues[index] = { current: value };
    return hookValues[index];
  },
  useCallback(fn) {
    cursor += 1;
    return fn;
  },
  useMemo(fn) {
    cursor += 1;
    return fn();
  },
  useEffect(fn, deps) {
    const index = cursor;
    cursor += 1;
    const previous = hookDeps[index];
    const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous)
      && previous.length === deps.length && deps.every((value, at) => Object.is(value, previous[at]));
    if (!same) {
      hookDeps[index] = Array.isArray(deps) ? deps.slice() : deps;
      pendingEffects.push(fn);
    }
  },
};

// ── 桩：模块加载器 / document ────────────────────────────────────────────────
let captured = null;
const styleNodes = [];
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};
globalThis.document = {
  querySelector: () => null,
  createElement() {
    return {
      dataset: {},
      textContent: '',
      parentNode: null,
      setAttribute() {},
    };
  },
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
  documentElement: { appendChild() {} },
};

const requireStub = (moduleName) => {
  if (moduleName === 'react') return react;
  throw new Error('unexpected require: ' + moduleName);
};

new Function('window', 'document', 'require', 'fetch', source)(globalThis.window, globalThis.document, requireStub, programmableFetch);

// ── 执行 ────────────────────────────────────────────────────────────────────
ok(captured !== null, 'client.js 通过 __ModuleLoader__ 注册');
eq(captured.id, 'dsh-workspace-context', '模块 id');
const exports_ = captured.factory(requireStub);
eq(JSON.stringify(exports_.inject), JSON.stringify(['slots']), 'client inject 只依赖 slots');
ok(typeof exports_.apply === 'function', '导出 apply');
const ui = exports_.__ui;

let tree = null;
const effectCleanups = [];
function renderPage(props = {}) {
  cursor = 0;
  pendingEffects = [];
  rerenderRequested = false;
  tree = ui.Page(props);
  const effects = pendingEffects;
  pendingEffects = [];
  for (const effect of effects) {
    // 清理函数只在「卸载」时调用；这里收集起来不调用——立刻调用会把组件标成已卸载，
    // 后续 setState 全部被丢弃（装载请求的结果就再也进不来）。
    const cleanup = effect();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  }
  return tree;
}

/** 排空微任务，并在组件请求重渲染时重渲染（模拟 React 的提交）。 */
async function settle() {
  for (let round = 0; round < 12; round += 1) {
    await tick();
    if (!rerenderRequested) {
      await tick();
      if (!rerenderRequested) return;
    }
    renderPage();
  }
}

function nodesOf(node) {
  const out = [];
  const walk = (current) => {
    if (current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (typeof current !== 'object') return;
    out.push(current);
    if (Array.isArray(current.children)) {
      for (const child of current.children) walk(child);
    }
  };
  walk(node);
  return out;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('');
  return '';
}

const findAll = (predicate) => nodesOf(tree).filter(predicate);
const findButton = (label) => findAll((node) => node.type === 'button' && textOf(node) === label)[0];
const findTextarea = () => findAll((node) => node.type === 'textarea')[0];

// ── 1. apply：槽位与样式 ───────────────────────────────────────────────────
const registered = [];
const effectLabels = [];
const fakeCtx = {
  effect(fn, label) {
    effectLabels.push(label);
    const disposer = fn();
    return () => (typeof disposer === 'function' ? disposer() : undefined);
  },
  slots: {
    inject(slotName, callback) {
      registered.push({ slotName, viaInject: true });
      return callback();
    },
    register(spec, component) {
      registered.push({ spec, component });
      return () => {};
    },
  },
};
exports_.apply(fakeCtx);
eq(styleNodes.length, 1, '注入了一个 <style> 节点');
eq(styleNodes[0].dataset.plugin, 'dsh-workspace-context', '样式节点带插件标记');
ok(styleNodes[0].textContent.includes('.wctx-root'), '样式含页面类名');
eq(effectLabels.length, 1, '样式卸载挂在 effect 上（随 fiber 回收）');
ok(registered.some((item) => item.slotName === 'settings.section' && item.viaInject === true), '用 slots.inject 声明依赖');
const registration = registered.find((item) => item.spec !== undefined);
eq(registration.spec.name, 'settings.section', '槽位名');
eq(registration.spec.id, 'workspace-context', '槽位 id');
eq(registration.spec.order, 20, '槽位顺序 20（在「模型分组」25 之前）');
eq(registration.spec.label, '工作区常驻上下文', '槽位标签');
eq(typeof registration.component, 'function', '注册的是组件');

// ── 2. 装载与渲染 ──────────────────────────────────────────────────────────
renderPage();
await settle();
const body = textOf(tree);
ok(body.includes('/home/u/.dsh/workspace-context'), '显示存储目录');
ok(body.includes(WORKSPACE_A), '列出工作区 A');
ok(body.includes(WORKSPACE_B), '列出工作区 B');
ok(body.includes('未配置'), '列出尚未配置的已知工作区');
ok(body.includes('未绑定文件（1）'), '列出未绑定文件');
ok(body.includes('装配 7 次'), '显示诊断：装配次数');
ok(body.includes('注入 5 次'), '显示诊断：注入次数');
ok(body.includes('最近注入：' + WORKSPACE_A), '显示最近注入');
const textarea = findTextarea();
ok(textarea !== undefined, '渲染出正文编辑器');
eq(textarea.props.value, 'A 的常驻正文', '默认选中最近活跃工作区并载入其正文');
ok(body.includes('proj-a--aaaa1111.md'), '显示磁盘文件路径（可直接编辑）');
eq(requests.filter((item) => item.url.includes('/state')).length, 1, '装载只请求一次 state');

// ── 3. 显式保存 ────────────────────────────────────────────────────────────
requests.length = 0;
findButton('保存').props.onClick();
await settle();
const saveRequest = requests.find((item) => item.url.includes('/save'));
ok(saveRequest !== undefined, '点「保存」发出 POST /save');
eq(saveRequest.body.path, WORKSPACE_A, '保存目标路径');
eq(saveRequest.body.text, 'A 的常驻正文', '保存正文');
eq(saveRequest.body.cwd, WORKSPACE_A, '保存带上当前工作区（供 host 回显命中）');
ok(textOf(tree).includes('已保存'), '保存后给出成功提示');

// ── 4. 改字 → 防抖自动保存 ─────────────────────────────────────────────────
requests.length = 0;
const textarea2 = findTextarea();
textarea2.props.onChange({ target: { value: 'A 的新正文' } });
await settle();
eq(requests.length, 0, '改字先不立刻发请求（防抖）');
const autosave = timers.filter((timer) => timer.cancelled !== true && timer.ms === ui.AUTOSAVE_MS).pop();
ok(autosave !== undefined, '起了防抖计时器（' + ui.AUTOSAVE_MS + 'ms）');
autosave.fn();
await settle();
const debounced = requests.find((item) => item.url.includes('/save'));
ok(debounced !== undefined, '防抖到点后自动保存');
eq(debounced.body.text, 'A 的新正文', '自动保存的是最新正文');
ok(textOf(tree).includes('有未保存改动') || textOf(tree).includes('已保存'), '编辑器状态行随保存更新');

// ── 5. 停用 / 启用 ─────────────────────────────────────────────────────────
requests.length = 0;
const toggleButton = findAll((node) => node.type === 'button' && textOf(node) === '停用')[0];
ok(toggleButton !== undefined, '有「停用」按钮');
toggleButton.props.onClick();
await settle();
const enabledRequest = requests.find((item) => item.url.includes('/enabled'));
ok(enabledRequest !== undefined, '点「停用」发出 POST /enabled');
eq(enabledRequest.body.path, WORKSPACE_A, '停用目标');
eq(enabledRequest.body.enabled, false, '停用写入 false');

// ── 6. 收编未绑定文件 ──────────────────────────────────────────────────────
requests.length = 0;
const bindButton = findButton('收编');
ok(bindButton !== undefined, '有「收编」按钮');
bindButton.props.onClick();
await settle();
const bindRequest = requests.find((item) => item.url.includes('/bind'));
ok(bindRequest !== undefined, '点「收编」发出 POST /bind');
eq(bindRequest.body.file, 'hand.md', '收编文件名');
eq(bindRequest.body.path, WORKSPACE_A, '收编到当前选中的工作区');

// ── 7. 新建路径校验与打开 ──────────────────────────────────────────────────
const input = findAll((node) => node.type === 'input')[0];
ok(input !== undefined, '有路径输入框');
input.props.onChange({ target: { value: 'relative/path' } });
await settle();
findButton('新建 / 打开').props.onClick();
await settle();
ok(textOf(tree).includes('请填绝对路径'), '相对路径被界面拦下');
eq(requests.filter((item) => item.url.includes('/save')).length, 0, '非法路径不发请求');
input.props.onChange({ target: { value: '/ws/empty' } });
await settle();
findButton('新建 / 打开').props.onClick();
await settle();
eq(findTextarea().props.value, '', '打开未配置工作区得到空正文');
ok(textOf(tree).includes('尚未保存'), '未保存条目给出状态');
ok(textOf(tree).includes('/ws/empty'), '编辑器显示目标路径');

// ── 8. 清空正文与回收站 ────────────────────────────────────────────────────
requests.length = 0;
const clearButton = findButton('清空正文');
ok(clearButton !== undefined, '有「清空正文」按钮');

// ── 9. 错误路径：host 报错要显示出来 ───────────────────────────────────────
failNext = true;
findButton('重新读取').props.onClick();
await settle();
ok(textOf(tree).includes('host 拒绝'), 'host 报错显示在页面上');

// ── 10. 纯函数 ─────────────────────────────────────────────────────────────
eq(ui.formatBytes(0), '0 B', 'formatBytes(0)');
eq(ui.formatBytes(999), '999 B', 'formatBytes(999)');
eq(ui.formatBytes(2048), '2.0 KB', 'formatBytes KB');
eq(ui.formatBytes(3 * 1048576), '3.00 MB', 'formatBytes MB');
eq(ui.isAbsolutePath('/root/x'), true, '绝对路径：Linux');
eq(ui.isAbsolutePath('C:\\work\\proj'), true, '绝对路径：Windows');
eq(ui.isAbsolutePath('rel/x'), false, '相对路径被拒');
eq(ui.isAbsolutePath(42), false, '非字符串被拒');
eq(ui.activeWorkspaceOf(baseState()), WORKSPACE_A, '最近活跃工作区取 seenCwds 末位');
eq(ui.activeWorkspaceOf({}), '', '无 seenCwds 时为空');
const rows = ui.workspaceRows(baseState());
eq(rows[0].hasEntry, true, '清单排序：已配置在前');
eq(rows[rows.length - 1].path, '/ws/empty', '清单排序：未配置在后');
eq(rows.length, 3, '清单合并 workspaces 与 entries');
const diag = ui.diagText(baseState());
ok(diag.includes('无条目 2'), 'diagText 带跳过细分');
ok(diag.includes('最近跳过：no-entry'), 'diagText 带最近跳过原因');
eq(ui.hookLayout.length, 8, 'hook 次序契约（自测与实现同步）');
ok(ui.css.includes('--dsw-alias-border-l1'), '样式使用出厂主题变量');

console.log(`CLIENT SELFTEST PASS（${checks} 项断言）`);