/**
 * dsh-archived-sessions host 半边自测（不需要 dsh 进程、不碰真实 storages）。
 *
 *   node plugins/dsh-archived-sessions/selftest.mjs
 *
 * 覆盖：路由注册与回收、热重挂（路径被旧实例占用）容错、按工作区分组、
 * 内容检索（FTS 快路径 / 字面量退化路径 / 同步能力探测）、时间预算与 skip 续检、
 * 断开取消、恢复写入串行化、纯函数缝，以及 v3 的三处性能改动
 * （投影缓存标题快路径 / 成员感知 TTL 缓存 / 在飞合并 + 取消传播）。
 */

import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';

import * as plugin from './entry-v6.js';

// ───────────────────────────────── 迷你测试运行器 ─────────────────────────────────

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   ' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('FAIL ' + name + '\n     ' + (error && error.message ? error.message : String(error)));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await sleep(5);
  }
}

// ───────────────────────────────────── 端口桩 ─────────────────────────────────────

const LIST = '/dsh-arcsess/list';
const SEARCH = '/dsh-arcsess/search';
const RESTORE = '/dsh-arcsess/restore';
const DELETE = '/dsh-arcsess/delete';
const STATUS = '/dsh-arcsess/status';

function makeWebServer() {
  const routes = new Map();
  const registerCalls = [];
  return {
    routes,
    registerCalls,
    register(route) {
      registerCalls.push(route.path);
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
}

function makeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.headers = null;
  res.body = '';
  res.finished = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (chunk) => { res.body += chunk === undefined ? '' : String(chunk); res.finished = true; };
  res.payload = () => JSON.parse(res.body);
  return res;
}

/** 请求体分片：真实 IncomingMessage 默认给 Buffer，`chunks` 可传数组模拟跨分片切割。 */
function makeReq({ method = 'GET', url = '/', headers = {}, body = null, chunks = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  setImmediate(() => {
    if (chunks !== null) for (const chunk of chunks) req.emit('data', chunk);
    else if (body !== null) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

/** 挂一个插件实例：自带 effect 账本 + 路由调用入口。 */
function mount({ webServer = makeWebServer(), config = {}, services = {} } = {}) {
  const effects = [];
  const warnings = [];
  const ctx = {
    webServer,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    effect(factory, label) {
      const dispose = factory();
      effects.push({ label, dispose });
      return dispose;
    },
    get(name) { return services[name]; },
  };
  plugin.apply(ctx, config);
  return {
    ctx,
    webServer,
    effects,
    warnings,
    services,
    disposeAll() {
      for (const entry of effects.splice(0)) if (typeof entry.dispose === 'function') entry.dispose();
    },
    async call(path, options = {}) {
      const route = webServer.routes.get(path);
      assert.ok(route !== undefined, `路由未注册：${path}（已注册：${[...webServer.routes.keys()].join(', ') || '无'}）`);
      const res = makeRes();
      route.handler(makeReq({ url: options.url ?? path, ...options }), res);
      await waitFor(() => res.finished, 30000);
      assert.ok(res.finished, `路由 ${path} 没有响应`);
      return { status: res.status, headers: res.headers, body: res.payload(), res };
    },
  };
}

// ──────────────────────────────────── 服务桩 ────────────────────────────────────

/** 直接驱动路由、不等响应：用来测「取消后不该回包」这类无响应路径。 */
function rawCall(app, path, options = {}) {
  const route = app.webServer.routes.get(path);
  assert.ok(route !== undefined, `路由未注册：${path}`);
  const res = makeRes();
  route.handler(makeReq({ url: options.url ?? path, ...options }), res);
  return res;
}

function disabledSearchError() {
  const error = new Error('session search is disabled: this deployment configures the session-query index with openAt "never"');
  error.name = 'SessionQueryError';
  error.code = 'SESSION_QUERY_SEARCH_DISABLED';
  return error;
}

function makeRegistry({ archived = [], workspaces = [], writeDelayMs = 0 } = {}) {
  const state = { initialized: true, workspaceIds: workspaces.map((w) => w.id), archivedSessionIds: [...archived] };
  const registry = {
    state,
    archivedSessionIds: state.archivedSessionIds,
    writes: [],
    async list() { return workspaces; },
    async setState(next) {
      if (writeDelayMs > 0) await sleep(writeDelayMs);
      registry.writes.push(next);
      Object.assign(state, next);
      // readArchivedIds 优先读属性，桩必须跟着内存态一起换。
      registry.archivedSessionIds = state.archivedSessionIds;
    },
  };
  return registry;
}

const literalMatch = (text, query) => {
  const pattern = String(query).split(/\s+/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+');
  return new RegExp(pattern, 'iu').test(String(text));
};

function makeQuery({
  sessions = [],
  titles = {},
  documents = {},
  openAt = 'never',
  searchSessions,
  perCallDelayMs = 0,
  titleFailure = false,
  listDelayMs = 0,
} = {}) {
  const stats = {
    listSessions: 0,
    titleBatch: 0,
    readTitle: 0,
    filterEvents: 0,
    searchSessions: 0,
    listSignals: [],
    titleBatchSignals: [],
    readTitleSignals: [],
    lastTitleIds: null,
  };
  const query = {
    config: { openAt },
    stats,
    lastFilters: null,
    async listSessions(signal) {
      stats.listSessions += 1;
      stats.listSignals.push(signal);
      if (listDelayMs > 0) await sleep(listDelayMs);
      return sessions;
    },
    async readTitleSnapshots(ids, signal) {
      stats.titleBatch += 1;
      stats.titleBatchSignals.push(signal);
      stats.lastTitleIds = [...ids];
      if (titleFailure) throw new Error('title index unavailable');
      return ids.map((id) => (titles[id] === undefined
        ? { sessionId: id, status: 'rejected', reason: new Error('no title') }
        : { sessionId: id, status: 'fulfilled', value: { session: null, title: { title: titles[id], updatedAt: 1750000000000 } } }));
    },
    async readTitle(id, signal) {
      stats.readTitle += 1;
      stats.readTitleSignals.push(signal);
      return titles[id] === undefined ? null : { title: titles[id], updatedAt: 1750000000000 };
    },
    async filterEvents(id, filters) {
      stats.filterEvents += 1;
      query.lastFilters = filters;
      if (perCallDelayMs > 0) await sleep(perCallDelayMs);
      const text = filters.find((filter) => filter.kind === 'text')?.text ?? '';
      const types = filters.find((filter) => filter.kind === 'type')?.values ?? null;
      return (documents[id] ?? []).filter((doc) => (types === null || types.includes(doc.type)) && literalMatch(doc.text, text));
    },
    async searchSessions(request) {
      stats.searchSessions += 1;
      query.lastSearchRequest = request;
      if (searchSessions !== undefined) return searchSessions(request);
      throw disabledSearchError();
    },
  };
  return query;
}

/**
 * 投影缓存桩：模拟 `ctx.sessionProjectionCache` 的 listing 读
 * （`cachedSnapshot(header)` / `cachedPredecessorTitle(header)`——出厂同款，无第二个参数；v3 曾错传 0）。
 *
 *   entries[id] = { title, lastPromptAt?, seq?, predecessor?: true }
 *
 * `predecessor: true` 模拟「记录里的行版本比当前投影旧」——出厂读法此时退到
 * 只给标题的前身视图；未列出的 id 视为没有该会话的记录。
 */
function makeProjectionCache({ entries = {}, throwAlways = false } = {}) {
  const stats = { cachedSnapshot: 0, predecessor: 0, calls: [], headers: [] };
  return {
    stats,
    cachedSnapshot(header, cut) {
      stats.cachedSnapshot += 1;
      stats.calls.push(header.id + '@' + String(cut));
      stats.headers.push(header);
      if (throwAlways) throw new Error('projcache unavailable');
      const entry = entries[header.id];
      if (entry === undefined || entry.predecessor === true) return undefined;
      const values = { title: entry.title };
      if (typeof entry.lastPromptAt === 'number') values.sessionListMetadata = { lastPromptAt: entry.lastPromptAt };
      return { asOfSeq: typeof entry.seq === 'number' ? entry.seq : 7, values };
    },
    cachedPredecessorTitle(header) {
      stats.predecessor += 1;
      const entry = entries[header.id];
      if (entry === undefined || entry.predecessor !== true) return undefined;
      return { asOfSeq: -1, values: { title: entry.title } };
    },
  };
}

// ─────────────────────────────────── 测试数据 ───────────────────────────────────

const WS_A = { id: 'ws-a', title: 'ArkTower', path: '/root/nas/ArkTower' };
const WS_B = { id: 'ws-b', title: 'rustdesk_server', path: '/root/code/rustdesk_server' };

const listSessions = [
  { header: { id: 's1', cwd: '/root/nas/ArkTower', createdAt: 1750000000000, origin: 'interactive' }, live: false, persisted: true },
  { header: { id: 's2', cwd: '/root/nas/ArkTower', createdAt: 1750000900000, origin: 'subagent' }, live: true, persisted: true },
  { header: { id: 's3', cwd: '/root/code/rustdesk_server', createdAt: 1740000000000 }, live: false, persisted: true },
  { header: { id: 's4', cwd: '/tmp/scratch' }, live: false, persisted: false },
];

const listWorkspaces = [
  { id: 'ws-a', title: 'ArkTower', path: '/root/nas/ArkTower', sessionIds: ['s1', 's2'] },
  { id: 'ws-b', title: 'rustdesk_server', path: '/root/code/rustdesk_server', sessionIds: ['s3'] },
];

/** 带 lifecycle 字段的会话记录：投影缓存要靠 version / isSeeded 做 identity 校验。 */
const cacheReadySessions = [
  { header: { id: 's1', version: 3, isSeeded: false, cwd: '/root/nas/ArkTower', createdAt: 1750000000000 }, live: false, persisted: true },
  { header: { id: 's2', version: 3, isSeeded: false, cwd: '/root/nas/ArkTower', createdAt: 1750000900000 }, live: true, persisted: true },
  { header: { id: 's3', version: 3, isSeeded: true, cwd: '/root/nas/ArkTower', createdAt: 1750000800000 }, live: false, persisted: true },
];

/** 同上，但两个都不 live 也不 seeded：给「缓存条目边界」这类用例。 */
const quietSessions = [
  { header: { id: 's1', version: 3, isSeeded: false, cwd: '/root/nas/ArkTower', createdAt: 1750000000000 }, live: false, persisted: true },
  { header: { id: 's2', version: 3, isSeeded: false, cwd: '/root/nas/ArkTower', createdAt: 1750000900000 }, live: false, persisted: true },
];

// ──────────────────────────────────── 纯函数缝 ────────────────────────────────────

await test('纯函数：normalizeQuery 校验与裁剪', () => {
  assert.deepEqual(plugin.normalizeQuery('  a   b ').terms, ['a', 'b']);
  assert.equal(plugin.normalizeQuery('a').error, '检索词至少 2 个字符');
  assert.equal(plugin.normalizeQuery('a'.repeat(201)).error, '检索词过长（最多 200 个字符）');
  assert.equal(plugin.normalizeQuery('  ').error, '缺少检索词（q）');
  assert.equal(plugin.normalizeQuery(null).error, '缺少检索词（q）');
  // 长度按码点算：200 个 emoji 合法
  assert.equal(plugin.normalizeQuery('🙂'.repeat(200)).error, null);
  assert.equal(plugin.normalizeQuery('🙂'.repeat(201)).error, '检索词过长（最多 200 个字符）');
});

await test('纯函数：buildSnippet 定位与非 ASCII 大小写折叠', () => {
  const hit = plugin.buildSnippet('前面很长的一段话 '.repeat(30) + '龙门菜馆墙面修复完成', '墙面修复', 10);
  assert.ok(hit.highlightStart > 0, '命中区间应被定位');
  assert.equal(hit.snippet.slice(hit.highlightStart, hit.highlightEnd), '墙面修复');
  assert.equal(plugin.buildSnippet('abc', '不存在').highlightStart, -1);
  assert.equal(plugin.buildSnippet('', 'abc').snippet, '');
  // 'iu' 与 session-query 的 text 过滤同语义：西里尔字母大小写不敏感只有 u 标志下成立
  const cyrillic = plugin.buildSnippet('привет мир', 'ПРИВЕТ');
  assert.equal(cyrillic.highlightStart, 0);
  assert.equal(cyrillic.highlightEnd, 6);
  // 空白弹性：词间空白可跨行
  assert.ok(plugin.buildSnippet('龙门\n\n菜馆', '龙门 菜馆').highlightStart === 0);
});

await test('纯函数：sortSessionViews 全序（多个未知创建时间不产生 NaN）', () => {
  const rows = [
    { id: 'b', createdAt: null },
    { id: 'a', createdAt: null },
    { id: 'c', createdAt: 5 },
    { id: 'd', createdAt: 9 },
  ];
  const sorted = plugin.sortSessionViews(rows).map((row) => row.id);
  assert.deepEqual(sorted, ['d', 'c', 'a', 'b']);
  // 顺序结果稳定：再排一次不变
  assert.deepEqual(plugin.sortSessionViews(rows).map((row) => row.id), sorted);
});

await test('纯函数：groupByWorkspace 盖章 + 未归入桶', () => {
  const views = [
    { id: 's1', createdAt: 2, workspaceId: null, workspaceTitle: null, workspacePath: null },
    { id: 's2', createdAt: 1, workspaceId: null, workspaceTitle: null, workspacePath: null },
    { id: 's9', createdAt: 3, workspaceId: null, workspaceTitle: null, workspacePath: null },
  ];
  const grouped = plugin.groupByWorkspace(views, listWorkspaces);
  assert.equal(grouped.workspaces.length, 1);
  assert.equal(grouped.workspaces[0].id, 'ws-a');
  assert.equal(grouped.workspaces[0].count, 2);
  assert.deepEqual(grouped.workspaces[0].sessions.map((s) => s.id), ['s1', 's2']);
  assert.equal(grouped.workspaces[0].sessions[0].workspacePath, '/root/nas/ArkTower');
  assert.deepEqual(grouped.unassigned.map((s) => s.id), ['s9']);
  assert.equal(grouped.unassigned[0].workspaceId, null);
  assert.deepEqual(plugin.groupByWorkspace([], []).unassigned, []);
});

await test('纯函数：isSearchDisabled / isFullTextDisabled / normalizeConfig', () => {
  assert.equal(plugin.isSearchDisabled(disabledSearchError()), true);
  assert.equal(plugin.isSearchDisabled(Object.assign(new Error('x'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })), true);
  assert.equal(plugin.isSearchDisabled(new Error('boom')), false);
  assert.equal(plugin.isFullTextDisabled({ config: { openAt: 'never' } }), true);
  assert.equal(plugin.isFullTextDisabled({ config: { openAt: 'startup' } }), false);
  assert.equal(plugin.isFullTextDisabled({}), false);
  assert.equal(plugin.isFullTextDisabled(undefined), false);
  const config = plugin.normalizeConfig({ listCacheMs: -5, searchBudgetMs: 999999, searchConcurrency: 99, minQueryChars: 0, registerRetries: -1 });
  assert.equal(config.listCacheMs, 0);
  assert.equal(config.searchBudgetMs, 60000);
  assert.equal(config.searchConcurrency, 4);
  assert.equal(config.minQueryChars, 1);
  assert.equal(config.registerRetries, 0);
  assert.equal(plugin.normalizeConfig(null).searchEngine, 'auto');
  // 只有字面量是显式选择，其余（含历史拼写 'fts'）都归到 auto：
  // 「先试 FTS 再退化」本来就是 auto 的行为。
  assert.equal(plugin.normalizeConfig({ searchEngine: 'fts' }).searchEngine, 'auto');
  assert.equal(plugin.normalizeConfig({ searchEngine: 'literal' }).searchEngine, 'literal');
});

// ───────────────────────────────── 路由注册与回收 ─────────────────────────────────

await test('注册五条精确路由，dispose 后全部回收', () => {
  const server = makeWebServer();
  const app = mount({ webServer: server, services: { workspaceRegistry: makeRegistry(), sessionQuery: makeQuery() } });
  assert.deepEqual([...server.routes.keys()].sort(), [DELETE, LIST, RESTORE, SEARCH, STATUS].sort());
  assert.ok(server.routes.get(LIST).kind === 'exact');
  app.disposeAll();
  assert.equal(server.routes.size, 0, 'dispose 必须撤销全部路由');
});

await test('热重挂容错：旧实例仍占路径时不抛错，拆掉后自动占位', async () => {
  const server = makeWebServer();
  const config = { registerRetryMs: 20, registerRetries: 40 };
  const oldApp = mount({
    webServer: server,
    config,
    services: { workspaceRegistry: makeRegistry({ archived: ['s-old'] }), sessionQuery: makeQuery() },
  });
  assert.equal(server.routes.size, 5);
  const newApp = mount({
    webServer: server,
    config,
    services: { workspaceRegistry: makeRegistry({ archived: ['s-new'] }), sessionQuery: makeQuery() },
  });
  // loader 的顺序：先建新实例（此处全部撞 duplicate），之后才拆旧实例
  assert.equal(server.routes.size, 5, '新实例此时不该抢到路径');
  assert.equal(newApp.warnings.length, 0, '撞车是可恢复状态，不该立刻告警');
  oldApp.disposeAll();
  assert.equal(server.routes.size, 0);
  assert.ok(await waitFor(() => server.routes.size === 5), '旧实例拆除后新实例必须补位');
  const payload = await newApp.call(LIST);
  assert.deepEqual(payload.body.sessions.map((s) => s.id), ['s-new']);
  newApp.disposeAll();
});

await test('重试预算耗尽：只告警不抛错，其余路由照常注册', async () => {
  const server = makeWebServer();
  server.register({ kind: 'exact', path: LIST, handler: () => {} });
  const app = mount({
    webServer: server,
    config: { registerRetryMs: 10, registerRetries: 2 },
    services: { workspaceRegistry: makeRegistry(), sessionQuery: makeQuery() },
  });
  assert.ok(await waitFor(() => app.warnings.some((line) => line.includes('注册失败')), 2000));
  assert.ok(app.warnings.some((line) => line.includes('duplicate exact route')));
  assert.deepEqual([...server.routes.keys()].sort(), [DELETE, LIST, RESTORE, SEARCH, STATUS].sort());
  app.disposeAll();
});

// ─────────────────────────────────── /list 分组 ───────────────────────────────────

await test('GET /list：按工作区分组 + 平铺兼容字段', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2', 's3', 's4'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: listSessions, titles: { s1: '龙门菜馆墙面修复', s2: '第二个会话' } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const { status, body, headers } = await app.call(LIST);
  assert.equal(status, 200);
  assert.equal(headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(body.totalArchived, 4);
  assert.equal(body.totalListed, 4);
  assert.equal(body.workspaceSource, 'registry.list');
  assert.equal(body.workspaces.length, 2);
  assert.deepEqual(body.workspaces.map((w) => w.id), ['ws-a', 'ws-b'], '组间按组内最新会话倒序');
  assert.equal(body.workspaces[0].count, 2);
  assert.deepEqual(body.workspaces[0].sessions.map((s) => s.id), ['s2', 's1'], '组内创建时间倒序');
  assert.equal(body.workspaces[0].sessions[1].title, '龙门菜馆墙面修复');
  assert.equal(body.workspaces[0].sessions[1].workspaceTitle, 'ArkTower');
  assert.deepEqual(body.unassigned.map((s) => s.id), ['s4']);
  assert.equal(body.unassigned[0].workspacePath, null);
  assert.equal(body.unassigned[0].cwd, '/tmp/scratch');
  assert.equal(body.unassigned[0].persisted, false);
  // 兼容字段：平铺、按创建时间倒序、未知创建时间垫底
  assert.deepEqual(body.sessions.map((s) => s.id), ['s2', 's1', 's3', 's4']);
  assert.equal(body.capabilities.workspaceList, true);
  assert.equal(body.capabilities.filterEvents, true);
  app.disposeAll();
});

await test('GET /list：归档 id 一律 String 归一，且先信 getter 再退回 state', async () => {
  const registry = makeRegistry({ archived: ['s1', 7] });
  // 手上还捏着另一份（过期的）state：必须以后者之外的 getter 为准
  registry.state = Object.assign({}, registry.state, { archivedSessionIds: ['s9'] });
  const query = makeQuery({ sessions: listSessions });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });
  const { body } = await app.call(LIST);
  assert.deepEqual(body.sessions.map((s) => s.id), ['s1', '7'], '数字 id 归一；未知创建时间垫底');
  assert.ok(!body.sessions.some((s) => s.id === 's9'), 'state 里的旧账目不参与');
  app.disposeAll();
});

await test('GET /list：同一会话挂两个工作区时归第一个（先到先得）', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: [
    { id: 'ws-a', title: 'ArkTower', path: '/root/nas/ArkTower', sessionIds: ['s1'] },
    { id: 'ws-b', title: '后一个', path: '/root/code', sessionIds: ['s1'] },
  ] });
  const query = makeQuery({ sessions: listSessions, titles: { s1: '龙门菜馆墙面修复' } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });
  const { body } = await app.call(LIST);
  assert.deepEqual(body.workspaces.map((w) => w.id), ['ws-a']);
  assert.equal(body.workspaces[0].sessions[0].workspaceTitle, 'ArkTower');
  assert.equal(body.unassigned.length, 0);
  app.disposeAll();
});

await test('GET /status：配置回声是整数（clampInt 截断 + 上下限）', async () => {
  const app = mount({
    config: { snippetLimit: 3.7, searchBudgetMs: 99999, minQueryChars: 0.5, registerRetries: 1 },
    services: { workspaceRegistry: makeRegistry({ archived: [] }), sessionQuery: makeQuery() },
  });
  const { body } = await app.call(STATUS);
  assert.equal(body.config.snippetLimit, 3, '小数截断而不是四舍五入');
  assert.equal(body.config.searchBudgetMs, 60000, '上限钳制');
  assert.equal(body.config.minQueryChars, 1, '下限钳制');
  app.disposeAll();
});

await test('GET /search：字面量路径按归档顺序返回，读取失败只记 errors', async () => {
  const query = makeQuery({
    documents: {
      s1: [{ seq: 1, type: 'user/message', text: '龙门' }],
      s2: [{ seq: 1, type: 'assistant/message', text: '龙门' }],
    },
  });
  const innerFilter = query.filterEvents.bind(query);
  query.filterEvents = async (id, filters) => {
    if (id === 's3') throw new Error('日志读取失败');
    return innerFilter(id, filters);
  };
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s2', 's1', 's3'] }), sessionQuery: query } });
  const { body } = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(body.engine, 'literal');
  assert.deepEqual(body.results.map((r) => r.id), ['s2', 's1'], '命中顺序跟随归档集顺序（稳定可预期）');
  assert.deepEqual(body.errors.map((e) => e.id), ['s3']);
  assert.ok(String(body.errors[0].message).includes('日志读取失败'));
  assert.deepEqual([...body.scannedIds].sort(), ['s1', 's2', 's3'], '失败的会话也算扫过（否则续检会无限重试）');
  app.disposeAll();
});

await test('GET /search：searchConcurrency=2 时确实并行扫两个会话', async () => {
  const build = () => {
    const query = makeQuery({
      documents: { s1: [], s2: [] },
      perCallDelayMs: 40,
    });
    const inner = query.filterEvents.bind(query);
    const counter = { inFlight: 0, max: 0 };
    query.filterEvents = async (id, filters) => {
      counter.inFlight += 1;
      counter.max = Math.max(counter.max, counter.inFlight);
      try {
        return await inner(id, filters);
      } finally {
        counter.inFlight -= 1;
      }
    };
    return { query, counter };
  };
  const serial = build();
  const appSerial = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'] }), sessionQuery: serial.query } });
  await appSerial.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(serial.counter.max, 1, '默认串行：一次只读一个会话的完整日志');
  appSerial.disposeAll();
  const parallel = build();
  const appParallel = mount({
    config: { searchConcurrency: 2 },
    services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'] }), sessionQuery: parallel.query },
  });
  await appParallel.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(parallel.counter.max, 2, '显式调大并发后两个会话同时在扫');
  appParallel.disposeAll();
});

await test('GET /list：TTL 缓存 / ?fresh=1 / 恢复后失效', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: listSessions });
  const app = mount({ config: { listCacheMs: 5000 }, services: { workspaceRegistry: registry, sessionQuery: query } });

  await app.call(LIST);
  const afterFirst = query.stats.listSessions;
  await app.call(LIST);
  assert.equal(query.stats.listSessions, afterFirst, 'TTL 内不应重复读元数据');
  await app.call(LIST, { url: LIST + '?fresh=1' });
  assert.equal(query.stats.listSessions, afterFirst + 1, '?fresh=1 必须绕过缓存');
  app.disposeAll();

  // TTL 计时必须从「读完」开始：读一次要 250ms、TTL 只有 100ms 时，
  // 紧接着的第二次请求仍应命中缓存（时间戳若取在异步读之前就会误判过期）。
  const slowQuery = makeQuery({ sessions: listSessions });
  const innerList = slowQuery.listSessions.bind(slowQuery);
  slowQuery.listSessions = async () => { await sleep(250); return innerList(); };
  const slow = mount({ config: { listCacheMs: 100 }, services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: slowQuery } });
  await slow.call(LIST);
  const afterSlow = slowQuery.stats.listSessions;
  await slow.call(LIST);
  assert.equal(slowQuery.stats.listSessions, afterSlow, '耗时读之后紧接着的请求仍算缓存命中');
  slow.disposeAll();

  const app2 = mount({ config: { listCacheMs: 5000 }, services: { workspaceRegistry: registry, sessionQuery: query } });
  await app2.call(LIST);
  await app2.call(RESTORE, { method: 'POST', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, body: JSON.stringify({ sessionId: 's1' }) });
  const listed = await app2.call(LIST);
  assert.equal(listed.body.totalArchived, 0, '恢复后缓存必须失效');
  app2.disposeAll();
});

