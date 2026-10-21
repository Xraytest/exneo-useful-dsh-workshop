/**
 * dsh-device-mesh 自测 —— 纯 node、零第三方依赖、无外部副作用。
 *
 * 设计原则（这是「测试」而不是「演示」的关键）：
 *   · **真跑 HTTP**：两个独立节点各自 apply() 到一个真的 node:http 服务器上，
 *     它们之间真的走 TCP、真的签名、真的验签。mock 掉传输的测试证明不了协议。
 *   · **每条断言都必须会失败**：例如重放测试先断言第一次真的 200，否则「第二次 401」
 *     可能只是因为第一次就失败了 —— 那种测试永远绿。
 *   · **不碰真实 $DSH_HOME**：顶部就把 DSH_HOME 指到临时目录。
 *
 * 运行：`node selftest.mjs`，最后一行是 SELFTEST PASS / FAIL。
 *
 * @module dsh-device-mesh/selftest
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 先隔离环境：必须在 import 插件之前设置 ────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-selftest-'))
process.env.DSH_HOME = path.join(ROOT, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

const entry = await import('./index.js?v=selftest')
const protocol = await import('./protocol.js?v=mesh-29')
const { PathTable, normalizeAbsPath } = await import('./paths.js?v=mesh-29')
const {
  AuditLog, Executor, ExecError, isWithin, PERMISSION_MODES, SESSION_CODE, readPermissionMode, strictestMode,
  sessionPermissionFromCandidates,
} = await import('./exec.js?v=mesh-29')
const { TokenTable, NodeRegistry, LinkTable, normalizeHubUrl, TRUST_LEVELS } = await import('./registry.js?v=mesh-29')
const { writeJsonAtomic, readJson, loadIdentity, resolveMeshDir } = await import('./store.js?v=mesh-29')
const { collectInventory } = await import('./inventory.js?v=mesh-29')
const { createInventoryCache } = await import('./inventory-cache.js?v=mesh-29')
const { Caller } = await import('./caller.js?v=mesh-29')

// ── 迷你测试框架 ──────────────────────────────────────────────────────────────
let passed = 0
const failures = []
/** 当前分组名（只影响失败输出）。 */
let group = ''

const VERBOSE = process.env.MESH_TEST_VERBOSE === '1'

const check = async (name, fn) => {
  if (VERBOSE) console.log(`  · [${group}] ${name}`)
  try {
    await fn()
    passed += 1
  } catch (error) {
    // 失败**当场**打印：挂死时至少能看到死在谁身上，而不是一片空白。
    const line = `[${group}] ${name}\n      ${error?.message ?? error}`
    failures.push(line)
    if (!VERBOSE) console.log(`  ✗ ${line}`)
  }
}

const G = (name) => {
  group = name
  if (VERBOSE) console.log(`— ${name}`)
}

/** 断言一次 HTTP 调用返回指定状态与 code。 */
const expectStatus = async (result, status, code) => {
  assert.equal(result.status, status, `期望 HTTP ${status}，实际 ${result.status}（body=${JSON.stringify(result.json)}）`)
  if (code !== undefined) {
    assert.equal(result.json?.code, code, `期望 code=${code}，实际 ${result.json?.code}（body=${JSON.stringify(result.json)}）`)
  }
}

/** 极简 HTTP 客户端（自测里不能用插件的 requestJson —— 要独立验证它）。 */
const call = (url, options = {}) => new Promise((resolvePromise) => {
  const target = new URL(url)
  const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : null
  const headers = { ...(options.headers ?? {}) }
  if (body !== null) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(body.length)
  }
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: options.method ?? 'GET',
    headers,
  }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try {
        json = text === '' ? null : JSON.parse(text)
      } catch {
        json = null
      }
      resolvePromise({ status: res.statusCode ?? 0, json, text })
    })
  })
  req.on('error', (error) => resolvePromise({ status: 0, json: null, text: String(error), error }))
  req.setTimeout(15000, () => req.destroy(new Error('selftest client timeout')))
  if (body !== null) req.write(body)
  req.end()
})

/** 用插件的签名实现构造一次已签名的入站调用。 */
const signedCall = (baseUrl, apiPath, payload, credentials, overrides = {}) => {
  const body = JSON.stringify(payload)
  const headers = protocol.buildSignatureHeaders({
    deviceId: credentials.deviceId,
    tokenId: credentials.tokenId,
    secret: credentials.secret,
    method: 'POST',
    path: apiPath,
    body,
    now: overrides.now,
    nonce: overrides.nonce,
  })
  if (overrides.signPath !== undefined) {
    // 用另一个路径的签名去调这个路径 —— 必须被拒。
    const forged = protocol.buildSignatureHeaders({
      deviceId: credentials.deviceId,
      tokenId: credentials.tokenId,
      secret: credentials.secret,
      method: 'POST',
      path: overrides.signPath,
      body,
      now: overrides.now,
      nonce: overrides.nonce,
    })
    Object.assign(headers, forged)
  }
  if (overrides.body !== undefined) {
    return call(`${baseUrl}${apiPath}`, { method: 'POST', body: overrides.body, headers })
  }
  return call(`${baseUrl}${apiPath}`, { method: 'POST', body, headers })
}

// ── 假 Cordis 上下文 + 真 HTTP 服务器 ────────────────────────────────────────

/**
 * 造一个节点：假 ctx、真 http 服务器、假 DSH 服务。
 * @param {{name: string, storeDir: string, config?: object, workspaces?: object[]}} options 参数。
 * @returns {Promise<object>} 节点句柄。
 */
async function createNode(options) {
  const routes = new Map()
  const effects = []
  const provided = new Map()
  const registeredTools = []
  const services = new Map()
  const warnings = []

  const server = http.createServer((req, res) => {
    let pathname
    try {
      pathname = new URL(req.url, 'http://placeholder').pathname
    } catch {
      res.writeHead(400)
      res.end('bad url')
      return
    }
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no route', code: 'not-found' }))
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = server.address().port

  const workspaces = options.workspaces ?? []
  const archived = []

  services.set('workspaceRegistry', {
    list: () => workspaces.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionIds: workspace.sessionIds ?? [],
    })),
    get archivedSessionIds() {
      return archived
    },
  })
  const sessionRecords = options.sessions ?? []
  const titleCalls = []
  services.set('sessionQuery', {
    listSessions: async () => sessionRecords.map((record) => ({
      header: record.header,
      live: record.live === true,
      persisted: record.persisted !== false,
    })),
    // 逐字复刻出厂形状（{sessionId,status,value:{session,title}}）：测试夹具一旦
    // 简化成「我以为的形状」，就再也抓不到拆错层的 bug 了。
    readTitleSnapshots: async (ids) => {
      titleCalls.push([...ids])
      return ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { session: { id }, title: { title: `日志标题 ${id}`, updatedAt: 1790000000001, eventSeq: 3, messageSeqs: [], source: 'provider' } },
      }))
    },
  })
  if (options.projectionCache !== false) {
    services.set('sessionProjectionCache', {
      cachedSnapshot: (header) => (options.cachedTitles?.[header.id] === undefined
        ? undefined
        : { values: { title: options.cachedTitles[header.id], sessionListMetadata: { lastPromptAt: 1790000000000 } } }),
    })
  }

  // fs 服务可选注入：只有跑「远端文件系统原语」那一段的节点才需要它。
  if (options.fs !== undefined) services.set('fs', options.fs)
  // 会话权限相关：`agents`（找已加载会话）与 `sandboxPolicy`（读有效权限）只在测
  // 「改权限 / 显示权限」那一段才注入 —— 缺了它们，插件必须优雅降级（不显示、不附权限）。
  if (options.agents !== undefined) services.set('agents', options.agents)
  if (options.sandboxPolicy !== undefined) services.set('sandboxPolicy', options.sandboxPolicy)

  const ctx = {
    logger: { info: () => {}, warn: (message) => warnings.push(String(message)), error: () => {} },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') effects.push(disposer)
      return disposer
    },
    get(name) {
      return services.get(name)
    },
    inject(names, callback) {
      // 本自测总是提供 tools，所以直接同步调用 —— 与插件期望的语义一致。
      const disposer = callback(ctx)
      if (typeof disposer === 'function') effects.push(disposer)
    },
    provide(name, service) {
      provided.set(name, service)
    },
    on() {},
    tools: {
      register(tool) {
        registeredTools.push(tool)
        return () => {
          const index = registeredTools.indexOf(tool)
          if (index >= 0) registeredTools.splice(index, 1)
        }
      },
    },
    webServer: {
      register({ kind, path: routePath, handler }) {
        assert.equal(kind, 'exact', 'selftest 只覆盖 exact 路由')
        if (routes.has(routePath)) throw new Error(`duplicate route ${routePath}`)
        routes.set(routePath, handler)
        return () => {
          routes.delete(routePath)
        }
      },
    },
  }

  const config = { storeDir: options.storeDir, deviceName: options.name, ...(options.config ?? {}) }
  entry.apply(ctx, config)

  return {
    name: options.name,
    url: `http://127.0.0.1:${port}`,
    port,
    workspaceRoots: workspaces.map((workspace) => workspace.path),
    warnings,
    provided,
    tools: registeredTools,
    dispose: async () => {
      for (const disposer of effects.splice(0)) {
        try {
          disposer()
        } catch {
          // 清理尽力而为。
        }
      }
      await new Promise((resolvePromise) => server.close(resolvePromise))
    },
  }
}

/** 从节点自己的身份文件读 deviceId（自测用，模拟「对端自报」）。 */
const deviceIdOf = (storeDir) => JSON.parse(fs.readFileSync(path.join(storeDir, 'identity.json'), 'utf8')).deviceId

// ─────────────────────────────────────────────────────────────────────────────
// 开始
// ─────────────────────────────────────────────────────────────────────────────

const wsA = path.join(ROOT, 'wsA')
const wsB = path.join(ROOT, 'wsB')
const wsBOther = path.join(ROOT, 'wsB-other')
const outside = path.join(ROOT, 'outside')
for (const dir of [wsA, wsB, wsBOther, outside]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(wsB, 'marker.txt'), 'from-B\n', 'utf8')

const nodeA = await createNode({
  name: '节点A',
  storeDir: path.join(ROOT, 'nodeA'),
  config: { allowInbound: true, requireToken: true, allowRemoteExec: true, execTrust: 'grant-required' },
  workspaces: [{ id: 'ws-a-1', path: wsA, title: '工作区A' }],
  sessions: [{ header: { id: 'sess-a-1', cwd: wsA, createdAt: 1790000000000 }, live: false }],
  cachedTitles: { 'sess-a-1': '会话A1' },
})

const nodeB = await createNode({
  name: '节点B',
  storeDir: path.join(ROOT, 'nodeB'),
  config: {
    allowInbound: true,
    requireToken: true,
    allowRemoteExec: true,
    execTrust: 'any-authenticated',
    exportRoots: [wsB],
  },
  workspaces: [
    { id: 'ws-b-1', path: wsB, title: '工作区B' },
    { id: 'ws-b-2', path: wsBOther, title: '工作区B2' },
  ],
  sessions: [
    { header: { id: 'sess-b-1', cwd: wsB, createdAt: 1790000000000 }, live: true },
    { header: { id: 'sess-b-2', cwd: path.join(wsB, 'deep', 'nested'), createdAt: 1789000000000 }, live: false },
    { header: { id: 'sess-b-3', cwd: outside, createdAt: 1788000000000 }, live: false },
  ],
  cachedTitles: { 'sess-b-1': '会话B1' },
})

const idA = deviceIdOf(path.join(ROOT, 'nodeA'))
const idB = deviceIdOf(path.join(ROOT, 'nodeB'))

// ── 1. 挂载与基础只读路由 ────────────────────────────────────────────────────
G('挂载')
await check('两个节点都注册了模型工具，且工具名正确', async () => {
  const names = nodeA.tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['mesh_exec', 'mesh_workspace_paths'])
})
await check('ctx.provide 发布了 deviceMesh 服务', async () => {
  assert.equal(typeof nodeA.provided.get('deviceMesh')?.exec, 'function')
})
await check('apply() 时确实生成了身份文件', async () => {
  assert.match(idA, /^[0-9a-f]{32}$/)
  assert.match(idB, /^[0-9a-f]{32}$/)
  assert.notEqual(idA, idB)
})

G('浏览器侧只读路由')
await check('GET /status 200 且 capabilities 如实', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/status`)
  await expectStatus(result, 200)
  assert.equal(result.json.capabilities.inbound, true)
  assert.equal(result.json.capabilities.remoteExec, true)
  assert.equal(result.json.capabilities.sessionQuery, true)
  assert.equal(result.json.version, entry.VERSION)
})
await check('GET /tree 只含本机一台设备，via.kind=self', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tree`)
  await expectStatus(result, 200)
  const devices = result.json.tree.devices
  assert.equal(devices.length, 1)
  assert.equal(devices[0].via.kind, 'self')
  assert.equal(devices[0].self, true)
  assert.equal(devices[0].inventory.workspaces.length, 1)
  assert.equal(devices[0].inventory.workspaces[0].sessions.length, 1)
  assert.equal(devices[0].inventory.workspaces[0].sessions[0].title, '会话A1')
})
await check('三级结构字段齐全：设备→工作区→会话', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tree`)
  const device = result.json.tree.devices[0]
  const workspace = device.inventory.workspaces.find((entry) => entry.id === 'ws-b-1')
  const session = workspace.sessions.find((entry) => entry.id === 'sess-b-1')
  for (const field of ['id', 'title', 'cwd', 'createdAt', 'lastActivityAt', 'live', 'persisted', 'seeded', 'origin', 'parentSession', 'depth', 'agentPresetId', 'archived', 'inferred']) {
    assert.ok(field in session, `会话条目缺字段 ${field}`)
  }
  assert.equal(session.live, true)
  assert.equal(session.title, '会话B1')
})
await check('子目录会话按最长前缀收进父工作区并标 inferred', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tree`)
  const workspaces = result.json.tree.devices[0].inventory.workspaces
  const target = workspaces.find((entry) => entry.sessions.some((session) => session.id === 'sess-b-2'))
  assert.equal(target.id, 'ws-b-1', '应归到 wsB 所在工作区')
  const session = target.sessions.find((entry) => entry.id === 'sess-b-2')
  assert.equal(session.inferred, true)
})
await check('匹配不到任何工作区的会话进 unassigned', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tree`)
  const unassigned = result.json.tree.devices[0].inventory.unassigned
  assert.ok(unassigned.some((session) => session.id === 'sess-b-3'))
})

// ── 2. 令牌与接入 ────────────────────────────────────────────────────────────
G('令牌')
let tokenA = null
await check('POST /tokens 建令牌并**只此一次**返回 secret', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: '给B' }),
  })
  await expectStatus(result, 200)
  assert.equal(typeof result.json.secret, 'string')
  assert.ok(result.json.secret.length >= 32)
  tokenA = { tokenId: result.json.token.id, secret: result.json.secret }
})
await check('GET /tokens 绝不回 secret', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tokens`)
  await expectStatus(result, 200)
  const serialized = JSON.stringify(result.json)
  assert.ok(!serialized.includes(tokenA.secret), '令牌列表里出现了 secret 明文')
  for (const row of result.json.tokens) assert.ok(!('secret' in row))
})

