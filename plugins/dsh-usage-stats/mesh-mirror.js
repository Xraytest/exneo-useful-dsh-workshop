/**
 * mesh-mirror — 设备网格「会话历史镜像」的来源边界（纯 node，无 Cordis 依赖）。
 *
 * 背景（dsh-device-mesh §12.6 / §12.9）：
 *   会话跑在**会话端**（有 agent 的那台：LLM 请求由它发出、由它付费），工作树可能在
 *   **执行端**（按路径路由执行命令的那台）。执行端拿到的是**别人的会话历史副本**：
 *   镜像落在 `$DSH_HOME/device-mesh/session-replica/<源设备>/`，并在每次运行结束后被
 *   重压成出厂可读日志写进执行端自己的 `sessions/`（`sessionSync`），以便本机离线时
 *   能直接接手。
 *
 * 对用量统计的意义：
 *   本机账本只该记「**从当前设备发出的请求**」。执行端 `sessions/` 里那些副本的
 *   `assistant/message.usage` 等事实，是**对端设备发出的请求**，不是本机发出的——
 *   把它们计入本机账本会让同一笔用量在两台设备上各记一次（本机离线/接手之后新增的
 *   事件除外，那些确实是本机发出的）。
 *
 * 边界从哪来：
 *   接收端（执行端）的镜像索引 `device-mesh/session-replica/index.json` 里，每条会话带
 *   `syncedSeq`（本机那份日志已追平镜像的最后一条事件 seq）；旧记录可能只有 `lastSeq`
 *   （镜像已收到的最后一条）。取 `syncedSeq ?? lastSeq` 作为**来源边界**：
 *     - `seq <= floor`  → 对端发出，不计；
 *     - `seq >  floor`  → 本机接手/续跑产生，照常计。
 *   索引不存在 / 读不出来 = 没有镜像（或网格插件没装）→ 安全退化为「不排除」，
 *   宁可按旧行为记账，也不整块漏账。
 *
 * 注意方向：本机作为**会话端**推给对端的那些会话（`device-mesh/session-mirror.json`
 * 的 sender 游标）**不是**副本——它们的请求就是本机发出的，必须照常计。所以这里只读
 * 接收端的 `session-replica/index.json`，绝不读 sender 游标。
 *
 * @module dsh-usage-stats/mesh-mirror
 */

import fs from 'node:fs';
import path from 'node:path';

/** 接收端镜像索引的相对路径（相对 $DSH_HOME）。 */
export const REPLICA_INDEX_REL = path.join('device-mesh', 'session-replica', 'index.json');

/**
 * 会话 id 的规范形式：镜像索引里两代命名并存（`session-<uuid>` 与 `<uuid>`），
 * 账本里用的是日志头 id。比较前统一去掉 `session-` 前缀。
 * @param {unknown} id 原始 id。
 * @returns {string} 规范 id（空串 = 非法）。
 */
export function normalizeSessionId(id) {
  const text = String(id === undefined || id === null ? '' : id).trim();
  if (text === '') return '';
  return text.startsWith('session-') ? text.slice(8) : text;
}

/** 镜像索引的绝对路径。 */
export function mirrorIndexPath(dshHome) {
  return path.join(String(dshHome), REPLICA_INDEX_REL);
}

/**
 * 读接收端镜像索引，得到「会话 → 来源边界」。
 *
 * 返回 `{ available, path, error, byId, devices }`：
 *   - available：索引文件存在且能解析（false 时 byId 为空，调用方照常记账）；
 *   - error：读取/解析失败原因（ENOENT 不算错误，只是没有镜像）；
 *   - byId：Map<规范会话 id, { sessionId, deviceId, deviceName, floor, synced, boundary }>，
 *     floor = syncedSeq ?? lastSeq（都没有 → -1，表示拿不到边界，不做排除），
 *     boundary = 'synced' | 'lastSeq' | 'unknown'（status 观测用）；
 *   - devices：[{ deviceId, name, sessions }]（status 回显用）。
 * 同一条会话若出现多条记录，取**最大的 floor**（最保守：宁可少记，不重复记）。
 * @param {string} dshHome DSH home 目录。
 * @returns {{available:boolean, path:string, error:string|null, byId:Map, devices:Array}}
 */
export function loadMirrorIndex(dshHome) {
  const file = mirrorIndexPath(dshHome);
  const out = { available: false, path: file, error: null, byId: new Map(), devices: [] };
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 没有索引 = 本机没收到过镜像（正常路径），不是错误。
    if (!(error && error.code === 'ENOENT')) {
      out.error = String(error && error.message ? error.message : error);
    }
    return out;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    out.error = `镜像索引不是合法 JSON：${String(error && error.message ? error.message : error)}`;
    return out;
  }
  const list = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
  out.available = true;
  const devices = new Map();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
    const key = normalizeSessionId(sessionId);
    if (key === '') continue;
    const synced = Number.isFinite(entry.syncedSeq);
    const hasLast = Number.isFinite(entry.lastSeq);
    // 边界优先级：syncedSeq（本机那份日志追平镜像的位置）> lastSeq（镜像已收到的最后一条）。
    // 两者都没有 = 拿不到边界（很老的索引条目）：floor 记 -1，即**不排除**——宁可多记，
    // 也不把本机接手后的真实用量整块丢掉；这类条目在 status.mirrored.unknownBoundary 里露出。
    const floor = synced ? entry.syncedSeq : (hasLast ? entry.lastSeq : -1);
    const boundary = synced ? 'synced' : (hasLast ? 'lastSeq' : 'unknown');
    const deviceId = typeof entry.deviceId === 'string' ? entry.deviceId : '';
    const deviceName = typeof entry.sourceDeviceName === 'string' && entry.sourceDeviceName !== ''
      ? entry.sourceDeviceName
      : (deviceId === '' ? 'unknown' : deviceId);
    const prev = out.byId.get(key);
    if (prev === undefined || floor > prev.floor) {
      out.byId.set(key, { sessionId, deviceId, deviceName, floor, synced, boundary });
    }
    const deviceKey = deviceId === '' ? deviceName : deviceId;
    const device = devices.get(deviceKey) || { deviceId, name: deviceName, sessions: 0 };
    device.sessions += 1;
    devices.set(deviceKey, device);
  }
  out.devices = [...devices.values()];
  return out;
}

/**
 * 从镜像索引里取某条会话的来源边界（seq）。没有该会话 / 拿不到边界 → -1。
 * @param {ReturnType<typeof loadMirrorIndex>|null} index 索引。
 * @param {unknown} id 会话 id。
 * @returns {number} 边界 seq（-1 = 不做排除）。
 */
export function floorFromIndex(index, id) {
  if (index === null || index === undefined || !(index.byId instanceof Map)) return -1;
  const hit = index.byId.get(normalizeSessionId(id));
  return hit === undefined || !Number.isFinite(hit.floor) ? -1 : hit.floor;
}