await test('GET /list：没有 registry 时全部落 unassigned，不抛错', async () => {
  const app = mount({ services: { sessionQuery: makeQuery({ sessions: listSessions }) } });
  const { status, body } = await app.call(LIST);
  assert.equal(status, 500, '缺少归档集权威时应报错而不是假装空列表');
  assert.ok(String(body.error).includes('workspaceRegistry'));
  app.disposeAll();
});

await test('GET /list：registry 在但 list() 抛错 → 降级为空分组并告警', async () => {
  const registry = makeRegistry({ archived: ['s1'] });
  registry.list = async () => { throw new Error('registry broken'); };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery({ sessions: listSessions }) } });
  const { status, body } = await app.call(LIST);
  assert.equal(status, 200);
  assert.equal(body.workspaceSource, 'list-error');
  assert.equal(body.workspaces.length, 0);
  assert.deepEqual(body.unassigned.map((s) => s.id), ['s1']);
  assert.ok(app.warnings.some((line) => line.includes('workspaceRegistry.list() 失败')));
  app.disposeAll();
});

await test('GET /list：非 GET/HEAD 一律 405', async () => {
  const app = mount({ services: { workspaceRegistry: makeRegistry(), sessionQuery: makeQuery() } });
  const { status } = await app.call(LIST, { method: 'POST' });
  assert.equal(status, 405);
  app.disposeAll();
});

