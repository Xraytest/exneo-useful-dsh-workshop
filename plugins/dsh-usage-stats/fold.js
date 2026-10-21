/**
 * fold — 用量折叠与聚合（纯函数，无 I/O、无 Cordis 依赖）。
 *
 * 唯一事实来源 = 会话日志折叠：实时路径与回填路径调用同一个 foldEvents，
 * 因此「插件上线前 / 上线后」的数字天然可加、可对账（同一条日志折两次结果相同）。
 *
 * 实测折叠口径（2026-10-08 本机 188 会话语料）：
 *   assistant/message   data.usage           → kind 'step'      （16857 条，主口径）
 *   assistant/attempt   data.stream 末尾 usage chunk → 'attempt'（447 条，含失败重试的计费）
 *   compaction/summary  data.{provider,model,usage} → 'compaction'（58 条，自带路由）
 *   request/header      data.header.config   → 更新当前路由（同一会话可换路由，310 处）
 *   session/title       data.title           → 记录标题
 * 无 usage 的 assistant/message（19 条，被打断的回合）不计入，只进 gaps 计数。
 * 子代理会话是独立日志（实测不含父事件前缀），继承前缀仍按 inheritedEventCount 跳过。
 */

export const K_STEP = 'step';
export const K_ATTEMPT = 'attempt';
export const K_COMPACTION = 'compaction';
export const K_AUX = 'aux';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * 事实是否带缓存数据。
 *
 * 本机实测（2026-10-09，对抗验证专门查过）：「没有缓存字段」在这套部署里大概率
 * 等于「这一跳真的没命中」——dsh-llm-pi-ai 走 openai-completions 的 mapUsage 时
 * 用 `usage.cacheRead > 0 ? {cacheReadTokens} : {}` 过滤，0 值字段**被整个丢掉**
 * （且实测这些 usage 的 totalTokens 恰好等于 it+ot，没有藏着命中量）。
 * 但插件是通用的：别的供应商可能既不上报又有命中，账本层分不出来。
 * 所以这里保持保守——一律记成「不可测」，由 cacheCoverage 如实标出覆盖了多少流量，
 * 绝不把「没字段」当成「0% 命中」（那样会在真的不上报的渠道上谎报）。
 *
 * 新事实有显式 `cacheKnown` 布尔（usage 里真有 cacheReadTokens/cacheWriteTokens 键，哪怕值都是 0）。
 * **老账本**（v6 之前写的 facts/*.json）没有这个字段，此时退回「有非零缓存值即视为
 * 有缓存数据」——否则整个历史账本会被误判成「无缓存数据」。
 *
 * 注意边界（不要写成「重建一次就全部收敛」）：
 *   - `重建全部` 只重折**日志事实**（logFacts），实时补记的 aux 事实按设计保留
 *     （index.js::resetForRefold），因此 v6 之前写入的那批 aux 事实永远拿不回
 *     `cacheKnown` —— 它们原始的 usage 键信息已不在事实里。
 *   - 这类事实若 cr=cw=0，只能判为「未知」（占比 null，显示「无缓存数据」）；
 *     若 cr>0 则由下面的回退恢复为「有数据」。两者都不改变任何总量数字。
 *   - v6 之后新写入的 aux 事实由 makeFact 正常盖章。
 */
export function factCacheKnown(fact) {
  if (!fact) return false;
  if (fact.cacheKnown === true) return true;
  if (fact.cacheKnown === false) return false;
  return fact.cr > 0 || fact.cw > 0;
}

/** usage 是否真的带了缓存字段（老日志没有这两个键；带了但都是 0 也算有数据）。 */
export function hasCacheFields(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return 'cacheReadTokens' in usage || 'cacheWriteTokens' in usage;
}

/** 与 dsh-model-pool 同一口径：有 totalTokens 用总账，否则四项相加。 */
export function mixedTotal(u) {
  if (!u) return 0;
  const total = num(u.totalTokens);
  if (total > 0) return total;
  return num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
}

export function makeFact(kind, time, provider, model, usage, extra) {
  return {
    t: typeof time === 'number' ? time : 0,
    k: kind,
    p: provider || 'unknown',
    m: model || 'unknown',
    it: num(usage && usage.inputTokens),
    ot: num(usage && usage.outputTokens),
    cr: num(usage && usage.cacheReadTokens),
    cw: num(usage && usage.cacheWriteTokens),
    rt: num(usage && usage.reasoningTokens),
    tt: mixedTotal(usage),
    // 缓存字段是否存在：用于区分「命中 0 次」与「没有缓存数据」（老日志）。
    cacheKnown: hasCacheFields(usage),
    ...(extra || {}),
  };
}

