/**
 * REA（Reverse Engineer Anything）工具选择器 — host 半边。
 *
 * 与 `cordis.patch.yml` 里的 `rea-mcp-server` 行配合工作：那一行用
 * `@deepseek-ai/dsh-mcp-client` 把 REA 的 stdio MCP 服务器（`rea mcp`）接进来，
 * 于是注册表里出现 207 个 `mcp__rea__*` 工具。本插件**不碰连接**，只负责
 * 「哪些工具对模型可见」这一层，并把选择面做进设置页（client.js）。
 *
 * 为什么必须走 `tools.restrict()`：
 *   · dsh-mcp-client 没有 allowlist/裁剪配置项，207 个 tool schema（约 830 KB
 *     序列化后）会随每轮请求进模型上下文；
 *   · `tools.restrict()` 是 Harness 唯一的官方裁剪口，它按 Agent 作用域过滤
 *     **继承来的**全局工具（`deny`），被挡掉的工具在 `schemas(agent)` 里直接消失
 *     —— 模型既看不到 schema，也调不动（`execute` 报 UNKNOWN_TOOL）；
 *   · 它只能在带作用域标签的上下文（`agent.ctx`）里调，进程级限制会遮住所有
 *     Agent 并被框架显式拒绝，所以这里逐 Agent 挂、随 Agent 生命周期回收。
 *
 * 生效链路（都是现成机制，没有自造状态层）：
 *   设置页 → POST /dsh-rea-mcp/save → 落盘 tools.json → 立即重算并重挂限制
 *   → 下一轮请求的工具表就是新的。REA 重连/换工具时 `tools/change` 会触发重算，
 *   新工具按当前策略（全选 or 自定义）自动纳入。
 *
 * 选择语义：
 *   masterEnabled=false → 所有 `mcp__rea__*` 一律隐藏（连接保持，只是不给模型看）；
 *   mode='all'          → 全放行，新增工具自动可见；
 *   mode='custom'       → 只放行 `enabled` 里的名字，未列出的（含新增）默认隐藏。
 *
 * 已知边界：
 *   · 只过滤**全局层**注册的 `mcp__rea__*`。若哪天把 mcp-client 行挂到某个
 *     agent 预设里（作用域层），本插件看不到也管不到它（如实记日志）；
 *   · 工具全隐藏时，模型没有办法自己把它们打开——只能在设置页或 patch 里改；
 *   · 本进程里已存在的 Agent 在插件加载时会被补挂限制；插件卸载或 host 行改
 *     `disabled: true` 后，限制随 disposer 一起摘掉（恢复原可见面）。
 *
 * @module @local/rea-mcp
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'rea-mcp';
/** 需要的能力：注册表（过滤）、Agent 清单（补挂/回收）、HTTP 载体（设置页路由）。 */
export const inject = ['tools', 'agents', 'webServer'];

const PREFIX = 'mcp__rea__';
const ROUTE_STATE = '/dsh-rea-mcp/state';
const ROUTE_SAVE = '/dsh-rea-mcp/save';
const ROUTE_RESET = '/dsh-rea-mcp/reset';
const ROUTE_WORKBENCH = '/dsh-rea-mcp/workbench';
const STATE_VERSION = 1;
const MAX_BODY_BYTES = 1 << 20;
const MAX_DESCRIPTION = 220;

/** 推荐核心集：日常逆向最常用的入口，名字不存在时自动忽略。 */
const CORE = [
  'binary_session',
  'open_binary',
  'close_binary',
  'analyze_function',
  'procedure_pseudo_code',
  'procedure_assembly',
  'procedure_info',
  'list_procedures',
  'list_strings',
  'search_strings',
  'search_procedures',
  'xrefs',
  'get_call_graph',
  'read_bytes',
  'read_function_instructions',
  'batch_decompile',
  'inspect_artifact',
  'extract_artifact',
  'analyze_javascript_application',
  'inspect_managed_artifact',
  'inspect_managed_members',
  'inspect_go_binary',
  'inspect_rust_binary',
  'inspect_pe_resources',
  'inspect_sqlite_database',
  'inspect_wasm_artifact',
  'list_unknowns',
  'get_evidence_bundle',
];

