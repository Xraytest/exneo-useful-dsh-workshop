/**
 * dsh-device-mesh — 工作区「多工作路径」账目。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 出厂 `workspaceRegistry` 里，一个工作区**恰好**绑定一个规范路径（`workspace.path`），
 * 它是 `fs.realpath` 过的、不可改写的权威。这个语义是出厂侧边栏、会话归属、
 * 新建会话 cwd 的共同基础，**不能也不该**被一个插件改掉。
 *
 * 但「同一个项目在别的设备上还有一份工作目录」是真实需求：NasHost 上有
 * `/root/nas/ArkTower`，笔记本上有一份 `/srv/ArkTower` 镜像，或者一台机器上另有一个
 * 临时工作副本。所以本表**只记录额外路径**，主路径永远是出厂那个、永远是默认：
 *
 *   主路径（primary）  出厂权威，本表不存、只读派生 ⇒ 结构上不可能被本插件改坏，
 *                      也不可能出现「主路径指向了别的设备」这种状态。
 *   附加路径（member） 本表存的 (deviceId, path) 二元组，可落在**任意已知设备**上。
 *
 * 于是「默认在主工作区工作」不是一条需要遵守的约定，而是**没有别的可能**：
 * 一切出厂路径（新会话、侧边栏、`workspaceRegistry`）只认主路径，附加路径只由
 * 显式动作（模型工具 `mesh_exec` 指定、UI 里选目标、浏览器执行控制台）进入。
 *
 * ── 两种 group 的主路径来源不同（读代码时别混淆）─────────────────────────────
 *   homeDeviceId === 本机   主路径**实时**从 workspaceRegistry 读 ⇒ 永不过期；
 *                           工作区被删掉时 group 变成 orphan（保留，UI 标注）。
 *   其它设备                主路径是**快照**（来自那台设备的清单/镜像），
 *                           标 `primaryStale: true`，因为本机无法实时核验远端工作区。
 *
 * @module dsh-device-mesh/paths
 */

import path from 'node:path'

import { randomHex } from './protocol.js?v=mesh-31'
import { STORE_SCHEMA, readJson, writeJsonAtomic } from './store.js?v=mesh-31'

/** 附加路径的角色。 */
export const ROLES = ['mirror', 'scratch']

/** 一个人工的 (设备, 路径) 二元组最多挂多少条 —— 防止单工作区无界膨胀。 */
const MEMBERS_PER_GROUP = 32
/** 账目里最多保留多少个 group。 */
const MAX_GROUPS = 4096

const text = (value, limit, fallback = '') => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed.slice(0, limit)
}

const iso = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null)

/**
 * 校验并归一化一个绝对路径。
 *
 * 只做**字符串**归一化（`path.normalize` + 去尾斜杠），不做 realpath：
 * 这台设备上不存在的路径也要能被登记（镜像目录可能还没建），
 * 真实性与越界检查在执行/列举时做（见 exec.js）。
 * @param {unknown} value 输入。
 * @returns {string|null} 归一化后的绝对路径，或 null。
 */
export function normalizeAbsPath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || !path.isAbsolute(trimmed)) return null
  const normalized = path.normalize(trimmed)
  if (normalized === path.sep) return normalized
  return normalized.replace(/[\\/]+$/, '')
}

/**
 * 多工作路径账目。
 */
export class PathTable {
  /**
   * @param {string} meshDir mesh 数据目录。
   * @param {string} selfDeviceId 本机设备标识。
   * @param {string[]} problems 问题收集器。
   */
  constructor(meshDir, selfDeviceId, problems) {
    this.file = path.join(meshDir, 'workspace-paths.json')
    this.selfDeviceId = selfDeviceId
    this.problems = problems
    this.lastWriteError = null
    /** @type {Map<string, {id: string, homeDeviceId: string, workspaceId: string, workspaceTitle: string, primaryPath: string|null, members: object[]}>} */
    this.groups = new Map()
    this.#load()
  }

