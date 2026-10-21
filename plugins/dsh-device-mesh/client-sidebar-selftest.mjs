/**
 * 侧边栏「网络会话工作区」去重自测（client 半边，无浏览器）。
 *
 * 背景：mesh 的 workspaceId 是**跨设备共享**的 —— 本机与 orangepi5 注册表里
 * DSHpluginWorkSpace 是同一条 id。所以「对端也报了这个工作区」绝大多数情况下
 * 不是「那台机器上另有一个工作区」，而是同一个工作区的另一份清单快照。把它
 * 平铺进侧边栏，用户看到的就是**同一行工作区出现两遍**，连它下面的会话也照抄
 * 一遍（本项修复的起因）。
 *
 * 本测试用一个 ~90 行的 react mock 真的渲染 RemoteWorkspacesSection，喂进去的
 * 是从线上 /tree 抓回来的真实形状数据（两个设备、四个工作区、 capped 清单），
 * 钉住四条：
 *   1. 本机清单被截断（droppedSessions>0）的同 id 工作区 → **一行都不开**
 *      （两边都只报前 500 条，差异可能只是截断位置不同，猜不起）；
 *   2. 两边清单完全一致的同 id 工作区 → **一行都不开**（纯重复）；
 *   3. 本机清单完整、对端真有独有会话 → 开一行，且**行的标识用共享
 *      workspaceId**（默认 UI 里它归同一个工作区，不是第二个工作区）；
 *   4. aria-label 是「网络会话工作区」，合并行带「同一工作区」提示与 ＋N。
 *
 * 跑法：node client-sidebar-selftest.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, 'client.js');

// ── 真实形状的 /tree 夹具（字段与线上一致，数量按需要裁剪） ──────────────────
// ws-a：本机 500 条且 dropped>0（被截断）→ 跳过
// ws-b：两边都 3 条、完全一致 → 跳过
// ws-c：本机 2 条完整、对端 4 条（2 条独有）→ 一行，key = 共享 id
// ws-d：本机 0 条完整、对端 1 条 → 一行
function session(id, live = false) {
  return { id, title: 't-' + id, cwd: '/root/x', createdAt: 1, lastActivityAt: 1, live, persisted: true, seeded: false, origin: null, parentSession: null, depth: 0, agentPresetId: null, archived: false, inferred: true };
}
const TREE = {
  ok: true,
  tree: {
    schema: 1,
    selfDeviceId: 'dev-local',
    devices: [
      {
        deviceId: 'dev-local', name: '本机', self: true, liveness: 'online',
        inventory: {
          workspaces: [
            { id: 'ws-a', title: 'Alpha', path: '/root/a', sessionCount: 1188, droppedSessions: 688, liveCount: 3, sessions: Array.from({ length: 500 }, (_, i) => session('a-' + i)) },
            { id: 'ws-b', title: 'Beta', path: '/root/b', sessionCount: 3, droppedSessions: 0, liveCount: 0, sessions: [session('b-1'), session('b-2'), session('b-3')] },
            { id: 'ws-c', title: 'Gamma', path: '/root/c', sessionCount: 2, droppedSessions: 0, liveCount: 0, sessions: [session('c-loc-1'), session('c-loc-2')] },
            { id: 'ws-d', title: 'Delta', path: '/root/d', sessionCount: 0, droppedSessions: 0, liveCount: 0, sessions: [] },
          ],
        },
      },
      {
        deviceId: 'dev-remote', name: 'orangepi5', self: false, liveness: 'online',
        inventory: {
          workspaces: [
            { id: 'ws-a', title: 'Alpha', path: '/root/a', sessionCount: 1189, droppedSessions: 689, liveCount: 1, sessions: Array.from({ length: 500 }, (_, i) => session('a-' + i)).concat([session('a-live-remote', true)]) },
            { id: 'ws-b', title: 'Beta', path: '/root/b', sessionCount: 3, droppedSessions: 0, liveCount: 0, sessions: [session('b-1'), session('b-2'), session('b-3')] },
            { id: 'ws-c', title: 'Gamma', path: '/root/c', sessionCount: 4, droppedSessions: 0, liveCount: 0, sessions: [session('c-loc-1'), session('c-loc-2'), session('c-rem-9'), session('c-rem-10')] },
            { id: 'ws-d', title: 'Delta', path: '/root/d', sessionCount: 1, droppedSessions: 0, liveCount: 0, sessions: [session('d-1')] },
          ],
        },
      },
    ],
  },
};

// ── 执行端标识（drivers）夹具 ───────────────────────────────────────────────
// 形状抄自 drivers-selftest.mjs 的场景 1（.19 属主/执行端的真实 /tree + drivers），
// 不是随手编的对象 —— 否则测的是想象而不是协议。
const OWN_WS = 'db264e09-112c-478f-8bbd-f01baa20307c';
const OWN_PATH = '/root/DSHpluginWorkSpace';
const UNRES_WS = '863de1b8-a5f4-4560-beb7-fda46cf99189';
const UNRES_PATH = '/root/nas/ArkTower';
const OWN_S1 = 'session-db8fec3f-07b7-4f48-9cb7-e8bacd7a1aa1';
const OWN_S2 = 'session-8ee27c35-3606-4679-b4ca-3704776940f2';

/** `computeDrivers` 的真实形状：属主/执行端看自己的两个工作区。 */
function driversFixture() {
  return {
    schema: 1,
    generatedAt: '2026-10-13T10:46:00.000Z',
    selfDeviceId: 'dev-local',
    selfName: 'orangepi5',
    workspaces: [
      {
        workspaceId: OWN_WS,
        path: OWN_PATH,
        title: 'DSHpluginWorkSpace',
        owner: { deviceId: 'dev-local', name: 'orangepi5', isSelf: true, online: true, source: 'roles' },
        session: { deviceId: 'dev-remote', name: 'xray4668', isSelf: false, online: true, source: 'roles' },
        remote: true,
        active: true,
        evidence: {
          mirrorSessions: 2,
          mirrorLastAt: '2026-10-13T04:20:41.807Z',
          inboundExec: 2,
          inboundDenied: 1,
          inboundTotal: 3,
          inboundLastAt: '2026-10-13T10:45:11.980Z',
          inboundLastCommand: 'git status --short',
          inboundDevices: ['xray4668'],
        },
        remoteDevices: [{ deviceId: 'dev-remote', deviceName: 'xray4668', online: true, sessions: 2 }],
      },
      {
        // 声明了会话侧但清单里没有这台设备：名字要显示，且带「（未连接）」；
        // 没有任何运行时证据 —— 这一条用来钉「没有证据就不要编造」。
        workspaceId: UNRES_WS,
        path: UNRES_PATH,
        title: 'ArkTower',
        owner: { deviceId: 'dev-local', name: 'orangepi5', isSelf: true, online: true, source: 'roles' },
        session: { deviceId: '', name: 'ghost', isSelf: false, online: false, source: 'roles', unresolved: true },
        remote: true,
        active: false,
        evidence: {
          mirrorSessions: 0, mirrorLastAt: null, inboundExec: 0, inboundDenied: 0, inboundTotal: 0,
          inboundLastAt: null, inboundLastCommand: '', inboundDevices: [],
        },
        remoteDevices: [],
      },
    ],
    sessions: [
      {
        sessionId: OWN_S1, deviceId: 'dev-remote', deviceName: 'xray4668',
        workspaceId: OWN_WS, workspacePath: OWN_PATH, title: '', live: true, lastActivityAt: 1791900000000,
        mirror: true, mirrorEvents: 1960, mirrorLastAt: '2026-10-13T04:20:41.807Z',
        inbound: 2, inboundLastAt: '2026-10-13T10:45:11.980Z', presentLocally: true, source: 'exec',
      },
      {
        sessionId: OWN_S2, deviceId: 'dev-remote', deviceName: 'xray4668',
        workspaceId: OWN_WS, workspacePath: OWN_PATH, title: '', live: false, lastActivityAt: 1791800000000,
        mirror: true, mirrorEvents: 508, mirrorLastAt: '2026-10-13T03:01:25.509Z',
        inbound: 5, inboundLastAt: '2026-10-13T10:44:00.000Z', presentLocally: false, source: 'exec',
      },
    ],
    truncated: false,
  };
}

