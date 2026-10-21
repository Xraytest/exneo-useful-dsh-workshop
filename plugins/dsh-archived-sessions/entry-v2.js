/**
 * 归档会话浏览器（dsh-archived-sessions）— host 半边（当前实现）。
 *
 * 文件名带版本号是本 profile 的约定：loader 按 specifier 缓存模块、不认 ?query，
 * 所以改实现＝写新文件（`entry-v<N+1>.js`）+ 把 `cordis.patch.yml` 里该行的
 * name 指过去；`index.js` 只是再导出本文件的稳定包入口（见其头部注释）。
 *
 * DSH 出厂的 workspace 域只有单向 `archiveSession`（归档＝从侧边栏的每个位置
 * 隐藏，durable 归档集 `archivedSessionIds` 只增不减），没有「取消归档」入口。
 * 本插件把「按工作区列出归档 + 检索 + 一键恢复」落成静态插件，用 webServer
 * 精确路由暴露给浏览器（静态插件没有动态 runner 的 harness.handle 通道）：
 *
 *   GET  /dsh-arcsess/list     归档会话清单：按工作区分组 + 平铺列表（兼容字段）
 *   GET  /dsh-arcsess/search   在归档会话的消息内容里检索（带摘要片段）
 *   POST /dsh-arcsess/restore  把一个会话移出归档集（body {sessionId}）
 *   GET  /dsh-arcsess/status   只读自检：能力探测 / 检索引擎 / 内存（不改状态）
 *
 * 分组权威：`ctx.workspaceRegistry.list()` 的 Workspace 记录（path / title +
 * header 校验过的 sessionIds）。归档集里不属于任何工作区的会话落在
 * `unassigned`，由浏览器半边按 cwd 兜底分组（临时目录、已删除目录的会话）。
 *
 * 检索权威：优先 `ctx.sessionQuery.searchSessions`（SQLite FTS5 后端启用时：
 * 排序、摘要、亚秒级）；本部署缺省把后端配成 `openAt: never`
 * （dsh-base / dsh-web-app 的 patch 行），此时退化为
 * `ctx.sessionQuery.filterEvents` 的逐条字面量扫描。两条引擎共用同一份检索面
 * （`searchTypesFor`：FTS 走 eventFilters、字面量走 type 子句，metadata 过滤器
 * 接受 type 而不接受 text）。退化路径的边界：
 *   - 检索面是一条 type 子句：缺省 user/message + assistant/message，
 *     `includeTools=1` 再并上 tool/result + tool/call；
 *   - 会话逐个串行扫描（`searchConcurrency`），请求带时间预算（`budgetMs`），
 *     浏览器断开即停（res 'close' → cancelled）；
 *   - 响应回报已扫/待扫会话 id，浏览器可带 `skip=` 续检；FTS 路径则用
 *     `cursor=`（后端 nextCursor）翻页，两条路径的续检方式互不混用。
 *
 * 恢复写入走 `workspaceRegistry.setState`（出厂唯一写路径：域 global KV 写入
 * + 内存态替换），本插件自带串行化，避免并发读改写互相覆盖。
 * setState 是**整体替换**：本插件总是带上原样的 initialized / workspaceIds /
 * pendingMutation 等字段，只改 archivedSessionIds，避免写坏域记录。
 *
 * 写路由（/search 与 /restore）带同源门禁：`sec-fetch-site: cross-site` 与
 * 解析不出的 Origin（含 'null'）一律 403；请求体按字节限长 64 KiB（超限 413）。
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: archived-sessions
 *         name: ./plugins/dsh-archived-sessions/entry-v2.js
 *         config: {...}
 *
 * @module dsh-archived-sessions
 */

export const inject = ['webServer'];

const LIST_PATH = '/dsh-arcsess/list';
const SEARCH_PATH = '/dsh-arcsess/search';
const RESTORE_PATH = '/dsh-arcsess/restore';
const STATUS_PATH = '/dsh-arcsess/status';

