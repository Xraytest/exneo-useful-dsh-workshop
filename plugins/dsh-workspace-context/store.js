/**
 * dsh-workspace-context —— 存储层。
 *
 * 设计要点（为什么是「一工作区一 markdown 文件、绑定信息写在文件头」）：
 *   - **单一事实源**：正文与绑定关系都在同一个文件里，不存在 index.json 与正文
 *     两份状态互相背离的可能；人直接 `vim` 改正文即可，插件按 mtime+size 热读。
 *   - **文件头即绑定**：`<!-- dsh-workspace-context\nworkspace: <绝对路径> ... -->`
 *     是权威绑定；正文 = 头部之后的内容（头部不进模型上下文）。
 *   - **人的手艺不至于毁掉数据**：头缺失/写坏的文件不猜、不删，进 `unbound`
 *     列表，由 UI/工具显式 `bind` 收编。
 *   - **文件名只是保险**：`<可读 slug>--<路径 sha1 前 8 位>.md`，可读且不撞车；
 *     真正的键始终是头部里的路径。
 *
 * 本文件不依赖 Cordis，也不碰任何服务：全部是可单测的纯逻辑 + 文件 IO。
 *
 * @module dsh-workspace-context/store
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** 存储格式版本（对 UI/工具暴露，便于日后迁移）。 */
export const SCHEMA = 1;
/** 文件头标记字。 */
export const MARKER = 'dsh-workspace-context';
/** 上下文文件扩展名。 */
export const FILE_EXT = '.md';
/** 注入正文的缺省字节上限（超出即截断并附可见提示）。 */
export const DEFAULT_MAX_BYTES = 32768;
/** 外部改文件后多久内被读到（毫秒）。 */
export const DEFAULT_TTL_MS = 1000;

/** DSH home：`$DSH_HOME` 优先，其次 `~/.dsh`（与出厂 dsh-home-paths 同口径）。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/** 本插件的缺省存储根：`$DSH_HOME/workspace-context`。 */
export function defaultStoreDir() {
  return join(dshHome(), 'workspace-context');
}

/** 目标路径是否存在且是目录。 */
export function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 规范化工作区路径：必须是**绝对路径**，能 realpath 就 realpath
 * （与 workspaceRegistry 的唯一性口径一致：符号链接指向同一目录即同一工作区）。
 *
 * @param {unknown} target - 调用方给的路径。
 * @param {{mustExist?: boolean}} [options] - mustExist 时要求存在且为目录。
 * @returns {string} 规范化后的绝对路径。
 */
export function canonicalPath(target, options = {}) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('工作区路径必须是非空字符串');
  }
  const given = target.trim();
  if (!isAbsolute(given)) {
    throw new Error(`工作区路径必须是绝对路径：${given}`);
  }
  const absolute = resolve(given);
  let real;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    if (options.mustExist === true) {
      throw new Error(`工作区路径不存在或不可访问：${absolute}（${error && error.code ? error.code : error}）`);
    }
    return absolute;
  }
  if (options.mustExist === true && !isDirectory(real)) {
    throw new Error(`工作区路径不是目录：${real}`);
  }
  return real;
}

/** 文件名 slug：可读尾部 + 路径 sha1 前 8 位，保证唯一且不依赖路径长度。 */
export function slugFor(target) {
  const readable = String(target)
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(-48);
  const hash = createHash('sha1').update(String(target)).digest('hex').slice(0, 8);
  return `${readable === '' ? 'workspace' : readable}--${hash}`;
}

/** 某工作区对应的上下文文件绝对路径。 */
export function contextFileFor(dir, target) {
  return join(resolve(dir), 'contexts', slugFor(target) + FILE_EXT);
}

/** 头部匹配：允许 BOM/空白前缀，字段区到第一个 `-->` 为止。 */
const HEADER_RE = /^\uFEFF?[ \t\r\n]*<!--\s*dsh-workspace-context\b([\s\S]*?)-->/;

