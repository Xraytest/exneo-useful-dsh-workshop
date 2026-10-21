/**
 * dsh-device-mesh — 跨设备执行的**发起侧**：解析「这条命令该在哪台设备的哪个目录跑」，
 * 然后要么本机跑，要么签名发到直连接入点去跑。
 *
 * ── 目标解析（这是本模块唯一的难点，规则必须写死在代码里而不是交给调用方）────
 * 出厂语义是「一个工作区 = 一个路径」，本插件加了「附加路径」之后，同一条逻辑路径
 * 可能对应多个 (设备, 目录)。解析顺序：
 *
 *   1. 给了 `path`：
 *      a. 在路径账目里按「设备 + 路径」反查 → 命中附加路径 ⇒ 目标是那条 member，
 *         设备就是它所在的设备。**这是「跨设备」最主要的入口**。
 *      b. 没命中 → 在**各设备的主路径**里找精确匹配 ⇒ 目标是那台设备。
 *      c. 还没命中 → 给了 `device` 就按 (device, path) 走；没给就当本机路径。
 *   2. 只给 `workspace`（id 或标题）→ 用它的**主路径**与所属设备
 *      （"默认在主工作区工作" 在这里落地：不提 path 就永远走主路径）。
 *   3. 只给 `device` → 用该设备**第一个有会话的工作区**主路径；没有就报错要求显式给 path。
 *   4. 什么都没给 → 报错。
 *
 * ── 只走一跳（硬边界）──────────────────────────────────────────────────────
 * 目标设备必须是**本机自己**，或本机**直连的接入点**（本机 join 过它、有链接）。
 * 「接入点的接入点」在本机只是镜像里的一行数据：能看到它的会话，但**不能**在它上面
 * 执行 —— 那需要接入点替我们中继，而中继会把「谁真正执行了这条命令」变得含糊。
 * 拒绝时给的是可行动的说明（去加一条指向它的接入点），不是一个空错误。
 *
 * @module dsh-device-mesh/caller
 */

import { API, CODE, PROTOCOL_VERSION, buildSignatureHeaders } from './protocol.js?v=mesh-31'
import { ExecError } from './exec.js?v=mesh-31'
import { requestJson } from './http.js?v=mesh-31'

/** 设备名匹配时的宽松归一：去空白、小写。 */
const loose = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/**
 * 把**会话权限**并进转发请求体。
 *
 * 字段名用 `sessionMode`，而契约里写的是 `mode` —— 这是**必要**的偏离：`fsRead` 的
 * `mode` 早就是「读的编码」（`text` / `bytes`），沿用同名会直接把编码冲掉，读文件当场
 * 全坏。受理侧两个名字都认（`exec.js` 的 `readPermissionMode` 优先认 `sessionMode`，
 * 且只在 `mode` 的取值恰好是权限模式之一时才把它当权限），所以按契约发 `mode` 的调用
 * 方也仍然被认。
 *
 * @param {object} body 原请求体。
 * @param {{mode?: string, workspaceRoot?: string}|undefined} permission 会话权限。
 * @returns {object} 并好权限的请求体（没有权限时原样返回）。
 */
export function withPermission(body, permission) {
  const mode = typeof permission?.mode === 'string' ? permission.mode : ''
  if (mode === '') return body
  const root = typeof permission?.workspaceRoot === 'string' ? permission.workspaceRoot : ''
  return { ...body, sessionMode: mode, ...root !== '' ? { workspaceRoot: root } : {} }
}

/**
 * 跨设备执行发起器。
 */
export class Caller {
  /**
   * @param {{config: object, identity: {deviceId: string, name: string}, links: object, egress: object, executor: object, audit?: object, logger?: object, context: () => {devices: object[], groups: object[]}}} options 依赖。
   */
  constructor(options) {
    this.config = options.config
    this.identity = options.identity
    this.links = options.links
    this.egress = options.egress
    this.executor = options.executor
    // 发起侧也要审计：只在对端留痕的话，「这台机器发起过什么」在本机就查不到，
    // 而这恰恰是出事时第一个要回答的问题。
    this.audit = options.audit ?? null
    this.logger = options.logger
    this.context = options.context
    this.remoteRuns = 0
    this.localRuns = 0
    /** @type {number} 转发时**带了**会话权限的次数。 */
    this.forwardedWithMode = 0
    /** @type {number} 转发时**没带**会话权限的次数（属主按旧的导出根口径裁决）。 */
    this.forwardedWithoutMode = 0
    this.resolveFailures = 0
  }

