/**
 * dsh-device-mesh — 三张表：入站令牌 / 已接入节点 / 出站接入点。
 *
 * 三张表都遵守同一条纪律：**内存态是权威，落盘是尽力而为的持久化**。
 * 写盘失败不回滚内存（否则「磁盘满」会让整个接入功能停摆），而是把错误记进
 * `lastWriteError` 并由 `/status` 如实报告。读盘失败见 store.js：保留原文件、
 * 回落默认值、把原因写进 problems。
 *
 * 对外暴露的视图一律**脱敏**：`TokenTable.list()` 与 `LinkTable.list()` 都不含
 * secret，浏览器侧永远拿不到已保存的密钥（创建时那一次是唯一一次）。
 *
 * @module dsh-device-mesh/registry
 */

import path from 'node:path'

import { PROTOCOL_VERSION, randomHex, randomSecret } from './protocol.js?v=mesh-31'
import { STORE_SCHEMA, readJson, writeJsonAtomic } from './store.js?v=mesh-31'

/** 名字长度上界：够长到能区分设备，又不至于把 UI 撑爆。 */
const NAME_LIMIT = 120
/** 标签长度上界（令牌/链接的人可读标签）。 */
const LABEL_LIMIT = 80

/**
 * 信任级别。
 *
 * `inventory`（缺省）只能推清单，`exec` 额外允许在这台机器上执行命令，
 * `denied` 拉黑。'allowed' 是早期版本的名字，读旧文件时归一成 `inventory`。
 */
export const TRUST_LEVELS = ['inventory', 'exec', 'denied']

/**
 * 把任意输入压成有界字符串。
 * @param {unknown} value 输入。
 * @param {number} limit 字符上界。
 * @param {string} fallback 空值回落。
 * @returns {string} 结果。
 */
const text = (value, limit, fallback = '') => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.slice(0, limit)
}