/**
 * 解析一个上下文文件。
 *
 * @param {string} raw - 文件原文。
 * @returns {{bound: boolean, reason?: string, workspace?: string, title?: string,
 *   enabled?: boolean, updatedAt?: string, updatedBy?: string, text: string}}
 *   `bound:false` 时 `reason` ∈ {missing-header, missing-workspace}，调用方据此归入
 *   unbound；`text` 一律给出「头部之后」的正文，供预览与收编。
 */
export function parseContextFile(raw) {
  const source = typeof raw === 'string' ? raw : '';
  const match = HEADER_RE.exec(source);
  if (match === null) {
    return { bound: false, reason: 'missing-header', text: source };
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === '' || value === '') continue;
    fields[key] = value;
  }
  // 头部 `-->` 所在行的行尾 + 其后用于排版的空行都不属于正文；正文从此逐字保留。
  const text = source.slice(match[0].length).replace(/^\r?\n/, '').replace(/^(?:[ \t]*\r?\n)*/, '');
  const workspace = typeof fields.workspace === 'string' ? fields.workspace : undefined;
  if (workspace === undefined) {
    return { bound: false, reason: 'missing-workspace', text, fields };
  }
  return {
    bound: true,
    workspace,
    title: fields.title,
    enabled: fields.enabled === undefined ? true : fields.enabled !== 'false',
    updatedAt: fields.updated,
    updatedBy: fields.by,
    text,
    fields,
  };
}

/** 渲染一个上下文文件（头部 + 空行 + 正文）。字段顺序固定，便于人工 diff。 */
export function renderContextFile(input) {
  const lines = [`<!-- ${MARKER}`, `workspace: ${String(input.workspace)}`];
  if (typeof input.title === 'string' && input.title.trim() !== '') {
    lines.push(`title: ${input.title.trim().replace(/[\r\n]+/g, ' ')}`);
  }
  lines.push(`enabled: ${input.enabled === false ? 'false' : 'true'}`);
  if (typeof input.updatedAt === 'string' && input.updatedAt !== '') lines.push(`updated: ${input.updatedAt}`);
  if (typeof input.updatedBy === 'string' && input.updatedBy !== '') lines.push(`by: ${input.updatedBy}`);
  lines.push('-->', '', typeof input.text === 'string' ? input.text : '');
  return lines.join('\n');
}

/**
 * 中和 `{{…}}` 模板引用。
 *
 * **为什么必须做**：本插件的正文注入为 system-prompt 的 section，而装配后的
 * `renderPrompt` 会对每个 section 正文做**严格** `{{variable}}` 插值——未知变量、
 * 或「有 `{{` 且后面还有 `}}`」的畸形写法都会 **throw**，等于让用户正文里一句
 * `{{name}}` 把该工作区的每个请求都打挂。故在注入前拆开每一对相邻的 `{`（中间插
 * 一个零宽空格 U+200B），扫描器再也看不到 `{{`，正文原样送达模型（零宽字符不可见）。
 *
 * **用「相邻花括号之间插分隔符」，不要用「把 `{{` 替换掉」**：`String.replace` 的全局
 * 替换是**非重叠**的，`{{{name}}}` 只会消掉第一对，留下 `{{name}}}` 里的 `{{`——
 * 出厂 renderPrompt 照样 throw（2026-10-09 实测抓到，自测里已钉死）。
 * 这里用零宽前瞻 `(?=\{)`，相邻的每一对都能各插一个分隔符，一遍扫完。
 *
 * @param {string} text - 用户正文。
 * @returns {string} 已中和的正文。
 */