  /**
   * 找一台设备在本地视角下的记录。
   * @param {string} needle 设备 id / 名字（大小写不敏感）。
   * @returns {object|undefined} 设备条目。
   */
  findDevice(needle) {
    const target = loose(needle)
    if (target === '') return undefined
    const { devices } = this.context()
    return devices.find((entry) => entry.deviceId === needle)
      ?? devices.find((entry) => loose(entry.name) === target)
      ?? devices.find((entry) => entry.deviceId.startsWith(needle))
      ?? devices.find((entry) => loose(entry.name).includes(target))
  }

  /**
   * 按 workpace id 或标题找工作区（跨设备）。
   * @param {string} needle 工作区 id / 标题。
   * @returns {{device: object, workspace: object}|undefined} 命中。
   */
  findWorkspace(needle) {
    const target = loose(needle)
    if (target === '') return undefined
    const { devices } = this.context()
    for (const device of devices) {
      for (const workspace of device.inventory?.workspaces ?? []) {
        if (workspace.id === needle) return { device, workspace }
      }
    }
    for (const device of devices) {
      for (const workspace of device.inventory?.workspaces ?? []) {
        if (loose(workspace.title) === target) return { device, workspace }
      }
    }
    for (const device of devices) {
      for (const workspace of device.inventory?.workspaces ?? []) {
        if (loose(workspace.title).includes(target)) return { device, workspace }
      }
    }
    return undefined
  }

  /**
   * 找一台设备对应的出站链接（本机直连它）。
   *
   * 判据是「链接的 hub 就是这台设备」：`link.hubDevice.deviceId` 是 join 时对端自报的，
   * 权威。**不**用 URL 猜，也不看镜像 —— 镜像里的设备本机没有通往它的凭据。
   * @param {string} deviceId 目标设备。
   * @returns {object|undefined} 链接记录（含 secret）。
   */
  findLink(deviceId) {
    return this.links.all().find((link) => link.hubDevice?.deviceId === deviceId && link.enabled)
      ?? this.links.all().find((link) => link.hubDevice?.deviceId === deviceId)
  }

