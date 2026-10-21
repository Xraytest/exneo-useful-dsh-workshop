/**
 * 模型分组（dsh-model-groups）— host 半边。
 *
 * 一个「分组」= 一组 (provider, model) 匹配式（支持 `*` / `?` 通配），组成员
 * **允许跨供应商**。分组是「模型集合」这一概念的唯一权威定义，供其它插件按需
 * 消费：
 *   - dsh-usage-stats：新增 `by=group` 维度，把用量按组归并（见 README 的接入契约）；
 *   - dsh-model-retry：规则可用 `group` 选中一组模型，对整组下一套重试策略。
 *
 * 归属语义（互斥，详见 ./resolve.js 头部）：enabled 组按 (priority 升序, 声明顺序)
 * 排出解析次序，**第一个命中的组胜出**；未命中任何组的模型归入统计口径里的
 * 「未分组」。每个 (provider, model) 路由最多属于一个组——这样统计里各组之和
 * 恒等于总量，重试规则命中唯一确定。
 *
 * 运行期接口（服务名 `modelGroups`，由本插件 ctx.provide）：
 *   revision(): number
 *   list(): Group[]                       深拷贝，带 order（解析次序，1 起）
 *   ids(): string[]
 *   resolve(provider, model): Resolution|null    同步、带 TTL 缓存的快路径
 *   explain(provider, model): {winner, candidates}
 * 浏览器接口（同源相对路径，写操作带同源守卫）：
 *   GET  /dsh-model-groups/state
 *   POST /dsh-model-groups/groups   {groups:[…]}
 *   POST /dsh-model-groups/resolve  {provider, model} | {routes:[…]}
 *   GET  /dsh-model-groups/audit[?fresh=1]
 *   GET  /dsh-model-groups/ui                     折叠状态（UI 偏好）只读回显
 *   POST /dsh-model-groups/ui       {collapsed:[组 id…]}  覆盖写折叠状态
 *
 * 存储：
 *   $DSH_HOME/model-groups.json     分组本体（原子写：tmp + rename）；
 *   $DSH_HOME/model-groups-ui.json  设置页的折叠状态（UI 偏好，独立文件，
 *     绝不混进分组本体——分组文件是要被统计/重试消费的 schema 1 契约）。
 *   折叠项按**组 id**记账（uid 只活在浏览器本次会话里，刷新即换），
 *   归一化宽松：非法项丢弃并回报 issues，坏文件按「全部展开」处理（不影响分组）。
 * 热生效：解析快路径带缓存（默认 1000ms TTL，TTL 内纯内存、不做任何 I/O）；
 * TTL 到期后先比 (mtime,size)，相同时仍以「至多每秒一次」的频率把文件读出来比内容签名
 * ——同尺寸改写落在同一时间戳粒度内、或 mtime 被 cp -p / utimes 保留时也能热生效；
 * 设置页保存（POST）后强制重载——改分组立即影响统计与重试，无需重启。
 * 坏文件韧性：JSON 语法错、以及「JSON 合法但形状非法」（根不是对象 / 缺少或不是 groups
 * 数组 / schema 不认识）一律保留上次可用快照 + 告警；只有结构合法、某个组不规范才走
 * 逐组归一化 + issues。
 *
 * 组合行（profile 的 cordis.patch.yml；**name 随热挂入口变化**，见 README §9）：
 *   - insert:
 *       - id: model-groups
 *         name: ./plugins/dsh-model-groups/entry-v5.js
 * 该行**不传 config**：全部走 normalizeConfig 的缺省（cacheTtlMs 1000 等）。
 *
 * @module dsh-model-groups
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import {
  ID_RE, LIMITS, SCHEMA, compileGroups, emptyDocument, explainRoute, normalizeDocument, pairKey, resolveRoute,
} from './resolve.js?v=ui-2';   // 热挂版本标记：换 entry 时让新图重新求值本模块

export const name = 'dsh-model-groups';
export const inject = ['webServer'];

/**
 * (mtime, size) 都没变时的内容核对节流：至多每秒把文件读出来比一次内容签名（H2）。
 * 文件只有几 KB，读+哈希成本可忽略；关键是「同尺寸改写落在同一时间戳粒度内」
 * 和「mtime 被 cp -p / utimes 保留」这两种情况下，只看 stat 会永远读到旧归属。
 */
const CONTENT_RECHECK_MS = 1000;

/** 内容签名：用来识别「时间戳没变但内容变了」。 */
function contentSignature(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 缺省配置文件：$DSH_HOME/model-groups.json。 */
function defaultPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'model-groups.json');
}