  #load() {
    const stored = readJson(this.file, null, this.problems)
    const rows = stored !== null && Array.isArray(stored.groups) ? stored.groups : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const homeDeviceId = text(row.homeDeviceId, 128)
      const workspaceId = text(row.workspaceId, 128)
      if (homeDeviceId === '' || workspaceId === '') {
        this.problems.push('workspace-paths.json: 丢弃一条缺少 homeDeviceId/workspaceId 的 group')
        continue
      }
      const members = []
      for (const member of Array.isArray(row.members) ? row.members : []) {
        if (member === null || typeof member !== 'object') continue
        const deviceId = text(member.deviceId, 128)
        const memberPath = normalizeAbsPath(member.path)
        if (deviceId === '' || memberPath === null) {
          this.problems.push('workspace-paths.json: 丢弃一条 deviceId/path 非法的附加路径')
          continue
        }
        members.push({
          id: text(member.id, 64) || randomHex(8),
          deviceId,
          path: memberPath,
          role: ROLES.includes(member.role) ? member.role : 'mirror',
          // 显式优先级：同长并列时由它裁决（见 routing.js 的 betterOwner）。
          // 缺省 false，因此没有声明过的既有账目行为不变。
          prefer: member.prefer === true,
          label: text(member.label, 80),
          createdAt: iso(member.createdAt) ?? new Date().toISOString(),
        })
      }
      // group 的键是 (homeDeviceId, workspaceId)：workspaceId 是出厂 uuid，
      // 只在它所属设备上有意义，所以必须带上设备才能当全局键用。
      this.groups.set(groupKey(homeDeviceId, workspaceId), {
        id: text(row.id, 64) || randomHex(8),
        homeDeviceId,
        workspaceId,
        workspaceTitle: text(row.workspaceTitle, 200),
        // 本机 group 的 primaryPath 不落盘（实时派生）；远端 group 才存快照。
        primaryPath: homeDeviceId === this.selfDeviceId ? null : normalizeAbsPath(row.primaryPath),
        members,
      })
    }
  }

  #save() {
    const result = writeJsonAtomic(this.file, {
      schema: STORE_SCHEMA,
      groups: [...this.groups.values()].map((group) => ({
        ...group,
        primaryPath: group.homeDeviceId === this.selfDeviceId ? null : group.primaryPath,
      })),
    })
    this.lastWriteError = result.ok ? null : result.error
    return result.ok
  }

  /** 原始 group 列表（含 members）。 */
  all() {
    return [...this.groups.values()]
  }

  /**
   * 取（必要时新建）一个 group。
   * @param {{homeDeviceId: string, workspaceId: string, workspaceTitle?: string, primaryPath?: string|null}} input 身份。
   * @returns {{ok: true, group: object} | {ok: false, error: string}} 结果。
   */
  ensure(input) {
    const key = groupKey(input.homeDeviceId, input.workspaceId)
    const existing = this.groups.get(key)
    if (existing !== undefined) {
      // 标题与远端主路径快照每次都以最新观察为准（它们是展示字段，不是权威）。
      if (input.workspaceTitle !== undefined && input.workspaceTitle !== '') existing.workspaceTitle = input.workspaceTitle
      if (input.homeDeviceId !== this.selfDeviceId && input.primaryPath !== undefined) {
        existing.primaryPath = normalizeAbsPath(input.primaryPath)
      }
      return { ok: true, group: existing }
    }
    if (this.groups.size >= MAX_GROUPS) return { ok: false, error: `路径账目 group 数达到上限 ${MAX_GROUPS}` }
    const group = {
      id: randomHex(8),
      homeDeviceId: input.homeDeviceId,
      workspaceId: input.workspaceId,
      workspaceTitle: text(input.workspaceTitle, 200),
      primaryPath: input.homeDeviceId === this.selfDeviceId ? null : normalizeAbsPath(input.primaryPath ?? null),
      members: [],
    }
    this.groups.set(key, group)
    this.#save()
    return { ok: true, group }
  }

  /**
   * 给一个工作区挂一条附加路径。
   *
   * 同一 (deviceId, path) 在同一 group 内只允许一条 —— 否则 UI 上会出现两条一模一样的
   * 目标，执行时也无法说清「刚才那条是哪条」。跨 group 允许重复（两个逻辑工作区
   * 共用同一个物理目录是合法的）。
   * @param {{homeDeviceId: string, workspaceId: string, workspaceTitle?: string, primaryPath?: string|null, deviceId: unknown, path: unknown, role?: unknown, label?: unknown}} input 表单。
   * @returns {{ok: true, group: object, member: object} | {ok: false, error: string}} 结果。
   */
  add(input) {
    const deviceId = text(input.deviceId, 128)
    const memberPath = normalizeAbsPath(input.path)
    if (deviceId === '') return { ok: false, error: '缺少 deviceId' }
    if (memberPath === null) return { ok: false, error: '路径必须是以 / 开头的绝对路径' }
    const ensured = this.ensure({
      homeDeviceId: text(input.homeDeviceId, 128),
      workspaceId: text(input.workspaceId, 128),
      workspaceTitle: input.workspaceTitle,
      primaryPath: input.primaryPath,
    })
    if (!ensured.ok) return ensured
    const group = ensured.group

    if (group.members.length >= MEMBERS_PER_GROUP) {
      return { ok: false, error: `单个工作区最多挂 ${MEMBERS_PER_GROUP} 条附加路径` }
    }
    if (group.members.some((member) => member.deviceId === deviceId && member.path === memberPath)) {
      return { ok: false, error: '该设备上的这个路径已经挂在这个工作区下了' }
    }
    const member = {
      id: randomHex(8),
      deviceId,
      path: memberPath,
      role: ROLES.includes(input.role) ? input.role : 'mirror',
      prefer: input.prefer === true,
      label: text(input.label, 80),
      createdAt: new Date().toISOString(),
    }
    group.members.push(member)
    this.#save()
    return { ok: true, group, member }
  }

  /**
   * 改一条附加路径的角色 / 备注。
   * @param {string} memberId 成员标识。
   * @param {{role?: unknown, label?: unknown}} patch 变更。
   * @returns {{ok: true, group: object, member: object} | {ok: false, error: string}} 结果。
   */
  update(memberId, patch) {
    for (const group of this.groups.values()) {
      const member = group.members.find((entry) => entry.id === memberId)
      if (member === undefined) continue
      if (patch?.role !== undefined) {
        if (!ROLES.includes(patch.role)) return { ok: false, error: `role 必须是 ${ROLES.join(' 或 ')}` }
        member.role = patch.role
      }
      if (patch?.prefer !== undefined) member.prefer = patch.prefer === true
      if (patch?.label !== undefined) member.label = text(patch.label, 80)
      this.#save()
      return { ok: true, group, member }
    }
    return { ok: false, error: '附加路径不存在' }
  }

  /**
   * 删一条附加路径。
   * @param {string} memberId 成员标识。
   * @returns {{ok: true, group: object} | {ok: false, error: string}} 结果。
   */
  remove(memberId) {
    for (const group of this.groups.values()) {
      const index = group.members.findIndex((entry) => entry.id === memberId)
      if (index < 0) continue
      group.members.splice(index, 1)
      this.#save()
      return { ok: true, group }
    }
    return { ok: false, error: '附加路径不存在' }
  }

  /**
   * 按 workspaceId 找 group（不限定设备时取第一个命中的）。
   * @param {string} workspaceId 出厂工作区标识。
   * @param {string} [homeDeviceId] 限定所属设备。
   * @returns {object|undefined} group。
   */
  byWorkspace(workspaceId, homeDeviceId) {
    if (homeDeviceId !== undefined) return this.groups.get(groupKey(homeDeviceId, workspaceId))
    for (const group of this.groups.values()) {
      if (group.workspaceId === workspaceId) return group
    }
    return undefined
  }

  /**
   * 按「设备 + 路径」反查它属于哪个工作区。主路径的匹配由调用方另外做
   * （主路径是派生值，不在本表里）。
   * @param {string} deviceId 设备标识。
   * @param {string} targetPath 绝对路径。
   * @returns {{group: object, member: object}|undefined} 命中。
   */
  byMemberPath(deviceId, targetPath) {
    const normalized = normalizeAbsPath(targetPath)
    if (normalized === null) return undefined
    for (const group of this.groups.values()) {
      for (const member of group.members) {
        if (member.deviceId === deviceId && member.path === normalized) return { group, member }
      }
    }
    return undefined
  }

  /** 诊断。 */
  stats() {
    const groups = [...this.groups.values()]
    return {
      groups: groups.length,
      members: groups.reduce((sum, group) => sum + group.members.length, 0),
      lastWriteError: this.lastWriteError,
    }
  }
}

/**
 * group 的复合键。
 * @param {string} homeDeviceId 所属设备。
 * @param {string} workspaceId 工作区标识。
 * @returns {string} 键。
 */
function groupKey(homeDeviceId, workspaceId) {
  return `${homeDeviceId}\u0000${workspaceId}`
}