/** 分组规则：按顺序取第一个命中项，纯粹为了 UI 可读性，不参与权限判断。 */
const GROUPS = [
  ['android', 'Android / adb / JEB', /(^inspect_adb|^list_adb|^pull_adb|^push_adb|^read_adb|^resolve_adb|^install_adb|^uninstall_adb|^start_adb|^stop_adb|^capture_adb|^collect_adb|android|flutter|dart_aot|apktool|_jeb_)/],
  ['debug', '调试 / 运行时注入', /(frida|cutter|rizin|gdb|observe_native|instrument_|native_ui)/],
  ['web', 'Web / Electron / JS 运行时', /(web_|browser|electron_javascript|javascript|trace_web|source_location|recover_javascript)/],
  ['net', '抓包 / 信号', /(pcap|packet|signal)/],
  ['firmware', '固件', /(firmware|binwalk|unblob)/],
  ['dotnet', '.NET / 托管代码', /(managed|pe_resources)/],
  ['format', '格式识别（Go/Rust/WASM/EVM/SQLite/崩溃）', /(go_binary|rust_binary|wasm|evm|sqlite|recorded_crash|binary_layout)/],
  ['artifact', '包 / 存档 / Apple 资产', /(artifact|extract_|interface_builder|keyed_archive|asset_catalog|dylib|macho|plist|signature|architectures|fuses)/],
  ['evidence', '证据 / 比较 / 重构校验', /(evidence|unknown|compare_|verify_|project_|ledger|reconstruction|correlate_|find_changed_behavior|build_call_path|import_|export_)/],
  ['native', '原生分析（打开/反编译/符号）', /.*/],
];

function groupOf(rawName) {
  for (const [key, label, test] of GROUPS) if (test.test(rawName)) return { key, label };
  return { key: 'native', label: '原生分析（打开/反编译/符号）' };
}

function isReaTool(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(PREFIX);
}

function rawOf(publicName) {
  return publicName.slice(PREFIX.length);
}

function schemaBytesOf(schema) {
  try {
    return Buffer.byteLength(JSON.stringify({ name: schema.name, description: schema.description, parameters: schema.parameters }), 'utf8');
  } catch {
    return 0;
  }
}

function defaultState() {
  return { version: STATE_VERSION, masterEnabled: true, mode: 'all', enabled: [], updatedAt: null };
}

/** 宽进严出：永远返回可用的 state，坏文件不猜、只记 issue 并回落默认。 */
function normalizeState(input) {
  const issues = [];
  const state = defaultState();
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (input !== undefined) issues.push('state 文件不是对象，已回落默认（全选）。');
    return { state, issues };
  }
  if (typeof input.masterEnabled === 'boolean') state.masterEnabled = input.masterEnabled;
  else if (input.masterEnabled !== undefined) issues.push('masterEnabled 不是布尔值，已回落 true。');
  if (input.mode === 'all' || input.mode === 'custom') state.mode = input.mode;
  else if (input.mode !== undefined) issues.push(`mode "${String(input.mode)}" 非法，已回落 all。`);
  if (Array.isArray(input.enabled)) {
    const seen = new Set();
    for (const item of input.enabled) {
      if (typeof item !== 'string' || !isReaTool(item)) {
        issues.push(`enabled 里的 "${String(item)}" 不是 ${PREFIX}* 工具名，已忽略。`);
        continue;
      }
      if (seen.has(item)) continue;
      seen.add(item);
      state.enabled.push(item);
    }
  } else if (input.enabled !== undefined) {
    issues.push('enabled 不是数组，已回落空列表。');
  }
  if (typeof input.updatedAt === 'string') state.updatedAt = input.updatedAt;
  return { state, issues };
}

function statePathOf(config) {
  if (typeof config?.stateFile === 'string' && config.stateFile !== '') return config.stateFile;
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'rea-mcp', 'tools.json');
}

async function readStateFile(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { raw: JSON.parse(text), error: null };
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT') return { raw: undefined, error: null };
    return { raw: undefined, error: `${path} 读取失败（${String(error?.message ?? error)}），本次按默认全选处理。` };
  }
}

