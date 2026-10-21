/**
 * 归档会话浏览器（dsh-archived-sessions）— host 半边（当前实现，v3）。
 *
 * 文件名带版本号是本 profile 的约定：loader 按 specifier 缓存模块、不认 ?query，
 * 所以改实现＝写新文件（`entry-v<N+1>.js`）+ 把 `cordis.patch.yml` 里该行的
 * name 指过去；`index.js` 只是再导出本文件的稳定包入口（见其头部注释）。
 *
 * ── v3（2026-10-08）性能修复：列表冷路径 3.63–5.85 s → 预期 ≈0.5 s ──────────
 * 实测（报告 output/dsh_arcsess_perf_20261008.md）：`/list` 冷路径 3.63–5.85 s，
 * 其中约 75–98% 花在 `sessionQuery.readTitleSnapshots(30 个归档会话)`——折叠标题必须
 * **整份解码**每个会话日志（36.3 MB 压缩 → 120.5 MB 明文 → 27,456 个 zstd 帧
 * → 47,895 条事件全部 JSON 解析），后端解析 memo 上限只有 2 条，插件 5 s TTL
 * 一过就重付一遍。三处改动：
 *
 *   1. 标题快路径 = `ctx.sessionProjectionCache.cachedSnapshot(header, 0)`：DSH
 *      自己的会话列表对冷会话就是这么取标题的（dsh-api-session-controller 的
 *      `projectionsFor` → 同一调用），纯内存、零 I/O。实测（当天 30 条归档集）30/30
 *      命中 3.5 ms、与日志折叠结果逐字一致；复核时归档集已 32 条，独立重算 32/32 全等、
 *      暖态 32 条约 2 ms。只对**未命中**的 id 回退 `readTitleSnapshots`；live
 *      会话（内存态更新更快）与 seeded 会话（inherited cut 不在列表 header 里）
 *      不走投影缓存。缓存值是节流 checkpoint（writeEveryEvents 200 /
 *      writeIntervalMs 5000），可能落后日志尾，但记录绑定 header 的 lifecycle
 *      identity，不会张冠李戴。
 *   2. `/list` 缓存改为**成员感知**：缓存键带上归档集 id 串，归档集一变（新归档 /
 *      恢复）立即作废，TTL 只兜标题 / cwd / 工作区这类慢变量——于是 TTL 可以放宽
 *      到 60 s 而不牺牲「刚归档的会话马上可见」。
 *   3. 在飞请求合并 + 取消传播：同一 (fresh + 归档集成员) 键同一时刻只跑一份解码
 *      （实测 6 个并发各 41 s、3 个各 17 s，现在最多两份），浏览器断开（切走设置页 /
 *      刷新）时该调用方停止等待，**等待者归零**才取消共享解码（插件被拆时也取消）；
 *      signal 透传给 `listSessions(signal)` / `readTitleSnapshots(ids, signal)`。
 *      合并键必须带成员：恢复之后来的请求若接到「变更之前起跑」的那一份，会拿到仍含
 *      该会话的旧清单——客户端的固定动作恰好落在那个窗口里（恢复后立刻 `?fresh=1`）。
 *
 * 预期收益 ≈0.5 s（= listSessions 468 ms + 缓存标题 ~3.4 ms），激活后实测值见报告
 * 「v3 上线实测」。下面的加固来自对抗审查（4 个独立审查面；首轮 33 条变异 14 杀 / 18 存活 /
 * 1 条语法失败 —— 存活项已逐条转成新用例，加固版第二轮 16 条变异 12 杀），都写进了自测：
 *   - `listSessions()` 读失败的那一份**不落缓存**（缺 cwd/createdAt 会被浏览器渲染成
 *     「日志已删除」，v2 只错 5 s，放宽 TTL 后必须堵住），响应里带 `degraded: true`；
 *   - 缓存新旧判定用 **pass 起始时刻**（startedAt）而不是写入时刻，后起跑的那份赢，
 *     先起跑后完成的不会覆盖更新结果；
 *   - `readWorkspaces()` 之后补取消检查点（否则取消在这一段失效、还会落缓存）；
 *   - 诊断位 `capabilities.projectionCache` 与快路径准入用同一个谓词（服务在但没有
 *     `cachedSnapshot` 时报 true 会误导线上核对）。
 *
 * 响应新增 `titleSources`（cache / logFold / missing 计数）与 `degraded`；`/status`
 * 新增 `capabilities.projectionCache`、`listCache`（起点 / TTL / 条数）、`inflightPasses`。
 * 注意 `titleUpdatedAt` 的口径（见 `toSessionView` 上方注释）：缓存命中行是
 * max(createdAt, lastPromptAt)（侧边栏列表自己的「最近活动」），日志折叠行是最后一条
 * session/title 事件时间——两条路径拿不到对方的时钟。实测 30 个归档会话：有符号差中位数
 * −2.8 s，逐条绝对差中位数 12.5 s（11 条 >60 s、2 条 >1 天）。
 *
 * ── v4（2026-10-19）两件事：标题快路径真的用上 + 联动设备网格 ─────────────────
 *
 * ① **标题快路径此前从未命中**（这就是「归档会话一直转圈」的真实原因）：
 *    v3 的 `readCachedTitles` 把 `cachedSnapshot(header, 0)` / `cachedPredecessorTitle(header, 0)`
 *    的第二个参数当成「偏移」传了 `0`，而投影缓存的签名是 `cachedSnapshot(meta, keys)`：
 *    keys=0 会被 `viewCheckpoint` 里的 `new Set(keys)` 直接抛 TypeError
 *    （0 is not iterable），异常被本函数的 try/catch 吞掉 → **73 条归档会话只有 1 条
 *    命中缓存、其余 72 条全部回退日志折叠**（实测 `/list` 冷路径 72.7 s、暖路径 85.5 s，
 *    面板一直显示「加载中…」）。出厂调用点是 `cache.cachedSnapshot(header)`（不带第二个
 *    参数），这里照抄即可。修复后标题全部来自内存投影缓存，`/list` 回到百毫秒级。
 *
 * ② **联动设备网格**：本机 `workspaceRegistry` / `sessionQuery` 只认识本机的会话，
 *    另一台设备自己的归档会话在别处。v4 起 `/list` 会合并网格里各设备的归档会话：
 *      · 优先读对方清单快照（`deviceMesh.tree('full')` 的 `inventory`，`archived === true`），
 *        对方开了「包含已归档会话」时零成本；
 *      · 对方清单默认不含归档（includeArchived=false）时，退化为一次只读 exec：
 *        读对方的 `storages/workspace.json`（归档集 + 工作区账目）与
 *        `storages/session_projcache/sessions/<id>.json`（标题 / cwd / 创建时间），
 *        按 `remoteCacheMs` 缓存，失败只在 `/status` 留诊断，不影响本机清单。
 *    合并行带 `remote: true` / `deviceId` / `deviceName`；按工作区路径并进本机同名分组，
 *    对方独有的工作区自成一组（组上也带 device 信息）。整段有总预算 `remoteBudgetMs`，
 *    超时先返回本机清单（`remote.pending: true`），绝不把面板拖成「一直加载」。
 *
 * ③ 浏览器半边同步改动：行上标设备、远程会话的「恢复」按钮改为说明（归档集写的是
 *    那台设备的 registry，本机没有写入口）；`fetchJson` 加超时与「重试」入口。
 *
 * ── v5（2026-10-19）：本体与 v4 逐字一致，只为真正加载进来 ────────────────────
 * v4 写好后一直没在运行实例里生效：本部署实测 live patch 重载不触发（watcher 活着、
 * reconcile 不落地，`/dsh-arcsess/status` 一直是 version 3）→ 标题快路径修复从未
 * 上线，`/list` 冷路径仍 ≈70 s（titleSources: 73 logFold），设置页「刷新」约等于卡死。
 * v5 不改行为，随本轮 dsh 重启一起换文件名加载；`/status` 的 version 报 5。
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
 *         name: ./plugins/dsh-archived-sessions/entry-v3.js
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
  /** /list 结果缓存的 TTL（毫秒）。缓存键含归档集成员，成员一变立即失效，
   *  所以这里的 TTL 只兜标题 / cwd / 工作区这类慢变量；恢复动作与 ?fresh=1
   *  仍然立即失效。v3 起 5 s → 60 s（v3 的单次冷成本已从 4–6 s 降到 ~0.5 s，
   *  这里主要是防重复点击 / 面板切走切回）。 */
  listCacheMs: 60000,
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
  /** 设备网格：远程归档清单的缓存 TTL（毫秒）。0 = 每个请求都重新采集。 */
  remoteCacheMs: 60000,
  /** 设备网格：远程采集的总预算（毫秒）。超时先返回本机清单（remote.pending）。 */
  remoteBudgetMs: 8000,
  /** 设备网格：对端 exec 采集单次超时（毫秒）。 */
  remoteExecTimeoutMs: 20000,
  /** 设备网格：是否允许用 exec 读对端归档（对方清单不含归档时才会用到）。 */
  remoteExec: true,
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