/** ISO 时间字符串，坏值回落 null。 */
const iso = (value) => {
  if (typeof value !== 'string') return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

// ───────────────────────────── 入站令牌表 ─────────────────────────────

/**
 * 入站令牌表：远端节点用哪把密钥来签名「我要接入」。
 *
 * 撤销语义 = `revoked: true`（保留记录，`/tokens` 里看得见「撤过谁」），
 * 删除语义 = 整条抹掉。两者都立刻生效：{@link TokenTable.lookup} 拒 revoked。
 */
export class TokenTable {
  /**
   * @param {string} meshDir mesh 数据目录。
   * @param {string[]} problems 问题收集器。
   */
  constructor(meshDir, problems) {
    this.file = path.join(meshDir, 'tokens.json')
    this.problems = problems
    this.lastWriteError = null
    /** @type {Array<{id: string, label: string, secret: string, createdAt: string, expiresAt: string|null, revoked: boolean, lastUsedAt: string|null, useCount: number, lastDeviceId: string|null}>} */
    this.rows = []
    this.#load()
  }

  #load() {
    const stored = readJson(this.file, null, this.problems)
    const rows = stored !== null && Array.isArray(stored.rows) ? stored.rows : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const id = text(row.id, 64)
      const secret = typeof row.secret === 'string' ? row.secret : ''
      // id/secret 是本表的键，缺任何一个都无法验签 —— 这种行直接丢弃并报问题，
      // 不静默保留一条「永远验不过」的僵尸令牌。
      if (!/^[0-9a-f]{8,64}$/.test(id) || secret.length < 16) {
        this.problems.push('tokens.json: 丢弃一条缺少 id/secret 的令牌记录')
        continue
      }
      this.rows.push({
        id,
        label: text(row.label, LABEL_LIMIT) || '(未命名)',
        secret,
        createdAt: iso(row.createdAt) ?? new Date().toISOString(),
        expiresAt: iso(row.expiresAt),
        revoked: row.revoked === true,
        lastUsedAt: iso(row.lastUsedAt),
        useCount: Number.isSafeInteger(row.useCount) && row.useCount >= 0 ? row.useCount : 0,
        lastDeviceId: text(row.lastDeviceId, 128) || null,
      })
    }
    if (stored !== null && stored.schema !== STORE_SCHEMA) {
      this.problems.push(`tokens.json: schema 为 ${String(stored.schema)}（本实现 ${STORE_SCHEMA}），已按当前结构读取`)
    }
  }

  #save() {
    const result = writeJsonAtomic(this.file, { schema: STORE_SCHEMA, rows: this.rows })
    this.lastWriteError = result.ok ? null : result.error
    return result.ok
  }

  /**
   * 脱敏视图：**不含 secret**。浏览器侧只能看到这些字段。
   * @param {number} now 当前时刻（毫秒），用于算 `expired`。
   * @returns {Array<Record<string, unknown>>} 令牌列表（创建时间倒序）。
   */
  list(now = Date.now()) {
    return this.rows
      .map((row) => ({
        id: row.id,
        label: row.label,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revoked: row.revoked,
        expired: row.expiresAt !== null && Date.parse(row.expiresAt) <= now,
        lastUsedAt: row.lastUsedAt,
        useCount: row.useCount,
        lastDeviceId: row.lastDeviceId,
      }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /**
   * 按 id 取出**含 secret** 的记录（只在入站验签路径使用）。
   * @param {string} id 令牌标识。
   * @returns {object|undefined} 记录。
   */
  lookup(id) {
    return this.rows.find((row) => row.id === id)
  }

  /**
   * 新建令牌。secret 只在返回值里出现这一次，之后无法从任何接口读回。
   * @param {{label?: unknown, ttlMs?: unknown}} input 标签与有效期（毫秒，0/缺省 = 永不过期）。
   * @param {number} now 当前时刻（毫秒）。
   * @returns {{ok: true, token: Record<string, unknown>, secret: string} | {ok: false, error: string}} 结果。
   */
  create(input, now = Date.now()) {
    if (this.rows.length >= 512) return { ok: false, error: '令牌数量已达上限 512，请先删除不再使用的令牌' }
    const ttl = Number(input?.ttlMs)
    const expiresAt = Number.isFinite(ttl) && ttl > 0
      ? new Date(now + Math.min(ttl, 365 * 24 * 3600 * 1000)).toISOString()
      : null
    const row = {
      id: randomHex(8),
      label: text(input?.label, LABEL_LIMIT) || `令牌 ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}`,
      secret: randomSecret(32),
      createdAt: new Date(now).toISOString(),
      expiresAt,
      revoked: false,
      lastUsedAt: null,
      useCount: 0,
      lastDeviceId: null,
    }
    this.rows.push(row)
    const persisted = this.#save()
    const view = this.list(now).find((entry) => entry.id === row.id)
    return { ok: true, token: view, secret: row.secret, persisted }
  }

  /**
   * 撤销一个令牌。已撤销的再撤销是幂等 no-op。
   * @param {string} id 令牌标识。
   * @returns {boolean} 是否命中一条记录。
   */
  revoke(id) {
    const row = this.lookup(id)
    if (row === undefined) return false
    if (row.revoked) return true
    row.revoked = true
    this.#save()
    return true
  }

  /**
   * 删除一个令牌记录。
   * @param {string} id 令牌标识。
   * @returns {boolean} 是否删除了一条。
   */
  remove(id) {
    const index = this.rows.findIndex((row) => row.id === id)
    if (index < 0) return false
    this.rows.splice(index, 1)
    this.#save()
    return true
  }

  /**
   * 记一次成功使用（用于 `/tokens` 显示「谁在用、用了多少次」）。
   * @param {string} id 令牌标识。
   * @param {string} deviceId 使用者设备标识。
   * @param {number} now 当前时刻（毫秒）。
   * @param {number} flushEvery 每多少次落盘一次（0 = 每次都落）。
   * @returns {void}
   */
  touch(id, deviceId, now, flushEvery = 25) {
    const row = this.lookup(id)
    if (row === undefined) return
    row.lastUsedAt = new Date(now).toISOString()
    row.useCount += 1
    row.lastDeviceId = deviceId
    if (flushEvery <= 0 || row.useCount % flushEvery === 0) this.#save()
  }

  /** 仅在退出/卸载时把计数落盘。 */
  flush() {
    this.#save()
  }

  /** 诊断。 */
  stats() {
    return { total: this.rows.length, active: this.rows.filter((row) => !row.revoked).length, lastWriteError: this.lastWriteError }
  }
}

// ───────────────────────────── 已接入节点表 ─────────────────────────────

/**
 * 已接入本机的远端节点记录。每条含该节点**最近一次上报的清单快照**，
 * 所以本机重启后仍能显示「上次看到的」三级树（并按 lastSeenAt 标 stale/offline）。
 */
export class NodeRegistry {
  /**
   * @param {string} meshDir mesh 数据目录。
   * @param {number} maxDevices 节点数上界。
   * @param {string[]} problems 问题收集器。
   */
  constructor(meshDir, maxDevices, problems) {
    this.file = path.join(meshDir, 'nodes.json')
    this.maxDevices = maxDevices
    this.problems = problems
    this.lastWriteError = null
    /** @type {Map<string, object>} deviceId → 节点记录。 */
    this.nodes = new Map()
    this.#load()
  }

  #load() {
    const stored = readJson(this.file, null, this.problems)
    const rows = stored !== null && Array.isArray(stored.nodes) ? stored.nodes : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const device = row.device
      const deviceId = device !== null && typeof device === 'object' ? text(device.deviceId, 128) : ''
      if (!/^[0-9a-f]{8,128}$/.test(deviceId)) {
        this.problems.push('nodes.json: 丢弃一条缺少合法 device.deviceId 的节点记录')
        continue
      }
      this.nodes.set(deviceId, {
        deviceId,
        nodeId: text(row.nodeId, 64),
        device,
        tokenId: text(row.tokenId, 64),
        // trust 是四值枚举，不是二值：'inventory'（只看清单，缺省）、
        // 'exec'（额外允许跨设备执行）、'denied'（拉黑）。旧版本文件里的
        // 'allowed' 按 'inventory' 读 —— 语义完全一致（只看清单），只是名字更准确。
        trust: TRUST_LEVELS.includes(row.trust) ? row.trust : 'inventory',
        note: text(row.note, LABEL_LIMIT),
        joinedAt: iso(row.joinedAt) ?? new Date().toISOString(),
        lastSeenAt: iso(row.lastSeenAt) ?? new Date().toISOString(),
        lastInventoryAt: iso(row.lastInventoryAt),
        inventory: row.inventory !== null && typeof row.inventory === 'object' ? row.inventory : null,
        reportCount: Number.isSafeInteger(row.reportCount) && row.reportCount >= 0 ? row.reportCount : 0,
      })
    }
  }

  #save() {
    const result = writeJsonAtomic(this.file, { schema: STORE_SCHEMA, nodes: [...this.nodes.values()] })
    this.lastWriteError = result.ok ? null : result.error
    return result.ok
  }

  /** @returns {object|undefined} 记录。 */
  get(deviceId) {
    return this.nodes.get(deviceId)
  }

  /** @returns {object[]} 全部记录。 */
  list() {
    return [...this.nodes.values()]
  }

  /**
   * 接入（或重新接入）一个节点。同一 deviceId 重复接入是幂等的：
   * 更新 device 描述与 lastSeenAt，**保留**原有 trust/note/joinedAt，
   * 这样对端重启不会把「已拉黑」或人工备注冲掉。
   * @param {{deviceId: string, device: object, tokenId: string, now: number, nodeId?: string}} input 接入材料。
   * @returns {{ok: true, record: object} | {ok: false, error: string}} 结果。
   */
  join(input) {
    const existing = this.nodes.get(input.deviceId)
    if (existing !== undefined) {
      existing.device = input.device
      existing.tokenId = input.tokenId
      existing.lastSeenAt = new Date(input.now).toISOString()
      existing.nodeId = input.nodeId ?? existing.nodeId
      this.#save()
      return { ok: true, record: existing }
    }
    if (this.nodes.size >= this.maxDevices) {
      return { ok: false, error: `已接入节点数达到上限 ${this.maxDevices}，请先清理不再使用的设备` }
    }
    const record = {
      deviceId: input.deviceId,
      nodeId: input.nodeId ?? randomHex(8),
      device: input.device,
      tokenId: input.tokenId,
      // 缺省只给「看清单」：令牌证明身份，不自动等于允许在这台机器上执行命令。
      trust: 'inventory',
      note: '',
      joinedAt: new Date(input.now).toISOString(),
      lastSeenAt: new Date(input.now).toISOString(),
      lastInventoryAt: null,
      inventory: null,
      reportCount: 0,
    }
    this.nodes.set(input.deviceId, record)
    this.#save()
    return { ok: true, record }
  }

  /**
   * 记一次心跳 / 上报。
   * @param {string} deviceId 设备标识。
   * @param {{now: number, inventory?: object|null, flush?: boolean}} input 材料。
   * @returns {object|undefined} 更新后的记录，或 undefined（未知节点）。
   */
  touch(deviceId, input) {
    const record = this.nodes.get(deviceId)
    if (record === undefined) return undefined
    record.lastSeenAt = new Date(input.now).toISOString()
    if (input.inventory !== null && input.inventory !== undefined) {
      record.inventory = input.inventory
      record.lastInventoryAt = new Date(input.now).toISOString()
    }
    record.reportCount += 1
    // 心跳很频繁（默认 20 s），每次都落盘会让磁盘白转；清单变化必须立刻落盘，
    // 否则「对端刚推了新会话、本机重启」就会丢。心跳累计到 20 次再落一次。
    if (input.flush === true || record.reportCount % 20 === 0) this.#save()
    return record
  }

  /**
   * 人工改名 / 备注 / 拉黑。`device.name` 对端自己会覆盖，所以本机的人工命名
   * 单独存在 `note` 上（展示时优先 note）。
   * @param {string} deviceId 设备标识。
   * @param {{note?: unknown, trust?: unknown}} patch 变更。
   * @returns {object|undefined} 更新后的记录。
   */
  update(deviceId, patch) {
    const record = this.nodes.get(deviceId)
    if (record === undefined) return undefined
    if (patch?.note !== undefined) record.note = text(patch.note, LABEL_LIMIT)
    if (TRUST_LEVELS.includes(patch?.trust)) record.trust = patch.trust
    this.#save()
    return record
  }

  /**
   * 移除一个节点记录（不影响对端；对端下次心跳会重新 join，除非同时撤销了它的令牌）。
   * @param {string} deviceId 设备标识。
   * @returns {boolean} 是否删除了一条。
   */
  forget(deviceId) {
    const deleted = this.nodes.delete(deviceId)
    if (deleted) this.#save()
    return deleted
  }

  /** 诊断。 */
  stats() {
    return { total: this.nodes.size, max: this.maxDevices, lastWriteError: this.lastWriteError }
  }
}

