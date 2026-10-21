/**
 * DSH 用量统计（dsh-usage-stats）— host 半边。
 *
 * 从 模型 / 供应商 / 会话 / 每日 / 每周 五个角度统计 token 用量；关键能力是
 * **恢复历史用量**：插件上线前的对话、以及对话归档（会话日志 / 导出的归档 zip）
 * 都能折出同一套事实，与上线后的实时记账可加、可对账。
 *
 * 事实来源（唯一口径 = 会话日志折叠，实时与回填共用 fold.js::foldEvents）：
 *   assistant/message.usage        → step       （主口径）
 *   assistant/attempt 流末尾 usage → attempt    （含失败重试的计费）
 *   compaction/summary             → compaction （自带 provider/model）
 *   request/header                 → 当前路由（同一会话可中途换模型/供应商）
 *   session/title                  → 会话标题
 * 实时补记（日志不落 usage，只在上线后可得；默认只记 session-title）：
 *   llm/stream waterfall with options.purpose ∈ config.liveOnlyPurposes
 *   —— compaction 必须排除（它的用量已在日志里，否则双计）。
 * 已知缺口（无法恢复，只在 status 里计数）：
 *   联网搜索 web/deepseek-search-llm-request（走原始 fetch，无 usage 字段）
 *   被打断、未产生 usage 的 assistant/message
 *
 * 设备网格镜像（只记「从当前设备发出的请求」）：
 *   执行端（按路径路由跑命令的那台）的 sessions/ 里可能有 dsh-device-mesh 同步来的
 *   **对端会话历史副本**（§12.9 sessionSync）。副本里的 usage 是对端设备发出的请求 →
 *   不计入本机账本（否则同一笔用量两台设备各记一次）。边界取接收端镜像索引
 *   `device-mesh/session-replica/index.json` 的 `syncedSeq ?? lastSeq`（见 mesh-mirror.js），
 *   边界之后本机接手/续跑的事件照常计。`/dsh-usage/status` 的 `mirrored` 块回报排除量；
 *   `config.excludeMirroredSessions=false` 可关闭。
 *
 * 标注名称（模型行的 label）：优先取 DSH 自带「模型设置」里的模型展示名
 * （llm.listProviders × listModels = 设置页 Models 表的运行时投影；
 *   name=id 视为未配置），解析顺序 config.modelAliases > 模型设置展示名 >
 * 内置表 > 兜底美化；key 永远是请求名，只换显示不合并。索引按 TTL 惰性刷新，
 * 成功后持久化到 store.meta.modelSettingsNames（离线 preview.mjs 复用同一份）。
 *
 * 存储：$DSH_HOME/usage-stats/{state.json,facts/<sessionId>.json}，原子写、游标幂等。
 *
 * 路由（均同源可用；写操作带同源守卫）：
 *   GET  /dsh-usage/summary?by=model|provider|session|day|week&range=all|1d|7d|30d
 *                           &from=YYYY-MM-DD|epochMs&to=…&tz=…&subagents=own|root
 *   GET  /dsh-usage/status
 *   POST /dsh-usage/rescan   {full?: boolean}
 *   GET  /dsh-usage/export.csv?…（与 summary 同参）
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: usage-stats
 *         name: ./plugins/dsh-usage-stats/entry-v10.js
 *         config: { timeZone: Asia/Shanghai, … }
 *
 * @module dsh-usage-stats
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  aggregate, addAuxFact, dayKey, foldEvents, rangeStartKey,
} from './fold.js?v=mirror-origin-1';
import { FactStore, msg } from './store.js?v=mirror-origin-1';
import {
  inheritedCutFromEvents, readLogFile, sessionLogsFromZip, sessionMetaFromHeader, walkSessionRoot,
} from './rawlog.js?v=mirror-origin-1';
import { floorFromIndex, loadMirrorIndex, normalizeSessionId } from './mesh-mirror.js?v=mirror-origin-1';

export const name = 'dsh-usage-stats';
// 别名辅助也导出，便于 selftest 直接校验（不影响运行时）；
// settingsNameLookup 直接以声明导出（preview.mjs 离线复用）。
export { aliasForModel, prettifyModelName, DEFAULT_MODEL_ALIASES };
export const inject = ['webServer'];

const BY = ['model', 'provider', 'group', 'session', 'day', 'week'];
/** by=group 的未分组桶键（与 dsh-model-groups/client.js 同常量）。 */
const UNGROUPED_KEY = '__ungrouped__';
const UNGROUPED_LABEL = '未分组';
/** 来源等级：会话语料 > 备份根目录 > 归档 zip（同一 id 只按最高等级计一次）。 */
const RANK = { zip: 0, root: 1, corpus: 2, live: 2 };

const DEFAULTS = {
  timeZone: null,                    // null → 跟随系统时区
  weekStart: 1,                      // 0=周日, 1=周一
  liveOnlyPurposes: ['session-title'], // 实时才拿得到的辅助调用（compaction 必须排除）
  attributeSubagents: 'own',         // own=子代理单列；root=归到根会话
  extraSessionRoots: [],             // 追加的 sessions 根目录（另一个 DSH home / 备份）
  zipImportDirs: [],                 // 存放导出归档 *.zip 的目录
  modelAliases: {},                  // 模型别名表（覆盖内置默认；键 = 请求名）
  modelNamesTtlMs: 30000,            // 「模型设置」展示名索引的刷新间隔（请求驱动）
  flushIntervalMs: 5000,
  autoBackfill: true,
  maxRows: 500,
  // 设备网格镜像：执行端 sessions/ 里对端会话的副本不计入本机账本（见 mesh-mirror.js）。
  excludeMirroredSessions: true,
};

/**
 * 内置模型别名（本机实际出现的模型 + 常见写法）。
 * 只是显示名：统计行的 key 永远是**请求名**（日志里 provider/model 的原样字符串），
 * 所以悬停/CSV/接口都还能看到原始请求名，且不会把不同写法的请求合并计账。
 */
const DEFAULT_MODEL_ALIASES = {
  'deepseek-ai/deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash': 'DeepSeek V4.1 Flash',
  'step-5-preview': 'Step 5 Preview',
  'mimo-v2.6-flash-free': 'MiMo v2.6 Flash（免费）',
  'qwen/qwen3.8-27b:free': 'Qwen3.8 27B（免费）',
};

