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
 *   设置页/工作箱 → POST /dsh-rea-mcp/{save,workbench} → 落盘 tools.json
 *   → 立即重算并重挂限制 → 下一轮请求的工具表就是新的。REA 重连/换工具时
 *   `tools/change` 会触发重算，新工具按当前策略（全选 or 自定义）自动纳入。
 *
 * 选择语义（v2：**按会话隔离**）：
 *   masterEnabled=false → 该会话的所有 `mcp__rea__*` 一律隐藏（连接保持，只是不给模型看）；
 *   mode='all'          → 全放行，新增工具自动可见；
 *   mode='custom'       → 只放行 `enabled` 里的名字，未列出的（含新增）默认隐藏。
 *
 * 会话隔离（v2 起）：
 *   状态文件是 `{ version: 2, defaults: {…}, sessions: { <家族根>: {…} } }`。
 *   · `defaults` 是「没有单独设置的会话」继承的那一份（新会话从它开始）；
 *   · `sessions[root]` 是该会话（含它的分支/子代理）的覆盖，**不影响别的会话**；
 *   · 家族键 = 沿 `session.header.parentSession` 一直往上走（与 dsh-workbench 的
 *     家族语义同一套：分支上改 = 全家族一起改），深度上限 64，遇环即停；
 *   · v1 的老文件（顶层直接是 masterEnabled/mode/enabled）在读入时迁移到
 *     `defaults`，随后立刻按 v2 落盘——老状态一条都不丢。
 *   · 子代理各自有自己的 `agent.ctx`，但它们的 sessionId 落在同一家族里，所以
 *     自然继承父会话那一份（这是刻意的，不是意外）。
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
const ROUTE_EFFECTIVE = '/dsh-rea-mcp/effective';
const STATE_VERSION = 2;
/** 家族上溯深度上限（与 dsh-workbench / dsh-ultracode 同口径）。 */
const MAX_FAMILY_DEPTH = 64;
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

// ── 状态：一份 defaults + 若干会话覆盖 ─────────────────────────────────────

/** 单份选择（一个会话覆盖，或 defaults）。 */
function defaultSelection() {
  return { masterEnabled: true, mode: 'all', enabled: [], updatedAt: null };
}

/** 整份文件。 */
function defaultFile() {
  return { version: STATE_VERSION, defaults: defaultSelection(), sessions: {}, updatedAt: null };
}

/** 宽进严出：单份选择永远是可用的，坏字段只记 issue 并回落默认。 */
function normalizeSelection(input, label) {
  const issues = [];
  const selection = defaultSelection();
  const at = label === undefined ? '' : `${label}：`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (input !== undefined) issues.push(`${at}不是对象，已回落默认（全选）。`);
    return { selection, issues };
  }
  if (typeof input.masterEnabled === 'boolean') selection.masterEnabled = input.masterEnabled;
  else if (input.masterEnabled !== undefined) issues.push(`${at}masterEnabled 不是布尔值，已回落 true。`);
  if (input.mode === 'all' || input.mode === 'custom') selection.mode = input.mode;
  else if (input.mode !== undefined) issues.push(`${at}mode "${String(input.mode)}" 非法，已回落 all。`);
  if (Array.isArray(input.enabled)) {
    const seen = new Set();
    for (const item of input.enabled) {
      if (typeof item !== 'string' || !isReaTool(item)) {
        issues.push(`${at}enabled 里的 "${String(item)}" 不是 ${PREFIX}* 工具名，已忽略。`);
        continue;
      }
      if (seen.has(item)) continue;
      seen.add(item);
      selection.enabled.push(item);
    }
  } else if (input.enabled !== undefined) {
    issues.push(`${at}enabled 不是数组，已回落空列表。`);
  }
  if (typeof input.updatedAt === 'string') selection.updatedAt = input.updatedAt;
  return { selection, issues };
}

