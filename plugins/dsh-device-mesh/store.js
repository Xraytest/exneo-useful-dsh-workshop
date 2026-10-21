/**
 * dsh-device-mesh — 落盘层（原子写 + 设备身份）。
 *
 * 四份文件都在 `$DSH_HOME/device-mesh/` 下，全部 0600：
 *
 *   identity.json  本机设备身份（deviceId / 名字 / 首次启动时间）
 *   tokens.json    入站令牌表（**含明文 secret**，见 protocol.js 的认证模型）
 *   links.json     出站接入点清单（**含明文 secret**）
 *   nodes.json     已接入本机的远端节点记录 + 它们上报的清单快照
 *
 * 原子写 = 同目录临时文件 + fsync + rename。同目录是必须的：跨目录 rename 不是原子的。
 * 与同 profile 的其它静态插件一样，坏文件**不猜不删**：读失败一律回落到默认值并把
 * 原因回报到 `/status`，让人能看见「文件坏了」，而不是静默把配置清空。
 *
 * @module dsh-device-mesh/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { randomHex } from './protocol.js?v=mesh-31'

/** 落盘 schema 版本。将来改结构时用它做迁移判定，不靠字段是否存在猜。 */
export const STORE_SCHEMA = 1

/** 目录/文件权限：令牌与密钥都在里面，只给属主。 */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * 解析 mesh 数据目录。优先显式配置，其次 `$DSH_HOME/device-mesh`，
 * 最后 `~/.dsh/device-mesh`。
 * @param {string} configured 配置里的 storeDir（空 = 走缺省）。
 * @returns {string} 绝对目录路径。
 */
export function resolveMeshDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'device-mesh')
}

/**
 * 确保目录存在（0700）。
 * @param {string} dir 目录路径。
 * @returns {boolean} 是否可用。
 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    return true
  } catch {
    return false
  }
}

/**
 * 读一个 JSON 文件。任何失败（不存在 / 坏 JSON / 权限）都回落到 `fallback`，
 * 并把原因写进 `problems` 数组，让 `/status` 能如实报告而不是假装一切正常。
 * @param {string} file 文件路径。
 * @param {unknown} fallback 回落值。
 * @param {string[]} problems 问题收集器。
 * @returns {unknown} 解析结果或回落值。
 */
export function readJson(file, fallback, problems) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') problems.push(`${path.basename(file)}: 读取失败 ${error?.message ?? error}`)
    return fallback
  }
  try {
    const parsed = JSON.parse(text)
    return parsed === null || typeof parsed !== 'object' ? fallback : parsed
  } catch (error) {
    problems.push(`${path.basename(file)}: JSON 解析失败（保留原文件不覆盖）${error?.message ?? error}`)
    return fallback
  }
}

/**
 * 原子写 JSON（0600）。
 *
 * 先写同目录临时文件并 fsync，再 rename 覆盖 —— rename 在同一文件系统内是原子的，
 * 所以读者要么看到旧内容、要么看到新内容，不会看到半截 JSON。写完后尽力 fsync 目录，
 * 让「文件已改名」这件事本身也落盘（断电时不会退回到旧名字）。
 * @param {string} file 目标文件。
 * @param {unknown} value 要写入的值。
 * @returns {{ok: true} | {ok: false, error: string}} 结果。
 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  if (!ensureDir(dir)) return { ok: false, error: `目录不可用：${dir}` }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomHex(6)}.tmp`)
  let fd = null
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`
    fd = fs.openSync(tmp, 'w', FILE_MODE)
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    // rename 会保留临时文件的 0600；显式再 chmod 一次防止 umask 意外放宽。
    fs.chmodSync(tmp, FILE_MODE)
    fs.renameSync(tmp, file)
    try {
      const dirFd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // 目录 fsync 在部分平台/文件系统上不支持；不影响 rename 本身已生效。
    }
    return { ok: true }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // 已经关掉了。
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没建起来。
    }
    return { ok: false, error: error?.message ?? String(error) }
  }
}

// ───────────────────────────── 设备身份 ─────────────────────────────

/**
 * 设备身份的**形状**校验。任何一项不合规都当成「文件不可信」，
 * 重新生成身份会让对端把本机当成一台新设备（旧记录留成幽灵节点），
 * 所以这里只做形状判定、不做修复式猜测：字段缺失就报问题。
 * @param {unknown} value 解析出来的对象。
 * @returns {{ok: true, value: {schema: number, deviceId: string, name: string, createdAt: string}} | {ok: false, reason: string}} 判定结果。
 */
export function validateIdentity(value) {
  if (value === null || typeof value !== 'object') return { ok: false, reason: '不是对象' }
  const { deviceId, name, createdAt } = /** @type {Record<string, unknown>} */ (value)
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{8,128}$/.test(deviceId)) return { ok: false, reason: 'deviceId 缺失或非 hex' }
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: 'name 缺失' }
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return { ok: false, reason: 'createdAt 不是 ISO 时间' }
  return { ok: true, value: { schema: STORE_SCHEMA, deviceId, name: name.trim().slice(0, 120), createdAt } }
}

/**
 * 载入或创建本机设备身份。
 *
 * 名字的优先级：`identity.json` 里存的名字 > 配置里的 `deviceName` > `os.hostname()`。
 * 身份文件存在时**不**用配置覆盖名字 —— 否则配置文件一改，对端看到的就是两台设备。
 * 改名字请走浏览器侧的人机接口（`POST /config`），它会同时更新身份文件。
 * @param {string} meshDir mesh 数据目录。
 * @param {{deviceName: string}} config 归一化配置（只用 deviceName）。
 * @param {string[]} problems 问题收集器。
 * @returns {{identity: {schema: number, deviceId: string, name: string, createdAt: string}, created: boolean, file: string}} 身份与是否新建。
 */
export function loadIdentity(meshDir, config, problems) {
  const file = path.join(meshDir, 'identity.json')
  const stored = readJson(file, null, problems)
  const verdict = validateIdentity(stored)
  if (verdict.ok) return { identity: verdict.value, created: false, file }

  if (stored !== null && stored !== undefined) {
    problems.push(`identity.json: 内容不可信（${verdict.reason}），已按新设备重新生成`)
  }
  const fallbackName = typeof config.deviceName === 'string' && config.deviceName.trim() !== ''
    ? config.deviceName.trim()
    : os.hostname()
  const identity = {
    schema: STORE_SCHEMA,
    deviceId: randomHex(16),
    name: fallbackName.slice(0, 120),
    createdAt: new Date().toISOString(),
  }
  const written = writeJsonAtomic(file, identity)
  if (!written.ok) problems.push(`identity.json: 写入失败（身份仅存活于本次进程）${written.error}`)
  return { identity, created: true, file }
}