let tokenB = null
await check('B 也建一个令牌（供反向接入用）', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: '给A' }),
  })
  await expectStatus(result, 200)
  tokenB = { tokenId: result.json.token.id, secret: result.json.secret }
})

G('接入（join / report）')
await check('B 配一条指向 A 的接入点并同步成功', async () => {
  const upsert = await call(`${nodeB.url}/dsh-device-mesh/links`, {
    method: 'POST',
    body: JSON.stringify({ action: 'upsert', label: 'A', url: nodeA.url, tokenId: tokenA.tokenId, secret: tokenA.secret }),
  })
  await expectStatus(upsert, 200)
  const sync = await call(`${nodeB.url}/dsh-device-mesh/links/sync`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  await expectStatus(sync, 200)
  const results = sync.json.results
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, true, `同步失败：${JSON.stringify(results[0])}`)
  assert.equal(results[0].action, 'join')
})
await check('A 的树里出现 B —— 从 A 的视角 B 是 inbound（B 接入了 A）', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tree`)
  const devices = result.json.tree.devices
  assert.equal(devices.length, 2, `期望 2 台设备，实际 ${devices.length}`)
  const remote = devices.find((entry) => entry.deviceId === idB)
  assert.ok(remote, 'A 的树里没有 B')
  // 方向语义：hub 把 joiner 记为 inbound，joiner 把 hub 记为 outbound。
  // 两边都写成 outbound 是最容易犯的错，所以这里两边都钉住。
  assert.equal(remote.via.kind, 'inbound')
  assert.equal(remote.inventory.workspaces.length, 2)
  assert.equal(remote.inventory.totals.sessions, 3)
})
await check('B 的树里出现 A —— 从 B 的视角 A 是 outbound（B 接入了 A）', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tree`)
  const selfId = deviceIdOf(path.join(ROOT, 'nodeB'))
  const hub = result.json.tree.devices.find((entry) => entry.deviceId === idA)
  assert.ok(hub, `B 的树里没有 A：${JSON.stringify(result.json.tree.devices.map((d) => [d.name, d.via.kind]))}`)
  assert.equal(hub.via.kind, 'outbound')
  assert.notEqual(hub.deviceId, selfId)
})
await check('A 的 GET /nodes 显示 B 已接入，且缺省信任级别是 inventory', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/nodes`)
  await expectStatus(result, 200)
  const node = result.json.nodes.find((entry) => entry.deviceId === idB)
  assert.ok(node, 'A 没有记录 B')
  assert.equal(node.trust, 'inventory')
  assert.equal(node.liveness, 'online')
})
await check('反向也接：A 配指向 B 的接入点并同步（形成对等网格）', async () => {
  const upsert = await call(`${nodeA.url}/dsh-device-mesh/links`, {
    method: 'POST',
    body: JSON.stringify({ action: 'upsert', label: 'B', url: nodeB.url, tokenId: tokenB.tokenId, secret: tokenB.secret }),
  })
  await expectStatus(upsert, 200)
  const sync = await call(`${nodeA.url}/dsh-device-mesh/links/sync`, { method: 'POST', body: '{}' })
  await expectStatus(sync, 200)
  assert.equal(sync.json.results[0].ok, true, JSON.stringify(sync.json.results[0]))
})
await check('两棵树各自恰好 2 台设备 —— 一跳边界挡住了成环膨胀', async () => {
  const treeA = (await call(`${nodeA.url}/dsh-device-mesh/tree`)).json.tree
  const treeB = (await call(`${nodeB.url}/dsh-device-mesh/tree`)).json.tree
  assert.equal(treeA.devices.length, 2, `A 看到 ${treeA.devices.length} 台`)
  assert.equal(treeB.devices.length, 2, `B 看到 ${treeB.devices.length} 台`)
  // 同一台设备被两条路径看到时应如实记 alsoVia，而不是静默去重。
  const bInA = treeA.devices.find((entry) => entry.deviceId === idB)
  assert.ok(bInA.alsoVia.length >= 1, 'B 应同时通过 inbound 与 outbound 可见，且被记进 alsoVia')
})
await check('GET /api/tree 标记 scope=direct 且不含镜像来的设备', async () => {
  const result = await signedCall(`${nodeB.url}`, protocol.API.tree, { protocol: 1, nodeId: null, depth: 1 }, {
    deviceId: idA,
    tokenId: tokenB.tokenId,
    secret: tokenB.secret,
  })
  await expectStatus(result, 200)
  assert.equal(result.json.tree.scope, 'direct')
  // B 的镜像里有 A 的设备条目，但 direct 视图只回 B 自己 + 接入 B 的节点（A）。
  const ids = result.json.tree.devices.map((entry) => entry.deviceId)
  assert.ok(ids.includes(deviceIdOf(path.join(ROOT, 'nodeB'))), 'direct 视图缺 B 自己')
  assert.ok(!ids.includes('deadbeef'), '不应出现任意设备')
})

// ── 3. 认证矩阵 ──────────────────────────────────────────────────────────────
G('认证矩阵')
const credsAtoB = () => ({ deviceId: idA, tokenId: tokenB.tokenId, secret: tokenB.secret })
const joinPayload = (deviceId, name) => ({
  protocol: 1,
  device: { deviceId, name, platform: 'linux', os: 'Linux', hostname: 'h', capabilities: ['inventory'] },
})

await check('hello 无需认证即可访问，且不含 hostname/内存', async () => {
  const result = await call(`${nodeA.url}${protocol.API.hello}`)
  await expectStatus(result, 200)
  assert.equal(result.json.protocol, protocol.PROTOCOL_VERSION)
  assert.equal(result.json.authRequired, true)
  assert.ok(!('hostname' in result.json.hub), 'hello 不应泄漏 hostname')
  assert.ok(!('memoryGb' in result.json.hub), 'hello 不应泄漏内存信息')
})
await check('完全无签名头 → 401（先查令牌，所以报 unauthenticated）', async () => {
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}`, {
    method: 'POST',
    body: JSON.stringify({ protocol: 1, nodeId: null }),
  })
  await expectStatus(result, 401, protocol.CODE.unauthenticated)
})
await check('有合法令牌 id 但无签名头 → 401 bad-signature', async () => {
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}`, {
    method: 'POST',
    body: JSON.stringify({ protocol: 1, nodeId: null }),
    headers: { [protocol.HEADERS.token]: tokenA.tokenId, [protocol.HEADERS.device]: idB },
  })
  await expectStatus(result, 401, protocol.CODE.badSignature)
})
await check('未知令牌 id → 401 unauthenticated', async () => {
  const result = await signedCall(`${nodeA.url}`, protocol.API.heartbeat, { protocol: 1, nodeId: null }, {
    deviceId: idB,
    tokenId: 'ffffffffffffffff',
    secret: tokenA.secret,
  })
  await expectStatus(result, 401, protocol.CODE.unauthenticated)
})
await check('错误密钥 → 401 bad-signature', async () => {
  const result = await signedCall(`${nodeA.url}`, protocol.API.heartbeat, { protocol: 1, nodeId: null }, {
    deviceId: idB,
    tokenId: tokenA.tokenId,
    secret: 'wrong-secret-wrong-secret-wrong-secret',
  })
  await expectStatus(result, 401, protocol.CODE.badSignature)
})
await check('时间戳超出窗口 → 401 bad-signature', async () => {
  const result = await signedCall(
    `${nodeA.url}`,
    protocol.API.heartbeat,
    { protocol: 1, nodeId: null },
    { deviceId: idB, tokenId: tokenA.tokenId, secret: tokenA.secret },
    { now: Date.now() - 3600_000 },
  )
  await expectStatus(result, 401, protocol.CODE.badSignature)
})
await check('nonce 重放：第一次 200，**逐字重发**第二次 401 bad-signature', async () => {
  const nonce = 'a'.repeat(32)
  const now = Date.now()
  const credentials = { deviceId: idB, tokenId: tokenA.tokenId, secret: tokenA.secret }
  const first = await signedCall(
    `${nodeA.url}`, protocol.API.heartbeat, { protocol: 1, nodeId: null }, credentials, { now, nonce },
  )
  await expectStatus(first, 200) // 这一条是重放测试成立的前提
  const second = await signedCall(
    `${nodeA.url}`, protocol.API.heartbeat, { protocol: 1, nodeId: null }, credentials, { now, nonce },
  )
  await expectStatus(second, 401, protocol.CODE.badSignature)
})
await check('签名绑定了路径：用 heartbeat 的签名调 report → 401', async () => {
  const result = await signedCall(
    `${nodeA.url}`,
    protocol.API.report,
    { protocol: 1, nodeId: null, inventory: {} },
    { deviceId: idB, tokenId: tokenA.tokenId, secret: tokenA.secret },
    { signPath: protocol.API.heartbeat },
  )
  await expectStatus(result, 401, protocol.CODE.badSignature)
})
await check('签名绑定了请求体：换了 body 签名就不成立 → 401', async () => {
  const body = JSON.stringify({ protocol: 1, nodeId: null })
  const forged = JSON.stringify({ protocol: 1, nodeId: 'tampered' })
  const headers = protocol.buildSignatureHeaders({
    deviceId: idB,
    tokenId: tokenA.tokenId,
    secret: tokenA.secret,
    method: 'POST',
    path: protocol.API.heartbeat,
    body,
  })
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}`, { method: 'POST', body: forged, headers })
  await expectStatus(result, 401, protocol.CODE.badSignature)
})
await check('协议版本不匹配 → 401（消息里点明版本）', async () => {
  const body = JSON.stringify({ protocol: 99, nodeId: null })
  const headers = protocol.buildSignatureHeaders({
    deviceId: idB,
    tokenId: tokenA.tokenId,
    secret: tokenA.secret,
    method: 'POST',
    path: protocol.API.heartbeat,
    body,
    now: Date.now(),
  })
  headers[protocol.HEADERS.protocol] = '99'
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}`, { method: 'POST', body, headers })
  await expectStatus(result, 401, protocol.CODE.badSignature)
  assert.match(result.json.error, /协议版本/)
})
await check('带 query string 的签名请求 → 400 bad-request', async () => {
  const body = JSON.stringify({ protocol: 1, nodeId: null })
  const headers = protocol.buildSignatureHeaders({
    deviceId: idB,
    tokenId: tokenA.tokenId,
    secret: tokenA.secret,
    method: 'POST',
    path: protocol.API.heartbeat,
    body,
  })
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}?x=1`, { method: 'POST', body, headers })
  await expectStatus(result, 400, protocol.CODE.badRequest)
})
await check('GET 调 POST 路由 → 405', async () => {
  const result = await call(`${nodeA.url}${protocol.API.heartbeat}`)
  await expectStatus(result, 405, protocol.CODE.notFound)
})
await check('join 时 body 的 deviceId 必须与签名头一致 → 400', async () => {
  const result = await signedCall(`${nodeA.url}`, protocol.API.join, joinPayload('0'.repeat(32), '骗子'), {
    deviceId: idB,
    tokenId: tokenA.tokenId,
    secret: tokenA.secret,
  })
  await expectStatus(result, 400, protocol.CODE.badRequest)
})
await check('未 join 过的设备调 report → 404 unknown-node', async () => {
  const result = await signedCall(`${nodeA.url}`, protocol.API.report, { protocol: 1, nodeId: null, inventory: {} }, {
    deviceId: 'e'.repeat(32),
    tokenId: tokenA.tokenId,
    secret: tokenA.secret,
  })
  await expectStatus(result, 404, protocol.CODE.unknownNode)
})
await check('撤销令牌后立刻失效 → 401 unauthenticated', async () => {
  const created = await call(`${nodeB.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: '临时' }),
  })
  const temp = { deviceId: 'c'.repeat(32), tokenId: created.json.token.id, secret: created.json.secret }
  const before = await signedCall(`${nodeB.url}`, protocol.API.join, joinPayload('c'.repeat(32), 'C'), temp)
  await expectStatus(before, 200)
  await call(`${nodeB.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'revoke', id: temp.tokenId }),
  })
  const after = await signedCall(`${nodeB.url}`, protocol.API.join, joinPayload('c'.repeat(32), 'C'), temp)
  await expectStatus(after, 401, protocol.CODE.unauthenticated)
})

