/**
 * dsh-workspace-plugins —— 「只对指定工作区生效的插件」容器（host 半边）。
 *
 * 解决的问题：DSH 的组合行（host 平面）是进程级的——一行插件对所有会话生效；
 * agent preset 是会话级的——但一个 preset 覆盖整场会话（工具/提示词/skill 全换），
 * 没法表达「这个插件只加在**这个工作区**的会话上」。本插件补的正是中间那一格：
 * 一次声明（或设置页一次点击）＝ 把若干个普通插件挂到某个工作区的会话作用域里。
 *
 * 生效范围（机制见 ./mount.js 头注释）：
 *   · 命中判定＝会话 `header.cwd` 与声明路径比对（精确或子树，realpath 口径）；
 *   · 挂载点＝该会话自己的 `agent.ctx`，因此工具、提示词段、agent 作用域事件
 *     只对该会话可见，会话结束随之卸载，哥哥会话/其它工作区完全不受影响；
 *   · 未命中＝一行都不挂，零副作用。
 *
 * 两处清单，合并成一份有效清单（见 ./store.js 的 mergeWorkspaces）：
 *   ① 组合行 config.workspaces —— 部署方写死在 profile 的 cordis.patch.yml，
 *      设置页只读展示（可停用，停用标记写状态文件，不改组合文件）；
 *   ② $DSH_HOME/workspace-plugins.json —— 设置页管理（增删改/启停），原子写。
 *
 * 设置页入口：设置 →「工作区插件」（本插件 client.js，order 30）。
 * 同源路由（全部带跨站守卫——写路由等于「让 host 加载你指定的模块」，
 * 是本插件权限面最大的一处，守卫按 dsh-workspace-context v2 的严格档处理）：
 *   GET  /dsh-workspace-plugins/state[?cwd=…]   全量视图（清单/挂载/模块/诊断）
 *   GET  /dsh-workspace-plugins/status          精简自检（能力、计数、最后错误）
 *   POST /dsh-workspace-plugins/save            覆盖写状态文件并重挂
 *   POST /dsh-workspace-plugins/reload          重读状态文件 + 重新预导入 + 重挂
 *   POST /dsh-workspace-plugins/probe           只导入一个模块看形态，不挂载
 *   POST /dsh-workspace-plugins/remount         强制重挂（可只给一个 sessionId）
 *
 * 组合行（profile 的 cordis.patch.yml）：
 *   - insert:
 *       - id: workspace-plugins
 *         name: ./plugins/dsh-workspace-plugins/index.js
 *         config:
 *           workspaces:
 *             - path: /root/DSHpluginWorkSpace
 *               match: exact            # exact（缺省）| subtree
 *               plugins:
 *                 - id: probe
 *                   name: ./plugins/dsh-workspace-plugins/examples/probe-tool.js
 *
 * 维护：本 profile 未开模块热载，loader 按 specifier 缓存模块——改**本插件**的
 * 实现要让运行实例生效，需换下面的 name（指向新文件）或重启 dsh；只改 config
 * 是安全的（loader 走同 id 的 dispose→start）。改**被挂载的子插件**同理。
 *
 * @module dsh-workspace-plugins
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  STATE_VERSION,
  blankState,
  canonicalPath,
  defaultStatePath,
  disableKeyOf,
  emptyMeshIndex,
  emptyRegistryIndex,
  mergeWorkspaces,
  message,
  jsonSafe,
  matchWorkspace,
  normalizeState,
  normalizeWorkspace,
  readStateFile,
  resolveWorkspaces,
  rowKey,
  workspaceKeyOf,
  workspaceSignature,
  writeStateFile,
} from './store.js?v=wsp-7';   // 热挂版本标记：与 entry-v7.js、BUILD 一起 +1
import { createRuntime } from './mount.js?v=wsp-7';

/** 插件名（出现在 loader 诊断与设置页）。 */
export const name = 'workspace-plugins';

/**
 * 不声明硬依赖：挂载机制不需要任何服务，整行不该因为 webServer 缺席而 entering waiting
 * （那会把挂载一起拖住）。设置页路由改用 `ctx.inject(['webServer'], ...)` 等它出现。
 */
export const inject = [];

const ROUTE_PREFIX = '/dsh-workspace-plugins';
/**
 * 实现版本标记（诊断回显）。
 *
 * 这个 profile 没有模块热载：loader 与 Node ESM 都按 specifier/URL 缓存模块。要让
 * 改动生效，需要 ①在 index.js / mount.js / store.js 之间的相对导入上加 `?v=` 查询串
 * （Node ESM 按完整 URL 缓存，查询串不同即重读磁盘），②新写一个 entry-v<N>.js 只做
 * `export * from './index.js?v=<同样标记>'`，③把 patch 行的 name 指过去。
 * 改实现时三处标记一起 +1（并改这里），设置页与 /status 会显示它——一眼确认页面上
 * 跑的是哪一版，省得对着旧实例排查。
 */
const BUILD = 'wsp-7';

/**
 * 归一 apply 的 config。loader 已保证是对象，这里再夹一遍取值边界，
 * 并把非法声明收集成 errors 交给设置页（不抛，避免整层组合回滚）。
 * @param config - 组合行 config。
 * @returns `{ file, configDecls, errors }`。
 */