/**
 * 属主/执行端（.19）的 /tree 响应。`withDrivers: false` 模拟**旧版 host**
 * （有 authority、没有 drivers）—— 那时行为必须与改动前逐字一致。
 * @param {boolean} withDrivers 是否下发 drivers。
 * @returns {object} /tree 响应。
 */
function ownerResponse(withDrivers = true) {
  const tree = {
    schema: 1,
    selfDeviceId: 'dev-local',
    authority: { deviceId: 'dev-local', name: 'orangepi5', isSelf: true, configured: true },
    devices: [
      {
        deviceId: 'dev-local', name: 'orangepi5', self: true, liveness: 'online',
        inventory: {
          workspaces: [
            {
              id: OWN_WS, title: 'DSHpluginWorkSpace', path: OWN_PATH, sessionCount: 1, droppedSessions: 0, liveCount: 0,
              // 面板用例要在这台工作区里看到会话行；侧边栏用例走 host 的 localMatch 分支。
              sessions: [{ id: OWN_S2, cwd: OWN_PATH, live: false, origin: null, archived: false }],
            },
          ],
        },
      },
      {
        deviceId: 'dev-remote', name: 'xray4668', self: false, liveness: 'online',
        inventory: {
          workspaces: [
            {
              id: OWN_WS, title: 'DSHpluginWorkSpace', path: OWN_PATH, sessionCount: 2, droppedSessions: 0, liveCount: 1,
              localMatch: { workspaceId: OWN_WS, title: 'DSHpluginWorkSpace', path: OWN_PATH },
              sessions: [
                { id: OWN_S1, cwd: OWN_PATH, live: true, presentLocally: true, origin: null, archived: false },
                { id: OWN_S2, cwd: OWN_PATH, live: false, origin: null, archived: false },
              ],
            },
          ],
        },
      },
    ],
  };
  if (withDrivers) tree.drivers = driversFixture();
  return { ok: true, tree };
}