// ───────────────────────────── 出站接入点表 ─────────────────────────────

/**
 * 出站接入点：本机把清单推给哪些远端设备。每条含明文 secret（签名用），
 * 因此 {@link LinkTable.list} 只回 secret 的**前缀**，够人核对「是不是那一把」。
 */
export class LinkTable {
  /**
   * @param {string} meshDir mesh 数据目录。
   * @param {string[]} problems 问题收集器。
   */
  constructor(meshDir, problems) {
    this.file = path.join(meshDir, 'links.json')
    this.problems = problems
    this.lastWriteError = null
    /** @type {Map<string, object>} id → 链接。 */
    this.links = new Map()
    this.#load()
  }

  #load() {
    const stored = readJson(this.file, null, this.problems)
    const rows = stored !== null && Array.isArray(stored.links) ? stored.links : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const id = text(row.id, 64)
      const url = normalizeHubUrl(row.url)
      if (id === '' || url === null) {
        this.problems.push('links.json: 丢弃一条缺少 id 或 url 非法的接入点记录')
        continue
      }
      const secret = typeof row.secret === 'string' ? row.secret : ''
      const tokenId = text(row.tokenId, 64)
      this.links.set(id, {
        id,
        label: text(row.label, LABEL_LIMIT) || url,
        url,
        tokenId,
        secret,
        enabled: row.enabled !== false,
        // 缺 token/secret 的链接是「配了一半」的，保留下来让人在 UI 里补完，
        // 但 enabled 归 false，免得 egress 每轮都发一个必然 401 的请求。
        state: secret === '' && tokenId === '' ? 'unconfigured' : 'idle',
        createdAt: iso(row.createdAt) ?? new Date().toISOString(),
        lastJoinAt: iso(row.lastJoinAt),
        lastPushAt: iso(row.lastPushAt),
        lastError: text(row.lastError, 400) || null,
        hubDevice: row.hubDevice !== null && typeof row.hubDevice === 'object' ? row.hubDevice : null,
      })
    }
  }

  #save() {
    const result = writeJsonAtomic(this.file, { schema: STORE_SCHEMA, links: [...this.links.values()] })
    this.lastWriteError = result.ok ? null : result.error
    return result.ok
  }

  /** 内部用：含 secret 的全量记录。 */
  all() {
    return [...this.links.values()]
  }

  /** @returns {object|undefined} 记录。 */
  get(id) {
    return this.links.get(id)
  }

  /**
   * 脱敏视图：secret 只回前 6 位，够核对不够冒用。
   * @returns {Array<Record<string, unknown>>} 清单。
   */
  list() {
    return [...this.links.values()].map((link) => ({
      id: link.id,
      label: link.label,
      url: link.url,
      tokenId: link.tokenId,
      enabled: link.enabled,
      state: link.state,
      configured: link.tokenId !== '' && link.secret !== '',
      secretPreview: link.secret === '' ? '' : `${link.secret.slice(0, 6)}…`,
      createdAt: link.createdAt,
      lastJoinAt: link.lastJoinAt,
      lastPushAt: link.lastPushAt,
      lastError: link.lastError,
      hubDevice: link.hubDevice,
    }))
  }

  /**
   * 新建或更新一条出站接入点。
   *
   * 更新时**不传 secret 就保留原值** —— 这是必须的：UI 只能拿到 secret 前缀，
   * 如果「保存」把前缀当新 secret 写回去，链接会静默失效。
   * @param {{id?: unknown, label?: unknown, url: unknown, tokenId?: unknown, secret?: unknown, enabled?: unknown}} input 表单。
   * @returns {{ok: true, link: Record<string, unknown>} | {ok: false, error: string}} 结果。
   */
  upsert(input) {
    const url = normalizeHubUrl(input?.url)
    if (url === null) return { ok: false, error: '接入点地址必须是 http(s):// 开头的完整 URL' }
    const id = text(input?.id, 64)
    const existing = id === '' ? undefined : this.links.get(id)
    if (id !== '' && existing === undefined) return { ok: false, error: `接入点 ${id} 不存在` }

    const nextTokenId = input?.tokenId === undefined ? existing?.tokenId ?? '' : text(input.tokenId, 64)
    const nextSecret = input?.secret === undefined || input.secret === ''
      ? existing?.secret ?? ''
      : text(input.secret, 512)
    const link = {
      id: existing?.id ?? randomHex(8),
      label: input?.label === undefined ? existing?.label ?? url : (text(input.label, LABEL_LIMIT) || url),
      url,
      tokenId: nextTokenId,
      secret: nextSecret,
      enabled: input?.enabled === undefined ? existing?.enabled ?? true : input.enabled === true,
      state: nextTokenId !== '' && nextSecret !== '' ? (existing?.state ?? 'idle') : 'unconfigured',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastJoinAt: existing?.lastJoinAt ?? null,
      lastPushAt: existing?.lastPushAt ?? null,
      lastError: existing?.lastError ?? null,
      hubDevice: existing?.hubDevice ?? null,
    }
    if (link.state === 'unconfigured') link.enabled = false
    this.links.set(link.id, link)
    this.#save()
    const view = this.list().find((entry) => entry.id === link.id)
    return { ok: true, link: view }
  }

  /**
   * 写入一次连接结果（成功/失败）。
   * @param {string} id 链接标识。
   * @param {{state?: string, lastError?: string|null, hubDevice?: object|null, joined?: boolean, pushed?: boolean, now?: number, flush?: boolean}} patch 结果。
   * @returns {void}
   */
  record(id, patch) {
    const link = this.links.get(id)
    if (link === undefined) return
    const now = patch.now ?? Date.now()
    if (patch.state !== undefined) link.state = patch.state
    if (patch.lastError !== undefined) link.lastError = patch.lastError
    if (patch.hubDevice !== undefined) link.hubDevice = patch.hubDevice
    if (patch.joined === true) link.lastJoinAt = new Date(now).toISOString()
    if (patch.pushed === true) link.lastPushAt = new Date(now).toISOString()
    // 状态翻转（成功↔失败）必须立刻落盘：那是人要在 UI 上看见的东西。
    // 稳态的重复成功不必每轮写盘。
    if (patch.flush === true || patch.lastError !== undefined) this.#save()
  }

  /**
   * 删除一条接入点。
   * @param {string} id 链接标识。
   * @returns {boolean} 是否删除。
   */
  remove(id) {
    const deleted = this.links.delete(id)
    if (deleted) this.#save()
    return deleted
  }

  /**
   * 切换启用状态。
   * @param {string} id 链接标识。
   * @param {boolean} enabled 目标状态。
   * @returns {object|undefined} 脱敏后的记录。
   */
  setEnabled(id, enabled) {
    const link = this.links.get(id)
    if (link === undefined) return undefined
    if (link.tokenId === '' || link.secret === '') return undefined
    link.enabled = enabled === true
    if (link.enabled && link.state === 'disabled') link.state = 'idle'
    if (!link.enabled) link.state = 'disabled'
    this.#save()
    return this.list().find((entry) => entry.id === id)
  }

  /** 诊断。 */
  stats() {
    const rows = [...this.links.values()]
    return {
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      joined: rows.filter((row) => row.state === 'joined').length,
      lastWriteError: this.lastWriteError,
    }
  }
}

/**
 * 归一化接入点 URL：必须 http(s)、必须有 host、去掉尾斜杠与 query/fragment
 * （签名覆盖 path，query 会让「同一接入点两种写法」产生两种签名口径）。
 * @param {unknown} value 输入。
 * @returns {string|null} 归一化 URL，或 null（非法）。
 */
export function normalizeHubUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.host === '') return null
  parsed.search = ''
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * 协议版本常量再导出，方便调用方只 import 一个模块。
 * @type {number}
 */
export { PROTOCOL_VERSION }
