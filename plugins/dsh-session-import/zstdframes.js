/**
 * 多帧 Zstandard 会话日志解码（dsh-session-import 内部件，**仅供校验与测试**）。
 *
 * 插件本身**不需要**这个文件：`/export` 归档里是解压后的规范化 JSONL 文本，
 * 导入路径从不碰 `.jsonl.zstd`。它的用途只有两个，都属于「证明导入真的成功」
 * 这一类：
 *
 *   1. `selftest.mjs` 用它把磁盘上一条**真实**会话日志完整还原成规范化 JSONL，
 *      从而造出与 `/export` 逐字节同形的测试归档（而不是手搓的假日志）；
 *   2. 导入后回读新落盘的 `session.vN.jsonl.zstd`，逐条比对头与事件数——
 *      磁盘是唯一不会说谎的验收面。
 *
 * ## 为什么不能直接 `zstdDecompressSync(整个文件)`
 *
 * JSONL 后端是**按帧追加**的：每次 flush 追加一个独立的 Zstandard 帧，一个
 * 2.6 MB 的日志实测有 1757 个帧。Node 的 `zstdDecompressSync` 与
 * `createZstdDecompress()` **都只解第一个帧**，于是「解压成功但只剩头记录」——
 * 这正是不做帧扫描就会踩的坑。
 *
 * 扫描算法逐行对齐 dsh-session-persistence-jsonl 的 `scanZstdFrames`
 * （帧头描述符 + 块头链，读到 last-block 标志为止，再算上可选的 4 字节校验和），
 * 而不是去扫 `28 B5 2F FD` 魔数——压缩数据里完全可能出现同样的四字节，
 * 按魔数切分会把帧切坏。
 *
 * @module dsh-session-import/zstdframes
 */

import { zstdDecompressSync } from 'node:zlib';

/** Zstandard 帧魔数（小端 32 位 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 定位一段字节里的全部完整 Zstandard 帧。
 * @param {Buffer} buffer 会话工件当前的全部字节。
 * @returns {{frames: Array<{start: number, end: number}>, tornStart: number|undefined}}
 *   `frames` 是完整帧范围；`tornStart` 存在时表示末尾有一个未写完的帧。
 * @throws {Error} 帧结构损坏（魔数错位、保留位非零、保留块类型）。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Zstandard 日志损坏：字节 ${offset} 处不是帧魔数`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`Zstandard 日志损坏：字节 ${offset - 1} 处保留位非零`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`Zstandard 日志损坏：字节 ${offset - 3} 处保留块类型`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 把一份多帧 Zstandard 会话日志完整解码为规范化 JSONL 文本。
 * @param {Buffer|Uint8Array} bytes 工件字节。
 * @returns {{text: string, frameCount: number, torn: boolean}} 明文、完整帧数与是否有撕裂尾帧。
 * @throws {Error} 帧结构损坏或某帧解压失败（撕裂尾帧按设计丢弃，不报错）。
 */
export function decodeZstdSessionLog(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
  }
  return {
    text: Buffer.concat(parts).toString('utf8'),
    frameCount: frames.length,
    torn: tornStart !== undefined,
  };
}