await test('GET /list：标题批量失败退回逐条读，列表仍然完整', async () => {
  const query = makeQuery({ sessions: listSessions, titles: { s1: '兜底标题' }, titleFailure: true });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces }), sessionQuery: query } });
  const { body } = await app.call(LIST);
  assert.equal(query.stats.titleBatch, 1);
  assert.equal(query.stats.readTitle, 2, '批量失败后逐条兜底');
  assert.equal(body.sessions.find((s) => s.id === 's1').title, '兜底标题');
  assert.ok(app.warnings.some((line) => line.includes('readTitleSnapshots')));
  app.disposeAll();
});

// ────────────────────────────────── /search 检索 ──────────────────────────────────

await test('GET /search：参数校验与越权防护', async () => {
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: makeQuery() } });
  assert.equal((await app.call(SEARCH, { url: SEARCH })).status, 400);
  assert.equal((await app.call(SEARCH, { url: SEARCH + '?q=a' })).body.error, '检索词至少 2 个字符');
  assert.equal((await app.call(SEARCH, { url: SEARCH + '?q=' + 'x'.repeat(201) })).status, 400);
  const crossOrigin = await app.call(SEARCH, { url: SEARCH + '?q=abc', headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error, 'cross-origin request rejected');
  assert.equal((await app.call(SEARCH, { method: 'POST', url: SEARCH + '?q=abc' })).status, 405);
  app.disposeAll();
});

await test('GET /search：openAt=never 时同步探测，根本不调用 searchSessions', async () => {
  const query = makeQuery({
    openAt: 'never',
    documents: { s1: [{ seq: 7, type: 'user/message', time: 1, text: '请把龙门菜馆的墙面修复一下' }] },
  });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: query } });
  const { status, body } = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('墙面修复') });
  assert.equal(status, 200);
  assert.equal(query.stats.searchSessions, 0, '同步探测命中后不得再撞后端异常');
  assert.equal(body.engine, 'literal');
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, 's1');
  assert.equal(body.results[0].matchCount, 1);
  assert.equal(body.results[0].matches[0].type, 'user/message');
  assert.equal(body.results[0].matches[0].snippet.slice(body.results[0].matches[0].highlightStart, body.results[0].matches[0].highlightEnd), '墙面修复');
  const status2 = await app.call(STATUS);
  assert.equal(status2.body.search.engine, 'literal');
  assert.ok(String(status2.body.search.reason).includes('openAt'));
  app.disposeAll();
});

