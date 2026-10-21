/**
 * 设备网格面板「工作区归属」自测（client 半边，无浏览器）。
 *
 * 背景（用户实测）：面板里 **xray4668 名下**列着 4 个工作区，而它们的属主其实是
 * **orangepi5**（文件与命令都在那台）—— 只是互联会话的 cwd 落在属主那台的路径上，
 * 于是会话端本机注册表也把它们记了一份。host 给这类条目打了 `ownerDeviceId`
 * （声明的属主是另一台设备）。面板必须：
 *
 *   1. 不把别人的工作区记在自己名下（改成一枚「属主在别处」说明，并如实列出归到了谁）；
 *   2. 会话**合并到属主那条**（否则工作区挪走之后，会话端那 1000 多条会话会整段消失），
 *      并且每条会话标明**是哪台在跑**（复用 ⇄设备名 那套标签）；
 *   3. 同一个 session id 只出现一次（两台都报的同一条会话）；
 *   4. **没有 `ownerDeviceId` 时与改动前逐字一致**（不合并、不挪动、计数不变）——
 *      老 host / 纯本地部署走的正是这条路。
 *
 * harness 与 `client-sidebar-selftest.mjs` 同款（假 react + 真 client.js）：
 * hook 表按**组件类型**分（`deepTables`），所以同一类组件在同一个用例里只保留一份状态。
 *
 * 跑法：node client-panel-selftest.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, 'client.js');

// ── 夹具 ────────────────────────────────────────────────────────────────────
/** 一条会话（字段与线上 /tree 一致）。 */
function session(id, live = false) {
  return {
    id, title: id, cwd: '/root/DSHpluginWorkSpace', createdAt: 1791900000000, lastActivityAt: 1791900000000,
    live, persisted: true, seeded: false, origin: null, parentSession: null, depth: 0,
    agentPresetId: null, archived: false, inferred: true,
  };
}

const WS_MESH = 'db264e09-112c-478f-8bbd-f01baa20307c';
const WS_ARK = '863de1b8-a5f4-4560-beb7-fda46cf99189';
const PATH_MESH = '/root/DSHpluginWorkSpace';
const PATH_ARK = '/root/nas/ArkTower';

/**
 * 造一份 /tree：本机是 orangepi5（属主），对端 xray4668 报了 2 个「其实属于 orangepi5」的工作区。
 *
 * 形状抄线上：**属主那台也报同样那 2 个**（不带 owner 字段），对端那台带 `ownerDeviceId` ——
 * 两边都报，工作区挪到属主名下之后会话才有着落（这一点单独有用例 C 钉住）。
 * @param {boolean} withClaims 是否给 xray4668 那两条加上 `ownerDeviceId`（false = 老 host 形状）。
 * @returns {object} /tree 响应。
 */
function treeFixture(withClaims) {
  const claim = withClaims
    ? { ownerDeviceId: 'dev-opi', ownerDeviceName: 'orangepi5', ownerDeclared: true }
    : {};
  return {
    ok: true,
    tree: {
      schema: 1,
      selfDeviceId: 'dev-opi',
      authority: { deviceId: 'dev-opi', name: 'orangepi5', isSelf: true, configured: true },
      devices: [
        {
          deviceId: 'dev-opi', name: 'orangepi5', self: true, liveness: 'online',
          inventory: {
            totals: { workspaces: 2, sessions: 4, listed: 4, live: 0 },
            workspaces: [
              {
                id: WS_MESH, title: 'DSHpluginWorkSpace', path: PATH_MESH,
                sessionCount: 3, droppedSessions: 0, liveCount: 0,
                sessions: [session('opi-1'), session('opi-2')],
              },
              {
                id: WS_ARK, title: 'ArkTower', path: PATH_ARK,
                sessionCount: 1, droppedSessions: 0, liveCount: 0,
                sessions: [session('opi-3')],
              },
            ],
            unassigned: [],
          },
        },
        {
          deviceId: 'dev-rpi', name: 'xray4668', self: false, liveness: 'online',
          inventory: {
            totals: { workspaces: 2, sessions: 4, listed: 4, live: 1 },
            workspaces: [
              {
                id: WS_MESH, title: 'DSHpluginWorkSpace', path: PATH_MESH,
                sessionCount: 3, droppedSessions: 0, liveCount: 1,
                ...claim,
                // rpi-1/rpi-2 是 xray4668 自己的；opi-1 两台都报了（presentLocally 那种）
                sessions: [session('rpi-1', true), session('rpi-2'), session('opi-1')],
              },
              {
                id: WS_ARK, title: 'ArkTower', path: PATH_ARK,
                sessionCount: 1, droppedSessions: 0, liveCount: 0,
                ...claim,
                sessions: [session('rpi-3')],
              },
            ],
            unassigned: [],
          },
        },
      ],
    },
  };
}