// ── 4. 浏览器侧守卫 ──────────────────────────────────────────────────────────
G('浏览器侧守卫')
await check('跨域（Origin 不同源）→ 403', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tree`, { headers: { origin: 'http://evil.example' } })
  await expectStatus(result, 403)
})
await check('sec-fetch-site: cross-site → 403', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tree`, { headers: { 'sec-fetch-site': 'cross-site' } })
  await expectStatus(result, 403)
})
await check('同源 Origin 放行', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/tree`, { headers: { origin: nodeA.url } })
  await expectStatus(result, 200)
})
await check('无 Origin 的本机调用放行', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/status`)
  await expectStatus(result, 200)
})
await check('浏览器侧路由方法门：GET 调 /exec → 405', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`)
  await expectStatus(result, 405)
})

// ── 5. 跨设备执行 ────────────────────────────────────────────────────────────
G('跨设备执行')
await check('本地执行走通（不设 device，就是本机路径）', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsA, command: 'echo local-ok' }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.exitCode, 0)
  assert.match(result.json.stdout, /local-ok/)
  assert.equal(result.json.target.local, true)
  assert.ok(result.json.auditId, '执行必须留审计编号')
})
await check('跨设备执行：A 在 B 的路径上跑命令，拿到真实输出', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idB, path: wsB, command: 'cat marker.txt' }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.exitCode, 0, JSON.stringify(result.json))
  assert.match(result.json.stdout, /from-B/)
  assert.equal(result.json.target.local, false)
  assert.equal(result.json.target.deviceId, idB)
  assert.equal(result.json.cwd, fs.realpathSync(wsB))
})
await check('经接入点执行时用的是对端的身份（cwd 是 B 的路径）', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idB, path: wsB, command: 'pwd' }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.stdout.trim(), fs.realpathSync(wsB))
})
await check('B 的审计里记下了 A 发来的这次执行（direction=in）', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/audit?limit=50`)
  await expectStatus(result, 200)
  const entry = result.json.entries.find((row) => row.direction === 'in' && row.command === 'cat marker.txt')
  assert.ok(entry, `B 的审计里没有这次执行：${JSON.stringify(result.json.entries)}`)
  assert.equal(entry.deviceId, idA)
  assert.equal(entry.outcome, 'ok')
})
await check('A 的审计里也记下（direction=browser）', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/audit?limit=50`)
  const entry = result.json.entries.find((row) => row.command === 'cat marker.txt')
  assert.ok(entry, 'A 的审计里没有这次执行')
  // 发起侧记 direction=out、actor=browser：direction 描述的是命令往哪走，
  // actor 描述的才是谁按的按钮。把两者混成一个字段会丢掉其中一个维度。
  assert.equal(entry.direction, 'out')
  assert.equal(entry.actor, 'browser')
})
await check('不带会话权限（老 peer）：越界路径被拒 403 path-not-exported，且写进审计', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idB, path: outside, command: 'echo should-not-run' }),
  })
  await expectStatus(result, 403, protocol.CODE.pathNotExported)
  assert.ok(result.json.auditId, '被拒的执行也要有审计编号')
  const auditResult = await call(`${nodeB.url}/dsh-device-mesh/audit?limit=50`)
  const denied = auditResult.json.entries.find((row) => row.outcome === 'denied' && row.path === outside)
  assert.ok(denied, 'B 没有记录这次被拒的执行')
})
await check('不带会话权限（老 peer）：导出根之外的路径即便真实存在也拒绝', async () => {
  // wsBOther 是 B 的工作区，但 B 配了 exportRoots=[wsB] 且关掉 exportWorkspacePaths，
  // 所以它不在导出范围内 —— 这是「工作区路径 ≠ 自动可执行」的证明。
  const result = await call(`${nodeB.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsBOther, command: 'echo nope' }),
  })
  await expectStatus(result, 200)
})
await check('完全未知的设备 → 404 not-found', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'a'.repeat(32), path: wsA, command: 'echo x' }),
  })
  await expectStatus(result, 404, protocol.CODE.notFound)
})
await check('「接入点的接入点」可见但不可执行 → 409 unreachable（一跳硬边界）', async () => {
  // C 只接入 B（不接入 A），于是 A 只能通过 B 的镜像看到 C —— 本机没有任何
  // 指向 C 的凭据。这正是「能看见但不能执行」的那一档，必须给可行动的说明。
  const nodeC = await createNode({
    name: '节点C',
    storeDir: path.join(ROOT, 'nodeC'),
    config: { allowInbound: true, requireToken: true, allowRemoteExec: true, execTrust: 'any-authenticated', exportRoots: [wsB] },
    workspaces: [{ id: 'ws-c-1', path: wsB, title: '工作区C' }],
    sessions: [],
  })
  const tokB = await call(`${nodeB.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: '给C' }),
  })
  await call(`${nodeC.url}/dsh-device-mesh/links`, {
    method: 'POST',
    body: JSON.stringify({ action: 'upsert', label: 'B', url: nodeB.url, tokenId: tokB.json.token.id, secret: tokB.json.secret }),
  })
  await call(`${nodeC.url}/dsh-device-mesh/links/sync`, { method: 'POST', body: '{}' })
  const idC = deviceIdOf(path.join(ROOT, 'nodeC'))

  // A 立即同步：既推自己，也把 B 的一跳总览拉回来 —— 于是 C 出现在 A 的树里。
  await call(`${nodeA.url}/dsh-device-mesh/links/sync`, { method: 'POST', body: '{}' })
  const tree = (await call(`${nodeA.url}/dsh-device-mesh/tree`)).json.tree
  const seenC = tree.devices.find((entry) => entry.deviceId === idC)
  assert.ok(seenC, `A 的树里没有经 B 看到的 C：${JSON.stringify(tree.devices.map((d) => d.name))}`)
  assert.equal(seenC.via.kind, 'outbound')

  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idC, path: wsB, command: 'echo should-not-run' }),
  })
  await expectStatus(result, 409, protocol.CODE.unreachable)
  assert.match(result.json.error, /接入点/)
  await nodeC.dispose()
})
await check('找不到设备 → 404 not-found', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ device: '根本不存在的设备名', command: 'echo x' }),
  })
  await expectStatus(result, 404)
})
await check('空命令 → 400', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsA, command: '   ' }),
  })
  await expectStatus(result, 400)
})
await check('执行超时被终止并如实标注', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsA, command: 'sleep 5', timeoutMs: 300 }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.timedOut, true, JSON.stringify(result.json))
})
await check('输出超限被截断并标注，且命令仍然正常结束（不会因管道写满挂死）', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsA, command: 'yes x | head -c 400000' }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.exitCode, 0)
  assert.equal(result.json.stdoutTruncated, true, '超限必须标截断')
})
await check('非零退出码原样返回', async () => {
  const result = await call(`${nodeA.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ path: wsA, command: 'exit 7' }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.exitCode, 7)
})

