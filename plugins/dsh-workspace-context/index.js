/**
 * dsh-workspace-context —— host 半边（Cordis 静态插件）。
 *
 * 功能一句话：**给每个工作区一份「常驻上下文提示词」**——存在 `$DSH_HOME/`
 * `workspace-context/contexts/*.md`，每一条都常驻在该工作区会话的 system prompt
 * 里；人可以直接改文件（热生效）或走设置页，模型可以用工具 `workspace_context`
 * 读写。
 *
 * ── 三条实现路径 ─────────────────────────────────────────────────────────────
 * ① 注入：`system-prompt/assemble` 瀑布（`{prepend:true}`，与 dsh-ultracode 同一
 *    写法）。装配期按 `context.agent.session.header.cwd` 取工作区，命中条目就把
 *    一个 section 插进装配结果——**每个请求都在场**、改文件下一次请求即生效、
 *    不会被压实摘要盖掉，且不往会话日志里写任何可见消息。
 * ② 模型工具：`workspace_context`（list/read/write/append/clear/set_enabled）。
 *    注册在 host `tools` 注册表上，故**与本会话跑哪个 agent 预设无关**，每个会话
 *    都看得到（除非某个 scope 用 tools.restrict 把它挡掉）。
 * ③ 浏览器半边：设置页「工作区常驻上下文」一节（见 ./client.js），全部走本文件
 *    注册的同源路由 `/dsh-workspace-context/*`——静态插件没有动态包的 host.call。
 *
 * ── 两个必须知道的坑（都在代码里处理了）─────────────────────────────────────
 * - **`{{…}}` 会打挂装配**：section 正文随后要过 `renderPrompt` 的严格插值，
 *   正文里一句 `{{name}}` 会让该工作区每个请求都 throw。store.js 的
 *   `neutralizeTemplateRefs` 在注入前把 `{{` 拆开。
 * - **正文不可信**：正文由人或模型写入，注入前转义 `</workspace-context`，
 *   免得正文提前闭合本插件的外框。外框前的固定话术也把权限说清楚
 *   （不覆盖 system / developer / 用户直接指令）。
 *
 * 维护：本 profile 未开模块热载，loader 按 specifier 缓存模块——改实现后要让
 *   运行实例生效，需改 cordis.patch.yml 里该行的 `name`（指向新文件）或重启 dsh；
 *   只改 config 不改 name 会走同 id 的 dispose→start 路径，是安全的。
 * 自测：`node plugins/dsh-workspace-context/selftest.mjs`（纯 node，无副作用）。
 *
 * @module dsh-workspace-context
 */

import {
  SCHEMA,
  canonicalPath,
  createStore,
  defaultStoreDir,
  dshHome,
} from './store.js';

/** 插件版本（诊断回显用；改行为就 +1）。 */
const VERSION = 1;
/** 浏览器 API 前缀。 */
const ROUTE_PREFIX = '/dsh-workspace-context';
/** section 名（装配结果里可见，便于排查；也用于去重）。 */
const DEFAULT_SECTION_NAME = 'workspace:context';
/** 注入位置锚点：紧跟部署人设前缀。 */
const PERSONA_SECTION = 'deployment:persona-prefix';
/** 模型工具名。 */
const TOOL_NAME = 'workspace_context';
/** 诊断里保留的最近 cwd 数。 */
const SEEN_CWD_LIMIT = 40;