/**
 * 用例 C 的夹具：对端报了「属主在 orangepi5」的工作区，但**属主那台没报它**
 * （离线 / 清单降级 / 那台注册表里没有）。这种工作区不能挪走 —— 挪了会话就整段消失。
 * @returns {object} /tree 响应。
 */
function ownerSilentFixture() {
  const response = treeFixture(true);
  const opi = response.tree.devices[0];
  // opi 只报 ws-mesh，不报 ArkTower
  opi.inventory.workspaces = [opi.inventory.workspaces[0]];
  opi.inventory.totals = { workspaces: 1, sessions: 2, listed: 2, live: 0 };
  return response;
}

// ── react mock（只实现面板用到的面）──────────────────────────────────────────
let hooks = new Map();
let hookIndex = 0;
const pending = [];
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(init) {
    const table = hooks;
    const key = hookIndex++;
    if (!table.has(key)) table.set(key, typeof init === 'function' ? init() : init);
    const value = table.get(key);
    return [value, (next) => { table.set(key, typeof next === 'function' ? next(table.get(key)) : next); }];
  },
  useEffect(fn) { hookIndex++; pending.push(fn); },
  useCallback(fn) { hookIndex++; return fn; },
  // `useRef` 必须**跨渲染保持同一个对象**：面板的 OverviewTab 用它记 firstRender，
  // 每次都新建的话「首次自动展开本机」会在每一遍渲染里重跑、把用户点开的设备又关回去
  // （侧边栏 harness 那份 mock 不持久，是因为它不点非本机的设备）。
  useRef(init) {
    const table = hooks;
    const key = hookIndex++;
    if (!table.has(key)) table.set(key, { current: init });
    return table.get(key);
  },
  useMemo(fn) { hookIndex++; return fn(); },
};

// ── 浏览器环境 mock ─────────────────────────────────────────────────────────
let captured = null;
globalThis.window = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => setTimeout(fn, 0),
  __ModuleLoader__: { load(entry) { captured = entry; } },
};
globalThis.document = {
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  getElementById: () => null,
  head: { appendChild() {} },
  querySelector: () => null,
};
let currentTree = treeFixture(true);
globalThis.fetch = async (url) => {
  const target = String(url);
  return {
    ok: true,
    status: 200,
    json: async () => (target.includes('/tree') ? currentTree : { ok: true, sessions: [] }),
  };
};

/** 把微任务与定时器推完。 */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

const src = fs.readFileSync(CLIENT, 'utf8');
new Function('window', 'document', 'globalThis', src)(globalThis.window, globalThis.document, globalThis);
assert.ok(captured !== null, 'client.js 应注册进 __ModuleLoader__');
const moduleExports = captured.factory((name) => {
  if (name === 'react') return react;
  throw new Error('unexpected require: ' + name);
});
assert.equal(typeof moduleExports.apply, 'function', '导出 apply');

const injected = new Map();
const slots = { inject(name, cb) { injected.set(name, cb); }, register(def, component) { return { def, component }; } };
moduleExports.apply({ slots, logger: { warn() {} } });
assert.ok(injected.has('main'), '应注入 main 槽');
const panel = injected.get('main')().component;

// ── 渲染工具 ────────────────────────────────────────────────────────────────
const deepTables = new WeakMap();
/** 递归渲染：函数组件执行、宿主元素递归 children（与侧边栏 harness 同款）。 */
function deepRender(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return element;
  if (typeof element === 'string' || typeof element === 'number') return element;
  if (Array.isArray(element)) return element.map((child) => deepRender(child));
  if (typeof element.type === 'function') {
    let table = deepTables.get(element.type);
    if (table === undefined) { table = new Map(); deepTables.set(element.type, table); }
    const savedHooks = hooks;
    const savedIndex = hookIndex;
    hooks = table;
    hookIndex = 0;
    let node;
    try {
      const kids = element.children ?? [];
      const props = { ...element.props };
      if (kids.length === 1) props.children = kids[0];
      else if (kids.length > 1) props.children = kids;
      node = element.type(props);
    } finally {
      hooks = savedHooks;
      hookIndex = savedIndex;
    }
    return deepRender(node);
  }
  return { type: element.type, props: element.props, children: (element.children ?? []).map((child) => deepRender(child)) };
}

