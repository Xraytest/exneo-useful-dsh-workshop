/**
 * 会话日志解析与导入规划（dsh-session-import 内部件）。
 *
 * 纯逻辑、无 I/O、无 cordis 依赖：`selftest.mjs` 直接调用这里的每个函数。
 * host 半边只负责把归档字节喂进来、把规划结果落进持久化与工作区账目。
 *
 * ## 归档里到底是什么
 *
 * `/export`（dsh-session-log-export）产出的 ZIP 里，每个会话日志都是**规范化
 * JSONL 文本**：第 1 行是物理头记录，其后每行一条事件。根会话名为
 * `session[.vN].jsonl`，子代理在 `subagents/<id>/session[.vN].jsonl`
 * （见 dsh-session-format 的 sessionFormatLogFilename）。附件另有
 * `media/<attachmentId>.<ext>` 与 `files/<digest 前两位>/<digest>/<name>`，
 * 归档**不带清单**——路径本身就是索引。
 *
 * ## 为什么优先走 sessionFormatCatalog
 *
 * 归档可能来自任意一代格式（v0/v1/v2/v3）。`sessionFormatCatalog.createRestore`
 * 是 DSH 自己读冷会话用的同一条还原链，能把历史代迁移到当前代并做完整校验；
 * 自己 `JSON.parse` 只能读懂当前代。因此这里**优先**用目录还原，仅在目录模块
 * 解析不到时退回朴素解析（并只接受当前代），把降级事实如实报给调用方，
 * 而不是假装成功。
 *
 * @module dsh-session-import/sessionlog
 */

/**
 * DSH 当前写入的会话格式代；朴素回退路径只接受这一代。
 *
 * 这个值**必须跟着运行时走**：0.1 是 v3、0.2 是 v4。写死 3 会让 0.2 上的导入把
 * 会话头写成 v3，而 harness 自己写的是 v4——导进来的会话从此成了「旧代日志」，
 * 下次读还要再走一遍迁移。目录装载成功后会被校正为 `catalog.currentVersion`；
 * 目录不可用时退回这个编译期缺省（那时也只能按缺省代直接解析）。
 */
let currentFormatVersion = 3;

/**
 * 用已装载目录的当前代校正本进程的写入代。
 * @param {object|undefined} catalog 格式目录。
 */
function adoptFormatVersion(catalog) {
  const version = Number(catalog?.currentVersion);
  if (Number.isSafeInteger(version) && version > 0) currentFormatVersion = version;
}

/** 本进程当前写入的会话格式代（目录装载前是编译期缺省）。 */
export function currentSessionFormatVersion() {
  return currentFormatVersion;
}

/** 归档里的规范日志名：`session.jsonl`（v0）或 `session.v<N>.jsonl`。 */
const LOG_BASENAME_RE = /^session(?:\.v(\d+))?\.jsonl$/u;
const SUBAGENT_LOG_RE = /^subagents\/([^/]+)\/([^/]+)$/u;
const MEDIA_RE = /^media\/([^/]+)\.([A-Za-z0-9]+)$/u;
const FILE_RE = /^files\/[^/]+\/([^/]+)\/(.+)$/u;

/** 扩展名 → DSH 图像媒体类型（对齐导出侧 MEDIA_TYPE_EXTENSIONS 的逆映射）。 */
const EXTENSION_MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/** 日志解析/校验失败——调用方据此回 400 而不是 500。 */
export class SessionLogError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionLogError';
    this.code = 'SESSION_LOG_INVALID';
  }
}

/**
 * 解析日志 basename 的格式代。
 * @param {string} basename 文件名（不含目录）。
 * @returns {number|undefined} 格式代；`session.jsonl` 为 0；非规范名返回 `undefined`。
 */
