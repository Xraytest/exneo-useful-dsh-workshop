/**
 * 会话导入（dsh-session-import）— host 半边实现。
 *
 * 把 `/export`（dsh-session-log-export）导出的会话归档 ZIP **导回本机会话库**，
 * 并在导入时选择它归属的工作区（既有工作区，或就地新建一个）。
 *
 * ## 为什么需要它
 *
 * DSH 出厂只提供**单向**的会话导出：Session Header 的「Download session log」
 * 与 `/export` 命令能把会话树打成 ZIP 下载走，但没有任何导入入口——归档离机就是
 * 死数据。本插件补上回程，让「换机迁移 / 归档留存的上下文」重新变成可续聊、
 * 可在侧边栏看到的会话。
 *
 * ## 落库路径（全部走出厂公开 API，不碰磁盘格式）
 *
 *   1. `readZip` 解出归档条目（自带实现，只用 node:zlib）；
 *   2. `parseSessionLog` 经 `sessionFormatCatalog.createRestore` 还原日志
 *      （与 DSH 自己读冷会话同一条链，跨代迁移 + 完整校验）；
 *   3. 规范化头：新会话 id、`isSeeded:false`、`cwd = 目标工作区路径`；
 *   4. `ctx.sessionPersistence.create(header)` → `handle.append(events)` →
 *      `handle.flush()` → `handle.close()`：由 JSONL 后端自己决定落盘目录与
 *      压缩帧，**不手工写 session.vN.jsonl**；
 *   5. `workspace.attachSession(rootId)` 把根会话记进工作区账目。
 *
 * ## 工作区归属的唯一规则（决定第 3 步为什么改 cwd）
 *
 * `Workspace.sessionIds` 的成员判定是**两条同时成立**：该 id 在工作区的持久账目
 * 数组里，**且**该会话头里的规范 cwd 等于工作区路径（`dsh-workspace` 的
 * `WorkspaceEntity`：账目 ∩ 头索引）。所以「导入到某个工作区」这件事，在数据上
 * 就是「把会话头的 cwd 写成该工作区路径」+「attachSession」两步，没有第三条路。
 * 新建工作区则先 `workspaceRegistry.create(path, title)`——它对路径做
 * `fs.realpath`，因此**目标目录必须已存在**（这是出厂语义，不是本插件的限制）；
 * 需要新建目录时由前端先调本插件的 `/mkdir`。
 *
 * ## 子代理会话
 *
 * 归档里 `subagents/<id>/` 的会话会被一并导入（id 全部重分配、`parentSession`
 * 重映射到本次的新根 id），但**默认不记进工作区账目**——本部署实测 438 条
 * `origin:'subagent'` 会话无一在工作区账目内，这是出厂惯例（子代理随父会话
 * 呈现）。需要时用 `attachSubagents=1` 打开。
 *
 * ## 路由（同源相对路径，loopback 直连与 dsh-lanmode 反代下都可用）
 *
 *   GET  /dsh-session-import/status      只读自检（能力探测 / 配置回显 / 计数）
 *   GET  /dsh-session-import/workspaces  工作区清单（导入目标候选）
 *   GET  /dsh-session-import/browse      列出目录层级（新建工作区选路径用）
 *   POST /dsh-session-import/mkdir       在既有父目录下新建一级目录
 *   POST /dsh-session-import/inspect     解析归档并回概览，**不写任何东西**
 *   POST /dsh-session-import/import      真正导入；目标工作区来自查询参数
 *
 * `inspect` 与 `import` 的请求体都是**归档原始字节**（不是 JSON），目标选择放在
 * 查询串里，避免把几十 MB 的归档再套一层 base64。
 *
 * @module dsh-session-import
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { ZipError, readZip } from './zipread.js';
import {
  SessionLogError,
  classifyArchiveEntries,
  loadFormatCatalog,
  parseSessionLog,
  planArchiveImport,
  summarizeArchive,
} from './sessionlog.js';

export const inject = ['webServer'];

const BASE = '/dsh-session-import';
const STATUS_PATH = `${BASE}/status`;
const WORKSPACES_PATH = `${BASE}/workspaces`;
const BROWSE_PATH = `${BASE}/browse`;
const MKDIR_PATH = `${BASE}/mkdir`;
const INSPECT_PATH = `${BASE}/inspect`;
const IMPORT_PATH = `${BASE}/import`;

/** 本实现的版本号：/status 回读它来判断「跑的是哪一版」（loader 按 specifier 缓存模块）。 */
export const VERSION = 1;

