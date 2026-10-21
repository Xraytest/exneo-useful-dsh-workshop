/**
 * rawlog — 原始会话日志的离线解码工具（无 Cordis 依赖，可在 node 里单跑）。
 *
 * 用途：主回填走 ctx.sessionQuery.readSession（后端无关）；本模块只服务两条补充通道：
 *   1) extraSessionRoots：另一个 DSH home / 备份根目录里的 sessions 树；
 *   2) zipImportDirs：/export 导出的归档 zip。
 * selftest 也用它读真实语料做对账。
 *
 * 实测要点（2026-10-08，本机 188 会话 / 114MB 语料）：
 *   - 物理日志是【多个 zstd 帧首尾相接】。zlib.zstdDecompressSync(整块) 只解出第一帧
 *     （返回 198 字节，正好是头行），因此必须按 magic 28 b5 2f fd 扫描逐帧解压。
 *   - 帧边界不会切断 JSON 行（整语料 0 解析错误），但为稳妥仍用「拼接后再按 \n 切」。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 物理日志文件名：session.jsonl / session.v3.jsonl(.zstd) */
export const LOG_FILE_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/;

/**
 * 逐帧解压 zstd 拼接流。
 * 单帧解压失败时回退「从该 magic 到文件尾」，因为 zstdDecompressSync 遇到后续帧/尾随
 * 数据时只解第一帧而不报错——这正好能把「magic 误命中帧内部」的情况救回来。
 */
export function decodeZstdFrames(buf) {
  const out = [];
  let start = buf.indexOf(ZSTD_MAGIC, 0);
  let guard = 0;
  while (start !== -1 && start < buf.length && guard < 1e6) {
    guard++;
    const next = buf.indexOf(ZSTD_MAGIC, start + 4);
    let decoded = null;
    if (next !== -1) {
      try { decoded = zlib.zstdDecompressSync(buf.subarray(start, next)); } catch { decoded = null; }
    }
    if (decoded === null) {
      try { decoded = zlib.zstdDecompressSync(buf.subarray(start)); } catch { decoded = null; }
    }
    if (decoded !== null && decoded.length > 0) out.push(decoded);
    start = next;
  }
  return out;
}

/** 把物理日志字节解成文本（自动识别 zstd / 纯文本）。 */
export function decodeLogBytes(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    return Buffer.concat(decodeZstdFrames(buf)).toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * 解析逻辑日志文本 → { header, events, badLines }。
 * 第一行是会话头（{"type":"session",...}，注意它【没有 time 字段】）；其余为事件信封。
 */
export function parseLogText(text) {
  const lines = text.split('\n');
  const events = [];
  let header = null;
  let badLines = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { badLines++; continue; }
    if (obj && obj.type === 'session' && header === null) { header = obj; continue; }
    if (obj && typeof obj.type === 'string') events.push(obj);
    else badLines++;
  }
  return { header, events, badLines };
}

export function readLogFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseLogText(decodeLogBytes(buf));
}

/** fork 子会话的继承前缀切点：最后一个 {inherited:true} 的 session/end-seed 标记。 */
export function inheritedCutFromEvents(events) {
  let cut = 0;
  for (const e of events) {
    if (e.type === 'session/end-seed' && e.data && e.data.inherited === true) {
      if (typeof e.seq === 'number' && e.seq >= cut) cut = e.seq;
    }
  }
  return cut;
}

/** 从会话头上取 id / 元信息；缺失时用目录名兜底。 */
export function sessionMetaFromHeader(header, fallbackId) {
  const h = header || {};
  return {
    id: typeof h.id === 'string' && h.id ? h.id : (fallbackId || null),
    createdAt: typeof h.createdAt === 'number' ? h.createdAt : null,
    cwd: typeof h.cwd === 'string' ? h.cwd : null,
    parentSession: typeof h.parentSession === 'string' ? h.parentSession : null,
    origin: typeof h.origin === 'string' ? h.origin : null,
    delegationDepth: typeof h.delegationDepth === 'number' ? h.delegationDepth : null,
    agentPreset: typeof h.agentPreset === 'string' ? h.agentPreset : null,
    isSeeded: h.isSeeded === true,
    version: typeof h.version === 'number' ? h.version : null,
  };
}

/**
 * 遍历一个 sessions 根目录，收集 <root>/<project>/<sessionId>/session.vN.jsonl[.zstd]。
 * 目录名不参与主键（头行 id 优先），只作兜底。
 */
export function walkSessionRoot(rootDir, { maxDepth = 3 } = {}) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { visit(full, depth + 1); continue; }
      if (!ent.isFile()) continue;
      if (!LOG_FILE_RE.test(ent.name)) continue;
      found.push({ filePath: full, sessionId: path.basename(path.dirname(full)) });
    }
  };
  visit(rootDir, 0);
  return found;
}

/* ------------------------------------------------------------------ ZIP ---- */

export const ZIP_EOCD_SIG = 0x06054b50;
export const ZIP_CEN_SIG = 0x02014b50;
export const ZIP_LOC_SIG = 0x04034b50;

/** 读 zip 中央目录，返回 [{ name, data }]（仅支持 store / deflate，足够 /export 归档）。 */
export function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (!eocd) throw new Error('zip: 找不到 EOCD（不是有效 zip 或为分卷）');
  const entries = [];
  let off = eocd.cdOffset;
  for (let i = 0; i < eocd.cdCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== ZIP_CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    const next = off + 46 + nameLen + extraLen + cmtLen;
    if (compSize === 0xffffffff || localOff === 0xffffffff) { off = next; continue; } // zip64 跳过
    if (name.endsWith('/')) { off = next; continue; }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== ZIP_LOC_SIG) { off = next; continue; }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else { off = next; continue; }
    entries.push({ name, data });
    off = next;
  }
  return entries;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== ZIP_EOCD_SIG) continue;
    const cdCount = buf.readUInt16LE(i + 10);
    const cdOffset = buf.readUInt32LE(i + 16);
    if (cdOffset <= buf.length) return { cdCount, cdOffset };
  }
  return null;
}

/**
 * 从归档 zip 里取出所有会话日志：
 *   条目名 → 逻辑日志文件名（session.jsonl / session.vN.jsonl[.zstd]），
 *   会话 id 优先取头行，其次取父目录段（导出时 id 被单射转义成安全路径段）。
 */
export function sessionLogsFromZip(buf) {
  const out = [];
  for (const ent of readZipEntries(buf)) {
    const base = ent.name.split('/').pop() || '';
    if (!LOG_FILE_RE.test(base)) continue;
    let parsed;
    try { parsed = parseLogText(decodeLogBytes(ent.data)); } catch { continue; }
    const dirSeg = ent.name.split('/').slice(-2, -1)[0] || null;
    out.push({
      entryName: ent.name,
      header: parsed.header,
      events: parsed.events,
      badLines: parsed.badLines,
      fallbackId: dirSeg,
    });
  }
  return out;
}