/** 缺省折叠状态文件：与分组文件同目录的 model-groups-ui.json。 */
function defaultUiPath(groupsPath) {
  return join(dirname(groupsPath), 'model-groups-ui.json');
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const opt = {
    file: defaultPath(),
    uiFile: '',            // 空 = 跟随 file 的目录（见下）
    cacheTtlMs: 1000,
    auditTtlMs: 60000,
    maxCatalogRoutes: 2000,
  };
  if (typeof c.file === 'string' && c.file.trim() !== '') opt.file = c.file.trim();
  if (typeof c.uiFile === 'string' && c.uiFile.trim() !== '') opt.uiFile = c.uiFile.trim();
  if (opt.uiFile === '') opt.uiFile = defaultUiPath(opt.file);
  if (Number.isFinite(c.cacheTtlMs) && c.cacheTtlMs >= 0) opt.cacheTtlMs = Math.min(60000, c.cacheTtlMs);
  if (Number.isFinite(c.auditTtlMs) && c.auditTtlMs >= 0) opt.auditTtlMs = Math.min(600000, c.auditTtlMs);
  if (Number.isInteger(c.maxCatalogRoutes) && c.maxCatalogRoutes > 0) opt.maxCatalogRoutes = Math.min(20000, c.maxCatalogRoutes);
  return opt;
}

const msg = (error) => String((error && error.message) || error);

/**
 * 有界目录创建（**不要**换回 mkdirSync(dir, {recursive:true})）。
 *
 * Node v22.23.3 实测：对 procfs 这类「父目录不存在、且 mkdir 对缺失父目录返回 ENOENT
 * 而不是 EPERM」的文件系统，recursive mkdir 会**永不返回**——同步调用占死唯一的 JS
 * 线程，整个 DSH（GUI + 会话）冻结，既不抛错也不打日志，只能重启进程。
 * 逐级非递归创建把这种路径变成立刻抛出的 ENOENT，落进既有的 500 / 告警分支。
 *
 * @param {string} dir 目标目录（相对路径按进程 cwd 解析）
 */
export function ensureDirSync(dir) {
  const absolute = resolve(dir);
  if (absolute === sep) return;
  let current = sep;
  for (const part of absolute.slice(1).split(sep)) {
    if (part === '') continue;
    current = current === sep ? sep + part : current + sep + part;
    if (existsSync(current)) continue;
    try {
      mkdirSync(current);          // 非递归：失败立刻抛（procfs → ENOENT，不再死循环）
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;   // 并发创建：谁先谁赢
    }
    if (!existsSync(current)) throw new Error(`无法创建目录：${current}`);
  }
}

/** 原子写 JSON（tmp + rename）。rename 失败时清掉 tmp，避免在配置目录留下垃圾。 */
function atomicWriteJson(path, value) {
  ensureDirSync(dirname(path));
  const tmp = path + '.tmp-' + randomUUID();
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力而为：清理失败不掩盖原始错误 */ }
    throw error;
  }
}

/**
 * 建插件主体；返回句柄（selftest 直接调它，无需真 Cordis）。
 */
/** 本文件的构建标记（变更时递增；GET /dsh-model-groups/state 会回报）。 */
export const BUILD = 'ui-2';

/**
 * 本模块的**真实身份**：`index.js?v=ui-2`（带 query）。
 *
 * `build` 只是文件里的常量，而 entry-v2/v3/v4/… 都指向同一个 index.js 物理文件
 * （只是 query 不同）——光看 build 分不清 patch 行指向哪份 entry、哪个 `?v=` 标记，
 * 回滚没生效时也会看到同一个 build（假阳性）。`import.meta.url` 带得住 query，
 * 才是「线上跑的是哪张图」的可观测证据。
 */
function implTag() {
  try {
    const url = String(import.meta.url || '');
    const at = url.lastIndexOf('/');
    return at >= 0 ? url.slice(at + 1) : url;
  } catch {
    return '';
  }
}

/** 折叠状态文件自己的 schema（与分组本体的 SCHEMA 各管一份文件，互不影响）。 */
export const UI_SCHEMA = 1;

/** 折叠项上限：一项对应一个组，跟分组数上限同量级即可（多出来的按截断处理）。 */
export const MAX_COLLAPSED = LIMITS.maxGroups;