const DEFAULTS = {
  /** 归档字节上限；超过即 413。会话日志是文本，默认 256 MiB 已远超正常规模。 */
  maxArchiveBytes: 256 * 1024 * 1024,
  /** /mkdir 新建目录时允许的最大层级深度探测量（仅用于 browse 展示，不限制写入）。 */
  browseLimit: 500,
  /** 热重挂时路由被旧实例占用的重试次数与间隔（见 registerRoute 注释）。 */
  registerRetries: 40,
  registerRetryMs: 120,
  /** 未指定 workspaceId/newPath 时的兜底：false 表示必须显式选择。 */
  attachSubagents: false,
  /** 导入时是否重新分配会话 id（true = 可重复导入同一归档，永不撞已有会话）。 */
  assignNewIds: true,
  /** 是否顺带把归档里的附件（图片 / 文件）重新落进附件库。 */
  rehydrateAttachments: true,
};

/**
 * 归一化插件配置。与同 profile 的其它静态插件一致：手写 clamp，不引 schemastery，
 * 坏值一律回落到默认，不让一个错配置把整行打成 mount 失败。
 * @param {unknown} config patch 行里的 config。
 * @returns {typeof DEFAULTS} 归一化后的配置。
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const clampInt = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(number)));
  };
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  return {
    maxArchiveBytes: clampInt(raw.maxArchiveBytes, 1024, 4 * 1024 * 1024 * 1024, DEFAULTS.maxArchiveBytes),
    browseLimit: clampInt(raw.browseLimit, 1, 100000, DEFAULTS.browseLimit),
    registerRetries: clampInt(raw.registerRetries, 0, 200, DEFAULTS.registerRetries),
    registerRetryMs: clampInt(raw.registerRetryMs, 20, 5000, DEFAULTS.registerRetryMs),
    attachSubagents: bool(raw.attachSubagents, DEFAULTS.attachSubagents),
    assignNewIds: bool(raw.assignNewIds, DEFAULTS.assignNewIds),
    rehydrateAttachments: bool(raw.rehydrateAttachments, DEFAULTS.rehydrateAttachments),
  };
}

// ───────────────────────────── HTTP 小工具 ─────────────────────────────

/** 带状态码的调用方错误：4xx 的 message 会原样回到前端。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

/**
 * Same-origin 判定，对齐 `dsh-client-connection` 的 `isTrustedApiRequest`
 * 与同 profile 的 dsh-archived-sessions：`sec-fetch-site: cross-site` 一律拒绝；
 * 带 Origin 时必须与 Host 同源；无 Origin 的本机调用放行。
 * lanmode 会把 Host 与 Origin 双双改写成回环权威后再转发，故 LAN 客户端照常通过。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 是否可信。
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

/**
 * 读原始请求体（归档字节）。超限时暂停读取并以 413 拒绝，不 destroy socket。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<Buffer>} 请求体。
 * @throws {HttpError} 413 超限。
 */
function readRawBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
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
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > limit) {
        fail(new HttpError(413, `归档超过上限 ${limit} 字节（可在插件 config.maxArchiveBytes 调整）`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(error));
    req.on('aborted', () => fail(new Error('请求已中断')));
  });
}

/**
 * 读 JSON 请求体（仅用于 /mkdir 这类小请求）。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<object>} 解析后的对象。
 * @throws {HttpError} 413 超限或 400 非 JSON。
 */
function readJsonBody(req) {
  return readRawBody(req, 64 * 1024).then((buffer) => {
    if (buffer.length === 0) return {};
    try {
      const value = JSON.parse(buffer.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new HttpError(400, '请求体必须是 JSON 对象');
      }
      return value;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, `请求体不是合法 JSON：${errorText(error)}`);
    }
  });
}

const queryOf = (req, fallbackPath) => new URL(req.url ?? fallbackPath, 'http://localhost').searchParams;