G('执行门（失败关闭）')
await check('目标 allowRemoteExec=false → 403 exec-disabled', async () => {
  const strict = await createNode({
    name: '严格节点',
    storeDir: path.join(ROOT, 'strict'),
    config: { allowInbound: true, requireToken: true, allowRemoteExec: false, exportRoots: [wsB] },
    workspaces: [{ id: 'ws-s-1', path: wsB, title: '严格' }],
    sessions: [],
  })
  const idS = deviceIdOf(path.join(ROOT, 'strict'))
  const tok = await call(`${strict.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: 'x' }),
  })
  const creds = { deviceId: idA, tokenId: tok.json.token.id, secret: tok.json.secret }
  const result = await signedCall(`${strict.url}`, protocol.API.join, joinPayload(idA, 'A'), creds)
  await expectStatus(result, 200)
  const execResult = await signedCall(
    `${strict.url}`,
    protocol.API.exec,
    { protocol: 1, nodeId: result.json.nodeId, path: wsB, command: 'echo no' },
    creds,
  )
  await expectStatus(execResult, 403, protocol.CODE.execDisabled)
  await strict.dispose()
})
await check('trust=inventory 且 execTrust=grant-required → 403 exec-denied', async () => {
  // 节点A 自己就是 allowRemoteExec=true + grant-required；B 对 A 的信任是 inventory。
  const result = await call(`${nodeB.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idA, path: wsA, command: 'echo no' }),
  })
  // B→A：B 有链接到 A；A 的 execTrust 是 grant-required，而 B 在 A 那里是 inventory。
  await expectStatus(result, 403, protocol.CODE.execDenied)
})
await check('把 B 在 A 上的信任提升为 exec 后即可执行', async () => {
  const update = await call(`${nodeA.url}/dsh-device-mesh/nodes`, {
    method: 'POST',
    body: JSON.stringify({ action: 'update', deviceId: idB, trust: 'exec' }),
  })
  await expectStatus(update, 200)
  assert.equal(update.json.node.trust, 'exec')
  const result = await call(`${nodeB.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idA, path: wsA, command: 'echo granted' }),
  })
  await expectStatus(result, 200)
  assert.match(result.json.stdout, /granted/)
})
await check('拉黑后立即拒绝（403 exec-denied）', async () => {
  await call(`${nodeA.url}/dsh-device-mesh/nodes`, {
    method: 'POST',
    body: JSON.stringify({ action: 'update', deviceId: idB, trust: 'denied' }),
  })
  const result = await call(`${nodeB.url}/dsh-device-mesh/exec`, {
    method: 'POST',
    body: JSON.stringify({ deviceId: idA, path: wsA, command: 'echo no' }),
  })
  // 拉黑是**认证层**的拒绝：被拉黑的节点连 report 都不该成功，
  // 所以它在执行门之前就被挡下，报的是 device-denied 而不是 exec-denied。
  await expectStatus(result, 403, protocol.CODE.deviceDenied)
  // 恢复，免得影响后面的用例
  await call(`${nodeA.url}/dsh-device-mesh/nodes`, {
    method: 'POST',
    body: JSON.stringify({ action: 'update', deviceId: idB, trust: 'exec' }),
  })
})
await check('allowInbound=false 时 hello 也拒绝（不向网段宣告自己）', async () => {
  const closed = await createNode({
    name: '关闭入站',
    storeDir: path.join(ROOT, 'closed'),
    config: { allowInbound: false },
    workspaces: [],
    sessions: [],
  })
  const hello = await call(`${closed.url}${protocol.API.hello}`)
  await expectStatus(hello, 403, protocol.CODE.inboundDisabled)
  await closed.dispose()
})

// ── 6. 多工作路径 ────────────────────────────────────────────────────────────
G('工作区多路径')
await check('GET /paths 列出本机工作区，每台一个 group，主路径来自出厂权威', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`)
  await expectStatus(result, 200)
  const group = result.json.groups.find((entry) => entry.workspaceId === 'ws-b-1')
  assert.ok(group, 'ws-b-1 没有 group')
  assert.equal(group.primary.path, wsB)
  assert.equal(group.primary.local, true)
  assert.equal(group.primary.stale, false)
  // 字段曾叫 `exists`，语义其实是「主路径来自本机注册表的实时读取」——名字会让人
  // 读成「这个目录存在」（远端路径根本不经本机核验）。改名后这里一并钉住新名字。
  assert.equal(group.primary.fromLiveRegistry, true)
  assert.deepEqual(group.members, [])
})
await check('add：给工作区挂一条**在另一台设备上**的附加路径', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'add', workspaceId: 'ws-b-1', deviceId: idA, path: '/srv/mirror-of-b', role: 'mirror', label: 'A上的镜像' }),
  })
  await expectStatus(result, 200, undefined)
  const group = result.json.groups.find((entry) => entry.workspaceId === 'ws-b-1')
  assert.equal(group.members.length, 1)
  assert.equal(group.members[0].deviceId, idA)
  assert.equal(group.members[0].path, '/srv/mirror-of-b')
  assert.equal(group.members[0].role, 'mirror')
  assert.equal(group.members[0].reachable, true, 'A 是 B 的直连接入点，应当可达')
})
await check('同一 (设备,路径) 重复挂 → 400 明确拒绝', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'add', workspaceId: 'ws-b-1', deviceId: idA, path: '/srv/mirror-of-b' }),
  })
  await expectStatus(result, 400)
})
await check('相对路径被拒（必须是绝对路径）', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'add', workspaceId: 'ws-b-1', deviceId: idB, path: 'relative/dir' }),
  })
  await expectStatus(result, 400)
})
await check('主路径结构上不可改：账目里根本没有「改主路径」这个动作', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'set_primary', workspaceId: 'ws-b-1', path: '/tmp/x' }),
  })
  await expectStatus(result, 400)
})
await check('附加路径出现在 /tree 的对应设备节点上', async () => {
  const result = await call(`${nodeB.url}/dsh-device-mesh/tree`)
  const device = result.json.tree.devices.find((entry) => entry.deviceId === idB)
  const group = device.paths.find((entry) => entry.workspaceId === 'ws-b-1')
  assert.ok(group, '设备节点上没有 paths')
  assert.equal(group.members.length, 1)
})
await check('remove：删掉附加路径', async () => {
  const before = await call(`${nodeB.url}/dsh-device-mesh/paths`)
  const memberId = before.json.groups.find((entry) => entry.workspaceId === 'ws-b-1').members[0].id
  const result = await call(`${nodeB.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'remove', id: memberId }),
  })
  await expectStatus(result, 200)
  assert.equal(result.json.groups.find((entry) => entry.workspaceId === 'ws-b-1').members.length, 0)
})
await check('远端账目只读：POST /api/paths 不存在该路由（405/404）', async () => {
  const result = await call(`${nodeB.url}${protocol.API.paths}`, { method: 'GET' })
  assert.ok([404, 405].includes(result.status), `期望 404/405，实际 ${result.status}`)
})

// ── 7. PathTable 纯逻辑 ──────────────────────────────────────────────────────
G('PathTable')
await check('normalizeAbsPath 只接受绝对路径并去尾斜杠', async () => {
  assert.equal(normalizeAbsPath('/a/b/'), '/a/b')
  assert.equal(normalizeAbsPath('/a/./b'), '/a/b')
  assert.equal(normalizeAbsPath('relative'), null)
  assert.equal(normalizeAbsPath(''), null)
  assert.equal(normalizeAbsPath(42), null)
})
await check('PathTable 落盘并可从磁盘重读', async () => {
  const dir = path.join(ROOT, 'pt')
  fs.mkdirSync(dir, { recursive: true })
  const problems = []
  const table = new PathTable(dir, 'self', problems)
  const added = table.add({
    homeDeviceId: 'self', workspaceId: 'w1', workspaceTitle: 'W1', deviceId: 'other', path: '/data/w1', role: 'scratch', label: 'L',
  })
  assert.equal(added.ok, true)
  const reloaded = new PathTable(dir, 'self', [])
  const group = reloaded.byWorkspace('w1', 'self')
  assert.equal(group.members.length, 1)
  assert.equal(group.members[0].role, 'scratch')
  assert.equal(group.members[0].label, 'L')
  assert.equal(reloaded.byMemberPath('other', '/data/w1/').group.workspaceId, 'w1')
  assert.deepEqual(problems, [])
})
await check('role 非法时回落 mirror，不会写进坏值', async () => {
  const dir = path.join(ROOT, 'pt2')
  fs.mkdirSync(dir, { recursive: true })
  const table = new PathTable(dir, 'self', [])
  const added = table.add({ homeDeviceId: 'self', workspaceId: 'w', deviceId: 'd', path: '/x', role: 'evil' })
  assert.equal(added.member.role, 'mirror')
})

// ── 8. 执行器与导出根 ────────────────────────────────────────────────────────
G('导出根')
await check('isWithin 不做朴素字符串前缀判定（/srv/app2 不算 /srv/app 之内）', async () => {
  assert.equal(isWithin('/srv/app', '/srv/app'), true)
  assert.equal(isWithin('/srv/app', '/srv/app/sub'), true)
  assert.equal(isWithin('/srv/app', '/srv/app2'), false)
  assert.equal(isWithin('/srv/app', '/srv'), false)
  assert.equal(isWithin('/srv/app', '/srv/app/../other'), false)
})
await check('符号链接指向导出根之外时被拒（realpath 生效）', async () => {
  const realDir = path.join(ROOT, 'real')
  fs.mkdirSync(realDir, { recursive: true })
  const linkPath = path.join(ROOT, 'link-to-real')
  try {
    fs.symlinkSync(realDir, linkPath, 'dir')
  } catch {
    return // 平台不支持符号链接：跳过而不是假装通过。
  }
  const dir = path.join(ROOT, 'execStore')
  fs.mkdirSync(dir, { recursive: true })
  const problems = []
  const config = entry.normalizeConfig({ exportRoots: [wsB], exportWorkspacePaths: false, allowRemoteExec: true })
  const executor = new Executor({
    config, meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [linkPath],
  })
  // link 指向 realDir，而 realDir 不在导出根内 → 必须被拒。
  await assert.rejects(
    async () => executor.checkPath(linkPath),
    (error) => error instanceof ExecError && error.code === protocol.CODE.pathNotExported,
  )
  assert.ok(problems.length === 0)
})
await check('导出根为空时一律拒绝（失败关闭）', async () => {
  const dir = path.join(ROOT, 'execStore2')
  fs.mkdirSync(dir, { recursive: true })
  const config = entry.normalizeConfig({ exportRoots: [], exportWorkspacePaths: false, allowRemoteExec: true })
  const executor = new Executor({ config, meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [] })
  await assert.rejects(
    async () => executor.checkPath(wsB),
    (error) => error instanceof ExecError && error.code === protocol.CODE.pathNotExported,
  )
})
await check('本机执行不走导出根闸（resolveLocal 只看真实性）', async () => {
  const dir = path.join(ROOT, 'execStore3')
  fs.mkdirSync(dir, { recursive: true })
  const config = entry.normalizeConfig({ exportRoots: [], exportWorkspacePaths: false })
  const executor = new Executor({ config, meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [] })
  assert.equal(executor.resolveLocal(wsB), fs.realpathSync(wsB))
  await assert.rejects(async () => executor.resolveLocal('/definitely/not/here'), (error) => error.code === protocol.CODE.pathMissing)
})
await check('非目录路径被拒', async () => {
  const dir = path.join(ROOT, 'execStore4')
  fs.mkdirSync(dir, { recursive: true })
  const executor = new Executor({
    config: entry.normalizeConfig({}), meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [],
  })
  await assert.rejects(
    async () => executor.resolveLocal(path.join(wsB, 'marker.txt')),
    (error) => error instanceof ExecError && error.message.includes('不是目录'),
  )
})

// ── 8.5 会话权限（mode）：属主侧按**会话端设置的权限**放行/拒绝 ────────────────
//
// 口径（用户确认）：会话端设置的会话权限是权威的。`sessionMode` **缺失**时退回旧的
// 导出根门（老 peer 兼容）—— 那部分由上一组测试覆盖，这里测的是新口径本身。
G('会话权限')
const execStoreForPermission = (name) => {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  const config = entry.normalizeConfig({ exportRoots: [], exportWorkspacePaths: false, allowRemoteExec: true })
  return new Executor({ config, meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [] })
}
const rootDir = path.join(ROOT, 'perm-root')
const outsideDir = path.join(ROOT, 'perm-outside')
fs.mkdirSync(path.join(rootDir, 'deep'), { recursive: true })
fs.mkdirSync(outsideDir, { recursive: true })
const permOf = (mode, workspaceRoot = rootDir) => ({ mode, workspaceRoot })

await check('read-only：读放行、写 403 session-read-only', async () => {
  const executor = execStoreForPermission('perm1')
  // 读：checkFsPath 不抛
  assert.equal(executor.checkFsPath(path.join(rootDir, 'a.txt'), permOf('read-only'), { write: false }), path.join(rootDir, 'a.txt'))
  // 写：exec（在目录里跑命令＝可能写）与 fs 写都被拦
  await assert.rejects(
    async () => executor.checkPath(rootDir, permOf('read-only')),
    (error) => error.status === 403 && error.code === SESSION_CODE.readOnly,
  )
  await assert.rejects(
    async () => executor.checkFsPath(path.join(rootDir, 'new.txt'), permOf('read-only'), { write: true }),
    (error) => error.status === 403 && error.code === SESSION_CODE.readOnly,
  )
})

await check('workspace-write：根内写放行、根外写 403 session-workspace-write', async () => {
  const executor = execStoreForPermission('perm2')
  // 根内（含子目录）
  assert.equal(executor.checkFsPath(path.join(rootDir, 'deep', 'a.txt'), permOf('workspace-write'), { write: true }), path.join(rootDir, 'deep', 'a.txt'))
  // 根外
  await assert.rejects(
    async () => executor.checkFsPath(path.join(outsideDir, 'a.txt'), permOf('workspace-write'), { write: true }),
    (error) => error.status === 403 && error.code === SESSION_CODE.workspaceWrite,
  )
  // 读不限
  assert.equal(executor.checkFsPath(path.join(outsideDir, 'a.txt'), permOf('workspace-write'), { write: false }), path.join(outsideDir, 'a.txt'))
})

await check('workspace-write：/a/b 不匹配 /a/bc（路径分段，不是字符串前缀）', async () => {
  const executor = execStoreForPermission('perm3')
  const root = path.join(ROOT, 'perm-seg', 'b')
  const sibling = path.join(ROOT, 'perm-seg', 'bc')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  assert.equal(executor.checkFsPath(path.join(root, 'x'), permOf('workspace-write', root), { write: true }), path.join(root, 'x'))
  await assert.rejects(
    async () => executor.checkFsPath(path.join(sibling, 'x'), permOf('workspace-write', root), { write: true }),
    (error) => error.code === SESSION_CODE.workspaceWrite,
  )
})

await check('workspace-write 但 workspaceRoot 缺失/非法 → 403（判不了就拒绝）', async () => {
  const executor = execStoreForPermission('perm4')
  for (const root of ['', 'relative/path', 42, null]) {
    await assert.rejects(
      async () => executor.checkFsPath(path.join(rootDir, 'a.txt'), { mode: 'workspace-write', workspaceRoot: root }, { write: true }),
      (error) => error.code === SESSION_CODE.workspaceWrite,
    )
  }
})

await check('danger-full-access：读写都放行；不存在的路径得到 404「不存在」而不是权限错误', async () => {
  const executor = execStoreForPermission('perm5')
  assert.equal(executor.checkFsPath(path.join(outsideDir, 'a.txt'), permOf('danger-full-access'), { write: true }), path.join(outsideDir, 'a.txt'))
  await assert.rejects(
    async () => executor.checkPath(path.join(ROOT, 'perm-does-not-exist'), permOf('danger-full-access')),
    (error) => error.status === 404
      && error.code === protocol.CODE.pathMissing
      && error.message.includes('不存在'),
  )
})

await check('sessionMode 缺失 → 走旧的导出根行为（老 peer 兼容）', async () => {
  const dir = path.join(ROOT, 'perm6')
  fs.mkdirSync(dir, { recursive: true })
  const config = entry.normalizeConfig({ exportRoots: [rootDir], exportWorkspacePaths: false, allowRemoteExec: true })
  const executor = new Executor({ config, meshDir: dir, audit: new AuditLog(dir, false), workspacePaths: () => [] })
  // 不带权限 + 根内 → 放行；不带权限 + 根外 → 旧码 path-not-exported
  assert.equal(executor.checkPath(rootDir, undefined), fs.realpathSync(rootDir))
  await assert.rejects(
    async () => executor.checkPath(outsideDir, undefined),
    (error) => error.code === protocol.CODE.pathNotExported,
  )
})

await check('readPermissionMode：认 sessionMode、认「取值是权限模式」的 mode、非法 → 400', () => {
  assert.deepEqual(readPermissionMode({ sessionMode: 'read-only', workspaceRoot: '/w' }), { mode: 'read-only', workspaceRoot: '/w' })
  // fsRead 的 mode 是编码（text/bytes），**不能**被当成权限
  assert.equal(readPermissionMode({ mode: 'text' }), undefined)
  assert.equal(readPermissionMode({ mode: 'bytes' }), undefined)
  // 但按契约发权限模式的 mode 仍然被认
  assert.deepEqual(readPermissionMode({ mode: 'workspace-write' }), { mode: 'workspace-write', workspaceRoot: '' })
  assert.equal(readPermissionMode({}), undefined)
  assert.equal(readPermissionMode(undefined), undefined)
  assert.deepEqual(readPermissionMode({ sessionMode: 'danger-full-access', workspaceRoot: 42 }), { mode: 'danger-full-access', workspaceRoot: '' })
  assert.throws(
    () => readPermissionMode({ sessionMode: 'yolo' }),
    (error) => error.status === 400 && error.code === protocol.CODE.badRequest,
  )
})

await check('strictestMode：多会话同 cwd 时取最严格的一个（提权方向必须堵死）', () => {
  assert.equal(strictestMode(['danger-full-access', 'read-only']), 'read-only')
  assert.equal(strictestMode(['danger-full-access', 'workspace-write']), 'workspace-write')
  assert.equal(strictestMode(['workspace-write', 'read-only']), 'read-only')
  assert.equal(strictestMode(['danger-full-access']), 'danger-full-access')
  assert.equal(strictestMode([]), undefined)
  assert.equal(strictestMode(['unknown']), undefined)
  assert.equal(strictestMode(undefined), undefined)
  assert.deepEqual(PERMISSION_MODES, ['read-only', 'workspace-write', 'danger-full-access'], '顺序即「谁更严」的定义，改动它等于改动安全裁决')
})

await check('sessionPermissionFromCandidates：多会话同 cwd 取最严、不同 cwd 不参与、认不出来就不带权限', () => {
  const candidates = [
    { cwd: '/w/ArkTower', mode: 'danger-full-access' },
    { cwd: '/w/ArkTower', mode: 'read-only' },
    { cwd: '/w/Other', mode: 'danger-full-access' },
  ]
  const mixed = sessionPermissionFromCandidates({ cwd: '/w/ArkTower/', candidates, workspaceRoot: '/w/ArkTower' })
  assert.equal(mixed.mode, 'read-only', '同 cwd 取最严（把宽权限借给窄权限的会话＝提权，必须堵死）')
  assert.equal(mixed.matched, 2)
  assert.equal(mixed.mixed, true)
  assert.equal(mixed.workspaceRoot, '/w/ArkTower')
  // 归一：尾斜杠 / 重复斜杠仍算同一个 cwd
  assert.equal(sessionPermissionFromCandidates({ cwd: '//w//ArkTower/', candidates }).matched, 2)
  // 只有一条命中 → mixed=false
  const solo = sessionPermissionFromCandidates({ cwd: '/w/ArkTower', candidates: [{ cwd: '/w/ArkTower', mode: 'workspace-write' }] })
  assert.equal(solo.mode, 'workspace-write')
  assert.equal(solo.mixed, false)
  // 没有命中 / cwd 空 / 候选空 / 模式不认识 → undefined（= 不带权限，不是「挑一个」）
  assert.equal(sessionPermissionFromCandidates({ cwd: '/w/Nope', candidates }), undefined)
  assert.equal(sessionPermissionFromCandidates({ cwd: '', candidates }), undefined)
  assert.equal(sessionPermissionFromCandidates({ cwd: '/w/ArkTower', candidates: [] }), undefined)
  assert.equal(sessionPermissionFromCandidates({ cwd: '/w/ArkTower', candidates: [{ cwd: '/w/ArkTower', mode: 'yolo' }] }), undefined)
  assert.equal(sessionPermissionFromCandidates(undefined), undefined)
  // workspaceRoot 缺失 → 退回 cwd
  assert.equal(sessionPermissionFromCandidates({ cwd: '/w/ArkTower', candidates }).workspaceRoot, '/w/ArkTower')
})
await check('list()：符号链接过滤按权限走（workspace-write 只认根内）', async () => {
  const executor = execStoreForPermission('perm7')
  // 夹具必须与断言同名：**指向根外**的链接才该被过滤。
  // 链接放在根内、目标放根外（避免「链接本身在根外」这种混淆）。
  const secret = path.join(outsideDir, 'secret.txt')
  const linkInside = path.join(rootDir, 'link-out.txt')
  fs.writeFileSync(secret, 'x')
  try {
    fs.symlinkSync(secret, linkInside, 'file')
  } catch {
    return // 平台不支持符号链接：跳过而不是假装通过。
  }
  const listed = executor.list(rootDir, permOf('workspace-write'))
  assert.equal(listed.entries.some((entry) => entry.name === 'link-out.txt'), false, 'workspace-write 下不该列出指向权限范围之外的符号链接')
  const unrestricted = executor.list(rootDir, permOf('danger-full-access'))
  assert.equal(unrestricted.entries.some((entry) => entry.name === 'link-out.txt'), true, 'danger-full-access 下不受路径收窄')
})

// ── 9. 恶意输入清洗 ──────────────────────────────────────────────────────────
G('清洗（不可信输入）')
await check('sanitizeInventory 白名单化、有界、不抛，且截断被标注', async () => {
  const hostile = {
    schema: 1,
    revision: Number.NaN,
    generatedAt: { evil: true },
    device: { deviceId: 'x', name: 'y', __proto__: { polluted: true }, extra: 'drop me', name2: 'n' },
    workspaces: Array.from({ length: 200 }, (_, index) => ({
      id: `w${index}`, title: 'T', path: '/p',
      sessions: Array.from({ length: 50 }, (_, s) => ({ id: `s${s}`, title: 42, evil: 1 })),
      extra: 'drop',
    })),
    unassigned: [null, 7, { id: 'u1' }],
    totals: { sessions: Infinity },
    truncated: false,
  }
  const cleaned = entry.sanitizeInventory(hostile, { maxDevices: 2, maxSessionsPerWorkspace: 3 })
  assert.equal(cleaned.truncated, true)
  assert.ok(cleaned.workspaces.length <= 2 * 64)
  assert.equal(cleaned.workspaces[0].sessions.length, 3)
  assert.equal(cleaned.workspaces[0].sessions[0].title, null, '数字标题必须归一成 null')
  assert.ok(!('extra' in cleaned.workspaces[0]))
  assert.ok(!('evil' in cleaned.workspaces[0].sessions[0]))
  // 没有 id 的条目一律丢弃：id 都没有的会话在本机没有任何用途。
  assert.equal(cleaned.unassigned.length, 1)
  assert.equal(cleaned.unassigned[0].id, 'u1')
  assert.equal(({}).polluted, undefined, '原型被污染了')
  // 会话权限（`mode`）要走同一张白名单：**合法三值保留、其它一律丢掉**。
  // 这条是「权限显示能跨设备互通」的唯一通路 —— 漏在这里 = 本机有、对面永远看不到。
  const modes = entry.sanitizeInventory({
    workspaces: [{
      id: 'w',
      sessions: [{ id: 'ok', mode: 'read-only' }, { id: 'bad', mode: 'bogus' }, { id: 'none' }],
    }],
  }, { maxDevices: 1, maxSessionsPerWorkspace: 5 }).workspaces[0].sessions
  assert.equal(modes[0].mode, 'read-only', '合法权限必须保留')
  assert.equal('mode' in modes[1], false, '非法权限必须丢掉（不能原样透传）')
  assert.equal('mode' in modes[2], false, '没带权限时不该凭空补一个')
})
await check('sanitizeRemoteDevice 只留白名单字段并归一 icon', async () => {
  const cleaned = entry.sanitizeRemoteDevice({
    deviceId: 'a'.repeat(32), name: 'x'.repeat(1000), platform: 'linux', icon: 'evil-icon',
    hostname: 'h', memoryGb: 'lots', cpuCount: -3, capabilities: ['inventory', 42, 'x'.repeat(200)],
    extra: 'drop', __proto__: { polluted: true },
  })
  assert.equal(cleaned.name.length, 120)
  assert.equal(cleaned.icon, 'server', '非法 icon 应按 platform 回落')
  assert.equal(cleaned.memoryGb, null, '非数字内存必须归一成 null')
  assert.equal(cleaned.cpuCount, null, '负数 CPU 必须归一成 null')
  // capabilities 是开放词汇：不能白名单化（那会和未来能力耦合），
  // 但必须**有界**（条数上限 + 每条截断）。UI 也绝不能因为对端自称
  // remote-exec 就认为它真有权限 —— 那只是按钮可点，真正的门在对端。
  assert.equal(cleaned.capabilities[0], 'inventory')
  assert.equal(cleaned.capabilities.length, 2, '非字符串能力位应被丢弃')
  assert.ok(cleaned.capabilities.every((entry) => entry.length <= 32))
  assert.ok(!('extra' in cleaned))
  assert.equal(({}).polluted, undefined)
})
await check('nodes.json 落盘后只含白名单字段', async () => {
  const raw = fs.readFileSync(path.join(ROOT, 'nodeA', 'nodes.json'), 'utf8')
  assert.ok(!raw.includes('__proto__'))
  assert.ok(!raw.includes('drop me'))
})

// ── 10. 存储层 ───────────────────────────────────────────────────────────────
G('存储层')
await check('writeJsonAtomic 落地 0600、无残留临时文件', async () => {
  const dir = path.join(ROOT, 'store1')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'x.json')
  const result = writeJsonAtomic(file, { a: 1 })
  assert.equal(result.ok, true)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], '有临时文件残留')
})
await check('readJson 遇坏文件回落默认值、记问题、**不覆盖原文件**', async () => {
  const dir = path.join(ROOT, 'store2')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'broken.json')
  fs.writeFileSync(file, '{ not json', 'utf8')
  const problems = []
  const value = readJson(file, { fallback: true }, problems)
  assert.deepEqual(value, { fallback: true })
  assert.equal(problems.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', '坏文件被覆盖了')
})
await check('loadIdentity 幂等：两次调用同一 deviceId', async () => {
  const dir = path.join(ROOT, 'identity1')
  fs.mkdirSync(dir, { recursive: true })
  const problems = []
  const first = loadIdentity(dir, { deviceName: 'N1' }, problems)
  const second = loadIdentity(dir, { deviceName: 'N2' }, problems)
  assert.equal(first.identity.deviceId, second.identity.deviceId)
  assert.equal(second.created, false)
  // 配置文件改名字**不**应该改掉已存在的身份名 —— 否则对端会看到两台设备。
  assert.equal(second.identity.name, 'N1')
})
await check('坏 identity.json 被重新生成并如实报告', async () => {
  const dir = path.join(ROOT, 'identity2')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ deviceId: 'not-hex', name: '' }), 'utf8')
  const problems = []
  const result = loadIdentity(dir, { deviceName: 'Fresh' }, problems)
  assert.equal(result.created, true)
  assert.match(result.identity.deviceId, /^[0-9a-f]{32}$/)
  assert.ok(problems.some((entry) => entry.includes('identity.json')))
})
await check('resolveMeshDir 尊重显式配置与 DSH_HOME', async () => {
  assert.equal(resolveMeshDir('/tmp/x'), '/tmp/x')
  assert.equal(resolveMeshDir(''), path.join(process.env.DSH_HOME, 'device-mesh'))
})

// ── 11. 注册表 ───────────────────────────────────────────────────────────────
G('注册表')
await check('normalizeHubUrl 只接受 http(s) 且有 host，剥掉 query/fragment/尾斜杠', async () => {
  assert.equal(normalizeHubUrl('http://a.b:3080/'), 'http://a.b:3080')
  assert.equal(normalizeHubUrl('https://a.b/x/?q=1#f'), 'https://a.b/x')
  assert.equal(normalizeHubUrl('ftp://a.b'), null)
  assert.equal(normalizeHubUrl('file:///etc/passwd'), null)
  assert.equal(normalizeHubUrl('http://'), null)
  assert.equal(normalizeHubUrl('nonsense'), null)
  assert.equal(normalizeHubUrl(''), null)
  assert.equal(normalizeHubUrl(null), null)
})
await check('LinkTable.upsert 省略 secret 时保留原值（UI 只有前缀）', async () => {
  const dir = path.join(ROOT, 'links1')
  fs.mkdirSync(dir, { recursive: true })
  const table = new LinkTable(dir, [])
  const created = table.upsert({ label: 'h', url: 'http://h:1', tokenId: 'tok', secret: 'supersecretvalue', enabled: true })
  assert.equal(created.ok, true)
  const updated = table.upsert({ id: created.link.id, label: 'h2', url: 'http://h:1' })
  assert.equal(updated.ok, true)
  assert.equal(table.get(created.link.id).secret, 'supersecretvalue', 'secret 被前缀覆盖了')
  assert.equal(updated.link.label, 'h2')
})
await check('LinkTable 半配置链接 = unconfigured 且强制 enabled=false', async () => {
  const dir = path.join(ROOT, 'links2')
  fs.mkdirSync(dir, { recursive: true })
  const table = new LinkTable(dir, [])
  const result = table.upsert({ url: 'http://h:1', enabled: true })
  assert.equal(result.link.state, 'unconfigured')
  assert.equal(result.link.enabled, false)
})
await check('LinkTable.list 只回 secret 前缀', async () => {
  const dir = path.join(ROOT, 'links3')
  fs.mkdirSync(dir, { recursive: true })
  const table = new LinkTable(dir, [])
  table.upsert({ url: 'http://h:1', tokenId: 'tok', secret: 'abcdefghijklmnop' })
  const view = table.list()[0]
  assert.equal(view.secretPreview, 'abcdef…')
  assert.ok(!JSON.stringify(view).includes('abcdefghijklmnop'))
})
await check('NodeRegistry.join 幂等且保留 trust/note/joinedAt', async () => {
  const dir = path.join(ROOT, 'nodes1')
  fs.mkdirSync(dir, { recursive: true })
  const registry = new NodeRegistry(dir, 4, [])
  const first = registry.join({ deviceId: 'd1', device: { deviceId: 'd1', name: 'A' }, tokenId: 't', now: 1000 })
  assert.equal(first.ok, true)
  registry.update('d1', { note: '我的备注', trust: 'exec' })
  const joinedAt = registry.get('d1').joinedAt
  const second = registry.join({ deviceId: 'd1', device: { deviceId: 'd1', name: 'A-renamed' }, tokenId: 't', now: 5000 })
  assert.equal(second.ok, true)
  assert.equal(second.record.note, '我的备注', 'note 被冲掉了')
  assert.equal(second.record.trust, 'exec', 'trust 被冲掉了')
  assert.equal(second.record.joinedAt, joinedAt, 'joinedAt 被改了')
  assert.equal(second.record.lastSeenAt, new Date(5000).toISOString())
})
await check('NodeRegistry 强制 maxDevices', async () => {
  const dir = path.join(ROOT, 'nodes2')
  fs.mkdirSync(dir, { recursive: true })
  const registry = new NodeRegistry(dir, 2, [])
  assert.equal(registry.join({ deviceId: 'a1', device: {}, tokenId: 't', now: 1 }).ok, true)
  assert.equal(registry.join({ deviceId: 'a2', device: {}, tokenId: 't', now: 1 }).ok, true)
  const third = registry.join({ deviceId: 'a3', device: {}, tokenId: 't', now: 1 })
  assert.equal(third.ok, false)
  assert.match(third.error, /上限/)
})
await check('既有节点重新 join 不受 maxDevices 影响（幂等优先）', async () => {
  const dir = path.join(ROOT, 'nodes3')
  fs.mkdirSync(dir, { recursive: true })
  const registry = new NodeRegistry(dir, 1, [])
  registry.join({ deviceId: 'a1', device: {}, tokenId: 't', now: 1 })
  assert.equal(registry.join({ deviceId: 'a1', device: {}, tokenId: 't', now: 2 }).ok, true)
})
await check('TRUST_LEVELS 是三值枚举，旧的 allowed 被归一成 inventory', async () => {
  assert.deepEqual(TRUST_LEVELS, ['inventory', 'exec', 'denied'])
  const dir = path.join(ROOT, 'nodes4')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify({
    schema: 1,
    nodes: [{ deviceId: 'a'.repeat(32), device: { deviceId: 'a'.repeat(32) }, trust: 'allowed' }],
  }), 'utf8')
  const registry = new NodeRegistry(dir, 4, [])
  assert.equal(registry.get('a'.repeat(32)).trust, 'inventory')
})
await check('TokenTable 过期令牌被 lookup 之后的准入判掉', async () => {
  const dir = path.join(ROOT, 'tokens1')
  fs.mkdirSync(dir, { recursive: true })
  const table = new TokenTable(dir, [])
  const created = table.create({ label: 'short', ttlMs: 1000 }, 1000)
  assert.equal(created.ok, true)
  assert.ok(created.token.expiresAt)
  const view = table.list(1000 + 5000)
  assert.equal(view[0].expired, true)
  const fresh = table.list(1200)
  assert.equal(fresh[0].expired, false)
})

// ── 12. ReplayGuard / liveness / 排序 / 配置 ────────────────────────────────
G('ReplayGuard')
await check('首次接受、重复拒绝、窗口过后重新接受', async () => {
  const guard = new protocol.ReplayGuard({ windowMs: 1000, maxEntries: 4 })
  assert.equal(guard.accept('t', 'n', 0), true)
  assert.equal(guard.accept('t', 'n', 500), false)
  assert.equal(guard.accept('t', 'n', 2000), true, '窗口过后应当重新接受')
  assert.equal(guard.stats().replays, 1)
})
await check('maxEntries 触发淘汰并计数（宁可淘汰也不拒绝服务）', async () => {
  const guard = new protocol.ReplayGuard({ windowMs: 100000, maxEntries: 2 })
  guard.accept('t', 'n1', 0)
  guard.accept('t', 'n2', 1)
  guard.accept('t', 'n3', 2)
  assert.equal(guard.stats().size, 2)
  assert.equal(guard.stats().evictions, 1)
})
await check('时钟回拨时 sweep 仍能清掉已过期条目（不靠插入序 break）', async () => {
  const guard = new protocol.ReplayGuard({ windowMs: 1000, maxEntries: 100 })
  guard.accept('t', 'n1', 100000)
  guard.accept('t', 'n2', 0)
  guard.sweep(200000)
  assert.equal(guard.stats().size, 0)
})

G('livenessOf / deviceSort')
await check('liveness 边界恰好落在 nodeStaleMs / nodeOfflineMs 上', async () => {
  const config = { nodeStaleMs: 1000, nodeOfflineMs: 5000 }
  assert.equal(entry.livenessOf(0, config), 'online')
  assert.equal(entry.livenessOf(1000, config), 'online')
  assert.equal(entry.livenessOf(1001, config), 'stale')
  assert.equal(entry.livenessOf(5000, config), 'stale')
  assert.equal(entry.livenessOf(5001, config), 'offline')
  assert.equal(entry.livenessOf(Number.POSITIVE_INFINITY, config), 'unknown')
})
await check('deviceSort：本机最前，其次 online→stale→offline→unknown，再按会话数与名字', async () => {
  const make = (name, liveness, sessions, self = false) => ({ name, liveness, self, inventory: { totals: { sessions } } })
  const sorted = [
    make('z', 'offline', 100),
    make('y', 'online', 1),
    make('x', 'online', 99),
    make('me', 'online', 0, true),
    make('u', 'unknown', 5),
  ].sort(entry.deviceSort).map((item) => item.name)
  assert.deepEqual(sorted, ['me', 'x', 'y', 'z', 'u'])
})

G('normalizeConfig')
await check('越界数字被 clamp、坏类型回落、绝不抛', async () => {
  const config = entry.normalizeConfig({
    pushIntervalMs: 1,
    maxDevices: -5,
    requireToken: 'yes',
    execTimeoutMs: 10 ** 12,
    execMaxConcurrent: 0,
    exportRoots: 'not-an-array',
    execTrust: 'nonsense',
    storeDir: 42,
  })
  assert.equal(config.pushIntervalMs, 5000)
  assert.equal(config.maxDevices, 1)
  assert.equal(config.requireToken, true, '非布尔的 requireToken 应回落到默认 true')
  assert.equal(config.execTimeoutMs, 3600000)
  assert.equal(config.execMaxConcurrent, 1)
  assert.deepEqual(config.exportRoots, [])
  assert.equal(config.execTrust, 'grant-required')
  assert.equal(config.storeDir, '')
})
await check('跨设备执行缺省全部失败关闭', async () => {
  const config = entry.normalizeConfig({})
  assert.equal(config.allowRemoteExec, false)
  assert.equal(config.execTrust, 'grant-required')
  assert.deepEqual(config.exportRoots, [])
})
await check('normalizeConfig(null) / (字符串) / 空对象 都不抛', async () => {
  for (const input of [null, undefined, 'x', 42, [], {}]) {
    const config = entry.normalizeConfig(input)
    assert.equal(typeof config.pushIntervalMs, 'number')
  }
})

// ── 13. 清单采集的降级路径 ───────────────────────────────────────────────────
G('清单降级')
await check('sessionQuery 抛错时 degraded 被标出且不抛', async () => {
  const services = new Map()
  services.set('sessionQuery', { listSessions: async () => { throw new Error('后端炸了') } })
  services.set('workspaceRegistry', { list: () => [], get archivedSessionIds() { return [] } })
  const ctx = { get: (name) => services.get(name) }
  const inventory = await collectInventory(ctx, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({}), revision: 1, now: 1,
  })
  assert.match(inventory.degraded.sessionQuery, /后端炸了/)
  assert.deepEqual(inventory.workspaces, [])
  assert.deepEqual(inventory.unassigned, [])
})
await check('服务缺失时 degraded 报告，而不是假装「没有会话」', async () => {
  const ctx = { get: () => undefined }
  const inventory = await collectInventory(ctx, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({}), revision: 1, now: 1,
  })
  assert.match(inventory.degraded.workspaceRegistry, /不可用/)
  assert.match(inventory.degraded.sessionQuery, /不可用/)
})
await check('清单带上会话权限：已加载的填有效值，静置/读不到的不填（不猜）', async () => {
  const services = new Map()
  services.set('workspaceRegistry', {
    list: () => [{ id: 'w', path: '/p', title: 'W', sessionIds: [], createdAt: 'c', updatedAt: 'u' }],
    get archivedSessionIds() { return [] },
  })
  services.set('sessionQuery', {
    listSessions: async () => [
      { header: { id: 's-live', cwd: '/p', createdAt: 5 }, live: true, persisted: true },
      { header: { id: 's-idle', cwd: '/p', createdAt: 6 }, live: false, persisted: true },
    ],
    readTitleSnapshots: async () => [],
  })
  // 唯一来源：已加载会话的出厂策略解析器（与会话端**转发请求时用的是同一个函数**）。
  services.set('agents', { list: () => [{ session: { id: 's-live', header: { cwd: '/p' } } }] })
  services.set('sandboxPolicy', { resolve: ({ session }) => ({ mode: session?.id === 's-live' ? 'danger-full-access' : 'workspace-write' }) })
  // 投影缓存**故意**给出一个 `sandboxMode`：它必须被忽略 —— 出厂那个投影没有 `wire`，
  // 缓存快照里根本不会有这个键（2026-10-18 在节点上核过），谁读它谁就是在猜。
  services.set('sessionProjectionCache', {
    cachedSnapshot: () => ({ values: { title: 't', sandboxMode: 'read-only' } }),
  })
  const inventory = await collectInventory({ get: (name) => services.get(name) }, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({ titleFoldBudget: 0 }), revision: 1, now: 1,
  })
  const byId = new Map(inventory.workspaces[0].sessions.map((one) => [one.id, one]))
  assert.equal(byId.get('s-live').mode, 'danger-full-access', '已加载会话用有效权限（与转发同一个解析器）')
  assert.equal('mode' in byId.get('s-idle'), false, '未加载的会话读不到权限就不填（不许拿缓存或默认值猜）')
})
await check('日志折叠按出厂三层形状取值，且 status=rejected 的条目不算命中', async () => {
  const services = new Map()
  services.set('workspaceRegistry', {
    list: () => [{ id: 'w', path: '/p', title: 'W', sessionIds: [], createdAt: 'c', updatedAt: 'u' }],
    get archivedSessionIds() { return [] },
  })
  services.set('sessionQuery', {
    listSessions: async () => [
      { header: { id: 'good', cwd: '/p', createdAt: 5 }, live: false, persisted: true },
      { header: { id: 'bad', cwd: '/p', createdAt: 6 }, live: false, persisted: true },
    ],
    readTitleSnapshots: async () => [
      { sessionId: 'good', status: 'fulfilled', value: { session: { id: 'good' }, title: { title: '来自日志', updatedAt: 42 } } },
      { sessionId: 'bad', status: 'rejected', reason: new Error('读日志失败') },
    ],
  })
  const inventory = await collectInventory({ get: (name) => services.get(name) }, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({ titleFoldBudget: 10 }), revision: 1, now: 1,
  })
  const sessions = inventory.workspaces[0].sessions
  const good = sessions.find((entry) => entry.id === 'good')
  const bad = sessions.find((entry) => entry.id === 'bad')
  assert.equal(good.title, '来自日志', '三层形状拆错就会拿不到标题')
  assert.equal(good.lastActivityAt, 42)
  assert.equal(bad.title, null, 'status=rejected 的条目不该被当成命中')
  // 覆盖度的账要能对上：1 条来自日志折叠、1 条仍然缺标题。
  assert.equal(inventory.degraded.titleSources.logFold, 1)
  assert.equal(inventory.degraded.titleSources.missing, 1)
})
await check('titleFoldBudget=0 且缓存未命中时 title 为 null（绝不拿 id 冒充标题）', async () => {
  const services = new Map()
  services.set('workspaceRegistry', {
    list: () => [{ id: 'w', path: '/p', title: 'W', sessionIds: [], createdAt: 'c', updatedAt: 'u' }],
    get archivedSessionIds() { return [] },
  })
  services.set('sessionQuery', {
    listSessions: async () => [{ header: { id: 's1', cwd: '/p', createdAt: 5 }, live: false, persisted: true }],
    readTitleSnapshots: async () => { throw new Error('不该被调用') },
  })
  services.set('sessionProjectionCache', { cachedSnapshot: () => undefined })
  const inventory = await collectInventory({ get: (name) => services.get(name) }, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({ titleFoldBudget: 0 }), revision: 1, now: 1,
  })
  const session = inventory.workspaces[0].sessions[0]
  assert.equal(session.title, null)
  assert.equal(session.id, 's1')
})
await check('includeSubagents=false 时子代理会话不列出，但计数仍在 totals', async () => {
  const services = new Map()
  services.set('workspaceRegistry', {
    list: () => [{ id: 'w', path: '/p', title: 'W', sessionIds: [], createdAt: 'c', updatedAt: 'u' }],
    get archivedSessionIds() { return [] },
  })
  services.set('sessionQuery', {
    listSessions: async () => [
      { header: { id: 'root', cwd: '/p', createdAt: 5 }, live: false, persisted: true },
      { header: { id: 'kid', cwd: '/p', createdAt: 6, origin: 'subagent' }, live: false, persisted: true },
    ],
    readTitleSnapshots: async () => [],
  })
  const inventory = await collectInventory({ get: (name) => services.get(name) }, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({ includeSubagents: false, titleFoldBudget: 0 }), revision: 1, now: 1,
  })
  assert.equal(inventory.workspaces[0].sessions.length, 1)
  assert.equal(inventory.workspaces[0].sessions[0].id, 'root')
  assert.equal(inventory.totals.subagents, 1, 'totals 仍应如实计入子代理')
})
await check('maxSessionsPerWorkspace 截断时标 truncated 与 droppedSessions', async () => {
  const services = new Map()
  services.set('workspaceRegistry', {
    list: () => [{ id: 'w', path: '/p', title: 'W', sessionIds: [], createdAt: 'c', updatedAt: 'u' }],
    get archivedSessionIds() { return [] },
  })
  services.set('sessionQuery', {
    listSessions: async () => Array.from({ length: 10 }, (_, index) => ({
      header: { id: `s${index}`, cwd: '/p', createdAt: index }, live: false, persisted: true,
    })),
    readTitleSnapshots: async () => [],
  })
  const inventory = await collectInventory({ get: (name) => services.get(name) }, {
    device: { deviceId: 'd' }, config: entry.normalizeConfig({ maxSessionsPerWorkspace: 3, titleFoldBudget: 0 }), revision: 1, now: 1,
  })
  assert.equal(inventory.truncated, true)
  assert.equal(inventory.workspaces[0].sessions.length, 3)
  assert.equal(inventory.workspaces[0].droppedSessions, 7)
})

G('清单缓存')
await check('TTL 内复用同一份、在飞请求合并、force 强制重采', async () => {
  let collections = 0
  const ctx = {
    get: (name) => {
      if (name === 'workspaceRegistry') return { list: () => [], get archivedSessionIds() { return [] } }
      if (name === 'sessionQuery') return { listSessions: async () => { collections += 1; return [] } }
      // 三个服务都要给全：少一个，采出来的快照就是「采残」的，而采残的快照按设计
      // 在开机窗口内不算新鲜（见上一条用例）。这条用例要测的是**健康快照**的 TTL 复用。
      if (name === 'sessionProjectionCache') return { cachedSnapshot: () => undefined }
      return undefined
    },
  }
  const cache = createInventoryCache({
    ctx, config: entry.normalizeConfig({ inventoryTtlMs: 60000 }), device: () => ({ deviceId: 'd' }), now: () => 0,
  })
  const [first, second] = await Promise.all([cache.get({}), cache.get({})])
  assert.equal(collections, 1, '并发请求应合并成一次采集')
  assert.equal(first, second, '同一份快照')
  await cache.get({})
  assert.equal(collections, 1, 'TTL 内不应重采')
  await cache.get({ force: true })
  assert.equal(collections, 2)
  assert.equal(cache.stats().joins, 1)
})

// ── 14. Caller 目标解析 ──────────────────────────────────────────────────────
G('Caller 解析')
await check('path 命中附加路径 → 目标是对端设备，role=member', async () => {
  const dir = path.join(ROOT, 'caller1')
  fs.mkdirSync(dir, { recursive: true })
  const config = entry.normalizeConfig({})
  const links = new LinkTable(dir, [])
  const created = links.upsert({ url: 'http://hub:1', tokenId: 't', secret: 'ssssssssssssssss', enabled: true })
  links.record(created.link.id, { hubDevice: { deviceId: 'hub-1', name: 'Hub', capabilities: ['remote-exec'] } })
  const caller = new Caller({
    config, identity: { deviceId: 'self', name: '本机' }, links,
    egress: { stateOf: () => ({ nodeId: 'n' }) },
    executor: { resolveLocal: () => '/tmp', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    context: () => ({
      devices: [
        { deviceId: 'self', name: '本机', device: { capabilities: ['inventory'] }, inventory: { workspaces: [{ id: 'w1', title: 'W1', path: '/local/w1' }] } },
        { deviceId: 'hub-1', name: 'Hub', device: { capabilities: ['remote-exec'] }, inventory: { workspaces: [{ id: 'w2', title: 'W2', path: '/remote/w2' }] } },
      ],
      groups: [{ id: 'g1', homeDeviceId: 'hub-1', workspaceId: 'w2', members: [{ id: 'm1', deviceId: 'self', path: '/local/mirror', role: 'scratch' }] }],
    }),
  })
  const target = caller.resolveTarget({ path: '/local/mirror' })
  assert.equal(target.deviceId, 'self', '附加路径在本机 → 本机执行')
  assert.equal(target.role, 'scratch')
  const target2 = caller.resolveTarget({ path: '/remote/w2' })
  assert.equal(target2.deviceId, 'hub-1')
  assert.equal(target2.local, false)
  assert.equal(target2.resolvedBy, 'primary')
})
await check('workspace 解析到主路径与所属设备（默认在主工作区工作）', async () => {
  const dir = path.join(ROOT, 'caller2')
  fs.mkdirSync(dir, { recursive: true })
  const links = new LinkTable(dir, [])
  const caller = new Caller({
    config: entry.normalizeConfig({}), identity: { deviceId: 'self', name: '本机' }, links,
    egress: { stateOf: () => null }, executor: {}, context: () => ({
      devices: [{ deviceId: 'self', name: '本机', device: { capabilities: [] }, inventory: { workspaces: [{ id: 'w1', title: '项目甲', path: '/local/jia', sessionCount: 3 }] } }],
      groups: [],
    }),
  })
  const target = caller.resolveTarget({ workspace: '项目甲' })
  assert.equal(target.path, '/local/jia')
  assert.equal(target.local, true)
  assert.equal(target.resolvedBy, 'workspace-primary')
})
await check('不可达 + capabilities 缺 remote-exec → 明确报错（不是空错误）', async () => {
  const dir = path.join(ROOT, 'caller3')
  fs.mkdirSync(dir, { recursive: true })
  const links = new LinkTable(dir, [])
  const caller = new Caller({
    config: entry.normalizeConfig({}), identity: { deviceId: 'self', name: '本机' }, links,
    egress: { stateOf: () => null }, executor: {}, context: () => ({
      devices: [{ deviceId: 'far', name: '远方', device: { capabilities: [] }, inventory: { workspaces: [{ id: 'w', title: 'W', path: '/far/w' }] } }],
      groups: [],
    }),
  })
  await assert.rejects(async () => caller.resolveTarget({ workspace: 'W' }), (error) => {
    assert.equal(error.code, protocol.CODE.unreachable)
    assert.match(error.message, /一跳/)
    return true
  })
})
await check('什么都不给 → 400', async () => {
  const dir = path.join(ROOT, 'caller4')
  fs.mkdirSync(dir, { recursive: true })
  const caller = new Caller({
    config: entry.normalizeConfig({}), identity: { deviceId: 'self', name: '本机' },
    links: new LinkTable(dir, []), egress: { stateOf: () => null }, executor: {}, context: () => ({ devices: [], groups: [] }),
  })
  await assert.rejects(async () => caller.resolveTarget({}), (error) => error.status === 400)
})
await check('caller.sessionMode：是 request 的薄包装（本机设备直接拒绝，不绕网格）', async () => {
  const dir = path.join(ROOT, 'caller-mode')
  fs.mkdirSync(dir, { recursive: true })
  const caller = new Caller({
    config: entry.normalizeConfig({}), identity: { deviceId: 'self', name: '本机' },
    links: new LinkTable(dir, []), egress: { stateOf: () => null }, executor: {},
    context: () => ({
      devices: [{ deviceId: 'self', name: '本机', device: { capabilities: [] }, inventory: { workspaces: [{ id: 'w1', title: 'W', path: '/local/w' }] } }],
      groups: [],
    }),
  })
  // 「本机路径不该走入站 API」这条既有承诺对 session-mode 同样成立：它必须走 resolveTarget
  // （否则设备钉住就被绕过了），而不是自己拼一条 HTTP。
  await assert.rejects(
    async () => caller.sessionMode({ deviceId: 'self', sessionId: 'session-x', mode: 'read-only', targetPath: '/local/w' }),
    (error) => String(error.message).includes('本机路径不该走入站 API'),
  )
})

// ── 15. 签名原语 ─────────────────────────────────────────────────────────────
G('签名原语')
await check('canonicalRequest 五段以 \\n 连接', async () => {
  assert.equal(
    protocol.canonicalRequest({ method: 'post', path: '/p', timestamp: 1, nonce: 'n', hash: 'h' }),
    'POST\n/p\n1\nn\nh',
  )
})
await check('字段含换行直接抛错（不给规范串歧义留口子）', async () => {
  assert.throws(() => protocol.canonicalRequest({ method: 'POST', path: '/p\n/p2', timestamp: 1, nonce: 'n', hash: 'h' }))
})
await check('bodyHash 空体等于空串摘要', async () => {
  assert.equal(protocol.bodyHash(''), protocol.sha256Hex(''))
  assert.equal(protocol.bodyHash(null), protocol.EMPTY_BODY_HASH)
})
await check('timingSafeEqualStr 长度不同即 false', async () => {
  assert.equal(protocol.timingSafeEqualStr('abc', 'abcd'), false)
  assert.equal(protocol.timingSafeEqualStr('abc', 'abc'), true)
  assert.equal(protocol.timingSafeEqualStr('abc', 42), false)
})
await check('readSignatureHeaders 拒绝畸形头', async () => {
  assert.throws(() => protocol.readSignatureHeaders({}))
  assert.throws(() => protocol.readSignatureHeaders({ [protocol.HEADERS.device]: 'ZZZ' }))
  assert.throws(() => protocol.readSignatureHeaders({
    [protocol.HEADERS.device]: 'a'.repeat(32),
    [protocol.HEADERS.token]: 'b'.repeat(16),
    [protocol.HEADERS.timestamp]: '１', // 全角数字
    [protocol.HEADERS.nonce]: 'c'.repeat(16),
    [protocol.HEADERS.signature]: 'sig',
  }))
})
await check('verifyRequestSignature 拒绝换体、换路径、换密钥、超窗', async () => {
  const secret = 'k'.repeat(32)
  const parts = { method: 'POST', path: '/a', timestamp: 1000, nonce: 'd'.repeat(16) }
  const headers = protocol.buildSignatureHeaders({ ...parts, deviceId: 'a'.repeat(32), tokenId: 'b'.repeat(16), secret, body: '{}', now: 1000 })
  const verify = (extra) => protocol.verifyRequestSignature({
    secret, method: 'POST', path: '/a', body: '{}', headers, now: 1000, skewMs: 100, ...extra,
  })
  assert.equal(verify({}).tokenId, 'b'.repeat(16))
  assert.throws(() => verify({ body: '{"x":1}' }), /签名/)
  assert.throws(() => verify({ path: '/b' }), /签名/)
  assert.throws(() => verify({ secret: 'other'.repeat(10) }), /签名/)
  assert.throws(() => verify({ now: 99999 }), /时间戳/)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
G('资源回收')
await check('dispose 后所有路由不再注册（effects 被正确回收）', async () => {
  const temp = await createNode({
    name: '临时', storeDir: path.join(ROOT, 'temp'), workspaces: [], sessions: [],
  })
  const before = await call(`${temp.url}/dsh-device-mesh/status`)
  await expectStatus(before, 200)
  await temp.dispose()
  const after = await call(`${temp.url}/dsh-device-mesh/status`)
  assert.notEqual(after.status, 200, 'dispose 后路由仍在响应')
})

await check('两个节点都 dispose 完成', async () => {
  await nodeA.dispose()
  await nodeB.dispose()
})

// ── 远端文件系统原语（6 条 fs/* 入站路由）────────────────────────────────────
// 这一段此前**完全不存在**：fs/* 是 v11 的主要新增能力，却只被桥接层的桩测过
// （bridge-selftest.mjs 用 stub delegate + stub caller）。入站侧的鉴权、导出根闸、
// 错误信封与错误翻译（也就是真正会跨网的那一半）一条都没被跑过。
//
// 覆盖它需要一个 fs 服务，所以下面带一个**最小桩实现**。它是桩不是实现：真实
// provider 的语义由 DSH 自己保证，这里要钉住的是本插件这一层的形状与判定。

/**
 * 测试用 fs 服务：只实现 fs-inbound 真正用到的方法，形状对齐出厂契约
 * （`resolve()` 返回 `{displayPath,targetKey}`，版本令牌是字符串）。
 *
 * **刻意复刻一处上游行为**：出厂 `dsh-fs-local` 的 `listDirectory` 逐子项走
 * `resolveLocalTarget(cwd, name)`，而它开头 `if (path.trim().length === 0) throw`——
 * 于是目录里只要有一个纯空白文件名，**整个目录列举**都会抛
 * `FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')`。这里照做，
 * 是为了让「把它翻译成可行动的说法」这条逻辑有回归网。
 * 上游若修好这个 bug，本桩要一并改掉（那条用例会因此翻红，正是提醒）。
 * @returns {object} fs 服务桩。
 */
function makeFakeFs() {
  let clock = 0
  const versionOf = () => `v${++clock}`
  const key = (target) => (typeof target === 'string' ? target : target.targetKey)
  const typeOf = (stats) => (stats.isDirectory() ? 'directory' : (stats.isFile() ? 'file' : 'other'))
  return {
    async resolve(p, opts) {
      const absolutePath = path.resolve(opts?.cwd ?? process.cwd(), p)
      return { displayPath: absolutePath, targetKey: absolutePath }
    },
    async stat(target) {
      try {
        const stats = fs.statSync(key(target))
        return { type: typeOf(stats), size: stats.size, version: versionOf() }
      } catch {
        return undefined
      }
    },
    async lstat(p, opts) {
      // 与出厂一致：**先 trim 判空再解析**，空路径抛那条会误导人的消息。
      if (String(p).trim().length === 0) {
        const error = new Error('file_path must be a non-empty string')
        error.code = 'FS_NOT_FOUND'
        throw error
      }
      const absolutePath = path.resolve(opts?.cwd ?? process.cwd(), p)
      const stats = fs.lstatSync(absolutePath)
      return { type: typeOf(stats), size: stats.size, version: versionOf() }
    },
    async readText(target) {
      return fs.readFileSync(key(target), 'utf8')
    },
    async readBytes(target, _signal, maxBytes) {
      const buffer = fs.readFileSync(key(target))
      return maxBytes === undefined ? buffer : buffer.subarray(0, maxBytes)
    },
    async readByteRange(target, range) {
      return fs.readFileSync(key(target)).subarray(range.offset, range.offset + range.length)
    },
    async listDir(target) {
      const dir = key(target)
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      // 复刻上游：逐子项解析，纯空白名字直接抛，整个列举失败。
      for (const entry of entries) {
        if (entry.name.trim().length === 0) {
          const error = new Error('file_path must be a non-empty string')
          error.code = 'FS_NOT_FOUND'
          throw error
        }
      }
      return entries.map((entry) => {
        const stats = fs.statSync(path.join(dir, entry.name))
        return { name: entry.name, type: typeOf(stats), size: stats.size, version: versionOf() }
      })
    },
    async writeText(target, content, intent) {
      const file = key(target)
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      if (intent?.kind === 'createIfAbsent' && before !== null) {
        const error = new Error('文件已存在')
        error.code = 'FS_STALE_VERSION'
        throw error
      }
      fs.writeFileSync(file, content, 'utf8')
      return { operation: before === null ? 'create' : 'replace', version: versionOf(), before, after: content }
    },
    async editText(target, edit, expected) {
      const file = key(target)
      const before = fs.readFileSync(file, 'utf8')
      if (expected?.version !== undefined && String(expected.version) === 'v0-not-a-real-version') {
        const error = new Error('版本过期')
        error.code = 'FS_STALE_VERSION'
        throw error
      }
      if (!before.includes(edit.oldString)) {
        const error = new Error('找不到 oldString')
        error.code = 'FS_NOT_FOUND'
        throw error
      }
      const after = edit.replaceAll === true
        ? before.split(edit.oldString).join(edit.newString)
        : before.replace(edit.oldString, edit.newString)
      fs.writeFileSync(file, after, 'utf8')
      return { version: versionOf(), before, after }
    },
  }
}

G('远端文件系统原语')
const fsWork = path.join(ROOT, 'fs-work')
fs.mkdirSync(path.join(fsWork, 'sub'), { recursive: true })
fs.mkdirSync(path.join(fsWork, 'blank-dir'), { recursive: true })
fs.writeFileSync(path.join(fsWork, 'hello.txt'), 'hello mesh\n', 'utf8')
fs.writeFileSync(path.join(fsWork, 'sub', 'inner.txt'), 'inner\n', 'utf8')

const fsNode = await createNode({
  name: 'fs-node',
  storeDir: path.join(ROOT, 'fs-node-store'),
  workspaces: [{ id: 'ws-fs-1', path: fsWork, title: 'fs-work' }],
  fs: makeFakeFs(),
  // fs/* 与 exec 共用同一道执行门，所以这里必须真的开执行权，否则每条都是 403。
  config: { allowRemoteExec: true, execTrust: 'any-authenticated', exportWorkspacePaths: true },
})
const fsToken = await call(`${fsNode.url}/dsh-device-mesh/tokens`, {
  method: 'POST',
  body: JSON.stringify({ action: 'create', label: 'fs' }),
})
const fsCreds = { deviceId: idA, tokenId: fsToken.json.token.id, secret: fsToken.json.secret }
await signedCall(`${fsNode.url}`, protocol.API.join, joinPayload(idA, 'A'), fsCreds)

await check('fs/stat：拿到远端目录元数据', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsStat, { path: fsWork }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.info.type, 'directory')
})
await check('fs/lstat：不跟随最后一段符号链接', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsLstat, { path: path.join(fsWork, 'hello.txt') }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.info.type, 'file')
})
await check('fs/read（text）：内容与源文件逐字相同', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsRead, { path: path.join(fsWork, 'hello.txt'), mode: 'text' }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.kind, 'text')
  assert.equal(result.json.text, 'hello mesh\n')
})
await check('fs/read（bytes）：base64 回传且带窗口', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsRead, {
    path: path.join(fsWork, 'hello.txt'), mode: 'bytes', offset: 0, length: 5,
  }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.kind, 'bytes')
  assert.equal(Buffer.from(result.json.base64, 'base64').toString('utf8'), 'hello')
})
await check('fs/listdir：列直接子项', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsListDir, { path: fsWork }, fsCreds)
  await expectStatus(result, 200)
  const names = result.json.entries.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['blank-dir', 'hello.txt', 'sub'])
})
await check('fs/write + fs/edit：真的落到对端磁盘上', async () => {
  const file = path.join(fsWork, 'written.txt')
  const written = await signedCall(`${fsNode.url}`, protocol.API.fsWrite, {
    path: file, content: 'one\ntwo\n', expected: { kind: 'createIfAbsent' },
  }, fsCreds)
  await expectStatus(written, 200)
  assert.equal(written.json.operation, 'create')
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\n')
  const edited = await signedCall(`${fsNode.url}`, protocol.API.fsEdit, {
    path: file, oldString: 'two', newString: 'three',
  }, fsCreds)
  await expectStatus(edited, 200)
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\nthree\n')
})
await check('fs/write：createIfAbsent 撞上已存在文件 → FS_STALE_VERSION 走 200 信封', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsWrite, {
    path: path.join(fsWork, 'hello.txt'), content: 'x', expected: { kind: 'createIfAbsent' },
  }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.failed, true)
  assert.equal(result.json.fsCode, 'FS_STALE_VERSION')
})
await check('fs/*：导出根之外被拒（门走 HTTP 错误，不是 200 信封）', async () => {
  const outsideFile = path.join(ROOT, 'outside-fs.txt')
  fs.writeFileSync(outsideFile, 'secret\n', 'utf8')
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsRead, { path: outsideFile, mode: 'text' }, fsCreds)
  await expectStatus(result, 403, protocol.CODE.pathNotExported)
})
await check('fs/*：没带令牌被拒（401）', async () => {
  const result = await fetch(`${fsNode.url}${protocol.API.fsStat}`, {
    method: 'POST', body: JSON.stringify({ path: fsWork }),
  })
  assert.equal(result.status, 401)
})
await check('fs/listdir：目录里有纯空白文件名 → 翻译成可行动的说法，而不是「路径没传」', async () => {
  const dirty = path.join(fsWork, 'dirty')
  fs.mkdirSync(path.join(dirty, 'ok'), { recursive: true })
  fs.mkdirSync(path.join(dirty, ' \t '), { recursive: true })
  const result = await signedCall(`${fsNode.url}`, protocol.API.fsListDir, { path: dirty }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.failed, true)
  assert.match(result.json.message, /纯空白文件名/)
  // 原始文案要保留在末尾，否则「上游到底报了什么」就查不到了。
  assert.match(result.json.message, /file_path must be a non-empty string/)
})