/** 整份文件归一；v1（顶层直接是选择）迁移进 defaults。 */
function normalizeFile(input) {
  const issues = [];
  const file = defaultFile();
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (input !== undefined) issues.push('state 文件不是对象，已回落默认（全选）。');
    return { file, issues, migratedFrom: null };
  }
  // 三种情况分开处理：v1（顶层直接是选择，迁移进 defaults）、v2 形状、以及
  // 「比本插件更新」的文件。后者只读不写回——否则会把别人的新语义静默降级。
  const version = Number(input.version);
  const newer = Number.isFinite(version) && version > STATE_VERSION;
  const hasV2Shape = input.defaults !== undefined || input.sessions !== undefined;
  if (!hasV2Shape && !newer) {
    // v1：整份文件就是一份全局选择（含 `{ version: 1, masterEnabled… }` 这种写法）。
    const normalized = normalizeSelection(input, 'defaults');
    file.defaults = normalized.selection;
    issues.push(...normalized.issues);
    return { file, issues, migratedFrom: 1 };
  }
  const normalizedDefaults = normalizeSelection(input.defaults, 'defaults');
  file.defaults = normalizedDefaults.selection;
  issues.push(...normalizedDefaults.issues);
  if (input.sessions !== undefined && input.sessions !== null) {
    if (typeof input.sessions !== 'object' || Array.isArray(input.sessions)) {
      issues.push('sessions 不是对象，已回落空表。');
    } else {
      for (const [key, value] of Object.entries(input.sessions)) {
        if (typeof key !== 'string' || key === '') {
          issues.push('sessions 里出现空键，已忽略。');
          continue;
        }
        const normalized = normalizeSelection(value, `sessions[${key}]`);
        issues.push(...normalized.issues);
        file.sessions[key] = normalized.selection;
      }
    }
  }
  if (typeof input.updatedAt === 'string') file.updatedAt = input.updatedAt;
  if (newer) issues.push(`状态文件版本是 v${version}（本插件只认 v${STATE_VERSION}）：按 v2 解读，且不回写。`);
  // migratedFrom 只对 v1 有意义。更高版本不能重写（会把新语义降级），v2 无需迁移。
  return { file, issues, migratedFrom: null };
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
async function writeStateFile(path, file) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

/** 从 URL 里取 sessionId（GET 用 ?sessionId=，POST 用 body）。 */
function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function badSessionId(sessionId) {
  return sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string';
}