/** 布尔查询参数：`1`/`true`/`yes`/`on` 为真，`0`/`false`/`no`/`off` 为假，其余取兜底。 */
function boolParam(params, key, fallback) {
  const value = params.get(key);
  if (value === null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

// ─────────────────────── 归档解析（inspect / import 共用） ───────────────────────

/**
 * 解出归档并解析其中全部会话日志。**不写任何东西**——导入前的全部校验都在这里
 * 完成，因此后面的落库阶段原则上只剩存储错误。
 *
 * @param {Buffer} body 归档字节。
 * @returns {Promise<{entries: Map<string, Uint8Array>, archive: object, warnings: string[]}>}
 * @throws {ZipError|SessionLogError} 归档或日志非法。
 */
async function loadArchive(body) {
  const warnings = [];
  const { entries, list } = readZip(body);
  const classified = classifyArchiveEntries(entries);
  if (classified.rootPath === null) {
    throw new SessionLogError('归档里没有根会话日志（期望 session.jsonl 或 session.vN.jsonl）');
  }
  if (classified.unknown.length > 0) {
    warnings.push(`归档含 ${classified.unknown.length} 个无法识别的条目，已忽略：${classified.unknown.slice(0, 5).join('、')}${classified.unknown.length > 5 ? ' …' : ''}`);
  }

  const catalog = await loadFormatCatalog();
  if (catalog === undefined) {
    warnings.push('未能装载 @deepseek-ai/dsh-session-format-catalog：按当前代直接解析，未做跨代迁移。');
  }

  const rootText = Buffer.from(entries.get(classified.rootPath)).toString('utf8');
  const root = { path: classified.rootPath, parsed: await parseSessionLog(rootText, { catalog }) };

  const subagents = [];
  for (const descriptor of classified.subagentPaths) {
    const text = Buffer.from(entries.get(descriptor.path)).toString('utf8');
    const parsed = await parseSessionLog(text, { catalog });
    subagents.push({ idFromPath: descriptor.idFromPath, path: descriptor.path, parsed });
  }

  const archive = {
    root,
    subagents,
    media: classified.media,
    files: classified.files,
    unknown: classified.unknown,
  };
  return { entries, archive, list, warnings };
}

// ───────────────────────────── 附件回灌 ─────────────────────────────

/**
 * 把归档里的附件重新落进本机附件库。
 *
 * 附件是**内容寻址**的：文件的 `attachmentId` 就是字节摘要，图片的归档条目名
 * 就是它原来的 `attachmentId`。所以只要存进去的字节一致，拿回的 id 就与日志里
 * 引用的一致，历史里的图片/文件引用不会变成悬空指针。
 *
 * 全程 best-effort：附件服务缺席或某一条失败只记警告，**绝不阻塞会话导入**
 * （上下文是主产物，附件是增值项）。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} archive `loadArchive` 的结果。
 * @param {Map<string, Uint8Array>} entries 归档条目。
 * @returns {Promise<{files: number, images: number, failed: Array<{path: string, error: string}>, warnings: string[]}>}
 */
async function rehydrateAttachments(ctx, archive, entries) {
  const result = { files: 0, images: 0, failed: [], warnings: [] };
  const attachments = ctx.get('attachments');
  if (attachments === undefined || attachments === null) {
    if (archive.files.length + archive.media.length > 0) {
      result.warnings.push('附件服务不可用：归档里的图片与文件未回灌，历史中的附件引用会指向缺失对象。');
    }
    return result;
  }

  const stripDigest = (value) => String(value).replace(/^sha256:/u, '');

  for (const file of archive.files) {
    const data = entries.get(file.path);
    if (data === undefined) continue;
    try {
      const ref = await attachments.saveFile({ data, name: file.name });
      if (stripDigest(ref.attachmentId) !== stripDigest(file.digest)) {
        result.warnings.push(`文件附件 ${file.name} 回灌后的摘要与归档不一致，历史引用可能失效。`);
      } else {
        result.files += 1;
      }
    } catch (error) {
      result.failed.push({ path: file.path, error: errorText(error) });
    }
  }

  for (const image of archive.media) {
    const data = entries.get(image.path);
    if (data === undefined) continue;
    if (image.mediaType === undefined) {
      result.failed.push({ path: image.path, error: `无法从扩展名 .${image.extension} 判定媒体类型` });
      continue;
    }
    try {
      const ref = await attachments.saveImage({ data, mediaType: image.mediaType });
      if (String(ref.attachmentId) !== image.attachmentId) {
        result.warnings.push(`图片附件 ${image.attachmentId} 回灌后的 id 与归档不同（${String(ref.attachmentId)}），该图在历史中的引用可能失效。`);
      } else {
        result.images += 1;
      }
    } catch (error) {
      result.failed.push({ path: image.path, error: errorText(error) });
    }
  }

  if (result.failed.length > 0) {
    result.warnings.push(`${result.failed.length} 个附件回灌失败（已跳过，不影响会话导入）。`);
  }
  return result;
}

// ───────────────────────────── 插件本体 ─────────────────────────────

/**
 * 装载 host 半边：注册六条同源路由。
 * @param {object} ctx cordis 上下文（依赖 `webServer`；其余服务按需 `ctx.get`）。
 * @param {unknown} config patch 行的 config。
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const counters = { inspect: 0, imports: 0, sessionsWritten: 0, lastError: null };

  /** 取一个必需服务；缺席时给出可行动的中文错误而不是 TypeError。 */
  const requireService = (name, hint) => {
    const service = ctx.get(name);
    if (service === undefined || service === null) {
      throw new HttpError(503, `${hint}（服务 ${name} 不可用）`);
    }
    return service;
  };

  /**
   * 注册一条精确路由，并容忍 patch 层热重挂时的瞬时占用。
   *
   * profile 是 patchReload=live，而 loader 的 EntryGroup.update 是**先建全部新
   * entry、再拆被删掉的旧 entry**，于是新行的 apply 会在旧行仍占着同名路径期间
   * 执行，`webServer.register` 的 duplicate 检查抛错 → 整层 update 回滚 → 旧代码
   * 继续在跑。这里把「路径已被占用」当成可恢复状态重试，dispose 时撤销未完成的
   * 定时器与已注册的路由。（与 dsh-archived-sessions 的 registerRoute 同一套路。）
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
        ctx.logger?.warn?.(`dsh-session-import: 路由 ${path} 注册失败：${errorText(error)}`);
      }
    };
    attempt(options.registerRetries);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (unregister !== null) unregister();
    };
  }, label);

  /** 统一的处理器包装：同源守卫 + 异常翻译成 JSON 错误。 */
  const handle = (name, methods, fn) => async (req, res) => {
    if (!methods.includes(req.method ?? 'GET')) {
      return json(res, 405, { ok: false, error: 'Method Not Allowed' });
    }
    if (!sameOrigin(req)) {
      return json(res, 403, { ok: false, error: 'cross-origin request rejected' });
    }
    try {
      const value = await fn(req, res);
      if (res.writableEnded === true) return undefined;
      return json(res, 200, { ok: true, ...value });
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : (error instanceof ZipError || error instanceof SessionLogError ? 400 : 500);
      if (status >= 500) {
        counters.lastError = { at: new Date().toISOString(), route: name, error: errorText(error) };
        ctx.logger?.warn?.(`dsh-session-import: ${name} 失败：${errorText(error)}`);
      }
      return json(res, status, { ok: false, error: errorText(error), code: error?.code ?? null });
    }
  };

  // ── GET /status ───────────────────────────────────────────────────────────
  registerRoute('dsh-session-import: status route', STATUS_PATH, handle('status', ['GET', 'HEAD'], async () => {
    const registry = ctx.get('workspaceRegistry');
    const persistence = ctx.get('sessionPersistence');
    const attachments = ctx.get('attachments');
    const catalog = await loadFormatCatalog();
    return {
      version: VERSION,
      config: options,
      counters,
      capabilities: {
        workspaceRegistry: typeof registry?.list === 'function',
        sessionPersistence: typeof persistence?.create === 'function',
        attachments: typeof attachments?.saveFile === 'function',
        formatCatalog: catalog !== undefined,
        formatCatalogVersion: catalog?.currentVersion ?? null,
      },
    };
  }));

  // ── GET /workspaces ───────────────────────────────────────────────────────
  registerRoute('dsh-session-import: workspaces route', WORKSPACES_PATH, handle('workspaces', ['GET', 'HEAD'], async () => {
    const registry = requireService('workspaceRegistry', '工作区注册表不可用');
    if (typeof registry.list !== 'function') throw new HttpError(503, '工作区注册表没有 list()');
    const listed = await registry.list();
    const workspaces = [];
    for (const workspace of Array.isArray(listed) ? listed : []) {
      if (workspace === null || typeof workspace !== 'object') continue;
      let status = 'ok';
      try {
        status = typeof workspace.status === 'function' ? await workspace.status() : 'ok';
      } catch {
        status = 'unknown';
      }
      workspaces.push({
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : '',
        path: typeof workspace.path === 'string' ? workspace.path : '',
        sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        status,
      });
    }
    return { workspaces, browseRoot: homedir() };
  }));

  // ── GET /browse ───────────────────────────────────────────────────────────
  registerRoute('dsh-session-import: browse route', BROWSE_PATH, handle('browse', ['GET', 'HEAD'], async (req) => {
    const params = queryOf(req, BROWSE_PATH);
    const requested = params.get('path');
    const target = requested === null || requested === '' ? homedir() : requested;
    if (!isAbsolute(target)) throw new HttpError(400, '路径必须是绝对路径');
    let canonical;
    try {
      canonical = await realpath(target);
    } catch (error) {
      throw new HttpError(404, `目录不存在或不可读：${target}`);
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new HttpError(400, `不是目录：${canonical}`);

    const dirents = await readdir(canonical, { withFileTypes: true });
    const directories = dirents
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: join(canonical, entry.name) }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .slice(0, options.browseLimit);

    const parent = resolve(canonical, '..');
    return {
      path: canonical,
      parent: parent === canonical ? null : parent,
      entries: directories,
      truncated: dirents.length > options.browseLimit,
    };
  }));

  // ── POST /mkdir ───────────────────────────────────────────────────────────
  registerRoute('dsh-session-import: mkdir route', MKDIR_PATH, handle('mkdir', ['POST'], async (req) => {
    const body = await readJsonBody(req);
    const parent = body.parent;
    const name = body.name;
    if (typeof parent !== 'string' || parent === '' || !isAbsolute(parent)) {
      throw new HttpError(400, 'parent 必须是绝对路径');
    }
    if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
      || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new HttpError(400, 'name 必须是单个非空路径段（不含分隔符）');
    }
    let parentCanonical;
    try {
      parentCanonical = await realpath(parent);
    } catch {
      throw new HttpError(404, `父目录不存在：${parent}`);
    }
    const target = join(parentCanonical, name);
    try {
      await mkdir(target);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new HttpError(409, `目录已存在：${target}`);
      throw new HttpError(500, `创建目录失败：${errorText(error)}`);
    }
    return { path: await realpath(target) };
  }));

  // ── POST /inspect ─────────────────────────────────────────────────────────
  registerRoute('dsh-session-import: inspect route', INSPECT_PATH, handle('inspect', ['POST'], async (req) => {
    const body = await readRawBody(req, options.maxArchiveBytes);
    if (body.length === 0) throw new HttpError(400, '请求体为空：请上传 /export 导出的 ZIP 归档');
    const { archive, warnings } = await loadArchive(body);
    counters.inspect += 1;
    return { summary: summarizeArchive(archive), warnings };
  }));

  // ── POST /import ──────────────────────────────────────────────────────────
  registerRoute('dsh-session-import: import route', IMPORT_PATH, handle('import', ['POST'], async (req) => {
    const params = queryOf(req, IMPORT_PATH);
    const body = await readRawBody(req, options.maxArchiveBytes);
    if (body.length === 0) throw new HttpError(400, '请求体为空：请上传 /export 导出的 ZIP 归档');

    // ① 目标工作区（先定，未选定就不必解析归档）
    const registry = requireService('workspaceRegistry', '工作区注册表不可用');
    const workspaceId = params.get('workspaceId');
    const newPath = params.get('newPath');
    let workspace;
    let workspaceCreated = false;
    if (workspaceId !== null && workspaceId !== '') {
      if (typeof registry.get !== 'function') throw new HttpError(503, '工作区注册表没有 get()');
      workspace = registry.get(workspaceId);
      if (workspace === undefined || workspace === null) throw new HttpError(404, `未知工作区 id：${workspaceId}`);
    } else if (newPath !== null && newPath !== '') {
      if (!isAbsolute(newPath)) throw new HttpError(400, '新工作区路径必须是绝对路径');
      const title = params.get('newTitle');
      // create() 内部做 fs.realpath：路径必须已存在且是目录（出厂语义）。
      try {
        workspace = await registry.create(newPath, title !== null && title !== '' ? title : basename(newPath));
      } catch (error) {
        throw new HttpError(400, `新建工作区失败：${errorText(error)}（目标目录必须已存在；可先用 /mkdir 创建）`);
      }
      workspaceCreated = true;
    } else {
      throw new HttpError(400, '必须指定归属工作区：workspaceId=<既有 id> 或 newPath=<绝对路径>');
    }
    const workspacePath = String(workspace.path);

    // ② 解析归档（全量校验，此时尚未写任何东西）
    const { entries, archive, warnings: loadWarnings } = await loadArchive(body);
    const warnings = [...loadWarnings];

    // ③ 规划：分配新 id、构造新头、重映射子代理父引用
    const includeSubagents = boolParam(params, 'includeSubagents', true);
    const assignNewIds = boolParam(params, 'assignNewIds', options.assignNewIds);
    const plan = planArchiveImport(archive, {
      cwd: workspacePath,
      idFactory: () => `session-${randomUUID()}`,
      assignNewIds,
      includeSubagents,
    });
    warnings.push(...plan.warnings);

    // ④ 新 id 可用性预检：id 已存在会让 create() 抛错，提前查比写一半再失败好。
    const persistence = requireService('sessionPersistence', '会话持久化服务不可用');
    if (typeof persistence.create !== 'function') throw new HttpError(503, '会话持久化服务没有 create()');
    for (const session of plan.sessions) {
      const existing = await persistence.stat(session.id);
      if (existing !== undefined) {
        throw new HttpError(409, `会话 id 已存在：${session.id}（可改用 assignNewIds=1 重新分配）`);
      }
    }

    // ⑤ 附件回灌（best-effort，失败只记警告）
    let attachments = { files: 0, images: 0, failed: [], warnings: [] };
    if (options.rehydrateAttachments && (archive.files.length > 0 || archive.media.length > 0)) {
      attachments = await rehydrateAttachments(ctx, archive, entries);
      warnings.push(...attachments.warnings);
    }

    // ⑥ 落库：create → append → flush → close。逐条记录已写入的会话，中途失败如实上报。
    const written = [];
    for (const session of plan.sessions) {
      let handle;
      try {
        handle = await persistence.create(session.header);
        if (session.events.length > 0) await handle.append(session.events);
        await handle.flush();
      } catch (error) {
        const partial = written.length > 0
          ? `；已成功写入 ${written.length} 条会话（${written.map((entry) => entry.id).join('、')}），本次导入未完成`
          : '';
        throw new HttpError(500, `写入会话 ${session.id} 失败：${errorText(error)}${partial}`);
      } finally {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch { /* close 失败不掩盖主错误 */ }
        }
      }
      written.push({
        id: session.id,
        role: session.role,
        originalId: session.originalId,
        events: session.events.length,
      });
      counters.sessionsWritten += 1;
    }

    // ⑦ 记账：根会话进目标工作区（子代理按配置）。
    const rootSession = written.find((entry) => entry.role === 'root');
    const attachSubagents = boolParam(params, 'attachSubagents', options.attachSubagents);
    const attached = [];
    const attachFailed = [];
    const toAttach = attachSubagents ? written : written.filter((entry) => entry.role === 'root');
    for (const entry of toAttach) {
      try {
        if (typeof workspace.attachSession !== 'function') throw new Error('工作区实体没有 attachSession()');
        await workspace.attachSession(entry.id);
        attached.push(entry.id);
      } catch (error) {
        attachFailed.push({ id: entry.id, error: errorText(error) });
      }
    }
    if (attachFailed.length > 0) {
      warnings.push(`有 ${attachFailed.length} 条会话未能记入工作区账目（它们仍可从持久化读到）：${attachFailed.map((entry) => `${entry.id}（${entry.error}）`).join('；')}`);
    }

    counters.imports += 1;
    return {
      sessionId: rootSession?.id ?? null,
      workspace: {
        id: String(workspace.id),
        title: typeof workspace.title === 'string' ? workspace.title : '',
        path: workspacePath,
        created: workspaceCreated,
      },
      sessions: written,
      attached,
      attachments: { files: attachments.files, images: attachments.images, failed: attachments.failed },
      summary: summarizeArchive(archive),
      warnings,
    };
  }));
}