/** 工具描述：模型靠它决定什么时候用、以及「常驻」意味着什么。 */
const TOOL_DESCRIPTION = [
  'Read or maintain the persistent workspace context for a working directory.',
  'A workspace context is a standing prompt block stored on disk for one workspace directory and injected into the system prompt of EVERY request whose session working directory is that workspace (or a subdirectory of it). It is how a human keeps durable, workspace-specific instructions or knowledge in front of you without repeating them each turn.',
  'Actions: "list" shows every workspace that has a context plus known workspaces that do not; "read" returns the text that would be injected (defaults to this session\'s workspace); "write" replaces that text; "append" adds a paragraph; "clear" empties the text but keeps the entry; "set_enabled" silences or re-enables an entry without touching its text.',
  'Only "list" and "read" are safe by default: call "read" before "write" so you replace rather than destroy existing guidance, keep the text tight and durable (it costs tokens on EVERY request of that workspace), and never put secrets in it. Writes take effect from the next model request; the same text stays editable by the human at its file under $DSH_HOME/workspace-context/contexts/.',
  'Without an explicit "path" argument the target is this session\'s own workspace; pass an absolute existing directory to read or maintain another workspace.',
].join(' ');

/** 把返回值清成 lossless JSON：出厂按 JSON 往返校验工具的规范值，含 undefined 键的
 *  对象会被判 `INVALID_TOOL_OUTPUT`（"value is not lossless JSON"，2026-10-09 活体实测
 *  抓到：read 的 `inheritedFrom` 精确命中时是 undefined）。**每个 return 都要过它。** */
function lossless(value) {
  if (Array.isArray(value)) return value.map(lossless);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = lossless(item);
    }
    return out;
  }
  return value;
}

/** 取会话的工作目录（出厂 SessionHeader.cwd 是绝对路径；子代理会话继承父会话 cwd）。 */
function sessionCwd(agent) {
  const session = agent === undefined || agent === null ? undefined : agent.session;
  const header = session === undefined || session === null ? undefined : session.header;
  const cwd = header === undefined || header === null ? undefined : header.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/** 规范化 apply 的 config（loader 已保证是对象，这里再夹一遍取值边界）。 */
function normalizeConfig(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const positiveInt = (value, fallback) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
  return {
    enabled: input.enabled !== false,
    dir: typeof input.dir === 'string' && input.dir.trim() !== '' ? input.dir.trim() : defaultStoreDir(),
    ttlMs: positiveInt(input.ttlMs, 1000),
    maxBytes: Number.isFinite(input.maxBytes) && input.maxBytes >= 512 ? Math.floor(input.maxBytes) : 32768,
    inheritFromAncestor: input.inheritFromAncestor !== false,
    sectionName: typeof input.sectionName === 'string' && input.sectionName.trim() !== ''
      ? input.sectionName.trim()
      : DEFAULT_SECTION_NAME,
  };
}

/**
 * 把 section 插进装配结果。`AssembledSection` 只有 `{name,text}` 不带 order，
 * 位置由下标决定：紧跟 `deployment:persona-prefix`；没有该段就插在第一个 `tool:`
 * 段之前；再没有就追加。
 */
function insertSection(assembly, section) {
  const sections = Array.isArray(assembly.sections) ? assembly.sections.slice() : [];
  let at = -1;
  for (let index = 0; index < sections.length; index += 1) {
    if (sections[index] !== null && sections[index] !== undefined && sections[index].name === PERSONA_SECTION) at = index + 1;
  }
  if (at < 0) {
    for (let index = 0; index < sections.length; index += 1) {
      const name = sections[index] === null || sections[index] === undefined ? undefined : sections[index].name;
      if (typeof name === 'string' && name.startsWith('tool:')) {
        at = index;
        break;
      }
    }
  }
  if (at < 0) at = sections.length;
  sections.splice(at, 0, section);
  return { ...assembly, sections };
}

/** 模型可读的报告文本（`output.render`）。 */
function renderToolReport(value) {
  const lines = [];
  if (value.action === 'list') {
    lines.push(`工作区常驻上下文：${value.entries.length} 条已配置（存储 ${value.dir}）`);
    for (const entry of value.entries) {
      lines.push(`- ${entry.path}｜${entry.enabled ? '启用' : '已停用'}｜${entry.textBytes} 字节｜${entry.title}`);
    }
    if (value.entries.length === 0) lines.push('- （还没有任何工作区配置）');
    if (value.unbound.length > 0) {
      lines.push(`未绑定文件 ${value.unbound.length} 个（头部缺失或写坏，正文不会注入；用 bind 收编）：`);
      for (const item of value.unbound) lines.push(`- ${item.name}（${item.reason}）`);
    }
    for (const item of value.errors) lines.push(`⚠ ${item}`);
    return lines.join('\n');
  }
  const head = `${value.path}`;
  if (value.action === 'read') {
    if (value.exists !== true) {
      return `${head} 还没有常驻上下文（${value.via === undefined ? '未命中任何条目' : value.via}）。`
        + (value.inheritedFrom === undefined ? '' : `\n当前生效的是祖先工作区的条目：${value.inheritedFrom}`);
    }
    const meta = `[${value.title}｜${value.enabled ? '启用' : '已停用'}｜${value.textBytes} 字节`
      + `${value.via === 'ancestor' ? `｜来自祖先工作区 ${value.inheritedFrom}` : ''}]`;
    return `${head}\n${meta}\n\n${value.text === '' ? '（正文为空）' : value.text}`;
  }
  lines.push(`${value.path} 常驻上下文已更新（${value.action}）：${value.textBytes} 字节，${value.enabled ? '启用' : '已停用'}。`);
  lines.push(`下一次模型请求起生效；文件：${value.file}`);
  lines.push('人可以直接编辑该文件（改完约 1 秒内热生效），也可以在 DSH 设置页「工作区常驻上下文」里改。');
  return lines.join('\n');
}

/** 工具参数 schema：刻意扁平、无 oneOf/anyOf（本部署的转换器只稳吃扁平结构）。 */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read', 'write', 'append', 'clear', 'set_enabled'],
      description: 'list=列出全部条目；read=读取将注入的正文；write=整体替换；append=追加段落；clear=清空正文但保留条目；set_enabled=停用/启用。',
    },
    path: {
      type: 'string',
      description: '目标工作区绝对路径（必须是已存在的目录）。省略 = 本会话自己的工作目录。',
    },
    text: {
      type: 'string',
      description: 'write/append 的正文（write 可传空串=清空；append 不接受空串）。',
    },
    enabled: {
      type: 'boolean',
      description: 'set_enabled 的目标状态。',
    },
    title: {
      type: 'string',
      description: '可选的显示名（缺省取目录名）。',
    },
  },
  required: ['action'],
};