/**
 * @param ctx - 本插件的 fiber 上下文（host 根作用域）。
 * @param config - patch 里的 config（可省略）；目前支持 stateFile 与 serverPrefix。
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

  /** 整份状态（defaults + 会话覆盖）。 */
  let file = defaultFile();
  let loadIssues = [];
  /** 最近诊断（环形、有上限）：没有日志服务时，设置页也能看到「为什么没生效」。 */
  const notes = [];
  const note = (message) => {
    notes.push(message);
    if (notes.length > 20) notes.splice(0, notes.length - 20);
  };
  /** agent.id → { key, dispose }：每个活 Agent 身上已挂的那条限制。 */
  const applied = new Map();
  let readStatePromise = (async () => {
    const read = await readStateFile(stateFile);
    const normalized = normalizeFile(read.raw);
    file = normalized.file;
    loadIssues = [...(read.error === null ? [] : [read.error]), ...normalized.issues];
    if (normalized.migratedFrom !== null) {
      // 老格式（v1）迁移后立刻按 v2 落盘：工作箱/设置页看到的是同一种结构。
      try {
        await writeStateFile(stateFile, file);
        log('info', `state 已从 v${normalized.migratedFrom} 迁移到 v${STATE_VERSION}（全局选择 → defaults，会话覆盖表空）`);
      } catch (error) {
        loadIssues.push(`迁移落盘失败（${String(error?.message ?? error)}），本次仍按内存态运行。`);
      }
    }
    if (read.raw !== undefined) {
      log('info', `已读取选择：defaults ${file.defaults.masterEnabled ? '启用' : '停用'} / ${file.defaults.mode} / ${file.defaults.enabled.length} 个白名单，会话覆盖 ${Object.keys(file.sessions).length} 份`);
    }
  })();

  // ── 会话家族 ──────────────────────────────────────────────────────────────

  const sessionsService = () => {
    try { return ctx.get('sessions'); } catch { return undefined; }
  };

  /** 取一个会话的父会话 id（会话不在内存里 → undefined）。 */
  function parentOf(sessionId) {
    try {
      const live = sessionsService()?.get?.(sessionId);
      const parent = live?.header?.parentSession;
      return typeof parent === 'string' && parent !== '' ? parent : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 家族根：沿 `parentSession` 上溯（与 dsh-workbench 的 familyRootOf 同口径）。
   * 子代理（dsh-subagent 的 child agent）带 parentSession，因此与父会话共用一份选择；
   * `/fork` 出来的分支**不**带 parentSession（宿主只写 cwd/isSeeded），它是独立家族，
   * 落 defaults 继承。工作箱里那张表（ultracode.json 的 families）本插件不读：
   * 它的键是裸 UUID，与会话 id（session-<uuid>）对不上，读它反而会算出第二个根。
   */
  function familyRootOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    const seen = new Set();
    let current = sessionId;
    for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth += 1) {
      if (seen.has(current)) return sessionId;
      seen.add(current);
      const parent = parentOf(current);
      if (parent === undefined || parent === current) return current;
      current = parent;
    }
    return sessionId;
  }

  /** 在一份（可能是刚读盘的新）文档上算生效选择。 */
  function selectionOfIn(doc, sessionId) {
    const root = familyRootOf(sessionId);
    if (root !== undefined) {
      const override = doc.sessions[root];
      if (override !== undefined && override !== null && typeof override === 'object') {
        return { selection: override, root, source: 'session' };
      }
    }
    return { selection: doc.defaults, root, source: 'defaults' };
  }

  /** 一个会话当前生效的那份选择 + 来源说明（读内存态）。 */
  function selectionOf(sessionId) {
    return selectionOfIn(file, sessionId);
  }

  /** Agent 的会话身份（Agent 与 Session 同一身份；`agent.session` 是同一 id 的对象引用）。 */
  function sessionIdOf(agent) {
    const candidates = [agent?.session?.id, agent?.sessionId, agent?.id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
    return undefined;
  }

  // ── 工具面 ────────────────────────────────────────────────────────────────

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

  /** 给定一份选择 + 当前注册表，应被隐藏的 REA 工具名。 */
  function desiredDeny(selection) {
    const names = liveReaNames();
    if (names.length === 0) return [];
    if (selection.masterEnabled !== true) return names;
    if (selection.mode === 'all') return [];
    const on = new Set(selection.enabled);
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
    const sessionId = sessionIdOf(agent);
    const { selection, root, source } = selectionOf(sessionId);
    const deny = desiredDeny(selection);
    const key = `${root ?? '-'}/${source}/${selection.masterEnabled ? 'on' : 'off'}/${selection.mode}/${deny.join(',')}`;
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
      if (typeof dispose === 'function') {
        applied.set(agent.id, { key, dispose });
        restrictFailures = 0;
      }
    } catch (error) {
      // 名字刚被注销时 restrict 会拒绝（unknown global tool）。此时该 Agent 处于
      // 无限制状态，必须尽快补挂：退避重试，别等下一次 tools/change。
      log('warn', `挂载工具限制失败（agent ${agent.id}）：${String(error?.message ?? error)}`);
      scheduleRetry();
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

  // 重算调度：tools/change 用 150ms 防抖；restrict 抛错（工具名正在换代的瞬间）用
  // 1s 退避重试几次——不能只指望下一次 tools/change，那个事件可能再也不来，
  // 到时候这个 Agent 会一直看到全量 REA 工具（fail-open）。
  const RETRY_LIMIT = 5;
  let pending = null;
  let restrictFailures = 0;

  function scheduleReapply(delay) {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      reapplyAll();
    }, delay);
  }

  function scheduleRetry() {
    if (restrictFailures >= RETRY_LIMIT) return;
    restrictFailures += 1;
    scheduleReapply(1000);
  }

  /** 会话清单（供设置页选范围）：覆盖过的 + 当前在线的，按家族根去重。 */
  function sessionDirectory(activeRoot) {
    const entries = new Map();
    const add = (sessionId, live) => {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      const root = familyRootOf(sessionId) ?? sessionId;
      const existing = entries.get(root);
      const override = file.sessions[root] !== undefined;
      let cwd = existing?.cwd;
      if (cwd === undefined) {
        try {
          const value = sessionsService()?.get?.(root)?.header?.cwd;
          if (typeof value === 'string' && value !== '') cwd = value;
        } catch { /* 会话可能已不在内存里 */ }
      }
      entries.set(root, {
        root,
        sessionId: existing?.sessionId ?? sessionId,
        live: (existing?.live === true) || live,
        override,
        cwd,
        active: root === activeRoot,
      });
    };
    for (const root of Object.keys(file.sessions)) add(root, false);
    try {
      for (const agent of ctx.agents.list()) add(sessionIdOf(agent), true);
    } catch { /* 清单拿不到不影响主流程 */ }
    return [...entries.values()].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.override !== b.override) return a.override ? -1 : 1;
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.root.localeCompare(b.root);
    });
  }

  function snapshot(sessionId) {
    const { selection, root, source } = selectionOf(sessionId);
    const schemas = liveReaSchemas();
    const enabledSet = new Set(selection.enabled);
    const tools = schemas.map((schema) => {
      const raw = rawOf(schema.name);
      const group = groupOf(raw);
      const enabled = selection.masterEnabled === true && (selection.mode === 'all' || enabledSet.has(schema.name));
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
      // state 仍指向「本次作用域生效的那一份」：老的客户端字段不用改。
      state: { ...selection },
      scope: {
        sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
        root: root ?? null,
        source,
        hasOverride: source === 'session',
      },
      defaults: { ...file.defaults },
      sessions: Object.entries(file.sessions).map(([rootId, entry]) => ({
        root: rootId,
        masterEnabled: entry.masterEnabled === true,
        mode: entry.mode,
        enabledCount: entry.enabled.length,
        updatedAt: entry.updatedAt,
      })),
      directory: sessionDirectory(root),
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
        stateVersion: STATE_VERSION,
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
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'body 必须是对象' };
    }
    const next = defaultSelection();
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
    return { ok: true, selection: next, issues };
  }

  /** 把一份选择写到指定作用域（sessionId 缺省 = defaults），基于传入的文档而非内存态。 */
  function withSelectionIn(doc, sessionId, selection) {
    const next = {
      version: STATE_VERSION,
      defaults: doc.defaults,
      sessions: { ...doc.sessions },
      updatedAt: new Date().toISOString(),
    };
    if (typeof sessionId === 'string' && sessionId !== '') {
      const root = familyRootOf(sessionId) ?? sessionId;
      next.sessions[root] = selection;
      return { next, root, target: 'session' };
    }
    next.defaults = selection;
    return { next, root: null, target: 'defaults' };
  }

  /**
   * 三条写路由共用的落盘路径：串行化 + 写前重读。
   *
   * 为什么必须串行 + 重读：整份文件是「读-改-写」。两个窗口（设置页 + 工作箱浮层，
   * 或两个浏览器标签）几乎同时给**不同会话**翻开关时，若各自基于同一份旧快照构造
   * 新文件，后落地的那个会把前者刚写的 `sessions[别的会话]` 整份抹掉——覆盖静默
   * 消失、那个会话退回 defaults，而两边都收到 200。重读同时让手工修改生效（内存
   * 态不再无条件覆盖磁盘）。
   */
  let writeChain = Promise.resolve();
  function mutate(mutator) {
    const run = async () => {
      // 只有「读到了东西且没读坏」才采纳磁盘态；读坏了保留内存态，免得把好文件盖掉。
      const fresh = await readStateFile(stateFile);
      if (fresh.raw !== undefined && fresh.error === null) {
        const normalized = normalizeFile(fresh.raw);
        file = normalized.file;
        if (normalized.issues.length > 0) log('warn', `写前重读状态文件：${normalized.issues[0]}`);
      }
      const { next, ...meta } = mutator(file);
      await writeStateFile(stateFile, next);
      file = next;
      reapplyAll();
      return { ...meta, next };
    };
    const queued = writeChain.then(run, run);
    writeChain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function handleState(req, res, json) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method Not Allowed' });
    const sessionId = queryOf(req).get('sessionId') ?? undefined;
    if (badSessionId(sessionId)) return json(400, { error: 'sessionId 必须是字符串' });
    await readStatePromise;
    return json(200, snapshot(sessionId));
  }

  /** 轻量查询：工作箱/别的插件只需要「这个会话里 REA 开没开」。 */
  async function handleEffective(req, res, json) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method Not Allowed' });
    const sessionId = queryOf(req).get('sessionId') ?? undefined;
    if (badSessionId(sessionId)) return json(400, { error: 'sessionId 必须是字符串' });
    await readStatePromise;
    const { selection, root, source } = selectionOf(sessionId);
    return json(200, {
      ok: true,
      sessionId: sessionId ?? null,
      root: root ?? null,
      source,
      masterEnabled: selection.masterEnabled === true,
      mode: selection.mode,
      enabledCount: selection.enabled.length,
    });
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
    const wantSession = typeof parsed?.sessionId === 'string' && parsed.sessionId !== '';
    let target;
    let root;
    try {
      const outcome = await mutate((doc) => withSelectionIn(doc, wantSession ? parsed.sessionId : undefined, sanitized.selection));
      target = outcome.target;
      root = outcome.root;
    } catch (error) {
      return json(500, { error: `写入选择失败：${String(error?.message ?? error)}` });
    }
    loadIssues = sanitized.issues;
    const payload = snapshot(typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined);
    payload.saved = true;
    payload.issues = sanitized.issues;
    log('info', `已保存${target === 'session' ? `会话覆盖（${root}）` : '默认'}：${sanitized.selection.masterEnabled ? '启用' : '停用'} / ${sanitized.selection.mode} / ${sanitized.selection.enabled.length} 个白名单 → ${payload.stats.enabled}/${payload.stats.total} 个工具可见`);
    return json(200, payload);
  }

  async function handleReset(req, res, json) {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) return json(body.status, { error: body.error });
    let parsed = null;
    try {
      parsed = JSON.parse(body.text === '' ? 'null' : body.text);
    } catch {
      return json(400, { error: 'body 不是合法 JSON' });
    }
    await readStatePromise;
    const sessionId = typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : undefined;
    let cleared = 'defaults';
    try {
      await mutate((doc) => {
        const next = {
          version: STATE_VERSION,
          defaults: doc.defaults,
          sessions: { ...doc.sessions },
          updatedAt: new Date().toISOString(),
        };
        if (sessionId === undefined) {
          next.defaults = defaultSelection();
          cleared = 'defaults';
        } else {
          const root = familyRootOf(sessionId) ?? sessionId;
          delete next.sessions[root];
          cleared = `sessions[${root}]`;
        }
        return { next };
      });
    } catch (error) {
      return json(500, { error: `重置失败：${String(error?.message ?? error)}` });
    }
    loadIssues = [];
    const payload = snapshot(sessionId);
    payload.saved = true;
    payload.cleared = cleared;
    return json(200, payload);
  }

  /**
   * 工作箱直连路由（dsh-workbench 用）：只翻转该会话的 masterEnabled，mode /
   * enabled 白名单原样保留——设置页里精挑的工具集不被工作箱破坏。与 /save 同一
   * 套校验与落盘路径。body：`{ sessionId?, on }`；不带 sessionId = 改 defaults。
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
    const sessionId = typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : undefined;
    await readStatePromise;
    let root;
    let target;
    try {
      const outcome = await mutate((doc) => {
        const { selection } = selectionOfIn(doc, sessionId);
        // 覆盖是整份记录的：第一次在某会话里动开关时，先把生效的那份复制过来，
        // 之后这个会话的白名单就跟 defaults 脱钩（互不影响）。
        const nextSelection = { ...selection, enabled: [...selection.enabled], masterEnabled: parsed.on, updatedAt: new Date().toISOString() };
        return withSelectionIn(doc, sessionId, nextSelection);
      });
      root = outcome.root;
      target = outcome.target;
    } catch (error) {
      return json(500, { error: `写入选择失败：${String(error?.message ?? error)}` });
    }
    const payload = snapshot(sessionId);
    payload.saved = true;
    payload.target = target;
    log('info', `workbench 联动（${target === 'session' ? `会话 ${root}` : 'defaults'}）：masterEnabled → ${parsed.on}（${payload.stats.enabled}/${payload.stats.total} 个工具可见）`);
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
  route(ROUTE_EFFECTIVE, handleEffective);

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
  ctx.effect(() => ctx.on('tools/change', () => {
    // 工具表换代成功，之前的 restrict 失败不再是常态：重试额度归零。
    restrictFailures = 0;
    scheduleReapply(150);
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
    const total = snapshot(undefined).stats;
    log('info', `工具选择器就绪（state=${stateFile}，v${STATE_VERSION}，defaults 可见 ${total.enabled}/${total.total}，会话覆盖 ${Object.keys(file.sessions).length} 份）`);
  });
}