/** 词元大小写修正表（用于没有配别名的模型名，尽量好看一点）。 */
const BRAND_CASE = {
  deepseek: 'DeepSeek', qwen: 'Qwen', mimo: 'MiMo', glm: 'GLM', llama: 'Llama', gemma: 'Gemma',
  mistral: 'Mistral', gpt: 'GPT', claude: 'Claude', kimi: 'Kimi', minimax: 'MiniMax', doubao: 'Doubao',
  ernie: 'ERNIE', step: 'Step', grok: 'Grok', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku',
  flash: 'Flash', pro: 'Pro', turbo: 'Turbo', mini: 'Mini', nano: 'Nano', preview: 'Preview',
  free: 'Free', instruct: 'Instruct', thinking: 'Thinking', reasoner: 'Reasoner', coder: 'Coder',
};

/** 请求名里 `:tag` 后缀的中文写法（与内置别名表口径一致）。 */
const TAG_LABELS = {
  free: '免费', premium: '高级', beta: '测试版', exp: '实验版', preview: '预览版',
  thinking: '思考', reasoning: '推理', latest: '最新', turbo: '加速',
};

/**
 * 无别名时的兜底显示名：取请求名最后一段，`:tag` 变括号后缀（free → 免费），
 * `-`/`_` 分词后按表修正大小写（`deepseek-v4.1-flash` → `DeepSeek V4.1 Flash`）。
 */
function prettifyModelName(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '') return String(raw);
  const slash = text.lastIndexOf('/');
  let body = slash >= 0 ? text.slice(slash + 1) : text;
  let suffix = '';
  const colon = body.lastIndexOf(':');
  if (colon > 0) {
    const tag = body.slice(colon + 1);
    const label = TAG_LABELS[tag.toLowerCase()];
    suffix = '（' + (label !== undefined ? label : tag) + '）';
    body = body.slice(0, colon);
  }
  const words = body.split(/[-_\s]+/).filter((w) => w !== '').map((word) => {
    const m = /^([A-Za-z]+)(.*)$/.exec(word);
    if (m === null) return word;
    const known = BRAND_CASE[m[1].toLowerCase()];
    const head = known !== undefined ? known : m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return head + m[2];
  });
  return words.join(' ') + suffix;
}

/**
 * 请求名 → 显示别名（配置表 > 模型设置展示名 > 内置表 > 兜底美化）。
 *
 * settingsName：DSH 自带「模型设置」（Settings → Models，settings.yaml 的
 * llm-pi-ai.providers.*.models[].name）里配置的模型展示名，由运行时从
 * llm.listModels 枚举的索引传入（见 settingsNameLookup）。llm-pi-ai 对未配置
 * name 的模型回退 name=id，索引侧已把 name=id 视为未配置，这里再挡一层空白。
 * 统计行的 key 永远是请求名——别名只换显示，不改统计键，不同写法不合并。
 */
function aliasForModel(raw, table, settingsName) {
  const key = String(raw === undefined || raw === null ? '' : raw);
  if (table !== undefined && table !== null && Object.prototype.hasOwnProperty.call(table, key)) {
    const custom = table[key];
    if (typeof custom === 'string' && custom.trim() !== '') return custom.trim();
  }
  if (typeof settingsName === 'string' && settingsName.trim() !== '') return settingsName.trim();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_MODEL_ALIASES, key)) return DEFAULT_MODEL_ALIASES[key];
  return prettifyModelName(key);
}

/**
 * 从「模型设置」名称索引构造查找函数；运行时缓存与离线 preview.mjs 共用同一份
 * 持久化形状（store.meta.modelSettingsNames）。
 *
 * names 形状：
 *   { byModel: { 请求名: 展示名 },            // 全局兜底（首个供应商命中）
 *     byRoute: { 供应商: { 请求名: 展示名 } }, // 同名模型在不同供应商下各有展示名
 *     providers: { 供应商: 展示名 } }          // 供应商 displayName（by=provider 行用）
 *
 * 返回 (key, providers?) → 展示名 | undefined：先按行内供应商精确匹配（统计行
 * 的 providers 列表），全部未命中再退全局表；坏形状一律安全退化为查不到。
 */
export function settingsNameLookup(names) {
  if (names === null || typeof names !== 'object') return () => undefined;
  const byModel = names.byModel !== null && typeof names.byModel === 'object' ? names.byModel : null;
  const byRoute = names.byRoute !== null && typeof names.byRoute === 'object' ? names.byRoute : null;
  const pick = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  return (key, providers) => {
    if (Array.isArray(providers) && byRoute !== null) {
      for (const p of providers) {
        const routes = byRoute[p];
        if (routes !== null && typeof routes === 'object') {
          const hit = pick(routes[key]);
          if (hit !== undefined) return hit;
        }
      }
    }
    return byModel !== null ? pick(byModel[key]) : undefined;
  };
}


function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const out = [];
  for (const v of value) if (typeof v === 'string' && v.trim() !== '') out.push(v.trim());
  return out;
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const opt = Object.assign({}, DEFAULTS);
  if (typeof c.timeZone === 'string' && c.timeZone.trim() !== '') opt.timeZone = c.timeZone.trim();
  if (Number.isInteger(c.weekStart) && c.weekStart >= 0 && c.weekStart <= 6) opt.weekStart = c.weekStart;
  opt.liveOnlyPurposes = stringList(c.liveOnlyPurposes, DEFAULTS.liveOnlyPurposes);
  if (c.attributeSubagents === 'root' || c.attributeSubagents === 'own') opt.attributeSubagents = c.attributeSubagents;
  opt.extraSessionRoots = stringList(c.extraSessionRoots, []);
  opt.zipImportDirs = stringList(c.zipImportDirs, []);
  if (Number.isFinite(c.flushIntervalMs) && c.flushIntervalMs >= 500) opt.flushIntervalMs = c.flushIntervalMs;
  if (c.autoBackfill === false) opt.autoBackfill = false;
  if (c.excludeMirroredSessions === false) opt.excludeMirroredSessions = false;
  if (Number.isInteger(c.maxRows) && c.maxRows > 0) opt.maxRows = c.maxRows;
  if (c.modelAliases !== null && typeof c.modelAliases === 'object' && !Array.isArray(c.modelAliases)) {
    for (const [key, value] of Object.entries(c.modelAliases)) {
      if (typeof key === 'string' && key !== '' && typeof value === 'string' && value.trim() !== '') {
        opt.modelAliases[key] = value.trim();
      }
    }
  }
  if (Number.isFinite(c.modelNamesTtlMs) && c.modelNamesTtlMs >= 5000) opt.modelNamesTtlMs = c.modelNamesTtlMs;
  return opt;
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/* ------------------------------------------------------------- HTTP 小件 ---- */