// ── react mock（只实现本组件用到的面） ───────────────────────────────────────
// `hooks` 是 `let`：deepRender 渲染子组件时要**换一层 hook 表**（React 的规则：
// 每个组件实例自己一份 hook），渲染完再换回来。
let hooks = new Map();
let hookIndex = 0;
let dirty = false;
const pending = [];
/** 清空当前这一层的 hook 表（换组件渲染时用，模拟「挂载一个新实例」）。 */
function resetHooks() {
  hooks = new Map();
  hookIndex = 0;
  pending.length = 0;
}
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(init) {
    // 必须捕获得**这一层**的表：deepRender 渲染完子组件会把 hooks 换回去，
    // setter 若在调用时才读模块级 hooks，就会写进别人的那一层。
    const table = hooks;
    const key = hookIndex++;
    if (!table.has(key)) table.set(key, typeof init === 'function' ? init() : init);
    const value = table.get(key);
    return [value, (next) => { table.set(key, typeof next === 'function' ? next(table.get(key)) : next); dirty = true; }];
  },
  useEffect(fn) { hookIndex++; pending.push(fn); },
  useCallback(fn) { hookIndex++; return fn; },
  useRef(init) { hookIndex++; return { current: init }; },
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
// 夹具可变：执行端标识（drivers）的用例要换 /tree 响应，fetch 每次读当前值。
let currentTree = TREE;
// 镜像进度夹具（`/replica-progress`）与 POST 记录：进度行与「接管」按钮的用例用。
let currentProgress = { ok: true, sessions: [] };
const posted = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (init !== undefined && init.method === 'POST') {
    posted.push({ url: target, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
  }
  return {
    ok: true,
    status: 200,
    json: async () => {
      if (target.includes('/replica-progress')) return currentProgress;
      if (target.includes('/tree')) return currentTree;
      // 接管成功的回执形状抄自 host 的 `/takeover`（在线路径）。
      if (target.includes('/takeover')) {
        return {
          ok: true, mode: 'pull', sessionId: OWN_S2, deviceId: 'dev-remote', deviceName: 'orangepi5',
          version: 'v4', bytes: 3936333, path: '/root/.dsh/sessions/--root-DSHpluginWorkSpace--/' + OWN_S2 + '/session.v4.jsonl.zstd',
          backup: null, shadowed: [],
        };
      }
      return { ok: true };
    },
  };
};

/**
 * 一条进度行（字段抄自 host 的 `/replica-progress` 输出，不随手编）。
 * @param {object} [overrides] 覆盖字段。
 * @returns {object} 进度行。
 */
function progressRow(overrides = {}) {
  return {
    sessionId: OWN_S2,
    replicaId: OWN_S2,
    deviceId: 'dev-remote',
    sourceDeviceName: 'xray4668',
    title: '',
    cwd: OWN_PATH,
    workspacePath: OWN_PATH,
    firstSeq: 0,
    lastSeq: 4210,
    events: 508,
    bytes: 2110292,
    truncated: false,
    dropped: 0,
    createdAt: '2026-10-13T03:00:00.000Z',
    updatedAt: new Date(Date.now() - 12000).toISOString(),
    idleMs: 12000,
    live: true,
    lastEventType: 'tool/call',
    lastEventTime: 1791900000000,
    summary: '调用工具 bash',
    headerVersion: 4,
    hasHeader: true,
    remoteLive: true,
    remoteLastActivityAt: 1791900000000,
    localExists: false,
    localHasEvents: false,
    localLive: false,
    localBytes: 0,
    takenOverAt: null,
    canTakeover: true,
    ...overrides,
  };
}

/** 把微任务与定时器推完（effect 里的 refresh/pull 都是 promise）。 */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

const src = fs.readFileSync(CLIENT, 'utf8');
new Function('window', 'document', 'globalThis', src)(globalThis.window, globalThis.document, globalThis);
assert.ok(captured !== null, 'client.js 应注册进 __ModuleLoader__');
const require_ = (name) => {
  if (name === 'react') return react;
  throw new Error('unexpected require: ' + name);
};
const moduleExports = captured.factory(require_);
assert.equal(typeof moduleExports.apply, 'function', '导出 apply');

// ── slots mock + apply ──────────────────────────────────────────────────────
const injected = new Map();
const slots = { inject(name, cb) { injected.set(name, cb); }, register(def, component) { return { def, component }; } };
moduleExports.apply({ slots, logger: { warn() {} } });
assert.ok(injected.has('sidebar.workspaces.remote'), '应注入 sidebar.workspaces.remote');
const Component = injected.get('sidebar.workspaces.remote')().component;

// ── 渲染两遍（第一遍触发 effect 里的 refresh，第二遍用新 state） ─────────────
function renderOnce() {
  hookIndex = 0;
  pending.length = 0;
  const element = Component({ wide: true });
  return typeof element === 'object' && element !== null && typeof element.type === 'function'
    ? element.type(element.props)
    : element;
}
let tree = renderOnce();
for (const effect of pending) effect();
for (let i = 0; i < 30; i++) await Promise.resolve();
await new Promise((r) => setTimeout(r, 10));
assert.ok(dirty, 'refresh 之后应有状态更新');
tree = renderOnce();

const text = [];
(function walk(node) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return; }
  if (Array.isArray(node)) { for (const item of node) walk(item); return; }
  if (node.props) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'children') continue;
      if (typeof value === 'string') text.push(value);
    }
  }
  for (const child of node.children ?? []) walk(child);
})(tree);
const joined = text.join('\n');
const groupKeys = (function keysOf(node, acc = []) {
  if (node === null || node === undefined || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const item of node) keysOf(item, acc); return acc; }
  if (node.props && node.props.key !== undefined) acc.push(String(node.props.key));
  for (const child of node.children ?? []) keysOf(child, acc);
  return acc;
})(tree).filter((k) => /^ws-[abcd]/.test(k));