/** 原子写：同目录临时文件 + rename，0600（里面只有工具名，仍按用户数据对待）。 */
async function writeStateFile(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, error: `请求体超过 ${limit} 字节` });
        if (typeof req.destroy === 'function') req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (error) => finish({ ok: false, status: 400, error: `读取请求体失败：${String(error?.message ?? error)}` }));
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function jsonOf(res) {
  return (status, value) => {
    if (res.headersSent === true) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
}

/**
 * @param ctx - 本插件的 fiber 上下文（host 根作用域）。
 * @param config - patch 里的 config（可省略）；目前支持 stateFile 与 serverName 前缀展示。
 */
export function apply(ctx, config) {
  const stateFile = statePathOf(config);
  const prefix = typeof config?.serverPrefix === 'string' && config.serverPrefix !== '' ? config.serverPrefix : PREFIX;
  const log = (level, message, extra) => {
    const line = `[rea-mcp] ${message}`;
    try {
      const logger = ctx.logger;
      const sink = logger === undefined ? undefined : logger[level];
      if (typeof sink === 'function') {
        if (extra !== undefined) sink.call(logger, line, extra);
        else sink.call(logger, line);
      }
    } catch { /* 日志不是关键路径 */ }
    if (level !== 'info') note(message);
  };

  let state = defaultState();
  let loadIssues = [];
  /** 最近诊断（环形、有上限）：没有日志服务时，设置页也能看到「为什么没生效」。 */
  const notes = [];
  const note = (message) => {
    notes.push(message);
    if (notes.length > 20) notes.splice(0, notes.length - 20);
  };
  /** sessionId → { key, dispose }：每个活 Agent 身上已挂的那条限制。 */
  const applied = new Map();
  let readStatePromise = (async () => {
    const read = await readStateFile(stateFile);
    const normalized = normalizeState(read.raw);
    state = normalized.state;
    loadIssues = [...(read.error === null ? [] : [read.error]), ...normalized.issues];
    if (read.raw !== undefined) log('info', `已读取选择：${state.masterEnabled ? '启用' : '停用'} / ${state.mode} / ${state.enabled.length} 个白名单`);
  })();

  /** 全局层里现存的 REA 工具 schema（限制挂在各 Agent 层，不影响这个视图）。 */
  function liveReaSchemas() {
    try {
      const schemas = ctx.tools.schemas();
      return Array.isArray(schemas) ? schemas.filter((schema) => isReaTool(schema?.name)) : [];
    } catch (error) {
      log('warn', `读取工具注册表失败：${String(error?.message ?? error)}`);
      return [];
    }
  }

  function liveReaNames() {
    return liveReaSchemas().map((schema) => schema.name);
  }

  /** 当前策略下应被隐藏的 REA 工具名。 */
  function desiredDeny() {
    const names = liveReaNames();
    if (names.length === 0) return [];
    if (state.masterEnabled !== true) return names;
    if (state.mode === 'all') return [];
    const on = new Set(state.enabled);
    return names.filter((toolName) => !on.has(toolName));
  }

  function agentCtxOf(agent) {
    const agentCtx = agent?.ctx;
    if (agentCtx === undefined || typeof agentCtx?.tools?.restrict !== 'function') return undefined;
    return agentCtx;
  }

  /** 给一个 Agent 重挂限制；deny 集合没变就跳过（避免 tools/change 自激）。 */
  function applyFor(agent) {
    const agentCtx = agentCtxOf(agent);
    if (agentCtx === undefined) {
      // 例如宿主自己构造的占位 Agent：没有作用域上下文，限制无处可挂。
      return;
    }
    const deny = desiredDeny();
    const key = `${state.masterEnabled ? 'on' : 'off'}/${state.mode}/${deny.join(',')}`;
    const record = applied.get(agent.id);
    if (record !== undefined && record.key === key) return;
    if (record !== undefined) {
      try {
        record.dispose();
      } catch (error) {
        log('warn', `摘除旧限制失败（agent ${agent.id}）：${String(error?.message ?? error)}`);
      }
      applied.delete(agent.id);
    }
    if (deny.length === 0) return;
    try {
      const dispose = agentCtx.tools.restrict({ deny });
      if (typeof dispose === 'function') applied.set(agent.id, { key, dispose });
    } catch (error) {
      // 名字刚被注销时 restrict 会拒绝（unknown global tool）；下一轮 tools/change 会重算。
      log('warn', `挂载工具限制失败（agent ${agent.id}）：${String(error?.message ?? error)}`);
    }
  }

  function reapplyAll() {
    let agents = [];
    try {
      agents = ctx.agents.list();
    } catch (error) {
      log('warn', `列出 Agent 失败：${String(error?.message ?? error)}`);
      return;
    }
    for (const agent of agents) applyFor(agent);
  }

  function snapshot() {
    const schemas = liveReaSchemas();
    const enabledSet = new Set(state.enabled);
    const tools = schemas.map((schema) => {
      const raw = rawOf(schema.name);
      const group = groupOf(raw);
      const enabled = state.masterEnabled === true && (state.mode === 'all' || enabledSet.has(schema.name));
      return {
        name: schema.name,
        raw,
        group: group.key,
        groupLabel: group.label,
        description: typeof schema.description === 'string' ? schema.description.slice(0, MAX_DESCRIPTION) : '',
        bytes: schemaBytesOf(schema),
        enabled,
      };
    });
    tools.sort((a, b) => (a.group === b.group ? a.raw.localeCompare(b.raw) : a.group.localeCompare(b.group)));
    const allBytes = tools.reduce((sum, tool) => sum + tool.bytes, 0);
    const enabledTools = tools.filter((tool) => tool.enabled);
    const groupTotals = new Map();
    for (const tool of tools) {
      const entry = groupTotals.get(tool.group) ?? { key: tool.group, label: tool.groupLabel, total: 0, enabled: 0 };
      entry.total += 1;
      if (tool.enabled) entry.enabled += 1;
      groupTotals.set(tool.group, entry);
    }
    const known = new Set(tools.map((tool) => tool.name));
    const presets = [
      { id: 'all', label: '全选', names: tools.map((tool) => tool.name) },
      { id: 'none', label: '全不选', names: [] },
      {
        id: 'core',
        label: '核心推荐',
        names: CORE.map((raw) => `${PREFIX}${raw}`).filter((toolName) => known.has(toolName)),
      },
    ];
    return {
      ok: true,
      state: { ...state },
      tools,
      groups: [...groupTotals.values()],
      presets,
      stats: {
        total: tools.length,
        enabled: enabledTools.length,
        schemaBytes: enabledTools.reduce((sum, tool) => sum + tool.bytes, 0),
        allSchemaBytes: allBytes,
      },
      server: {
        prefix,
        stateFile,
        connected: tools.length > 0,
        agents: (() => {
          try {
            return ctx.agents.list().length;
          } catch {
            return 0;
          }
        })(),
        applied: applied.size,
        notes: notes.slice(),
      },
      issues: loadIssues,
    };
  }

  function sanitizeSave(body) {
    const issues = [];
    const next = defaultState();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'body 必须是对象' };
    }
    if (typeof body.masterEnabled !== 'boolean') return { ok: false, error: 'masterEnabled 必须是布尔值' };
    next.masterEnabled = body.masterEnabled;
    if (body.mode !== 'all' && body.mode !== 'custom') return { ok: false, error: 'mode 必须是 "all" 或 "custom"' };
    next.mode = body.mode;
    if (!Array.isArray(body.enabled)) return { ok: false, error: 'enabled 必须是数组' };
    const known = new Set(liveReaNames());
    const seen = new Set();
    for (const item of body.enabled) {
      if (typeof item !== 'string' || !isReaTool(item)) {
        issues.push(`忽略非法工具名 ${String(item)}`);
        continue;
      }
      if (seen.has(item)) continue;
      seen.add(item);
      // 允许保存当前未注册的名字（例如 REA 重连中），但提示一句。
      if (!known.has(item)) issues.push(`"${item}" 当前未注册，先记为启用（连上后自动生效）`);
      next.enabled.push(item);
    }
    next.updatedAt = new Date().toISOString();
    return { ok: true, state: next, issues };
  }

  async function persist(next) {
    await writeStateFile(stateFile, next);
    state = next;
    reapplyAll();
  }

  async function handleState(req, res, json) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method Not Allowed' });
    await readStatePromise;
    return json(200, snapshot());
  }

  async function handleSave(req, res, json) {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) return json(body.status, { error: body.error });
    let parsed;
    try {
      parsed = JSON.parse(body.text === '' ? 'null' : body.text);
    } catch {
      return json(400, { error: 'body 不是合法 JSON' });
    }
    await readStatePromise;
    const sanitized = sanitizeSave(parsed);
    if (!sanitized.ok) return json(400, { error: sanitized.error });
    try {
      await persist(sanitized.state);
    } catch (error) {
      return json(500, { error: `写入选择失败：${String(error?.message ?? error)}` });
    }
    loadIssues = sanitized.issues;
    const payload = snapshot();
    payload.saved = true;
    payload.issues = sanitized.issues;
    log('info', `已保存选择：${state.masterEnabled ? '启用' : '停用'} / ${state.mode} / ${state.enabled.length} 个白名单 → ${payload.stats.enabled}/${payload.stats.total} 个工具可见`);
    return json(200, payload);
  }

  async function handleReset(req, res, json) {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    await readStatePromise;
    const next = { ...defaultState(), updatedAt: new Date().toISOString() };
    try {
      await persist(next);
    } catch (error) {
      return json(500, { error: `重置失败：${String(error?.message ?? error)}` });
    }
    loadIssues = [];
    const payload = snapshot();
    payload.saved = true;
    return json(200, payload);
  }


  /**
   * 工作箱直连路由（dsh-workbench 用）：只翻转 masterEnabled，mode / enabled 白名单
   * 原样保留——设置页里精挑的工具集不被工作箱破坏。与 /save 同一套校验与落盘路径。
   */
  async function handleWorkbench(req, res, json) {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) return json(body.status, { error: body.error });
    let parsed;
    try {
      parsed = JSON.parse(body.text === '' ? 'null' : body.text);
    } catch {
      return json(400, { error: 'body 不是合法 JSON' });
    }
    if (typeof parsed?.on !== 'boolean') return json(400, { error: 'on 必须是布尔值' });
    await readStatePromise;
    const next = { ...state, masterEnabled: parsed.on, updatedAt: new Date().toISOString() };
    try {
      await persist(next);
    } catch (error) {
      return json(500, { error: `写入选择失败：${String(error?.message ?? error)}` });
    }
    const payload = snapshot();
    payload.saved = true;
    log('info', `workbench 联动：masterEnabled → ${parsed.on}（${payload.stats.enabled}/${payload.stats.total} 个工具可见）`);
    return json(200, payload);
  }

  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      const json = jsonOf(res);
      Promise.resolve()
        .then(() => handler(req, res, json))
        .catch((error) => json(500, { error: `rea-mcp 路由内部错误：${String(error?.message ?? error)}` }));
    },
  }), `rea-mcp: ${path}`);

  route(ROUTE_STATE, handleState);
  route(ROUTE_SAVE, handleSave);
  route(ROUTE_RESET, handleReset);
  route(ROUTE_WORKBENCH, handleWorkbench);

  // 新 Agent 创建时补挂；已存在的 Agent 在加载完成后补一次。
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => { applyFor(agent); }));
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    const record = applied.get(agent.id);
    if (record !== undefined) {
      try {
        record.dispose();
      } catch { /* Agent 已销毁：disposer 可能已随作用域回收 */ }
      applied.delete(agent.id);
    }
  }));

  // REA 连上/换工具/限制变化都会发 tools/change；合并 150ms 后重算。
  let pending = null;
  ctx.effect(() => ctx.on('tools/change', () => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      reapplyAll();
    }, 150);
  }));
  ctx.effect(() => () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    for (const record of applied.values()) {
      try {
        record.dispose();
      } catch { /* 已在回收路径上 */ }
    }
    applied.clear();
  });

  // 首轮：等状态读完再补挂现存 Agent（mcp 工具此时可能还没注册，tools/change 会兜住）。
  void readStatePromise.then(() => {
    reapplyAll();
    log('info', `工具选择器就绪（state=${stateFile}，当前可见 ${snapshot().stats.enabled}/${snapshot().stats.total}）`);
  });
}