function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function text(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'cache-control': 'no-store' }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** 同源守卫（与 dsh-archived-sessions 同款）：lanmode 会把 Origin/Host 一起重写成
 *  loopback，故 LAN 客户端同样通过；无 Origin 的本机 curl 放行。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseBound(value, tz) {
  if (typeof value !== 'string' || value === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return dayKey(n, tz);
  return null;
}

/* ---------------------------------------------------------------- 主体 ---- */

/**
 * 建插件主体；返回句柄（selftest 直接调它，无需真 Cordis）。
 */
export function createUsageStats(ctx, config = {}) {
  const opt = normalizeConfig(config);
  const dir = path.join(dshHome(), 'usage-stats');
  const store = new FactStore(dir).loadSync();
  const tz = () => opt.timeZone || systemTimeZone();

  const backfill = {
    running: false,
    startedAt: null,
    finishedAt: null,
    scanned: 0, folded: 0, skipped: 0, imported: 0, recovered: 0, notes: [],
    errors: [],
  };
  let disposed = false;

  /* --------------------------------- 设备网格镜像（来源边界） ---- */
  //
  // 执行端（按路径路由跑命令的那台）的 sessions/ 里，可能有 dsh-device-mesh 同步来的
  // **对端会话历史副本**（§12.9 sessionSync）。那些副本里的 usage 是对端设备发出的
  // 请求，本机账本不该记（本机接手/续跑之后新增的事件才由本机发出，照常计）。
  // 边界来自接收端镜像索引 device-mesh/session-replica/index.json 的
  // syncedSeq ?? lastSeq（见 mesh-mirror.js）。索引不存在 = 没有镜像 → 不排除。
  const MIRROR_INDEX_TTL_MS = 30000;
  const mirrorCache = { at: 0, index: null };

  function mirrorIndex(force = false) {
    if (opt.excludeMirroredSessions !== true) return null;
    const now = Date.now();
    if (!force && mirrorCache.index !== null && now - mirrorCache.at < MIRROR_INDEX_TTL_MS) {
      return mirrorCache.index;
    }
    try {
      mirrorCache.index = loadMirrorIndex(dshHome());
    } catch (error) {
      mirrorCache.index = { available: false, path: '', error: msg(error), byId: new Map(), devices: [] };
    }
    mirrorCache.at = now;
    return mirrorCache.index;
  }

  /** 会话 → 来源边界（-1 = 不是镜像副本 / 拿不到边界）。 */
  function mirrorFloorOf(id) {
    if (opt.excludeMirroredSessions !== true) return -1;
    return floorFromIndex(mirrorIndex(), id);
  }

  function floorOfEntry(entry) {
    return entry !== null && entry !== undefined && typeof entry.remoteBelow === 'number'
      ? entry.remoteBelow
      : -1;
  }

  /** 把来源边界写到账本条目上（普通会话不落这个字段）。 */
  function applyFloor(entry, floor) {
    if (floor >= 0) entry.remoteBelow = floor;
    else delete entry.remoteBelow;
  }

  /* --------------------------------- 模型设置（DSH 自带）展示名索引 ---- */
  //
  // 标注名称优先用「模型设置」（Settings → Models）里配置的模型展示名：
  // llm.listProviders() × llm.listModels() 就是设置页那张表的运行时投影
  //（pi-ai 侧 name = providers.*.models[].name，provider name = displayName）。
  // llm-pi-ai 对未配置 name 的模型回退 name=id——这类条目**视为未配置**，
  // 让标签落到 内置表 / 兜底美化，绝不把展示名退化成原始请求名。
  // 索引按 TTL 惰性刷新（请求驱动，无定时器，dispose 无需额外清理）；
  // 刷新成功后写入 store.meta.modelSettingsNames，离线 preview.mjs 读同一份，
  // 两边展示名一致。

  const MODEL_NAMES_TIMEOUT_MS = 3000;
  const modelNamesState = { at: 0, names: null, providers: {}, pending: null, error: null, available: false };

  function llmService() {
    try {
      const service = ctx.get('llm');
      return service !== undefined && typeof service.listProviders === 'function'
        && typeof service.listModels === 'function'
        ? service
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function buildModelNameIndex() {
    const byModel = {};
    const byRoute = {};
    const providers = {};
    const llm = llmService();
    if (llm === undefined) return { available: false, byModel, byRoute, providers };
    let list = [];
    // 供应商目录都读不到 = 索引不可用（如实报告，别把「空目录」冒充「已枚举」）
    try { list = llm.listProviders() || []; } catch { return { available: false, byModel, byRoute, providers }; }
    for (const entry of list) {
      const pid = String((entry && entry.id) || '');
      if (pid === '') continue;
      const pname = String((entry && entry.name) || '').trim();
      if (pname !== '' && pname !== pid) providers[pid] = pname;
      let models = [];
      try { models = (await llm.listModels(pid)) || []; } catch { continue; }
      const routes = byRoute[pid] || (byRoute[pid] = {});
      for (const model of models) {
        const id = String((model && model.id) || '');
        const name = String((model && model.name) || '').trim();
        // name === id 视为未配置展示名（pi-ai 的缺省回退就是 id 本身）
        if (id === '' || name === '' || name === id) continue;
        routes[id] = name;
        // hasOwnProperty 防「模型 id 恰为 toString 等原型链键」误判命中
        if (!Object.prototype.hasOwnProperty.call(byModel, id)) byModel[id] = name;
      }
    }
    return { available: true, byModel, byRoute, providers };
  }

  /** 刷新「模型设置」展示名索引（TTL 惰性、单飞；成功后持久化到账本 meta）。 */
  async function refreshModelNames(force = false) {
    if (!force && modelNamesState.names !== null && Date.now() - modelNamesState.at < opt.modelNamesTtlMs) {
      return modelNamesState;
    }
    if (modelNamesState.pending !== null) return modelNamesState.pending.catch(() => modelNamesState);
    const task = (async () => {
      const index = await buildModelNameIndex();
      modelNamesState.at = Date.now();
      modelNamesState.names = { byModel: index.byModel, byRoute: index.byRoute };
      modelNamesState.providers = index.providers;
      modelNamesState.available = index.available;
      modelNamesState.error = null;
      try {
        // 持久化到账本 meta：离线 preview 与下一次冷启动立刻可用同一份名称。
        store.meta.modelSettingsNames = {
          at: modelNamesState.at,
          available: index.available,
          byModel: index.byModel,
          byRoute: index.byRoute,
          providers: index.providers,
        };
        store.markMetaDirty();
      } catch { /* 持久化失败不影响查询 */ }
      return modelNamesState;
    })();
    modelNamesState.pending = task;
    try {
      return await task;
    } catch (error) {
      // 失败：保留旧索引继续用；记时间戳避免每次请求都重试打爆。
      modelNamesState.at = Date.now();
      modelNamesState.error = msg(error);
      return modelNamesState;
    } finally {
      if (modelNamesState.pending === task) modelNamesState.pending = null;
    }
  }

  /** 路由侧入口：等一次（最多 3s）新鲜索引；失败/超时都用现有缓存继续。 */
  async function ensureModelNames() {
    try {
      await Promise.race([
        refreshModelNames(),
        new Promise((resolve) => {
          const t = setTimeout(resolve, MODEL_NAMES_TIMEOUT_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch { /* 刷新异常绝不影响统计接口 */ }
  }

  /* ----------------------------------------------------------- 折叠入口 ---- */

  function resetForRefold(entry) {
    const { state } = entry;
    state.lastSeq = -1;
    state.route = null;
    state.logFacts = [];
    state.gaps = { noUsageMessages: 0, searchRequests: 0, titleRequests: 0 };
    state.remoteSkipped = { facts: 0, tokens: 0 };
    // 注意：auxFacts 是实时补记的、日志里没有，重折时必须保留。
  }

  function foldInto(entry, events, inheritedBelow) {
    const added = foldEvents(entry.state, events, {
      inheritedBelow: inheritedBelow || 0,
      // 镜像副本的来源边界：≤ 边界的事实是对端发出的请求，不计（见 mesh-mirror.js）。
      remoteBelow: floorOfEntry(entry),
    });
    entry.foldedAt = Date.now();
    store.markDirty(entry.id);
    return added;
  }

  function headerOf(session) {
    const h = (session && session.header) || {};
    return sessionMetaFromHeader({
      id: session && session.id,
      createdAt: h.createdAt,
      cwd: h.cwd,
      parentSession: h.parentSession,
      origin: h.origin,
      delegationDepth: h.delegationDepth,
      agentPreset: h.agentPreset,
      isSeeded: h.isSeeded,
    }, session && session.id);
  }

  /** 采纳一个运行中的会话（apply 时对已有会话、以及 session/created 时调用）。 */
  function adoptLive(session) {
    if (!session || typeof session.id !== 'string') return;
    const entry = store.entry(session.id);
    const inherited = typeof session.inheritedEventCount === 'number' ? session.inheritedEventCount : 0;
    const floor = mirrorFloorOf(session.id);
    const floorChanged = floor !== floorOfEntry(entry);
    if ((entry.state.lastSeq >= 0 && entry.source && RANK[entry.source] < RANK.live) || floorChanged) {
      resetForRefold(entry);
    }
    applyFloor(entry, floor);
    let events = [];
    try {
      const fromSeq = entry.state.lastSeq + 1;
      events = fromSeq > 0 ? session.snapshotEvents(fromSeq) : session.snapshotEvents();
    } catch { events = []; }
    entry.header = Object.assign({}, headerOf(session), entry.header || {});
    if (!entry.source || RANK[entry.source] < RANK.live) entry.source = 'live';
    foldInto(entry, events, inherited);
  }

  function onSessionEvent(session, event) {
    if (!session || typeof session.id !== 'string' || !event) return;
    const entry = store.entry(session.id);
    // 边界变了只改边界、不重折（重折要从日志整份来，由下一次回填做；这里只折这一条，
    // 它本身就是刚发生的事件）。
    const floor = mirrorFloorOf(session.id);
    if (floor !== floorOfEntry(entry)) applyFloor(entry, floor);
    if (!entry.header) entry.header = headerOf(session);
    if (!entry.source) entry.source = 'live';
    const inherited = typeof session.inheritedEventCount === 'number' ? session.inheritedEventCount : 0;
    foldInto(entry, [event], inherited);
  }

  /* --------------------------------------------------------- 语料回填 ---- */

  function adoptCorpus(id, snapshot, sizeBytes, force) {
    const entry = store.entry(id);
    const rank = entry.source ? RANK[entry.source] : -1;
    const switchingSource = entry.source !== null && rank < RANK.corpus;
    // 镜像副本的来源边界变化（首次识别 / 网格又同步了一轮）必须重折，否则旧事实还在。
    const floor = mirrorFloorOf(id);
    const floorChanged = floor !== floorOfEntry(entry);
    if (force || switchingSource || floorChanged) resetForRefold(entry);
    applyFloor(entry, floor);
    const meta = sessionMetaFromHeader(snapshot && snapshot.session, id);
    entry.header = Object.assign({}, meta, entry.header || {});
    entry.source = 'corpus';
    if (typeof sizeBytes === 'number') entry.sizeBytes = sizeBytes;
    const events = (snapshot && snapshot.events) || [];
    const inherited = snapshot && typeof snapshot.inheritedEventCount === 'number'
      ? snapshot.inheritedEventCount
      : inheritedCutFromEvents(events);
    return foldInto(entry, events, inherited);
  }

  function adoptImport(id, header, events, source, sourceRef) {
    const entry = store.entry(id);
    const rank = entry.source ? RANK[entry.source] : -1;
    if (rank >= RANK[source]) return null; // 已有更高等级来源（语料优先），不重复计
    resetForRefold(entry);
    // 显式导入通道（extraSessionRoots / zip）也按会话来源判：同一会话在本机是镜像副本时
    // （说明它的请求由对端发出），导入的也是同一份对端历史，同样不计。
    applyFloor(entry, mirrorFloorOf(id));
    entry.header = Object.assign({}, sessionMetaFromHeader(header, id), entry.header || {});
    entry.source = source;
    const added = foldInto(entry, events, inheritedCutFromEvents(events));
    entry._sourceRef = sourceRef;
    return added;
  }

  /**
   * 语料读取失败时的兜底：直接在 $DSH_HOME/sessions（以及 extraSessionRoots）里
   * 按会话 id 找原始日志折叠。走的是同一个 rawlog + fold.js，口径与语料一致；
   * 返回新增事实数，找不到日志返回 null。
   */
  let logIndex = null;
  function findSessionLog(id) {
    if (logIndex === null) {
      logIndex = new Map();
      const roots = [path.join(dshHome(), 'sessions'), ...opt.extraSessionRoots];
      for (const root of roots) {
        let files = [];
        try { files = walkSessionRoot(root); } catch { continue; }
        for (const file of files) if (!logIndex.has(file.sessionId)) logIndex.set(file.sessionId, file.filePath);
      }
    }
    return logIndex.get(id) || null;
  }

  function adoptFromLog(id, sizeBytes, force) {
    const filePath = findSessionLog(id);
    if (filePath === null) return null;
    let parsed;
    let stat = null;
    try {
      parsed = readLogFile(filePath);
      stat = fs.statSync(filePath);
    } catch (error) {
      backfill.errors.push({ id, error: `原始日志回退失败：${filePath}: ${msg(error)}` });
      return null;
    }
    const entry = store.entry(id);
    const floor = mirrorFloorOf(id);
    const floorChanged = floor !== floorOfEntry(entry);
    if (force || floorChanged) resetForRefold(entry);
    applyFloor(entry, floor);
    const header = parsed.header !== null && parsed.header !== undefined
      ? Object.assign({}, parsed.header, { id })
      : { id };
    entry.header = Object.assign({}, sessionMetaFromHeader(header, id), entry.header || {});
    entry.source = 'corpus';
    if (stat !== null) entry.sizeBytes = stat.size;
    else if (typeof sizeBytes === 'number') entry.sizeBytes = sizeBytes;
    const added = foldInto(entry, parsed.events, inheritedCutFromEvents(parsed.events));
    store.markDirty(id);
    return added;
  }

  async function importRoots(force) {
    const imports = store.meta.imports || (store.meta.imports = {});
    for (const root of opt.extraSessionRoots) {
      let files = [];
      try { files = walkSessionRoot(root); } catch (error) {
        backfill.errors.push({ id: `root:${root}`, error: msg(error) });
        continue;
      }
      for (const file of files) {
        if (disposed) return;
        let stat;
        try { stat = fs.statSync(file.filePath); } catch { continue; }
        const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        const known = imports[file.filePath];
        if (!force && known && known.key === key) { backfill.skipped++; continue; }
        backfill.scanned++;
        try {
          const parsed = readLogFile(file.filePath);
          const id = (parsed.header && typeof parsed.header.id === 'string' && parsed.header.id)
            || file.sessionId;
          if (!id) { backfill.errors.push({ id: file.filePath, error: '无法确定会话 id' }); continue; }
          const existing = store.entries.get(id);
          if (existing && existing.source && RANK[existing.source] >= RANK.root && !force) {
            imports[file.filePath] = { id, key };
            backfill.skipped++;
            continue;
          }
          const added = adoptImport(id, parsed.header, parsed.events, 'root', file.filePath);
          imports[file.filePath] = { id, key };
          if (added !== null) backfill.imported++;
        } catch (error) {
          backfill.errors.push({ id: file.filePath, error: msg(error) });
        }
      }
    }
  }

  async function importZips(force) {
    const imports = store.meta.imports || (store.meta.imports = {});
    for (const zipDir of opt.zipImportDirs) {
      let names = [];
      try { names = fs.readdirSync(zipDir).filter((n) => /\.zip$/i.test(n)); } catch (error) {
        backfill.errors.push({ id: `zip:${zipDir}`, error: msg(error) });
        continue;
      }
      for (const base of names) {
        if (disposed) return;
        const file = path.join(zipDir, base);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const key = `${stat.size}:${Math.round(stat.mtimeMs)}`;
        if (!force && imports[file] && imports[file].key === key) { backfill.skipped++; continue; }
        try {
          const logs = sessionLogsFromZip(fs.readFileSync(file));
          for (const log of logs) {
            const id = (log.header && typeof log.header.id === 'string' && log.header.id) || log.fallbackId;
            if (!id) { backfill.errors.push({ id: `${base}:${log.entryName}`, error: '无法确定会话 id' }); continue; }
            const added = adoptImport(id, log.header, log.events, 'zip', `${file}#${log.entryName}`);
            if (added !== null) backfill.imported++;
          }
          imports[file] = { id: null, key };
        } catch (error) {
          backfill.errors.push({ id: file, error: msg(error) });
        }
      }
    }
  }

  async function runBackfill({ full = false } = {}) {
    if (backfill.running) return { started: false, reason: '已在回填中' };
    backfill.running = true;
    backfill.startedAt = Date.now();
    backfill.finishedAt = null;
    backfill.scanned = 0; backfill.folded = 0; backfill.skipped = 0; backfill.imported = 0;
    backfill.recovered = 0;
    backfill.errors = [];
    backfill.notes = [];
    // 回填是「来源边界」的权威时刻：强制重读镜像索引（执行端每轮同步都会改它）。
    mirrorCache.at = 0;
    try {
      const sizeById = new Map();
      const persistence = ctx.get('sessionPersistence');
      if (persistence !== undefined) {
        try {
          const snapshots = await persistence.list();
          for (const snap of snapshots) {
            if (!snap || !snap.header || snap.header.id === undefined) continue;
            if (typeof snap.sizeBytes === 'number') sizeById.set(String(snap.header.id), snap.sizeBytes);
          }
        } catch (error) {
          backfill.errors.push({ id: '*', error: `sessionPersistence.list: ${msg(error)}` });
        }
      }
      const query = ctx.get('sessionQuery');
      if (query === undefined) {
        backfill.errors.push({
          id: '*',
          error: 'sessionQuery 服务不可用：本次只处理 extraSessionRoots / zipImportDirs；'
            + '会话日志回填需要该服务（web profile 由 session-query-sqlite 提供）',
        });
      }
      if (query !== undefined) {
        let records = [];
        try { records = await query.listSessions(); } catch (error) {
          backfill.errors.push({ id: '*', error: `sessionQuery.listSessions: ${msg(error)}` });
        }
        for (const record of records) {
          if (disposed) break;
          const header = record && record.header;
          if (!header || header.id === undefined) continue;
          const id = String(header.id);
          backfill.scanned++;
          const entry = store.entries.get(id);
          const size = sizeById.get(id);
          // 镜像边界变了必须重折：网格每同步一轮都可能把边界往后推，旧事实要按新边界清掉。
          const floorChanged = mirrorFloorOf(id) !== floorOfEntry(entry);
          if (!full && !floorChanged && entry && entry.source && RANK[entry.source] >= RANK.corpus
              && typeof size === 'number' && entry.sizeBytes === size && entry.state.lastSeq >= 0) {
            backfill.skipped++;
            continue;
          }
          try {
            const snapshot = await query.readSession(id);
            adoptCorpus(id, snapshot, size, full);
            backfill.folded++;
          } catch (error) {
            // 语料读取失败时（已见：seeded 会话在 session 侧报
            // "constructor seed must equal its inherited prefix"）改为直接读原始日志折叠：
            // 同一份 fold.js、同一口径，避免这些会话整块漏账。
            const recovered = adoptFromLog(id, size, full);
            if (recovered !== null) {
              backfill.folded++;
              backfill.recovered++;
              backfill.notes.push({
                id,
                note: `语料读取失败，已按原始日志折叠（${recovered} 条事实）：${msg(error)}`,
              });
            } else {
              backfill.errors.push({ id, error: msg(error) });
            }
          }
          if (backfill.scanned % 8 === 0) await new Promise((r) => setImmediate(r));
        }
      }
      await importRoots(full);
      await importZips(full);
    } finally {
      backfill.running = false;
      backfill.finishedAt = Date.now();
      store.meta.backfill = {
        startedAt: backfill.startedAt,
        finishedAt: backfill.finishedAt,
        scanned: backfill.scanned,
        folded: backfill.folded,
        skipped: backfill.skipped,
        imported: backfill.imported,
        recovered: backfill.recovered,
        notes: backfill.notes.slice(0, 20),
        errors: backfill.errors.slice(0, 50),
      };
      store.markMetaDirty();
      store.flushSync();
    }
    return { started: true, stats: backfillStats() };
  }

  function backfillStats() {
    return {
      running: backfill.running,
      scanned: backfill.scanned,
      folded: backfill.folded,
      skipped: backfill.skipped,
      imported: backfill.imported,
      recovered: backfill.recovered,
      notes: backfill.notes.slice(0, 20),
      errors: backfill.errors.slice(0, 50),
      last: store.meta.backfill,
    };
  }

  /* ------------------------------------------------------------ 查询 ---- */

  function archivedSet() {
    try {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined) return new Set();
      const raw = registry.archivedSessionIds !== undefined
        ? registry.archivedSessionIds
        : (registry.state !== undefined ? registry.state.archivedSessionIds : undefined);
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch { return new Set(); }
  }

  function buildSessions() {
    const archived = archivedSet();
    const live = new Set();
    try {
      for (const session of ctx.sessions.list()) live.add(String(session.id));
    } catch { /* 无会话服务时按全离线处理 */ }
    const out = [];
    for (const entry of store.entries.values()) {
      const h = entry.header || {};
      out.push({
        id: entry.id,
        meta: {
          title: entry.state.title || null,
          cwd: h.cwd || null,
          createdAt: h.createdAt || null,
          parentSession: h.parentSession || null,
          origin: h.origin || null,
          archived: archived.has(entry.id),
          live: live.has(entry.id),
          source: entry.source || null,
        },
        logFacts: entry.state.logFacts,
        auxFacts: entry.state.auxFacts,
      });
    }
    return out;
  }

  // dsh-model-groups 接入：分组维度（可选依赖）。服务来自 dsh-model-groups；插件不在线时
  // 一律返回 null → 整个维度退化为单个「未分组」行（接口不报错、不改行为）。
  // 每次查询现取，插件热重载/后挂载都能跟上。
  function groupService() {
    try {
      const service = ctx.get('modelGroups');
      return service !== undefined && typeof service.resolve === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  }

  function groupResolver() {
    const service = groupService();
    if (service === undefined) return null;
    const labels = {};
    try {
      for (const group of service.list()) labels[group.id] = group.name || group.id;
    } catch { /* 名字拿不到不影响分桶 */ }
    return {
      labels,
      of: (provider, model) => {
        try {
          const hit = service.resolve(provider, model);
          return hit === null || hit === undefined ? null : hit.groupId;
        } catch {
          return null;
        }
      },
    };
  }

  function summaryPayload(searchParams) {
    const byRaw = searchParams.get('by');
    const by = BY.includes(byRaw) ? byRaw : 'model';
    const zone = searchParams.get('tz') || tz();
    const subagentsRaw = searchParams.get('subagents');
    const subagents = subagentsRaw === 'root' || subagentsRaw === 'own' ? subagentsRaw : opt.attributeSubagents;
    const range = searchParams.get('range') || 'all';
    const fromKey = parseBound(searchParams.get('from'), zone)
      || (range === 'all' ? null : rangeStartKey(range, Date.now(), zone));
    const toKey = parseBound(searchParams.get('to'), zone);
    const groupIndex = by === 'group' ? groupResolver() : null;
    const result = aggregate(buildSessions(), {
      by, fromKey, toKey, timeZone: zone, weekStart: opt.weekStart, attributeSubagents: subagents,
      groupOf: groupIndex === null ? null : groupIndex.of,
      groupLabels: groupIndex === null ? null : groupIndex.labels,
      ungroupedKey: UNGROUPED_KEY,
      ungroupedLabel: UNGROUPED_LABEL,
    });
    if (by === 'group') result.ungroupedKey = UNGROUPED_KEY;
    const limitRaw = Number(searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : opt.maxRows;
    const truncated = result.rows.length > limit;
    result.rows = result.rows.slice(0, limit);
    if (by === 'model') {
      // key 保持请求名（悬停 / CSV / 接口都能看到原样），label 换成别名。
      // 标注名优先级：config.modelAliases > 模型设置展示名（DSH 自带）> 内置表 > 兜底美化。
      const lookup = settingsNameLookup(modelNamesState.names);
      result.rows = result.rows.map((row) => {
        const settingsName = lookup(row.key, row.providers) || null;
        const alias = aliasForModel(row.key, opt.modelAliases, settingsName === null ? undefined : settingsName);
        return Object.assign({}, row, {
          model: row.key,
          alias,
          label: alias,
          settingsName,
        });
      });
    } else if (by === 'provider') {
      // 供应商行同样用「模型设置」里的 provider displayName（如 localhost → NewAPIGate）；
      // 没配置 displayName 的行保持原样（label = key）。
      const providerNames = modelNamesState.providers;
      result.rows = result.rows.map((row) => {
        const name = typeof providerNames[row.key] === 'string' ? providerNames[row.key].trim() : '';
        return Object.assign({}, row, { label: name !== '' ? name : row.key });
      });
    }
    result.truncated = truncated;
    result.generatedAt = Date.now();
    result.subagents = subagents;
    result.units = 'tokens';
    return result;
  }

  function statusPayload() {
    const s = store.stats();
    return {
      schema: 1,
      now: Date.now(),
      dir,
      timeZone: tz(),
      weekStart: opt.weekStart,
      config: {
        timeZone: opt.timeZone,
        weekStart: opt.weekStart,
        liveOnlyPurposes: opt.liveOnlyPurposes,
        attributeSubagents: opt.attributeSubagents,
        extraSessionRoots: opt.extraSessionRoots,
        zipImportDirs: opt.zipImportDirs,
        flushIntervalMs: opt.flushIntervalMs,
        modelAliases: Object.assign({}, DEFAULT_MODEL_ALIASES, opt.modelAliases),
        modelNamesTtlMs: opt.modelNamesTtlMs,
        excludeMirroredSessions: opt.excludeMirroredSessions,
      },
      modelSettings: {
        available: modelNamesState.available,
        providers: Object.keys(modelNamesState.providers).length,
        models: modelNamesState.names !== null ? Object.keys(modelNamesState.names.byModel).length : 0,
        updatedAt: modelNamesState.at > 0 ? modelNamesState.at : null,
        error: modelNamesState.error,
        names: modelNamesState.names !== null ? modelNamesState.names.byModel : null,
      },
      sessions: {
        total: s.sessions,
        withFacts: s.withFacts,
        folded: s.folded,
        bySource: s.bySource,
      },
      facts: { log: s.logFacts, aux: s.auxFacts, total: s.logFacts + s.auxFacts },
      // 设备网格镜像：本机 sessions/ 里对端会话副本的来源边界（见 mesh-mirror.js）。
      // excludedFacts/excludedTokens = 按边界被排除的用量（对端发出的请求），
      // 它们不计入上面的 facts / 任何聚合，只在这里留痕供核对。
      mirrored: (() => {
        const index = mirrorIndex();
        if (index === null) {
          return {
            enabled: false,
            available: false,
            sessions: 0,
            synced: 0,
            unknownBoundary: 0,
            devices: [],
            excludedSessions: 0,
            excludedFacts: 0,
            excludedTokens: 0,
            note: 'config.excludeMirroredSessions=false：设备网格同步来的会话历史副本会被计入本机账本。',
          };
        }
        let excludedSessions = 0;
        for (const entry of store.entries.values()) {
          if (entry.state.lastSeq < 0) continue;
          if (index.byId.has(normalizeSessionId(entry.id))) excludedSessions++;
        }
        let synced = 0;
        let unknownBoundary = 0;
        for (const item of index.byId.values()) {
          if (item.synced === true) synced++;
          if (item.boundary === 'unknown') unknownBoundary++;
        }
        return {
          enabled: true,
          available: index.available,
          source: index.path,
          error: index.error,
          sessions: index.byId.size,
          synced,
          unknownBoundary,
          devices: index.devices,
          excludedSessions,
          excludedFacts: s.remoteSkipped.facts,
          excludedTokens: s.remoteSkipped.tokens,
          note: '网格镜像：执行端 sessions/ 里对端会话副本的请求由对端设备发出，按 syncedSeq/lastSeq '
            + '边界排除、不计入本机账本；边界之后本机接手/续跑产生的事件照常计入。'
            + '索引不存在 = 本机没收到过镜像，不做任何排除。'
            + (unknownBoundary > 0 ? `另有 ${unknownBoundary} 条镜像记录拿不到边界（很老的索引条目），按不排除处理。` : ''),
        };
      })(),
      groups: (() => {
        const service = groupService();
        if (service === undefined) return { available: false, groups: 0, ungroupedKey: UNGROUPED_KEY };
        try { return { available: true, groups: service.list().length, ungroupedKey: UNGROUPED_KEY }; } catch { return { available: true, groups: 0, ungroupedKey: UNGROUPED_KEY }; }
      })(),
      cache: (() => {
        // 缓存占比口径说明：inputTokens 与 cacheReadTokens 互斥（未命中/命中各自计），
        // 且分母**只算带缓存字段的流量**——有些渠道根本不上报缓存，把没上报的流量
        // 按「未命中」摊进分母会把真实命中率稀释掉（实测 96.4% → 25.9%）。
        // 注意别叫 known：它只表示「已经折叠到任何事实」，与有没有缓存数据无关
        // （哪怕整库事实都没有缓存字段它也是 true）。
        const hasFacts = s.logFacts > 0 || s.auxFacts > 0;
        return {
          metric: 'cacheShare',
          note: 'cacheShare = (cacheRead+cacheWrite) / 可测计费输入；可测 = 该流量带 cacheReadTokens/cacheWriteTokens 字段。'
            + 'cacheCoverage = 可测计费输入 / 全部计费输入（计费输入 = input+cacheRead+cacheWrite）；'
            + 'cacheUnknownInput = 未上报缓存状态的计费输入。可测流量为 0 时 cacheShare=null（界面显示「无缓存数据」，不当 0%）。'
            + '两者均按【每一项】各自计算（每个模型/供应商/分组/会话/日/周），不是总量口径。',
          hasFacts,
        };
      })(),
      gaps: {
        noUsageMessages: s.gaps.noUsageMessages,
        searchRequests: s.gaps.searchRequests,
        titleRequests: s.gaps.titleRequests,
        note: 'search=联网搜索调用（原始 fetch，无 usage，无法恢复）；noUsageMessages=被打断、未产生用量的事件；titleRequests=日志中的标题生成请求（其用量只能实时补记）',
      },
      backfill: backfillStats(),
      pendingWrites: store.pending,
      loadErrors: store.loadErrors.slice(0, 20),
    };
  }

  /* ------------------------------------------------------------ 路由 ---- */

  const routes = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage/status',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
        try {
          await ensureModelNames();
          return json(res, 200, statusPayload());
        } catch (error) { return json(res, 500, { error: msg(error) }); }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage/summary',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
        try {
          await ensureModelNames();
          const url = new URL(req.url || '/', 'http://localhost');
          return json(res, 200, summaryPayload(url.searchParams));
        } catch (error) { return json(res, 500, { error: msg(error) }); }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage/export.csv',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
        try {
          await ensureModelNames();
          const url = new URL(req.url || '/', 'http://localhost');
          const payload = summaryPayload(url.searchParams);
          // 新列一律**追加在末尾**：老的位置解析器（第 10 列 = sessions）不受影响。
          const head = ['key', 'label', 'calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'sessions',
            'cacheShare', 'cacheCoverage'];
          const lines = [head.join(',')];
          for (const row of payload.rows) {
            lines.push([
              row.key, row.label || row.key, row.calls, row.input, row.output,
              row.cacheRead, row.cacheWrite, row.reasoning, row.total, row.sessions,
              // 百分比两位小数；无实测流量（cacheShare=null）留空而不是 0。
              row.cacheShare === null || row.cacheShare === undefined ? '' : (row.cacheShare * 100).toFixed(2),
              row.cacheCoverage === null || row.cacheCoverage === undefined ? '' : (row.cacheCoverage * 100).toFixed(2),
            ].map(csvEscape).join(','));
          }
          return text(res, 200, `${lines.join('\n')}\n`, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="dsh-usage-${payload.by}-${dayKey(Date.now(), payload.timeZone)}.csv"`,
          });
        } catch (error) { return json(res, 500, { error: msg(error) }); }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-usage/rescan',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
        if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
        readBody(req).then((body) => {
          let args = {};
          if (body !== '') {
            try { args = JSON.parse(body); } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
          }
          const full = args !== null && typeof args === 'object' && args.full === true;
          runBackfill({ full }).then(
            (r) => json(res, 200, r),
            (error) => json(res, 500, { error: msg(error) }),
          );
        }).catch(() => json(res, 400, { error: 'body 读取失败' }));
      },
    }),
  ];

  /* ------------------------------------------------------- 生命周期 ---- */

  ctx.on('session/created', (session) => { adoptLive(session); });
  ctx.on('session/event', (session, event) => { onSessionEvent(session, event); });
  ctx.on('session/flush', () => { try { store.flushSync(); } catch { /* 由定时器兜底 */ } });

  ctx.on('llm/stream', async function* usageStatsStream(options, next) {
    const purpose = options && options.purpose;
    const sessionId = options && typeof options.sessionId === 'string' ? options.sessionId : null;
    if (sessionId === null || typeof purpose !== 'string' || !opt.liveOnlyPurposes.includes(purpose)) {
      for await (const chunk of next()) yield chunk;
      return;
    }
    let usage = null;
    for await (const chunk of next()) {
      if (chunk && chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
      yield chunk;
    }
    try {
      if (usage) {
        const entry = store.entry(sessionId);
        addAuxFact(entry.state, {
          purpose,
          provider: options.provider,
          model: options.model,
          usage,
          time: Date.now(),
        });
        store.markDirty(sessionId);
      }
    } catch { /* 统计失败绝不能影响 LLM 调用 */ }
  });

  const timer = setInterval(() => {
    if (store.pending > 0) { try { store.flushSync(); } catch { /* 下一轮再试 */ } }
  }, opt.flushIntervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  let backfillTimer = null;
  if (opt.autoBackfill) {
    backfillTimer = setTimeout(() => { void runBackfill({ full: false }); }, 400);
    if (backfillTimer && typeof backfillTimer.unref === 'function') backfillTimer.unref();
  }

  // apply 时已在运行的会话：构造期 seed 不会走 session/event，必须显式采纳。
  try {
    for (const session of ctx.sessions.list()) adoptLive(session);
  } catch { /* 会话服务不可用时跳过 */ }

  const dispose = () => {
    disposed = true;
    for (const r of routes) { try { if (typeof r === 'function') r(); } catch { /* ignore */ } }
    if (timer) clearInterval(timer);
    if (backfillTimer) clearTimeout(backfillTimer);
    try { store.flushSync(); } catch { /* ignore */ }
  };
  ctx.effect(() => dispose, 'dsh-usage-stats: dispose');

  return {
    opt, store, dir,
    runBackfill, statusPayload, summaryPayload, buildSessions,
    refreshModelNames, ensureModelNames,
    adoptLive, onSessionEvent, flush: () => store.flushSync(),
    dispose,
  };
}

export function apply(ctx, config = {}) {
  return createUsageStats(ctx, config);
}