console.log('行 key：', JSON.stringify(groupKeys));

// 1) 被截断的同 id 工作区：一行都不开
assert.equal(groupKeys.filter((k) => k.startsWith('ws-a')).length, 0,
  'ws-a：本机清单被截断（dropped>0）→ 不猜差异，整行跳过');
// 2) 两边完全一致：一行都不开
assert.equal(groupKeys.filter((k) => k.startsWith('ws-b')).length, 0,
  'ws-b：两边清单一致 → 纯重复，一行都不该有');
// 3) 本机完整 + 对端独有会话：一行，且 key 是共享 workspaceId
assert.equal(groupKeys.filter((k) => k === 'ws-c').length, 1,
  `ws-c：2 条对端独有会话 → 一行，标识用共享 id（实际 ${JSON.stringify(groupKeys)}）`);
assert.equal(groupKeys.filter((k) => k === 'ws-d').length, 1,
  'ws-d：1 条对端独有会话 → 一行');
// 4) key 唯一
assert.equal(new Set(groupKeys).size, groupKeys.length, 'React key 必须唯一');
// 5) 文案与 aria-label
assert.ok(joined.includes('网络会话工作区'), 'aria-label 应为「网络会话工作区」');
assert.ok(joined.includes('同一工作区'), '合并行要说明「同一工作区」');
assert.ok(joined.includes('＋2'), 'ws-c 行要显示 ＋2');
assert.ok(!joined.includes('b-1'), '重复会话不许再列一遍');
assert.ok(!joined.includes('a-0'), '被截断的工作区不许列会话');

// 6) 展开 ws-c：列出的正是那两条对端独有会话
(function click(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) click(item); return; }
  if (node.props && node.props.key === 'row' && typeof node.props.onClick === 'function'
    && String(node.props.title || '').includes('/root/c')) node.props.onClick();
  for (const child of node.children ?? []) click(child);
})(tree);
tree = renderOnce();
const expanded = [];
(function walk2(node) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') { expanded.push(String(node)); return; }
  if (Array.isArray(node)) { for (const item of node) walk2(item); return; }
  if (node.props) {
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'children') continue;
      if (typeof value === 'string') expanded.push(value);
    }
  }
  for (const child of node.children ?? []) walk2(child);
})(tree);
const expandedText = expanded.join('\n');
assert.ok(expandedText.includes('c-rem-9') && expandedText.includes('c-rem-10'), '展开后要列出对端独有会话');
assert.ok(!expandedText.includes('c-loc-1'), '本机已有的会话不许重复列');
assert.ok(expandedText.includes('同一工作区'), '展开后要有归属提示');

