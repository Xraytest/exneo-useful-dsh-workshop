/**
 * 宿主半边：给「ZCode 反代（CLI）」设置页提供数据与动作。
 *
 * 本文件是**本机新增**（不属于上游），所以放在 local/ 下，lib/ 保持与上游逐行一致
 * （只多一处平台目录名的修复）。由 entry-v3.js 的 apply 调用。
 *
 * 路由（全部同源守卫）：
 *   GET  /dsh-zcode-cli-proxy/status        账号列表 / 通道匹配 / 配置（不含任何密钥明文）
 *   GET  /dsh-zcode-cli-proxy/balance        各账号余额（订阅套餐 + 额度余量）
 *   POST /dsh-zcode-cli-proxy/login/start    拉起 `zcode login --no-browser`，回 OAuth URL
 *   GET  /dsh-zcode-cli-proxy/login/state    登录子进程状态（页面轮询）
 *   POST /dsh-zcode-cli-proxy/login/cancel   中止登录子进程
 *   POST /dsh-zcode-cli-proxy/test           真跑一轮（**消耗额度**），回结果
 *
 * 安全约定：
 *   · 只回 token 的**存在性/长度**，绝不回明文（jwt / api-key / 账号 token 都不出宿主）。
 *   · 登录子进程用最小 env（PATH/HOME/… + ZCODE_*），不把 DSH 宿主的全部 env 带下去。
 *   · 所有写动作要求同源：`sec-fetch-site: cross-site` 拒；带 Origin 时必须与 Host 同源。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const ROUTE_PREFIX = '/dsh-zcode-cli-proxy'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const TEST_TIMEOUT_MS = 240 * 1000
/** zcode.z.ai 的 CLI OAuth 端点（zcode login 用的同一套协议，provider 可指定 bigmodel）。 */
const OAUTH_API = 'https://zcode.z.ai/api/v1'
/** BigModel 开放平台（coding-plan key 的签发地，与 zcode.cjs 的 resolveCodingPlanApiKey 同款流程）。 */
const BIGMODEL_API_HOST = 'open.bigmodel.cn'
/** coding-plan API key 的固定名字（zcode.cjs 里 jZr 常量，签发与复用都认这个名字）。 */
const BIGMODEL_API_KEY_NAME = 'zcode'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 同源守卫（与本 profile 其它插件的口径一致）。 */
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const sendJson = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function sendError(res, status, error) {
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, status, { error: message })
}

const readBody = (req) => new Promise((resolve, reject) => {
  let text = ''
  req.on('data', (chunk) => {
    text += chunk
    if (text.length > 64_000) reject(new Error('请求体过大'))
  })
  req.on('end', () => resolve(text))
  req.on('error', reject)
})

/** 形状描述：只给「有没有 / 多长 / 几个分隔符」，不给值。 */
function describeSecret(value) {
  if (typeof value !== 'string' || value === '') return { present: false }
  return {
    present: true,
    length: value.length,
    separators: (value.match(/\./g) ?? []).length,
    looksLikeJwt: (value.match(/\./g) ?? []).length === 2,
  }
}