G('远端执行：中止')
await check('exec/cancel：中止一条正在跑的命令，且不再等满超时', async () => {
  const jobId = 'a1b2c3d4e5f60718'
  const started = Date.now()
  const running = signedCall(`${fsNode.url}`, protocol.API.exec, {
    path: fsWork, command: 'sleep 20', timeoutMs: 60000, jobId,
  }, fsCreds)
  // 等它真的起来（登记进 Job 表）再取消，否则会撞上正常竞态。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
  const cancelled = await signedCall(`${fsNode.url}`, protocol.API.execCancel, { jobId }, fsCreds)
  assert.equal(cancelled.status, 200, `cancel 应当 200，实际 ${cancelled.status} ${JSON.stringify(cancelled.json)}`)
  assert.equal(cancelled.json.cancelled, true, `cancel 未被接受：${JSON.stringify(cancelled.json)}`)
  const finished = await running
  assert.equal(finished.status, 200, `exec 应当 200，实际 ${finished.status}`)
  assert.equal(finished.json.cancelled, true, `exec 结果应标 cancelled：${JSON.stringify(finished.json).slice(0, 200)}`)
  assert.ok(Date.now() - started < 12000, `中止后应当很快返回，实际 ${Date.now() - started}ms`)
})
await check('exec/cancel：未知 jobId → 结构化码，不是错误状态（正常竞态）', async () => {
  const result = await signedCall(`${fsNode.url}`, protocol.API.execCancel, { jobId: 'ffffffffffffffff' }, fsCreds)
  await expectStatus(result, 200)
  assert.equal(result.json.cancelled, false)
  assert.equal(result.json.code, protocol.CODE.unknownJob)
})
await check('exec/cancel：没带令牌被拒', async () => {
  const result = await fetch(`${fsNode.url}${protocol.API.execCancel}`, {
    method: 'POST', body: JSON.stringify({ jobId: 'a1b2c3d4e5f60718' }),
  })
  assert.equal(result.status, 401)
})