export const name = 'workspace-context';

/** 无硬依赖：tools / webServer / workspaceRegistry 都是 `ctx.get` 可选消费。 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  const store = createStore({
    dir: options.dir,
    ttlMs: options.ttlMs,
    maxBytes: options.maxBytes,
    inheritFromAncestor: options.inheritFromAncestor,
  });

  /** 诊断：一切「为什么没注入」都能在这里看到，是排查的第一现场。 */
  const diag = {
    version: VERSION,
    enabled: options.enabled,
    storeDir: store.dir,
    startedAt: new Date().toISOString(),
    assemblies: 0,
    injected: 0,
    skipped: { noSession: 0, noEntry: 0, disabled: 0, empty: 0 },
    lastInjection: undefined,
    lastSkip: undefined,
    toolCalls: 0,
    routeErrors: 0,
    routes: false,
    loadError: undefined,
  };
  /** 见过的会话 cwd（按最近使用排序，供设置页选工作区）。 */
  const seenCwds = new Map();

  const rememberCwd = (cwd) => {
    if (typeof cwd !== 'string' || cwd === '') return;
    seenCwds.delete(cwd);
    seenCwds.set(cwd, Date.now());
    while (seenCwds.size > SEEN_CWD_LIMIT) {
      const oldest = seenCwds.keys().next();
      if (oldest.done === true) break;
      seenCwds.delete(oldest.value);
    }
  };

  const recordSkip = (reason, cwd, entry) => {
    diag.lastSkip = {
      at: new Date().toISOString(),
      reason,
      cwd,
      path: entry === undefined ? undefined : entry.path,
    };
  };

  // ── ① 注入：装配期直注 ────────────────────────────────────────────────────
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (options.enabled !== true) return assembly;
    diag.assemblies += 1;
    const cwd = context === undefined || context === null ? undefined : sessionCwd(context.agent);
    if (cwd === undefined) {
      diag.skipped.noSession += 1;
      recordSkip('no-session-cwd', undefined, undefined);
      return assembly;
    }
    rememberCwd(cwd);
    let section;
    try {
      section = store.sectionFor(cwd);
    } catch (error) {
      diag.loadError = error && error.message ? error.message : String(error);
      recordSkip('load-error', cwd, undefined);
      return assembly;
    }
    if (section === undefined) {
      diag.skipped.noEntry += 1;
      recordSkip('no-entry', cwd, undefined);
      return assembly;
    }
    if (section.skipped === 'disabled') {
      diag.skipped.disabled += 1;
      recordSkip('disabled', cwd, section.entry);
      return assembly;
    }
    if (section.skipped === 'empty') {
      diag.skipped.empty += 1;
      recordSkip('empty', cwd, section.entry);
      return assembly;
    }
    diag.injected += 1;
    diag.lastInjection = {
      at: new Date().toISOString(),
      cwd,
      path: section.entry.path,
      via: section.via,
      title: section.entry.title,
      textBytes: section.entry.textBytes,
      injectedBytes: section.injectedBytes,
      truncated: section.truncated === true,
      sectionName: options.sectionName,
    };
    return insertSection(assembly, { name: options.sectionName, text: section.text });
  }, { prepend: true });

  // ── ② 模型工具 ────────────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolsCtx) => toolsCtx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: renderToolReport(value) }];
      },
    },
    // 声明为 async：ToolDefinition.execute 的契约是 Promise，校验失败也走 rejection。
    async execute(args, exec) {
      diag.toolCalls += 1;
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'read';
      const cwd = sessionCwd(exec === undefined ? undefined : exec.agent);
      const explicit = typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : undefined;
      const targetOf = () => {
        if (explicit !== undefined) return canonicalPath(explicit);
        if (cwd === undefined) {
          throw new Error('本会话没有工作目录（session.header.cwd 缺失），请显式传 path');
        }
        return canonicalPath(cwd);
      };
      const entryView = (entry) => ({
        path: entry.path,
        title: entry.title,
        enabled: entry.enabled,
        file: entry.file,
        textBytes: entry.textBytes,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
        text: entry.text,
      });

      if (action === 'list') {
        const index = store.scan(true);
        return lossless({
          ok: true,
          action,
          dir: store.dir,
          entries: index.entries.map((entry) => ({
            path: entry.path,
            title: entry.title,
            enabled: entry.enabled,
            file: entry.file,
            textBytes: entry.textBytes,
            updatedAt: entry.updatedAt,
            updatedBy: entry.updatedBy,
          })),
          unbound: index.unbound.map((item) => ({ name: item.name, reason: item.reason, bytes: item.bytes })),
          errors: index.errors,
        });
      }

      if (action === 'read') {
        const target = targetOf();
        const resolved = store.resolveFor(target);
        if (resolved === undefined) {
          return lossless({ ok: true, action, path: target, exists: false, text: '', via: undefined });
        }
        const entry = resolved.entry;
        return lossless({
          ok: true,
          action,
          path: target,
          exists: true,
          title: entry.title,
          enabled: entry.enabled,
          file: entry.file,
          textBytes: entry.textBytes,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          text: entry.text,
          via: resolved.via,
          inheritedFrom: resolved.via === 'ancestor' ? entry.path : undefined,
        });
      }

      if (action === 'write' || action === 'append' || action === 'clear') {
        const target = targetOf();
        if (action === 'write' && typeof input.text !== 'string') {
          throw new Error('write 需要 text（字符串；传空串即清空正文）');
        }
        if (action === 'append' && (typeof input.text !== 'string' || input.text.trim() === '')) {
          throw new Error('append 需要非空 text');
        }
        let text;
        if (action === 'clear') {
          text = '';
        } else if (action === 'write') {
          text = input.text;
        } else {
          const resolved = store.resolveFor(target);
          const existing = resolved === undefined ? '' : resolved.entry.text;
          text = existing.trim() === '' ? input.text : `${existing.replace(/\s+$/, '')}\n\n${input.text}`;
        }
        const entry = store.writeEntry({
          path: target,
          text,
          title: typeof input.title === 'string' ? input.title : undefined,
          updatedBy: 'tool',
        });
        return lossless({ ok: true, action, ...entryView(entry), note: '下一次模型请求起生效' });
      }

      if (action === 'set_enabled') {
        if (typeof input.enabled !== 'boolean') throw new Error('set_enabled 需要布尔 enabled');
        const target = targetOf();
        const entry = store.setEnabled(target, input.enabled);
        return lossless({ ok: true, action, ...entryView(entry), note: '下一次模型请求起生效' });
      }

      throw new Error(`未知 action：${action}（合法值 list/read/write/append/clear/set_enabled）`);
    },
    presentCall(args) {
      const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : 'read';
      const path = args !== null && typeof args === 'object' && typeof args.path === 'string' ? ` ${args.path}` : '';
      return { card: 'generic', kind: 'execute', title: `工作区常驻上下文：${action}${path}` };
    },
  }));

  // ── ③ 浏览器 API（同源守卫；写操作只走这里或工具） ─────────────────────────
  //
  // 守卫口径（比 ultracode 那版更严，取 dsh-archived-sessions / dsh-client-connection
  // 的两条浏览器侧判据）：
  //   · `sec-fetch-site: cross-site` 一律拒；
  //   · 带 Origin 时必须与 Host 同源；**`Origin: null` 按跨站处理**——它不是本页面的
  //     同源来源（沙箱 iframe / data: / file: 页面都会发 null）；
  //   · 无 Origin 头（本机 curl、CLI、同源 GET 导航）放行。
  // 为什么值得更严：本插件的写路由会把正文写进**系统提示词**，等价于一条可持久的
  // prompt 注入面；任何跨站可达的写路径都不能只靠「读者拿不到响应」兜底。
  const sameOrigin = (req) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };
  const apiJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const apiError = (res, status, error) => {
    diag.routeErrors += 1;
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: message }));
  };
  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 4_000_000) rejectBody(new Error('请求体过大'));
    });
    req.on('end', () => resolveBody(text));
    req.on('error', rejectBody);
  });

  /** 已知工作区：workspaceRegistry 的正式记录 + 本插件见过的会话 cwd。 */
  const knownWorkspaces = () => {
    const list = [];
    const registry = ctx.get('workspaceRegistry');
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) {
          if (workspace !== null && typeof workspace === 'object' && typeof workspace.path === 'string') {
            list.push({ path: workspace.path, title: workspace.title, source: 'registry' });
          }
        }
      } catch (error) {
        diag.loadError = `workspaceRegistry.list 失败：${error && error.message ? error.message : error}`;
      }
    }
    for (const cwd of seenCwds.keys()) list.push({ path: cwd, source: 'seen' });
    return list;
  };

  /** 给浏览器半边的状态视图；`cwd` 给定时附带「该工作区当前会注入什么」。 */
  const stateView = (cwd) => {
    let index;
    try {
      index = store.scan(false);
    } catch (error) {
      return { version: VERSION, schema: SCHEMA, ok: false, error: error && error.message ? error.message : String(error), diag: { ...diag } };
    }
    let current;
    if (typeof cwd === 'string' && cwd !== '') {
      try {
        const resolved = store.resolveFor(cwd);
        current = resolved === undefined
          ? { cwd, hit: false }
          : { cwd, hit: true, via: resolved.via, path: resolved.entry.path, title: resolved.entry.title, enabled: resolved.entry.enabled, textBytes: resolved.entry.textBytes };
      } catch (error) {
        current = { cwd, hit: false, error: error && error.message ? error.message : String(error) };
      }
    }
    return {
      ok: true,
      version: VERSION,
      schema: SCHEMA,
      dir: store.dir,
      contextsDir: store.contextsDir,
      trashDir: store.trashDir,
      revision: index.revision,
      config: {
        enabled: options.enabled,
        ttlMs: store.ttlMs,
        maxBytes: store.maxBytes,
        inheritFromAncestor: store.inheritFromAncestor,
        sectionName: options.sectionName,
        dshHome: dshHome(),
      },
      entries: index.entries.map((entry) => ({
        path: entry.path,
        title: entry.title,
        enabled: entry.enabled,
        file: entry.file,
        name: entry.name,
        bytes: entry.bytes,
        textBytes: entry.textBytes,
        digest: entry.digest,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
        exists: entry.exists,
        text: entry.text,
      })),
      unbound: index.unbound,
      errors: index.errors,
      workspaces: store.workspaceList(knownWorkspaces()),
      current,
      diag: {
        ...diag,
        seenCwds: [...seenCwds.keys()],
      },
    };
  };

  const webServer = ctx.get('webServer');
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    diag.routes = true;
    const postRoute = (path, handler, label) => {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (req.method !== 'POST') return apiError(res, 405, 'Method Not Allowed');
          if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
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
              return apiError(res, 400, error);
            }
          }).catch((error) => apiError(res, 400, error));
        },
      }), label);
    };

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + '/state',
      handler: (req, res) => {
        if (req.method !== 'GET') return apiError(res, 405, 'Method Not Allowed');
        if (!sameOrigin(req)) return apiError(res, 403, 'cross-origin request rejected');
        let cwd;
        try {
          cwd = new URL(req.url, 'http://localhost').searchParams.get('cwd') ?? undefined;
        } catch {
          cwd = undefined;
        }
        try {
          return apiJson(res, 200, stateView(cwd));
        } catch (error) {
          return apiError(res, 500, error);
        }
      },
    }), 'dsh-workspace-context state route');

    postRoute(ROUTE_PREFIX + '/save', (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path 必填');
      if (typeof args.text !== 'string') throw new Error('text 必须是字符串（空串=清空正文）');
      store.writeEntry({
        path: args.path,
        text: args.text,
        title: typeof args.title === 'string' ? args.title : undefined,
        enabled: args.enabled === undefined ? undefined : args.enabled !== false,
        updatedBy: 'human',
      });
      return stateView(typeof args.cwd === 'string' ? args.cwd : args.path);
    }, 'dsh-workspace-context save route');

    postRoute(ROUTE_PREFIX + '/enabled', (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path 必填');
      if (typeof args.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
      store.setEnabled(args.path, args.enabled);
      return stateView(args.path);
    }, 'dsh-workspace-context enabled route');

    postRoute(ROUTE_PREFIX + '/bind', (args) => {
      if (typeof args.file !== 'string' || args.file === '') throw new Error('file 必填');
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path 必填');
      store.bind({
        file: args.file,
        path: args.path,
        title: typeof args.title === 'string' ? args.title : undefined,
        overwrite: args.overwrite === true,
      });
      return stateView(args.path);
    }, 'dsh-workspace-context bind route');

    postRoute(ROUTE_PREFIX + '/trash', (args) => {
      if (typeof args.path !== 'string' || args.path.trim() === '') throw new Error('path 必填');
      const trashed = store.trashEntry(args.path);
      const view = stateView(args.path);
      view.trashed = trashed;
      return view;
    }, 'dsh-workspace-context trash route');

    postRoute(ROUTE_PREFIX + '/reload', (args) => {
      store.invalidate();
      store.scan(true);
      return stateView(typeof args.cwd === 'string' ? args.cwd : undefined);
    }, 'dsh-workspace-context reload route');
  }

  // 启动即建目录：用户一眼能看到文件该放哪里（失败不致命，留给诊断上报）。
  try {
    store.ensureDirs();
    store.scan(true);
  } catch (error) {
    diag.loadError = error && error.message ? error.message : String(error);
  }
}