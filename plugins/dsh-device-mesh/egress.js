/**
 * dsh-device-mesh — 出站连接器：把本机清单推给远端接入点。
 *
 * 一个「接入点」= 一台装了本插件、开了入站接入的 DSH。本机主动向它 join，
 * 之后周期性 report（清单变了才推全量）/ heartbeat（没变就只报活）。
 *
 * 每个链接的运行时状态（是否已 join、上次推的哪一版）只存内存：进程重启后
 * 重新 join 一次即可，join 是幂等的，没必要把「握过手」也落盘。
 *
 * ── 失败分级（决定重试姿态）────────────────────────────────────────────────
 *   unauthenticated / device-denied  → 停在这个链接上等人处理，每轮仍试（便宜），
 *                                      UI 红色显示具体原因。
 *   protocol-mismatch                → 同上（升级才能解决）。
 *   unknown-node                     → **就地重新 join**（对端换过数据目录 / forget 过）。
 *   inbound-disabled / too-many-nodes→ 停推，等人去对端开。
 *   网络/超时/5xx                     → 标记 idle，下一轮重试（不累积错误状态）。
 *
 * @module dsh-device-mesh/egress
 */

import { API, CODE, PROTOCOL_VERSION, buildSignatureHeaders } from './protocol.js?v=mesh-31'
import { requestJson } from './http.js?v=mesh-31'

/**
 * 出站连接器。
 */
export class Egress {
  /**
   * @param {{config: object, identity: object, links: object, device: () => object, inventory: object, logger?: object, now?: () => number}} options 依赖。
   */
  constructor(options) {
    this.config = options.config
    this.identity = options.identity
    this.links = options.links
    this.device = options.device
    this.inventory = options.inventory
    this.logger = options.logger
    this.now = options.now ?? Date.now
    /** @type {Map<string, {joined: boolean, nodeId: string|null, lastPushRevision: number, lastPushAt: number, hubDevice: object|null, consecutiveFailures: number}>} */
    this.runtime = new Map()
    this.timer = null
    this.running = false
    this.ticking = false
    this.controller = null
    this.lastTickAt = null
    this.ticks = 0
    this.pushes = 0
    this.heartbeats = 0
    this.failures = 0
    this.joinAttempts = 0
  }

  /** 启动轮询。重复调用是幂等的。 */
  start() {
    if (this.running) return
    this.running = true
    this.#schedule(1500)
  }

  /** 停止轮询并取消在飞请求。 */
  stop() {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.controller?.abort()
    this.controller = null
  }