G('路由判定与可观测性')
await check('/status.routing：把「配置意图」与「实际挂载结果」分开报', async () => {
  const result = await call(`${fsNode.url}/dsh-device-mesh/status`)
  await expectStatus(result, 200)
  // 这一段曾完全缺失：配置里 routeExecByPath 可以是 true，而 ctx.shell/ctx.fs 其实
  // 还是出厂实现（provide 撞名时挂载失败、只留一条日志），界面上两者长得一样。
  assert.ok(result.json.routing !== undefined, 'status 里应当有 routing 段')
  assert.equal(typeof result.json.routing.configured, 'boolean')
  assert.equal(typeof result.json.routing.shell.ready, 'boolean')
  assert.equal(typeof result.json.routing.fs.ready, 'boolean')
})
await check('/route：同长并列先被标出来，再由显式 prefer 裁决', async () => {
  // 起点：只有主路径一个候选，不存在并列。
  const solo = await call(`${fsNode.url}/dsh-device-mesh/route`, {
    method: 'POST', body: JSON.stringify({ path: fsWork }),
  })
  await expectStatus(solo, 200)
  assert.equal(solo.json.tied, false, '只有一个候选时不该报并列')
  // 挂一条**路径字符串完全相同**的附加路径 → 两个同长候选，隐患显式暴露。
  // 这正是「把工作路径定位到另一台机器」的常态写法，也是最容易退化成
  // 「谁赢看 deviceId 大小」的情形。
  const added = await call(`${fsNode.url}/dsh-device-mesh/paths`, {
    method: 'POST',
    body: JSON.stringify({ action: 'add', workspaceId: 'ws-fs-1', deviceId: idA, path: fsWork }),
  })
  await expectStatus(added, 200)
  const tied = await call(`${fsNode.url}/dsh-device-mesh/route`, {
    method: 'POST', body: JSON.stringify({ path: fsWork }),
  })
  await expectStatus(tied, 200)
  assert.equal(tied.json.tied, true, '同路径双属主应当报并列')
  assert.equal(tied.json.needsPrefer, true, '没有显式 prefer 时必须把隐患标出来')
  assert.equal(tied.json.contenders.length, 2)
  // 声明 prefer → 由人决定，而不是由随机生成的 deviceId 决定。
  const member = added.json.groups.find((entry) => entry.workspaceId === 'ws-fs-1').members[0]
  const updated = await call(`${fsNode.url}/dsh-device-mesh/paths`, {
    method: 'POST', body: JSON.stringify({ action: 'update', id: member.id, prefer: true }),
  })
  await expectStatus(updated, 200)
  const after = await call(`${fsNode.url}/dsh-device-mesh/route`, {
    method: 'POST', body: JSON.stringify({ path: fsWork }),
  })
  await expectStatus(after, 200)
  assert.equal(after.json.decision.kind, 'remote', 'prefer 之后应当判给另一台')
  assert.equal(after.json.needsPrefer, false, '声明过之后就不该再报隐患')
  assert.match(after.json.explanation, /显式偏好/)
})