/** 「被来源边界排除的事实」计数（只用于 status 观测，不进任何聚合）。 */
function normalizeRemoteSkipped(value) {
  const facts = value && Number.isFinite(value.facts) && value.facts > 0 ? value.facts : 0;
  const tokens = value && Number.isFinite(value.tokens) && value.tokens > 0 ? value.tokens : 0;
  return { facts, tokens };
}

export function createFoldState(seed) {
  return {
    lastSeq: typeof (seed && seed.lastSeq) === 'number' ? seed.lastSeq : -1,
    route: (seed && seed.route) || null,
    title: (seed && seed.title) || null,
    logFacts: (seed && seed.logFacts) || [],
    auxFacts: (seed && seed.auxFacts) || [],
    gaps: Object.assign(
      { noUsageMessages: 0, searchRequests: 0, titleRequests: 0 },
      (seed && seed.gaps) || {},
    ),
    // 设备网格镜像的来源边界（见 mesh-mirror.js）：边界内的 usage 事实是**对端设备
    // 发出的请求**，被排除并在这里留痕（observation only）。老账本没有这个字段。
    remoteSkipped: normalizeRemoteSkipped(seed && seed.remoteSkipped),
  };
}

/** 取助手消息里最后一个 usage chunk（实测每条 attempt 流最多 1 个）。 */
export function lastUsageInStream(stream) {
  if (!Array.isArray(stream)) return null;
  let found = null;
  for (const rec of stream) {
    if (rec && rec.type === 'chunk' && rec.chunk && rec.chunk.type === 'usage' && rec.chunk.usage) {
      found = rec.chunk.usage;
    }
  }
  return found;
}

/**
 * 增量折叠：只处理 seq > state.lastSeq 的事件（日志只追加，故游标即幂等键）。
 * 返回新产生的事实条数。
 *
 * opts.inheritedBelow：fork 子会话的继承前缀切点，该前缀内的事件只用于承接路由/标题，
 * 不产生事实（前缀里的用量已记在父会话日志上）。
 *
 * opts.remoteBelow：设备网格镜像的**来源边界**（见 mesh-mirror.js）。执行端 sessions/
 * 里可能是对端设备会话的副本：seq <= remoteBelow 的事件是对端发出的请求，照常推进
 * 游标、承接路由与标题，但**不产生用量事实**（否则同一笔用量会在两台设备上各记一次）；
 * 边界之后的事件（本机接手/续跑）照常计。remoteBelow 缺省/负数 = 无边界（会话端本机）。
 */
export function foldEvents(state, events, opts = {}) {
  const inheritedBelow = Number.isFinite(opts.inheritedBelow) ? opts.inheritedBelow : 0;
  const remoteBelow = Number.isFinite(opts.remoteBelow) ? opts.remoteBelow : -1;
  let added = 0;
  for (const ev of events) {
    if (!ev || typeof ev.seq !== 'number') continue;
    if (ev.seq <= state.lastSeq) continue;
    const inherited = ev.seq < inheritedBelow;
    const remote = remoteBelow >= 0 && ev.seq <= remoteBelow;
    switch (ev.type) {
      case 'request/header': {
        const cfg = ev.data && ev.data.header && ev.data.header.config;
        if (cfg && typeof cfg.provider === 'string') {
          state.route = { provider: cfg.provider, model: typeof cfg.model === 'string' ? cfg.model : '' };
        }
        break;
      }
      case 'session/title': {
        const t = ev.data && ev.data.title;
        if (typeof t === 'string' && t) state.title = t;
        break;
      }
      case 'session/title-llm-request':
        if (!remote) state.gaps.titleRequests++;
        break;
      case 'web/deepseek-search-llm-request':
        // 已知缺口：联网搜索走原始 fetch，日志里不带 usage，无法恢复。
        if (!remote) state.gaps.searchRequests++;
        break;
      case 'assistant/message': {
        const usage = (ev.data && ev.data.usage) || lastUsageInStream(ev.data && ev.data.stream);
        if (!usage) { if (!inherited && !remote) state.gaps.noUsageMessages++; break; }
        if (!inherited) {
          if (remote) skipRemoteFact(state, usage);
          else {
            const r = state.route || {};
            state.logFacts.push(makeFact(K_STEP, ev.time, r.provider, r.model, usage));
            added++;
          }
        }
        break;
      }
      case 'assistant/attempt': {
        const usage = lastUsageInStream(ev.data && ev.data.stream);
        if (!usage) break;
        if (!inherited) {
          if (remote) skipRemoteFact(state, usage);
          else {
            const r = state.route || {};
            state.logFacts.push(makeFact(K_ATTEMPT, ev.time, r.provider, r.model, usage));
            added++;
          }
        }
        break;
      }
      case 'compaction/summary': {
        const usage = ev.data && ev.data.usage;
        if (!usage || inherited) break;
        if (remote) { skipRemoteFact(state, usage); break; }
        const p = (ev.data && ev.data.provider) || 'unknown';
        const m = (ev.data && ev.data.model) || 'unknown';
        state.logFacts.push(makeFact(K_COMPACTION, ev.time, p, m, usage));
        added++;
        break;
      }
      default:
        break;
    }
    state.lastSeq = ev.seq;
  }
  return added;
}