/**
 * 折叠状态归一化（**宽松**，与分组本体的「严格写入」刻意不同）：
 *   - 只保留「像组 id 的字符串」——trim + 小写、匹配 ID_RE、长度 ≤ maxIdChars；
 *   - 去重、排序（排序让「同一集合」有唯一的落盘表示，客户端与服务端的键才能直接比）；
 *   - 超过 MAX_COLLAPSED 截断；丢弃与截断都记进 issues（不抛错）。
 * 形状非法（根不是对象 / collapsed 不是数组）同样不抛错，按空处理并记 issue：
 * 这是一个纯 UI 偏好文件，坏内容的正确降级是「全部展开」，不该连累分组本体。
 *
 * @param {unknown} raw 解析后的 JSON
 * @returns {{collapsed: string[], revision: number, issues: string[]}}
 */
export function normalizeUiState(raw) {
  const issues = [];
  const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const source = isPlain(raw) ? raw : {};
  if (!isPlain(raw)) issues.push('折叠状态文件根不是对象：按「全部展开」处理');
  const rawList = Array.isArray(source.collapsed) ? source.collapsed : [];
  if (source.collapsed !== undefined && !Array.isArray(source.collapsed)) {
    issues.push('collapsed 不是数组：按「全部展开」处理');
  }
  const seen = new Set();
  const collapsed = [];
  for (const item of rawList) {
    if (typeof item !== 'string') {
      issues.push(`折叠项 ${String(item)}（类型 ${typeof item}）不是字符串：已忽略`);
      continue;
    }
    const id = item.trim().toLowerCase();
    if (id === '' || id.length > LIMITS.maxIdChars || !ID_RE.test(id)) {
      issues.push(`折叠项 "${item}" 不是合法组 id（需匹配 ${ID_RE.source}，≤ ${LIMITS.maxIdChars} 字符）：已忽略`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    collapsed.push(id);
  }
  collapsed.sort();
  if (collapsed.length > MAX_COLLAPSED) {
    issues.push(`折叠项 ${collapsed.length} 个超过上限 ${MAX_COLLAPSED}：已截断`);
    collapsed.length = MAX_COLLAPSED;
  }
  const revision = Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
  return { collapsed, revision, issues };
}

export function createModelGroups(ctx, config = {}) {
  const opt = normalizeConfig(config);
  // 护栏：uiFile 与 file 撞成同一路径时，一次 POST /ui 就会把分组本体覆盖成 UI 偏好
  // 文档（运行中靠「坏文件保留快照」侥幸活着，重启后分组静默全空）。配错一次代价太大，
  // 这里直接退回缺省派生路径并告警——宁可折叠状态换个地方存，也不碰分组文件。
  if (resolve(opt.uiFile) === resolve(opt.file)) {
    ctx.logger?.warn?.(`dsh-model-groups: uiFile 与 file 指向同一路径（${opt.file}），已退回 ${defaultUiPath(opt.file)}；折叠状态绝不写进分组本体`);
    opt.uiFile = defaultUiPath(opt.file);
  }
  const path = opt.file;

  /** 快照：文件内容的解析产物 + 编译后的解析次序表 + 路由解析记忆。 */
  let snapshot = {
    exists: false,
    mtimeMs: -1,
    size: -1,
    checkedAt: 0,            // 上次「查过盘」的时刻（TTL 快路径的闸门）
    contentCheckedAt: 0,     // 上次真正读过文件内容的时刻（H2 的每秒节流）
    contentSignature: '',    // 上次可用快照对应的文件内容签名
    revision: 0,
    groups: [],          // 归一化后的组（文件顺序）
    compiled: [],        // 解析次序表（仅 enabled）
    issues: [],
    loadError: null,
    memo: new Map(),     // 路由 → Resolution|null，换快照即换表（键用 pairKey，不会撞）
  };

  /** 读盘原文；文件不存在返回 null（=没有文件，按空文档处理）。 */
  function readText() {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * 读盘并刷新快照。ttlMs 内不做任何 I/O（快路径：统计逐事实解析、重试每次失败）。
   *
   * 三条判定：
   *   1. force（设置页保存、GET /state）总是立即重读 → 保存后立刻生效；
   *   2. (mtime,size) 变了 → 重读重建；
   *   3. (mtime,size) 没变 → 仍以「至多每秒一次」的频率把文件读出来比对内容签名（H2），
   *      内容一致什么都不做，不一致则重建快照；
   *   4. 文件读到了但 JSON 语法错 **或形状非法**（根不是对象 / 缺少或不是 groups 数组 /
   *      schema 不认识）→ 一律按坏文件处理：保留上次可用快照 + 记 warnings（H1）。
   *      只有「结构合法、某个组有问题」才走逐组归一化 + issues。
   */
  function load(force = false) {
    const now = Date.now();
    if (!force && now - snapshot.checkedAt < opt.cacheTtlMs) return snapshot;
    let stat = null;
    try {
      stat = statSync(path);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        snapshot = { ...snapshot, checkedAt: now, loadError: msg(error) };
        return snapshot;
      }
    }
    const size = stat ? stat.size : -1;
    const mtimeMs = stat ? stat.mtimeMs : -1;
    if (stat === null && !snapshot.exists) {
      snapshot = { ...snapshot, checkedAt: now, loadError: null };
      return snapshot;
    }

    let text = null;   // 非 null = 本次已在下面读过内容（用于与快照比对签名）
    if (!force && stat !== null && mtimeMs === snapshot.mtimeMs && size === snapshot.size) {
      if (now - snapshot.contentCheckedAt < Math.min(CONTENT_RECHECK_MS, opt.cacheTtlMs)) {
        snapshot = { ...snapshot, checkedAt: now };     // 节流：本次只续期，不读内容
        return snapshot;
      }
      try { text = readText(); } catch { text = null; }  // 读失败交给下面的统一错误处理
      if (text !== null && contentSignature(text) === snapshot.contentSignature && snapshot.loadError === null) {
        snapshot = { ...snapshot, checkedAt: now, contentCheckedAt: now };
        return snapshot;                                // 内容一致：什么都不做（memo 保持有效）
      }
    }

    try {
      if (text === null) text = readText();
      const exists = text !== null;
      const raw = exists ? JSON.parse(text) : emptyDocument();
      const normalized = normalizeDocument(raw);
      if (normalized.shapeErrors.length > 0) {
        // 「JSON 合法但形状非法」与语法错同等对待：否则一个 {"groups":null} 或根为 null
        // 的文件就会静默顶掉上次可用快照、把全部分组清空。
        throw new Error('配置文件形状非法：' + normalized.shapeErrors.join('；'));
      }
      const signature = exists ? contentSignature(text) : '';
      const changed = signature !== snapshot.contentSignature;
      // revision 语义：**单调不减**。内容变了要递增（外部改写通常不动 revision 字段），
      // 内容没变也不能往回落——曾经出现过「内容变 → 6、随后仅 touch → 回落到文件里的 5」
      // 的非单调抖动（同一个 revision 值指向两份内容，消费方会误判「没变」而用旧分组）。
      const revision = changed
        ? Math.max(normalized.doc.revision, snapshot.revision + 1)
        : Math.max(normalized.doc.revision, snapshot.revision);
      snapshot = {
        exists,
        mtimeMs,
        size,
        checkedAt: now,
        contentCheckedAt: now,
        contentSignature: signature,
        revision,
        groups: normalized.doc.groups,
        compiled: compileGroups(normalized.doc.groups),
        issues: normalized.issues.concat(normalized.fatal),
        loadError: null,
        memo: new Map(),
      };
    } catch (error) {
      // 坏文件：保留上一次可用快照（不让一个手抖的编辑把分组全部清空），只记错误。
      snapshot = { ...snapshot, checkedAt: now, contentCheckedAt: now, loadError: msg(error) };
      ctx.logger?.warn?.(`dsh-model-groups: 配置文件不可用，沿用上次快照：${msg(error)}`);
    }
    return snapshot;
  }

  /** 组 → 对外视图（深拷贝，带解析次序；0 = 未参与解析）。 */
  function viewGroups(current) {
    const orderOf = new Map();
    for (const entry of current.compiled) orderOf.set(entry.group.id, entry.order);
    return current.groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      enabled: group.enabled,
      priority: group.priority,
      ignoreCase: group.ignoreCase,
      members: group.members.map((member) => ({ provider: member.provider, model: member.model })),
      order: orderOf.get(group.id) ?? 0,
    }));
  }

  /**
   * 无目录也能算出的结构性警告（有目录时由 audit 补充遮蔽/重叠）。
   * catch-all 判定走 specOf 的语义归一：spec 0 = 「任意」，`*`、`**`、`***` 一视同仁，
   * 所以「provider 与 model 都是全星号」的组即使写成 `**` 加 `***` 也会照常报遮蔽（H7）。
   */
  function structuralWarnings(current) {
    const warnings = current.issues.slice();
    if (current.loadError !== null) warnings.push(`配置文件读取失败：${current.loadError}`);
    const compiled = current.compiled;
    for (let at = 0; at < compiled.length - 1; at++) {
      const catchAll = compiled[at].matchers.some((m) => m.pSpec === 0 && m.mSpec === 0);
      if (catchAll) {
        // 文案同时点出「全星号写法」：`**` 加 `***` 这类成员同样按语义等于 */* 处理（H7）。
        warnings.push(`第 ${compiled[at].order} 位「${compiled[at].group.name}」含 catch-all 成员（*/* 或全星号写法），会遮蔽其后全部 ${compiled.length - at - 1} 个组`);
        break;
      }
    }
    return warnings;
  }

  /* ------------------------------------------------------------ 服务 ---- */

  const service = {
    schema: SCHEMA,
    path,
    revision() { return load(false).revision; },
    list() { return viewGroups(load(false)); },
    ids() { return load(false).compiled.map((entry) => entry.group.id); },
    /** 快路径：统计逐事实调用、重试每次失败调用。命中记忆表即 O(1)。 */
    resolve(provider, model) {
      const current = load(false);
      // 记忆表键用 pairKey（长度前缀编码）：NUL 拼接会让 ("a","b\0c") 与 ("a\0b","c")
      // 撞成同一个键，于是 resolve 对后者返回前者的组，与 explain 自相矛盾（H6）。
      const key = pairKey(provider, model);
      if (current.memo.has(key)) return current.memo.get(key);
      const value = resolveRoute(current.compiled, provider, model);
      if (current.memo.size < 8192) current.memo.set(key, value);
      return value;
    },
    explain(provider, model) { return explainRoute(load(false).compiled, provider, model); },
    members(groupId) {
      const group = load(false).groups.find((item) => item.id === groupId);
      return group === undefined ? [] : group.members.map((member) => ({ provider: member.provider, model: member.model }));
    },
    refresh() { return load(true).revision; },
  };

  // 服务名在本 realm 已被占用时不要让整行失败：apply 抛错会让 loader 回滚
  // 整层更新，连累同层其它改动。降级为「无服务」并留下警告。
  let disposed = false;
  let servicePublished = true;
  try {
    ctx.provide('modelGroups', service);
  } catch (error) {
    servicePublished = false;
    ctx.logger?.warn?.(`dsh-model-groups: ctx.provide('modelGroups') 失败，服务不可用（设置页与路由仍可用）：${msg(error)}`);
  }

  /* -------------------------------------------------- 折叠状态（UI 偏好） ---- */

  /**
   * 分组本体之外的**设置页视图状态**：哪些分组卡被收起。它不属于分组语义
   *（统计与重试都不该看见它），所以单独一个文件，且只由本插件的设置页读写。
   *
   * 记账口径：折叠项 = **组 id**（不是浏览器侧的 uid——uid 每次加载重新生成，
   * 落盘没有意义）。id 是用户可改的字段，因此客户端每次派生都取「当前界面的
   * 合法 id」；改名后折叠状态跟着新 id 走（见 client.js 的派生键）。
   *
   * 读：宽松（坏文件 = 全部展开，不影响分组）；写：原子写 tmp + rename。
   */
  const uiPath = opt.uiFile;
  let uiRevision = 0;   // 单调不减：与分组文件同款语义，便于判断「有没有变过」

  /** 读折叠状态文件。任何读取/解析失败都降级为「空 + 说明」，绝不抛错。 */
  function readUiState() {
    let text = null;
    try {
      text = readFileSync(uiPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { exists: false, revision: 0, collapsed: [], issues: [], loadError: null };
      }
      return { exists: false, revision: 0, collapsed: [], issues: [], loadError: msg(error) };
    }
    try {
      const normalized = normalizeUiState(JSON.parse(text));
      return {
        exists: true,
        revision: normalized.revision,
        collapsed: normalized.collapsed,
        issues: normalized.issues,
        loadError: null,
      };
    } catch (error) {
      // 坏文件（JSON 语法错）：折叠状态回落到「全部展开」。这里刻意不与分组本体
      // 一样「保留上次可用快照」——UI 偏好没有值得保护的语义，且进程内本来就没有
      // 上一份权威快照（重启后更不会有）；宁可显示全展开，也不要拿旧集合糊弄。
      return { exists: true, revision: 0, collapsed: [], issues: [], loadError: '折叠状态文件不可用：' + msg(error) };
    }
  }

  /**
   * 覆盖写折叠状态；返回本次落盘的 revision。
   * 先算后写、写完再提交内存值：落盘失败时 handle.uiRevision 不会前进到一个
   * 从未落盘的号上（否则「POST 500 之后 GET 却报了一个不存在的 revision」）。
   */
  function writeUiState(collapsed) {
    const current = readUiState();
    const next = Math.max(current.revision, uiRevision) + 1;
    atomicWriteJson(uiPath, {
      schema: UI_SCHEMA,
      revision: next,
      updatedAt: Date.now(),
      collapsed,
    });
    uiRevision = next;
    return next;
  }

  /**
   * 折叠状态的对外 revision：`max(文件字段, 进程内计数器)` ——**单调不减**。
   * 只报文件字段会在「外部把文件改小/改写」时回落（同一号指向两份内容，H8 的教训）；
   * 只报进程计数器又在重启后失真。取两者最大值，语义与分组本体的 revision 对齐。
   */
  function uiRevisionNow() {
    return Math.max(readUiState().revision, uiRevision);
  }

  /** GET /ui 的响应体（也内联进 /state 的 ui 字段，客户端一次请求就能拿到）。 */
  function uiPayload() {
    const current = readUiState();
    return {
      ok: true,
      schema: UI_SCHEMA,
      build: BUILD,
      impl: implTag(),
      path: uiPath,
      exists: current.exists,
      revision: Math.max(current.revision, uiRevision),
      collapsed: current.collapsed,
      issues: capIssues(current.issues).issues,
      issueCount: current.issues.length,
      warning: current.loadError,
    };
  }

  /**
   * issues 只回前 N 条（+ 总数）：逐条回显会让一个 256 KiB 的请求换回数 MB 响应
   * （实测 40k 个坏项 → 2.5 MB 回包）。落盘内容不受影响。
   */
  function capIssues(issues) {
    const list = Array.isArray(issues) ? issues : [];
    return { issues: list.slice(0, 20), issueCount: list.length };
  }

  /* ------------------------------------------------------------ HTTP ---- */

  function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  /**
   * 同源守卫（与 dsh-usage-stats / dsh-model-retry 同款）。
   * 无 Origin 头（curl、本机 CLI）放行；`Origin: null` 按**外部**处理（H4）——
   * 它不是本页面的同源来源（沙箱 iframe、file:// 页面都会发 `null`），
   * README 承诺的「仅 loopback / 同源页面可写」不能靠它蒙混过关。
   */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    if (origin === 'null') return false;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  /**
   * 读请求体。超限时**不** destroy 连接（H5）：先让调用方把 413 响应完整发出去，
   * 这里只把剩余请求体读完（drain）并停累积——先 destroy 会把连接重置，
   * 客户端只会看到 ECONNRESET，看不到任何响应。错误文案保持 'body too large'。
   */
  function readBody(req, limit = 262144) {
    // setEncoding('utf8') 让 Node 用 StringDecoder 拼接**跨 TCP 分块**的多字节字符：
    // 手工 `body += chunk`（chunk 是 Buffer）会在分块切断处插入 U+FFFD，静默损坏
    // name/description 这类多字节字段；同时 `body.length` 变成字符数（与上限口径一致，
    // 不再出现「同尺寸 CJK 载荷时接受时拒绝」）。
    if (typeof req.setEncoding === 'function') req.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let body = '';
      let overflowed = false;
      let drained = 0;
      req.on('data', (chunk) => {
        if (overflowed) {
          // 已回 413：还要把余下的体读掉（否则连接被 reset，客户端看不到响应），
          // 但 drain 是**有界**的——持续投喂的客户端可以无限占住 socket
          //（requestTimeout 是空闲计时器，会被不断到达的数据重置）。
          drained += typeof chunk === 'string' ? chunk.length : chunk.length;
          if (drained > limit * 4) req.destroy();
          return;
        }
        body += chunk;
        if (body.length > limit) {
          overflowed = true;
          body = '';
          reject(Object.assign(new Error('body too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' }));
        }
      });
      req.on('end', () => { if (!overflowed) resolve(body); });
      req.on('error', (error) => { if (!overflowed) reject(error); });
    });
  }

  /** 请求体相关的失败响应：超限 413，其余 400。 */
  function bodyError(res, error) {
    return json(res, error && error.statusCode === 413 ? 413 : 400, { error: msg(error) });
  }

  function statePayload() {
    const current = load(true);
    const ui = readUiState();
    return {
      ok: true,
      schema: SCHEMA,
      // 构建标记：热挂是靠「换 specifier 触发重新求值」，光看行为很难确认线上跑的
      // 到底是哪一版（本项目就踩过一次：标记只打了一半，线上静默跑旧代码）。
      build: BUILD,
      // 真正的身份（index.js?v=ui-2）：build 分不清 entry / ?v 标记，这个能。
      impl: implTag(),
      path,
      exists: current.exists,
      revision: current.revision,
      groups: viewGroups(current),
      warnings: structuralWarnings(current),
      limits: LIMITS,
      // 设置页折叠状态（UI 偏好，独立文件）：跟分组一起回给客户端，加载时一次请求
      // 就能把「分组 + 折叠」还原成上次看到的样子。缺字段 = 宿主没有这半边，客户端按全展开。
      // warning/issues 一并带上：坏文件降级成「全部展开」时，页面才有话可解释
      //（客户端只读 /state，从不单独 GET /ui）。
      ui: {
        schema: UI_SCHEMA,
        path: uiPath,
        exists: ui.exists,
        revision: uiRevisionNow(),
        collapsed: ui.collapsed,
        issues: capIssues(ui.issues).issues,
        issueCount: ui.issues.length,
        warning: ui.loadError,
      },
    };
  }

  /* ------------------------------------------------------------ 审计 ---- */

  let auditCache = { at: 0, value: null };

  async function catalogRoutes(force) {
    if (!force && auditCache.value !== null && Date.now() - auditCache.at < opt.auditTtlMs) {
      return auditCache.value;
    }
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      const value = { available: false, error: 'llm 服务不可用：无法枚举真实模型目录', routes: [], failures: [] };
      auditCache = { at: Date.now(), value };
      return value;
    }
    const routes = [];
    const failures = [];
    let providers = [];
    try { providers = llm.listProviders() || []; } catch (error) { failures.push({ provider: '*', error: msg(error) }); }
    for (const provider of providers) {
      const id = String(provider && provider.id !== undefined ? provider.id : '');
      if (id === '') continue;
      try {
        const models = await llm.listModels(id);
        for (const model of Array.isArray(models) ? models : []) {
          const modelId = String(model && model.id !== undefined ? model.id : '');
          if (modelId === '') continue;
          routes.push({ provider: id, model: modelId, name: (model && model.name) || modelId });
          if (routes.length >= opt.maxCatalogRoutes) break;
        }
      } catch (error) {
        failures.push({ provider: id, error: msg(error) });
      }
      if (routes.length >= opt.maxCatalogRoutes) break;
    }
    const value = { available: true, error: null, routes, failures };
    auditCache = { at: Date.now(), value };
    return value;
  }

  async function auditPayload(force) {
    const current = load(true);
    const catalog = await catalogRoutes(force);
    const compiled = current.compiled;
    const groups = compiled.map((entry) => ({
      id: entry.group.id,
      name: entry.group.name,
      order: entry.order,
      matched: [],
      shadowed: [],
      empty: true,
    }));
    const byId = new Map(groups.map((row) => [row.id, row]));
    const ungrouped = [];
    const overlaps = [];
    for (const route of catalog.routes) {
      const explanation = explainRoute(compiled, route.provider, route.model);
      if (explanation.winner === null) {
        ungrouped.push(route);
        continue;
      }
      for (const candidate of explanation.candidates) {
        const row = byId.get(candidate.groupId);
        if (row === undefined) continue;
        row.empty = false;
        (candidate.shadowed ? row.shadowed : row.matched).push({
          provider: route.provider, model: route.model, matchedBy: candidate.member,
        });
      }
      if (explanation.candidates.length > 1) {
        overlaps.push({
          provider: route.provider,
          model: route.model,
          winner: explanation.winner.groupId,
          also: explanation.candidates.slice(1).map((candidate) => candidate.groupId),
        });
      }
    }
    return {
      ok: true,
      revision: current.revision,
      catalog: {
        available: catalog.available,
        error: catalog.error,
        providers: catalog.available ? new Set(catalog.routes.map((route) => route.provider)).size : 0,
        routes: catalog.routes.length,
        failures: catalog.failures,
      },
      groups,
      ungrouped,
      overlaps,
      warnings: structuralWarnings(current),
    };
  }

  /* ------------------------------------------------------------ 路由 ---- */

  const routes = [
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-model-groups/state',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
        try { return json(res, 200, statePayload()); } catch (error) { return json(res, 500, { error: msg(error) }); }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-model-groups/groups',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
        if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
        readBody(req).then((body) => {
          if (body === '') return json(res, 400, { error: 'body 为空' });
          let parsed;
          try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
          const { doc, issues, fatal, shapeErrors } = normalizeDocument(parsed);
          // 形状非法（根不是对象 / groups 不是数组 / schema 不认识）与超上限一律拒绝写入：
          // 否则一次手抖的提交就能把文件里的分组静默清空（H1）。
          if (shapeErrors.length > 0 || fatal.length > 0) {
            return json(res, 400, { error: '分组校验失败: ' + shapeErrors.concat(fatal).join('; ') });
          }
          const next = {
            schema: SCHEMA,
            revision: (load(true).revision || 0) + 1,
            updatedAt: Date.now(),
            groups: doc.groups,
          };
          try {
            atomicWriteJson(path, next);
          } catch (error) {
            return json(res, 500, { error: '分组写入失败: ' + msg(error) });
          }
          const current = load(true);
          return json(res, 200, {
            ok: true,
            revision: current.revision,
            groups: viewGroups(current),
            warnings: structuralWarnings(current),
            issues,
          });
        }).catch((error) => bodyError(res, error));
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-model-groups/ui',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
          try { return json(res, 200, uiPayload()); } catch (error) { return json(res, 500, { error: msg(error) }); }
        }
        if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
        readBody(req).then((body) => {
          if (body === '') return json(res, 400, { error: 'body 为空' });
          let parsed;
          try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return json(res, 400, { error: 'body 必须是对象：{collapsed:[组 id…]}' });
          }
          if (parsed.collapsed === undefined) {
            return json(res, 400, { error: '缺少 collapsed（要清空折叠状态就提交 collapsed:[]）' });
          }
          if (!Array.isArray(parsed.collapsed)) return json(res, 400, { error: 'collapsed 必须是字符串数组' });
          // 元素级问题宽松处理（丢弃 + issues）：一个手抖的坏项不该让整批折叠状态写不进去。
          const normalized = normalizeUiState({ collapsed: parsed.collapsed });
          try {
            writeUiState(normalized.collapsed);
          } catch (error) {
            return json(res, 500, { error: '折叠状态写入失败: ' + msg(error) });
          }
          return json(res, 200, {
            ok: true,
            revision: uiRevision,
            collapsed: normalized.collapsed,
            // issues 回前 20 条 + 总数（见 capIssues）：客户端据此提示「部分项未保存」。
            issues: capIssues(normalized.issues).issues,
            issueCount: normalized.issues.length,
          });
        }).catch((error) => bodyError(res, error));
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-model-groups/resolve',
      handler: (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
        if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request rejected' });
        readBody(req).then((body) => {
          let parsed = {};
          if (body !== '') {
            try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'body 不是合法 JSON' }); }
          }
          const current = load(false);
          if (Array.isArray(parsed.routes)) {
            if (parsed.routes.length > 200) return json(res, 400, { error: 'routes 最多 200 项' });
            return json(res, 200, {
              ok: true,
              revision: current.revision,
              results: parsed.routes.slice(0, 200).map((route) => {
                const provider = route && typeof route.provider === 'string' ? route.provider : '';
                const model = route && typeof route.model === 'string' ? route.model : '';
                return explainRoute(current.compiled, provider, model);
              }),
            });
          }
          const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
          const model = typeof parsed.model === 'string' ? parsed.model : '';
          if (provider === '' && model === '') return json(res, 400, { error: '需要 provider/model（或 routes 数组）' });
          return json(res, 200, { ok: true, revision: current.revision, ...explainRoute(current.compiled, provider, model) });
        }).catch((error) => bodyError(res, error));
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-model-groups/audit',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method Not Allowed' });
        let fresh = false;
        try { fresh = new URL(req.url || '/', 'http://localhost').searchParams.get('fresh') === '1'; } catch { /* 保持 false */ }
        auditPayload(fresh).then(
          (value) => json(res, 200, value),
          (error) => json(res, 500, { error: msg(error) }),
        );
      },
    }),
  ];

  const dispose = () => {
    disposed = true;
    for (const route of routes) { try { if (typeof route === 'function') route(); } catch { /* ignore */ } }
    // 服务的注销由 fiber 自己负责（ctx.provide 内部就是 fiber effect），这里不重复注销。
  };
  ctx.effect(() => dispose, 'dsh-model-groups: dispose');

  load(true);

  return {
    opt, path, service, servicePublished, load, statePayload, auditPayload, catalogRoutes, dispose, viewGroups,
    uiPath, readUiState, writeUiState, uiPayload,
    get uiRevision() { return uiRevision; },
    get disposed() { return disposed; },
  };
}

export function apply(ctx, config = {}) {
  return createModelGroups(ctx, config);
}