/** 会话内容事件类型：默认检索面（用户输入 + 模型回复）。 */
const DEFAULT_SEARCH_TYPES = ['user/message', 'assistant/message'];
/** `includeTools=1` 时追加的检索面（工具调用参数 + 工具输出）。
 *  取值取自 session-query 的语义文本抽取面（dsh-session-query 的
 *  buildSessionEventSearchDocuments：user/message、assistant/message、tool/call、
 *  tool/result、todo/write、turn/end）——只列真正带文本的类型；system/message、
 *  session/title、compaction/summary 抽取为空串，列进来只会白占过滤位。
 *  未纳入 todo/write 与 turn/end：它们也带文本，但内容是同一轮对话的派生物
 *  （待办清单 / 轮次小结），并进来会让同一个关键词在一轮里重复命中、把真正的
 *  消息片段挤出 `snippetLimit`。 */
const TOOL_SEARCH_TYPES = ['tool/result', 'tool/call'];

/** 检索面取值并集：两条引擎（FTS 的 eventFilters / 字面量的 type 子句）共用同一份。 */
const searchTypesFor = (includeTools) => (includeTools
  ? [...DEFAULT_SEARCH_TYPES, ...TOOL_SEARCH_TYPES]
  : DEFAULT_SEARCH_TYPES);

const DEFAULTS = {
  /** /list 结果的短 TTL 缓存（毫秒）；恢复动作与 ?fresh=1 立即失效。 */
  listCacheMs: 5000,
  /** 逐条扫描的单次请求时间预算（毫秒）。 */
  searchBudgetMs: 12000,
  /** 逐条扫描的并发会话数（>1 会同时持有多个会话的完整日志）。 */
  searchConcurrency: 1,
  /** 每个命中会话返回的摘要片段数上限。 */
  snippetLimit: 3,
  /** 片段命中点两侧保留的字符数。 */
  snippetRadius: 90,
  /** 检索引擎偏好：auto=先试全文索引再退化；literal=直接逐条扫描。 */
  searchEngine: 'auto',
  minQueryChars: 2,
  maxQueryChars: 200,
  /** 热重挂时路由被旧实例占用的重试次数与间隔（≈ registerRetries × registerRetryMs 的窗口）。 */
  registerRetries: 40,
  registerRetryMs: 120,
};

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

const MAX_BODY_BYTES = 65536;

/**
 * 读 JSON 请求体：按**字节**计数（Buffer.length；不设 encoding，避免多字节字符
 * 跨分片时被拆坏），超限时暂停读取并以 code='BODY_TOO_LARGE' 拒绝——不 destroy
 * socket，好让调用方还能把 413 写回去。
 * @returns {Promise<string>} 请求体文本
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (typeof req.pause === 'function') req.pause();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      // 真实 IncomingMessage 给的是 Buffer（没调 setEncoding）；这里再兜一层字符串，
      // 免得中间层换了分片类型就整条路由 500。
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('body too large');
        error.code = 'BODY_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}

/**
 * Same-origin 判定，对齐 dsh-client-connection 的 isTrustedApiRequest 浏览器侧两条：
 * `sec-fetch-site: cross-site` 一律拒绝；带 Origin 时必须与 Host 同源。
 * 无 Origin 的本机 curl / 同源 fetch 放行；解析不出的 Origin（含 'null'，
 * 即沙箱 iframe / data: 页面）按跨站处理。lanmode 会把 Host 与 Origin 双双改写成
 * 回环权威后再转发，所以 LAN 客户端照常通过，而外部站点的跨站请求被拒。
 */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const errorText = (error) => String(error && error.message ? error.message : error);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clampInt = (raw, min, max, fallback) => {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
};

// ─────────────────────────── 纯函数（selftest 直接调用） ───────────────────────────

/**
 * 检索词规范化：折叠空白、裁剪长度。
 * @returns {{value: string, error: string|null, terms: string[]}}
 */
export function normalizeQuery(raw, options = {}) {
  const minChars = Number.isFinite(options.minQueryChars) ? options.minQueryChars : DEFAULTS.minQueryChars;
  const maxChars = Number.isFinite(options.maxQueryChars) ? options.maxQueryChars : DEFAULTS.maxQueryChars;
  const value = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, ' ').trim();
  if (value === '') return { value: '', error: '缺少检索词（q）', terms: [] };
  const chars = [...value];
  if (chars.length < minChars) return { value, error: `检索词至少 ${minChars} 个字符`, terms: [] };
  if (chars.length > maxChars) return { value, error: `检索词过长（最多 ${maxChars} 个字符）`, terms: [] };
  return { value, error: null, terms: value.split(' ') };
}