/** 深渲染若干遍（每遍跑 effect 并等异步），让内部状态收敛。 */
async function deepMount(passes) {
  let tree = null;
  for (let i = 0; i < passes; i++) {
    pending.length = 0;
    tree = deepRender(panel({}));
    for (const effect of pending) effect();
    await flush();
  }
  return tree;
}

/** 点掉第一个文本等于 label 的按钮（面板的「全部展开」就是这一种）。 */
function clickButtonByText(node, label) {
  let hits = 0;
  (function walk(entry) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (hits === 0 && entry.type === 'button' && typeof entry.props.onClick === 'function') {
      const own = (entry.children ?? []).filter((child) => typeof child === 'string').join('');
      if (own === label) { entry.props.onClick({ stopPropagation() {} }); hits += 1; return; }
    }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return hits;
}

/**
 * 渲染面板并**全部展开**，让设备体、工作区块与会话行都渲染出来。
 * @param {object} fixture /tree 响应。
 * @returns {Promise<{tree: object, text: string}>} 渲染结果与全部字符串。
 */
async function mountPanel(fixture) {
  currentTree = fixture;
  let tree = await deepMount(3);
  // 面板顶部就有「全部展开」：它一次开掉所有设备与工作区，比逐个点设备头稳
  // （设备头是 Row 组件包的一层，宿主 div 上没有 key，逐个点要按文案/结构去猜）。
  assert.equal(clickButtonByText(tree, '全部展开'), 1, '面板应有一个「全部展开」按钮');
  tree = await deepMount(2);
  return { tree, text: collectStrings(tree).join('\n') };
}

/** 收集整棵渲染树里的字符串（含 props 上的字符串，如 className/title）。 */
function collectStrings(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const item of node) collectStrings(item, out); return out; }
  if (node.props) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'children') continue;
      if (typeof value === 'string') out.push(value);
    }
  }
  for (const child of node.children ?? []) collectStrings(child, out);
  return out;
}

/** 数一数渲染树里有多少个节点的 className 含某个类。 */
function countClass(node, className, acc = { n: 0 }) {
  if (node === null || node === undefined || typeof node !== 'object') return acc.n;
  if (Array.isArray(node)) { for (const item of node) countClass(item, className, acc); return acc.n; }
  if (node.props && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes(className)) acc.n += 1;
  for (const child of node.children ?? []) countClass(child, className, acc);
  return acc.n;
}

/**
 * 数一数「某条会话」渲染成了几行。
 *
 * 为什么不数文本出现次数：会话行的 `title` 里也带 id（`<id>\n点击复制会话 id`），
 * 一行会命中两次 —— 那会把「渲染了一行」和「渲染了两行」判成同一件事。
 * 这里按**行**数：className 含 `dmesh-sess` 的节点，子树里出现该 id 才算一行。
 * @param {object} node 渲染树。
 * @param {string} id 会话 id。
 * @returns {number} 行数。
 */