  /**
   * 解析执行目标。
   * @param {{path?: unknown, workspace?: unknown, device?: unknown}} request 请求。
   * @returns {{deviceId: string, deviceName: string, path: string, local: boolean, link: object|null, resolvedBy: string, groupId: string|null, memberId: string|null, role: string}} 目标。
   * @throws {ExecError} 解析失败（400 / 409 unreachable / 400 path-missing）。
   */
  resolveTarget(request) {
    const { devices, groups } = this.context()
    const selfDeviceId = this.identity.deviceId
    const wantPath = typeof request.path === 'string' ? request.path.trim() : ''
    const wantWorkspace = typeof request.workspace === 'string' ? request.workspace.trim() : ''
    const wantDevice = typeof request.device === 'string' ? request.device.trim() : ''

    const deviceView = (deviceId) => devices.find((entry) => entry.deviceId === deviceId)
    const finish = (deviceId, targetPath, resolvedBy, extra = {}) => {
      const view = deviceView(deviceId)
      const local = deviceId === selfDeviceId
      const link = local ? null : (this.findLink(deviceId) ?? null)
      if (!local && link === null) {
        this.resolveFailures += 1
        throw new ExecError(
          409,
          `无法在「${view?.name ?? deviceId}」上执行：本机没有指向它的接入点。`
          + '跨设备执行只走一跳 —— 需要在「接入点」页加一条指向该设备的链接（并让对端给你一个令牌）。',
          CODE.unreachable,
          { deviceId },
        )
      }
      if (!local && view?.device?.capabilities !== undefined
        && Array.isArray(view.device.capabilities)
        && !view.device.capabilities.includes('remote-exec')) {
        this.resolveFailures += 1
        throw new ExecError(
          409,
          `「${view?.name ?? deviceId}」没有开启跨设备执行（它的 capabilities 里没有 remote-exec）`,
          CODE.execDisabled,
          { deviceId },
        )
      }
      return {
        deviceId,
        deviceName: view?.name ?? (local ? this.identity.name : deviceId),
        path: targetPath,
        local,
        link,
        resolvedBy,
        groupId: extra.groupId ?? null,
        memberId: extra.memberId ?? null,
        role: extra.role ?? (local ? 'primary' : 'primary'),
      }
    }

    // ① path 优先
    if (wantPath !== '') {
      // 一次性把「限定设备」解析成 id：下面 b/c 两步都必须**只在它之内**找。
      // 如果 b 步扫全部设备，那么「(设备C, 恰好是B主路径的路径)」会被静默解释成
      // 「在 B 上执行」—— 请求里点名了设备却被换掉，这是最不能接受的一种错误，
      // 因为它会在一台用户没打算碰的机器上跑命令，而且看起来完全成功。
      const pinned = wantDevice === '' ? null : this.findDevice(wantDevice)
      if (wantDevice !== '' && pinned === undefined) {
        throw new ExecError(404, `找不到设备「${wantDevice}」`, CODE.notFound)
      }
      const candidates = pinned === null || pinned === undefined ? devices.map((entry) => entry.deviceId) : [pinned.deviceId]

      // a. 附加路径账目反查（限定设备时只在它下面查）
      for (const deviceId of candidates) {
        const hit = this.#memberByPath(deviceId, wantPath, groups)
        if (hit !== undefined) {
          return finish(deviceId, hit.member.path, 'member', {
            groupId: hit.group.id,
            memberId: hit.member.id,
            role: hit.member.role,
          })
        }
      }
      // b. 主路径精确匹配 —— 同样只在上面的 candidate 集合里找
      for (const device of devices) {
        if (pinned !== null && pinned !== undefined && device.deviceId !== pinned.deviceId) continue
        for (const workspace of device.inventory?.workspaces ?? []) {
          if (workspace.path === wantPath) {
            return finish(device.deviceId, workspace.path, 'primary', { groupId: workspace.id })
          }
        }
      }
      // c. 限定设备时按 (device, path) 走（允许执行一个还没在任何清单里出现的目录）；
      //    没限定设备时把它当本机路径。
      if (pinned !== null && pinned !== undefined) {
        return finish(pinned.deviceId, wantPath, 'device+path')
      }
      return finish(selfDeviceId, wantPath, 'local-path')
    }

    // ② workspace
    if (wantWorkspace !== '') {
      const hit = this.findWorkspace(wantWorkspace)
      if (hit === undefined) throw new ExecError(404, `找不到工作区「${wantWorkspace}」`, CODE.notFound)
      // 主路径可能对端清单里为空（工作区目录已删）——那时只能要求显式给 path。
      if (typeof hit.workspace.path !== 'string' || hit.workspace.path === '') {
        throw new ExecError(400, `工作区「${hit.workspace.title}」没有可用的主路径，请显式指定 path`, CODE.badRequest)
      }
      return finish(hit.device.deviceId, hit.workspace.path, 'workspace-primary', { groupId: hit.workspace.id })
    }

    // ③ device
    if (wantDevice !== '') {
      const device = this.findDevice(wantDevice)
      if (device === undefined) throw new ExecError(404, `找不到设备「${wantDevice}」`, CODE.notFound)
      const workspaces = [...(device.inventory?.workspaces ?? [])]
        .filter((workspace) => typeof workspace.path === 'string' && workspace.path !== '')
        .sort((a, b) => (b.sessionCount ?? 0) - (a.sessionCount ?? 0))
      if (workspaces.length === 0) {
        throw new ExecError(400, `「${device.name}」没有已知的工作区路径，请显式指定 path`, CODE.badRequest)
      }
      return finish(device.deviceId, workspaces[0].path, 'device-default', { groupId: workspaces[0].id })
    }

    throw new ExecError(400, '需要至少指定 path、workspace 或 device 之一', CODE.badRequest)
  }