await test('GET /search：检索面是一条 type 子句，includeTools 决定是否并上工具面', async () => {
  const documents = {
    s1: [
      { seq: 1, type: 'user/message', text: 'alpha 墙面' },
      { seq: 2, type: 'tool/result', text: 'alpha 工具输出' },
      { seq: 3, type: 'tool/call', text: 'alpha 工具参数' },
      { seq: 4, type: 'system/message', text: 'alpha 系统注入' },
      { seq: 5, type: 'todo/write', text: 'alpha 待办' },
    ],
  };
  const query = makeQuery({ documents });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: query } });

  const plain = await app.call(SEARCH, { url: SEARCH + '?q=alpha' });
  const plainTypes = query.lastFilters.filter((f) => f.kind === 'type');
  assert.equal(plainTypes.length, 1, '同 kind 子句是 AND 关系，必须合成一条');
  assert.deepEqual(plainTypes[0].values, ['user/message', 'assistant/message']);
  assert.deepEqual(plain.body.results[0].matches.map((m) => m.type), ['user/message']);

  const withTools = await app.call(SEARCH, { url: SEARCH + '?q=alpha&includeTools=1' });
  const toolTypes = query.lastFilters.filter((f) => f.kind === 'type');
  assert.equal(toolTypes.length, 1);
  assert.deepEqual(toolTypes[0].values, ['user/message', 'assistant/message', 'tool/result', 'tool/call']);
  assert.deepEqual(withTools.body.results[0].matches.map((m) => m.type), ['user/message', 'tool/result', 'tool/call']);
  assert.equal(withTools.body.includeTools, true);
  app.disposeAll();
});

await test('GET /search：片段数按 limit 截断，matchCount 报真实命中数', async () => {
  const documents = {
    s1: Array.from({ length: 6 }, (_, index) => ({ seq: index, type: 'assistant/message', text: `第 ${index} 段提到龙门` })),
  };
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: makeQuery({ documents }) } });
  const { body } = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') + '&limit=2' });
  assert.equal(body.results[0].matchCount, 6);
  assert.equal(body.results[0].matches.length, 2);
  assert.equal(body.snippetLimit, undefined, 'limit 不回声进响应体');
  app.disposeAll();
});

await test('GET /search：FTS 快路径（后端可用时直接返回索引命中）', async () => {
  const query = makeQuery({
    openAt: 'startup',
    searchSessions: async () => ({
      items: [
        { header: { id: 's1' }, live: false, persisted: true, bestMatch: { sessionId: 's1', type: 'assistant/message', seq: 3, time: 42, surface: 'current', snippet: '龙门 墙面 修复' } },
        { header: { id: 's2' }, live: false, persisted: true, bestMatch: { sessionId: 's2', type: 'user/message', snippet: '另一个 龙门' } },
      ],
    }),
  });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'] }), sessionQuery: query } });
  const { body } = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(body.engine, 'fts');
  assert.equal(query.stats.filterEvents, 0, 'FTS 命中后不得再逐条扫描');
  assert.deepEqual(body.results.map((r) => r.id), ['s1', 's2']);
  assert.equal(body.results[0].matchCount, null);
  assert.equal(body.results[0].matches[0].snippet.includes('龙门'), true);
  assert.deepEqual(query.lastSearchRequest.sessionFilters, [{ kind: 'id', values: ['s1', 's2'] }]);
  assert.deepEqual(query.lastSearchRequest.eventFilters, [{ kind: 'type', values: ['user/message', 'assistant/message'] }],
    'FTS 路径与字面量路径同一检索面（metadata 过滤器接受 type，不接受 text）');
  assert.equal(body.truncated, false);
  assert.equal(body.nextCursor, null);
  app.disposeAll();
});

await test('GET /search：FTS 分页（nextCursor → truncated，cursor 续检且换检索面）', async () => {
  const seen = [];
  const query = makeQuery({
    openAt: 'startup',
    searchSessions: async (request) => {
      seen.push(request.cursor);
      if (request.cursor === undefined) {
        return {
          items: [{ header: { id: 's1' }, bestMatch: { sessionId: 's1', snippet: '龙门' } }],
          nextCursor: 'CUR1',
        };
      }
      return {
        items: [{ header: { id: 's2' }, bestMatch: { sessionId: 's2', snippet: '龙门' } }],
      };
    },
  });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'] }), sessionQuery: query } });
  const first = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(first.body.engine, 'fts');
  assert.equal(first.body.truncated, true, '有 nextCursor 就是还有下一页');
  assert.equal(first.body.nextCursor, 'CUR1');
  const second = await app.call(SEARCH, {
    url: SEARCH + '?q=' + encodeURIComponent('龙门') + '&includeTools=1&cursor=CUR1',
  });
  assert.equal(second.body.truncated, false);
  assert.equal(second.body.nextCursor, null);
  assert.deepEqual(second.body.results.map((r) => r.id), ['s2']);
  assert.deepEqual(seen, [undefined, 'CUR1'], '续检把游标原样交给后端');
  assert.deepEqual(query.lastSearchRequest.eventFilters, [{
    kind: 'type',
    values: ['user/message', 'assistant/message', 'tool/result', 'tool/call'],
  }], 'includeTools=1 的并集同样作用于 FTS 路径');
  app.disposeAll();
});

await test('GET /search：FTS 抛 SESSION_QUERY_SEARCH_DISABLED → 结论固化并退化扫描', async () => {
  const query = makeQuery({
    openAt: 'startup',
    documents: { s1: [{ seq: 1, type: 'user/message', text: '龙门' }] },
  });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: query } });
  const first = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(first.body.engine, 'literal');
  assert.equal(first.body.results.length, 1);
  assert.equal(query.stats.searchSessions, 1);
  assert.ok(String(first.body.engineReason).includes('未启用全文索引'), '退化原因随响应回报');
  const second = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(second.body.engine, 'literal');
  assert.equal(query.stats.searchSessions, 1, '结论固化后不再试探');
  app.disposeAll();
});

await test('GET /search：FTS 之外的异常只告警并退化，不固化结论', async () => {
  const query = makeQuery({ openAt: 'startup' });
  query.searchSessions = async () => { query.stats.searchSessions += 1; throw new Error('index corrupt'); };
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: query } });
  const first = await app.call(SEARCH, { url: SEARCH + '?q=abc' });
  assert.equal(first.body.engine, 'literal');
  assert.ok(app.warnings.some((line) => line.includes('searchSessions 失败')));
  await app.call(SEARCH, { url: SEARCH + '?q=abc' });
  assert.equal(query.stats.searchSessions, 2, '非稳定失败每次仍会试探');
  app.disposeAll();
});

await test('GET /search：无归档会话时 engine=empty，不碰后端', async () => {
  const query = makeQuery({ openAt: 'startup' });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: [] }), sessionQuery: query } });
  const { body } = await app.call(SEARCH, { url: SEARCH + '?q=abc' });
  assert.equal(body.engine, 'empty');
  assert.equal(query.stats.searchSessions, 0);
  assert.equal(query.stats.filterEvents, 0);
  app.disposeAll();
});

await test('GET /search：时间预算用尽 → truncated + pendingIds，skip 续检只扫剩下的', async () => {
  const documents = Object.fromEntries(['s1', 's2', 's3', 's4'].map((id) => [id, [{ seq: 1, type: 'user/message', text: '龙门 ' + id }]]));
  const query = makeQuery({ documents, perCallDelayMs: 350 });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2', 's3', 's4'] }), sessionQuery: query } });
  const first = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') + '&budgetMs=1000' }, 30000);
  assert.equal(first.body.truncated, true);
  assert.ok(first.body.scannedIds.length >= 1 && first.body.scannedIds.length < 4, `已扫 ${first.body.scannedIds.length}`);
  assert.equal(first.body.pendingIds.length, 4 - first.body.scannedIds.length);
  assert.ok(first.body.elapsedMs >= 1000);

  // 续检语义：skip = 已经扫过的会话（浏览器「继续检索」按钮就是这么传的）
  const rest = first.body.scannedIds.join(',');
  const second = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') + '&budgetMs=60000&skip=' + rest });
  assert.equal(second.body.truncated, false);
  assert.deepEqual([...second.body.scannedIds].sort(), [...first.body.pendingIds].sort());
  assert.equal(query.stats.filterEvents, 4, 'skip 掉的会话不得重扫');
  app.disposeAll();
});

await test('GET /search：浏览器断开后停止扫描', async () => {
  const documents = Object.fromEntries(['s1', 's2', 's3', 's4'].map((id) => [id, [{ seq: 1, type: 'user/message', text: '龙门 ' + id }]]));
  const query = makeQuery({ documents, perCallDelayMs: 200 });
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2', 's3', 's4'] }), sessionQuery: query } });
  const route = app.webServer.routes.get(SEARCH);
  const res = makeRes();
  route.handler(makeReq({ url: SEARCH + '?q=' + encodeURIComponent('龙门') }), res);
  await sleep(60);
  res.emit('close');
  await waitFor(() => res.finished, 5000);
  assert.equal(res.finished, true);
  assert.ok(res.payload().scannedIds.length < 4, '断开后不再继续扫描');
  app.disposeAll();
});

// ────────────────────────────────── /restore 恢复 ──────────────────────────────────

await test('POST /restore：移出归档集并回报结果', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery({ sessions: listSessions }) } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  const ok = await app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restored, true);
  assert.deepEqual(ok.body.archivedSessionIds, ['s2']);
  assert.equal(registry.state.initialized, true, '写回必须保留其它 global 键');
  assert.deepEqual(registry.state.workspaceIds, ['ws-a', 'ws-b']);

  const again = await app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) });
  assert.equal(again.body.restored, false);
  assert.deepEqual(again.body.archivedSessionIds, ['s2']);
  app.disposeAll();
});