function countSessionRows(node, id) {
  let n = 0;
  (function walk(entry) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (entry.props && typeof entry.props.className === 'string'
      && entry.props.className.split(' ').includes('dmesh-sess')) {
      if (collectStrings(entry).some((value) => value.includes(id))) n += 1;
      return;
    }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return n;
}

let checks = 0;
/**
 * 断言并计数。
 * @param {unknown} value 值。
 * @param {string} label 说明。
 * @returns {void}
 */
function ok(value, label) {
  assert.ok(value, label);
  checks += 1;
  console.log('  ok  ' + label);
}

// ── 用例 A：有属主声明（用户实测的那份形状）──────────────────────────────────
console.log('用例 A：xray4668 报的工作区属主在 orangepi5');
{
  const { tree, text } = await mountPanel(treeFixture(true));
  // ① 不记在别人名下：xray4668 名下没有工作区块，只有一行说明
  const heads = countClass(tree, 'dmesh-ws-head');
  ok(heads === 2, `① 只应渲染属主（orangepi5）那 2 个工作区块，实际 ${heads}`);
  ok(text.includes('属主在别处'), '① 要有「属主在别处」说明行');
  ok(text.includes('2 个工作区的文件与命令在别的设备上'), '① 说明行要点出数量');
  ok(text.includes('DSHpluginWorkSpace、ArkTower'), '① 说明行要列出这些工作区的名字');
  ok(text.includes('→ 属主 orangepi5（会话也合并在那台名下）'), '① 说明行要指出归到了谁');
  ok(!text.includes('属主 orangepi5 暂未上报'), '① 属主报了这些工作区时，不该出现「暂未上报」兜底');

  // ⑤ 头部计数只数自己的
  ok(text.includes('0 工作区'), '⑤ xray4668 头部工作区计数应为 0（不再撒谎）');
  ok(text.includes('2 个属主在别处'), '⑤ 头部要另给一枚「N 个属主在别处」');
  ok(text.includes('2 工作区 · 4 会话'), '⑤ 属主自己那台计数不受影响');

  // ② 会话合并到属主那条：两台的会话都在，条数=合并后
  for (const id of ['opi-1', 'opi-2', 'opi-3', 'rpi-1', 'rpi-2', 'rpi-3']) {
    ok(text.includes(id), `② 合并后应能看到 ${id}`);
  }
  ok(text.includes('4 会话'), '② DSHpluginWorkSpace 的计数用合并后的数量（2 本机 + 2 对端）');
  ok(text.includes('2 会话'), '② ArkTower 的计数也是合并后的（1 本机 + 1 对端）');
  ok(text.includes('这个工作区的会话来自 2 台设备（已合并）'), '② 合并要有说明');
  ok(text.includes('⇄xray4668'), '② 跨设备的会话要带「哪台在跑」标签');
  ok(!text.includes('⇄orangepi5'), '② 属主自己的会话不该被标成别台');

  // ③ 同一个 session id 只渲染一行（opi-1 两台都报了）
  ok(countSessionRows(tree, 'opi-1') === 1, `③ 两台都报的会话只能渲染一行（实际 ${countSessionRows(tree, 'opi-1')} 行）`);
  ok(countSessionRows(tree, 'rpi-1') === 1, '③ 对端会话也只渲染一行');
  ok(countSessionRows(tree, 'rpi-3') === 1, '③ 只在对端账目里的会话要跟到属主那条（渲染一行）');
}

// ── 用例 B：没有属主声明（老 host / 纯本地）→ 与改动前逐字一致 ───────────────
console.log('用例 B：没有 ownerDeviceId（老 host / 纯本地）');
{
  const { tree, text } = await mountPanel(treeFixture(false));

  // ④ 不挪动、不合并、不加说明
  ok(!text.includes('属主在别处'), '④ 没有声明时不该出现「属主在别处」');
  ok(!text.includes('会话来自'), '④ 没有声明时不该合并、也不该有合并说明');
  ok(!text.includes('暂未上报'), '④ 没有声明时不该出现归属兜底');
  ok(countClass(tree, 'dmesh-foreign') === 0, '④ 没有声明时不该渲染归属说明块');

  // ④ 两台各自渲染自己的工作区（2 + 2 = 4 块），计数按各自清单
  const heads = countClass(tree, 'dmesh-ws-head');
  ok(heads === 4, `④ 两边各自渲染工作区（应为 2+2=4 块，实际 ${heads}）`);
  ok(text.includes('2 工作区 · 4 会话'), '④ xray4668 的头部计数保持改动前的口径');
  ok(text.includes('3 会话'), '④ xray4668 那条工作区仍按自己的账目显示条数（3，不是合并后的 5）');

  // ④ 两台都报的同一条会话**各列一遍**（改动前就是如此：不合并、不去重跨设备）
  ok(countSessionRows(tree, 'opi-1') === 2, `④ 没有声明时不做跨设备去重（两台各列一行，实际 ${countSessionRows(tree, 'opi-1')} 行）`);
  ok(text.includes('⇄'), '④ 面板会话标签行为不变');
}

// ── 用例 C：属主那台没报这个工作区 → 不能挪走（挪了会话就没了）──────────────
console.log('用例 C：属主当前没上报某个工作区');
{
  const { tree, text } = await mountPanel(ownerSilentFixture());
  const heads = countClass(tree, 'dmesh-ws-head');
  // 属主报了的 ws-mesh 挪过去了（opi 1 块），属主没报的 ArkTower 留在 xray4668 名下（1 块）
  ok(heads === 2, `⑥ 属主没报的工作区要留下（实际 ${heads} 个工作区块）`);
  ok(text.includes('属主 orangepi5 暂未上报'), '⑥ 留下的那行要标明属主与原因');
  ok(countSessionRows(tree, 'rpi-3') === 1, '⑥ 留下的工作区里，会话不能消失');
  ok(text.includes('1 个工作区的文件与命令在别的设备上'), '⑥ 说明行只算真正挪走的那 1 个');
  ok(text.includes('1 工作区 · 1 会话'), '⑥ xray4668 头部：留下的 1 个工作区算在自己头上');
}

// ── 用例 D：会话权限的显示与修改 ─────────────────────────────────────────────
console.log('用例 D：会话权限（显示 + 改）');
{
  /** 在共享夹具上挂两条权限：远端 live 的（可改）、本机非 live 的（只显示）。 */
  function modeFixture() {
    const fx = treeFixture(true);
    const device = (id) => fx.tree.devices.find((one) => one.deviceId === id);
    const sess = (deviceId, wsId, sessionId) => device(deviceId).inventory.workspaces
      .find((workspace) => workspace.id === wsId).sessions.find((one) => one.id === sessionId);
    sess('dev-rpi', WS_MESH, 'rpi-1').mode = 'danger-full-access';
    sess('dev-opi', WS_ARK, 'opi-3').mode = 'read-only';
    return fx;
  }

  /** 找出第一个可交互的 select（权限三选一）。 */
  function findSelect(node) {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) { const hit = findSelect(item); if (hit !== null) return hit; }
      return null;
    }
    if (node.type === 'select' && typeof node.props.onChange === 'function') return node;
    for (const child of node.children ?? []) { const hit = findSelect(child); if (hit !== null) return hit; }
    return null;
  }

  const { tree, text } = await mountPanel(modeFixture());
  ok(countClass(tree, 'dmesh-mode-tag') === 2, `⑦ 两条带权限的会话各一个标签（实际 ${countClass(tree, 'dmesh-mode-tag')}）`);
  ok(text.includes('danger-full-access'), '⑦ 权限取值原样显示（与配置同一套词）');
  ok(text.includes('read-only'), '⑦ read-only 也要显示');
  ok(countClass(tree, 'dmesh-mode-select') === 1,
    `⑦ 只有「改得动」的那条给选择器：远端 live=1 个，本机非 live 不给（实际 ${countClass(tree, 'dmesh-mode-select')}）`);

  // ⑦ 没有 mode 字段的会话（老 host / 读不到）不该出现权限标签或选择器
  {
    const { tree: bare, text: bareText } = await mountPanel(treeFixture(true));
    ok(countClass(bare, 'dmesh-mode-tag') === 0, '⑦ 清单里没有 mode 时一个权限标签都不画');
    ok(countClass(bare, 'dmesh-mode-select') === 0, '⑦ 没有 mode 时不摆选择器（避免「不知道却让你改」）');
    ok(!bareText.includes('danger-full-access'), '⑦ 没有 mode 时不该冒出权限取值');
  }

  // ⑦ 改权限：选择器要打到 `/dsh-device-mesh/session-mode`，并带上是哪条会话、哪台设备
  {
    const posted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes('/session-mode')) {
        posted.push({ target, body: JSON.parse((init && init.body) || '{}') });
        return { ok: true, status: 200, json: async () => ({ ok: true, local: false, mode: 'read-only' }) };
      }
      return realFetch(url, init);
    };
    try {
      const { tree: live, text: liveText } = await mountPanel(modeFixture());
      const select = findSelect(live);
      ok(select !== null, '⑦ 应当能找到一个权限选择器');
      select.props.onChange({ target: { value: 'read-only' }, stopPropagation() {} });
      await flush();
      ok(posted.length === 1, `⑦ 改权限要恰好发一次请求（实际 ${posted.length}）`);
      ok(posted[0].target.includes('/dsh-device-mesh/session-mode'), `⑦ 打到浏览器侧那条路由（实际 ${posted[0].target}）`);
      ok(posted[0].body.sessionId === 'rpi-1', '⑦ 要带上是哪条会话');
      ok(posted[0].body.mode === 'read-only', '⑦ 要带上改成什么权限');
      ok(posted[0].body.deviceId === 'dev-rpi', '⑦ 要带上是哪台在跑（属主侧据此一跳转发）');
      ok(liveText.includes('会话权限：'), '⑦ 标签的 title 要说清这条权限意味着什么');
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

console.log(`\nCLIENT PANEL SELFTEST PASS（${checks} 条断言）`);
