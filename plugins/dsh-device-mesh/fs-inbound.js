/**
 * dsh-device-mesh — 远端文件系统原语（**入站**侧，即「被当子节点用的那一台」执行的代码）。
 *
 * ── 这一层的职责边界 ────────────────────────────────────────────────────────
 * 主机侧的 `MeshFileSystem` 把「读/写/编辑一个远端文件」翻译成这里的一条请求；本模块
 * 只做一件事：拿**本机自己的** `ctx.fs` 把它落地，然后把结果如实回传。
 *
 * 关键设计：**不自己实现文件语义**。realpath、符号链接跟随、文本/二进制判定、
 * 大小上限、原子写、版本令牌——全部交给本机 `ctx.fs`。所以主机看到的「远端文件系统
 * 行为」和**对端自己跑工具时**的行为逐字一致：对端的沙箱策略、对端的路径解析规则、
 * 对端的版本令牌，都不会被主机代为解释。
 *
 * 为此这里取的是 `ctx.fs.localDelegate`（本插件的路由实现内部持有的、隔离 realm 里的
 * 出厂实现）。直接 `ctx.get('fs')` 会拿到**本插件的路由实现**，那会把请求再路由一次
 * ——对端如果自己也接了别的节点，就会二次转发。取 localDelegate 才是「就地在本地做」。
 *
 * ── 两道门：谁能访问，以及能访问哪里 ────────────────────────────────────────
 * 这里**不**自己判权限。`gate(auth, path, label)` 由入口提供，它一次做完四件事：
 *   ① 要求对端已经 join 过（否则让它重新 join）；
 *   ② 刷新节点活跃时间；
 *   ③ `checkAuthority`：`allowRemoteExec` 总开关 + `execTrust` 信任级别；
 *   ④ `checkFsPath`：路径必须落在本机**导出根**内（并且挡掉符号链接逃逸）。
 * 被门拒掉的尝试会写进审计——失败审计比成功审计更有价值。
 *
 * 为什么文件访问复用「执行权限」这套门：读写对端文件与在对端跑命令是同一量级的权力，
 * 给它单独一套更松的规则没有道理。收紧只需把 `execTrust` 改成 `grant-required`。
 *
 * ── 错误怎么过网 ────────────────────────────────────────────────────────────
 * 对端的 `FsError` 带机器可读的 code（`FS_NOT_FOUND` / `FS_STALE_VERSION` / …），
 * 上层靠 code 分支而不是解析文案。但本 profile 的 HTTP 失败通道只白名单携带少数几个
 * 附加字段（见 `failureOf`），硬塞新字段会被丢掉。
 *
 * 所以这里**刻意不抛**：文件系统层面的失败一律以 `{failed: true, fsCode, message}`
 * 的 200 响应回传，由主机侧重建成同码的 `FsError`。只有**门**的拒绝（权限/导出根）
 * 才走 HTTP 错误状态——那两类不是「文件操作失败」，而是「你根本不该碰这里」。
 *
 * @module dsh-device-mesh/fs-inbound
 */

import { FsVersion } from '@deepseek-ai/dsh-fs'

/** 一次读取允许回传的最大字节数（base64 前的原始字节）。 */
const READ_MAX_BYTES = 8 * 1024 * 1024

/**
 * 造一个带 HTTP 状态与协议码的错误——`failureOf` 按鸭子类型读这两个字段，
 * 所以不需要引用入口里的 HttpError 类。
 *
 * @param {number} status HTTP 状态码。
 * @param {string} message 给人看的说明。
 * @param {string} code 协议错误码。
 * @returns {Error} 带 status / code 的错误。
 */
