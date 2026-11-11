/**
 * 配对令牌的生成与持久化。
 *
 * 令牌是 PRTS Omni 与本桥接之间唯一的共享秘密：
 *   · 首次启动随机生成 256 位（64 个十六进制字符），写入插件数据目录的 `token.json`；
 *   · 文件权限 0600（仅当前用户可读写）；Windows 上 ACL 由用户目录继承，这里仍显式
 *     调用 chmod 并尽量收窄，best-effort；
 *   · 令牌**绝不**写进 info 日志、绝不通过非回环响应体返回；
 *   · 只有本机回环来源可以无令牌读取 `GET /auth/token`（供本机配对用）。
 *
 * 目录优先级：`PRTS_OMNI_BRIDGE_HOME` 环境变量 > `~/.prts-omni-bridge`。
 * 测试用前一个变量把令牌指到临时目录，避免污染用户 home。
 *
 * @module prts-omni-bridge/lib/token
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** token.json 的 schema 版本。 */
const TOKEN_FILE_VERSION = 1;

/** 令牌字节数：32 字节 = 256 位。 */
const TOKEN_BYTES = 32;

/**
 * 解析数据目录。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDataDir(env = process.env) {
  const override = typeof env.PRTS_OMNI_BRIDGE_HOME === 'string' ? env.PRTS_OMNI_BRIDGE_HOME.trim() : '';
  if (override !== '') return override;
  return join(homedir(), '.prts-omni-bridge');
}

/**
 * token.json 的路径。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function tokenFilePath(env = process.env) {
  return join(resolveDataDir(env), 'token.json');
}

/**
 * 读取一个「像令牌」的字符串。
 *
 * 从严判定：令牌是 64 位十六进制，任何空白（包括首尾）都说明文件被改过，
 * 一律视为无效并重新生成，不做「顺手 trim 一下」的宽容处理。
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function readStoredToken(value) {
  if (typeof value !== 'string') return undefined;
  if (value.length !== 64) return undefined;
  if (!/^[0-9a-f]{64}$/u.test(value)) return undefined;
  return value;
}

/**
 * 原子写文件并尽量把权限收窄到 0600。
 * @param {string} path
 * @param {string} text
 */
async function writePrivate(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(temp, 0o600);
  } catch {
    /* 某些平台/文件系统不支持 chmod；目录 ACL 仍是主要边界 */
  }
  await rename(temp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    /* 同上 */
  }
}

/**
 * 载入已有令牌，或在首次启动时生成并持久化一个新令牌。
 *
 * 幂等：重复调用返回同一个令牌；文件损坏时**重新生成**（旧令牌失效，需要重新配对），
 * 而不是抛出——桥接应该尽量保持可用。
 *
 * @param {{ dir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<{ token: string, path: string, created: boolean }>}
 */
export async function loadOrCreateToken(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir.trim() : resolveDataDir(options.env);
  const path = join(dir, 'token.json');
  await mkdir(dir, { recursive: true });

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    parsed = undefined;
  }
  const existing = readStoredToken(parsed !== null && typeof parsed === 'object' ? /** @type {any} */ (parsed).token : undefined);
  if (existing !== undefined) return { token: existing, path, created: false };

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const payload = JSON.stringify({ version: TOKEN_FILE_VERSION, token, createdAt: Date.now() }, null, 2);
  await writePrivate(path, `${payload}\n`);
  return { token, path, created: true };
}

/**
 * 恒定时间比较两个令牌，避免时序侧信道。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