// ── 执行端标识（drivers）自测 ───────────────────────────────────────────────
// 覆盖：①属主侧有远端会话 → 画执行端标记且文案方向正确；②属主侧但 drivers 缺失
// → 与改动前一致（不画）；③副本侧行为不变；④会话行命中 inbound>0 → 警示样式与次数；
// ⑤session.unresolved → 名称带「（未连接）」。每条都能真的失败。

/** 收集整棵渲染树里的字符串（含 props 上的 className/title，也含子节点文本）。 */
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

/** 点掉第一个「key==='row' 且 title 含 needle」的行。 */
function clickRow(node, needle) {
  let hits = 0;
  (function walk(entry) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (entry.props && entry.props.key === 'row' && typeof entry.props.onClick === 'function'
      && String(entry.props.title || '').includes(needle)) { entry.props.onClick(); hits += 1; return; }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return hits;
}

// ── 递归渲染（把函数组件也执行掉）──────────────────────────────────────────
// 两种需要它的情况：
//   1. 本插件把标示做成了组件复用的形式（`h(DriverMark, …)`），只执行顶层渲染时
//      拿到的是「组件元素」而不是最终要断言的 `className`；
//   2. 设备网格面板是「设备 → 工作区 → 会话」多层组件，不展开就看不到会话行。
// hook 表按**组件函数**分：夹具里每类需要保留状态的组件只出现一次实例
// （MeshPanel / OverviewTab 各一个），够用且不必实现 React 的位置 key。
const deepTables = new WeakMap();

/**
 * 递归渲染：函数组件执行、宿主元素递归 children。
 * @param {object} element 元素。
 * @returns {object|null} 宿主元素树。
 */
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
      // 与 React 一致：children 也从 props.children 传（工厂里的 Collapsible 等
      // 读的就是 props.children，而不是 createElement 的第三参数）。
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

/** 深渲染若干遍（每遍跑完 effect 并等异步），让内部状态收敛。 */
async function deepMount(make, passes) {
  let tree = null;
  for (let i = 0; i < passes; i++) {
    pending.length = 0;
    tree = deepRender(make());
    for (const effect of pending) effect();
    await flush();
  }
  return tree;
}

/** 点掉第一个 className 含 className 的节点（面板的工作区头就是这一种）。 */
function clickClass(node, className) {
  let hits = 0;
  (function walk(entry) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (entry.props && typeof entry.props.className === 'string'
      && entry.props.className.split(' ').includes(className)
      && typeof entry.props.onClick === 'function') { entry.props.onClick(); hits += 1; return; }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return hits;
}

// 本机工作区行上的标示（要求 1/2/3/5 走这条路径）。
const rowMarkComponent = injected.get('sidebar.workspaces.row.mark')().component;
function renderRowMark(props) {
  const outer = rowMarkComponent(props);
  return typeof outer === 'object' && outer !== null && typeof outer.type === 'function'
    ? outer.type(outer.props)
    : outer;
}
/** 渲染一次「本机工作区行标注」：先挂订阅，等 /tree 回来，再按新快照渲染。 */
async function markFor(response, props) {
  currentTree = response;
  resetHooks();
  deepRender(renderRowMark(props));
  for (const effect of pending) effect();
  await flush();
  resetHooks();
  // 深渲染一遍：标示是复用的组件（`h(DriverMark, …)`），要执行到宿主元素才看得到 class。
  return deepRender(renderRowMark(props));
}
/** 用指定 /tree 夹具渲染侧边栏「远程工作区」段（深渲染，会话行也能看到）。 */
async function renderRemote(response) {
  currentTree = response;
  resetHooks();
  deepRender(renderOnce());
  for (const effect of pending) effect();
  await flush();
  return deepRender(renderOnce());
}

// ① 属主侧 + drivers 说会话在远端 → 画 ⇄（不是地球），文案方向正确
const ownMark = await markFor(ownerResponse(true), { workspaceId: OWN_WS });
assert.ok(ownMark !== null && ownMark.props.className === 'dmesh-driver-mark',
  `①属主侧应画 dmesh-driver-mark（实际 ${JSON.stringify(ownMark === null ? null : ownMark.props.className)}）`);
const ownTitle = String(ownMark.props.title);
assert.ok(ownTitle.startsWith('远端执行会话：agent 在 xray4668 上运行，命令与文件在本机执行'), '①首行方向正确');
assert.ok(!ownTitle.includes('转发执行'), '①不该出现「转发执行」的说法');
assert.ok(ownTitle.includes('本机已收到 3 次执行请求'), '①入站次数');
assert.ok(/最近 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ownTitle), '①最近时间用本地时间');
assert.ok(ownTitle.includes('来自 xray4668'), '①来源设备');
assert.ok(ownTitle.includes('最近一条命令：git status --short'), '①最近一条命令');
assert.ok(ownTitle.includes('另有 2 条会话的历史已镜像到本机'), '①镜像行');

// ② 属主侧但没有 drivers（旧版 host）→ 一个字都不画
const noDrivers = await markFor(ownerResponse(false), { workspaceId: OWN_WS });
assert.equal(noDrivers, null, '②drivers 缺失时不该画任何标示');

// ③ 副本侧行为不变：同一份 drivers 摆在面前，也还是「副本工作区」的地球图标
const copyResponse = ownerResponse(true);
copyResponse.tree.authority = { deviceId: 'dev-remote', name: 'xray4668', isSelf: false, configured: true };
copyResponse.tree.drivers.workspaces[0].owner = { deviceId: 'dev-remote', name: 'xray4668', isSelf: false, online: true, source: 'roles' };
const copyMark = await markFor(copyResponse, { workspaceId: OWN_WS });
assert.ok(copyMark !== null && copyMark.props.className === 'dmesh-rw-net',
  `③副本侧仍是地球图标（实际 ${JSON.stringify(copyMark === null ? null : copyMark.props.className)}）`);
assert.ok(String(copyMark.props.title).includes('副本工作区：属主/执行侧是 xray4668'), '③副本侧文案不变');

// ⑤ unresolved → 名称带「（未连接）」；没有证据就不编造
const unresMark = await markFor(ownerResponse(true), { workspaceId: UNRES_WS });
const unresTitle = String(unresMark === null ? '' : unresMark.props.title);
assert.ok(unresTitle.includes('agent 在 ghost（未连接） 上运行'), '⑤未连接设备名带「（未连接）」');
assert.ok(unresTitle.includes('（尚未观察到发往本机的命令）'), '⑤无证据时只说明还没观察到');
assert.ok(!unresTitle.includes('最近一条命令'), '⑤无证据不许编造命令');
assert.ok(!unresTitle.includes('另有'), '⑤mirrorSessions=0 不出镜像行');

// ④ 侧边栏：本机属主的工作区行 + 会话行命中 inbound>0 → 警示样式与次数
let ownSection = await renderRemote(ownerResponse(true));
assert.equal(clickRow(ownSection, OWN_PATH), 1, '④属主侧应先渲染出一行工作区');
ownSection = deepRender(renderOnce());
const ownAll = collectStrings(ownSection).join('\n');
assert.ok(ownAll.includes('dmesh-driver-mark'), '④属主侧工作区行要画执行端标示');
assert.ok(ownAll.includes('远端执行会话：agent 在 xray4668 上运行，命令与文件在本机执行'), '④工作区行文案方向正确');
assert.ok(ownAll.includes('dmesh-rw-devtagWarn'), '④会话行命中 inbound>0 → 警示样式');
assert.ok(ownAll.includes('本机已收到它发来的 5 次执行'), '④会话行给出次数');
assert.ok(/本机已收到它发来的 5 次执行（最近 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）/.test(ownAll), '④次数带本地时间');
assert.ok(ownAll.includes('历史已镜像到本机（508 事件）'), '④会话行给出镜像事件数');
assert.ok(ownAll.includes('远端会话：agent 在 xray4668，命令与文件在本机执行 —— 可能将命令发到本机'), '④会话行基准文案方向正确');

// ③b 副本侧的侧边栏：没有 drivers（旧版 host）时逐字保持改动前
const legacyResponse = ownerResponse(false);
legacyResponse.tree.authority = { deviceId: 'dev-remote', name: 'xray4668', isSelf: false, configured: true };
let legacySection = await renderRemote(legacyResponse);
assert.equal(clickRow(legacySection, OWN_PATH), 1, '③b副本侧行仍要渲染');
legacySection = deepRender(renderOnce());
const legacyAll = collectStrings(legacySection).join('\n');
assert.ok(legacyAll.includes('dmesh-rw-net'), '③b副本侧仍是地球图标');
assert.ok(legacyAll.includes('转发执行：命令与文件在 xray4668 上执行'), '③b副本侧文案不变');
assert.ok(!legacyAll.includes('dmesh-driver-mark'), '③b副本侧不画执行端标示');
assert.ok(legacyAll.includes('远端会话：日志与 agent 在 xray4668，本机只能复制它的 id'), '③b副本侧会话行文案不变');
assert.ok(!legacyAll.includes('dmesh-rw-devtagWarn'), '③b副本侧会话行不带警示样式');

// ── 要求 4：设备网格面板「设备 → 工作区 → 会话」里要有同一套标记 ─────────────
const mainComponent = injected.get('main')().component;
currentTree = ownerResponse(true);
await deepMount(() => mainComponent({}), 3);
const panelCollapsed = await deepMount(() => mainComponent({}), 1);
assert.equal(clickClass(panelCollapsed, 'dmesh-ws-head'), 1, '④面板：本机设备的工作区头应可展开');
const panelOpen = await deepMount(() => mainComponent({}), 2);
const panelAll = collectStrings(panelOpen).join('\n');
assert.ok(panelAll.includes('dmesh-driver-mark'), '④面板工作区行要画执行端标示');
assert.ok(panelAll.includes('远端执行会话：agent 在 xray4668 上运行，命令与文件在本机执行'), '④面板工作区行文案方向正确');
assert.ok(panelAll.includes('dmesh-rw-devtag') && panelAll.includes('⇄xray4668'), '④面板会话行要有 ⇄设备名');
assert.ok(panelAll.includes('dmesh-rw-devtagWarn'), '④面板会话行命中 inbound>0 → 警示样式');
assert.ok(panelAll.includes('本机已收到它发来的 5 次执行'), '④面板会话行给出次数');

// ── 要求 6：执行端要看得到「最近进度」，并且能「随时接管」────────────────────
// 场景：本机是 orangepi5（执行端），xray4668 上有条会话（OWN_S2）本机没有 ——
// 它的历史一直在往本机镜像里推。执行端应该：① 看见它在干什么；② 一键把它变成本机会话。
/** 点掉第一个文本等于 label 的按钮（接管按钮是「武装 → 确认」两段式）。 */
function clickButtonByText(node, label) {
  let hits = 0;
  (function walk(entry) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (entry.type === 'button' && typeof entry.props.onClick === 'function') {
      const own = (entry.children ?? []).filter((child) => typeof child === 'string').join('');
      if (own === label) { entry.props.onClick({ stopPropagation() {} }); hits += 1; return; }
    }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return hits;
}

/**
 * 渲染「远程工作区」段并**展开 extras 行**，等异步收敛。
 *
 * 进度订阅挂在会话行上（不展开就不轮询），所以展开之后必须再跑一轮 effect + 等异步，
 * 否则拿到的是「订阅还没生效」的那一帧。
 * @param {object} response /tree 响应。
 * @param {string} path 要展开的工作区路径。
 * @returns {Promise<object>} 深渲染后的节点树。
 */
async function expandRemote(response, path) {
  let node = await renderRemote(response);
  clickRow(node, path);
  node = deepRender(renderOnce());
  for (const effect of pending) effect();
  await flush();
  return deepRender(renderOnce());
}

/** 接管按钮的全部文案（「武装」前后不同）。 */
const TAKEOVER_LABELS = ['接管', '更新并接管', '确认接管', '确认覆盖并接管'];

/**
 * 只看有没有接管按钮，**不点它**。
 *
 * 为什么不复用 clickButtonByText：本 harness 的 hook 表按组件类型共享（`deepTables`），
 * 同一个按钮组件在不同用例之间会留着上一轮的 `armed` 状态 —— 于是文案可能是
 * 「确认覆盖并接管」而不是「更新并接管」。断言「按钮在不在」时要把四种文案一起看，
 * 而且不该为了看一眼就真的点下去（点下去会发请求）。
 * @param {object} node 渲染树。
 * @returns {boolean} 是否存在接管按钮。
 */
function hasTakeoverButton(node) {
  let hit = false;
  (function walk(entry) {
    if (hit || entry === null || entry === undefined || typeof entry !== 'object') return;
    if (Array.isArray(entry)) { for (const item of entry) walk(item); return; }
    if (entry.type === 'button' && typeof entry.props.onClick === 'function') {
      const own = (entry.children ?? []).filter((child) => typeof child === 'string').join('');
      if (TAKEOVER_LABELS.includes(own)) { hit = true; return; }
    }
    for (const child of entry.children ?? []) walk(child);
  })(node);
  return hit;
}

currentProgress = { ok: true, sessions: [progressRow()] };
let progressSection = await expandRemote(ownerResponse(true), OWN_PATH);
const progressAll = collectStrings(progressSection).join('\n');
assert.ok(progressAll.includes('调用工具 bash'), '⑥进度行要显示最近在干什么');
assert.ok(progressAll.includes('正在跑'), '⑥对端清单说 agent 在跑 → 显示「正在跑」');
assert.ok(progressAll.includes('seq 4210'), '⑥进度行带镜像 seq');
assert.ok(progressAll.includes('dmesh-prog-dot on'), '⑥正在跑用绿点');
assert.equal(clickButtonByText(progressSection, '接管'), 1, '⑥能接管时要有一个「接管」按钮');

// 两段式：第一次点击只是武装（不改文案不写盘），第二次才真的动手
assert.equal(posted.length, 0, '⑥点击前不该有写操作');
assert.equal(clickButtonByText(progressSection, '接管'), 1, '⑥应有一个「接管」按钮');
let armed = deepRender(renderOnce());
assert.equal(posted.length, 0, '⑥第一次点击只武装，不发请求');
assert.equal(clickButtonByText(armed, '确认接管'), 1, '⑥武装后按钮变成「确认接管」');
await flush();
assert.equal(posted.length, 1, '⑥确认后应发一次接管请求');
assert.equal(posted[0].url, '/dsh-device-mesh/takeover', '⑥接管请求打的是接管路由');
assert.deepEqual(posted[0].body, { sessionId: OWN_S2, deviceId: 'dev-remote' }, '⑥带上会话 id 与设备 id');
const doneAll = collectStrings(deepRender(renderOnce())).join('\n');
assert.ok(doneAll.includes('已从 orangepi5 拉回'), '⑥接管成功要有就地回执');

// 本机已有旧历史时：文案变成「更新并接管」，并说明会覆盖
currentProgress = { ok: true, sessions: [progressRow({ localExists: true, localHasEvents: true, localBytes: 4096 })] };
posted.length = 0;
const overwriteSection = await expandRemote(ownerResponse(true), OWN_PATH);
const overwriteAll = collectStrings(overwriteSection).join('\n');
assert.ok(overwriteAll.includes('更新并接管'), '⑥本机有旧历史时按钮说「更新并接管」');
assert.equal(clickButtonByText(overwriteSection, '更新并接管'), 1, '⑥按钮存在');
assert.ok(collectStrings(deepRender(renderOnce())).join('\n').includes('确认覆盖并接管'), '⑥覆盖要二次确认');

// 镜像目录里两代命名并存：进度行的 id 只有裸 uuid 也要认出来
currentProgress = { ok: true, sessions: [progressRow({ sessionId: OWN_S2.slice('session-'.length), replicaId: OWN_S2.slice('session-'.length) })] };
const bareSection = await expandRemote(ownerResponse(true), OWN_PATH);
assert.ok(collectStrings(bareSection).join('\n').includes('调用工具 bash'), '⑥裸 uuid 的进度行也要匹配上');

// 已自动同步到本机：进度行说「已留在本机」，接管按钮收起来（那件事已经做完了）
currentProgress = {
  ok: true,
  sessions: [progressRow({
    syncedAt: '2026-10-15T15:00:00.000Z', syncedSeq: 4210, syncedBytes: 2110292, syncedVersion: 'v4', synced: true,
  })],
};
const syncedSection = await expandRemote(ownerResponse(true), OWN_PATH);
const syncedAll = collectStrings(syncedSection).join('\n');
assert.ok(syncedAll.includes('已留在本机'), '⑥同步完成时进度行要说「已留在本机」');
assert.equal(hasTakeoverButton(syncedSection), false, '⑥已同步时不再摆接管按钮');

// 本机副本落后于镜像：说清楚落后，并把接管按钮给回来（它同时是「拉回最新」）
currentProgress = {
  ok: true,
  sessions: [progressRow({
    syncedAt: '2026-10-14T15:00:00.000Z', syncedSeq: 10, syncedBytes: 4096, syncedVersion: 'v4', synced: false,
    localExists: true, localHasEvents: true, lastSeq: 4210,
  })],
};
const staleSection = await expandRemote(ownerResponse(true), OWN_PATH);
const staleAll = collectStrings(staleSection).join('\n');
assert.ok(staleAll.includes('本机副本落后'), '⑥落后时要说「本机副本落后」');
assert.equal(hasTakeoverButton(staleSection), true, '⑥落后时给回接管按钮（它同时是「拉回最新」）');

// 没有进度（旧版 host / 这条会话从不「动」）→ 一个字的接管都不出现（保持改动前）
currentProgress = { ok: true, sessions: [] };
const plainSection = await expandRemote(ownerResponse(true), OWN_PATH);
const plainAll = collectStrings(plainSection).join('\n');
assert.equal(clickButtonByText(plainSection, '接管'), 0, '⑥没有镜像进度时不该有「接管」按钮');
assert.ok(!plainAll.includes('dmesh-takeover'), '⑥没有镜像进度时不渲染接管按钮容器');
assert.ok(!plainAll.includes('dmesh-rw-sessionTall'), '⑥没有进度时行高维持出厂的 32px');
assert.ok(plainAll.includes('本机没有的会话'), '⑥没有进度时会话行文案保持改动前');

console.log('CLIENT SIDEBAR DEDUP SELFTEST PASS');