  /**
   * 排下一次心跳。间隔取「推送间隔」与「心跳间隔」的较小者，
   * 并夹在 [2 s, 10 min] 之间防止配置写出病态值。
   * @param {number} delayMs 延迟。
   * @returns {void}
   */
  #schedule(delayMs) {
    if (!this.running) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick().finally(() => {
        const cadence = Math.min(
          Math.max(2000, this.config.pushIntervalMs),
          Math.max(2000, this.config.heartbeatMs),
        )
        this.#schedule(Math.min(Math.max(2000, cadence), 600000))
      })
    }, Math.max(0, delayMs))
    // 轮询不该把 Node 进程钉住不退出（DSH 退出时不必等这一轮心跳）。
    this.timer.unref?.()
  }

  /**
   * 跑一轮：遍历启用中的链接，逐个驱动。
   * @param {{linkId?: string, force?: boolean}} request 只驱动某条 / 强制推全量。
   * @returns {Promise<object[]>} 每个链接这一轮的结果（也用于 `/links/sync` 的响应）。
   */
  async tick(request = {}) {
    if (this.ticking) return []
    this.ticking = true
    this.ticks += 1
    this.lastTickAt = new Date(this.now()).toISOString()
    this.controller = new AbortController()
    const signal = this.controller.signal
    /** @type {object[]} */
    const results = []
    try {
      const targets = this.links.all().filter((link) => (request.linkId === undefined ? link.enabled : link.id === request.linkId))
      if (targets.length === 0) return results
      let inventory = null
      try {
        inventory = await this.inventory.get({ force: request.force === true, signal })
      } catch (error) {
        results.push({ linkId: null, ok: false, error: `本机清单采集失败：${error?.message ?? error}` })
        return results
      }
      for (const link of targets) {
        if (signal.aborted) break
        results.push(await this.#drive(link, inventory, signal, request.force === true))
      }
      return results
    } finally {
      this.ticking = false
      this.controller = null
    }
  }

  /**
   * 驱动一条链接：没 join 就 join，join 过就按「清单是否变了」决定推全量还是心跳。
   * @param {object} link 链接记录（含 secret）。
   * @param {object} inventory 当前清单快照。
   * @param {AbortSignal} signal 取消信号。
   * @param {boolean} force 强制推全量。
   * @returns {Promise<object>} 结果摘要。
   */
  async #drive(link, inventory, signal, force) {
    const state = this.#stateFor(link.id)
    if (link.tokenId === '' || link.secret === '') {
      this.links.record(link.id, { state: 'unconfigured', lastError: '尚未填写令牌标识与密钥' })
      return { linkId: link.id, ok: false, action: 'skip', error: '未配置令牌' }
    }
    if (!state.joined) {
      const joined = await this.#join(link, inventory, signal)
      if (!joined.ok) return joined
      return { linkId: link.id, ok: true, action: 'join', hub: joined.hub }
    }

    const stale = this.now() - state.lastPushAt >= this.config.pushIntervalMs
    const changed = state.lastPushRevision !== inventory.revision
    if (force || changed || stale) {
      return this.#post(link, state, API.report, { protocol: PROTOCOL_VERSION, nodeId: state.nodeId, inventory }, signal, inventory.revision)
    }
    const summary = {
      workspaces: inventory.totals.workspaces,
      sessions: inventory.totals.sessions,
      live: inventory.totals.live,
      revision: inventory.revision,
      generatedAt: inventory.generatedAt,
    }
    return this.#post(link, state, API.heartbeat, { protocol: PROTOCOL_VERSION, nodeId: state.nodeId, summary }, signal, null)
  }

  /**
   * 取（或建）一条链接的运行时状态。
   * @param {string} linkId 链接标识。
   * @returns {object} 状态。
   */
  #stateFor(linkId) {
    let state = this.runtime.get(linkId)
    if (state === undefined) {
      state = { joined: false, nodeId: null, lastPushRevision: -1, lastPushAt: 0, hubDevice: null, consecutiveFailures: 0 }
      this.runtime.set(linkId, state)
    }
    return state
  }

  /**
   * 向接入点发起 join。
   * @param {object} link 链接记录。
   * @param {object} inventory 当前清单。
   * @param {AbortSignal} signal 取消信号。
   * @returns {Promise<object>} 结果。
   */
  async #join(link, inventory, signal) {
    this.joinAttempts += 1
    const body = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      device: this.device(),
      inventory,
    })
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path: API.join,
      body,
      now: this.now(),
    })
    const result = await requestJson(link.url, {
      path: API.join,
      method: 'POST',
      body,
      headers,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
      signal,
    })
    if (!result.ok) return this.#fail(link, 'join', result)
    const payload = result.json !== null && typeof result.json === 'object' ? result.json : {}
    const state = this.#stateFor(link.id)
    state.joined = true
    state.nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null
    state.hubDevice = payload.hub !== null && typeof payload.hub === 'object' ? payload.hub : null
    // join 已经带上当前清单，对端记录的就是这一版（除非它没存 inventory，
    // 那种情况下一次 report 会补上；保守起见把 lastPushRevision 留在 -1，
    // 让紧接着的那一轮补推一次全量）。
    state.lastPushRevision = payload.inventoryStored === true ? inventory.revision : -1
    state.lastPushAt = payload.inventoryStored === true ? this.now() : 0
    state.consecutiveFailures = 0
    this.links.record(link.id, {
      state: 'joined',
      lastError: null,
      hubDevice: state.hubDevice,
      joined: true,
      now: this.now(),
      flush: true,
    })
    return { linkId: link.id, ok: true, action: 'join', hub: state.hubDevice }
  }

  /**
   * 发一次已签名的 POST（report / heartbeat）。
   * @param {object} link 链接记录。
   * @param {object} state 运行时状态。
   * @param {string} path 目标路径。
   * @param {object} payload 请求体对象。
   * @param {AbortSignal} signal 取消信号。
   * @param {number|null} revision 成功后要记的清单版本（心跳传 null）。
   * @returns {Promise<object>} 结果。
   */
  async #post(link, state, path, payload, signal, revision) {
    const body = JSON.stringify(payload)
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path,
      body,
      now: this.now(),
    })
    const result = await requestJson(link.url, {
      path,
      method: 'POST',
      body,
      headers,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
      signal,
    })
    const action = path === API.report ? 'report' : 'heartbeat'
    if (!result.ok) {
      // unknown-node 是对端「不记得我们了」，就地重新 join 一次，不让它变成一个
      // 需要人工介入的错误——这是幂等 join 存在的意义。
      if (result.json !== null && typeof result.json === 'object' && result.json.code === CODE.unknownNode) {
        state.joined = false
        state.lastPushRevision = -1
        return { linkId: link.id, ok: false, action, error: result.error, recovered: 'rejoin-scheduled' }
      }
      return this.#fail(link, action, result)
    }
    state.consecutiveFailures = 0
    state.lastPushAt = this.now()
    if (revision !== null) {
      state.lastPushRevision = revision
      this.pushes += 1
      this.links.record(link.id, { state: 'joined', lastError: null, pushed: true, now: this.now() })
      return { linkId: link.id, ok: true, action: 'report', revision }
    }
    this.heartbeats += 1
    // 心跳成功且此前是错误态 → 立刻落盘，让 UI 从红转绿。
    const wasError = link.lastError !== null && link.lastError !== undefined
    this.links.record(link.id, { state: 'joined', lastError: null, flush: wasError, now: this.now() })
    return { linkId: link.id, ok: true, action: 'heartbeat' }
  }

  /**
   * 统一处理一次失败：写状态、累计、返回结果。
   * @param {object} link 链接记录。
   * @param {string} action 动作名。
   * @param {{status: number|null, error: string, json: unknown}} result 失败结果。
   * @returns {object} 结果摘要。
   */
  #fail(link, action, result) {
    this.failures += 1
    const state = this.#stateFor(link.id)
    state.consecutiveFailures += 1
    const code = result.json !== null && typeof result.json === 'object' && typeof result.json.code === 'string'
      ? result.json.code
      : null
    // 认证/协议类失败要求人工介入：把 joined 打掉，让人在 UI 上看到「需要处理」，
    // 而不是继续显示一个其实推不上去的「已连接」。
    if (code === CODE.unauthenticated || code === CODE.badSignature || code === CODE.protocolMismatch || code === CODE.deviceDenied) {
      state.joined = false
    }
    const label = result.status === null ? result.error : `HTTP ${result.status}：${result.error}`
    this.links.record(link.id, {
      state: result.status === null ? 'idle' : 'error',
      lastError: label,
      now: this.now(),
      flush: true,
    })
    if (state.consecutiveFailures === 1 || state.consecutiveFailures % 10 === 0) {
      this.logger?.warn?.(`dsh-device-mesh: 接入点 ${link.url} ${action} 失败（连续 ${state.consecutiveFailures} 次）：${label}`)
    }
    return { linkId: link.id, ok: false, action, error: label, code }
  }

  /**
   * 探测一个接入点：`hello` 是不需要认证的，正好用来区分
   * 「地址不通」与「地址通了但令牌不对」。
   * @param {{url: string, tokenId?: string, secret?: string}} input 待测接入点。
   * @returns {Promise<object>} 探测结果。
   */
  async probe(input) {
    const hello = await requestJson(input.url, {
      path: API.hello,
      method: 'GET',
      timeoutMs: Math.min(this.config.requestTimeoutMs, 8000),
      maxBytes: 256 * 1024,
    })
    if (!hello.ok) return { ok: false, stage: 'hello', error: hello.error, status: hello.status }
    const hub = hello.json !== null && typeof hello.json === 'object' ? hello.json : {}
    if (hub.protocol !== PROTOCOL_VERSION) {
      return {
        ok: false,
        stage: 'hello',
        error: `协议版本不匹配：对端 ${String(hub.protocol)}，本机 ${PROTOCOL_VERSION}`,
        code: CODE.protocolMismatch,
        hub,
      }
    }
    if (input.tokenId === undefined || input.tokenId === '' || input.secret === undefined || input.secret === '') {
      return { ok: true, stage: 'hello', hub, authenticated: false, note: '地址可达；未填令牌，未做认证探测' }
    }
    const body = JSON.stringify({ protocol: PROTOCOL_VERSION, device: this.device(), probe: true })
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: input.tokenId,
      secret: input.secret,
      method: 'POST',
      path: API.join,
      body,
      now: this.now(),
    })
    const joined = await requestJson(input.url, {
      path: API.join,
      method: 'POST',
      body,
      headers,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
    })
    if (!joined.ok) {
      return {
        ok: false,
        stage: 'join',
        error: joined.error,
        code: joined.json !== null && typeof joined.json === 'object' ? joined.json.code ?? null : null,
        status: joined.status,
        hub,
      }
    }
    return { ok: true, stage: 'join', hub, authenticated: true, note: '地址可达且令牌有效' }
  }

  /**
   * 取一条链接的**只读**运行时状态（给 entry 的镜像循环用）。
   * 返回副本而不是内部对象：调用方不该能把「已 join」改成别的值。
   * @param {string} linkId 链接标识。
   * @returns {object|null} 状态副本，或 null（该链接从没跑过）。
   */
  stateOf(linkId) {
    const state = this.runtime.get(linkId)
    if (state === undefined) return null
    return {
      joined: state.joined,
      nodeId: state.nodeId,
      lastPushRevision: state.lastPushRevision,
      lastPushAt: state.lastPushAt,
      hubDevice: state.hubDevice,
      consecutiveFailures: state.consecutiveFailures,
    }
  }

  /** 诊断快照。 */
  stats() {
    return {
      running: this.running,
      ticking: this.ticking,
      ticks: this.ticks,
      pushes: this.pushes,
      heartbeats: this.heartbeats,
      failures: this.failures,
      joinAttempts: this.joinAttempts,
      lastTickAt: this.lastTickAt,
      links: this.links.all().map((link) => {
        const state = this.runtime.get(link.id)
        return {
          id: link.id,
          url: link.url,
          enabled: link.enabled,
          joined: state?.joined === true,
          nodeId: state?.nodeId ?? null,
          lastPushRevision: state?.lastPushRevision ?? null,
          consecutiveFailures: state?.consecutiveFailures ?? 0,
        }
      }),
    }
  }
}