/**
 * 把设备网格采到的远程归档会话并进本机分组（纯函数，selftest 可直接调用）。
 *
 * 归组口径：先按 `workspacePath`（对方账目里的工作区路径）找本机同路径分组——
 * 同一份工作区在两台设备上各有一份时，两边的归档会话落在同一个分组里（行上再标
 * 设备）。对方独有的工作区自成一组，组 key 带 deviceId（不与同路径的本机组撞 id），
 * 组上也带 `remote`/`deviceId`/`deviceName`。
 * 本机已有的同 id 会话一律优先：远程行只在本地没有该 id 时才并入。
 * @param {{workspaces: object[], unassigned: object[]}} grouped `groupByWorkspace` 的结果（就地修改）。
 * @param {object[]} remoteViews 远程会话视图（带 remote/deviceId/deviceName）。
 * @returns {{workspaces: object[], unassigned: object[]}} 同一个对象。
 */
export function mergeRemoteViews(grouped, remoteViews) {
  const byPath = new Map();
  for (const group of grouped.workspaces) {
    if (typeof group.path === 'string' && group.path !== '') byPath.set(group.path, group);
  }
  for (const view of Array.isArray(remoteViews) ? remoteViews : []) {
    if (view === null || typeof view !== 'object' || typeof view.id !== 'string') continue;
    const path = typeof view.workspacePath === 'string' && view.workspacePath !== ''
      ? view.workspacePath
      : (typeof view.cwd === 'string' ? view.cwd : '');
    let group = path !== '' ? byPath.get(path) : undefined;
    if (group === undefined) {
      const title = typeof view.workspaceTitle === 'string' && view.workspaceTitle !== ''
        ? view.workspaceTitle
        : (path !== '' ? path : '远程工作区');
      group = {
        id: 'remote:' + String(view.deviceId) + ':' + String(view.workspaceId ?? path),
        title,
        path,
        count: 0,
        sessions: [],
        remote: true,
        deviceId: view.deviceId,
        deviceName: view.deviceName,
      };
      grouped.workspaces.push(group);
      if (path !== '') byPath.set(path, group);
    }
    if (group.sessions.some((session) => session.id === view.id)) continue;
    view.workspaceId = group.id;
    view.workspaceTitle = group.title;
    view.workspacePath = group.path;
    group.sessions.push(view);
    if (group.remote !== true && group.mixed !== true) group.mixed = true;
  }
  for (const group of grouped.workspaces) {
    sortSessionViews(group.sessions);
    group.count = group.sessions.length;
    group.newestAt = group.sessions.reduce((acc, session) => {
      const at = createdOrder(session);
      return at > acc ? at : acc;
    }, Number.NEGATIVE_INFINITY);
  }
  grouped.workspaces.sort((left, right) => {
    if (left.newestAt !== right.newestAt) return left.newestAt > right.newestAt ? -1 : 1;
    return String(left.title).localeCompare(String(right.title));
  });
  return grouped;
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
    remoteCacheMs: clampInt(raw.remoteCacheMs, 0, 600000, DEFAULTS.remoteCacheMs),
    remoteBudgetMs: clampInt(raw.remoteBudgetMs, 500, 60000, DEFAULTS.remoteBudgetMs),
    remoteExecTimeoutMs: clampInt(raw.remoteExecTimeoutMs, 1000, 120000, DEFAULTS.remoteExecTimeoutMs),
    remoteExec: raw.remoteExec === false ? false : DEFAULTS.remoteExec,
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

  /** 取消语义：调用方（浏览器）已经走了不算错误，但必须停止后续解码。 */
  const abortError = () => {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    return error;
  };
  const throwIfAborted = (signal) => {
    if (signal !== undefined && signal !== null && signal.aborted === true) throw abortError();
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

  // ─────────────────────── 设备网格：远程工作区的归档会话 ───────────────────────
  // 本机 registry 只认识本机的归档集；另一台设备自己的归档会话只能从网格拿。
  // 两条来源，按成本从低到高：
  //   ① 对方清单快照（`deviceMesh.tree('full')` 的 `inventory`）：对方开启
  //      「包含已归档会话」时，归档行直接带着 `archived: true`（含标题），零成本。
  //   ② 对端只读 exec：读对方 `storages/workspace.json` 的 `archivedSessionIds`
  //      与 `tables.workspaces`，再读 `storages/session_projcache/sessions/<id>.json`
  //      拿标题 / cwd / createdAt。对方清单默认 includeArchived=false，所以这是
  //      **今天唯一能真正拿到远端归档**的路；一次 ~150 ms，按 remoteCacheMs 缓存。
  // 两条路都是 best-effort：任何失败只写进 /status 的诊断，绝不影响本机清单。

  /** 对端采集脚本：只读 JSON，不写任何东西。外层用单引号包给 sh -c，脚本内只用双引号。 */
  const REMOTE_COLLECT_COMMAND = `node -e 'const fs=require("fs"),path=require("path");const H=process.env.DSH_HOME||"/root/.dsh";const rd=(p)=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){return null}};const ws=rd(path.join(H,"storages/workspace.json"))||{};const g=ws.global||{};const tables=ws.tables||{};const wss=tables.workspaces||{};const archived=(Array.isArray(g.archivedSessionIds)?g.archivedSessionIds:[]).map(String);const pc=path.join(H,"storages/session_projcache/sessions");const out=[];for(const id of archived){const rec=(rd(path.join(pc,id+".json"))||{}).record||null;const rows=(rec&&rec.rows)||{};const t=rows.title?rows.title.val:null;const idn=(rec&&rec.identity)||{};out.push({id,title:typeof t==="string"?t:null,cwd:typeof idn.cwd==="string"?idn.cwd:null,createdAt:Number.isFinite(idn.createdAt)?idn.createdAt:null})}const workspaces=Object.entries(wss).map(([id,w])=>({id,title:w&&typeof w.title==="string"?w.title:"",path:w&&typeof w.path==="string"?w.path:"",sessionIds:Array.isArray(w&&w.sessionIds)?w.sessionIds.map(String):[]}));console.log(JSON.stringify({archived,out,workspaces}));'`;

  /** 网格侧缓存：{ at, devices: [...], sessions: [...], problems: [...] }。 */
  let meshCache = null;
  /** 最近一次采集的诊断（/status 用，不进缓存判定）。 */
  let meshDiag = { at: null, devices: [], problems: [], pending: false };

  /** 从一台设备的清单快照里取归档会话（对方 includeArchived=true 时才非空）。 */
  const remoteFromInventory = (device) => {
    const inventory = device !== null && typeof device === 'object' ? device.inventory : undefined;
    if (inventory === null || typeof inventory !== 'object') return null;
    const rows = [];
    for (const workspace of Array.isArray(inventory.workspaces) ? inventory.workspaces : []) {
      for (const session of Array.isArray(workspace.sessions) ? workspace.sessions : []) {
        if (session === null || typeof session !== 'object' || session.archived !== true) continue;
        if (typeof session.id !== 'string') continue;
        rows.push({
          id: session.id,
          title: typeof session.title === 'string' ? session.title : null,
          cwd: typeof session.cwd === 'string' ? session.cwd : null,
          createdAt: typeof session.createdAt === 'number' ? session.createdAt : null,
          live: session.live === true,
          persisted: session.persisted === true,
          origin: typeof session.origin === 'string' ? session.origin : null,
          parentSession: typeof session.parentSession === 'string' ? session.parentSession : null,
          workspaceId: typeof workspace.id === 'string' ? workspace.id : null,
          workspaceTitle: typeof workspace.title === 'string' ? workspace.title : '',
          workspacePath: typeof workspace.path === 'string' ? workspace.path : '',
        });
      }
    }
    return rows;
  };

  /**
   * 只读 exec 采集一台对端设备的归档会话。
   * @returns {Promise<{rows: object[], error: string|null}>}
   */
  const remoteViaExec = async (mesh, device) => {
    const workspaces = (device.inventory?.workspaces ?? []).filter((workspace) => typeof workspace.path === 'string' && workspace.path !== '');
    const path = workspaces.length > 0 ? workspaces[0].path : null;
    if (path === null) return { rows: [], error: 'no-exported-workspace' };
    let result = null;
    try {
      result = await mesh.exec({
        deviceId: device.deviceId,
        path,
        command: REMOTE_COLLECT_COMMAND,
        timeoutMs: options.remoteExecTimeoutMs,
      });
    } catch (error) {
      return { rows: [], error: errorText(error) };
    }
    if (result === null || typeof result !== 'object') return { rows: [], error: 'empty result' };
    if (result.exitCode !== 0 || result.timedOut === true) {
      return { rows: [], error: `exit ${String(result.exitCode)}${result.timedOut === true ? ' (timeout)' : ''}: ${String(result.stderr ?? '').slice(0, 200)}` };
    }
    let payload = null;
    try {
      payload = JSON.parse(String(result.stdout ?? ''));
    } catch (error) {
      return { rows: [], error: `stdout 不是 JSON：${errorText(error)}` };
    }
    const workspaceById = new Map();
    for (const workspace of Array.isArray(payload.workspaces) ? payload.workspaces : []) {
      if (workspace !== null && typeof workspace === 'object' && typeof workspace.id === 'string') workspaceById.set(workspace.id, workspace);
    }
    const rows = Array.isArray(payload.out) ? payload.out : [];
    return {
      rows: rows
        .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
        .map((row) => {
          const cwd = typeof row.cwd === 'string' ? row.cwd : null;
          // 工作区归属：先按账目里 path 完全相等，再按 cwd 前缀。
          let owner = null;
          for (const workspace of workspaceById.values()) {
            if (workspace.path === cwd) { owner = workspace; break; }
          }
          if (owner === null && cwd !== null) {
            for (const workspace of workspaceById.values()) {
              if (typeof workspace.path === 'string' && workspace.path !== ''
                && (cwd === workspace.path || cwd.startsWith(workspace.path.endsWith('/') ? workspace.path : workspace.path + '/'))) {
                owner = workspace;
                break;
              }
            }
          }
          return {
            id: row.id,
            title: typeof row.title === 'string' ? row.title : null,
            cwd,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : null,
            live: false,
            persisted: true,
            origin: null,
            parentSession: null,
            workspaceId: owner === null ? null : owner.id,
            workspaceTitle: owner === null ? '' : String(owner.title ?? ''),
            workspacePath: owner === null ? '' : String(owner.path ?? ''),
          };
        }),
      error: null,
    };
  };

  /**
   * 采集全网格的远程归档会话（带缓存与总预算）。
   * @param {boolean} fresh - true 时忽略缓存。
   * @returns {Promise<{sessions: object[], devices: object[], problems: string[], pending: boolean, source: string}>}
   */
  const readMeshArchived = async (fresh) => {
    const mesh = ctx.get('deviceMesh');
    if (mesh === undefined || mesh === null || typeof mesh.tree !== 'function') {
      meshDiag = { at: Date.now(), devices: [], problems: [], pending: false, source: 'no-mesh' };
      return { sessions: [], devices: [], problems: [], pending: false, source: 'no-mesh' };
    }
    const now = Date.now();
    if (!fresh && meshCache !== null && now - meshCache.at < options.remoteCacheMs) {
      meshDiag = meshCache.diag;
      return meshCache.value;
    }
    let tree = null;
    try {
      tree = mesh.tree('full');
    } catch (error) {
      tree = null;
    }
    const allDevices = tree !== null && Array.isArray(tree.devices) ? tree.devices : [];
    const peers = allDevices.filter((device) => device !== null && typeof device === 'object' && device.self !== true && typeof device.deviceId === 'string');
    const devices = [];
    const problems = [];
    const sessions = [];
    const collect = async () => {
      for (const device of peers) {
        const name = typeof device.name === 'string' && device.name !== '' ? device.name : device.deviceId;
        const online = device.liveness === 'online' || device.liveness === 'stale';
        let rows = remoteFromInventory(device);
        let source = rows === null ? 'inventory-absent' : 'inventory';
        let error = null;
        if ((rows === null || rows.length === 0) && options.remoteExec && online) {
          const collected = await remoteViaExec(mesh, device);
          if (collected.error === null) {
            rows = collected.rows;
            source = 'exec';
          } else {
            error = collected.error;
            rows = rows ?? [];
            source = rows.length > 0 ? 'inventory' : 'unavailable';
          }
        }
        rows = rows ?? [];
        if (error !== null) problems.push(`${name}: ${error}`);
        devices.push({
          deviceId: device.deviceId,
          name,
          liveness: device.liveness ?? 'unknown',
          source,
          error,
          archivedCount: rows.length,
        });
        for (const row of rows) {
          sessions.push(Object.assign({}, row, { deviceId: device.deviceId, deviceName: name }));
        }
      }
    };
    let pending = false;
    if (peers.length > 0) {
      await Promise.race([
        collect(),
        new Promise((resolve) => {
          const timer = setTimeout(() => { pending = true; resolve(); }, options.remoteBudgetMs);
          timer.unref?.();
        }),
      ]);
    }
    const value = { sessions, devices, problems, pending, source: 'mesh' };
    const diag = { at: Date.now(), devices, problems, pending, source: 'mesh' };
    meshDiag = diag;
    // 只缓存**完整**的一轮：超时的半轮不落缓存，否则下一次请求会在 TTL 里继续读半份。
    if (!pending) meshCache = { at: Date.now(), value, diag };
    return value;
  };

  /** 会话元数据：listSessions() 一次拿全（归档只是显示过滤，记录仍在语料里）。
   *  同时交出**原始 header**：标题的零 I/O 快路径要拿它当 lifecycle identity
   *  见证（投影缓存按 header 校验记录归属）。
   *  @returns {Promise<{meta: Map, headers: Map, failed: boolean}>} failed=读失败
   *  （区别于「没有 sessionQuery 服务」），调用方据此决定要不要落缓存。 */
  const readSessionMeta = async (query, signal) => {
    const meta = new Map();
    const headers = new Map();
    if (query === undefined || typeof query.listSessions !== 'function') return { meta, headers, failed: false };
    let failed = false;
    try {
      const records = await query.listSessions(signal);
      throwIfAborted(signal);
      for (const record of Array.isArray(records) ? records : []) {
        const header = record !== null && typeof record === 'object' ? record.header : undefined;
        if (header === undefined || header === null || header.id === undefined) continue;
        const id = String(header.id);
        headers.set(id, header);
        meta.set(id, {
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
          live: record.live === true,
          persisted: record.persisted === true,
          parentSession: header.parentSession === undefined ? null : String(header.parentSession),
          origin: typeof header.origin === 'string' ? header.origin : null,
        });
      }
    } catch (error) {
      // 取消不是「读失败」：不能带着空 meta 继续，否则会把空标题缓存下来。
      throwIfAborted(signal);
      failed = true;
      ctx.logger?.warn?.(`dsh-archived-sessions: sessionQuery.listSessions() 失败：${errorText(error)}`);
    }
    return { meta, headers, failed };
  };

  /**
   * 投影缓存是否真的可用：诊断位（capabilities.projectionCache）与快路径准入
   * 必须用同一个谓词，否则 /status 会报 true 而标题其实全走了日志折叠。
   */
  const projectionCacheUsable = () => {
    const cache = ctx.get('sessionProjectionCache');
    return cache !== undefined && cache !== null && typeof cache.cachedSnapshot === 'function';
  };

  /**
   * 零 I/O 标题快路径：投影缓存的 listing 读。
   *
   * DSH 自己的会话列表给冷会话取标题走的就是这条路
   * （dsh-api-session-controller 的 `projectionsFor` →
   * `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0))`），
   * 而日志折叠（`readTitleSnapshots`）要为每个会话整份解码会话日志——本部署
   * 30 个归档会话 = 36.3 MB 压缩 / 120.5 MB 明文 / 27,456 个 zstd 帧，实测
   * 3.6–4.7 s，而这里命中只要毫秒级（30/30 实测 3.5 ms；32 条复核约 2 ms）。
   *
   * 只服务「有 header（identity 见证）+ 非 seeded + 非 live」的会话：
   *   - 没有 header 就没有身份可比，宁可不命中；
   *   - seeded 会话的 inherited cut 不在列表 header 里（出厂读法同样跳过）；
   *   - live 会话的内存态比 checkpoint 新，走日志折叠更准。
   * 记录可能落后日志尾（写盘节流 200 事件 / 5 s），但绑定了 lifecycle
   * identity，取到的标题不会来自别的会话；未命中的 id 一律回退日志折叠。
   * @returns {Map<string, {title: string, updatedAt: number|null}>} 命中的标题
   */
  const readCachedTitles = (ids, headers, liveIds) => {
    const hits = new Map();
    if (!projectionCacheUsable()) return hits;
    const cache = ctx.get('sessionProjectionCache');
    let warned = false;
    for (const id of ids) {
      const header = headers.get(id);
      if (header === undefined || header === null) continue;
      if (header.isSeeded === true) continue;
      if (liveIds.has(id)) continue;
      try {
        // 签名是 cachedSnapshot(meta, keys)：keys 只能省略或给**键名数组**。
        // v3 在这里传了 `0`（当成偏移量），`viewCheckpoint` 里的 `new Set(0)`
        // 抛 TypeError，异常被下面的 catch 吞掉 → 全部回退日志折叠（72 条 × 整份
        // 解码 ≈72 s）。出厂调用点同样不带第二个参数。
        let block = cache.cachedSnapshot(header);
        if (block === undefined && typeof cache.cachedPredecessorTitle === 'function') {
          // 记录里的行版本比当前投影旧时，出厂读法是退到「只给标题」的前身视图。
          block = cache.cachedPredecessorTitle(header);
        }
        const values = block !== null && typeof block === 'object' ? block.values : undefined;
        if (values === null || typeof values !== 'object') continue;
        const title = values.title;
        if (typeof title !== 'string' || title === '') continue;
        const metadata = values.sessionListMetadata;
        const lastPromptAt = metadata !== null && typeof metadata === 'object' && typeof metadata.lastPromptAt === 'number'
          ? metadata.lastPromptAt
          : null;
        const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null;
        // 与出厂会话列表同口径的「最近活动」：max(createdAt, lastPromptAt)；
        // 拿不到 lastPromptAt 时退回 createdAt（客户端活动排序的既有回落）。
        const updatedAt = lastPromptAt === null
          ? createdAt
          : (createdAt === null ? lastPromptAt : Math.max(createdAt, lastPromptAt));
        hits.set(id, { title, updatedAt });
      } catch (error) {
        if (!warned) {
          warned = true;
          ctx.logger?.warn?.(`dsh-archived-sessions: sessionProjectionCache 读取失败，本次全部回退日志折叠：${errorText(error)}`);
        }
      }
    }
    return hits;
  };

  /** 标题：投影缓存优先（零 I/O），未命中的 id 批量折叠（后端内部有界并发），最后逐条回退。 */
  const readTitles = async (query, ids, headers, liveIds, signal) => {
    const titles = new Map();
    const sources = { cache: 0, logFold: 0, missing: 0 };
    if (ids.length === 0) return { titles, sources };
    for (const [id, entry] of readCachedTitles(ids, headers, liveIds)) {
      titles.set(id, Object.assign({ source: 'cache' }, entry));
      sources.cache += 1;
    }
    const pending = ids.filter((id) => !titles.has(id));
    const canBatch = query !== undefined && typeof query.readTitleSnapshots === 'function';
    // 只有「批量不可用 / 整批抛错」才退到逐条：批量成功但某个 id 是 rejected（日志里
    // 没有 title 事件）时再逐条 readTitle，会把该会话的整份日志又解码一遍——v2 在批量
    // 成功时是直接返回的（entry-v2.js 的批量分支 `return titles`）；实测逐条路径
    // 30 个会话 = 15.8 s，是这条回退的真实代价。
    let batchFailed = false;
    if (pending.length > 0 && canBatch) {
      try {
        const results = await query.readTitleSnapshots(pending, signal);
        throwIfAborted(signal);
        for (const result of Array.isArray(results) ? results : []) {
          if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue;
          const observation = result.value;
          const snapshot = observation !== null && typeof observation === 'object' ? observation.title : undefined;
          if (snapshot === undefined || snapshot === null || typeof snapshot.title !== 'string') continue;
          titles.set(String(result.sessionId), {
            title: snapshot.title,
            updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
            source: 'logFold',
          });
        }
      } catch (error) {
        // 取消要往外抛；真正的读失败才退回逐条。
        throwIfAborted(signal);
        batchFailed = true;
        ctx.logger?.warn?.(`dsh-archived-sessions: sessionQuery.readTitleSnapshots() 失败，退回逐条读：${errorText(error)}`);
      }
    }
    if ((batchFailed || !canBatch) && query !== undefined && typeof query.readTitle === 'function') {
      for (const id of ids) {
        throwIfAborted(signal);
        if (titles.has(id)) continue;
        try {
          const snapshot = await query.readTitle(id, signal);
          if (snapshot !== null && snapshot !== undefined && typeof snapshot.title === 'string') {
            titles.set(id, {
              title: snapshot.title,
              updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
              source: 'logFold',
            });
          }
        } catch (error) {
          /* 标题缺失不阻塞列表；取消仍然要往外抛 */
          throwIfAborted(signal);
        }
      }
    }
    for (const id of ids) {
      const entry = titles.get(id);
      if (entry === undefined) sources.missing += 1;
      else if (entry.source === 'logFold') sources.logFold += 1;
    }
    return { titles, sources };
  };

  /**
   * 会话行视图。`titleUpdatedAt` 是**最近活动时间**（浏览器半边 client.js 的
   * activityOf 用它排序、并在「活动」列显示），v3 起两条标题路径的口径不同：
   *   - 投影缓存命中（绝大多数归档会话）：max(createdAt, sessionListMetadata.lastPromptAt)，
   *     即 DSH 侧边栏会话列表自己的「最近活动」口径（最后一次人类提问）；
   *   - 日志折叠（live / seeded / 缓存未命中）：最后一条 session/title 事件的时间。
   * 缓存行拿不到 title 事件时间（投影缓存里的 title 行只有 {ver, seq, val}），
   * 而 logFold 行拿不到 lastPromptAt，故两种时钟必然并存。实测 30 个归档会话：有符号差
   * 中位数 −2.8 s，逐条绝对差中位数 12.5 s（11 条 >60 s、2 条 >1 天）——两个方向都有。
   */
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

  const describeArchive = async ({ fresh = false, signal = undefined, idsKey: presetKey = undefined } = {}) => {
    throwIfAborted(signal);
    const ids = readArchivedIds();
    // 成员感知缓存键：归档集一变（新归档 / 恢复）立即作废，不必等 TTL 过期。
    // 用 JSON 而不是 join(',')：会话 id 里若真出现分隔符也不会撞键。
    // 在飞合并那条路会把同一个键传进来（键与 ids 必须出自同一次同步读取）。
    const idsKey = presetKey === undefined ? JSON.stringify(ids) : presetKey;
    const now = Date.now();
    if (!fresh && listCache !== null && listCache.idsKey === idsKey && now - listCache.at < options.listCacheMs) {
      return listCache.value;
    }
    const query = ctx.get('sessionQuery');
    const { meta, headers, failed } = await readSessionMeta(query, signal);
    const liveIds = new Set();
    for (const [id, entry] of meta) if (entry.live === true) liveIds.add(id);
    const { titles, sources } = await readTitles(query, ids, headers, liveIds, signal);
    throwIfAborted(signal);
    const { workspaces, source } = await readWorkspaces();
    throwIfAborted(signal);
    const views = ids.map((id) => toSessionView(id, meta.get(id), titles.get(id)));
    const grouped = groupByWorkspace(views, workspaces);
    // ── 设备网格：其它设备自己的归档会话也列进来（本机同 id 的以本机为准）──
    // 放在本机清单算完之后：网格采集慢/失败都只影响「远程那部分」，
    // 本机清单照常返回（readMeshArchived 自己带缓存与总预算）。
    const remoteCollection = await readMeshArchived(false);
    const localIds = new Set(ids);
    const remoteViews = [];
    for (const row of Array.isArray(remoteCollection.sessions) ? remoteCollection.sessions : []) {
      if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue;
      if (localIds.has(row.id)) continue;
      remoteViews.push({
        id: row.id,
        title: typeof row.title === 'string' ? row.title : null,
        titleUpdatedAt: typeof row.createdAt === 'number' ? row.createdAt : null,
        cwd: typeof row.cwd === 'string' ? row.cwd : null,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : null,
        live: row.live === true,
        persisted: row.persisted !== false,
        parentSession: row.parentSession === undefined ? null : row.parentSession,
        origin: row.origin === undefined ? null : row.origin,
        workspaceId: null,
        workspaceTitle: null,
        workspacePath: null,
        remote: true,
        deviceId: row.deviceId,
        deviceName: row.deviceName,
      });
    }
    if (remoteViews.length > 0) mergeRemoteViews(grouped, remoteViews);
    const flat = sortSessionViews(views.concat(remoteViews).map((view) => Object.assign({}, view)));
    const value = {
      generatedAt: now,
      totalArchived: ids.length,
      totalListed: views.length + remoteViews.length,
      totalRemote: remoteViews.length,
      workspaceSource: source,
      /** true＝listSessions() 读失败，这份清单缺 cwd/createdAt/live（渲染成「日志已删除」）。 */
      degraded: failed,
      /** 标题来源计数：cache=投影缓存（零 I/O）/ logFold=日志折叠 / missing=没有标题。 */
      titleSources: sources,
      /** 设备网格：远程来源的设备清单与诊断（浏览器半边据此画「远程」标记/提示）。 */
      remote: {
        source: remoteCollection.source,
        pending: remoteCollection.pending === true,
        devices: Array.isArray(remoteCollection.devices) ? remoteCollection.devices : [],
        problems: Array.isArray(remoteCollection.problems) ? remoteCollection.problems : [],
      },
      workspaces: grouped.workspaces,
      unassigned: grouped.unassigned,
      /** 兼容字段：平铺列表（历史客户端按此渲染）。 */
      sessions: flat,
      capabilities: {
        workspaceList: source === 'registry.list',
        sessionQuery: query !== undefined,
        titleBatch: query !== undefined && typeof query.readTitleSnapshots === 'function',
        projectionCache: projectionCacheUsable(),
        searchSessions: query !== undefined && typeof query.searchSessions === 'function',
        filterEvents: query !== undefined && typeof query.filterEvents === 'function',
      },
    };
    // 读失败那次不落缓存：缺 cwd/createdAt 的清单不是「数据」，缓存它会让面板在 TTL
    // 内一直显示「日志已删除」，下次请求本该能自愈（实测 v2 只缓存 5 s，v3 是 60 s）。
    if (failed) return value;
    // 并发 pass（fresh 与 cached 各一份）可能乱序完成：判新旧要用**pass 起始时刻**
    // （startedAt），不能用写入时刻——后起跑的 pass 读到的数据只会更新，它赢。
    if (listCache === null || listCache.startedAt <= now) {
      listCache = { startedAt: now, at: Date.now(), idsKey, value };
    }
    return value;
  };

  /**
   * 在飞合并 + 取消传播：同一 (fresh + 归档集成员) 键同一时刻只跑一份解码。
   *
   * 实测未合并时 1 个请求 4.4 s、3 个并发各 17 s、6 个并发各 41 s（重复点击、
   * 面板切走再切回、恢复后的刷新各跑一份）。这里让它们共享同一份；调用方自己的
   * signal 只影响「它还要不要等」——等待者归零（浏览器断开且没人还在等）时才取消
   * 共享的那份解码，避免无人要的工作继续烧 CPU；解码结果照常进 listCache。
   *
   * 键里必须带成员：恢复/新归档之后来的请求绝不能接到「变更之前起跑」的那一份上，
   * 否则会拿到仍含该会话的旧清单——而客户端的固定动作恰好落在这个窗口里
   * （恢复成功后立刻发 ?fresh=1 刷新，client.js:478）。
   */
  const listPasses = new Map();
  const describeArchiveShared = (fresh, signal) => {
    let idsKey = 'unknown';
    try {
      idsKey = JSON.stringify(readArchivedIds());
    } catch {
      /* 归档集不可读：让 pass 自己去抛（每次请求都会得到 500，不必合并成一份） */
    }
    const key = (fresh ? 'fresh' : 'cached') + '|' + idsKey;
    let pass = listPasses.get(key);
    // 已被取消的那一份不再复用：取消失效与 map 清理之间有一整个微任务窗口，
    // 期间来的调用方若接到它，只会收到一个 AbortError（没人取消它）。
    if (pass !== undefined && pass.controller.signal.aborted === true) pass = undefined;
    if (pass === undefined) {
      const controller = new AbortController();
      pass = { controller, waiters: 0, settled: false, promise: null };
      pass.promise = describeArchive({ fresh, signal: controller.signal, idsKey })
        .finally(() => {
          pass.settled = true;
          if (listPasses.get(key) === pass) listPasses.delete(key);
        });
      listPasses.set(key, pass);
    }
    pass.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      pass.waiters -= 1;
      // 只取消**还在跑**的那一份：跑完的 pass 不该被 abort（否则 signal 的
      // aborted 位会在事后翻真，事后回看日志/桩的人分不清谁真的取消过）。
      if (pass.waiters <= 0 && pass.settled === false) pass.controller.abort();
    };
    const racers = [pass.promise];
    let detach = null;
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      racers.push(new Promise((_resolve, reject) => {
        // 调用方的 signal 只决定「它还要不要等」；早退分支是防御性的
        // （唯一调用点刚建的 controller 不可能已 abort）。
        if (signal.aborted === true) {
          reject(abortError());
          return;
        }
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => {
          if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        };
      }));
    }
    const raced = racers.length === 1 ? pass.promise : Promise.race(racers);
    return raced.then(
      (value) => { if (detach !== null) detach(); release(); return value; },
      (error) => { if (detach !== null) detach(); release(); throw error; },
    );
  };

  // 插件被拆（patch 热重载）时不留在飞解码：路由注册有重试补位逻辑，
  // 说明重挂是常规路径，旧实例的解码不该在静默中跑完。
  ctx.effect(() => () => {
    for (const pass of listPasses.values()) if (pass.settled === false) pass.controller.abort();
    listPasses.clear();
  }, 'dsh-archived-sessions: in-flight list passes');

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
    const controller = new AbortController();
    // 浏览器断开（面板切走 / 刷新 / 关标签）→ 本调用方停止等待；没有别的等待者时
    // 共享解码也一起取消。res 'close' 在正常结束响应后也会触发，此时那一份早已
    // 完成，abort 是空操作。
    if (typeof res.on === 'function') res.on('close', () => controller.abort());
    describeArchiveShared(fresh, controller.signal)
      .then((value) => json(res, 200, value))
      .catch((error) => {
        if (controller.signal.aborted === true) return; // 客户端已经走了
        json(res, 500, { error: errorText(error) });
      });
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
        version: 5,
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
          projectionCache: projectionCacheUsable(),
          deviceMesh: ctx.get('deviceMesh') !== undefined,
        },
        /** 设备网格诊断：每台对端设备的采集来源（inventory / exec / unavailable）、
         *  归档条数与错误；`pending` = 上一轮采集超了 remoteBudgetMs（缓存未落）。 */
        mesh: {
          source: meshDiag.source ?? 'unknown',
          at: meshDiag.at,
          pending: meshDiag.pending === true,
          cacheAgeMs: meshCache === null ? null : Date.now() - meshCache.at,
          ttlMs: options.remoteCacheMs,
          budgetMs: options.remoteBudgetMs,
          exec: options.remoteExec,
          devices: meshDiag.devices,
          problems: meshDiag.problems,
        },
        listCache: listCache === null ? null : {
          ageMs: Date.now() - listCache.at,
          ttlMs: options.listCacheMs,
          listed: listCache.value.totalListed,
        },
        inflightPasses: [...listPasses.keys()],
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
