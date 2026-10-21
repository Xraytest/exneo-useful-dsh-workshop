/**
 * 极简 ZIP 读取器（dsh-session-import 内部件）。
 *
 * 只认 `/export` 归档真正会用到的那一小片 ZIP 语法，**不引入任何第三方依赖**
 * （fflate 虽然在本安装里可解析，但那是 dsh-session-log-export 的传递依赖，
 * 不属于本插件的声明面；自己实现换来确定的错误信息与可单测的单元）。
 *
 * 覆盖范围（对齐 fflate 流式 Zip 写入器的输出）：
 *   - 中央目录（EOCD → CEN）驱动，而不是扫描本地头——`localHeaderOffset`
 *     是唯一权威，避免在压缩数据里误撞 `PK\x03\x04`；
 *   - 压缩方法 0（store）与 8（deflate，`zlib.inflateRawSync`）；
 *   - 本地头 name/extra 长度**单独读**（可能 ≠ 中央目录里的值）；
 *   - 逐条 CRC-32 校验：归档损坏必须在导入前失败，而不是把半截日志写进会话库。
 *
 * 明确不支持并会显式报错的：ZIP64（>4GiB 或条目数 >65535）、加密、其它压缩
 * 方法、分卷。归档是浏览器下载的会话日志，正常远在这些边界之内。
 *
 * @module dsh-session-import/zipread
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT = 0xffff;

/** 方法 0=store，8=deflate；其余一律拒绝。 */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** CRC-32（IEEE 802.3）查表，惰性构建一次。 */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE !== null) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

/**
 * 计算一段字节的 CRC-32。
 * @param {Uint8Array} bytes 待校验字节。
 * @returns {number} 无符号 32 位 CRC。
 */
export function crc32(bytes) {
  const table = crcTable();
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 归档结构或条目损坏——调用方据此回 400 而不是 500。 */
export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
    this.code = 'ZIP_INVALID';
  }
}

/**
 * 规范化归档内的条目路径：反斜杠转正斜杠、去掉前导 `/` 与 `./`，并拒绝任何
 * 会逃出归档根的段（`..`、盘符、NUL）。归档由 DSH 自己产出，但解包器不该
 * 假定输入可信。
 * @param {string} raw 中央目录里的原始条目名。
 * @returns {string} 规范化后的相对路径。
 */
export function normalizeEntryPath(raw) {
  const unified = String(raw).replace(/\\/gu, '/');
  if (unified.includes('\0')) throw new ZipError('归档条目名含 NUL 字节');
  const segments = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new ZipError(`归档条目路径逃逸归档根：${raw}`);
    if (/^[A-Za-z]:$/u.test(segment)) throw new ZipError(`归档条目名含盘符：${raw}`);
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 反向定位 EOCD（末尾可能带最长 64 KiB 注释）。
 * @param {Buffer} buffer 完整归档字节。
 * @returns {number} EOCD 记录起始偏移。
 */
function findEocd(buffer) {
  const earliest = Math.max(0, buffer.length - (EOCD_MIN_BYTES + EOCD_MAX_COMMENT));
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  throw new ZipError('不是 ZIP 归档：未找到中央目录结尾记录（EOCD）');
}

/**
 * 读取一个会话导出归档。
 *
 * 每个条目都返回**解压后**的字节；目录条目（以 `/` 结尾）跳过。
 * 全部条目在返回前完成 CRC 校验。
 *
 * @param {Uint8Array|Buffer} bytes 完整归档字节。
 * @returns {{entries: Map<string, Uint8Array>, list: Array<{path: string, size: number, method: number}>}}
 *   `entries` 以规范化路径为键；`list` 是同一批条目的有序元数据。
 * @throws {ZipError} 结构非法、ZIP64、加密、未知压缩方法或 CRC 不匹配。
 */
export function readZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < EOCD_MIN_BYTES) throw new ZipError('不是 ZIP 归档：字节数不足');
  const eocd = findEocd(buffer);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 归档（本读取器只服务 DSH 会话导出）');
  }
  if (centralOffset + centralSize > buffer.length) throw new ZipError('中央目录越界：归档被截断');

  const entries = new Map();
  const list = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) throw new ZipError('中央目录条目越界：归档被截断');
    if (buffer.readUInt32LE(cursor) !== CEN_SIG) throw new ZipError(`中央目录第 ${index} 条签名非法`);

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new ZipError('中央目录条目名越界：归档被截断');
    const rawName = buffer.toString('utf8', nameStart, nameEnd);
    cursor = nameEnd + extraLength + commentLength;

    if (rawName.endsWith('/')) continue; // 目录条目
    if ((flags & 0x1) !== 0) throw new ZipError(`条目已加密，无法读取：${rawName}`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError(`不支持的压缩方法 ${method}（条目 ${rawName}）`);
    }

    if (localOffset + 30 > buffer.length) throw new ZipError(`本地头越界：${rawName}`);
    if (buffer.readUInt32LE(localOffset) !== LOC_SIG) throw new ZipError(`本地头签名非法：${rawName}`);
    // 本地头的 name/extra 长度与中央目录可能不同——必须按本地头自己那份推进。
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new ZipError(`条目数据越界：${rawName}`);

    const stored = buffer.subarray(dataStart, dataEnd);
    let content;
    if (method === METHOD_STORE) {
      content = Uint8Array.prototype.slice.call(stored);
    } else {
      try {
        content = inflateRawSync(stored);
      } catch (error) {
        throw new ZipError(`条目解压失败（${rawName}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (content.length !== uncompressedSize) {
      throw new ZipError(`条目长度不符（${rawName}）：期望 ${uncompressedSize}，实得 ${content.length}`);
    }
    const actualCrc = crc32(content);
    if (actualCrc !== expectedCrc) {
      throw new ZipError(`条目 CRC 校验失败（${rawName}）：归档已损坏`);
    }

    const path = normalizeEntryPath(rawName);
    if (path === '') continue;
    entries.set(path, content);
    list.push({ path, size: content.length, method });
  }

  return { entries, list };
}

/**
 * 以 UTF-8 读取一个条目为文本。
 * @param {Map<string, Uint8Array>} entries `readZip` 的结果。
 * @param {string} path 规范化条目路径。
 * @returns {string|undefined} 条目文本，缺失时 `undefined`。
 */
export function readEntryText(entries, path) {
  const value = entries.get(path);
  if (value === undefined) return undefined;
  return Buffer.from(value).toString('utf8');
}