export function parseLogBasename(basename) {
  const match = LOG_BASENAME_RE.exec(basename);
  if (match === null) return undefined;
  if (match[1] === undefined) return 0;
  // 规范名不带前导零（对齐 dsh-session-format 的 parseSessionFormatLogFilename：
  // `.v0`、`.v03`、大写后缀、压缩后缀都不是规范名）。`Number('03')` 会得到 3，
  // 所以必须比对原始拼写，不能只看数值。
  if (match[1].length > 1 && match[1].startsWith('0')) return undefined;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

/**
 * 惰性装载 DSH 的会话格式目录（只解析一次；失败不抛，返回 `undefined`）。
 *
 * 这里刻意用动态 import + try/catch：目录模块是本安装的裸包名，
 * 万一将来解析链变化，插件应当退化成「只支持当前代」而不是整个装载失败。
 *
 * 0.2 起返回的是**绑定了「无历史子节点」**的目录：v3→v4 那条边必须被显式喂一份
 * 子节点清单（空数组也算明说），裸目录在迁移任何 v3 日志时都会直接抛。调用方若
 * 知道真正的子节点（导入归档时就知道），应当用 {@link loadFormatCatalogWithChildren}
 * 现建一个绑定真实子节点的目录——见 `entry-v2.js` 的 `loadArchive`。
 * 0.1 没有这套 API，返回的就是原生裸目录，行为与从前一致。
 *
 * @returns {Promise<object|undefined>} 目录，不可用时 `undefined`。
 */
let catalogPromise;
export function loadFormatCatalog() {
  if (catalogPromise === undefined) {
    catalogPromise = loadChildCatalogSupport().then(async (support) => {
      if (support !== undefined) {
        try {
          const bound = support.createSessionFormatCatalogWithChildren([]);
          adoptFormatVersion(bound);
          return bound;
        } catch {
          // 落到下面走裸目录（至少与 0.1 同能力）。
        }
      }
      return import('@deepseek-ai/dsh-session-format-catalog')
        .then((module) => module.sessionFormatCatalog)
        .catch(() => undefined);
    }).then((catalog) => {
      adoptFormatVersion(catalog);
      return catalog;
    });
  }
  return catalogPromise;
}

/**
 * 惰性装载「带子节点事实的格式目录」能力（0.2 起才有；0.1 上返回 `undefined`）。
 *
 * 0.2 引入 v3→v4 之后，目录的 v3→v4 边**必须**知道父会话的历史子节点——
 * 没有子节点也要显式给一个空数组，否则 `createRestore` 直接抛
 * `SessionFormatUnsupportedMigrationError`。同时 0.2 把 `historicalChildCatalogSource`
 * 放在 `@deepseek-ai/dsh-session-format-v3-to-v4` 里（该包 0.1 不存在）。
 * 两样都拿不到就返回 `undefined`，调用方退回默认目录（= 0.1 的旧行为）。
 *
 * @returns {Promise<object|undefined>} 能力集合，不可用时 `undefined`。
 */
let childCatalogSupportPromise;
function loadChildCatalogSupport() {
  if (childCatalogSupportPromise === undefined) {
    childCatalogSupportPromise = Promise.all([
      import('@deepseek-ai/dsh-session-format-catalog'),
      import('@deepseek-ai/dsh-session-format-v3-to-v4'),
    ]).then(([catalogModule, v3to4Module]) => {
      if (typeof catalogModule.createSessionFormatCatalogWithChildren !== 'function') return undefined;
      if (typeof v3to4Module.historicalChildCatalogSource !== 'function') return undefined;
      return {
        createSessionFormatCatalogWithChildren: catalogModule.createSessionFormatCatalogWithChildren,
        historicalSessionFormatCatalog: catalogModule.historicalSessionFormatCatalog,
        sessionFormatCatalog: catalogModule.sessionFormatCatalog,
        historicalChildCatalogSource: v3to4Module.historicalChildCatalogSource,
      };
    }).catch(() => undefined);
  }
  return childCatalogSupportPromise;
}

/**
 * 只读会话日志的**头记录**（不迁移、不校验事件）。
 * @param {string} text 规范化 JSONL 文本。
 * @returns {object|undefined} 头记录；首行不是对象时 `undefined`。
 */
export function readSessionLogHeader(text) {
  const { headerValue } = splitSessionLog(text);
  if (headerValue === null || typeof headerValue !== 'object' || Array.isArray(headerValue)) return undefined;
  return headerValue;
}

/**
 * 把一份**历史子会话**日志还原成目录迁移需要的「子节点事实」。
 *
 * 这里刻意用 `historicalSessionFormatCatalog`（currentVersion = 3，只有 v0→v1→v2→v3
 * 三条边）解码：它**天然不需要**子节点事实，因此取证据这一步不会递归回本次要解的
 * v3→v4 边。这与 `dsh-session-persistence-jsonl` 的 `prepareCatalogFacts` 同源同法。
 *
 * 解码失败时退回「不可用」事实（描述符计数 0），而不是把子节点整个丢掉——
 * 父目录的成员校验要求子节点清单完整，少一条会让父会话迁移失败。
 *
 * @param {string} text 子会话日志文本。
 * @returns {Promise<object|undefined>} 子节点事实；代际能力不可用时 `undefined`。
 */
export async function childCatalogFact(text) {
  const support = await loadChildCatalogSupport();
  if (support === undefined) return undefined;
  const { headerValue, rowValues } = splitSessionLog(text);
  if (headerValue === null || typeof headerValue !== 'object' || Array.isArray(headerValue)) return undefined;
  const unavailable = {
    childId: String(headerValue.id ?? ''),
    childCreatedAt: Number(headerValue.createdAt ?? 0),
    descriptorCount: 0,
    descriptor: null,
  };
  try {
    const version = Number(headerValue.version);
    const catalog = version <= 3 ? support.historicalSessionFormatCatalog : support.sessionFormatCatalog;
    const restore = catalog.createRestore(headerValue, { recovery: 'recoverable', validation: 'current' });
    for (const row of rowValues) restore.decodeRow(row);
    return support.historicalChildCatalogSource(restore.finish());
  } catch {
    return unavailable;
  }
}

/**
 * 装载一个绑定「某个父会话的历史子节点」的格式目录。
 * @param {object[]} facts 该父会话的完整子节点事实（无子节点传空数组）。
 * @returns {Promise<object|undefined>} 目录；代际能力不可用时 `undefined`。
 */
export async function loadFormatCatalogWithChildren(facts) {
  const support = await loadChildCatalogSupport();
  if (support === undefined) return undefined;
  return support.createSessionFormatCatalogWithChildren(facts);
}

/**
 * 惰性装载持久化层的**存储契约校验器**（写前预校验用）。
 *
 * 这四个函数就是 JSONL 后端 `create`/`append` 内部实际调用的那四个——直接引用
 * 同一个包实例，因此 `KNOWN_SESSION_EVENT_TYPES` 等集合与本进程持久化服务完全同源，
 * 不会出现「我这里放行、它那里拒绝」的错位。
 *
 * 装载失败不抛：预校验随之退化成「不预校验」，真正的把关仍在 append。
 * @returns {Promise<object|undefined>} 校验器集合，不可用时 `undefined`。
 */
let contractPromise;
export function loadPersistenceContract() {
  if (contractPromise === undefined) {
    contractPromise = import('@deepseek-ai/dsh-session-persistence')
      .then((module) => ({
        materializeCreateHeader: module.materializeCreateHeader,
        materializeAppendBatch: module.materializeAppendBatch,
        validateStoredEvents: module.validateStoredEvents,
        assertContiguous: module.assertContiguous,
      }))
      .catch(() => undefined);
  }
  return contractPromise;
}

/**
 * 写前预校验一个会话的头与事件数组。
 *
 * 为什么值得单独做一遍：`create()` 一落盘就写下了头记录，若随后的 `append()` 因
 * 词汇表/结构问题被拒，磁盘上会留下一个**只有头、没有事件**的残会话；而且导入是
 * 逐条会话进行的，第 N 条不合格会连累前面已经写好的。所以先把整个导入计划的每一条
 * 都过一遍真实校验器，全过才开始写。
 *
 * 校验顺序与后端一致：头可序列化 → 事件批次可序列化 → 事件词汇表/信封 → seq 连续。
 * @param {object} header 目标会话头。
 * @param {unknown[]} events 事件数组（会就地冻结，故必须是自有数组）。
 * @param {object|undefined} contract `loadPersistenceContract()` 的结果。
 * @returns {unknown[]} 采用（adopt）后的事件数组；契约不可用时原样返回。
 * @throws {SessionLogError} 任一环节不通过，消息即真实校验器的原话。
 */
export function prevalidateSession(header, events, contract) {
  if (contract === undefined || contract === null) return events;
  const id = String(header?.id ?? '');
  try {
    const meta = contract.materializeCreateHeader(header);
    const batch = contract.materializeAppendBatch(events);
    contract.validateStoredEvents(meta, batch, undefined);
    // 新建会话的 inheritedEventCount 恒为 0，因此批次必须从 seq 0 起——与 append 的判据一致。
    contract.assertContiguous(id, batch, 0);
    return batch;
  } catch (error) {
    throw new SessionLogError(`会话 ${id} 未通过写前校验：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 把规范化 JSONL 文本拆成「头值 + 事件行值」。
 * @param {string} text 日志文本。
 * @returns {{headerValue: unknown, rowValues: unknown[], lineCount: number}}
 * @throws {SessionLogError} 文本为空或任一行不是合法 JSON。
 */
export function splitSessionLog(text) {
  const lines = String(text).split('\n');
  const nonEmpty = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      nonEmpty.push({ value: JSON.parse(line), line: index + 1 });
    } catch (error) {
      throw new SessionLogError(`第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (nonEmpty.length === 0) throw new SessionLogError('会话日志为空');
  return {
    headerValue: nonEmpty[0].value,
    rowValues: nonEmpty.slice(1).map((entry) => entry.value),
    lineCount: nonEmpty.length,
  };
}

/**
 * 更新代（本进程读不了的代）日志的**前向通道**。
 *
 * 背景：本进程的格式目录 `currentVersion = 3`，随包只有 v0→v1、v1→v2、v2→v3 三个
 * 迁移包，**没有 v4 编解码器**。若归档来自更晚的 DSH（头的 version 更大），
 * `createRestore` 只会抛出「this build writes v3」，导入就此死掉。
 *
 * 但「理解这一代」并不是导入的必要条件。事件行**逐字保留**，交给持久化层真正的
 * 校验器裁决——那正是 harness 为这种情况设计的闸（`validateStoredEvents`）：
 * 未知事件类型只有在写入方标了 `ignorable: true` 时才放行（`SessionEvent.ignorable`
 * 信封契约），否则拒绝。于是：
 *
 * - 全部通过 → 该日志对本进程而言就是可读的日志，导入成立；
 * - 任一条不通过 → 校验器原话上报（「upgrade the harness to open it」），绝不猜测。
 *
 * 这条通道**不**用于更老的代（v0/v1/v2）——那些有真实迁移路径，由目录负责，
 * 不该退化成「不迁移直接塞」。
 * @param {object} headerValue 日志首行的原始头值。
 * @param {unknown[]} rowValues 事件行的原始值（逐字保留）。
 * @param {number} storedVersion 头里声明的存储代。
 * @param {{targetVersion?: number, reason?: string}} status 目录给出的结构化结论。
 * @returns {object} 与目录通道同形的解析结果，`via: 'forward'`。
 */
function forwardFormatResult(headerValue, rowValues, storedVersion, status) {
  const { type: _discriminator, ...header } = headerValue;
  return {
    header,
    events: rowValues,
    inheritedEventCount: 0,
    storedVersion,
    via: 'forward',
    degraded: {
      kind: 'newer-format',
      storedVersion,
      targetVersion: Number(status?.targetVersion ?? currentFormatVersion),
      reason: typeof status?.reason === 'string'
        ? status.reason
        : `stored Session uses newer format v${storedVersion}; this build writes v${currentFormatVersion}`,
    },
  };
}

/**
 * 解析一个会话日志。
 *
 * 三条通道，按代选择：
 * 1. **目录通道**（当前代与更老的代）：`sessionFormatCatalog.createRestore` 跨代迁移 + 完整校验。
 * 2. **前向通道**（比本进程更新的代）：事件逐字保留，交由持久化层校验器裁决，见
 *    {@link forwardFormatResult}。
 * 3. **朴素通道**（目录装载失败）：只接受当前代。
 *
 * @param {string} text 规范化 JSONL 文本。
 * @param {{catalog?: object}} [options] 已装载的格式目录（缺省自行惰性装载）。
 * @returns {Promise<{header: object, events: unknown[], inheritedEventCount: number, storedVersion: number, via: 'catalog'|'forward'|'raw', degraded: {kind: string, storedVersion: number, targetVersion: number, reason: string}|null}>}
 * @throws {SessionLogError} 日志非法，或朴素路径遇到非当前代。
 */
export async function parseSessionLog(text, options = {}) {
  const { headerValue, rowValues } = splitSessionLog(text);
  if (headerValue === null || typeof headerValue !== 'object' || Array.isArray(headerValue)) {
    throw new SessionLogError('会话日志首行不是头记录对象');
  }
  const storedVersion = Number(headerValue.version);
  if (!Number.isSafeInteger(storedVersion) || storedVersion < 0) {
    throw new SessionLogError('会话日志头记录缺少合法的 version 字段');
  }

  const catalog = options.catalog !== undefined ? options.catalog : await loadFormatCatalog();
  if (catalog !== undefined && catalog !== null && typeof catalog.createRestore === 'function') {
    // 先用只读探测问清楚「这一代本进程认不认」。目录的 readHeader 返回结构化结论而不抛，
    // 更新代的日志在这里就被认出来，走前向通道；否则要等 createRestore 抛出
    // 「stored Session uses newer format vN; this build writes vM」才知道。
    const status = typeof catalog.readHeader === 'function' ? catalog.readHeader(headerValue) : null;
    const targetVersion = Number(catalog.currentVersion);
    if (status !== null && status.status === 'unsupported' && storedVersion > Number(status.targetVersion)) {
      return forwardFormatResult(headerValue, rowValues, storedVersion, status);
    }
    try {
      // recovery/validation 与 dsh-session-persistence-jsonl 读冷会话时**逐字对齐**
      // （`lib/index.js`：`{ recovery: 'strict', validation: 'transformed' }`）。
      //
      // 这里不能用 `validation: 'current'`：那是「全量语义校验」，实测会拒掉本部署
      // 真实存在的日志——最后一条 turn 只有 `turn/start` 没有 `turn/end`（进程崩过
      // 一轮，DSH 的设计是事后补一条 interrupted 收尾，而不是判日志非法）。
      // persistence 自己读得进去的日志，导入器就不能读不进去；事件的词汇表校验
      // 由 append 时的 `validateStoredEvents` 负责，那才是它该待的地方。
      const restore = catalog.createRestore(headerValue, { recovery: 'strict', validation: 'transformed' });
      for (const row of rowValues) restore.decodeRow(row);
      const artifact = restore.finish();
      return {
        header: artifact.header,
        events: artifact.events,
        inheritedEventCount: artifact.inheritedEventCount,
        storedVersion,
        via: 'catalog',
        degraded: null,
      };
    } catch (error) {
      // 目录没有 readHeader（更老的目录）时，靠 currentVersion 兜一次同样的判断。
      if (status === null && storedVersion > targetVersion) {
        return forwardFormatResult(headerValue, rowValues, storedVersion, {
          targetVersion,
          reason: `stored Session uses newer format v${storedVersion}; this build writes v${targetVersion}`,
        });
      }
      throw new SessionLogError(`会话日志还原失败（存储代 v${storedVersion}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (storedVersion !== currentFormatVersion) {
    throw new SessionLogError(
      `会话日志是 v${storedVersion} 代，而本进程未能装载格式目录（只支持 v${currentFormatVersion} 的直接解析）`,
    );
  }
  const { type: _discriminator, ...header } = headerValue;
  return {
    header,
    events: rowValues,
    inheritedEventCount: header.isSeeded === true ? rowValues.length : 0,
    storedVersion,
    via: 'raw',
    degraded: {
      kind: 'no-format-catalog',
      storedVersion,
      targetVersion: currentFormatVersion,
      reason: '未能装载 @deepseek-ai/dsh-session-format-catalog：按当前代直接解析，未做跨代迁移。',
    },
  };
}

/**
 * 扫描归档条目，按角色归类。
 *
 * @param {Map<string, Uint8Array>} entries `readZip` 的 `entries`。
 * @returns {{
 *   rootPath: string|null,
 *   subagentPaths: Array<{path: string, idFromPath: string, version: number|undefined}>,
 *   media: Array<{path: string, attachmentId: string, mediaType: string|undefined, extension: string}>,
 *   files: Array<{path: string, digest: string, name: string}>,
 *   unknown: string[],
 * }}
 */
export function classifyArchiveEntries(entries) {
  let rootPath = null;
  const subagentPaths = [];
  const media = [];
  const files = [];
  const unknown = [];

  for (const path of entries.keys()) {
    if (!path.includes('/')) {
      if (parseLogBasename(path) !== undefined) {
        // 根日志只可能有一条；多出来的一律当未知条目上报，而不是静默覆盖。
        if (rootPath === null) rootPath = path;
        else unknown.push(path);
        continue;
      }
      unknown.push(path);
      continue;
    }
    const subagent = SUBAGENT_LOG_RE.exec(path);
    if (subagent !== null) {
      const version = parseLogBasename(subagent[2]);
      if (version !== undefined) {
        subagentPaths.push({ path, idFromPath: subagent[1], version });
        continue;
      }
    }
    const image = MEDIA_RE.exec(path);
    if (image !== null) {
      media.push({
        path,
        attachmentId: image[1],
        extension: image[2].toLowerCase(),
        mediaType: EXTENSION_MEDIA_TYPES.get(image[2].toLowerCase()),
      });
      continue;
    }
    const file = FILE_RE.exec(path);
    if (file !== null) {
      files.push({ path, digest: file[1], name: file[2] });
      continue;
    }
    unknown.push(path);
  }

  subagentPaths.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { rootPath, subagentPaths, media, files, unknown };
}

/** 只保留 SessionHeader 的已知字段，并丢掉物理判别字段 `type`。 */
const HEADER_KEYS = ['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'];

/**
 * 把导入前解析出的头记录规范化成**可交给 `sessionPersistence.create()` 的新头**。
 *
 * 关键决定：
 *   - `isSeeded` 一律置 false：导入产物是一条**独立**会话，不继承任何 fork 前缀。
 *     源日志若本身是 seeded，其事件里已含继承前缀，作为自有事件整体保留即可
 *     （调用方会收到一条警告，说明这层语义变化）。
 *   - `cwd` 由调用方指定为目标工作区路径——**这是工作区归属的唯一来源**：
 *     Workspace.sessionIds 的成员判定 = 账目里有这个 id **且** 头里的规范 cwd
 *     等于工作区路径。因此导入到哪个工作区，就是写进头里的这个 cwd。
 *   - `parentSession` / `origin` / `delegationDepth` 由调用方按角色给。
 *
 * @param {object} source 解析出的头记录。
 * @param {{id: string, cwd: string, parentSession?: string, origin?: 'subagent', delegationDepth?: number}} overrides 覆盖值。
 * @returns {object} 全新的、只含已知字段的头对象。
 * @throws {SessionLogError} `createdAt` 非法。
 */
export function buildImportedHeader(source, overrides) {
  if (source === null || typeof source !== 'object') throw new SessionLogError('缺少源会话头记录');
  const createdAt = Number(source.createdAt);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new SessionLogError('源会话头记录的 createdAt 不是非负安全整数');
  }
  if (typeof overrides.cwd !== 'string' || overrides.cwd === '') {
    throw new SessionLogError('目标工作区路径为空，无法确定会话归属');
  }
  const header = {
    version: currentFormatVersion,
    id: overrides.id,
    createdAt,
    cwd: overrides.cwd,
    isSeeded: false,
  };
  // agentPreset 逐会话保留：子代理可能与根会话用不同预设，且恢复时要按原样重组工具。
  const preset = source.agentPreset;
  if (typeof preset === 'string' && preset !== '') header.agentPreset = preset;

  if (overrides.origin === 'subagent') {
    header.origin = 'subagent';
    const depth = Number(overrides.delegationDepth);
    header.delegationDepth = Number.isSafeInteger(depth) && depth > 0
      ? depth
      : (Number.isSafeInteger(Number(source.delegationDepth)) && Number(source.delegationDepth) >= 0
        ? Number(source.delegationDepth)
        : 1);
    if (typeof overrides.parentSession === 'string' && overrides.parentSession !== '') {
      header.parentSession = overrides.parentSession;
    }
  } else {
    header.delegationDepth = 0;
  }
  return header;
}

/**
 * 规划整份归档的导入：分配新会话 id、逐条构造新头、把子代理的 `parentSession`
 * 重映射到本次导入的新 id 上。
 *
 * 两趟分配是必要的：子代理的父可能是**同归档里的另一个子代理**，所以必须先把
 * 全部新 id 定下来，再回填父引用；指向归档外的父则回落到新的根会话 id。
 *
 * @param {{
 *   root: {parsed: object},
 *   subagents: Array<{idFromPath: string, parsed: object}>,
 * }} archive 已解析的归档内容。
 * @param {{
 *   cwd: string,
 *   idFactory: () => string,
 *   assignNewIds?: boolean,
 *   includeSubagents?: boolean,
 * }} options 目标工作区路径、id 工厂（测试可注入确定性实现）。
 * @returns {{
 *   sessions: Array<{role: 'root'|'subagent', originalId: string, id: string, header: object, events: unknown[]}>,
 *   idMap: Map<string, string>,
 *   warnings: string[],
 * }}
 */
export function planArchiveImport(archive, options) {
  const assignNewIds = options.assignNewIds !== false;
  const includeSubagents = options.includeSubagents !== false;
  const warnings = [];
  const idMap = new Map();

  const rootOriginalId = String(archive.root.parsed.header.id);
  const rootId = assignNewIds ? options.idFactory() : rootOriginalId;
  idMap.set(rootOriginalId, rootId);
  if (!assignNewIds) warnings.push('按配置保留了原始会话 id；若该 id 已存在，导入会失败。');

  const subagentEntries = includeSubagents ? archive.subagents : [];
  if (!includeSubagents && archive.subagents.length > 0) {
    warnings.push(`归档含 ${archive.subagents.length} 条子代理会话，按配置已跳过。`);
  }
  for (const entry of subagentEntries) {
    const originalId = String(entry.parsed.header.id);
    idMap.set(originalId, assignNewIds ? options.idFactory() : originalId);
  }

  const sessions = [];
  const rootParsed = archive.root.parsed;
  if (rootParsed.header.isSeeded === true) {
    warnings.push('源根会话是 fork 派生（isSeeded）；导入后作为独立会话，继承前缀已并入自有事件。');
  }
  sessions.push({
    role: 'root',
    originalId: rootOriginalId,
    id: rootId,
    header: buildImportedHeader(rootParsed.header, { id: rootId, cwd: options.cwd }),
    events: rootParsed.events,
  });

  for (const entry of subagentEntries) {
    const parsed = entry.parsed;
    const originalId = String(parsed.header.id);
    const id = idMap.get(originalId);
    const parentOriginal = parsed.header.parentSession === undefined ? null : String(parsed.header.parentSession);
    const parentId = parentOriginal !== null && idMap.has(parentOriginal) ? idMap.get(parentOriginal) : rootId;
    if (parentOriginal !== null && !idMap.has(parentOriginal)) {
      warnings.push(`子代理 ${originalId} 的原父会话 ${parentOriginal} 不在本归档内，已改挂到本次导入的根会话。`);
    }
    if (parsed.header.isSeeded === true) {
      warnings.push(`子代理 ${originalId} 是 fork 派生（isSeeded）；导入后作为独立会话。`);
    }
    sessions.push({
      role: 'subagent',
      originalId,
      id,
      header: buildImportedHeader(parsed.header, {
        id,
        cwd: options.cwd,
        parentSession: parentId,
        origin: 'subagent',
      }),
      events: parsed.events,
    });
  }

  return { sessions, idMap, warnings };
}

/**
 * 汇总归档概览——`/inspect` 与导入结果里的 `summary` 共用同一份口径。
 * @param {{root: {parsed: object}, subagents: Array<{parsed: object}>, media: unknown[], files: unknown[], unknown: string[]}} archive 解析结果。
 * @returns {object} 可直接 JSON 化的概览对象。
 */
export function summarizeArchive(archive) {
  return {
    originalSessionId: String(archive.root.parsed.header.id),
    originalCwd: typeof archive.root.parsed.header.cwd === 'string' ? archive.root.parsed.header.cwd : null,
    createdAt: Number(archive.root.parsed.header.createdAt),
    agentPreset: typeof archive.root.parsed.header.agentPreset === 'string' ? archive.root.parsed.header.agentPreset : null,
    storedVersion: archive.root.parsed.storedVersion,
    via: archive.root.parsed.via,
    degraded: archive.root.parsed.degraded ?? null,
    rootEventCount: archive.root.parsed.events.length,
    subagents: archive.subagents.map((entry) => ({
      originalId: String(entry.parsed.header.id),
      eventCount: entry.parsed.events.length,
      agentPreset: typeof entry.parsed.header.agentPreset === 'string' ? entry.parsed.header.agentPreset : null,
    })),
    mediaCount: archive.media.length,
    fileCount: archive.files.length,
    unknownEntries: archive.unknown,
  };
}