  /**
   * 在路径账目里按「设备 + 路径」反查。
   * @param {string} deviceId 设备。
   * @param {string} targetPath 路径。
   * @param {object[]} groups 账目视图。
   * @returns {{group: object, member: object}|undefined} 命中。
   */
  #memberByPath(deviceId, targetPath, groups) {
    const trimmed = targetPath.replace(/[\\/]+$/, '')
    for (const group of groups) {
      for (const member of group.members ?? []) {
        if (member.deviceId === deviceId && member.path === trimmed) return { group, member }
      }
    }
    return undefined
  }

  /**
   * 执行一条命令。
   * @param {{path?: unknown, workspace?: unknown, device?: unknown, command: unknown, timeoutMs?: unknown, actor?: string, direction?: 'tool'|'browser'}} request 请求。
   * @returns {Promise<object>} 结果（含 `target`）。
   * @throws {ExecError} 解析 / 传输 / 远端拒绝。
   */
  async exec(request) {
    const command = typeof request.command === 'string' ? request.command : ''
    if (command.trim() === '') throw new ExecError(400, 'command 不能为空', CODE.badRequest)
    if (command.length > this.config.execCommandLimit) {
      throw new ExecError(400, `command 超过 ${this.config.execCommandLimit} 字符上限`, CODE.badRequest)
    }
    const target = this.resolveTarget(request)
    const actor = request.actor ?? 'local'
    const direction = request.direction ?? 'tool'

    if (target.local) {
      const cwd = this.executor.resolveLocal(target.path)
      const result = await this.executor.run({
        cwd,
        command,
        timeoutMs: request.timeoutMs,
        actor,
        deviceId: this.identity.deviceId,
        deviceName: this.identity.name,
        direction,
        auditPath: target.path,
        permission: request.permission,
      })
      this.localRuns += 1
      return { ...result, target: publicTarget(target, cwd) }
    }

    const link = target.link
    if (link.tokenId === '' || link.secret === '') {
      throw new ExecError(409, `接入点「${link.label}」还没配好令牌，无法执行`, CODE.unauthenticated, { linkId: link.id })
    }
    const timeoutMs = Number.isFinite(Number(request.timeoutMs))
      ? Math.min(Math.max(100, Math.trunc(Number(request.timeoutMs))), this.config.execTimeoutMs)
      : this.config.execTimeoutMs
    // 权限计数按**尝试**记（请求体只要带着权限就算），与 `remoteRuns`（按成功记）不同口径。
    if (typeof request.permission?.mode === 'string' && request.permission.mode !== '') this.forwardedWithMode += 1
    else this.forwardedWithoutMode += 1
    const body = JSON.stringify(withPermission({
      protocol: PROTOCOL_VERSION,
      nodeId: this.egress.stateOf(link.id)?.nodeId ?? null,
      path: target.path,
      command,
      timeoutMs,
      // 发起方生成的执行 id，原样带给对端：本机靠它在本地中止时点名中止。
      // 只有形状合法才带（与签名头 nonce 同一套字符集），免得把任意字符串塞进对端查找表。
      ...(typeof request.jobId === 'string' && /^[0-9a-f]{8,64}$/.test(request.jobId.trim())
        ? { jobId: request.jobId.trim() }
        : {}),
    }, request.permission))
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path: API.exec,
      body,
    })
    const result = await requestJson(link.url, {
      path: API.exec,
      method: 'POST',
      body,
      headers,
      // 远端执行本身可能跑满 execTimeoutMs，网络超时必须比它宽，否则我们会先
      // 放弃等待而远端还在跑 —— 那会留下一条「执行了但没人知道结果」的命令。
      timeoutMs: timeoutMs + 15000,
      maxBytes: this.config.maxResponseBytes,
    })
    if (!result.ok) {
      const code = result.json !== null && typeof result.json === 'object' && typeof result.json.code === 'string'
        ? result.json.code
        : CODE.unreachable
      this.logger?.warn?.(`dsh-device-mesh: 远端执行失败（${link.url}）：${result.error}`)
      this.#audit({
        direction: 'out',
        actor,
        deviceId: target.deviceId,
        deviceName: target.deviceName,
        path: target.path,
        command,
        outcome: 'error',
        code,
        exitCode: null,
        durationMs: 0,
        error: result.error,
      })
      const remoteAuditId = result.json !== null && typeof result.json === 'object' && typeof result.json.auditId === 'string'
        ? result.json.auditId
        : undefined
      throw new ExecError(result.status ?? 502, `${target.deviceName}：${result.error}`, code, {
        linkId: link.id,
        deviceId: target.deviceId,
        // 把对端那条审计的编号带回来：一次被拒的执行会在两侧各留一条，
        // 用同一个 id 就能直接对上「我发的这条」和「它拒的那条」。
        auditId: remoteAuditId,
      })
    }
    const payload = result.json !== null && typeof result.json === 'object' ? result.json : {}
    this.remoteRuns += 1
    // 成功路径也在发起侧留一条：审计编号沿用对端返回的那个，
    // 于是两端日志可以按同一个 id 对上（"我发的这条，对端记的那条，是同一次"）。
    this.#audit({
      id: typeof payload.auditId === 'string' ? payload.auditId : undefined,
      direction: 'out',
      actor,
      deviceId: target.deviceId,
      deviceName: target.deviceName,
      path: target.path,
      command,
      outcome: payload.timedOut === true ? 'timeout' : (payload.exitCode === 0 ? 'ok' : 'error'),
      code: null,
      exitCode: Number.isSafeInteger(payload.exitCode) ? payload.exitCode : null,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
      error: null,
    })
    return {
      auditId: payload.auditId ?? null,
      cwd: payload.cwd ?? target.path,
      command: payload.command ?? command,
      exitCode: Number.isSafeInteger(payload.exitCode) ? payload.exitCode : null,
      signal: payload.signal ?? null,
      timedOut: payload.timedOut === true,
      stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
      stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
      stdoutTruncated: payload.stdoutTruncated === true,
      stderrTruncated: payload.stderrTruncated === true,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
      startedAt: payload.startedAt ?? null,
      finishedAt: payload.finishedAt ?? null,
      target: publicTarget(target, payload.cwd ?? target.path),
    }
  }

  /**
   * 对某个已接入设备发一条**任意协议路由**的签名请求（远端文件系统原语走这里）。
   *
   * `deviceId` 必填且会钉住目标：调用方（路由型 ctx.fs）**已经判定**过这条路径归哪台，
   * 再让 Caller 按路径重猜一次，就可能落到别的机器上去读写文件。
   *
   * @param {{deviceId: string, targetPath: string, route: string, body?: object, timeoutMs?: number}} request 请求。
   * `targetPath` 是**对端的文件路径**，只用来钉住设备与审计；`route` 才是 HTTP 协议路由。
   * 两者必须分开：早先把它们合用一个 `path` 字段，请求就打到了文件路径上（实测 405）。
   * @returns {Promise<object>} `{ json, deviceId, deviceName, targetPath }`。
   * @throws {ExecError} 无接入点 / 未配令牌 / 传输失败。
   */
  async request(request) {
    const target = this.resolveTarget({ device: request.deviceId, path: request.targetPath })
    if (target.local) {
      // 自问自答没有意义：本机的东西应当直接走本机服务，不该绕网格一圈。
      throw new ExecError(400, '本机路径不该走入站 API', CODE.badRequest, { deviceId: target.deviceId })
    }
    const link = target.link
    if (link.tokenId === '' || link.secret === '') {
      throw new ExecError(409, `接入点「${link.label}」还没配好令牌，无法访问`, CODE.unauthenticated, { linkId: link.id })
    }
    if (typeof request.permission?.mode === 'string' && request.permission.mode !== '') this.forwardedWithMode += 1
    else this.forwardedWithoutMode += 1
    const body = JSON.stringify(withPermission({
      protocol: PROTOCOL_VERSION,
      nodeId: this.egress.stateOf(link.id)?.nodeId ?? null,
      ...(request.body ?? {}),
    }, request.permission))
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path: request.route,
      body,
    })
    const result = await requestJson(link.url, {
      path: request.route,
      method: 'POST',
      body,
      headers,
      timeoutMs: Number.isFinite(request.timeoutMs) ? request.timeoutMs : this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
    })
    if (!result.ok) {
      const code = result.json !== null && typeof result.json === 'object' && typeof result.json.code === 'string'
        ? result.json.code
        : CODE.unreachable
      throw new ExecError(result.status ?? 502, `${target.deviceName}：${result.error}`, code, { deviceId: target.deviceId })
    }
    const json = result.json !== null && typeof result.json === 'object' ? result.json : {}
    return { json, deviceId: target.deviceId, deviceName: target.deviceName, targetPath: target.path }
  }

  /**
   * 让**会话所在的那台**改一条会话的权限。
   *
   * 为什么复用 `request()` 而不是新开一条传输：签名、时间窗、设备钉住、错误信封翻译都在
   * 那一个地方，多一条并行实现只会多一处漂移。
   *
   * @param {{deviceId: string, sessionId: string, mode: string, targetPath?: string, timeoutMs?: number}} request 材料。
   * `targetPath` 是那条会话的 cwd（对端文件路径），只用来钉设备与审计 —— 与 `request()` 的约定一致。
   * @returns {Promise<{json: object, deviceId: string, deviceName: string, targetPath: string}>} 回执。
   */
  async sessionMode(request) {
    return this.request({
      deviceId: request.deviceId,
      targetPath: typeof request.targetPath === 'string' ? request.targetPath : '',
      route: API.sessionMode,
      body: { sessionId: request.sessionId, mode: request.mode },
      timeoutMs: request.timeoutMs,
    })
  }

  /**
   * 列目录（本机或远端，同一形状）。
   * @param {{deviceId?: unknown, path: unknown}} request 请求。
   * @returns {Promise<object>} 列表结果。
   * @throws {ExecError} 解析 / 传输 / 远端拒绝。
   */
  async list(request) {
    const target = this.resolveTarget({ path: request.path, device: request.deviceId })
    if (target.local) return { ...this.executor.list(target.path), target: publicTarget(target, target.path) }
    const link = target.link
    const body = JSON.stringify(withPermission({
      protocol: PROTOCOL_VERSION,
      nodeId: this.egress.stateOf(link.id)?.nodeId ?? null,
      path: target.path,
    }, request.permission))
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path: API.list,
      body,
    })
    const result = await requestJson(link.url, {
      path: API.list,
      method: 'POST',
      body,
      headers,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
    })
    if (!result.ok) {
      const code = result.json !== null && typeof result.json === 'object' && typeof result.json.code === 'string'
        ? result.json.code
        : CODE.unreachable
      throw new ExecError(result.status ?? 502, `${target.deviceName}：${result.error}`, code, { deviceId: target.deviceId })
    }
    const payload = result.json !== null && typeof result.json === 'object' ? result.json : {}
    return { ...payload, target: publicTarget(target, payload.path ?? target.path) }
  }

  /**
   * 拉一个接入点的路径账目（远端工作区 + 它自己的附加路径）。
   *
   * 本机**不**把远端账目落盘：账目是「谁的账谁说了算」，本机只在自己这条
   * 工作区的附加路径上做记录。远端账目只用来在 UI 上展示与解析远端主路径。
   * @param {object} link 链接记录。
   * @returns {Promise<object>} `{ ok, workspaces }`。
   */
  async fetchRemotePaths(link) {
    const body = JSON.stringify({
      protocol: PROTOCOL_VERSION,
      nodeId: this.egress.stateOf(link.id)?.nodeId ?? null,
    })
    const headers = buildSignatureHeaders({
      deviceId: this.identity.deviceId,
      tokenId: link.tokenId,
      secret: link.secret,
      method: 'POST',
      path: API.paths,
      body,
    })
    const result = await requestJson(link.url, {
      path: API.paths,
      method: 'POST',
      body,
      headers,
      timeoutMs: this.config.requestTimeoutMs,
      maxBytes: this.config.maxResponseBytes,
    })
    if (!result.ok) return { ok: false, error: result.error, code: result.json?.code ?? null }
    return { ok: true, ...(result.json ?? {}) }
  }

  /**
   * 写一条发起侧审计。`audit` 缺席时静默跳过 —— 审计不可用不该让执行失败。
   * @param {object} entry 审计条目。
   * @returns {void}
   */
  #audit(entry) {
    if (this.audit === null) return
    try {
      this.audit.append(entry)
    } catch (error) {
      this.logger?.warn?.(`dsh-device-mesh: 写发起侧审计失败：${error?.message ?? error}`)
    }
  }

  /** 诊断。 */
  stats() {
    return { remoteRuns: this.remoteRuns, localRuns: this.localRuns, resolveFailures: this.resolveFailures }
  }
}

/**
 * 给调用方看的执行目标（不含 secret / 链接内部字段）。
 * @param {object} target 解析结果。
 * @param {string} cwd 实际工作目录。
 * @returns {object} 公开目标。
 */
export function publicTarget(target, cwd) {
  return {
    deviceId: target.deviceId,
    deviceName: target.deviceName,
    path: cwd,
    local: target.local,
    resolvedBy: target.resolvedBy,
    role: target.role,
    groupId: target.groupId,
    memberId: target.memberId,
    linkId: target.link?.id ?? null,
  }
}