await test('POST /restore：并发写入串行化，互不覆盖', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2', 's3'], writeDelayMs: 20 });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  const [a, b] = await Promise.all([
    app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) }),
    app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's2' }) }),
  ]);
  assert.equal(a.body.restored, true);
  assert.equal(b.body.restored, true);
  assert.deepEqual(registry.state.archivedSessionIds, ['s3'], '两次读改写不得互相覆盖');
  app.disposeAll();
});

await test('POST /restore：错误入参、错误方法、跨站请求', async () => {
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: makeQuery() } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  assert.equal((await app.call(RESTORE, { method: 'GET' })).status, 405);
  assert.equal((await app.call(RESTORE, { method: 'POST', headers: { origin: 'http://evil.test', host: '127.0.0.1:3080' } })).status, 403);
  // Origin: null（沙箱 iframe / data: 页面）与 sec-fetch-site: cross-site 都必须拒
  assert.equal((await app.call(RESTORE, { method: 'POST', headers: { origin: 'null', host: '127.0.0.1:3080' } })).status, 403);
  assert.equal((await app.call(RESTORE, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080' } })).status, 403);
  assert.equal((await app.call(SEARCH, { url: SEARCH + '?q=ab', headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080' } })).status, 403);
  assert.equal((await app.call(RESTORE, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({}) })).status, 400);
  assert.equal((await app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 7 }) })).status, 400);
  app.disposeAll();
});

await test('POST /restore：body 按字节限长（413），跨分片的多字节字符不坏', async () => {
  const app = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'] }), sessionQuery: makeQuery() } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  // 超过 64 KiB：必须回 413（而不是把 socket 掐掉，让浏览器只看到连接重置）
  const huge = JSON.stringify({ sessionId: 's1', pad: 'x'.repeat(70000) });
  const overflow = await app.call(RESTORE, { method: 'POST', headers, body: huge });
  assert.equal(overflow.status, 413);
  assert.ok(String(overflow.body.error).includes('64 KiB'));
  // 3 字节汉字正好被分片切开：按字节拼接后再解码才不坏
  const raw = Buffer.from(JSON.stringify({ sessionId: '会话测试' }), 'utf8');
  const at = raw.indexOf(Buffer.from('会', 'utf8')) + 1;
  const split = await app.call(RESTORE, { method: 'POST', headers, chunks: [raw.subarray(0, at), raw.subarray(at)] });
  assert.equal(split.status, 200, '多字节字符跨分片也要能解析');
  assert.equal(split.body.restored, false, '该 id 不在归档集');
  // 字符串分片（中间层换了分片类型）也要能读
  const asString = await app.call(RESTORE, { method: 'POST', headers, chunks: [JSON.stringify({ sessionId: 's1' })] });
  assert.equal(asString.status, 200);
  assert.equal(asString.body.restored, true);
  app.disposeAll();
});

await test('POST /restore：registry 无 setState 时报错而不是静默成功', async () => {
  const registry = makeRegistry({ archived: ['s1'] });
  delete registry.setState;
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  const { status, body } = await app.call(RESTORE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) });
  assert.equal(status, 500);
  assert.ok(String(body.error).includes('setState'));
  app.disposeAll();
});

// ─────────────────────────────────── /status 自检 ───────────────────────────────────

await test('GET /search：命中顺序跟随归档集（并发扫描下也不随完成先后抖动）', async () => {
  // s1 慢、s2 快：并发扫两个会话时完成顺序必然是 s2 → s1，结果仍须按归档顺序排。
  const query = makeQuery({ documents: { s1: [{ seq: 1, type: 'user/message', text: '龙门' }], s2: [{ seq: 1, type: 'assistant/message', text: '龙门' }] } });
  const inner = query.filterEvents.bind(query);
  query.filterEvents = async (id, filters) => {
    await sleep(id === 's1' ? 120 : 5);
    return inner(id, filters);
  };
  const app = mount({
    config: { searchConcurrency: 2 },
    services: { workspaceRegistry: makeRegistry({ archived: ['s1', 's2'] }), sessionQuery: query },
  });
  const { body } = await app.call(SEARCH, { url: SEARCH + '?q=' + encodeURIComponent('龙门') });
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results.map((r) => r.id), ['s1', 's2'], '并发完成顺序不得泄漏到结果顺序');
  app.disposeAll();
});

await test('GET /status：能力探测 + 配置回声，且不改任何状态', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ openAt: 'never' });
  const app = mount({ config: { listCacheMs: 1234, searchConcurrency: 2 }, services: { workspaceRegistry: registry, sessionQuery: query } });
  const { status, body } = await app.call(STATUS);
  assert.equal(status, 200);
  assert.equal(body.plugin, 'dsh-archived-sessions');
  assert.equal(body.version, 6);
  assert.deepEqual(body.routes, [LIST, SEARCH, RESTORE, DELETE, STATUS]);
  assert.equal(body.archivedCount, 2);
  assert.equal(body.archivedError, null);
  assert.equal(body.workspaceCount, 2);
  assert.equal(body.workspaceSource, 'registry.list');
  assert.equal(body.assignedSessions, 3);
  assert.equal(body.capabilities.registrySetState, true);
  assert.equal(body.capabilities.workspaceList, true);
  assert.equal(body.capabilities.searchSessions, true);
  assert.equal(body.capabilities.filterEvents, true);
  assert.equal(body.config.listCacheMs, 1234);
  assert.equal(body.config.searchConcurrency, 2);
  assert.deepEqual(registry.writes, [], 'status 是只读的');
  assert.ok(body.memory === null || typeof body.memory.rssMb === 'number');
  app.disposeAll();
});

await test('GET /status：服务缺失时能力位为 false 且不抛错', async () => {
  const app = mount({ services: {} });
  const { status, body } = await app.call(STATUS);
  assert.equal(status, 200);
  assert.equal(body.capabilities.sessionQuery, false);
  assert.equal(body.capabilities.registrySetState, false);
  assert.equal(body.archivedCount, null);
  assert.ok(String(body.archivedError).includes('workspaceRegistry'));
  app.disposeAll();
});

await test('GET /status：非 GET/HEAD 405', async () => {
  const app = mount({ services: { workspaceRegistry: makeRegistry(), sessionQuery: makeQuery() } });
  assert.equal((await app.call(STATUS, { method: 'POST' })).status, 405);
  app.disposeAll();
});

// ─────────────── v3：投影缓存标题 / 成员感知缓存 / 在飞合并 / 取消传播 ───────────────