/** 把一段语义文本聚焦成片段，并给出命中区间（相对片段起点，-1=未定位）。
 *  与 sessionQuery 的 text 过滤同语义：大小写不敏感、空白弹性。 */
export function buildSnippet(text, query, radius = DEFAULTS.snippetRadius) {
  const clean = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  if (clean === '') return { snippet: '', highlightStart: -1, highlightEnd: -1 };
  const terms = String(query === null || query === undefined ? '' : query)
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((term) => term !== '');
  let match = null;
  if (terms.length > 0) {
    try {
      match = new RegExp(terms.map(escapeRegExp).join('\\s+'), 'iu').exec(clean);
    } catch {
      match = null;
    }
  }
  if (match === null) {
    return {
      snippet: clean.length > radius * 2 ? `${clean.slice(0, radius * 2)}…` : clean,
      highlightStart: -1,
      highlightEnd: -1,
    };
  }
  const start = Math.max(0, match.index - radius);
  const end = Math.min(clean.length, match.index + match[0].length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  return {
    snippet: `${prefix}${clean.slice(start, end)}${suffix}`,
    highlightStart: prefix.length + (match.index - start),
    highlightEnd: prefix.length + (match.index - start) + match[0].length,
  };
}

const createdOrder = (session) => (typeof session.createdAt === 'number' ? session.createdAt : Number.NEGATIVE_INFINITY);

/** 会话视图排序：创建时间倒序，未知创建时间垫底，id 升序兜底。 */
export function sortSessionViews(sessions) {
  sessions.sort((left, right) => {
    const a = createdOrder(left);
    const b = createdOrder(right);
    if (a !== b) return a > b ? -1 : 1;
    return String(left.id).localeCompare(String(right.id));
  });
  return sessions;
}

/**
 * 按工作区分组：membership 取 `workspace.sessionIds`（header 校验过的成员账目）。
 * 未命中任何工作区的会话进 `unassigned`，其 workspace* 字段显式为 null。
 * 分组内按创建时间倒序；分组之间按「组内最新会话」倒序。
 * @returns {{workspaces: Array, unassigned: Array}}
 */
export function groupByWorkspace(sessions, workspaces) {
  const membership = new Map();
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    for (const sessionId of workspace.sessionIds) {
      if (!membership.has(sessionId)) membership.set(sessionId, workspace);
    }
  }
  const groups = new Map();
  const unassigned = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const workspace = membership.get(session.id);
    if (workspace === undefined) {
      unassigned.push(Object.assign({}, session, { workspaceId: null, workspaceTitle: null, workspacePath: null }));
      continue;
    }
    session.workspaceId = workspace.id;
    session.workspaceTitle = workspace.title;
    session.workspacePath = workspace.path;
    let group = groups.get(workspace.id);
    if (group === undefined) {
      group = { id: workspace.id, title: workspace.title, path: workspace.path, count: 0, sessions: [] };
      groups.set(workspace.id, group);
    }
    group.sessions.push(session);
  }
  const list = [...groups.values()];
  for (const group of list) {
    sortSessionViews(group.sessions);
    group.count = group.sessions.length;
    group.newestAt = group.sessions.reduce((acc, session) => {
      const at = createdOrder(session);
      return at > acc ? at : acc;
    }, Number.NEGATIVE_INFINITY);
  }
  list.sort((left, right) => {
    if (left.newestAt !== right.newestAt) return left.newestAt > right.newestAt ? -1 : 1;
    return String(left.title).localeCompare(String(right.title));
  });
  sortSessionViews(unassigned);
  return { workspaces: list, unassigned };
}

/** 全文索引后端被部署关闭时的判定（本部署缺省 openAt: never）。 */
export function isSearchDisabled(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (code === 'SESSION_QUERY_SEARCH_DISABLED') return true;
  return /SESSION_QUERY_SEARCH_DISABLED|search is disabled|search.*disabled by configuration/i.test(errorText(error));
}