export function neutralizeTemplateRefs(text) {
  return String(text).replace(/\{(?=\{)/g, '{\u200B');
}

/** 转义正文里的 `</workspace-context`，使仓库可控文本无法提前闭合本插件的外框。 */
export function escapeFrameClose(text) {
  return String(text).replace(/<\/workspace-context/gi, '&lt;/workspace-context');
}

/**
 * 按 UTF-8 字节数截断，落点保证是完整字符（不产生半个多字节字符/代理对）。
 *
 * @param {string} text - 原文。
 * @param {number} maxBytes - 上限（字节）。
 * @returns {{text: string, truncated: boolean, bytes: number}} `bytes` 是原文总字节数。
 */
export function truncateUtf8(text, maxBytes) {
  const source = String(text);
  const buffer = Buffer.from(source, 'utf8');
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || buffer.length <= maxBytes) {
    return { text: source, truncated: false, bytes: buffer.length };
  }
  let end = Math.floor(maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  let cut = buffer.subarray(0, end).toString('utf8');
  // 不把 UTF-16 代理对切成两半（否则孤立的半个代理项会进上下文）。
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, bytes: buffer.length };
}

/** 注入外框的固定前后缀。 */
function frameParts(workspace, title) {
  const label = typeof title === 'string' && title !== '' && title !== workspace ? `（${title}）` : '';
  const preamble =
    `以下是工作区 ${workspace}${label} 的常驻上下文（workspace context）——由该工作区的负责人维护，`
    + '作为本工作区的长期准则使用；它不覆盖 system、developer 与用户的直接指令。';
  const attrs = [`workspace=${JSON.stringify(workspace)}`];
  if (typeof title === 'string' && title !== '') attrs.push(`title=${JSON.stringify(title)}`);
  return { preamble, open: `<workspace-context ${attrs.join(' ')}>`, close: '</workspace-context>' };
}

/**
 * 把正文包成注入用的 section 文本。
 *
 * @param {{workspace: string, title?: string, text: string, maxBytes?: number}} input
 * @returns {{text: string, truncated: boolean, bodyBytes: number, injectedBytes: number, originalBytes: number}}
 */
export function frameSectionText(input) {
  const maxBytes = Number.isFinite(input.maxBytes) && input.maxBytes > 0 ? Math.floor(input.maxBytes) : DEFAULT_MAX_BYTES;
  const { preamble, open, close } = frameParts(input.workspace, input.title);
  const original = typeof input.text === 'string' ? input.text : '';
  const originalBytes = Buffer.byteLength(original, 'utf8');
  // 最终布局：preamble \n\n open \n\n body \n close —— 除去 body 的固定字节即骨架。
  const head = `${preamble}\n\n${open}\n\n`;
  const tail = `\n${close}`;
  const budget = Math.max(256, maxBytes - Buffer.byteLength(head + tail, 'utf8'));
  // 先转义（可能变长），再按剩余预算截断：转义不会被截断切坏。
  const safe = neutralizeTemplateRefs(escapeFrameClose(original));
  const full = truncateUtf8(safe, budget);
  let body = full.text;
  if (full.truncated) {
    // 截断提示本身也占字节，且提示里写着「已注入多少字节」——这个数字随截断结果变化，
    // 故迭代到数字位数稳定为止（最多两轮即收敛），保证总字节数不超 maxBytes。
    const notice = (shown) => `\n\n[workspace-context 已截断：正文共 ${originalBytes} 字节，`
      + `本次仅注入前约 ${shown} 字节；请精简文件，或调高插件 config.maxBytes]`;
    let shown = full.bytes;
    for (let pass = 0; pass < 4; pass += 1) {
      const allowed = Math.max(64, budget - Buffer.byteLength(notice(shown), 'utf8'));
      body = truncateUtf8(safe, allowed).text;
      const actual = Buffer.byteLength(body, 'utf8');
      if (actual === shown) break;
      shown = actual;
    }
    body += notice(shown);
  }
  const text = `${head}${body}${tail}`;
  return {
    text,
    truncated: full.truncated,
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    injectedBytes: Buffer.byteLength(text, 'utf8'),
    originalBytes,
  };
}

/** 单行预览（unbound 文件列表用）。 */
function previewOf(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** parent 是否是 child 的祖先目录（含相等）。 */
export function isAncestor(parent, child) {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/** 原子写：先写同目录临时文件再 rename，读者只会看到旧内容或新内容。 */
function writeFileAtomic(target, text) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    renameSync(tmp, target);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

/**
 * 建立存储句柄。
 *
 * @param {{dir?: string, ttlMs?: number, maxBytes?: number, inheritFromAncestor?: boolean}} [options]
 */
export function createStore(options = {}) {
  const dir = resolve(String(options.dir !== undefined && options.dir !== null && String(options.dir).trim() !== ''
    ? options.dir
    : defaultStoreDir()));
  const contextsDir = join(dir, 'contexts');
  const trashDir = join(dir, 'trash');
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? Math.floor(options.ttlMs) : DEFAULT_TTL_MS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 512
    ? Math.floor(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const inheritFromAncestor = options.inheritFromAncestor !== false;

  /** 索引缓存：TTL 内复用；外部改文件靠它 + 每文件的 mtime/size 双重探测发现。 */
  let indexCache = { at: 0, value: undefined };
  /** 每文件内容缓存：mtimeMs+size 未变即复用（人改文件后下一次 stat 就发现）。 */
  const textCache = new Map();

  function ensureDirs() {
    mkdirSync(contextsDir, { recursive: true });
    mkdirSync(trashDir, { recursive: true });
  }

  function loadFile(file) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      textCache.delete(file);
      return undefined;
    }
    const cached = textCache.get(file);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      return { mtimeMs: stat.mtimeMs, size: stat.size, raw: '', parsed: undefined, error: `读取失败：${error && error.code ? error.code : error}` };
    }
    const value = { mtimeMs: stat.mtimeMs, size: stat.size, raw, parsed: parseContextFile(raw), error: undefined };
    textCache.set(file, value);
    return value;
  }

  function digestOf(text) {
    return createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
  }

  /** 扫描存储目录，产出索引（带 TTL 缓存）。 */
  function scan(force = false) {
    const now = Date.now();
    if (force !== true && indexCache.value !== undefined && now - indexCache.at < ttlMs) return indexCache.value;
    /** @type {any[]} */
    const entries = [];
    /** @type {any[]} */
    const unbound = [];
    /** @type {string[]} */
    const errors = [];
    let names = [];
    if (existsSync(contextsDir)) {
      try {
        names = readdirSync(contextsDir).filter((name) => name.endsWith(FILE_EXT) && !name.startsWith('.')).sort();
      } catch (error) {
        errors.push(`目录列举失败 ${contextsDir}：${error && error.message ? error.message : error}`);
      }
    }
    const byPath = new Map();
    for (const name of names) {
      const file = join(contextsDir, name);
      const loaded = loadFile(file);
      if (loaded === undefined) continue;
      if (loaded.error !== undefined) {
        errors.push(`${name}：${loaded.error}`);
        continue;
      }
      const parsed = loaded.parsed;
      if (parsed.bound !== true) {
        unbound.push({
          file,
          name,
          bytes: loaded.size,
          reason: parsed.reason,
          preview: previewOf(parsed.text),
        });
        continue;
      }
      let workspace;
      try {
        workspace = canonicalPath(parsed.workspace);
      } catch (error) {
        unbound.push({
          file,
          name,
          bytes: loaded.size,
          reason: 'invalid-workspace',
          detail: error && error.message ? error.message : String(error),
          preview: previewOf(parsed.text),
        });
        continue;
      }
      const previous = byPath.get(workspace);
      if (previous !== undefined) {
        errors.push(`重复绑定：${name} 与 ${previous.name} 都声明 workspace=${workspace}（按文件名排序取前者，后者进 unbound）`);
        unbound.push({
          file,
          name,
          bytes: loaded.size,
          reason: 'duplicate-binding',
          workspace,
          preview: previewOf(parsed.text),
        });
        continue;
      }
      const entry = {
        path: workspace,
        title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : (basename(workspace) || workspace),
        enabled: parsed.enabled !== false,
        updatedAt: parsed.updatedAt,
        updatedBy: parsed.updatedBy,
        file,
        name,
        bytes: loaded.size,
        textBytes: Buffer.byteLength(parsed.text, 'utf8'),
        text: parsed.text,
        digest: digestOf(parsed.text),
        mtimeMs: loaded.mtimeMs,
        exists: isDirectory(workspace),
      };
      byPath.set(workspace, entry);
      entries.push(entry);
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const revision = digestOf(entries.map((e) => `${e.path}\u0000${e.digest}\u0000${e.enabled ? 1 : 0}\u0000${e.title}`).join('\u0001'));
    const value = { at: now, schema: SCHEMA, dir, contextsDir, trashDir, maxBytes, ttlMs, inheritFromAncestor, entries, unbound, errors, revision };
    indexCache = { at: now, value };
    return value;
  }

  function invalidate() {
    indexCache = { at: 0, value: undefined };
  }

  /** 当前工作区 → 命中的条目（精确优先；可选最近祖先继承）。 */
  function resolveFor(cwd, opts = {}) {
    if (typeof cwd !== 'string' || cwd.trim() === '') return undefined;
    let target;
    try {
      target = canonicalPath(cwd);
    } catch {
      return undefined;
    }
    const index = scan();
    const exact = index.entries.find((entry) => entry.path === target);
    if (exact !== undefined) return { entry: exact, via: 'exact', cwd: target };
    const inherit = opts.inheritFromAncestor === undefined ? inheritFromAncestor : opts.inheritFromAncestor === true;
    if (!inherit) return undefined;
    const candidates = index.entries.filter((entry) => isAncestor(entry.path, target));
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.path.length - a.path.length);
    return { entry: candidates[0], via: 'ancestor', cwd: target };
  }

  /**
   * 某工作区本次要注入的 section。
   * @returns {undefined | {entry: any, via?: string, skipped?: string, text?: string,
   *   truncated?: boolean, bodyBytes?: number, injectedBytes?: number, originalBytes?: number}}
   */
  function sectionFor(cwd, opts = {}) {
    const resolved = resolveFor(cwd, opts);
    if (resolved === undefined) return undefined;
    const entry = resolved.entry;
    if (entry.enabled === false) return { entry, skipped: 'disabled' };
    if (String(entry.text).trim() === '') return { entry, skipped: 'empty' };
    const framed = frameSectionText({ workspace: entry.path, title: entry.title, text: entry.text, maxBytes });
    return { entry, via: resolved.via, ...framed };
  }

  /** 写入（等价于「人存盘」）：AI 工具/UI 都走这一条路。 */
  function writeEntry(args) {
    const target = canonicalPath(args.path, { mustExist: true });
    if (!isDirectory(target)) throw new Error(`工作区路径不是目录：${target}`);
    ensureDirs();
    const file = contextFileFor(dir, target);
    const loaded = loadFile(file);
    const parsed = loaded !== undefined && loaded.parsed !== undefined && loaded.parsed.bound === true ? loaded.parsed : undefined;
    const title = typeof args.title === 'string' && args.title.trim() !== ''
      ? args.title.trim()
      : (parsed !== undefined && typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : (basename(target) || target));
    const enabled = args.enabled === undefined ? (parsed === undefined ? true : parsed.enabled !== false) : args.enabled !== false;
    const raw = renderContextFile({
      workspace: target,
      title,
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy: typeof args.updatedBy === 'string' && args.updatedBy !== '' ? args.updatedBy : 'unknown',
      text: typeof args.text === 'string' ? args.text : '',
    });
    writeFileAtomic(file, raw);
    textCache.delete(file);
    invalidate();
    return scan(true).entries.find((entry) => entry.path === target);
  }

  /** 只改启用位（不删正文）。 */
  function setEnabled(path, enabled) {
    const target = canonicalPath(path, { mustExist: true });
    const loaded = loadFile(contextFileFor(dir, target));
    if (loaded === undefined || loaded.parsed === undefined || loaded.parsed.bound !== true) {
      throw new Error(`该工作区还没有常驻上下文：${target}`);
    }
    return writeEntry({ path: target, text: loaded.parsed.text, title: loaded.parsed.title, enabled: enabled !== false, updatedBy: 'human' });
  }

  /** 收编一个 unbound 文件到指定工作区（重写头部 → 落到规范文件名）。 */
  function bind(args) {
    const target = canonicalPath(args.path, { mustExist: true });
    if (!isDirectory(target)) throw new Error(`工作区路径不是目录：${target}`);
    const index = scan(true);
    const orphan = index.unbound.find((item) => item.name === args.file || item.file === args.file);
    if (orphan === undefined) throw new Error(`没有这个未绑定文件：${args.file}`);
    const loaded = loadFile(orphan.file);
    if (loaded === undefined || loaded.parsed === undefined) throw new Error(`读取失败：${orphan.file}`);
    ensureDirs();
    const destination = contextFileFor(dir, target);
    if (existsSync(destination) && resolve(destination) !== resolve(orphan.file)) {
      const existing = loadFile(destination);
      const empty = existing === undefined || existing.parsed === undefined || existing.parsed.bound !== true
        || String(existing.parsed.text).trim() === '';
      if (args.overwrite !== true && !empty) {
        throw new Error(`该工作区已有常驻上下文：${destination}（需 overwrite 才覆盖；被覆盖者会移入回收站）`);
      }
      if (!empty) trashFile(destination);
    }
    const title = typeof args.title === 'string' && args.title.trim() !== ''
      ? args.title.trim()
      : (loaded.parsed.title || basename(target) || target);
    writeFileAtomic(destination, renderContextFile({
      workspace: target,
      title,
      enabled: loaded.parsed.enabled !== false,
      updatedAt: new Date().toISOString(),
      updatedBy: 'bind',
      text: loaded.parsed.text,
    }));
    textCache.delete(orphan.file);
    textCache.delete(destination);
    if (resolve(destination) !== resolve(orphan.file)) {
      try {
        rmSync(orphan.file, { force: true });
      } catch (error) {
        throw new Error(`已写入 ${destination}，但清理原文件失败：${error && error.message ? error.message : error}`);
      }
    }
    invalidate();
    return scan(true).entries.find((entry) => entry.path === target);
  }

  /** 把文件移入回收站（**不硬删**，人工可捞回）。 */
  function trashFile(file) {
    ensureDirs();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = join(trashDir, `${basename(file)}.${stamp}`);
    renameSync(file, destination);
    textCache.delete(file);
    invalidate();
    return destination;
  }

  /** 按工作区路径把其上下文文件移入回收站。 */
  function trashEntry(path) {
    const target = canonicalPath(path);
    const index = scan(true);
    const entry = index.entries.find((item) => item.path === target);
    if (entry === undefined) throw new Error(`该工作区还没有常驻上下文：${target}`);
    return trashFile(entry.file);
  }

  /** 合并外部来源的工作区清单（workspaceRegistry / 见过的 cwd），供 UI 选择。 */
  function workspaceList(extra = []) {
    const index = scan();
    const map = new Map();
    for (const entry of index.entries) {
      map.set(entry.path, { path: entry.path, title: entry.title, source: 'entry', hasEntry: true, enabled: entry.enabled, textBytes: entry.textBytes });
    }
    for (const item of extra) {
      if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || item.path === '') continue;
      let path;
      try {
        path = canonicalPath(item.path);
      } catch {
        continue;
      }
      const existing = map.get(path);
      if (existing !== undefined) {
        // 已有条目：只补上更权威的标题来源（entry 的标题优先，除非它是缺省 basename）。
        if (existing.title === (basename(path) || path) && typeof item.title === 'string' && item.title !== '') existing.title = item.title;
        existing.registry = item.source === 'registry' ? true : existing.registry;
        existing.seen = item.source === 'seen' ? true : existing.seen;
        continue;
      }
      map.set(path, {
        path,
        title: typeof item.title === 'string' && item.title !== '' ? item.title : (basename(path) || path),
        source: item.source === 'registry' ? 'registry' : 'seen',
        hasEntry: false,
        enabled: false,
        textBytes: 0,
      });
    }
    return [...map.values()].sort((a, b) => {
      if (a.hasEntry !== b.hasEntry) return a.hasEntry ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  }

  return {
    dir,
    contextsDir,
    trashDir,
    maxBytes,
    ttlMs,
    inheritFromAncestor,
    ensureDirs,
    scan,
    invalidate,
    resolveFor,
    sectionFor,
    writeEntry,
    setEnabled,
    bind,
    trashEntry,
    workspaceList,
    /** 供测试/诊断：某文件当前解析结果。 */
    inspectFile(file) {
      const loaded = loadFile(file);
      return loaded === undefined ? undefined : { ...loaded, parsed: loaded.parsed };
    },
  };
}