await test('v3 GET /list：标题走投影缓存（零 I/O），不再折叠日志', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '日志里的标题' } });
  const cache = makeProjectionCache({ entries: { s1: { title: '缓存标题', lastPromptAt: 1750000999000 } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { status, body } = await app.call(LIST);
  assert.equal(status, 200);
  assert.deepEqual(body.titleSources, { cache: 1, logFold: 0, missing: 0 });
  const row = body.sessions.find((s) => s.id === 's1');
  assert.equal(row.title, '缓存标题');
  assert.equal(row.titleUpdatedAt, 1750000999000, '活动时间取 max(createdAt, lastPromptAt)');
  assert.equal(query.stats.titleBatch, 0, '命中投影缓存就不该再读日志');
  assert.equal(query.stats.readTitle, 0);
  assert.deepEqual(cache.stats.calls, ['s1@undefined'], '出厂同款调用：cachedSnapshot(header) 不带第二个参数');
  app.disposeAll();
});

await test('v3 GET /list：未命中的 id 才回退日志折叠，且只传未命中的 id', async () => {
  const registry = makeRegistry({ archived: ['s1', 's3'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '日志标题一', s3: '日志标题三' } });
  const cache = makeProjectionCache({ entries: { s1: { title: '缓存标题一' } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  // s3 是 seeded 会话：不查投影缓存（inherited cut 不在列表 header 里），走日志折叠
  assert.deepEqual(body.titleSources, { cache: 1, logFold: 1, missing: 0 });
  assert.deepEqual(query.stats.lastTitleIds, ['s3']);
  assert.equal(body.sessions.find((s) => s.id === 's1').title, '缓存标题一');
  assert.equal(body.sessions.find((s) => s.id === 's3').title, '日志标题三');
  assert.deepEqual(cache.stats.calls, ['s1@undefined'], 'seeded 会话不进缓存查询');
  app.disposeAll();
});

await test('v3 GET /list：live 会话不走向量缓存（内存态更新更快）', async () => {
  const registry = makeRegistry({ archived: ['s2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s2: '实时标题' } });
  const cache = makeProjectionCache({ entries: { s2: { title: '陈旧缓存标题' } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  assert.equal(body.sessions.find((s) => s.id === 's2').title, '实时标题');
  assert.deepEqual(body.titleSources, { cache: 0, logFold: 1, missing: 0 });
  assert.equal(cache.stats.cachedSnapshot, 0, 'live 会话不该被查缓存');
  assert.equal(body.capabilities.projectionCache, true);
  app.disposeAll();
});

await test('v3 GET /list：投影缓存抛错 → 整份回退日志折叠，每个 pass 只告警一次', async () => {
  const registry = makeRegistry({ archived: ['s1', 's3'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: 'A', s3: 'B' } });
  const cache = makeProjectionCache({ throwAlways: true });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { status, body } = await app.call(LIST);
  assert.equal(status, 200, '缓存坏了也不能让列表失败');
  assert.deepEqual(body.titleSources, { cache: 0, logFold: 2, missing: 0 });
  assert.equal(app.warnings.filter((line) => line.includes('sessionProjectionCache')).length, 1);
  app.disposeAll();
});

await test('v3 GET /list：只有前身标题时也命中缓存（updatedAt 回落 createdAt）', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '日志标题' } });
  const cache = makeProjectionCache({ entries: { s1: { title: '前身标题', predecessor: true } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  const row = body.sessions.find((s) => s.id === 's1');
  assert.equal(row.title, '前身标题');
  assert.equal(row.titleUpdatedAt, 1750000000000, '没有 lastPromptAt 时回落 createdAt');
  assert.equal(cache.stats.predecessor, 1);
  assert.equal(query.stats.titleBatch, 0);
  assert.deepEqual(body.titleSources, { cache: 1, logFold: 0, missing: 0 });
  app.disposeAll();
});

await test('v3 GET /list：缓存条目边界——空标题算未命中、lastPromptAt 早于 createdAt 取 createdAt', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '日志标题一', s2: '日志标题二' } });
  const cache = makeProjectionCache({
    entries: {
      s1: { title: '' },                            // 空标题＝没有标题 → 回退日志折叠
      s2: { title: '缓存标题二', lastPromptAt: 1 },  // 早于 createdAt（异常但可能出现）
    },
  });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  assert.equal(body.sessions.find((s) => s.id === 's1').title, '日志标题一', '空标题不得当成有效标题');
  assert.equal(body.sessions.find((s) => s.id === 's2').title, '缓存标题二');
  assert.equal(body.sessions.find((s) => s.id === 's2').titleUpdatedAt, 1750000900000, '活动时间不得小于 createdAt');
  assert.deepEqual(body.titleSources, { cache: 1, logFold: 1, missing: 0 });
  app.disposeAll();
});

await test('v3 GET /list：缓存成员感知——归档集变化立即失效，成员不变才吃 TTL', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '一', s3: '三' } });
  const app = mount({ config: { listCacheMs: 60000 }, services: { workspaceRegistry: registry, sessionQuery: query } });

  const first = await app.call(LIST);
  assert.deepEqual(first.body.sessions.map((s) => s.id), ['s1']);
  // 模拟「又归档了一个会话」：注册表内存态变化（不经过本插件的恢复路径）
  registry.archivedSessionIds = ['s1', 's3'];
  registry.state.archivedSessionIds = ['s1', 's3'];
  const second = await app.call(LIST);
  assert.deepEqual(second.body.sessions.map((s) => s.id), ['s3', 's1'], 'TTL 内也要看到新归档的会话');
  assert.equal(query.stats.listSessions, 2, '成员变化必须重读，而不是回旧清单');
  const third = await app.call(LIST);
  assert.equal(query.stats.listSessions, 2, '成员不变 + TTL 内 → 命中缓存');
  assert.deepEqual(third.body.sessions.map((s) => s.id), ['s3', 's1']);
  // 默认 TTL 已放宽到 60 s（v3），配置可覆盖
  assert.equal(plugin.normalizeConfig({}).listCacheMs, 60000);
  assert.equal(plugin.normalizeConfig({ listCacheMs: 1234 }).listCacheMs, 1234);
  app.disposeAll();
});

await test('v3 GET /list：在飞合并——并发请求共用一次解码，fresh 通道各自合并', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '标题' }, listDelayMs: 150 });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const pendingA = app.call(LIST);
  const pendingB = app.call(LIST);
  const during = await app.call(STATUS);
  assert.equal(during.body.inflightPasses.length, 1, '在飞时 /status 能看到这一份');
  assert.ok(during.body.inflightPasses[0].startsWith('cached|'), '在飞键带通道前缀：' + during.body.inflightPasses[0]);
  const [a, b] = await Promise.all([pendingA, pendingB]);
  assert.equal(query.stats.listSessions, 1, '并发请求必须共用同一份解码');
  assert.equal(a.body.generatedAt, b.body.generatedAt, '两边的响应应来自同一份结果');
  assert.deepEqual(a.body.sessions.map((s) => s.id), ['s1']);

  const [c, d] = await Promise.all([
    app.call(LIST, { url: LIST + '?fresh=1' }),
    app.call(LIST, { url: LIST + '?fresh=1' }),
  ]);
  assert.equal(query.stats.listSessions, 2, '?fresh=1 是另一条通道，自己合并成一份');
  assert.equal(c.body.generatedAt, d.body.generatedAt);

  // 两条通道绝不合流：cached 在飞时来的 ?fresh=1 必须自己跑一份（否则 fresh 会
  // 拿到没绕过缓存的结果），fresh 在飞时来的 cached 也要走自己的判定。
  const other = mount({ services: { workspaceRegistry: makeRegistry({ archived: ['s1'], workspaces: listWorkspaces }), sessionQuery: query } });
  const pendingCached = other.call(LIST);
  const pendingFresh = other.call(LIST, { url: LIST + '?fresh=1' });
  await Promise.all([pendingCached, pendingFresh]);
  assert.equal(query.stats.listSessions, 4, 'cached 与 fresh 各自一份，互不合并');
  other.disposeAll();

  // 跑完后不留残余，下一次请求重新开始
  const status = await app.call(STATUS);
  assert.deepEqual(status.body.inflightPasses, []);
  await app.call(LIST, { url: LIST + '?fresh=1' });
  assert.equal(query.stats.listSessions, 5);
  app.disposeAll();
});

await test('v3 GET /list：调用方断开 → 停止等待并取消无人要的共享解码，且不写缓存', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '标题' } });
  const signals = [];
  query.listSessions = (signal) => new Promise((resolve, reject) => {
    signals.push(signal);
    const timer = setTimeout(() => resolve(cacheReadySessions), 200);
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }
  });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const res = rawCall(app, LIST);
  await waitFor(() => signals.length === 1);
  assert.equal(typeof signals[0].addEventListener, 'function', 'signal 应透传到 listSessions');
  res.emit('close'); // 浏览器断开（切走设置页 / 刷新 / 关标签）
  await waitFor(() => signals[0].aborted === true);
  assert.equal(signals[0].aborted, true, '没有别的等待者时共享解码应被取消');
  assert.equal(res.finished, false, '客户端已经走了，不必回包');
  // 取消要一路上抛：不能吞掉取消再拿着空 meta 继续读标题（半份清单更不能进缓存）
  assert.equal(query.stats.titleBatch, 0, '取消后不得继续读标题');
  assert.equal(query.stats.readTitle, 0);

  // 取消的那一份不写缓存：下一个请求必须重新读，并且能正常拿到结果
  const after = await app.call(LIST);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.sessions.map((s) => s.id), ['s1']);
  assert.equal(signals.length, 2, '取消后新请求要重新开始一份');
  const status = await app.call(STATUS);
  assert.deepEqual(status.body.inflightPasses, [], '取消后不留残余 pass');
  app.disposeAll();
});

await test('v3 GET /list：有别人还在等时，某个调用方断开不得取消共享解码', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '标题' }, listDelayMs: 60 });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const res = rawCall(app, LIST);              // 等待者 A：马上断开
  const waiting = app.call(LIST);              // 等待者 B：继续等
  res.emit('close');
  const body = (await waiting).body;
  assert.deepEqual(body.sessions.map((s) => s.id), ['s1'], 'B 仍应拿到结果');
  assert.equal(query.stats.listSessions, 1);
  assert.equal(query.stats.listSignals[0].aborted, false, '还有人等 → 共享解码不得取消');
  app.disposeAll();
});

await test('v3 GET /list：signal 透传，且批量成功时不再逐条重复解码', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '一' } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  await app.call(LIST);
  assert.equal(typeof query.stats.titleBatchSignals[0]?.addEventListener, 'function', 'readTitleSnapshots 应收到 AbortSignal');
  assert.equal(query.stats.titleBatchSignals[0].aborted, false);
  // 批量成功、s2 只是没有 title 事件（rejected）→ 不得逐条再整份解码一遍（v2 也不）
  assert.equal(query.stats.readTitle, 0, '批量成功就不要逐条回退：每次 readTitle 都是一次整份日志解码');
  assert.deepEqual((await app.call(LIST, { url: LIST + '?fresh=1' })).body.titleSources, { cache: 0, logFold: 1, missing: 1 });
  app.disposeAll();
});

await test('v3 GET /list：批量不可用 / 整批抛错时才逐条回退，且逐条也收到 signal', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const withBatch = makeQuery({ sessions: quietSessions, titles: { s1: '一' }, titleFailure: true });
  const appA = mount({ services: { workspaceRegistry: registry, sessionQuery: withBatch } });
  const a = await appA.call(LIST);
  assert.equal(withBatch.stats.titleBatch, 1);
  assert.equal(withBatch.stats.readTitle, 2, '整批抛错 → 逐条兜底');
  assert.equal(typeof withBatch.stats.readTitleSignals[0]?.addEventListener, 'function', '逐条也要收到 AbortSignal');
  assert.deepEqual(a.body.titleSources, { cache: 0, logFold: 1, missing: 1 });
  appA.disposeAll();

  const noBatch = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
  delete noBatch.readTitleSnapshots;
  const appB = mount({ services: { workspaceRegistry: registry, sessionQuery: noBatch } });
  const b = await appB.call(LIST);
  assert.equal(noBatch.stats.readTitle, 2, '批量 API 不存在 → 逐条');
  assert.deepEqual(b.body.titleSources, { cache: 0, logFold: 1, missing: 1 });
  appB.disposeAll();
});

await test('v3 GET /status：暴露投影缓存能力位与列表缓存/在飞诊断', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '标题' } });
  const cache = makeProjectionCache({ entries: { s1: { title: '缓存标题' } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const before = await app.call(STATUS);
  assert.equal(before.body.listCache, null, '还没跑过 /list');
  assert.deepEqual(before.body.inflightPasses, []);
  await app.call(LIST);
  const after = await app.call(STATUS);
  assert.equal(after.body.version, 6);
  assert.equal(after.body.capabilities.projectionCache, true);
  assert.equal(after.body.listCache.ttlMs, 60000);
  assert.equal(after.body.listCache.listed, 1);
  assert.ok(after.body.listCache.ageMs >= 0);
  await sleep(20);
  const later = await app.call(STATUS);
  assert.ok(later.body.listCache.ageMs > after.body.listCache.ageMs, 'ageMs 必须真的在走');
  app.disposeAll();
});

await test('v3 GET /list：没有投影缓存服务时行为与 v2 一致（纯日志折叠）', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: cacheReadySessions, titles: { s1: '一', s2: '二' } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const { body } = await app.call(LIST);
  assert.equal(body.capabilities.projectionCache, false);
  assert.deepEqual(body.titleSources, { cache: 0, logFold: 2, missing: 0 });
  assert.equal(query.stats.titleBatch, 1);
  app.disposeAll();
});