/** 被来源边界排除的一条事实：只累计到 observation 计数（不改变任何统计聚合）。 */
function skipRemoteFact(state, usage) {
  if (!state.remoteSkipped) state.remoteSkipped = { facts: 0, tokens: 0 };
  state.remoteSkipped.facts += 1;
  state.remoteSkipped.tokens += mixedTotal(usage);
}

/** 一次折完整个日志（回填 / selftest 用）。 */
export function foldLog(events, opts = {}) {
  const state = createFoldState(opts.seed);
  foldEvents(state, events, opts);
  return state;
}

/** 实时补记的辅助用量（日志不落 usage 的调用，如 session-title）。 */
export function addAuxFact(state, { purpose, provider, model, usage, time }) {
  state.auxFacts.push(
    makeFact(K_AUX, time, provider, model, usage, purpose ? { u: purpose } : undefined),
  );
}

/* -------------------------------------------------------------- 时间分桶 ---- */

const fmtCache = new Map();
function dayFormatter(timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}

/** epoch ms → 该 IANA 时区下的 YYYY-MM-DD。 */
export function dayKey(timeMs, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(new Date(timeMs));
  let y = '', m = '', d = '';
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y}-${m}-${d}`;
}

/** YYYY-MM-DD ± n 天（纯日历运算，不涉时区）。 */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 周边界键 = 该周 weekStart（0=周日，1=周一）那天的日期。 */
export function weekKey(dayK, weekStart = 1) {
  const [y, m, d] = dayK.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const delta = (dow - weekStart + 7) % 7;
  return addDays(dayK, -delta);
}

/** range → 起始日键（含当天）：1d / 7d / 30d / all。 */
export function rangeStartKey(range, nowMs, timeZone) {
  const today = dayKey(nowMs, timeZone);
  if (range === '1d') return today;
  const n = /^(\d+)d$/.exec(String(range || ''));
  if (n) return addDays(today, -(Number(n[1]) - 1));
  return null; // all
}

/**
 * 缓存占比（model-cap 口径）。
 *
 * DSH 的 usage 里 inputTokens 与 cacheReadTokens 互斥（未命中缓存的输入 /
 * 命中缓存的输入各自单独计），故：
 *   计费输入 billedInput = input + cacheRead + cacheWrite
 *   缓存占比 cacheShare  = (cacheRead + cacheWrite) / **measuredInput**
 *
 * 关键：分母只用**带缓存字段的那部分事实**（measuredInput）。有些路由/渠道的
 * usage 根本不上报 cacheRead/cacheWrite（实测 ModelScope 渠道的
 * `deepseek-ai/DeepSeek-V4.1-Flash` 整个语料 1808 条 usage 都不带这两个键），
 * 把这部分流量按「未命中」摊进分母等于把「没上报」当成 0% 命中——实测一个会话
 * 的真实命中率 96.4% 会被拖成 25.9%。所以：
 *   - cacheShare  = 实测命中率（只覆盖有上报的流量）；
 *   - coverage    = measuredInput / billedInput，告诉调用方这个数字覆盖了多少流量；
 *   - unknownInput= 没上报缓存状态的计费输入（token）。
 * measuredInput 为 0（该项完全没有可测流量）时 cacheShare 是 null，展示侧一律写
 * 「无缓存数据」，绝不当 0%——否则等于断言「一次都没命中」。
 */
export function cacheMetrics(row) {
  const r = row || {};
  const input = r.input || 0;
  const cacheRead = r.cacheRead || 0;
  const cacheWrite = r.cacheWrite || 0;
  const billedInput = input + cacheRead + cacheWrite;
  const cacheFacts = r.cacheKnownFacts || 0;
  // 只有聚合桶（addToRow 逐条累加出来的内部行）才有 cacheKnownFacts / cacheBilledInput。
  // 普通对象（比方外部调用方手搓的一行）没有这两个字段 → 视为「无可测流量」，
  // 占比给 null（展示成「无缓存数据」）而不是拿全量当分母硬算一个数出来。
  const measuredInput = cacheFacts > 0
    ? Math.min(Math.max(0, r.cacheBilledInput || 0), billedInput)
    : 0;
  const cached = cacheRead + cacheWrite;
  return {
    known: cacheFacts > 0,
    billedInput,
    measuredInput,
    unknownInput: Math.max(0, billedInput - measuredInput),
    cached,
    cacheShare: measuredInput > 0 ? cached / measuredInput : null,
    coverage: billedInput > 0 ? measuredInput / billedInput : null,
  };
}

/** 百分比展示（1 位小数；无数据返回 null）。 */
export function pct(share) {
  return typeof share === 'number' && Number.isFinite(share) ? (share * 100).toFixed(1) : null;
}

/* ---------------------------------------------------------------- 聚合 ---- */

const EMPTY_ROW = () => ({
  key: '', calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  reasoning: 0, total: 0, sessions: 0, _sessionSet: null, providers: null, kinds: null,
  // 带缓存字段的事实条数与其计费输入：0 = 该桶完全没有缓存数据（老日志），
  // >0 = 有数据（哪怕读/写都是 0，那也是真实命中的 0）。命中率只用这部分算。
  cacheKnownFacts: 0,
  cacheBilledInput: 0,
});

function addToRow(row, fact) {
  row.calls++;
  row.input += fact.it;
  row.output += fact.ot;
  row.cacheRead += fact.cr;
  row.cacheWrite += fact.cw;
  row.reasoning += fact.rt;
  row.total += fact.tt;
  // 该事实是否真的带了缓存字段（老日志根本没有这两个键）——逐项占比要能区分
  // 「命中 0 次」与「没有缓存数据」，所以不能用行上的 cr/cw 反推。
  // 老账本没有显式标记，由 factCacheKnown 退回非零值判定。
  if (factCacheKnown(fact)) {
    row.cacheKnownFacts++;
    // 只有这部分事实进入命中率的分母（见 cacheMetrics）。
    row.cacheBilledInput += (fact.it || 0) + (fact.cr || 0) + (fact.cw || 0);
  }
  if (fact.p) {
    if (!row.providers) row.providers = new Set();
    row.providers.add(fact.p);
  }
  if (fact.k) {
    if (!row.kinds) row.kinds = {};
    row.kinds[fact.k] = (row.kinds[fact.k] || 0) + 1;
  }
}

/**
 * 五维聚合。
 * sessions: [{ id, meta:{title,cwd,createdAt,parentSession,origin,archived}, logFacts, auxFacts }]
 * opts: { by, fromKey, toKey, timeZone, weekStart, attributeSubagents,
 *         groupOf, groupLabels, ungroupedKey, ungroupedLabel }   // by=group 用
 */
export function aggregate(sessions, opts = {}) {
  const by = opts.by || 'model';
  const tz = opts.timeZone || 'UTC';
  const weekStart = Number.isFinite(opts.weekStart) ? opts.weekStart : 1;
  const fromKey = opts.fromKey || null;
  const toKey = opts.toKey || null;
  const root = opts.attributeSubagents === 'root';
  // dsh-model-groups 接入：分组维度。opts.groupOf(provider, model) → 组 id（查询时解析，
  // 事实里不落组名）；缺省（或返回 null）归入未分组桶。
  const groupOf = typeof opts.groupOf === 'function' ? opts.groupOf : null;
  const ungroupedKey = typeof opts.ungroupedKey === 'string' && opts.ungroupedKey !== '' ? opts.ungroupedKey : '__ungrouped__';
  const groupLabels = opts.groupLabels !== null && typeof opts.groupLabels === 'object' ? opts.groupLabels : null;
  const ungroupedLabel = typeof opts.ungroupedLabel === 'string' && opts.ungroupedLabel !== '' ? opts.ungroupedLabel : '未分组';

  const map = new Map();
  const metaByKey = new Map();
  const seenSessions = new Map();
  let factsSeen = 0;

  for (const s of sessions) {
    const sid = root ? rootOf(s, sessions) : s.id;
    const all = s.logFacts.concat(s.auxFacts);
    let touched = false;
    for (const f of all) {
      const dk = dayKey(f.t, tz);
      if (fromKey && dk < fromKey) continue;
      if (toKey && dk > toKey) continue;
      factsSeen++;
      touched = true;
      let key;
      if (by === 'model') key = f.m;
      else if (by === 'provider') key = f.p;
      else if (by === 'group') key = (groupOf === null ? null : groupOf(f.p, f.m)) || ungroupedKey;
      else if (by === 'session') key = sid;
      else if (by === 'day') key = dk;
      else key = weekKey(dk, weekStart);
      let row = map.get(key);
      if (!row) { row = EMPTY_ROW(); row.key = key; map.set(key, row); }
      addToRow(row, f);
      if (by === 'session') {
        if (!row._sessionSet) row._sessionSet = new Set();
        row._sessionSet.add(sid);
      }
      if (by === 'model' || by === 'provider' || by === 'group' || by === 'week' || by === 'day') {
        if (!seenSessions.has(key)) seenSessions.set(key, new Set());
        seenSessions.get(key).add(sid);
      }
    }
    if (touched && by === 'session') metaByKey.set(sid, s.meta || {});
  }

  const rows = [...map.values()].map((row) => {
    const out = {
      key: row.key,
      calls: row.calls,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      reasoning: row.reasoning,
      total: row.total,
    };
    // 模型缓存占比（逐项口径，见 cacheMetrics）：分母只用带缓存字段的事实，
    // 另外给出覆盖度与「未上报缓存状态」的输入量。
    const metrics = cacheMetrics(row);
    out.cacheKnown = metrics.known;
    out.cacheFacts = row.cacheKnownFacts;
    out.cacheShare = metrics.cacheShare;
    out.cacheCoverage = metrics.coverage;
    out.cacheUnknownInput = metrics.unknownInput;
    if (by === 'session') {
      out.sessions = 1;
      const meta = metaByKey.get(row.key) || {};
      out.label = meta.title || row.key;
      Object.assign(out, {
        title: meta.title || null,
        cwd: meta.cwd || null,
        createdAt: meta.createdAt || null,
        parentSession: meta.parentSession || null,
        origin: meta.origin || null,
        archived: meta.archived === true,
      });
    } else {
      out.sessions = seenSessions.has(row.key) ? seenSessions.get(row.key).size : 0;
      if (row.providers && (by === 'model' || by === 'group')) out.providers = [...row.providers];
      if (row.kinds && by !== 'session') out.kinds = row.kinds;
      if (by === 'group') {
        out.ungrouped = row.key === ungroupedKey;
        out.label = out.ungrouped ? ungroupedLabel : ((groupLabels !== null && groupLabels[row.key]) || row.key);
      }
    }
    return out;
  });

  const timeDim = by === 'day' || by === 'week';
  rows.sort((a, b) => (timeDim ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : b.total - a.total));

  const totals = rows.reduce(
    (acc, r) => {
      acc.calls += r.calls; acc.input += r.input; acc.output += r.output;
      acc.cacheRead += r.cacheRead; acc.cacheWrite += r.cacheWrite;
      acc.reasoning += r.reasoning; acc.total += r.total;
      // 逐行求和即可：各页签的行是对全部事实的一个划分。
      acc.cacheKnownFacts += r.cacheFacts;
      acc.cacheBilledInput += (r.input + r.cacheRead + r.cacheWrite) - (r.cacheUnknownInput || 0);
      return acc;
    },
    {
      calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0,
      cacheKnownFacts: 0, cacheBilledInput: 0,
    },
  );
  const totalsMetrics = cacheMetrics(totals);
  totals.cacheKnown = totalsMetrics.known;
  totals.cacheShare = totalsMetrics.cacheShare;
  totals.cacheCoverage = totalsMetrics.coverage;
  totals.cacheUnknownInput = totalsMetrics.unknownInput;
  totals.billedInput = totalsMetrics.billedInput;
  totals.cached = totalsMetrics.cached;
  totals.cacheFacts = totals.cacheKnownFacts;
  const sessionIds = new Set();
  for (const s of sessions) {
    if (root) sessionIds.add(rootOf(s, sessions));
    else sessionIds.add(s.id);
  }
  totals.sessions = sessionIds.size;

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  for (const r of rows) r.share = r.total / maxTotal;
  return { by, timeZone: tz, weekStart, from: fromKey, to: toKey, facts: factsSeen, rows, totals };
}

function rootOf(session, sessions) {
  let cur = session;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (let i = 0; i < 32; i++) {
    const parent = cur.meta && cur.meta.parentSession;
    if (!parent) return cur.id;
    const next = byId.get(parent);
    if (!next) return cur.id;
    cur = next;
  }
  return cur.id;
}