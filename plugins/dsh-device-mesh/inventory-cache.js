/**
 * dsh-device-mesh — 清单快照缓存。
 *
 * 采集一次本机清单要读全部会话头 + 可能折叠日志，**不能每个请求各采一次**：
 * egress 的心跳、对端的 `/tree`、浏览器开面板都会要清单。所以全进程只留一份
 * 带 revision 的快照，所有消费方共享：
 *
 *   · TTL 内直接复用（默认 5 s）；
 *   · 同一时刻只跑一次采集（在飞合并），后来的等同一份；
 *   · 采集失败**保留上一份可用快照**并标 `stale`，而不是把树清空
 *     （「读不到」和「没有会话」必须能被区分开）。
 *
 * revision 只在**采集成功**时自增，egress 用它判断「这次要不要真的推」。
 *
 * @module dsh-device-mesh/inventory-cache
 */

import { collectInventory } from './inventory.js?v=mesh-31'

/**
 * @param {{ctx: object, config: object, device: () => object, logger?: object, now?: () => number}} options 依赖。
 * @returns {{get: (options?: {force?: boolean, signal?: AbortSignal}) => Promise<object>, invalidate: () => void, current: () => object|null, stats: () => object}} 缓存句柄。
 */
export function createInventoryCache(options) {
  const now = options.now ?? Date.now
  /** @type {object|null} */
  let snapshot = null
  let revision = 0
  let collectedAt = 0
  let inflight = null
  let lastError = null
  let lastErrorAt = null
  let collections = 0
  let failures = 0
  let joins = 0
  let lastDurationMs = null
  let lastSlowMs = null
  /** 缓存建立时刻：用来界定「开机初期」这一段特殊窗口。 */
  const loadedAt = now()

  /**
   * 装载后多久之内，把「采残的快照」一律视为不新鲜。
   *
   * Cordis 按行装载，网格行可能**先于**工作区/会话那几行挂上，于是第一份清单是在
   * 它们还没就绪时采的：`degraded.workspaceRegistry = 服务不可用`、0 个工作区、
   * 全部会话未归属、没有标题。实测（rpi，0.2.0）这份残清单会被当成正常数据展示
   * **约 60 秒**才自愈——重启后那一分钟里对端看到的是一个不存在的世界。
   * 一分钟后仍残（例如本 profile 本来就没有该服务）就恢复正常 TTL：一直重采会把
   * 3 秒级的采集变成常态，那比展示一次残清单更糟。
   */
  const BOOT_GRACE_MS = 60_000

  /**
   * 这份快照是不是「采到了、但采残了」——采集时某项必需服务还没挂上。
   * 采残 ≠ 采集失败：它有 revision、有 totals，看起来完全正常，所以必须单独识别。
   * @returns {boolean} 是否残。
   */
  const degraded = () => {
    const view = snapshot?.degraded
    if (view === null || typeof view !== 'object') return false
    return Object.values(view).some((value) => typeof value === 'string' && value !== '')
  }

  const fresh = (force) => !force
    && snapshot !== null
    && !(degraded() && now() - loadedAt < BOOT_GRACE_MS)
    && now() - collectedAt < options.config.inventoryTtlMs

  const collect = async (force, signal) => {
    collections += 1
    const startedAt = now()
    try {
      revision += 1
      const next = await collectInventory(options.ctx, {
        device: options.device(),
        config: options.config,
        revision,
        signal,
        now: now(),
      })
      snapshot = next
      collectedAt = now()
      lastDurationMs = collectedAt - startedAt
      // 采集一次的代价直接决定 TTL 该配多大：listSessions 要遍历整个逻辑语料
      // （本机实测 1700+ 会话），所以把耗时记下来供 /status 核对，而不是靠猜。
      lastSlowMs = Math.max(lastSlowMs ?? 0, lastDurationMs)
      lastError = null
      return next
    } catch (error) {
      revision -= 1
      failures += 1
      lastError = error?.message ?? String(error)
      lastErrorAt = new Date(now()).toISOString()
      options.logger?.warn?.(`dsh-device-mesh: 清单采集失败：${lastError}`)
      if (snapshot !== null) return { ...snapshot, stale: true, staleReason: lastError }
      throw error
    }
  }

  return {
    /**
     * 后台刷新：不等待结果。
     *
     * 采集一次要遍历整个逻辑语料（本机 1700+ 会话实测约 3.3 s，其中大头是标题
     * 日志折叠的时间预算），**不能**把它放在浏览器请求的关键路径上 —— 那样每次
     * 面板轮询都会卡住三秒。所以有快照时立刻返回旧快照、同时踢一次后台刷新，
     * 下一次轮询自然拿到新数据。首次（还没有任何快照）仍然必须等，否则会返回空树。
     * @returns {boolean} 是否真的踢了一次。
     */
    kick() {
      if (inflight !== null) return false
      if (fresh(false)) return false
      void collect(false, undefined).catch(() => {
        // collect 自己已经记了 lastError 并保留旧快照，这里只负责不让 rejection 逃逸。
      })
      return true
    },
    async get(request = {}) {
      if (fresh(request.force === true)) return snapshot
      if (inflight !== null) {
        joins += 1
        return inflight
      }
      inflight = collect(request.force === true, request.signal)
      try {
        return await inflight
      } finally {
        inflight = null
      }
    },
    invalidate() {
      collectedAt = 0
    },
    current() {
      return snapshot
    },
    stats() {
      return {
        revision,
        collections,
        failures,
        joins,
        inflight: inflight !== null,
        collectedAt: collectedAt === 0 ? null : new Date(collectedAt).toISOString(),
        ageMs: collectedAt === 0 ? null : now() - collectedAt,
        lastDurationMs,
        slowestMs: lastSlowMs,
        ttlMs: options.config.inventoryTtlMs,
        lastError,
        lastErrorAt,
        hasSnapshot: snapshot !== null,
        // 「当前这份快照残没残」也是一条可观测事实：它决定对端看到的清单可不可信。
        degraded: degraded(),
        workspaceCount: snapshot?.workspaces?.length ?? 0,
        sessionCount: snapshot?.totals?.sessions ?? 0,
      }
    },
  }
}