await test('v3 GET /list：在飞键含归档集成员——restore 之后的请求不得接到变更前的那一份', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一', s2: '二' }, listDelayMs: 120 });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const stale = app.call(LIST, { url: LIST + '?fresh=1' }); // 变更前起跑的那一份
  await waitFor(() => query.stats.listSessions === 1);
  registry.archivedSessionIds = ['s1'];                    // 模拟 restore('s2') 写入成功
  registry.state.archivedSessionIds = ['s1'];
  const fresh = await app.call(LIST, { url: LIST + '?fresh=1' });
  assert.equal(fresh.body.totalArchived, 1, '恢复之后必须看到「已经不在了」');
  assert.deepEqual(fresh.body.sessions.map((s) => s.id), ['s1']);
  assert.equal(query.stats.listSessions, 2, '成员变了 → 必须另起一份，不能复用旧 pass');
  const before = await stale;
  assert.equal(before.body.totalArchived, 2, '变更前发出的请求仍然是变更前的语义');
  // 旧 pass 不得毒化缓存：下一次普通 /list 仍是新成员集
  const after = await app.call(LIST);
  assert.deepEqual(after.body.sessions.map((s) => s.id), ['s1']);
  app.disposeAll();
});

await test('v3 GET /list：乱序完成——先起跑后完成的那份不覆盖后起跑的结果', async () => {
  const registry = makeRegistry({ archived: ['s2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions });
  const passTag = new Map();
  let listCalls = 0;
  query.listSessions = async (signal) => {
    listCalls += 1;
    passTag.set(signal, listCalls === 1 ? 'A' : 'B');
    if (listCalls === 1) await sleep(150); // A（cached）先起跑但慢
    return quietSessions;
  };
  query.readTitleSnapshots = async (ids, signal) => {
    const tag = passTag.get(signal) ?? '?';
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: null, title: { title: '标题' + tag, updatedAt: 1750000000000 } } }));
  };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const slow = app.call(LIST);                            // A：t0 起跑，150ms 后完成
  await waitFor(() => query.stats.listSessions === 1);
  const fast = await app.call(LIST, { url: LIST + '?fresh=1' }); // B：t0+ε 起跑，先完成
  assert.equal(fast.body.sessions.find((s) => s.id === 's2').title, '标题B');
  const stale = await slow;
  assert.equal(stale.body.sessions.find((s) => s.id === 's2').title, '标题A');
  // 缓存里必须留下后起跑的 B（判定用写入时刻时会被 A 覆盖成「标题A」）
  const cached = await app.call(LIST);
  assert.equal(cached.body.sessions.find((s) => s.id === 's2').title, '标题B', '后起跑者胜，旧 pass 不得覆盖缓存');
  app.disposeAll();
});

await test('v3 GET /list：反向乱序——先起跑但先落盘的旧结果不得挡住后起跑的更新结果', async () => {
  const registry = makeRegistry({ archived: ['s2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions });
  const passTag = new Map();
  let listCalls = 0;
  query.listSessions = async (signal) => {
    listCalls += 1;
    const tag = listCalls === 1 ? 'A' : 'B';
    passTag.set(signal, tag);
    await sleep(tag === 'A' ? 50 : 120); // A 先起跑、先落盘；B 后起跑、后落盘
    return quietSessions;
  };
  query.readTitleSnapshots = async (ids, signal) => {
    const tag = passTag.get(signal) ?? '?';
    return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: null, title: { title: '标题' + tag, updatedAt: 1750000000000 } } }));
  };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const early = app.call(LIST);                             // A：t0 起跑（缓存空 → 真的跑）
  await waitFor(() => listCalls === 1);
  assert.equal(listCalls, 1, 'A 必须真的跑起来（缓存空时不得早退）');
  await sleep(10);
  const later = app.call(LIST, { url: LIST + '?fresh=1' });  // B：t0+10 起跑，t0+130 落盘
  await waitFor(() => listCalls === 2);
  assert.equal(listCalls, 2, 'B 是另一条通道，必须自己跑一份（不得被 A 合并掉）');
  assert.equal((await early).body.sessions.find((s) => s.id === 's2').title, '标题A');
  assert.equal((await later).body.sessions.find((s) => s.id === 's2').title, '标题B');
  const cached = await app.call(LIST);
  assert.equal(cached.body.sessions.find((s) => s.id === 's2').title, '标题B',
    '后起跑的 B 必须能覆盖先落盘的 A：判新旧若用写入时刻，B 会被判成「比已有条目旧」而丢弃');
  assert.equal(listCalls, 2, '最后这次必须是缓存命中（否则上面的断言测的是重算结果）');
  app.disposeAll();
});

await test('v3 GET /list：取消失效与 map 清理之间来的请求另起一份，而不是收到 AbortError', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
  const signals = [];
  const appRef = { app: null };
  let follow = null;
  query.listSessions = (signal) => new Promise((resolve, reject) => {
    signals.push(signal);
    const timer = setTimeout(() => resolve(quietSessions), 100);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      // 就在「共享 pass 被取消」的这一同步瞬间发出接替请求：此时 map 里那一份还没被清掉
      // （.finally 还要再走几个微任务），正是 entry-v3.js 里那条 aborted 守卫要处理的窗口。
      if (follow === null) follow = appRef.app.call(LIST);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });
  appRef.app = app;

  const res = rawCall(app, LIST);
  await waitFor(() => signals.length === 1);
  res.emit('close');
  await waitFor(() => follow !== null);
  await sleep(5); // 让被取消的那份 pass 走完 .finally（不按身份判断就会把新 pass 的条目删掉）
  const during = await app.call(STATUS);
  assert.equal(during.body.inflightPasses.length, 1, '迟到 settle 的旧 pass 不得删掉新 pass 的条目');
  const next = await follow;
  assert.equal(next.status, 200, '接替的请求必须拿到 200，而不是已取消 pass 的 500');
  assert.deepEqual(next.body.sessions.map((s) => s.id), ['s1']);
  assert.equal(signals.length, 2, '另起一份而不是复用已取消的那份');
  assert.equal(res.finished, false, '取消的那个仍然不回包');
  app.disposeAll();
});

await test('v3 GET /list：listSessions 读失败 → degraded 且不落缓存（下次能自愈）', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
  let fail = true;
  let listCalls = 0;
  const inner = query.listSessions.bind(query);
  query.listSessions = async (signal) => {
    listCalls += 1;
    if (fail) throw new Error('listSessions boom');
    return inner(signal);
  };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const broken = await app.call(LIST);
  assert.equal(broken.status, 200, '读失败仍然返回清单（不阻塞面板）');
  assert.equal(broken.body.degraded, true);
  assert.equal(broken.body.sessions.find((s) => s.id === 's1').persisted, false, '缺元数据的表现');
  assert.ok(app.warnings.some((line) => line.includes('listSessions() 失败')));
  fail = false;
  const healed = await app.call(LIST);
  assert.equal(healed.body.degraded, false, '读失败的那份不落缓存，下次必须重读');
  assert.equal(healed.body.sessions.find((s) => s.id === 's1').persisted, true);
  assert.equal(listCalls, 2, '读失败的那次也要真的发生过（否则这条用例是空转）');
  app.disposeAll();
});

await test('v3 GET /list：断开落在 readWorkspaces 期间也要停（之后不再落缓存）', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
  const signals = [];
  const innerList = query.listSessions.bind(query);
  query.listSessions = async (signal) => {
    signals.push(signal);
    return innerList(signal);
  };
  let workspacesStarted = false;
  registry.list = async () => { workspacesStarted = true; await sleep(60); return listWorkspaces; };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });

  const res = rawCall(app, LIST);
  await waitFor(() => workspacesStarted && query.stats.titleBatch === 1);
  res.emit('close');        // 断开点：标题已读完，正在读工作区账目
  await waitFor(() => signals[0].aborted === true);
  assert.equal(res.finished, false, '取消后不回包');
  await sleep(120);         // 没有检查点的话，这段足够跑完并落缓存
  const status = await app.call(STATUS);
  assert.equal(status.body.listCache, null, '取消的那一份不得落缓存（readWorkspaces 之后要有检查点）');
  app.disposeAll();
});

await test('v3 GET /list：请求结束后摘掉调用方 signal 上的 abort 监听', async () => {
  const RealAbortController = globalThis.AbortController;
  const controllers = [];
  globalThis.AbortController = class extends RealAbortController {
    constructor(...args) {
      super(...args);
      controllers.push(this);
    }
  };
  try {
    const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
    const query = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
    const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query } });
    await app.call(LIST);
    assert.ok(controllers.length >= 1, '路由应新建 AbortController');
    for (const controller of controllers) {
      assert.deepEqual(getEventListeners(controller.signal, 'abort'), [],
        '等待结束后必须 removeEventListener，别把监听器留在 signal 上');
    }
    // 断开场景同样要摘（这条 pass 是被取消的，走的是 rejection 分支）
    const stuck = rawCall(app, LIST, { url: LIST + '?fresh=1' });
    await waitFor(() => controllers.length >= 3);
    assert.ok(controllers.length >= 3, '第二个请求应新建 controller（否则这条断言是空转）');
    stuck.emit('close');
    await sleep(20);
    for (const controller of controllers) {
      assert.deepEqual(getEventListeners(controller.signal, 'abort'), [], '取消分支也要摘监听');
    }
    app.disposeAll();
  } finally {
    globalThis.AbortController = RealAbortController;
  }
});

await test('v3 GET /list：投影缓存服务在但不可用 → 早退（不是靠异常兜底），能力位为 false', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一' } });
  const app = mount({
    services: {
      workspaceRegistry: registry,
      sessionQuery: query,
      // 服务存在但形状不对：必须走「不可用」早退，而不是每个 id 各抛一次 TypeError
      sessionProjectionCache: { cachedSnapshot: 'not-a-function' },
    },
  });
  const { body } = await app.call(LIST);
  assert.equal(body.capabilities.projectionCache, false);
  assert.equal(body.titleSources.logFold, 1);
  assert.equal(app.warnings.some((line) => line.includes('sessionProjectionCache 读取失败')), false, '不得走异常兜底');
  app.disposeAll();
});