/**
 * 同步能力探测：`openAt: 'never'` 时 searchSessions/searchEvents 必抛
 * SESSION_QUERY_SEARCH_DISABLED（在 _assertSearchEnabled 里，早于任何 SQLite 工作）。
 * `config` 是后端实例的公开字段（dsh-session-query-sqlite 构造函数里 this.config = config），
 * 所以这层探测不依赖异常、也不触发索引初始化。
 */
export function isFullTextDisabled(service) {
  return service !== undefined && service !== null
    && typeof service === 'object'
    && service.config !== undefined && service.config !== null
    && service.config.openAt === 'never';
}

export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const engine = raw.searchEngine === 'literal' ? 'literal' : DEFAULTS.searchEngine;
  return {
    listCacheMs: clampInt(raw.listCacheMs, 0, 60000, DEFAULTS.listCacheMs),
    searchBudgetMs: clampInt(raw.searchBudgetMs, 1000, 60000, DEFAULTS.searchBudgetMs),
    searchConcurrency: clampInt(raw.searchConcurrency, 1, 4, DEFAULTS.searchConcurrency),
    snippetLimit: clampInt(raw.snippetLimit, 1, 10, DEFAULTS.snippetLimit),
    snippetRadius: clampInt(raw.snippetRadius, 20, 400, DEFAULTS.snippetRadius),
    searchEngine: engine,
    minQueryChars: clampInt(raw.minQueryChars, 1, 8, DEFAULTS.minQueryChars),
    maxQueryChars: clampInt(raw.maxQueryChars, 16, 1000, DEFAULTS.maxQueryChars),
    registerRetries: clampInt(raw.registerRetries, 0, 200, DEFAULTS.registerRetries),
    registerRetryMs: clampInt(raw.registerRetryMs, 20, 5000, DEFAULTS.registerRetryMs),
  };
}

// ─────────────────────────────────── 插件本体 ───────────────────────────────────