function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const errors = [];
  let file;
  if (input.file !== undefined && input.file !== null) {
    if (typeof input.file !== 'string' || input.file.trim() === '') errors.push('config.file 必须是非空字符串或 null');
    else file = input.file.trim();
  }
  const configDecls = [];
  if (input.workspaces !== undefined && !Array.isArray(input.workspaces)) {
    errors.push('config.workspaces 必须是数组');
  } else {
    const raw = Array.isArray(input.workspaces) ? input.workspaces : [];
    for (let index = 0; index < raw.length; index += 1) {
      const normalized = normalizeWorkspace(raw[index], `config.workspaces[${String(index)}]`);
      if (normalized.error !== undefined) errors.push(normalized.error);
      else configDecls.push(normalized.decl);
    }
  }
  return { file, configDecls, errors };
}

/** 一份声明的签名：清单内容变了才需要重挂，避免每次刷新都抖动活会话。 */
const signatureOfWorkspace = workspaceSignature;

/**
 * 插件入口。
 * @param ctx - host 上下文（组合行）。
 * @param config - 见模块头注释。
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const statePath = options.file ?? defaultStatePath();
  const log = (level, text) => {
    try {
      const logger = ctx.logger;
      const line = `[workspace-plugins] ${text}`;
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](line);
      else if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    } catch {
      // 日志失败绝不能影响挂载。
    }
  };

  const runtime = createRuntime({ ctx, baseUrl: ctx.baseUrl, log });

  let fileState = blankState();
  let fileMeta = { exists: false, bytes: 0, errors: [], warnings: [] };
  const diagnostics = {
    startedAt: new Date().toISOString(),
    tokenFingerprint: null,
    refreshes: 0,
    routeErrors: 0,
    rejected: 0,
    mountDecisions: 0,
    lastError: null,
    lastRefreshAt: null,
    lastRefreshReason: null,
    // 设置页路由是否已挂上（等待 webServer → registered）。冷启动时它曾经停在
    // waiting 而没人发现，所以这个值要能在 /status 里直接看到。
    routes: 'waiting',
  };

  /**
   * 本机工作区注册表 / 设备网格的**投影快照**（每次 refresh 重取一次）。
   *
   * 为什么快照而不是每次现取：匹配要在 `agent/created` 里同步完成，而同步路径上
   * 不该再碰两个外部服务；注册表与账目都只在显式刷新时变。
   * 两者都只读、失败降级为空投影——没有它们时匹配语义与旧版本完全一致。
   */
  let registryIndex = emptyRegistryIndex('尚未刷新');
  let meshIndex = emptyMeshIndex('尚未刷新');

  /**
   * 当前 live agent 列表；**读不到时返回 null**（未知 ≠ 空）。
   *
   * 这个区分很要紧：重挂流程会用这份列表做「已经不存在的会话就清掉」的清扫。
   * 若把「读失败」当成「一个活会话都没有」，一次瞬时抖动就会把**所有**活会话的
   * 子插件卸掉、连挂载记录一起删（记录没了就不会再有 agent/created，只能等下一次
   * 刷新），设置页却还回 200 报成功。所以这里返回 null，调用方据此跳过清扫。
   * @returns agent 数组，或 null（拿不到/读取失败）。
   */
  function liveAgents() {
    const agents = ctx.get('agents');
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return null;
    try {
      const list = agents.list();
      return Array.isArray(list) ? list : null;
    } catch (error) {
      log('warn', `读取 live agent 列表失败（跳过本次清扫，不动任何已有挂载）：${message(error)}`);
      return null;
    }
  }

  /**
   * 本机工作区注册表（出厂 `workspaceRegistry`）的只读投影。
   *
   * 拿到的东西：
   *   · byId / byPath —— 身份绑定（workspace id）与路径绑定的解析表；
   *   · sessionOf —— 会话 id → 工作区 id（注册表按 canonical cwd 头部索引算好的账，
   *     会话归属的最硬来源）；
   *   · list —— 设置页「按工作区挑」下拉框的数据源。
   * 服务缺席/抛错一律降级为空投影并记下原因（设置页据此提示，不静默）。
   * @returns 投影（见 store.js emptyRegistryIndex）。
   */
  function readRegistry() {
    const empty = emptyRegistryIndex();
    let service;
    try {
      service = ctx.get('workspaceRegistry');
    } catch (error) {
      empty.error = message(error);
      return empty;
    }
    if (service === null || service === undefined || typeof service.list !== 'function') {
      empty.error = '组合里没有 workspaceRegistry（无法按工作区身份绑定）';
      return empty;
    }
    try {
      const raw = service.list();
      const list = [];
      const byId = new Map();
      const byPath = new Map();
      const sessionOf = new Map();
      for (const item of Array.isArray(raw) ? raw : []) {
        const id = typeof item?.id === 'string' && item.id !== '' ? item.id : null;
        const path = typeof item?.path === 'string' ? canonicalPath(item.path) : null;
        if (id === null || path === null) continue;
        const sessionIds = Array.isArray(item?.sessionIds) ? item.sessionIds.filter((value) => typeof value === 'string') : [];
        const entry = {
          id,
          title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : null,
          path,
          sessionIds,
        };
        list.push(entry);
        byId.set(id, entry);
        if (!byPath.has(path)) byPath.set(path, entry);
        for (const sessionId of sessionIds) if (!sessionOf.has(sessionId)) sessionOf.set(sessionId, id);
      }
      return { available: true, error: null, list, byId, byPath, sessionOf };
    } catch (error) {
      return { ...empty, error: `读取 workspaceRegistry 失败：${message(error)}` };
    }
  }

  /**
   * 设备网格（`deviceMesh`，由 dsh-device-mesh 提供）的只读投影。
   *
   * 只取匹配要用的三样：本机身份、设备表、工作区路径账目（`paths()` 的 group）。
   * 这是「网络工作区」的全部输入——同一份工作区在各设备上的路径都记在这里。
   * 没有这个服务（没装网格）时降级为空投影：单机行为完全不变。
   * @returns 投影（见 store.js emptyMeshIndex）。
   */
  function readMesh() {
    const empty = emptyMeshIndex();
    let service;
    try {
      service = ctx.get('deviceMesh');
    } catch (error) {
      empty.error = message(error);
      return empty;
    }
    if (service === null || service === undefined) {
      empty.error = '组合里没有 deviceMesh（这是单机部署，或网格插件未启用）';
      return empty;
    }
    try {
      const identity = typeof service.identity === 'function' ? service.identity() : null;
      const selfDeviceId = typeof identity?.deviceId === 'string' ? identity.deviceId : null;
      const selfDeviceName = typeof identity?.name === 'string' && identity.name !== '' ? identity.name : selfDeviceId;
      const devices = [];
      try {
        const tree = typeof service.tree === 'function' ? service.tree('direct') : null;
        for (const node of Array.isArray(tree?.devices) ? tree.devices : []) {
          const deviceId = typeof node?.deviceId === 'string' ? node.deviceId : null;
          if (deviceId === null) continue;
          devices.push({
            deviceId,
            name: typeof node.name === 'string' && node.name !== '' ? node.name : deviceId,
            self: node.self === true,
            liveness: typeof node.liveness === 'string' ? node.liveness : null,
            trust: typeof node.trust === 'string' ? node.trust : null,
            via: typeof node.via?.kind === 'string' ? node.via.kind : null,
          });
        }
      } catch {
        // 设备表拿不到不影响匹配（账目里的 deviceName 是冗余的）。
      }
      const rawGroups = typeof service.paths === 'function' ? service.paths() : [];
      const groups = [];
      const byWorkspaceId = new Map();
      const byPath = new Map();
      for (const group of Array.isArray(rawGroups) ? rawGroups : []) {
        if (group === null || typeof group !== 'object') continue;
        const safe = jsonSafe(group);
        const view = safe.ok ? group : null;
        if (view === null) continue;
        groups.push(view);
        if (typeof view.workspaceId === 'string' && view.workspaceId !== '') {
          const bucket = byWorkspaceId.get(view.workspaceId) ?? [];
          bucket.push(view);
          byWorkspaceId.set(view.workspaceId, bucket);
        }
        const mark = (path, kind, member) => {
          const canonical = typeof path === 'string' ? canonicalPath(path) : null;
          if (canonical === null || byPath.has(canonical)) return;
          byPath.set(canonical, {
            group: view,
            kind,
            member: member ?? null,
            deviceId: kind === 'primary' ? view.primary?.deviceId ?? view.homeDeviceId ?? null : member?.deviceId ?? null,
            deviceName: kind === 'primary' ? view.primary?.deviceName ?? null : member?.deviceName ?? null,
            role: kind === 'primary' ? 'primary' : member?.role ?? null,
            local: kind === 'primary' ? view.primary?.local === true : member?.local === true,
          });
        };
        mark(view.primary?.path, 'primary', null);
        for (const member of Array.isArray(view.members) ? view.members : []) mark(member?.path, 'member', member);
      }
      return { available: true, error: null, selfDeviceId, selfDeviceName, devices, groups, byWorkspaceId, byPath };
    } catch (error) {
      return { ...empty, error: `读取 deviceMesh 失败：${message(error)}` };
    }
  }

  /** 视图用的行副本：config 过一遍 jsonSafe，不可序列化的换成占位文本并标 configUnsafe。
   * 这样 /state 永远不会因为清单里的一个活对象而序列化失败；设置页看到标记后会拒绝
   * 保存该行（避免把占位文本写回状态文件、把真 config 弄丢）。
   */
  function rowView(row) {
    const safe = jsonSafe(row.config);
    if (safe.ok) return row;
    return { ...row, config: safe.value, configUnsafe: true };
  }

  /** 视图用的清单副本（fileState 与 workspaces 都走它）。 */
  function stateViewOf(state) {
    return {
      ...state,
      workspaces: state.workspaces.map((workspace) => ({ ...workspace, plugins: workspace.plugins.map(rowView) })),
    };
  }

  /** 全部挂载记录里报出来的「疑似全局泄漏」工具名（去重）。 */
  function leakedNames() {
    const names = [];
    for (const mount of runtime.mountSnapshot()) {
      if (!Array.isArray(mount.leaked)) continue;
      for (const name of mount.leaked) if (!names.includes(name)) names.push(name);
    }
    return names;
  }

  /** 有效清单（组合声明 + 状态文件，已合并/去重/叠加停用）。 */
  function effective() {
    return mergeWorkspaces(options.configDecls, fileState);
  }

  /**
   * 重读状态文件 → 合并 → 预导入 → 按需重挂活会话。
   * 全程不抛：任何一步失败都记诊断并保持上一份可用状态。
   * @param reason - 触发原因（诊断用）。
   * @param force - 无视签名强制重挂（显式「重新加载」/「强制重挂」用）。
   */
  async function refresh(reason, force = false) {
    try {
      const read = readStateFile(statePath);
      // 文件读坏（截断/手改）时**沿用上一次成功读取的清单**：否则本文件声明的
      // 工作区会凭空消失，活会话上的子插件被卸掉、记录也删了（文件修好之前不会
      // 自动回来）。缺文件仍然按空清单处理（那是正常状态，不是错误）。
      const keepPrevious = !read.ok && read.exists && fileState.workspaces.length > 0;
      if (keepPrevious) {
        read.warnings.push('状态文件读取失败：沿用上一次成功读取的清单（修好文件后点「重新加载」）');
        log('warn', `状态文件读取失败，沿用上一份清单（${String(fileState.workspaces.length)} 个工作区）`);
      } else {
        fileState = read.state;
      }
      fileMeta = { exists: read.exists, bytes: read.bytes, errors: read.errors, warnings: read.warnings };
      if (read.errors.length > 0) log('warn', `状态文件有 ${String(read.errors.length)} 处问题：${read.errors.join('；')}`);
      const list = effective();
      // 注册表与网格每次刷新重取（只读快照）：解析出「本机可匹配的路径集合」。
      // 服务缺席时两个投影都是空壳，resolveWorkspaces 退化成只有声明里的 path。
      registryIndex = readRegistry();
      meshIndex = readMesh();
      const resolved = resolveWorkspaces(list, registryIndex, meshIndex);
      const remoteOnly = resolved.filter((workspace) => workspace.remoteOnly === true).length;
      runtime.setWorkspaces(resolved);
      const before = runtime.mountSnapshot();
      await runtime.preload();
      const agents = liveAgents();
      if (agents === null) diagnostics.lastAgentListError = new Date().toISOString();
      // agents === null：只做「已命中会话的重试/新挂」是做不到的（没有列表可扫），
      // 于是本轮只更新清单与模块，**不碰**任何现有挂载。
      const result = agents === null
        ? { kept: runtime.mountedCount(), remounted: 0, mounted: 0, skipped: [], skippedSweep: true }
        : await runtime.remountLive(agents, {
        force,
          signatureOf: (agent, record) => {
            const matched = runtime.resolveWorkspace(record.cwd);
            return matched === undefined || matched.workspace.path !== record.workspace ? null : signatureOfWorkspace(matched.workspace);
          },
        });
      diagnostics.refreshes += 1;
      diagnostics.lastRefreshAt = new Date().toISOString();
      diagnostics.lastRefreshReason = reason;
      log('info', `刷新完成（${reason}）：工作区 ${String(list.length)} 条（其中本机无路径的 ${String(remoteOnly)} 条）、活会话 ${agents === null ? '未知（列表读取失败，未清扫）' : String(agents.length)} 个、保留 ${String(result.kept)}、重挂 ${String(result.remounted)}、新挂 ${String(result.mounted)}、当前挂载 ${String(runtime.mountedCount())}（此前 ${String(before.length)}）`);
      if (registryIndex.available === false) log('warn', `工作区注册表不可用：${registryIndex.error ?? '未知原因'}（身份绑定与附加路径匹配退化为按声明路径匹配）`);
      if (meshIndex.available === false) log('info', `设备网格不可用：${meshIndex.error ?? '未知原因'}（按单机处理，网络工作区信息不可见）`);
      return result;
    } catch (error) {
      diagnostics.lastError = message(error);
      log('error', `刷新失败（${reason}）：${message(error)}`);
      return { error: message(error) };
    }
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  /**
   * 本进程实例的访问令牌（每次 apply 现生成）。
   *
   * 为什么需要它：`Origin` 与 `Host` 都是请求方给的，「两者一致」挡不住 DNS rebinding
   * ——页面从 `http://evil.example:3080` 加载、该域名解析到 127.0.0.1 时，浏览器发的
   * `Origin` 与 `Host` 恰好都是 `evil.example:3080`，「同源」判定会放行。而这个插件的
   * 写路由能让 host **加载并执行**一个模块（本部署里权限面最大的一处），不能只靠头部
   * 自洽。
   *
   * 令牌只经 `webserver/index-inject` 注入到**受壳层鉴权保护的** index HTML 里
   * （`globalThis.__DSH_WORKSPACE_PLUGINS__`），跨站页面读不到它；设置页把它放进
   * `x-workspace-plugins-token` 头。带浏览器头（Origin / Sec-Fetch-*）但不带令牌的
   * 请求一律拒绝并提示刷新页面；完全不带浏览器头的本机调用（curl / 脚本）照常放行
   * ——那种调用方本来就能直接读写同一个文件。
   */
  const token = randomBytes(16).toString('hex');
  // 令牌指纹（只用于诊断核对，不泄露令牌本身）。
  diagnostics.tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 8);
  const browserish = (req) => {
    if (typeof req.headers.origin === 'string' && req.headers.origin !== '') return true;
    return Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'));
  };
  /** 严格守卫：跨站拒 → 带令牌则验令牌 → 浏览器请求必须有令牌 → 否则 Origin 必须与 Host 一致。 */
  const sameOrigin = (req) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const presented = req.headers['x-workspace-plugins-token'];
    if (typeof presented === 'string' && presented.length > 0) return presented === token;
    const origin = req.headers.origin;
    if (browserish(req)) return false;
    if (typeof origin !== 'string' || origin === '') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      // Origin: null（沙箱 iframe / data: / file:）不是本页面的同源来源。
      return false;
    }
  };
  /**
   * 序列化再发；**先 stringify 后 writeHead**。
   *
   * 顺序反过来的话，一个 JSON.stringify 拒绝的值（循环引用、BigInt、抛错的 toJSON
   * ——子插件往 config 上挂活对象就能造出来）会在响应头已经发出去之后才抛：内层
   * catch 再调 apiError → writeHead 二次调用抛 ERR_HTTP_HEADERS_SENT → 外层 catch
   * 又调一次 → 未处理的 rejection。DSH 对未处理 rejection 是 fail-loud（直接退出
   * 进程），所以这条路径必须是「要么正常发完，要么干净地发一个 500」。
   */
  /**
   * 客户端输入错误：带 status=400。
   * 处理函数抛的错默认按 500 处理（那才是「本插件故障」）；校验类错误必须显式标 400，
   * 否则设置页会把「你填错了」显示成服务端故障，/status.ok 也跟着翻红。
   */
  const badRequest = (text) => Object.assign(new Error(text), { status: 400 });

  /** 403 文案：区分「跨站」与「页面该刷新了（令牌换了）」。 */
  const guardError = (req) => (browserish(req) && typeof req.headers['x-workspace-plugins-token'] !== 'string'
    ? '浏览器请求缺少访问令牌：请刷新页面后重试（插件重载过，旧页面拿的是旧令牌）'
    : 'cross-origin request rejected');

  const apiJson = (res, status, value) => {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      return apiError(res, 500, `响应无法序列化为 JSON：${message(error)}`);
    }
    if (text === undefined) text = 'null';
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  };
  /**
   * 错误响应。4xx 只计数（跨站探测、方法不对不是本插件的故障），5xx 才记 lastError
   * ——否则一次 403 会让 /status.ok 永久为 false，掩盖真正的问题。
   */
  const apiError = (res, status, error) => {
    const text = message(error);
    if (status >= 500) {
      diagnostics.routeErrors += 1;
      diagnostics.lastError = text;
    } else {
      diagnostics.rejected += 1;
    }
    if (res.headersSent === true || res.writableEnded === true) {
      // 已经发过响应头：不能再写，也不能让异常逃到 unhandled rejection。
      res.destroy?.();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: text }));
  };
  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 1_000_000) {
        rejectBody(new Error('请求体过大（上限 1 MB）'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(text));
    req.on('error', rejectBody);
  });

  /**
   * 一个 GET 路由。
   *
   * **不要在 apply 里 `ctx.get('webServer')` 一次就定终身**：patch 的 `- insert:`
   * 行在启动期可能先于 webserver 行被应用，那时 get 到的是 undefined，于是整段注册
   * 被静默跳过。本插件在 0.2.0-rc.2 的这个 profile 上真的这样空转过——冷启动后
   * `/dsh-workspace-plugins/status` 404，而挂载机制一切正常，设置页却一片报错。
   * 现在由 `ctx.inject(['webServer'], …)` 等它出现再调 registerRoutes()（见文件尾）。
   * @param webServer - 已经就绪的 webServer 服务。
   */
  const registerGet = (webServer, path, handler, label) => {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, guardError(req));
        try {
          return apiJson(res, 200, handler(new URL(req.url, 'http://localhost')));
        } catch (error) {
          return apiError(res, 500, error);
        }
      },
    }), label);
  };

  /** 一个 POST 路由：同源 → JSON body → handler → 响应。 */
  const registerPost = (webServer, path, handler, label) => {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, guardError(req));
        readBody(req).then(async (text) => {
          let args = {};
          if (text !== '') {
            try {
              args = JSON.parse(text);
            } catch {
              return apiError(res, 400, 'body 不是合法 JSON');
            }
          }
          try {
            return apiJson(res, 200, await handler(args === null || typeof args !== 'object' ? {} : args));
          } catch (error) {
            // 处理函数抛错默认 500；校验类错误在抛出时就带了 status=400（badRequest）。
            return apiError(res, Number.isInteger(error?.status) ? error.status : 500, error);
          }
        }).catch((error) => {
          // 兜底：读 body 之外的任何异常。apiError 自身保证不会二次写响应，所以这里
          // 不会变成未处理 rejection（那在 DSH 里等于 fail-loud 退出进程）。
          try {
            apiError(res, 500, error);
          } catch {
            res.destroy?.();
          }
        });
      },
    }), label);
  };

  /** 可挂载子插件的候选清单：组合里已经在用的本地行（`.`/绝对路径）。 */
  function catalog() {
    const out = new Set();
    let entries = [];
    try {
      entries = ctx.get('loader')?.entries?.() ?? [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const entryName = entry?.options?.name;
      if (typeof entryName !== 'string' || entryName === '') continue;
      if (entryName.startsWith('.') || entryName.startsWith('file:')) out.add(entryName);
    }
    for (const workspace of runtime.getWorkspaces()) {
      for (const row of workspace.plugins) out.add(row.name);
    }
    return [...out].sort((left, right) => left.localeCompare(right));
  }

  /** 每个「工作区#行」的实时挂载汇总（设置页据此标出 active/waiting/failed）。 */
  function rowLiveSummary() {
    const summary = new Map();
    for (const mount of runtime.mountSnapshot()) {
      for (const row of mount.rows) {
        const key = `${mount.key ?? mount.workspace}#${row.id}`;
        const record = summary.get(key) ?? { total: 0, active: 0, pending: 0, waiting: 0, failed: 0, skipped: 0, errors: [], waitingFor: [] };
        record.total += 1;
        record[row.state] = (record[row.state] ?? 0) + 1;
        if (row.error !== undefined && record.errors.length < 3) record.errors.push(row.error);
        if (Array.isArray(row.waitingFor)) for (const service of row.waitingFor) if (!record.waitingFor.includes(service)) record.waitingFor.push(service);
        summary.set(key, record);
      }
    }
    return summary;
  }

  /** 设备网格的人类可读摘要（设置页顶部那条「本机 xray4668 · 已接入 orangepi5」）。 */
  function meshView() {
    const self = { deviceId: meshIndex.selfDeviceId, name: meshIndex.selfDeviceName };
    const peers = meshIndex.devices.filter((device) => device.self !== true);
    const remoteMembers = meshIndex.groups.reduce((sum, group) => sum + (Array.isArray(group.members) ? group.members.filter((member) => member?.local !== true).length : 0), 0);
    return {
      available: meshIndex.available,
      error: meshIndex.error ?? null,
      self,
      devices: meshIndex.devices,
      peers,
      groups: meshIndex.groups.length,
      remoteMembers,
    };
  }

  /** 设置页/路由用的全量视图。 */
  function stateView(url) {
    const list = runtime.getWorkspaces();
    const live = rowLiveSummary();
    const cwd = url?.searchParams?.get?.('cwd') ?? undefined;
    const session = url?.searchParams?.get?.('session') ?? undefined;
    return {
      name,
      build: BUILD,
      version: STATE_VERSION,
      baseUrl: runtime.baseUrl,
      statePath,
      routes: diagnostics.routes,
      // 网络维度：本机身份、接入的设备、账目里的远端副本数。设置页据此显示「网络工作区」。
      mesh: meshView(),
      // 本机工作区注册表（身份绑定的数据源，也是设置页「按工作区挑」下拉框的来源）。
      registry: {
        available: registryIndex.available,
        error: registryIndex.error ?? null,
        workspaces: registryIndex.list.map((entry) => ({ id: entry.id, title: entry.title, path: entry.path, sessions: entry.sessionIds.length })),
      },
      file: { exists: fileMeta.exists, bytes: fileMeta.bytes, errors: fileMeta.errors, warnings: fileMeta.warnings },
      // 设置页的编辑基准就是它：只有状态文件里的行可写回；组合声明只在上面的
      // workspaces 里只读展示（要停用组合行就走 configDisabled，不改组合文件）。
      fileState: stateViewOf(fileState),
      // 组合声明那份同样是「视图」：它的 config 也可能含活对象（YAML 里的 !!js），
      // 一样要过 jsonSafe，否则 /state 会在序列化时失败（自测里用一个循环引用抓到过）。
      config: {
        errors: options.errors,
        declared: options.configDecls.map((workspace) => ({ ...workspace, plugins: workspace.plugins.map(rowView) })),
      },
      workspaces: list.map((workspace) => ({
        key: workspace.key ?? workspaceKeyOf(workspace),
        // configDisabled 的键（与 workspace.key 不同：路径声明保持 v6 的裸路径拼写）。
        disableKey: disableKeyOf(workspace),
        workspaceId: workspace.workspaceId ?? null,
        path: workspace.path ?? null,
        registryPath: workspace.registryPath ?? null,
        title: workspace.registryTitle ?? null,
        label: workspace.label ?? null,
        match: workspace.match,
        includeMembers: workspace.includeMembers !== false,
        source: workspace.source,
        // 本机真正参与匹配的路径（主路径 + 本机附加路径）：设置页要显示「凭什么命中」。
        matchPaths: (workspace.matchPaths ?? []).map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          source: entry.source ?? null,
          role: entry.role ?? null,
          deviceId: entry.deviceId ?? null,
          deviceName: entry.deviceName ?? null,
          prefer: entry.prefer === true,
          exists: entry.exists ?? null,
        })),
        // 网络信息：账目里的本机/远端副本。remoteOnly＝本机没有这条工作区的任何路径。
        network: workspace.network ?? null,
        remoteOnly: workspace.remoteOnly === true,
        hints: workspace.hints ?? [],
        plugins: workspace.plugins.map((raw) => {
          // 有效清单里的行同样要过 rowView：它的 config 直接来自组合声明/状态文件。
          const row = rowView(raw);
          return {
            id: row.id,
            name: row.name,
            source: row.source,
            disabled: row.disabled === true,
            conflict: row.conflict === true,
            isolate: row.isolate ?? null,
            config: row.config ?? null,
            configUnsafe: row.configUnsafe === true,
            live: live.get(`${workspace.key ?? workspaceKeyOf(workspace)}#${row.id}`) ?? null,
          };
        }),
      })),
      mounts: runtime.mountSnapshot(),
      modules: runtime.moduleSnapshot(),
      live: { agents: (liveAgents() ?? []).length, mountedSessions: runtime.mountedCount(), leaked: leakedNames() },
      catalog: catalog(),
      diagnostics: {
        ...diagnostics,
        // 命中测试：设置页填一个 cwd（可再填会话 id）看它落到谁身上、凭什么落。
        // 没命中时把「这条 cwd 属于一个在别的设备上另有副本的工作区」这类原因一并给出，
        // 免得用户对着「未命中」猜。
        matched: cwd === undefined || cwd === '' ? undefined : (() => {
          const matched = matchWorkspace(list, cwd, session);
          if (matched !== undefined) {
            return {
              cwd,
              session: session ?? null,
              hit: true,
              key: matched.workspace.key ?? workspaceKeyOf(matched.workspace),
              workspaceId: matched.workspace.workspaceId ?? null,
              workspace: matched.workspace.path ?? matched.workspace.registryPath ?? matched.workspace.workspaceId ?? null,
              title: matched.workspace.registryTitle ?? matched.workspace.label ?? null,
              mode: matched.mode,
              by: matched.by ?? 'path',
              matchedPath: matched.path ?? null,
              kind: matched.kind ?? null,
              plugins: matched.workspace.plugins.filter((row) => row.disabled !== true && row.conflict !== true).map((row) => row.name),
            };
          }
          const canonical = canonicalPath(cwd);
          const nearby = canonical === null ? [] : list
            .filter((workspace) => (workspace.matchPaths ?? []).some((entry) => entry.path === canonical))
            .map((workspace) => workspace.key ?? workspaceKeyOf(workspace));
          const hints = [];
          const remoteOnly = list.filter((workspace) => workspace.remoteOnly === true);
          for (const workspace of remoteOnly) {
            const devices = workspace.network?.remoteDevices ?? [];
            if (devices.length > 0) hints.push(`工作区 ${workspace.registryTitle ?? workspace.label ?? workspace.workspaceId ?? '?'} 本机没有路径（在 ${devices.join('、')} 上）：请在那台设备上声明这一行`);
          }
          return { cwd, session: session ?? null, hit: false, nearby, hints };
        })(),
      },
    };
  }

  // ── 装配 ────────────────────────────────────────────────────────────────

  // 令牌注入：只出现在壳层（已鉴权）渲染的 index HTML 里，设置页据此调用本插件的路由。
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_WORKSPACE_PLUGINS__', value: { token } });
  });

  // 会话创建：同步判定 + 同步提交挂载（见 mount.js 头注释的时机说明）。
  ctx.on('agent/created', ({ agent }) => {
    try {
      diagnostics.mountDecisions += 1;
      const record = runtime.mountForAgent(agent);
      if (record?.skipped === 'not-ready') {
        // 正常延迟：模块还在预导入，refresh() 的 sweep 紧接着会把这个会话挂上。
        log('info', `会话 ${String(agent?.id)} 暂缓挂载：模块尚未预导入完成，随后的 sweep 会补上`);
        return;
      }
      if (record?.skipped === 'unscoped' || record?.skipped === 'no-agent') {
        log('warn', `会话 ${String(agent?.id)} 未挂载：${record.reason ?? record.skipped}`);
        return;
      }
      if (record?.rows?.length > 0) {
        log('info', `会话 ${String(agent.id)}（${record.cwd}）命中工作区 ${record.workspace}，提交 ${String(record.rows.length)} 个子插件`);
      }
    } catch (error) {
      // 监听器抛错会被出厂记成 warn 并继续，但这里自己吞掉更干净。
      diagnostics.lastError = message(error);
      log('error', `agent/created 挂载失败：${message(error)}`);
    }
  });

  // 会话销毁：显式卸载一次（agent 销毁本来会连带卸载；这里保证记录与句柄及时释放）。
  ctx.on('agent/disposed', ({ agent }) => {
    void runtime.unmountAgent(agent?.id).catch((error) => log('warn', `卸载会话 ${String(agent?.id)} 失败：${message(error)}`));
  });

  // 插件卸载：把还挂在活会话上的子插件全部摘掉。
  ctx.effect(() => () => {
    // 返回 promise（不是 void 掉）：Cordis 会等它，于是「换 entry 热挂」时新实例不会在
    // 旧注册还没摘干净的空档里注册同名工具——那种撞名会让新实例的这一行直接 failed。
    return runtime.disposeAll().catch((error) => {
      log('warn', `插件卸载时清理失败：${message(error)}`);
    });
  }, 'dsh-workspace-plugins: unmount every session on dispose');

  /**
   * 注册全部设置页路由（webServer 就绪后由 ctx.inject 调一次）。
   * @param webServer - webServer 服务。
   */
  function registerRoutes(webServer) {
    registerGet(webServer, `${ROUTE_PREFIX}/state`, (url) => stateView(url), 'dsh-workspace-plugins: state route');
    registerGet(webServer, `${ROUTE_PREFIX}/status`, () => ({
      ok: diagnostics.lastError === null,
      name,
      build: BUILD,
      version: STATE_VERSION,
      baseUrl: runtime.baseUrl,
      statePath,
      // 与 /state 保持同一形状：errors/warnings 是**文本数组**（数长度这种事交给客户端，
      // 免得两个视图给出不同的类型、客户端写两套容错）。
      file: { exists: fileMeta.exists, bytes: fileMeta.bytes, errors: fileMeta.errors, warnings: fileMeta.warnings },
      routes: diagnostics.routes,
      workspaces: runtime.getWorkspaces().length,
      // 网络维度摘要：本机设备、接入的设备名、账目里的工作区组与远端副本数、
      // 以及「本机没有路径因而永远挂不上」的工作区数（= remoteOnly）。
      mesh: (() => {
        const view = meshView();
        return {
          available: view.available,
          error: view.error,
          self: view.self,
          devices: view.devices.map((device) => ({ deviceId: device.deviceId, name: device.name, self: device.self, liveness: device.liveness, via: device.via })),
          groups: view.groups,
          remoteMembers: view.remoteMembers,
        };
      })(),
      registry: {
        available: registryIndex.available,
        error: registryIndex.error ?? null,
        workspaces: registryIndex.list.length,
      },
      remoteOnly: runtime.getWorkspaces().filter((workspace) => workspace.remoteOnly === true).length,
      config: options.configDecls.length,
      rows: runtime.getWorkspaces().reduce((sum, workspace) => sum + workspace.plugins.length, 0),
      modules: runtime.moduleSnapshot().map((record) => ({ specifier: record.specifier, state: record.state, error: record.error })),
      mounts: runtime.mountSnapshot().map((mount) => ({
        sessionId: mount.sessionId,
        workspace: mount.workspace,
        leaked: mount.leaked,
        rows: mount.rows.map((row) => ({ id: row.id, source: row.source, state: row.state, error: row.error, waitingFor: row.waitingFor })),
      })),
      live: { agents: (liveAgents() ?? []).length, mountedSessions: runtime.mountedCount(), leaked: leakedNames() },
      diagnostics,
    }), 'dsh-workspace-plugins: status route');

    registerPost(webServer, `${ROUTE_PREFIX}/save`, async (args) => {
      // 缺 workspaces 字段不等于「清空」：显式要求给出（可以是空数组）。否则一个只带
      // configDisabled 的请求会把所有工作区悄悄抹掉。
      if (args.workspaces === undefined) throw badRequest('body 必须带 workspaces 字段（清空就传空数组）');
      // 含不可序列化 config 的行不允许经本接口回写：视图里那份是占位文本，写回去就
      // 把真 config 弄丢了。这类行只能直接改状态文件。
      const unsafe = fileState.workspaces.flatMap((workspace) => workspace.plugins
        .filter((row) => !jsonSafe(row.config).ok)
        .map((row) => rowKey(disableKeyOf(workspace), row.id)));
      if (unsafe.length > 0) throw badRequest(`这些行的 config 含无法序列化的值，本接口拒绝覆盖（请直接改状态文件）：${unsafe.join('、')}`);
      const normalized = normalizeState({ version: STATE_VERSION, workspaces: args.workspaces, configDisabled: args.configDisabled });
      if (normalized.errors.length > 0) throw badRequest(normalized.errors.join('；'));
      const bytes = writeStateFile(statePath, normalized.state);
      await refresh('save');
      log('info', `状态文件已写入 ${statePath}（${String(bytes)} 字节）`);
      return stateView();
    }, 'dsh-workspace-plugins: save route');

    registerPost(webServer, `${ROUTE_PREFIX}/reload`, async () => {
      const result = await refresh('reload', true);
      return { result, state: stateView() };
    }, 'dsh-workspace-plugins: reload route');

    registerPost(webServer, `${ROUTE_PREFIX}/probe`, async (args) => {
      const specifier = typeof args.specifier === 'string' ? args.specifier.trim() : '';
      if (specifier === '') throw badRequest('需要 specifier');
      return await runtime.probe(specifier);
    }, 'dsh-workspace-plugins: probe route');

    registerPost(webServer, `${ROUTE_PREFIX}/remount`, async (args) => {
      const sessionId = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined;
      const agents = (liveAgents() ?? []).filter((agent) => sessionId === undefined || agent?.id === sessionId);
      if (sessionId !== undefined && agents.length === 0) throw new Error(`没有找到 live 会话 ${sessionId}`);
      if (sessionId !== undefined) await runtime.unmountAgent(sessionId);
      const result = await runtime.remountLive(agents, { force: sessionId !== undefined });
      return { result, mounts: runtime.mountSnapshot() };
    }, 'dsh-workspace-plugins: remount route');
  }

  // webServer 用 ctx.inject 等（而不是 export const inject = ['webServer']）：启动期与
  // patch 热重载期都对，而整行不会因为 webServer 缺席被挂起、把挂载机制一起拖住。
  // 回调返回的 fiber 归本插件，插件被拆时路由随之摘掉（见 cordis Context.inject）。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      log('warn', 'webServer 出现了但没有 register，设置页路由未注册（挂载机制不受影响）');
      return;
    }
    try {
      registerRoutes(webServer);
      diagnostics.routes = 'registered';
      log('info', `设置页路由已注册：${ROUTE_PREFIX}/state · /status · /save · /reload · /probe · /remount`);
    } catch (error) {
      diagnostics.routes = 'failed';
      diagnostics.lastError = message(error);
      log('error', `注册设置页路由失败：${message(error)}`);
    }
  });

  // 首次装配：读文件 → 预导入 → 给已经活着的会话补挂载。
  void refresh('startup').then(() => {
    if (options.errors.length > 0) log('warn', `组合 config 有 ${String(options.errors.length)} 处问题：${options.errors.join('；')}`);
  });
}