/** 在最近的 ZCode CLI 日志里找最后一条上游模型失败（给设置页当「最近错误」）。 */
function lastUpstreamFailure(baseDir) {
  const logDir = path.join(baseDir, '.zcode', 'cli', 'log')
  let names
  try {
    names = fs.readdirSync(logDir).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    return undefined
  }
  for (let index = names.length - 1; index >= 0 && index >= names.length - 3; index -= 1) {
    let text
    try {
      text = fs.readFileSync(path.join(logDir, names[index]), 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n').filter((line) => line !== '').reverse()
    for (const line of lines.slice(0, 400)) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const context = entry?.context ?? {}
      const cause = entry?.error?.cause?.context ?? {}
      const isRequestFailure = entry?.event === 'model.request.failed' || entry?.event === 'model.network.failed'
      const isTurnFailure = entry?.event === 'turn.failed'
      if (!isRequestFailure && !isTurnFailure) continue
      const providerId = context.providerId ?? cause.providerId
      const statusMessage = context.statusMessage ?? cause.message ?? entry?.error?.cause?.message
      if (typeof providerId !== 'string' && typeof statusMessage !== 'string') continue
      return {
        at: entry.timestamp,
        event: entry.event,
        providerId: providerId ?? null,
        modelId: context.modelId ?? cause.modelId ?? null,
        baseURL: context.baseURL ?? null,
        statusCode: context.statusCode ?? cause.statusCode ?? null,
        reason: context.reason ?? cause.reason ?? null,
        providerCode: cause.providerCode ?? null,
        message: typeof statusMessage === 'string' ? statusMessage : null,
        logFile: names[index],
      }
    }
  }
  return undefined
}

/**
 * @param {object} ctx cordis 上下文
 * @param {object} deps entry-v3 注入的上游能力
 */
export function registerHostPanel(ctx, deps) {
  const { options, ZcodeAppServerAdapter, START_PLAN_PROVIDER_ID, START_PLAN_MODELS, CODING_PLAN_MODELS, resolveDefaultModelId, resolveBuiltinRuntime, readCredentials, credentialsPath, logger } = deps
  void START_PLAN_MODELS
  void CODING_PLAN_MODELS
  void resolveDefaultModelId

  const baseDir = () => {
    const configured = options().zcodeDataBaseDir
    return configured !== '' ? configured : (process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir())
  }

  /** 当前注入的 Start Plan provider（配置 startPlanProviderId 覆盖；缺省上游的 zai 家族）。 */
  function startPlanProviderId() {
    const o = options()
    return o.startPlanProviderId && o.startPlanProviderId.trim() !== '' ? o.startPlanProviderId : START_PLAN_PROVIDER_ID
  }

  /** 与 app-server 同款的最小 env（复刻其白名单意图，不整体透传宿主 env）。 */
  function childEnv(o) {
    const env = {}
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'NODE_EXTRA_CA_CERTS']) {
      const value = process.env[key]
      if (typeof value === 'string' && value !== '') env[key] = value
    }
    env.ZCODE_SERVICE_AUTHORITY_MODE = 'desktop-local'
    const builtin = resolveBuiltinRuntime(o.zcodeDataBaseDir || undefined)
    if (builtin !== undefined) {
      env.ZCODE_APP_VERSION = builtin.version
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin.activeFilePath
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(baseDir(), '.zcode', 'v2', 'provider_config.json')
      env.ZCODE_BASE_URL = 'https://zcode.z.ai'
    }
    return env
  }

  // ── 登录子进程 ────────────────────────────────────────────────────────────
  let login = { child: undefined, url: undefined, tail: '', startedAt: 0, exitCode: null, signal: null, error: null, timer: undefined }

  function loginSnapshot() {
    return {
      running: login.child !== undefined,
      url: login.url ?? null,
      startedAt: login.startedAt || null,
      exitCode: login.exitCode,
      error: login.error,
      output: login.tail.slice(-2000),
    }
  }

  function stopLogin(reason) {
    if (login.timer !== undefined) {
      clearTimeout(login.timer)
      login.timer = undefined
    }
    const child = login.child
    login.child = undefined
    if (child !== undefined) {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      login.error = reason ?? null
    }
  }

  function startLogin() {
    if (login.child !== undefined) throw new Error('登录流程已在进行中')
    const o = options()
    if (!fs.existsSync(o.zcodeCliPath)) throw new Error(`找不到 ZCode CLI：${o.zcodeCliPath}`)
    login = { child: undefined, url: undefined, tail: '', startedAt: Date.now(), exitCode: null, signal: null, error: null, timer: undefined }
    const child = spawn(o.zcodeCliNode, [o.zcodeCliPath, 'login', '--no-browser'], {
      cwd: o.cliCwd !== '' ? o.cliCwd : os.homedir(),
      env: childEnv(o),
      windowsHide: true,
    })
    login.child = child
    const consume = (chunk) => {
      const text = String(chunk)
      login.tail = (login.tail + text).slice(-4000)
      if (login.url === undefined) {
        const match = text.match(/https?:\/\/[^\s"'<>]+/)
        if (match !== null) login.url = match[0]
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', (error) => {
      login.error = `登录进程启动失败：${error?.message ?? error}`
      login.child = undefined
    })
    child.on('exit', (code, signal) => {
      login.exitCode = code
      login.signal = signal ?? null
      login.child = undefined
      if (login.timer !== undefined) {
        clearTimeout(login.timer)
        login.timer = undefined
      }
      logger?.info?.(`[zcode-panel] login 退出 code=${code}`)
    })
    login.timer = setTimeout(() => stopLogin('登录超时（10 分钟），已中止'), LOGIN_TIMEOUT_MS)
    login.timer.unref?.()
    logger?.info?.('[zcode-panel] 已启动 zcode login --no-browser')
    return loginSnapshot()
  }

  // ── BigModel OAuth（原生流程，不经过 zcode CLI）───────────────────────────
  //
  // 协议与 zcode.cjs 的 loginBigmodelCodingPlan 同源：zcode.z.ai 的 CLI OAuth 服务端
  // 本来就支持 provider="bigmodel"（它生成 bigmodel.cn/login 的授权 URL，回调整理与
  // 轮询都在 zcode.z.ai 侧），CLI 只是把 login 子命令写死成了 zai。这里直接说协议：
  //   POST {OAUTH_API}/oauth/cli/init {provider:"bigmodel"} + Bearer <随机 pollToken>
  //     -> {data:{flow_id, poll_token, authorize_url, expires_at, poll_interval_sec}}
  //   GET {OAUTH_API}/oauth/cli/poll/<flow_id> + Bearer <poll_token>
  //     -> {data:{status:"pending"|"ready"|"failed", bigmodel:{access_token,refresh_token},
  //              token:<zcodejwttoken>, user:{user_id,name,email}}}
  // 拿到 access_token 后按 CLI 同款流程换 coding-plan 的 api-key（那条"恰好一个分隔符"
  // 的签名凭证）：getCustomerInfo 选组织/项目 -> 找或建名为 "zcode" 的 api_keys。
  let bmFlow = { active: false, url: null, state: null, flowId: null, pollToken: null, expiresAt: 0, pollIntervalMs: 2000, status: 'idle', error: null, user: null, apiKeyWritten: false, pollTimer: undefined, stopRequested: false }

  function bmSnapshot() {
    return {
      active: bmFlow.active,
      status: bmFlow.status,
      url: bmFlow.url,
      state: bmFlow.state,
      expiresAt: bmFlow.expiresAt || null,
      error: bmFlow.error,
      user: bmFlow.user,
      apiKeyWritten: bmFlow.apiKeyWritten,
    }
  }

  function stopBmFlow(reason) {
    if (bmFlow.pollTimer !== undefined) {
      clearTimeout(bmFlow.pollTimer)
      bmFlow.pollTimer = undefined
    }
    bmFlow.active = false
    if (reason !== undefined) bmFlow.error = reason
  }

  /** 极简 https JSON 请求（POST/GET；只服务本模块的三个端点）。 */
  function httpJson(method, url, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers }, timeout: 30000 }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('网络超时')) })
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  /**
   * 用 BigModel 的 access_token 换 coding-plan api-key（复刻 zcode.cjs 的
   * resolveCodingPlanApiKey：Authorization 头**不带 Bearer**（xct 的原样），先
   * getCustomerInfo 选组织/项目，再在项目下找或建名为 "zcode" 的 api_keys）。
   * @returns {Promise<{apiKey: string, accountId: string}>}
   */
  async function resolveBigModelApiKey(accessToken) {
    const auth = { Authorization: accessToken, 'Content-Type': 'application/json' }
    const info = await httpJson('GET', `https://${BIGMODEL_API_HOST}/api/biz/customer/getCustomerInfo`, { headers: auth })
    if (info.status !== 200) throw new Error(`getCustomerInfo HTTP ${info.status}：${info.body.slice(0, 120)}`)
    let customer
    try { customer = JSON.parse(info.body) } catch { throw new Error('getCustomerInfo 响应不是 JSON') }
    // 响应形状兼容 {organizations:[...]} 与 {data:{organizations:[...]}}
    const orgs = customer?.organizations ?? customer?.data?.organizations ?? []
    const org = orgs.find((o) => (o?.organizationName ?? '').includes('个人')) ?? orgs[0]
    const projects = org?.projects ?? []
    const project = projects.find((p) => (p?.projectName ?? '').includes('默认')) ?? projects[0]
    if (!org?.organizationId || !project?.projectId) throw new Error('无法从 BigModel 账号解析组织/项目（可能没有可用项目）')
    const keysUrl = `https://${BIGMODEL_API_HOST}/api/biz/v1/organization/${org.organizationId}/projects/${project.projectId}/api_keys`
    const list = await httpJson('GET', keysUrl, { headers: auth })
    if (list.status !== 200) throw new Error(`api_keys 列表 HTTP ${list.status}：${list.body.slice(0, 120)}`)
    let keys
    try { keys = JSON.parse(list.body) } catch { throw new Error('api_keys 列表响应不是 JSON') }
    const existing = (Array.isArray(keys) ? keys : keys?.data ?? []).find((entry) => entry?.name === BIGMODEL_API_KEY_NAME)
    if (existing?.apiKey?.trim()) return { apiKey: existing.apiKey.trim(), accountId: String(project.projectId) }
    const created = await httpJson('POST', keysUrl, { headers: auth, body: JSON.stringify({ name: BIGMODEL_API_KEY_NAME }) })
    if (created.status !== 200 && created.status !== 201) throw new Error(`创建 api-key HTTP ${created.status}：${created.body.slice(0, 160)}`)
    let createdJson
    try { createdJson = JSON.parse(created.body) } catch { throw new Error('创建 api-key 响应不是 JSON') }
    const apiKey = createdJson?.apiKey?.trim() ?? createdJson?.data?.apiKey?.trim() ?? ''
    if (apiKey === '') throw new Error('创建 api-key 响应里没有 apiKey')
    return { apiKey, accountId: String(project.projectId) }
  }

  /** 把 poll ready 的结果写进共享凭证文件（与 CLI 的 saveMany 同一组键）。 */
  async function persistBigModelLogin(ready, apiKey) {
    const user = ready?.user ?? {}
    const accountId = String(user?.user_id ?? '')
    if (accountId === '') throw new Error('OAuth 响应里没有 user.user_id')
    const file = credentialsPath('')
    let raw = {}
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 文件不存在时从空开始 */ }
    const entries = {
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      'oauth:active_provider': 'bigmodel',
      'oauth:bigmodel:access_token': ready.bigmodel.access_token,
      ...(ready.bigmodel.refresh_token ? { 'oauth:bigmodel:refresh_token': ready.bigmodel.refresh_token } : {}),
      'oauth:bigmodel:user_info': JSON.stringify({ id: accountId, rawProfile: { user_id: accountId, name: user?.name ?? '', email: user?.email ?? '' } }),
      'zcodejwttoken': ready.token,
      [`account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:${accountId}:api-key`]: apiKey,
    }
    const tmp = `${file}.tmp-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return { accountId, username: user?.name ?? user?.email ?? accountId, credentialsPath: file }
  }

  function bmPollLoop() {
    if (!bmFlow.active || bmFlow.stopRequested) return
    bmFlow.pollTimer = setTimeout(async () => {
      if (!bmFlow.active || bmFlow.stopRequested) return
      try {
        const r = await httpJson('GET', `${OAUTH_API}/oauth/cli/poll/${encodeURIComponent(bmFlow.flowId)}`, { headers: { authorization: `Bearer ${bmFlow.pollToken}` } })
        if (r.status !== 200) throw new Error(`poll HTTP ${r.status}：${r.body.slice(0, 140)}`)
        let envelope
        try { envelope = JSON.parse(r.body) } catch { throw new Error('poll 响应不是 JSON') }
        const data = envelope?.data ?? envelope
        if (data?.status === 'ready') {
          bmFlow.status = 'exchanging'
          const access = data?.bigmodel?.access_token?.trim() ?? data?.bigmodel?.accessToken?.trim() ?? ''
          if (access === '') throw new Error('授权完成但响应里没有 bigmodel.access_token')
          const { apiKey } = await resolveBigModelApiKey(access)
          const persisted = await persistBigModelLogin({ token: data?.token ?? '', user: data?.user, bigmodel: { access_token: access, refresh_token: data?.bigmodel?.refresh_token ?? data?.bigmodel?.refreshToken ?? '' } }, apiKey)
          bmFlow.user = { userId: persisted.accountId, username: persisted.username }
          bmFlow.apiKeyWritten = true
          bmFlow.status = 'done'
          bmFlow.active = false
          logger?.info?.(`[zcode-panel] BigModel OAuth 完成：account=${persisted.accountId} user=${persisted.username}`)
          return
        }
        if (data?.status === 'failed') throw new Error(data?.msg ?? '授权失败（上游回 failed）')
        bmFlow.status = 'pending'
      } catch (error) {
        bmFlow.status = 'failed'
        bmFlow.error = error?.message ?? String(error)
        bmFlow.active = false
        logger?.warn?.(`[zcode-panel] BigModel OAuth 失败：${bmFlow.error}`)
        return
      }
      bmPollLoop()
    }, bmFlow.pollIntervalMs)
    bmFlow.pollTimer.unref?.()
  }

  async function startBigModelLogin() {
    if (bmFlow.active) throw new Error('BigModel 登录流程已在进行中')
    const pollToken = crypto.randomBytes(32).toString('hex')
    const init = await httpJson('POST', `${OAUTH_API}/oauth/cli/init`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${pollToken}` },
      body: JSON.stringify({ provider: 'bigmodel' }),
    })
    if (init.status !== 200) throw new Error(`oauth init HTTP ${init.status}：${init.body.slice(0, 140)}`)
    let data
    try { data = JSON.parse(init.body)?.data } catch { throw new Error('oauth init 响应不是 JSON') }
    if (!data?.authorize_url || !data?.flow_id) throw new Error('oauth init 响应缺 authorize_url/flow_id')
    bmFlow = {
      active: true, stopRequested: false,
      url: data.authorize_url, state: new URL(data.authorize_url).searchParams.get('state'),
      flowId: data.flow_id, pollToken: data.poll_token ?? pollToken,
      expiresAt: (data.expires_at ?? 0) * 1000,
      pollIntervalMs: Math.max(1000, (data.poll_interval_sec ?? 2) * 1000),
      status: 'pending', error: null, user: null, apiKeyWritten: false, pollTimer: undefined,
    }
    logger?.info?.('[zcode-panel] BigModel OAuth 流程已启动（flowId=…' + String(data.flow_id).slice(-6) + '）')
    bmPollLoop()
    return bmSnapshot()
  }

  // ── 状态采集 ──────────────────────────────────────────────────────────────
  /**
   * 账号列表：每个本地登录过的平台（zai / bigmodel）一条，标注平台、用户名、订阅与凭据形态。
   * 依据共享凭证文件里的 `oauth:<family>:user_info`、`oauth:active_provider` 与
   * `account-provider:…` 键聚合；不含任何密钥明文。
   */
  function accountView() {
    const base = baseDir()
    const file = credentialsPath(base === os.homedir() ? '' : base)
    const view = { credentialsPath: file, exists: false, updatedAt: null, activeProvider: null, jwt: null, accounts: [], error: null }
    let stat
    try {
      stat = fs.statSync(file)
      view.exists = true
      view.updatedAt = stat.mtime.toISOString()
    } catch {
      return view
    }
    let creds
    try {
      creds = readCredentials(base === os.homedir() ? '' : base)
    } catch (error) {
      view.error = error?.message ?? String(error)
      return view
    }
    view.activeProvider = typeof creds['oauth:active_provider'] === 'string' ? creds['oauth:active_provider'] : null
    view.jwt = describeSecret(creds.zcodejwttoken)

    // 每个平台一条：user_info 定身份，account-provider 键定订阅计划。
    // 键形如 account-provider:coding-plan:account:<mode>:account:<id>:api-key，
    // 其中 <mode> = bigmodel-individual-coding-plan / zai-start-plan / …，平台要从 mode 前缀取。
    const families = new Set()
    for (const key of Object.keys(creds)) {
      const m = key.match(/^oauth:([a-z]+):user_info$/)
      if (m) families.add(m[1])
      const p = key.split(':')
      if (p[0] === 'account-provider' && p[3]) families.add(p[3].split('-')[0])
    }
    if (families.size === 0 && view.jwt.present) families.add(view.activeProvider ?? 'zai')
    for (const family of families) {
      const account = {
        platform: family,                     // zai（国际站 Z.AI）/ bigmodel（中国站智谱）
        platformLabel: family === 'bigmodel' ? 'BigModel（中国站）' : 'Z.AI（国际站）',
        active: view.activeProvider === family,
        accountId: null,
        username: null,
        plans: [],
      }
      const raw = creds[`oauth:${family}:user_info`]
      if (typeof raw === 'string' && raw !== '') {
        try {
          const info = JSON.parse(raw)
          account.accountId = info?.id ?? info?.rawProfile?.user_id ?? null
          account.username = info?.username ?? info?.rawProfile?.name ?? info?.rawProfile?.email ?? null
        } catch { /* 非 JSON 忽略 */ }
      }
      for (const [key, value] of Object.entries(creds)) {
        const parts = key.split(':')
        if (parts[0] !== 'account-provider') continue
        const mode = parts[3] ?? ''            // bigmodel-individual-coding-plan / zai-start-plan / …
        if (mode.split('-')[0] !== family) continue
        const planKind = mode.split('-').slice(1).join('-')
        account.accountId = account.accountId ?? parts[5] ?? null
        account.plans.push({
          mode: planKind,                       // start-plan / individual-coding-plan / team-coding-plan
          accountId: parts[5] ?? null,
          key: describeSecret(value),
        })
      }
      view.accounts.push(account)
    }
    // 兜底：user_info 没写时从 account-provider 的 accountId 补
    if (view.accounts.length === 1 && view.accounts[0].accountId === null && view.accounts[0].plans.length > 0) {
      view.accounts[0].accountId = view.accounts[0].plans[0].accountId
    }
    return view
  }

  /** 运行时一览（压缩成一行字段，给页面底部小字）。 */
  function runtimeView() {
    const o = options()
    const builtin = resolveBuiltinRuntime(o.zcodeDataBaseDir || undefined)
    const exists = (p) => {
      try {
        return fs.existsSync(p)
      } catch {
        return false
      }
    }
    const ok = exists(o.zcodeCliPath) && exists(o.zcodeCliNode) && builtin !== undefined
    return {
      ok,
      builtinVersion: builtin?.version ?? null,
      cliPath: o.zcodeCliPath,
      cliExists: exists(o.zcodeCliPath),
      cliNode: o.zcodeCliNode,
      cliNodeExists: exists(o.zcodeCliNode),
      dataBaseDir: baseDir(),
    }
  }

  /**
   * 家族匹配诊断：插件注入的 provider 由配置 startPlanProviderId 决定（缺省上游的
   * account:zai-start-plan）。凭证里的 `oauth:active_provider` 才是当前账号真正所属的
   * 家族；两者不一致时上游会拒（实测 zai↔bigmodel：1005 exceed quota limit / 401）。
   */
  function channelView(account) {
    const providerId = startPlanProviderId()
    const providerFamily = providerId.replace(/^account:/, '').split('-')[0]
    const planKind = providerId.replace(/^account:/, '').split('-').slice(1).join('-')
    const accountFamily = account.activeProvider ?? account.accounts[0]?.platform ?? null
    const familyMatches = accountFamily === null ? null : accountFamily === providerFamily
    const models = providerId.includes('coding-plan')
      ? ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.3-FlashX']
      : ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']
    const planLabel = planKind === 'individual-coding-plan' ? '标准订阅（Coding Plan）' : 'Start Plan'
    return {
      injectedProviderId: providerId,
      injectedPlanKind: planKind,
      injectedPlanLabel: planLabel,
      injectedModels: models,
      injectedFamily: providerFamily,
      accountFamily,
      familyMatches,
      hint: familyMatches === false
        ? `当前登录的是 ${accountFamily} 平台的账号，而通道注入的是 ${providerFamily} 家族的 ${providerId} —— 上游会拒绝。请登录 ${providerFamily} 平台账号，或把配置 startPlanProviderId 改成 account:${accountFamily}-${planKind}。`
        : '',
    }
  }

  function statusView() {
    const account = accountView()
    return {
      ok: true,
      at: new Date().toISOString(),
      account,
      channel: channelView(account),
      runtime: runtimeView(),
      lastFailure: lastUpstreamFailure(baseDir()) ?? null,
      login: loginSnapshot(),
      loginBigmodel: bmSnapshot(),
    }
  }

  // ── 账号余额 ──────────────────────────────────────────────────────────────
  // 标准订阅（coding plan）：open.bigmodel.cn /api/biz/subscription/list（套餐）+
  //   /api/monitor/usage/quota/limit（额度余量，authorization = apiKeyId.secret）。
  // Start Plan（zai 计划）：zcode.z.ai /api/v1/zcode-plan/billing/current（套餐）+
  //   /billing/balance（额度桶；必须带 X-Device-Mid 头，否则 400 parameter error）。
  /** bigmodel/zai 标准订阅的完整签名凭证（apiKeyId.secret，带内存缓存）。 */
  const fullKeyCache = new Map()
  async function codingPlanFullKey(creds, bareKey, accessToken) {
    if (typeof bareKey !== 'string' || bareKey === '') return null
    if (bareKey.includes('.')) return bareKey
    const cached = fullKeyCache.get(bareKey)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    try {
      const auth = { Authorization: accessToken, 'Content-Type': 'application/json' }
      const info = await httpJson('GET', `https://${BIGMODEL_API_HOST}/api/biz/customer/getCustomerInfo`, { headers: auth })
      if (info.status !== 200) throw new Error(`getCustomerInfo HTTP ${info.status}`)
      const parsed = JSON.parse(info.body)
      const orgs = parsed?.organizations ?? parsed?.data?.organizations ?? []
      const org = orgs.find((o) => (o?.organizationName ?? '').includes('个人')) ?? orgs.find((o) => (o?.organizationName ?? '').includes('默认')) ?? orgs[0]
      const projects = (org?.projects ?? []).filter((p) => String(p?.projectType ?? '').trim() !== '2')
      const project = projects.find((p) => (p?.projectName ?? '').includes('默认')) ?? projects[0]
      if (!org?.organizationId || !project?.projectId) throw new Error('无法解析组织/项目')
      const listUrl = `https://${BIGMODEL_API_HOST}/api/biz/v1/organization/${org.organizationId}/projects/${project.projectId}/api_keys`
      const list = await httpJson('GET', listUrl, { headers: auth })
      if (list.status !== 200) throw new Error(`api_keys HTTP ${list.status}`)
      const keys = JSON.parse(list.body)
      const entries = Array.isArray(keys) ? keys : keys?.data ?? []
      const entry = entries.find((item) => item?.apiKey === bareKey) ?? entries[0]
      if (!entry?.apiKey) throw new Error('api_keys 列表为空')
      const copy = await httpJson('GET', `${listUrl}/copy/${encodeURIComponent(entry.apiKey)}`, { headers: auth })
      const secret = (JSON.parse(copy.body)?.data?.secretKey ?? '').trim()
      if (copy.status !== 200 || secret === '') throw new Error(`copy secret HTTP ${copy.status}`)
      const full = `${entry.apiKey}.${secret}`
      fullKeyCache.set(bareKey, { value: full, expiresAt: Date.now() + 6 * 3600 * 1000 })
      return full
    } catch {
      return null
    }
  }

  async function bigmodelBalance(creds) {
    const accessToken = creds['oauth:bigmodel:access_token'] ?? ''
    const out = { platform: 'bigmodel', subscription: null, quota: null, error: null }
    if (accessToken === '') { out.error = '没有 bigmodel OAuth 凭证（未登录）'; return out }
    const auth = { Authorization: accessToken, 'Content-Type': 'application/json' }
    try {
      const sub = await httpJson('GET', `https://${BIGMODEL_API_HOST}/api/biz/subscription/list`, { headers: auth })
      if (sub.status === 200) {
        const payload = JSON.parse(sub.body)
        const list = Array.isArray(payload?.data) ? payload.data : []
        const active = list.filter((item) => item?.status === 'VALID' && item?.inCurrentPeriod !== false)
        out.subscription = active.map((item) => ({
          productName: item?.productName ?? null,
          billingCycle: item?.billingCycle ?? null,
          valid: item?.valid ?? null,
          nextRenewTime: item?.nextRenewTime ?? null,
        }))
      }
    } catch (error) { out.error = `订阅查询失败：${error?.message ?? error}` }
    // 额度余量：需要 apiKeyId.secret 签名凭证
    try {
      const bareKey = Object.entries(creds).find(([name]) => name.startsWith('account-provider:') && name.includes(':bigmodel-individual-coding-plan:'))?.[1] ?? ''
      const fullKey = await codingPlanFullKey(creds, bareKey, accessToken)
      if (fullKey === null) throw new Error('无法组签名凭证（api-key 缺失或 copy secret 失败）')
      const quota = await httpJson('GET', `https://${BIGMODEL_API_HOST}/api/monitor/usage/quota/limit`, { headers: { authorization: fullKey } })
      const payload = quota.status === 200 ? JSON.parse(quota.body) : null
      if (payload?.code === 200 && Array.isArray(payload?.data?.limits)) {
        out.quota = payload.data.limits.map((limit) => ({
          type: limit.type,
          level: payload.data.level ?? null,
          unit: limit.number ?? null,
          used: limit.usage ?? limit.currentValue ?? null,
          remaining: limit.remaining ?? null,
          percentage: limit.percentage ?? null,
          nextResetTime: typeof limit.nextResetTime === 'number' ? new Date(limit.nextResetTime).toISOString() : null,
        }))
      } else {
        out.error = out.error ?? `额度查询失败：${payload?.msg ?? `HTTP ${quota.status}`}`
      }
    } catch (error) { out.error = out.error ?? `额度查询失败：${error?.message ?? error}` }
    return out
  }

  async function zaiBalance(creds) {
    const jwt = creds['zcodejwttoken'] ?? ''
    const out = { platform: 'zai', subscription: null, quota: null, error: null }
    if (jwt === '') { out.error = '没有 zcodejwttoken（未登录）'; return out }
    const headers = { Authorization: `Bearer ${jwt}`, 'X-Device-Mid': crypto.randomUUID() }
    try {
      const current = await httpJson('GET', `${OAUTH_API}/zcode-plan/billing/current?app_version=${encodeURIComponent(resolveBuiltinRuntime(options().zcodeDataBaseDir || undefined)?.version ?? '3.14.4')}`, { headers })
      const payload = current.status === 200 ? JSON.parse(current.body) : null
      const plans = payload?.data?.plans ?? []
      out.subscription = plans.map((plan) => ({
        productName: plan?.name ?? 'Start Plan',
        status: plan?.status ?? null,
        endsAt: typeof plan?.ends_at === 'number' ? new Date(plan.ends_at * 1000).toISOString() : null,
      }))
    } catch (error) { out.error = `套餐查询失败：${error?.message ?? error}` }
    try {
      const balance = await httpJson('GET', `${OAUTH_API}/zcode-plan/billing/balance?app_version=${encodeURIComponent(resolveBuiltinRuntime(options().zcodeDataBaseDir || undefined)?.version ?? '3.14.4')}`, { headers })
      const payload = balance.status === 200 ? JSON.parse(balance.body) : null
      const buckets = payload?.data?.balances ?? []
      out.quota = buckets.map((bucket) => ({
        type: bucket?.show_name ?? bucket?.meter ?? 'model_usage',
        models: (bucket?.capabilities ?? []).map((c) => String(c).replace(/^model:/, '')),
        unit: typeof bucket?.total_units === 'number' ? bucket.total_units : null,
        used: typeof bucket?.used_units === 'number' ? bucket.used_units : null,
        remaining: typeof bucket?.remaining_units === 'number' ? bucket.remaining_units : null,
        nextResetTime: typeof bucket?.expires_at === 'number' ? new Date(bucket.expires_at * 1000).toISOString() : null,
      }))
    } catch (error) { out.error = out.error ?? `额度查询失败：${error?.message ?? error}` }
    return out
  }

  async function balanceView() {
    const base = baseDir()
    let creds = {}
    try { creds = readCredentials(base === os.homedir() ? '' : base) } catch { return { ok: false, error: '凭证文件读取失败（未登录？）', at: new Date().toISOString(), items: [] } }
    const families = new Set()
    for (const key of Object.keys(creds)) {
      const m = key.match(/^oauth:([a-z]+):user_info$/)
      if (m) families.add(m[1])
      const p = key.split(':')
      if (p[0] === 'account-provider' && p[3]) families.add(p[3].split('-')[0])
    }
    const items = []
    for (const family of families) {
      if (family === 'bigmodel') items.push(await bigmodelBalance(creds))
      else if (family === 'zai') items.push(await zaiBalance(creds))
    }
    return { ok: true, at: new Date().toISOString(), items }
  }

  // ── 通道测试 ──────────────────────────────────────────────────────────────
  async function runTest() {
    const o = options()
    if (!o.enabled) throw new Error('插件总开关是关的（配置项 enabled=false）')
    if (!fs.existsSync(o.zcodeCliPath)) throw new Error(`找不到 ZCode CLI：${o.zcodeCliPath}`)
    const adapter = new ZcodeAppServerAdapter({ options, logger })
    const modelId = o.cliModels.find((m) => !m.id.endsWith('-start-plan'))?.id ?? o.cliModels[0]?.id ?? 'glm-5.3-flash'
    const result = { ok: false, modelId, text: '', usage: null, channel: null, finish: null, error: null, elapsedMs: 0 }
    const startedAt = Date.now()
    let timer
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`测试超时（${TEST_TIMEOUT_MS / 1000}s）`)), TEST_TIMEOUT_MS)
        timer.unref?.()
      })
      const run = (async () => {
        for await (const chunk of adapter.stream({
          provider: 'zcode-cli',
          model: modelId,
          sessionId: `panel-test-${Date.now()}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：就绪' }] }],
        })) {
          if (chunk.type === 'text-delta') result.text += chunk.text
          if (chunk.type === 'usage') result.usage = chunk.usage
          if (chunk.type === 'finish') {
            result.finish = chunk.reason
            result.channel = chunk.replayState?.channel ?? null
          }
        }
      })()
      await Promise.race([run, deadline])
      result.ok = result.finish?.kind === 'stop'
    } catch (error) {
      result.error = error?.message ?? String(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      try {
        adapter.dispose()
      } catch {
        /* 已经退了 */
      }
      result.elapsedMs = Date.now() - startedAt
    }
    return result
  }

  // ── 注册路由 ──────────────────────────────────────────────────────────────
  ctx.inject(['webServer'], (web) => {
    const route = (method, routePath, handler, label) => {
      web.effect(() => web.webServer.register({
        kind: 'exact',
        path: ROUTE_PREFIX + routePath,
        handler: (req, res) => {
          if (req.method !== method) return sendError(res, 405, 'Method Not Allowed')
          if (!sameOrigin(req)) return sendError(res, 403, 'cross-origin request rejected')
          Promise.resolve()
            .then(() => (method === 'POST' ? readBody(req).then(() => undefined) : undefined))
            .then(() => handler(req))
            .then((value) => sendJson(res, 200, value))
            .catch((error) => {
              logger?.warn?.(`[zcode-panel] ${label} 失败：${error?.message ?? error}`)
              sendError(res, 500, error)
            })
        },
      }), `dsh-zcode-cli-proxy ${label}`)
    }

    route('GET', '/status', () => statusView(), 'status')
    route('GET', '/balance', () => balanceView(), 'balance')
    route('GET', '/login/state', () => loginSnapshot(), 'login state')
    route('POST', '/login/start', () => startLogin(), 'login start')
    route('POST', '/login/cancel', () => {
      stopLogin('已取消')
      return loginSnapshot()
    }, 'login cancel')
    route('GET', '/login/bigmodel/state', () => bmSnapshot(), 'bigmodel login state')
    route('POST', '/login/bigmodel/start', () => startBigModelLogin(), 'bigmodel login start')
    route('POST', '/login/bigmodel/cancel', () => {
      bmFlow.stopRequested = true
      stopBmFlow('已取消')
      return bmSnapshot()
    }, 'bigmodel login cancel')
    route('POST', '/test', () => runTest(), 'channel test')

    web.effect(() => () => {
      stopLogin('插件已卸载')
      bmFlow.stopRequested = true
      stopBmFlow('插件已卸载')
    }, 'dsh-zcode-cli-proxy login children')
    logger?.info?.(`[zcode-panel] 设置页路由已注册：${ROUTE_PREFIX}/{status,login/*,test}`)
  })

  // 顺带把登录子进程状态打到日志，便于确认页面动作真的发生了
  logger?.info?.(`[zcode-panel] 宿主半边就绪（凭证目录 ${baseDir()}）`)
  void sleep
}