await test('v3 GET /list：identity 见证缺失 / 记录形状异常都不进快路径', async () => {
  const registry = makeRegistry({ archived: ['s1', 's9'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一', s9: '九' } });
  const cache = makeProjectionCache({ entries: { s1: { title: '缓存一' }, s9: { title: '缓存九' } } });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  // s9 不在 listSessions 里 → 没有 header 当 identity 见证 → 不查缓存，走日志折叠
  assert.deepEqual(cache.stats.calls, ['s1@undefined'], '没有 header 的会话不得查缓存：' + JSON.stringify(cache.stats.calls));
  assert.deepEqual(cache.stats.headers, [quietSessions[0].header], '必须把 listSessions 的原始 header 交给缓存');
  assert.equal(body.sessions.find((s) => s.id === 's9').title, '九');
  assert.deepEqual(body.titleSources, { cache: 1, logFold: 1, missing: 0 });
  app.disposeAll();
});

await test('v3 GET /list：投影缓存返回畸形记录（无 values / values 为 null）不炸', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一', s2: '二' } });
  let call = 0;
  const cache = {
    cachedSnapshot(header) {
      call += 1;
      if (header.id === 's1') return { asOfSeq: 3 };            // 没有 values
      if (header.id === 's2') return { asOfSeq: 3, values: null }; // values 为 null
      return undefined;
    },
  };
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { status, body } = await app.call(LIST);
  assert.equal(status, 200);
  assert.equal(call, 2);
  assert.deepEqual(body.titleSources, { cache: 0, logFold: 2, missing: 0 });
  assert.equal(body.sessions.find((s) => s.id === 's1').title, '一');
  assert.equal(app.warnings.length, 0, '畸形记录要按「没有这条记录」处理，不是靠异常兜底');
  app.disposeAll();
});

await test('v3 GET /list：多个合格 id 时投影缓存报错只告警一次', async () => {
  const registry = makeRegistry({ archived: ['s1', 's2'], workspaces: listWorkspaces });
  const query = makeQuery({ sessions: quietSessions, titles: { s1: '一', s2: '二' } });
  const cache = makeProjectionCache({ throwAlways: true });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: cache } });

  const { body } = await app.call(LIST);
  assert.equal(cache.stats.cachedSnapshot, 2, '两个 id 都要试过（否则这条断言是空转）');
  assert.equal(app.warnings.filter((line) => line.includes('sessionProjectionCache')).length, 1);
  assert.deepEqual(body.titleSources, { cache: 0, logFold: 2, missing: 0 });
  app.disposeAll();
});

await test('v3 POST /restore：写入后回读校验能发现「写没写进去」', async () => {
  const registry = makeRegistry({ archived: ['s1'], workspaces: listWorkspaces });
  registry.setState = async (next) => { registry.writes.push(next); }; // 假装成功，实际不改内存态
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });

  const { status, body } = await app.call(RESTORE, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    body: JSON.stringify({ sessionId: 's1' }),
  });
  assert.equal(status, 500);
  assert.ok(String(body.error).includes('仍包含该会话'), '必须把「写了但没生效」报出来：' + body.error);
  app.disposeAll();
});

// ── v6 删除：未登记工作区的会话历史 ────────────────────────────────────────────
// 删除动的是真文件系统：DSH_HOME 指到临时目录，里面造假会话目录。
// 断言面：只删未登记会话（登记在册的跳过）、归档集先摘、目录真删、投影缓存清掉。

const fsDelete = await import('node:fs');
const osDelete = await import('node:os');
const pathDelete = await import('node:path');

/** 造一个临时 DSH_HOME：sessions/<slug>/<id>/ 若干 + 投影缓存文件。 */
function makeFakeHome({ sessions = {}, projectionCache = [] } = {}) {
  const home = fsDelete.mkdtempSync(pathDelete.join(osDelete.tmpdir(), 'arcsess-del-'));
  for (const [slug, ids] of Object.entries(sessions)) {
    for (const id of ids) {
      fsDelete.mkdirSync(pathDelete.join(home, 'sessions', slug, id), { recursive: true });
      fsDelete.writeFileSync(pathDelete.join(home, 'sessions', slug, id, 'session.v4.jsonl.zstd'), 'x');
    }
  }
  for (const id of projectionCache) {
    const dir = pathDelete.join(home, 'storages', 'session_projcache', 'sessions');
    fsDelete.mkdirSync(dir, { recursive: true });
    fsDelete.writeFileSync(pathDelete.join(dir, `${id}.json`), '{}');
  }
  return home;
}

await test('v6 POST /delete：删未登记会话的日志目录，先摘归档集', async () => {
  const home = makeFakeHome({
    sessions: { '--root-code--': ['s-unreg', 's-unreg2'], '--root-nas-ArkTower--': ['s-reg'] },
    projectionCache: ['s-unreg', 's-reg'],
  });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const registry = makeRegistry({
      archived: ['s-unreg', 's-reg'],
      // s-reg 登记在 ws-x 的成员账目里——删除必须跳过它（删登记会话要动工作区
      // 槽位，不归本路由管）。
      workspaces: [...listWorkspaces, { id: 'ws-x', title: 'X', path: '/root/x', sessionIds: ['s-reg'] }],
    });
    const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });

    const { status, body } = await app.call(DELETE, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
      body: JSON.stringify({ sessionIds: ['s-unreg', 's-unreg2', 's-reg'] }),
    });
    assert.equal(status, 200);
    // 登记在册的 s-reg（在 ws-a 的 sessionIds 里）跳过；未登记的两个真删。
    assert.deepEqual(body.deleted, ['s-unreg', 's-unreg2']);
    assert.deepEqual(body.skipped, [{ id: 's-reg', reason: 'registered-workspace' }]);
    assert.deepEqual(body.failed, []);
    // 目录没了、投影缓存清了；登记会话的目录与缓存原样。
    assert.equal(fsDelete.existsSync(pathDelete.join(home, 'sessions', '--root-code--', 's-unreg')), false);
    assert.equal(fsDelete.existsSync(pathDelete.join(home, 'sessions', '--root-code--', 's-unreg2')), false);
    assert.equal(fsDelete.existsSync(pathDelete.join(home, 'sessions', '--root-nas-ArkTower--', 's-reg')), true);
    assert.equal(fsDelete.existsSync(pathDelete.join(home, 'storages', 'session_projcache', 'sessions', 's-unreg.json')), false);
    assert.equal(fsDelete.existsSync(pathDelete.join(home, 'storages', 'session_projcache', 'sessions', 's-reg.json')), true);
    // 归档集只摘了删掉的那些（s-reg 仍在集里）。
    assert.deepEqual(registry.state.archivedSessionIds, ['s-reg']);
    app.disposeAll();
  } finally {
    process.env.DSH_HOME = previousHome;
    fsDelete.rmSync(home, { recursive: true, force: true });
  }
});

await test('v6 POST /delete：日志目录不存在也算删成功（幂等）', async () => {
  const home = makeFakeHome({ sessions: {} });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const registry = makeRegistry({ archived: ['s-ghost'], workspaces: [] });
    const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });
    const { status, body } = await app.call(DELETE, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
      body: JSON.stringify({ sessionIds: ['s-ghost'] }),
    });
    assert.equal(status, 200);
    assert.deepEqual(body.deleted, ['s-ghost']);
    assert.deepEqual(registry.state.archivedSessionIds, [], '不在集里的 id 也不该把集合写坏');
    app.disposeAll();
  } finally {
    process.env.DSH_HOME = previousHome;
    fsDelete.rmSync(home, { recursive: true, force: true });
  }
});

await test('v6 POST /delete：参数与跨站门禁', async () => {
  const registry = makeRegistry({ archived: [], workspaces: [] });
  const app = mount({ services: { workspaceRegistry: registry, sessionQuery: makeQuery() } });
  const headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };
  const noArray = await app.call(DELETE, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) });
  assert.equal(noArray.status, 400, '缺 sessionIds 数组要 400');
  const empty = await app.call(DELETE, { method: 'POST', headers, body: JSON.stringify({ sessionIds: [] }) });
  assert.equal(empty.status, 400, '空数组要 400（点了空分组不该发请求，发了也要挡）');
  const tooMany = await app.call(DELETE, { method: 'POST', headers, body: JSON.stringify({ sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) }) });
  assert.equal(tooMany.status, 400, '超过 64 个要 400（分批删，别一把梭）');
  const badJson = await app.call(DELETE, { method: 'POST', headers, body: '{oops' });
  assert.equal(badJson.status, 400, '坏 JSON 要 400');
  const cross = await app.call(DELETE, { method: 'POST', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' }, body: JSON.stringify({ sessionIds: ['s1'] }) });
  assert.equal(cross.status, 403, '跨站要 403');
  const get = await app.call(DELETE, { method: 'GET', headers });
  assert.equal(get.status, 405, 'GET 要 405');
  app.disposeAll();
});

await test('v3 声明面：inject 与包入口（装载门禁不可静默丢弃）', async () => {
  assert.deepEqual(plugin.inject, ['webServer'], 'inject 少了 webServer 会让 apply 在服务之前跑，路由全 404');
  const viaIndex = await import('./index.js');
  assert.equal(viaIndex.apply, plugin.apply, 'index.js 必须再导出同一份实现（否则线上跑的还是旧版）');
  assert.equal(viaIndex.inject, plugin.inject);
});

// ──────────────────────────────────── 收尾 ────────────────────────────────────

console.log('');
if (failures.length === 0) {
  console.log(`SELFTEST PASS (${passed} cases)`);
} else {
  console.log(`SELFTEST FAIL (${passed} passed, ${failures.length} failed)`);
  for (const failure of failures) console.error('- ' + failure.name);
  process.exitCode = 1;
}