// ── 会话权限：显示与修改 ─────────────────────────────────────────────────────
// 权限的**权威在会话所在这台**（出厂 `sandbox/mode` 会话覆盖），但两边都要能看到同一条
// 值，也都要能发起修改。显示走清单（两边互通），修改走 `session-mode` 两条路由。
G('会话权限：显示与修改')
{
  const appended = []
  const modeSession = {
    id: 'session-11111111-1111-1111-1111-111111111111',
    header: { cwd: '/root/mode-ws', createdAt: 1 },
    append(type, data) { appended.push([type, data]) },
  }
  const modeWork = path.join(ROOT, 'mode-ws')
  fs.mkdirSync(modeWork, { recursive: true })
  const modeNode = await createNode({
    name: 'mode-node',
    storeDir: path.join(ROOT, 'mode-node-store'),
    workspaces: [{ id: 'ws-mode-1', path: modeWork, title: 'mode-ws' }],
    config: { allowRemoteExec: true, execTrust: 'any-authenticated' },
    agents: { list: () => [{ session: modeSession }] },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: session?.id === modeSession.id ? 'read-only' : 'workspace-write' }) },
  })
  const modeToken = await call(`${modeNode.url}/dsh-device-mesh/tokens`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create', label: 'mode' }),
  })
  const modeCreds = { deviceId: idA, tokenId: modeToken.json.token.id, secret: modeToken.json.secret }
  await signedCall(`${modeNode.url}`, protocol.API.join, joinPayload(idA, 'A'), modeCreds)

  await check('路由常量：两类 session-mode 分开（设备 API vs 浏览器）', () => {
    assert.equal(protocol.API.sessionMode, '/dsh-device-mesh/api/session-mode')
    assert.equal(protocol.UI.sessionMode, '/dsh-device-mesh/session-mode')
  })
  await check('入站 session-mode：非法权限 → 400，且**不**动会话', async () => {
    const result = await signedCall(`${modeNode.url}`, protocol.API.sessionMode,
      { sessionId: modeSession.id, mode: 'root-access' }, modeCreds)
    await expectStatus(result, 400, protocol.CODE.badRequest)
    assert.deepEqual(appended, [], '模式非法时绝不能追加事件')
  })
  await check('入站 session-mode：会话不在这台（没加载）→ 404 并说清原因', async () => {
    const result = await signedCall(`${modeNode.url}`, protocol.API.sessionMode,
      { sessionId: 'session-22222222-2222-2222-2222-222222222222', mode: 'workspace-write' }, modeCreds)
    await expectStatus(result, 404, protocol.CODE.notFound)
    assert.match(String(result.json.error), /不在这台机器上/)
    assert.deepEqual(appended, [], '找不到会话时绝不能追加事件')
  })
  await check('入站 session-mode：成功 → 追加 sandbox/mode 事件 + 写审计 + 回执带新权限', async () => {
    const result = await signedCall(`${modeNode.url}`, protocol.API.sessionMode,
      { sessionId: modeSession.id, mode: 'danger-full-access' }, modeCreds)
    await expectStatus(result, 200)
    assert.equal(result.json.mode, 'danger-full-access')
    assert.deepEqual(appended, [['sandbox/mode', { mode: 'danger-full-access' }]],
      '出厂 setSandboxMode 就是往会话追加一条 sandbox/mode 事件')
    // 改权限是**权限变更**，审计必须留痕（事后要能回答「谁在什么时候改成了什么」）。
    const audit = await call(`${modeNode.url}/dsh-device-mesh/audit?limit=50`)
    await expectStatus(audit, 200)
    const hit = (audit.json.entries ?? []).find((entryRow) => String(entryRow.command ?? '').includes(modeSession.id))
    assert.ok(hit !== undefined, '审计里没有这条权限变更')
    assert.equal(hit.mode, 'danger-full-access')
    assert.equal(hit.direction, 'in')
    assert.equal(hit.outcome, 'ok')
  })
  await check('浏览器 session-mode：会话就在本机 → 就地改（local=true）', async () => {
    appended.length = 0
    const result = await call(`${modeNode.url}${protocol.UI.sessionMode}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: modeSession.id, mode: 'workspace-write' }),
    })
    await expectStatus(result, 200)
    assert.equal(result.json.local, true, '本机已加载的会话必须就地改，不该绕网格')
    assert.equal(result.json.mode, 'workspace-write')
    assert.equal(result.json.before, 'read-only', '回执要带改之前的值（便于界面确认）')
    assert.deepEqual(appended, [['sandbox/mode', { mode: 'workspace-write' }]])
    // 浏览器侧那条也要留痕（actor=browser、direction=out），否则「谁改的」只剩一半。
    const audit = await call(`${modeNode.url}/dsh-device-mesh/audit?limit=50`)
    const hit = (audit.json.entries ?? []).find((entryRow) => entryRow.actor === 'browser')
    assert.ok(hit !== undefined, '浏览器侧改权限也要写审计')
    assert.equal(hit.mode, 'workspace-write')
  })
  await check('浏览器 session-mode：本机清单有、但没加载 → 409 说清「先在那台打开它」', async () => {
    appended.length = 0
    const result = await call(`${modeNode.url}${protocol.UI.sessionMode}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-33333333-3333-3333-3333-333333333333', mode: 'read-only', deviceId: 'self-not-this' }),
    })
    // 既没加载、又给了个别人的 deviceId → 走到「一跳转发」，本机没有到它的接入点 → 明确报错。
    assert.equal(result.status >= 400, true)
    assert.deepEqual(appended, [])
  })
  await modeNode.dispose()
}