export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);

  /** 归档集：durable display filter，权威在 registry 的 global state。 */
  const readArchivedIds = () => {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用');
    const raw = registry.archivedSessionIds !== undefined
      ? registry.archivedSessionIds
      : (registry.state !== undefined ? registry.state.archivedSessionIds : undefined);
    if (!Array.isArray(raw)) throw new Error('归档集不可读：workspaceRegistry 未暴露 archivedSessionIds');
    return raw.map((id) => String(id));
  };

  const toWorkspaceView = (workspace) => {
    if (workspace === null || typeof workspace !== 'object' || workspace.id === undefined) return null;
    return {
      id: String(workspace.id),
      title: typeof workspace.title === 'string' ? workspace.title : '',
      path: typeof workspace.path === 'string' ? workspace.path : '',
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map((id) => String(id)) : [],
    };
  };

  /** 工作区账目：public `list()` 优先（path/title + 已校验成员）。 */
  const readWorkspaces = async () => {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined) return { workspaces: [], source: 'no-registry' };
    if (typeof registry.list !== 'function') return { workspaces: [], source: 'no-list' };
    try {
      const listed = await registry.list();
      if (!Array.isArray(listed)) return { workspaces: [], source: 'list-not-array' };
      return { workspaces: listed.map(toWorkspaceView).filter((entry) => entry !== null), source: 'registry.list' };
    } catch (error) {
      ctx.logger?.warn?.(`dsh-archived-sessions: workspaceRegistry.list() 失败：${errorText(error)}`);
      return { workspaces: [], source: 'list-error' };
    }
  };

  /** 会话元数据：listSessions() 一次拿全（归档只是显示过滤，记录仍在语料里）。 */
  const readSessionMeta = async (query) => {
    const meta = new Map();
    if (query === undefined || typeof query.listSessions !== 'function') return meta;
    try {
      const records = await query.listSessions();
      for (const record of Array.isArray(records) ? records : []) {
        const header = record !== null && typeof record === 'object' ? record.header : undefined;
        if (header === undefined || header === null || header.id === undefined) continue;
        meta.set(String(header.id), {
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
          live: record.live === true,
          persisted: record.persisted === true,
          parentSession: header.parentSession === undefined ? null : String(header.parentSession),
          origin: typeof header.origin === 'string' ? header.origin : null,
        });
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-archived-sessions: sessionQuery.listSessions() 失败：${errorText(error)}`);
    }
    return meta;
  };

  /** 标题：批量折叠优先（后端内部有界并发），逐条回退。 */
  const readTitles = async (query, ids) => {
    const titles = new Map();
    if (query === undefined || ids.length === 0) return titles;
    if (typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(ids);
        for (const result of Array.isArray(results) ? results : []) {
          if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue;
          const observation = result.value;
          const snapshot = observation !== null && typeof observation === 'object' ? observation.title : undefined;
          if (snapshot === undefined || snapshot === null || typeof snapshot.title !== 'string') continue;
          titles.set(String(result.sessionId), {
            title: snapshot.title,
            updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
          });
        }
        return titles;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-archived-sessions: sessionQuery.readTitleSnapshots() 失败，退回逐条读：${errorText(error)}`);
      }
    }
    if (typeof query.readTitle === 'function') {
      for (const id of ids) {
        try {
          const snapshot = await query.readTitle(id);
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.title === 'string') {
            titles.set(id, {
              title: snapshot.title,
              updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
            });
          }
        } catch {
          /* 标题缺失不阻塞列表 */
        }
      }
    }
    return titles;
  };

  const toSessionView = (id, meta, title) => ({
    id,
    title: title === undefined ? null : title.title,
    titleUpdatedAt: title === undefined ? null : title.updatedAt,
    cwd: meta === undefined ? null : meta.cwd,
    createdAt: meta === undefined ? null : meta.createdAt,
    live: meta === undefined ? false : meta.live,
    persisted: meta === undefined ? false : meta.persisted,
    parentSession: meta === undefined ? null : meta.parentSession,
    origin: meta === undefined ? null : meta.origin,
    workspaceId: null,
    workspaceTitle: null,
    workspacePath: null,
  });

  let listCache = null;
  const invalidateList = () => { listCache = null; };

  const describeArchive = async ({ fresh = false } = {}) => {
    const now = Date.now();
    if (!fresh && listCache !== null && now - listCache.at < options.listCacheMs) return listCache.value;
    const ids = readArchivedIds();
    const query = ctx.get('sessionQuery');
    const meta = await readSessionMeta(query);
    const titles = await readTitles(query, ids);
    const { workspaces, source } = await readWorkspaces();
    const views = ids.map((id) => toSessionView(id, meta.get(id), titles.get(id)));
    const grouped = groupByWorkspace(views, workspaces);
    const flat = sortSessionViews(views.map((view) => Object.assign({}, view)));
    const value = {
      generatedAt: now,
      totalArchived: ids.length,
      totalListed: views.length,
      workspaceSource: source,
      workspaces: grouped.workspaces,
      unassigned: grouped.unassigned,
      /** 兼容字段：平铺列表（历史客户端按此渲染）。 */
      sessions: flat,
      capabilities: {
        workspaceList: source === 'registry.list',
        sessionQuery: query !== undefined,
        titleBatch: query !== undefined && typeof query.readTitleSnapshots === 'function',
        searchSessions: query !== undefined && typeof query.searchSessions === 'function',
        filterEvents: query !== undefined && typeof query.filterEvents === 'function',
      },
    };
    listCache = { at: Date.now(), value };
    return value;
  };

  let tail = Promise.resolve();
  const restore = (sessionId) => {
    const run = tail.then(async () => {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined) throw new Error('workspaceRegistry 服务不可用');
      if (typeof registry.setState !== 'function' || registry.state === undefined || typeof registry.state !== 'object') {
        throw new Error('当前 DSH 构建未暴露恢复写入路径（registry.setState），无法恢复');
      }
      const current = registry.state;
      const stored = Array.isArray(current.archivedSessionIds)
        ? current.archivedSessionIds.map((id) => String(id))
        : [];
      if (!stored.includes(sessionId)) return { restored: false, archivedSessionIds: stored };
      const archivedSessionIds = stored.filter((id) => id !== sessionId);
      await registry.setState(Object.assign({}, current, { archivedSessionIds }));
      const after = readArchivedIds();
      if (after.includes(sessionId)) {
        throw new Error('恢复写入后归档集仍包含该会话，请重试');
      }
      invalidateList();
      return { restored: true, archivedSessionIds: after };
    });
    tail = run.then(() => {}, () => {});
    return run;
  };

  // 检索引擎判定是进程级的一次性结论：全文后端被关闭时不再重复试探。
  const searchState = {
    engine: options.searchEngine === 'literal' ? 'literal' : 'unknown',
    reason: options.searchEngine === 'literal' ? '配置指定 literal' : null,
    at: null,
    lastError: null,
  };

  const matchView = (document, query) => {
    const source = typeof document.text === 'string'
      ? document.text
      : (typeof document.snippet === 'string' ? document.snippet : '');
    const snippet = buildSnippet(source, query, options.snippetRadius);
    return {
      seq: typeof document.seq === 'number' ? document.seq : null,
      type: typeof document.type === 'string' ? document.type : null,
      time: typeof document.time === 'number' ? document.time : null,
      surface: typeof document.surface === 'string' ? document.surface : null,
      snippet: snippet.snippet,
      highlightStart: snippet.highlightStart,
      highlightEnd: snippet.highlightEnd,
    };
  };

  const runContentSearch = async ({ query, includeTools, budgetMs, snippetLimit, skip, cursor, cancelled }) => {
    const service = ctx.get('sessionQuery');
    if (service === undefined) throw new Error('sessionQuery 服务不可用，无法检索内容');
    const archivedIds = readArchivedIds().filter((id) => !skip.has(id));
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    const types = searchTypesFor(includeTools);
    const result = {
      query,
      includeTools,
      engine: 'literal',
      engineReason: null,
      results: [],
      errors: [],
      scannedIds: [],
      pendingIds: [],
      nextCursor: null,
      elapsedMs: 0,
      truncated: false,
    };
    if (archivedIds.length === 0) {
      result.engine = 'empty';
      result.elapsedMs = Date.now() - startedAt;
      return result;
    }

    // 快路径：SQLite FTS5 后端（带排序与摘要）。
    // 部署把索引配成 openAt:'never' 时，后端会在任何 SQLite 工作之前就同步抛
    // SESSION_QUERY_SEARCH_DISABLED（session-query-sqlite._assertSearchEnabled），
    // 该结论进程内稳定——先用公开的 config 探测一次，省掉每次请求的异常开销。
    if (searchState.engine !== 'literal' && isFullTextDisabled(service)) {
      searchState.engine = 'literal';
      searchState.reason = '部署把全文索引配成 openAt: "never"（session-query 索引未启用）';
      searchState.at = Date.now();
    }
    if (searchState.engine === 'literal' && searchState.reason !== null) {
      // 退化原因随响应回给浏览器（状态行把它挂成 tooltip）。
      result.engineReason = searchState.reason;
    }
    if (searchState.engine !== 'literal' && typeof service.searchSessions === 'function') {
      try {
        const page = await service.searchSessions({
          query,
          sessionFilters: [{ kind: 'id', values: archivedIds }],
          // 与字面量路径同一个检索面：metadata 过滤器接受 type（不接受 text）。
          eventFilters: [{ kind: 'type', values: types }],
          limit: Math.max(snippetLimit, 20),
          ...(typeof cursor === 'string' && cursor !== '' ? { cursor } : {}),
        });
        searchState.engine = 'fts';
        searchState.reason = null;
        searchState.at = Date.now();
        result.engine = 'fts';
        // FTS 是索引命中而不是「扫过会话日志」：scannedIds 报的是索引覆盖的归档集。
        result.scannedIds = [...archivedIds];
        result.nextCursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
        result.truncated = result.nextCursor !== null;
        for (const hit of Array.isArray(page?.items) ? page.items : []) {
          const best = hit !== null && typeof hit === 'object' ? hit.bestMatch : undefined;
          const id = hit !== null && typeof hit === 'object' && hit.header !== undefined
            ? String(hit.header.id)
            : (best !== undefined ? String(best.sessionId) : '');
          if (id === '') continue;
          result.results.push({ id, matchCount: null, matches: [matchView(best === undefined ? {} : best, query)] });
        }
        result.elapsedMs = Date.now() - startedAt;
        return result;
      } catch (error) {
        const message = errorText(error);
        const compact = message.length > 160 ? `${message.slice(0, 159)}…` : message;
        searchState.lastError = message;
        searchState.at = Date.now();
        if (isSearchDisabled(error)) {
          // 部署把全文后端配成 openAt: never —— 结论稳定，不再重复试探。
          searchState.engine = 'literal';
          searchState.reason = '部署未启用全文索引（openAt: "never"）';
          result.engineReason = searchState.reason;
        } else {
          result.engineReason = `全文索引不可用（${compact}），本次已逐条扫描`;
          ctx.logger?.warn?.(`dsh-archived-sessions: searchSessions 失败，本次退化逐条扫描：${message}`);
        }
      }
    }

    // 慢路径：逐会话字面量扫描（provider-independent，任何部署都可用）。
    // filterEvents 的多条同 kind 子句是 AND 关系（session-query 的
    // filterSessionEventDocuments 用 predicates.every 逐条判定），所以检索面
    // 必须写成一条 type 子句里的取值并集，拆成两条会互相排斥成空集。
    const filters = [
      { kind: 'text', text: query },
      { kind: 'type', values: types },
    ];
    const pending = [...archivedIds];
    const order = new Map(archivedIds.map((id, index) => [id, index]));
    const worker = async () => {
      for (;;) {
        if (cancelled() || Date.now() >= deadline) return;
        const id = pending.shift();
        if (id === undefined) return;
        try {
          const documents = await service.filterEvents(id, filters);
          result.scannedIds.push(id);
          if (Array.isArray(documents) && documents.length > 0) {
            result.results.push({
              id,
              matchCount: documents.length,
              matches: documents.slice(0, snippetLimit).map((document) => matchView(document, query)),
            });
          }
        } catch (error) {
          result.scannedIds.push(id);
          result.errors.push({ id, message: errorText(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.searchConcurrency) }, worker));
    const scanned = new Set(result.scannedIds);
    result.pendingIds = archivedIds.filter((id) => !scanned.has(id));
    result.truncated = result.pendingIds.length > 0 || cancelled();
    result.results.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    result.elapsedMs = Date.now() - startedAt;
    return result;
  };

  /**
   * 注册一条精确路由，并容忍 patch 层热重挂时的瞬时占用。
   *
   * profile 是 patchReload=live，而 loader 的 EntryGroup.update 是**先建全部新
   * entry、再拆被删掉的旧 entry**（cordis-plugin-loader/lib/index.js：create 先走
   * Promise.allSettled，remove 在其后）。于是按本 profile 的惯例「换 id 强制重挂」
   * 时，新行的 apply 会在旧行仍占着同名路径期间执行，`webServer.register` 的
   * duplicate 检查抛错 → 整层 update 回滚 → 旧代码继续在跑（2026-10-08 实测：
   * /dsh-arcsess/status 一直 404、/list 仍是旧实现）。
   * 这里把「路径已被占用」当成可恢复状态：首轮失败不抛错，下一个宏任务重试，
   * 等旧行拆干净再占位；dispose 时撤销未完成的定时器与已注册的路由。
   */
  const registerRoute = (label, path, handler) => ctx.effect(() => {
    let disposed = false;
    let unregister = null;
    let timer = null;
    const attempt = (remaining) => {
      if (disposed) return;
      try {
        unregister = ctx.webServer.register({ kind: 'exact', path, handler });
      } catch (error) {
        if (remaining > 0 && /duplicate .*route/i.test(errorText(error))) {
          timer = setTimeout(() => attempt(remaining - 1), options.registerRetryMs);
          return;
        }
        ctx.logger?.warn?.(`dsh-archived-sessions: 路由 ${path} 注册失败：${errorText(error)}`);
      }
    };
    attempt(options.registerRetries);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (unregister !== null) unregister();
    };
  }, label);

  registerRoute('dsh-archived-sessions: list route', LIST_PATH, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method Not Allowed' });
    }
    const url = new URL(req.url ?? LIST_PATH, 'http://localhost');
    const fresh = url.searchParams.get('fresh') === '1';
    describeArchive({ fresh })
      .then((value) => json(res, 200, value))
      .catch((error) => json(res, 500, { error: errorText(error) }));
  });

  registerRoute('dsh-archived-sessions: search route', SEARCH_PATH, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method Not Allowed' });
    }
    if (!sameOrigin(req)) {
      return json(res, 403, { error: 'cross-origin request rejected' });
    }
    const url = new URL(req.url ?? SEARCH_PATH, 'http://localhost');
    const normalized = normalizeQuery(url.searchParams.get('q'), options);
    if (normalized.error !== null) {
      return json(res, 400, { error: normalized.error });
    }
    const includeTools = url.searchParams.get('includeTools') === '1';
    const budgetMs = clampInt(url.searchParams.get('budgetMs'), 1000, 60000, options.searchBudgetMs);
    const snippetLimit = clampInt(url.searchParams.get('limit'), 1, 10, options.snippetLimit);
    const skip = new Set(
      String(url.searchParams.get('skip') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    );
    // FTS 引擎的分页游标（字面量路径不使用；两条路径的续检方式各自独立）。
    const cursor = url.searchParams.get('cursor');
    let cancelled = false;
    res.on('close', () => { cancelled = true; });
    runContentSearch({
      query: normalized.value,
      includeTools,
      budgetMs,
      snippetLimit,
      skip,
      cursor: cursor === null ? '' : cursor,
      cancelled: () => cancelled,
    })
      .then((value) => json(res, 200, value))
      .catch((error) => json(res, 500, { error: errorText(error) }));
  });

  registerRoute('dsh-archived-sessions: restore route', RESTORE_PATH, (req, res) => {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method Not Allowed' });
    }
    if (!sameOrigin(req)) {
      return json(res, 403, { error: 'cross-origin request rejected' });
    }
    readBody(req).then(async (text) => {
      let args = {};
      if (text !== '') {
        try {
          args = JSON.parse(text);
        } catch {
          return json(res, 400, { error: 'body 不是合法 JSON' });
        }
      }
      const sessionId = args !== null && typeof args === 'object' && typeof args.sessionId === 'string'
        ? args.sessionId
        : null;
      if (sessionId === null) {
        return json(res, 400, { error: 'arcsess/restore 需要 { sessionId: string }' });
      }
      try {
        return json(res, 200, await restore(sessionId));
      } catch (error) {
        return json(res, 500, { error: errorText(error) });
      }
    }).catch((error) => {
      const tooLarge = error !== null && typeof error === 'object' && error.code === 'BODY_TOO_LARGE';
      return json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body 过大（上限 64 KiB）' : 'body 读取失败' });
    });
  });

  registerRoute('dsh-archived-sessions: status route', STATUS_PATH, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'Method Not Allowed' });
    }
    (async () => {
      const registry = ctx.get('workspaceRegistry');
      const query = ctx.get('sessionQuery');
      let archivedCount = null;
      let archivedError = null;
      try {
        archivedCount = readArchivedIds().length;
      } catch (error) {
        archivedError = errorText(error);
      }
      const { workspaces, source } = await readWorkspaces();
      const memory = typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
        ? process.memoryUsage()
        : null;
      return {
        plugin: 'dsh-archived-sessions',
        version: 2,
        routes: [LIST_PATH, SEARCH_PATH, RESTORE_PATH, STATUS_PATH],
        archivedCount,
        archivedError,
        workspaceCount: workspaces.length,
        workspaceSource: source,
        assignedSessions: workspaces.reduce((acc, workspace) => acc + workspace.sessionIds.length, 0),
        capabilities: {
          registryState: registry !== undefined && registry.state !== undefined,
          registrySetState: registry !== undefined && typeof registry.setState === 'function',
          workspaceList: registry !== undefined && typeof registry.list === 'function',
          sessionQuery: query !== undefined,
          searchSessions: query !== undefined && typeof query.searchSessions === 'function',
          filterEvents: query !== undefined && typeof query.filterEvents === 'function',
          titleBatch: query !== undefined && typeof query.readTitleSnapshots === 'function',
        },
        search: {
          engine: searchState.engine,
          reason: searchState.reason,
          lastError: searchState.lastError,
          decidedAt: searchState.at,
        },
        memory: memory === null ? null : {
          heapUsedMb: Math.round(memory.heapUsed / 1048576),
          rssMb: Math.round(memory.rss / 1048576),
        },
        config: options,
        generatedAt: Date.now(),
      };
    })()
      .then((value) => json(res, 200, value))
      .catch((error) => json(res, 500, { error: errorText(error) }));
  });
}