function httpError(status, message, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/**
 * 取一个必填字符串字段。
 * @param {unknown} value 原值。
 * @param {string} name 字段名（报错用）。
 * @returns {string} 字符串值。
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw httpError(400, `${name} 不能为空`, 'bad-request')
  }
  return value
}

/**
 * 把 `FsInfo` / `FsPathInfo` 压成可过网的形状。缺席如实报 `exists:false`，
 * 而不是伪造一个空对象让主机去猜。
 *
 * @param {object|undefined} info 元数据，`undefined` 表示不存在。
 * @returns {{exists: boolean, type?: string, size?: number|null, version?: string}} 线形状。
 */
function describeInfo(info) {
  if (info === undefined || info === null) return { exists: false }
  return {
    exists: true,
    type: typeof info.type === 'string' ? info.type : 'other',
    size: Number.isFinite(info.size) ? info.size : null,
    version: info.version === undefined ? undefined : String(info.version),
  }
}

/**
 * 把线上的守卫意图还原成出厂形状（版本令牌要重新打上品牌）。
 * @param {unknown} expected 线上意图。
 * @returns {object|undefined} 出厂意图。
 */
function writeIntent(expected) {
  if (expected === null || typeof expected !== 'object') return undefined
  if (expected.kind === 'createIfAbsent') return { kind: 'createIfAbsent' }
  if (expected.kind === 'replaceIfVersion' && typeof expected.version === 'string') {
    return { kind: 'replaceIfVersion', version: FsVersion(expected.version) }
  }
  return undefined
}

/**
 * 挂载远端文件系统原语路由。
 *
 * @param {object} options 依赖。
 * @param {Function} options.registerRoute 入口的路由注册器。
 * @param {Function} options.inbound 入口的签名鉴权包装器。
 * @param {object} options.API 协议路径表。
 * @param {object} options.CODE 协议错误码表。
 * @param {object} options.ctx 插件上下文（子节点这边）。
 * @param {(auth: object, path: string, label: string) => string} options.gate 授权 + 会话权限闸；返回可用的绝对路径。
 * @param {(auth: object) => (object|undefined)} [options.permissionOf] 取请求里的会话权限（写类操作用它对齐本机沙箱）。
 * @param {object} [options.logger] 日志器。
 * @returns {void}
 */
export function mountFsInbound({ registerRoute, inbound, API, CODE, ctx, gate, logger, permissionOf }) {
  /**
   * 取「就地在本地做」的文件系统实现。
   * @returns {object} 本机出厂实现。
   */
  const localFs = () => {
    const service = ctx.get('fs')
    if (service === undefined || service === null) {
      throw httpError(503, '本机没有可用的文件系统服务', CODE.internal)
    }
    // 本插件的路由实现会把出厂实现挂在 localDelegate 上；没有就说明 fs 不是我们接管的，
    // 直接用服务本身（此时它本来就没有路由能力，不会二次转发）。
    return service.localDelegate ?? service
  }

  /**
   * 把请求里的**会话权限**翻成一次性的本机沙箱策略（**尽力而为**）。
   *
   * 为什么值得做：`dsh-fs-sandbox` 的 `writeText(target, content, expected, signal,
   * sandboxPolicy)` 会用这个策略去 `checkedTarget()` —— 传进去，本机的写边界就与
   * 请求的 mode 一致（会话端说 read-only，本机沙箱也按 read-only 挡）；不传，本机只会
   * 按**属主自己的**策略办，于是「网格层拒绝了、本机沙箱却以为自己在 workspace-write」
   * 这种不一致就会留在日志里。
   *
   * **做不到的部分如实说**：本机沙箱策略由 `dsh-sandbox-policy` 解析，它按**会话对象**
   * 取覆盖值；这里只有一个跨设备请求，没有可传的会话对象，所以 mode 与 workspaceRoot
   * 由我们**显式指定**，其余字段沿用服务给出的默认。若本机 fs 不是沙箱实现（或服务缺席），
   * 这里返回 `undefined`，调用方就不传第 5 个参数 —— 那时**只有网格层在判权限**。
   *
   * @param {object} auth 入站认证材料（含 body）。
   * @returns {object|undefined} 一次性沙箱策略。
   */
  const sandboxPolicyFor = (auth) => {
    try {
      const permission = typeof permissionOf === 'function' ? permissionOf(auth) : undefined
      if (permission === undefined || typeof permission.mode !== 'string' || permission.mode === '') return undefined
      const service = ctx.get('sandboxPolicy')
      const resolved = typeof service?.resolve === 'function' ? service.resolve({ mode: permission.mode }) : undefined
      if (resolved === null || typeof resolved !== 'object') return undefined
      const root = typeof permission.workspaceRoot === 'string' && permission.workspaceRoot !== ''
        ? permission.workspaceRoot
        : resolved.workspaceRoot
      return { ...resolved, mode: permission.mode, workspaceRoot: root }
    } catch (error) {
      logger?.warn?.(`dsh-device-mesh: 构造本机沙箱策略失败，本机按自己的策略落地：${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * 把一次文件操作包成「门拒走 HTTP 错误、文件失败走 200 信封」的处理器。
   *
   * 两类失败刻意分开：门拒（没授权 / 不在导出根）是**访问控制**问题，对端应当看到
   * 明确的拒绝码并在审计里留痕；而文件不存在、版本过期是**操作结果**，必须原样带回
   * 机器可读的 FsError 码，否则上层的重试/权限分支就瞎了。
   *
   * @param {string} label 诊断标签。
   * @param {Function} fn 真正干活的回调 `(fs, body, safePath) => Promise<object>`。
   * @returns {Function} 入站处理器。
   */
  const op = (label, fn) => async (auth) => {
    const body = auth.body ?? {}
    const rawPath = requireString(body.path, 'path')
    // 门：不在导出根内 / 没被授权 → 抛 ExecError，走 HTTP 错误 + 审计。
    const safePath = gate(auth, rawPath, label)
    try {
      const fs = localFs()
      // 第四个参数把 uth 透给写类操作（它们要按请求的会话权限构造一次性沙箱策略）。
      return await fn(fs, body, safePath, auth)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      const fsCode = code.startsWith('FS_') ? code : ''
      if (fsCode === '') {
        // 不是文件系统语义失败（没有 fs 服务、内部异常）：照常走 HTTP 错误。
        throw error
      }
      if (fsCode !== 'FS_NOT_FOUND') {
        logger?.warn?.(`dsh-device-mesh: 入站 ${label} 失败（${fsCode}）：${error.message}`)
      }
      /**
       * 出厂 `dsh-fs-local` 的 `listDirectory` 逐子项走 `resolveLocalTarget(cwd, name)`，
       * 而它开头就是 `if (path.trim().length === 0) throw` —— 于是**一个纯空白文件名**
       * （`"\t"`、一串空格，都是合法 POSIX 名字）会让**整个目录列举**抛这条消息；
       * 而 `listingIoError` 对已是 FsError 的错误**原样透传**，所以文案看起来像
       * 「路径根本没传过来」，排查时极容易被误判到参数管道上（本插件作者实测踩过）。
       *
       * 不改上游就不该让使用者对着这句话发懵：翻译成可行动的说法，原始文案留在末尾。
       */
      const rawMessage = String(error?.message ?? error)
      const whitespaceName = rawMessage === 'file_path must be a non-empty string'
      const message = whitespaceName
        ? `${label}：远端目录里存在「纯空白文件名」的条目，出厂文件系统实现无法列举该目录`
          + '（dsh-fs-local 按 trim 后的长度判空，而空白名是合法文件名）。'
          + `把那些条目改名即可，空目录与正常目录不受影响。[${rawMessage}]`
        : rawMessage
      if (whitespaceName) logger?.warn?.(`dsh-device-mesh: 入站 ${label} 遇到纯空白文件名目录`)
      return { failed: true, fsCode, message }
    }
  }

  // ── 元数据 ────────────────────────────────────────────────────────────────
  registerRoute('route:api-fs-stat', API.fsStat, inbound('fs/stat', API.fsStat, op('fs/stat', async (fs, body, safePath) => {
    const target = await fs.resolve(safePath, { cwd: body.cwd })
    return { info: describeInfo(await fs.stat(target)) }
  })))

  registerRoute('route:api-fs-lstat', API.fsLstat, inbound('fs/lstat', API.fsLstat, op('fs/lstat', async (fs, body, safePath) => {
    const info = await fs.lstat(safePath, { cwd: body.cwd })
    return { info: describeInfo(info) }
  })))

  // ── 读 ────────────────────────────────────────────────────────────────────
  registerRoute('route:api-fs-read', API.fsRead, inbound('fs/read', API.fsRead, op('fs/read', async (fs, body, safePath) => {
    const target = await fs.resolve(safePath, { cwd: body.cwd })
    const mode = body.mode === 'bytes' ? 'bytes' : 'text'
    if (mode === 'text') {
      const text = await fs.readText(target)
      return { kind: 'text', text }
    }
    const offset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : undefined
    const length = Number.isSafeInteger(body.length) && body.length > 0 ? body.length : undefined
    const maxBytes = Number.isSafeInteger(body.maxBytes) && body.maxBytes > 0
      ? Math.min(body.maxBytes, READ_MAX_BYTES)
      : READ_MAX_BYTES
    const bytes = offset !== undefined && length !== undefined
      ? await fs.readByteRange(target, { offset, length })
      : await fs.readBytes(target, undefined, maxBytes)
    return { kind: 'bytes', base64: Buffer.from(bytes).toString('base64') }
  })))

  // ── 列目录 ────────────────────────────────────────────────────────────────
  registerRoute('route:api-fs-listdir', API.fsListDir, inbound('fs/listdir', API.fsListDir, op('fs/listdir', async (fs, body, safePath) => {
    const target = await fs.resolve(safePath, { cwd: body.cwd })
    const entries = await fs.listDir(target)
    return {
      entries: (Array.isArray(entries) ? entries : []).map((entry) => ({
        name: String(entry?.name ?? ''),
        type: typeof entry?.type === 'string' ? entry.type : 'other',
        size: Number.isFinite(entry?.size) ? entry.size : null,
        version: entry?.version === undefined ? undefined : String(entry.version),
      })),
    }
  })))

  // ── 写 / 改 ───────────────────────────────────────────────────────────────
  // 写类操作**多传一个**一次性的沙箱策略（见 sandboxPolicyFor 的说明）。
  // 只在委托实现真的接受第 5 个参数时才传（`dsh-fs-sandbox` 接受，`dsh-fs-local` 只有
  // 4 个参数）—— 用 `length` 探这一点，比假定「一定沙箱化」稳。
  registerRoute('route:api-fs-write', API.fsWrite, inbound('fs/write', API.fsWrite, op('fs/write', async (fs, body, safePath, auth) => {
    if (typeof body.content !== 'string') throw httpError(400, 'content 必须是字符串', 'bad-request')
    const target = await fs.resolve(safePath, { cwd: body.cwd })
    const policy = fs.writeText.length >= 5 ? sandboxPolicyFor(auth) : undefined
    const outcome = policy === undefined
      ? await fs.writeText(target, body.content, writeIntent(body.expected))
      : await fs.writeText(target, body.content, writeIntent(body.expected), undefined, policy)
    return {
      operation: outcome.operation,
      version: String(outcome.version),
      before: outcome.before ?? null,
      after: outcome.after ?? null,
    }
  })))

  registerRoute('route:api-fs-edit', API.fsEdit, inbound('fs/edit', API.fsEdit, op('fs/edit', async (fs, body, safePath, auth) => {
    const oldString = typeof body.oldString === 'string' ? body.oldString : ''
    if (oldString === '') throw httpError(400, 'oldString 不能为空', 'bad-request')
    const edit = {
      oldString,
      newString: typeof body.newString === 'string' ? body.newString : '',
      replaceAll: body.replaceAll === true,
    }
    const expected = typeof body.expectedVersion === 'string'
      ? { version: FsVersion(body.expectedVersion) }
      : undefined
    const target = await fs.resolve(safePath, { cwd: body.cwd })
    const policy = fs.editText.length >= 5 ? sandboxPolicyFor(auth) : undefined
    const outcome = policy === undefined
      ? await fs.editText(target, edit, expected)
      : await fs.editText(target, edit, expected, undefined, policy)
    return {
      version: String(outcome.version),
      before: outcome.before ?? '',
      after: outcome.after ?? '',
    }
  })))
}