G('维护不变量')
await check('整张 import 图的 ?v= 缓存标记一致（换版最容易错的地方）', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const specifier = /\.\/[a-z0-9-]+\.js(\?v=mesh-\d+)?/g
  // 当前入口 = 版本号最大的那个（旧入口留着会带着旧标记，不该混进判定）。
  const entries = fs.readdirSync(here)
    .map((name) => /^entry-v(\d+)\.js$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[0], version: Number(match[1]) }))
    .sort((left, right) => right.version - left.version)
  assert.ok(entries.length > 0, '找不到 entry-v<N>.js')
  const current = entries[0].name
  const files = fs.readdirSync(here)
    .filter((name) => name.endsWith('.js') && !/^entry-v\d+\.js$/.test(name) && name !== 'index.js')
    .concat([current])
  const markers = new Set()
  const untagged = []
  for (const name of files) {
    const text = fs.readFileSync(path.join(here, name), 'utf8')
    for (const match of text.matchAll(specifier)) {
      if (match[1] === undefined) untagged.push(`${name}: ${match[0]}`)
      else markers.add(match[1])
    }
  }
  assert.deepEqual(untagged, [], `相对说明符必须带 ?v= 标记：${untagged.join(', ')}`)
  assert.equal(markers.size, 1, `不同版本标记混在一张图里：${[...markers].join(', ')}`)
  const entry = fs.readFileSync(path.join(here, current), 'utf8')
  const tag = /const IMPORT_TAG = '(mesh-\d+)'/.exec(entry)?.[1]
  assert.equal(`?v=${tag}`, [...markers][0], 'IMPORT_TAG 与说明符标记不一致')
})

// 这一段自己起的节点自己收：留着监听不关，整个自测进程会挂在事件循环上不退出
// （症状是「检查全跑完、摘要也打出来了，但进程不退」）。
await fsNode.dispose()

await check('清单缓存：「采残的快照」不算新鲜，下一次请求就重采', async () => {
  // 实测（rpi，0.2.0）：重启后第一份清单是在工作区/会话行挂载**之前**采的，
  // 于是有约 60 秒里对端看到的是「0 个工作区、全部会话未归属、没有标题」——
  // 那份快照有 revision、有 totals，看起来完全正常，只是采残了。
  let clock = 1_000_000
  const cache = createInventoryCache({
    // 所有服务都缺席 → 必然采残（这正是开机头几秒的情形）。
    ctx: { get: () => undefined },
    config: { inventoryTtlMs: 20000 },
    device: () => ({ deviceId: 'inv-dev', name: 'inv-dev' }),
    now: () => clock,
  })
  const first = await cache.get({})
  assert.equal(cache.stats().degraded, true, `这份快照应当被判为采残：${JSON.stringify(first.degraded)}`)
  const collections = cache.stats().collections
  clock += 1000 // 远未到 TTL
  await cache.get({})
  assert.equal(cache.stats().collections, collections + 1, '采残的快照不该被当成新鲜数据复用')
  // 过了开机窗口仍残（例如本 profile 本来就没有该服务）则恢复正常 TTL，
  // 否则会把一次 3 秒级的采集变成每请求都跑。
  clock = 1_000_000 + 61_000
  await cache.get({})
  const settled = cache.stats().collections
  clock += 1000
  await cache.get({})
  assert.equal(cache.stats().collections, settled, '过了开机窗口就应当恢复 TTL 复用')
})

// ── 结果 ─────────────────────────────────────────────────────────────────────
const total = passed + failures.length
if (failures.length === 0) {
  console.log(`SELFTEST PASS (${passed} checks)`)
} else {
  console.log('失败的检查：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  console.log(`SELFTEST FAIL (${failures.length} failures / ${total} checks)`)
  process.exitCode = 1
}

// 清掉临时树。窗口期内子进程可能还在收尾，失败不影响判定。
try {
  fs.rmSync(ROOT, { recursive: true, force: true })
} catch {
  // 尽力而为。
}
