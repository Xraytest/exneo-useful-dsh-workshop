/**
 * dsh-workspace-plugins —— 清单、路径匹配与落盘的**纯逻辑**（无 Cordis 依赖）。
 *
 * 拆出来的理由与同目录其它插件一致：匹配语义（精确/子树、最长优先）与清单
 * 校验是最容易出错、也最值得逐条单测的部分，不该埋在插件 apply 里。
 *
 * 术语：
 *   · 声明（declaration）—— 一条「工作区 → 子插件行」的配置；来源有两处：
 *     组合行 config（部署方写死在 profile 的 cordis.patch.yml，只读）与
 *     状态文件（设置页管理，落盘 $DSH_HOME/workspace-plugins.json）。
 *   · 附件（attachment）/行（row）—— 挂到某个工作区上的一个子插件：
 *     { id, name, disabled?, config?, isolate? }。
 *   · 有效清单（effective）—— 两处声明合并、去重、叠加停用标记后的结果，
 *     也是 host 半边唯一用于匹配与挂载的输入。
 *   · 工作区身份（workspace id）—— 出厂 workspaceRegistry 的 uuid；**跨设备一致**，
 *     所以能用它做声明的主键，而 path 是随设备变的。见 workspaceKeyOf()。
 *   · 网络工作区（network workspace）—— 同一份工作区在多台设备上各有路径：本机
 *     主路径（注册表登记的那条）＋设备网格账目里的附加路径（mirror/scratch，可能
 *     在别的设备上）。resolveWorkspaces() 把账目折成「本机可匹配的路径集合」。
 *
 * 路径口径：一律走 canonicalPath()（resolve → realpath（可行时）→ 去尾分隔符）。
 * 工作区账目（workspaceRegistry）本身是 realpath 口径，会话 cwd 多数是用户
 * 选定的绝对路径，两边都归一后比较，才不会出现「同一个目录两个拼写」。
 *
 * 本模块不认识 Cordis：注册表与设备网格都由调用方取成 JSON 投影后传进来，于是
 * 匹配语义可以在自测里用假投影逐条断言（见 selftest.mjs 的「网络工作区」一节）。
 *
 * @module dsh-workspace-plugins/store
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 状态文件格式版本。读到更高版本只警告、不猜字段。 */
export const STATE_VERSION = 1;

/** 工作区匹配方式：exact＝只认该目录本身；subtree＝该目录及其后代。 */
export const MATCH_MODES = ['exact', 'subtree'];

/** 行 id 的合法拼写（它会进状态文件、出现在路由参数里，也会显示在设置页）。 */
const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 工作区 id 的**宽松**拼写检查。
 *
 * id 的口径归出厂注册表所有（当前是 UUID），这里只挡明显的手误（空白、超长、
 * 控制字符），不替注册表定格式——将来 id 换形状也不该让本插件先坏。
 */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,79}$/;

/**
 * 一份声明的**稳定键**：能拿工作区 id 就用它，否则退回本机路径。
 *
 * 为什么要有这一层：网络工作区在两台设备上的路径**可能就是不一样的**，而 `path`
 * 是随设备变的拼写。用 id 做键之后，同一份声明（连同 configDisabled 里的停用
 * 标记）在每台设备上都能对回同一条记录；只给 path 的旧声明行为完全不变。
 * @param decl - 归一后的声明，或 mergeWorkspaces 合并后的记录。
 * @returns `ws:<id>` 或 `path:<本机路径>`。
 */
export function workspaceKeyOf(decl) {
  const id = typeof decl?.workspaceId === 'string' ? decl.workspaceId.trim() : '';
  if (id !== '') return `ws:${id}`;
  const path = typeof decl?.path === 'string' ? decl.path : '';
  return `path:${path}`;
}

// ── 路径 ──────────────────────────────────────────────────────────────────

/** DSH 主目录：与出厂 `dshHomePath()` 同一口径（环境变量优先，缺省 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/** 状态文件缺省路径。 */
export function defaultStatePath() {
  return join(dshHome(), 'workspace-plugins.json');
}

/**
 * 归一一个路径用于比较：绝对化 → realpath（目录不存在时退回绝对路径）→ 去尾分隔符。
 * realpath 让符号链接的两个拼写落到同一个键上；失败不抛（cwd 可能已被删除）。
 * @param value - 任意路径字符串。
 * @returns 归一后的绝对路径，输入非法时返回 null。
 */
export function canonicalPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const abs = resolve(value.trim());
  let real = abs;
  try {
    real = realpathSync.native(abs);
  } catch {
    // 目录不存在/无权限：保持 resolve 的结果，仍然可比。
  }
  if (real.length > 1 && real.endsWith(sep)) real = real.slice(0, -1);
  return real;
}

/**
 * `child` 是否等于 `parent` 或位于其子树内（两者都已归一）。
 * 用 relative() 而不是字符串前缀，避免 `/root/x` 命中 `/root/xy`。
 * @param child - 待测路径（已归一）。
 * @param parent - 工作区路径（已归一）。
 * @returns 是否包含。
 */
export function isInside(child, parent) {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ── 清单校验 ───────────────────────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 校验并归一一个子插件行。
 * @param raw - 状态文件/组合 config 里的一行。
 * @param where - 报错定位用的前缀（如 `工作区 /root/x`）。
 * @param index - 行下标。
 * @returns `{ row }` 或 `{ error }`。
 */
export function normalizeRow(raw, where, index) {
  const at = `${where} 第 ${String(index + 1)} 个子插件`;
  if (!isPlainObject(raw)) return { error: `${at}：必须是对象` };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return { error: `${at}：缺少 id` };
  if (!ROW_ID_PATTERN.test(id)) return { error: `${at}（${id}）：id 只能由字母/数字/._- 组成且以字母或数字开头` };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') return { error: `${at}（${id}）：缺少 name（模块标识）` };
  if (raw.disabled !== undefined && typeof raw.disabled !== 'boolean') return { error: `${at}（${id}）：disabled 必须是布尔值` };
  if (raw.config !== undefined && !isPlainObject(raw.config)) return { error: `${at}（${id}）：config 必须是对象` };
  const isolate = {};
  if (raw.isolate !== undefined) {
    if (!isPlainObject(raw.isolate)) return { error: `${at}（${id}）：isolate 必须是对象` };
    for (const [service, label] of Object.entries(raw.isolate)) {
      if (label !== true && typeof label !== 'string') return { error: `${at}（${id}）：isolate.${service} 只能是 true（每会话独立域）或字符串（同名共享域）` };
      if (label === '') return { error: `${at}（${id}）：isolate.${service} 的共享域标签不能是空串` };
      isolate[service] = label;
    }
  }
  const row = { id, name };
  if (raw.disabled === true) row.disabled = true;
  if (raw.config !== undefined) row.config = raw.config;
  if (Object.keys(isolate).length > 0) row.isolate = isolate;
  if (typeof raw.label === 'string' && raw.label.trim() !== '') row.label = raw.label.trim();
  return { row };
}

/**
 * 校验并归一一条工作区声明。
 * @param raw - `{ path, label?, match?, plugins: [...] }`。
 * @param where - 报错定位前缀。
 * @returns `{ decl }` 或 `{ error }`。
 */
/**
 * 归一一条工作区声明。
 *
 * 两种绑定方式（至少要给一个）：
 *   · path —— 按**本机路径**绑定（旧口径，缺省 exact）。路径随设备变。
 *   · workspace（别名 workspaceId）—— 按**工作区身份**绑定，即出厂注册表的 id。
 *     id 跨设备一致，于是同一份声明在每台设备上都指向同一个工作区——网络工作区
 *     的正解（本机主路径变了也不用改声明）。
 * 两者都给时：id 定身份，path 只当「本机路径应该在哪」的线索，以及注册表读不到时
 * 的回退（并在视图里标记出来，免得静默按错路径匹配）。
 * includeMembers：是否同时匹配该工作区在**本机**的附加路径（网格账目里的
 *   mirror/scratch），缺省 true。声明里写 false 可关掉。
 * @param raw - 声明原文。
 * @param where - 诊断前缀（写清是第几处）。
 * @returns `{ decl }` 或 `{ error }`。
 */
export function normalizeWorkspace(raw, where) {
  if (!isPlainObject(raw)) return { error: `${where}：必须是对象` };
  const rawId = raw.workspace ?? raw.workspaceId;
  let workspaceId;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    const text = String(rawId).trim();
    if (!WORKSPACE_ID_PATTERN.test(text)) {
      return { error: `${where}：workspace 必须是工作区 id（4–80 个字母/数字/. _ : -）：${text}` };
    }
    workspaceId = text;
  }
  const hasPath = typeof raw.path === 'string' && raw.path.trim() !== '';
  if (raw.path !== undefined && raw.path !== null && !hasPath) return { error: `${where}：path 必须是非空字符串` };
  if (!hasPath && workspaceId === undefined) return { error: `${where}：至少要给 path 或 workspace（工作区 id）之一` };
  let path;
  if (hasPath) {
    // `~` 展开与「必须绝对」都在 canonicalPath 之前判定：canonicalPath 会把相对路径
    // 解析成「相对进程 cwd」的绝对路径，那对声明来说是个静默的错绑定。
    let declared = raw.path.trim();
    if (declared === '~' || declared.startsWith('~/')) declared = join(homedir(), declared.slice(1));
    if (!isAbsolute(declared)) return { error: `${where}：path 必须是绝对路径（或以 ~/ 开头）：${raw.path}` };
    path = canonicalPath(declared);
    if (path === null) return { error: `${where}：path 非法` };
  }
  const at = path ?? workspaceId;
  if (raw.includeMembers !== undefined && typeof raw.includeMembers !== 'boolean') {
    return { error: `${where}（${at}）：includeMembers 只能是 true 或 false` };
  }
  if (raw.match !== undefined && !MATCH_MODES.includes(raw.match)) {
    return { error: `${where}（${at}）：match 只能是 ${MATCH_MODES.join(' 或 ')}` };
  }
  if (raw.label !== undefined && typeof raw.label !== 'string') return { error: `${where}（${at}）：label 必须是字符串` };
  if (raw.plugins !== undefined && !Array.isArray(raw.plugins)) return { error: `${where}（${at}）：plugins 必须是数组` };
  const plugins = [];
  const seen = new Set();
  const rows = Array.isArray(raw.plugins) ? raw.plugins : [];
  for (let index = 0; index < rows.length; index += 1) {
    const normalized = normalizeRow(rows[index], `${where}（${at}）`, index);
    if (normalized.error !== undefined) return { error: normalized.error };
    if (seen.has(normalized.row.id)) return { error: `${where}（${at}）：子插件 id 重复：${normalized.row.id}` };
    seen.add(normalized.row.id);
    plugins.push(normalized.row);
  }
  const decl = {
    workspaceId,
    path,
    includeMembers: raw.includeMembers !== false,
    match: raw.match === 'subtree' ? 'subtree' : 'exact',
    plugins,
  };
  if (typeof raw.label === 'string' && raw.label.trim() !== '') decl.label = raw.label.trim();
  return { decl };
}

export function blankState() {
  return { version: STATE_VERSION, workspaces: [], configDisabled: [] };
}

/**
 * 校验并归一状态文件内容。
 * 坏内容不抛异常：返回带 errors 的空/部分状态，让插件能继续运行并在设置页
 * 如实报告（与同目录插件的「坏文件保留上次可用快照」口径一致）。
 * @param raw - JSON.parse 的结果。
 * @returns `{ state, errors, warnings }`。
 */
export function normalizeState(raw) {
  const errors = [];
  const warnings = [];
  if (raw === undefined || raw === null) return { state: blankState(), errors, warnings };
  if (!isPlainObject(raw)) {
    errors.push('状态文件根节点必须是对象');
    return { state: blankState(), errors, warnings };
  }
  if (raw.version !== undefined && raw.version !== STATE_VERSION) {
    warnings.push(`状态文件 version=${String(raw.version)}，本插件按 version=${String(STATE_VERSION)} 读取，未知字段被忽略`);
  }
  const workspaces = [];
  const seenKeys = new Set();
  const rows = Array.isArray(raw.workspaces) ? raw.workspaces : [];
  if (raw.workspaces !== undefined && !Array.isArray(raw.workspaces)) errors.push('workspaces 必须是数组');
  for (let index = 0; index < rows.length; index += 1) {
    const normalized = normalizeWorkspace(rows[index], `状态文件 workspaces[${String(index)}]`);
    if (normalized.error !== undefined) {
      errors.push(normalized.error);
      continue;
    }
    const key = workspaceKeyOf(normalized.decl);
    if (seenKeys.has(key)) {
      errors.push(`状态文件里工作区重复：${normalized.decl.path ?? normalized.decl.workspaceId}（${key}）`);
      continue;
    }
    seenKeys.add(key);
    workspaces.push(normalized.decl);
  }
  const configDisabled = [];
  if (raw.configDisabled !== undefined && !Array.isArray(raw.configDisabled)) {
    errors.push('configDisabled 必须是数组');
  } else {
    for (const item of Array.isArray(raw.configDisabled) ? raw.configDisabled : []) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push('configDisabled 的每一项都必须是非空字符串（形如 <工作区路径>#<行 id>）');
        continue;
      }
      configDisabled.push(item.trim());
    }
  }
  return { state: { version: STATE_VERSION, workspaces, configDisabled }, errors, warnings };
}

/** 组合行 config 里「某工作区某个组合行」的停用键。 */
/**
 * `configDisabled` 用的工作区键。
 *
 * 与 workspaceKeyOf() **故意不同**：这里必须对路径声明保持 v6 的裸路径拼写
 * （`/root/x#row`），否则既有状态文件里的停用标记会静默失效；身份绑定是新增的
 * 命名空间 `ws:<id>`——裸路径永远以 `/` 或盘符开头，两者不会撞。
 * @param decl - 归一后的声明，或合并后的记录。
 * @returns `ws:<id>` 或本机路径（可能是空串，表示既无 id 也无路径）。
 */
export function disableKeyOf(decl) {
  const id = typeof decl?.workspaceId === 'string' ? decl.workspaceId.trim() : '';
  if (id !== '') return `ws:${id}`;
  return typeof decl?.path === 'string' ? decl.path : '';
}

/**
 * 停用标记的键：`<disableKeyOf(decl)>#<行 id>`。
 * @param workspaceKey - disableKeyOf() 的结果。
 * @param rowId - 行 id。
 */
export function rowKey(workspaceKey, rowId) {
  return `${workspaceKey}#${rowId}`;
}

/**
 * 合并两处声明成有效清单。
 *
 * 规则（也是设置页要如实展示的语义）：
 *   1. 组合声明在前、状态文件在后；同一工作区路径合并到一条记录里
 *      （source: config | file | both）。
 *   2. 同一工作区内 id 冲突时**保留组合那一条**，状态文件那一条标记
 *      conflict（不挂载、在设置页标红）—— 部署方的组合是权威。
 *   3. 组合行的停用标记只认 configDisabled（设置页可写），不改组合文件本身。
 * @param configDecls - 已归一的组合声明数组。
 * @param fileState - 已归一的状态文件内容。
 * @returns 有效清单：`[{ path, label, match, source, plugins: [...] }]`。
 */
/**
 * 合并两处声明（组合 config + 状态文件），按**稳定键**去重（见 workspaceKeyOf）。
 *
 * 合并语义（与旧版一致，只是键从路径换成了 workspaceKeyOf）：
 *   · 同键两处声明都出现的行 id：状态文件那份标 conflict + disabled（组合声明是
 *     部署方写死的，冲突时以它为准，但不静默丢掉另一份的意图——设置页会标红）。
 *   · 同键一处 subtree、一处 exact：subtree 胜出（覆盖面更大）。
 *   · 身份绑定优先：声明里给了 workspace id 时，即使另一处的 path 不同（两台设备
 *     路径不一样），也仍然合并成同一条。
 * @param configDecls - 组合行 config.workspaces 归一后的声明。
 * @param fileState - 状态文件归一后的状态。
 * @returns 有效清单（每个工作区一条记录）。
 */
export function mergeWorkspaces(configDecls, fileState) {
  const disabled = new Set(fileState.configDisabled ?? []);
  /** @type {Map<string, any>} */
  const byKey = new Map();
  const order = [];
  const push = (decl, source) => {
    const key = workspaceKeyOf(decl);
    let record = byKey.get(key);
    if (record === undefined) {
      record = {
        key,
        workspaceId: decl.workspaceId,
        path: decl.path,
        label: decl.label,
        match: decl.match,
        includeMembers: decl.includeMembers !== false,
        source,
        plugins: [],
        configRows: 0,
      };
      byKey.set(key, record);
      order.push(record);
    } else {
      record.source = record.source === source ? source : 'both';
      if (record.label === undefined) record.label = decl.label;
      if (record.path === undefined) record.path = decl.path;
      if (record.workspaceId === undefined) record.workspaceId = decl.workspaceId;
      // 同一工作区两处都声明时，更宽的匹配（subtree）胜出：它覆盖另一条的语义。
      if (decl.match === 'subtree') record.match = 'subtree';
      // 组合声明显式关掉附加路径匹配时尊重它（正式部署方能钉死匹配面）。
      if (source === 'config' && decl.includeMembers === false) record.includeMembers = false;
    }
    const ids = new Set(record.plugins.map((row) => row.id));
    for (const row of decl.plugins) {
      if (ids.has(row.id)) {
        record.plugins.push({ ...row, source, conflict: true, disabled: true });
        continue;
      }
      ids.add(row.id);
      const effective = { ...row, source };
      if (source === 'config') {
        record.configRows += 1;
        if (disabled.has(rowKey(disableKeyOf(decl), row.id))) effective.disabled = true;
      }
      record.plugins.push(effective);
    }
  };
  for (const decl of configDecls) push(decl, 'config');
  for (const decl of fileState.workspaces ?? []) push(decl, 'file');
  return order.map((record) => ({ ...record, plugins: record.plugins }));
}

/**
 * 会话 → 命中的有效工作区。
 *
 * 判定顺序（身份优先，其后沿用旧口径：精确命中 → 子树最长优先）：
 *   1. **身份命中**：本机注册表（workspaceRegistry）的账说这个会话属于该工作区
 *      ——`workspace.sessionIds` 含该会话 id。会话归属是注册表记的账，不靠 cwd 猜，
 *      所以最硬：软链、大小写、换过拼写的 cwd 都不影响。
 *   2. **精确命中**：cwd 等于某条匹配路径（主路径或本机附加路径）。
 *   3. **子树命中**：cwd 在某条 subtree 匹配路径之下，最长者胜。
 *
 * 匹配路径集合由 resolveWorkspaces() 算好（`matchPaths`）；没有它的记录退回单条
 * `path`，于是没有设备网格/注册表时行为与旧版完全一致。
 * @param workspaces - 有效清单（理想情况已过 resolveWorkspaces）。
 * @param cwd - 会话 header.cwd（任意拼写）。
 * @param sessionId - 会话 id（可选；给了才能做身份命中）。
 * @returns `{ workspace, mode, by, path, kind }` 或 undefined。
 */
export function matchWorkspace(workspaces, cwd, sessionId) {
  const key = canonicalPath(cwd);
  const wanted = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
  let identity;
  let exact;
  let subtree;
  for (const workspace of workspaces) {
    if (wanted !== null && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(wanted)) {
      if (identity === undefined) identity = workspace;
      continue;
    }
    if (key === null) continue;
    const paths = Array.isArray(workspace.matchPaths) && workspace.matchPaths.length > 0
      ? workspace.matchPaths
      : (typeof workspace.path === 'string' ? [{ path: workspace.path, kind: 'primary' }] : []);
    for (const entry of paths) {
      const path = typeof entry?.path === 'string' ? entry.path : null;
      if (path === null) continue;
      if (workspace.match === 'exact') {
        if (path === key && exact === undefined) exact = { workspace, mode: 'exact', path, kind: entry.kind ?? 'primary' };
        continue;
      }
      if (isInside(key, path) && (subtree === undefined || path.length > subtree.path.length)) {
        subtree = { workspace, mode: 'subtree', path, kind: entry.kind ?? 'primary' };
      }
    }
  }
  if (identity !== undefined) {
    return { workspace: identity, mode: 'exact', by: 'session', path: identity.path ?? null, kind: 'identity' };
  }
  if (exact !== undefined) return { ...exact, by: 'path' };
  if (subtree !== undefined) return { ...subtree, by: 'path' };
  return undefined;
}

// ── 网络工作区：把注册表与设备网格投影解析成「本机可匹配的路径集合」 ──────

/** 空注册表投影（服务缺席时用它，语义＝没有本机注册表）。 */
export function emptyRegistryIndex(error = null) {
  return { available: false, error, list: [], byId: new Map(), byPath: new Map(), sessionOf: new Map() };
}

/** 空设备网格投影（服务缺席时用它，语义＝没有网络工作区）。 */
export function emptyMeshIndex(error = null) {
  return {
    available: false,
    error,
    selfDeviceId: null,
    selfDeviceName: null,
    devices: [],
    groups: [],
    byWorkspaceId: new Map(),
    byPath: new Map(),
  };
}

/** 网格账目里一条附加路径的视图副本（字段与 deviceMesh.paths() 对齐，全部可缺省）。 */
function memberView(member) {
  return {
    id: member?.id ?? null,
    deviceId: member?.deviceId ?? null,
    deviceName: member?.deviceName ?? null,
    path: typeof member?.path === 'string' ? member.path : '',
    role: member?.role ?? null,
    label: member?.label ?? null,
    prefer: member?.prefer === true,
    local: member?.local === true,
  };
}

/**
 * 解析一条工作区记录：定身份、收本机匹配路径、归纳网络信息与诊断文案。
 * @param workspace - mergeWorkspaces 的记录。
 * @param reg - 注册表投影（见 emptyRegistryIndex）。
 * @param net - 网格投影（见 emptyMeshIndex）。
 * @returns 解析后的记录（原字段 + matchPaths/sessionIds/network/remoteOnly/hints）。
 */
function resolveWorkspaceRecord(workspace, reg, net) {
  const hints = [];
  const byId = reg?.byId instanceof Map ? reg.byId : new Map();
  const byPathIndex = reg?.byPath instanceof Map ? reg.byPath : new Map();
  const meshById = net?.byWorkspaceId instanceof Map ? net.byWorkspaceId : new Map();
  const meshByPath = net?.byPath instanceof Map ? net.byPath : new Map();
  const selfDeviceId = net?.selfDeviceId ?? null;
  const selfDeviceName = net?.selfDeviceName ?? null;

  const declaredId = workspace.workspaceId ?? null;
  let registryEntry = declaredId !== null ? byId.get(declaredId) ?? null : null;
  if (declaredId === null && typeof workspace.path === 'string') registryEntry = byPathIndex.get(workspace.path) ?? null;
  // 身份与路径对不上时（声明写错 id 或路径另有归属）要说出来，不能静默按错的那条走。
  if (declaredId !== null && registryEntry === null && typeof workspace.path === 'string') {
    const byPathEntry = byPathIndex.get(workspace.path) ?? null;
    if (byPathEntry !== null && byPathEntry.id !== declaredId) {
      hints.push(`本机注册表里 ${workspace.path} 属于别的工作区（${byPathEntry.title ?? byPathEntry.id}）：已按 workspace id 判定，path 只当线索`);
    }
  }
  const effectiveId = declaredId ?? registryEntry?.id ?? null;

  // 网格账目：先按身份找（同 id 可能有多组，本机为主的那组优先），再按路径找——
  // 只有 path 的旧声明也要能认出「这个路径属于哪个（可能跨设备的）工作区」。
  let group = null;
  if (effectiveId !== null) {
    const candidates = meshById.get(effectiveId) ?? [];
    group = candidates.find((item) => item?.homeDeviceId === selfDeviceId) ?? candidates[0] ?? null;
  }
  if (group === null && typeof workspace.path === 'string') {
    const byPathHit = meshByPath.get(workspace.path) ?? null;
    if (byPathHit !== null && byPathHit.group !== undefined) group = byPathHit.group;
  }
  const groupId = typeof group?.workspaceId === 'string' ? group.workspaceId : effectiveId;

  const matchPaths = [];
  const seen = new Set();
  const add = (path, kind, meta = {}) => {
    const canonical = canonicalPath(path);
    if (canonical === null || seen.has(canonical)) return null;
    seen.add(canonical);
    const entry = { path: canonical, kind, ...meta };
    matchPaths.push(entry);
    return entry;
  };

  const members = Array.isArray(group?.members) ? group.members : [];
  const localMembers = members.filter((member) => member?.local === true || (selfDeviceId !== null && member?.deviceId === selfDeviceId));
  const remoteMembers = members.filter((member) => localMembers.includes(member) === false);
  const primary = group?.primary ?? null;

  // 1) 主路径：注册表（身份绑定的权威来源）→ 声明里的 path → 账目里的本机主路径。
  if (registryEntry !== null && typeof registryEntry.path === 'string') {
    add(registryEntry.path, 'primary', { source: 'registry', local: true, deviceId: selfDeviceId, deviceName: selfDeviceName });
  } else if (typeof workspace.path === 'string') {
    add(workspace.path, 'primary', {
      source: 'declared',
      local: true,
      deviceId: selfDeviceId,
      deviceName: selfDeviceName,
      exists: existsSync(workspace.path),
    });
  } else if (primary !== null && primary.local === true && typeof primary.path === 'string') {
    add(primary.path, 'primary', { source: 'ledger', local: true, deviceId: selfDeviceId, deviceName: selfDeviceName });
    hints.push(`本机注册表里没有这个工作区，按设备网格账目里的本机主路径 ${primary.path} 匹配`);
  }

  // 2) 本机附加路径（mirror/scratch）：默认一起匹配（includeMembers: false 可关）。
  let memberCount = 0;
  if (workspace.includeMembers !== false) {
    for (const member of localMembers) {
      const added = add(member.path, 'member', {
        source: 'ledger',
        local: true,
        role: member.role ?? null,
        memberId: member.id ?? null,
        deviceId: member.deviceId ?? selfDeviceId,
        deviceName: member.deviceName ?? selfDeviceName,
        prefer: member.prefer === true,
        label: member.label ?? null,
      });
      if (added !== null) memberCount += 1;
    }
  }

  const homeDeviceId = group?.homeDeviceId ?? null;
  const homeDeviceName = primary?.deviceName ?? (homeDeviceId !== null && homeDeviceId === selfDeviceId ? selfDeviceName : homeDeviceId);
  const homeLocal = homeDeviceId === null ? true : homeDeviceId === selfDeviceId;
  const remoteNames = [];
  for (const member of remoteMembers) {
    const name = member?.deviceName ?? member?.deviceId ?? '?';
    if (!remoteNames.includes(name)) remoteNames.push(name);
  }
  if (homeLocal === false && typeof homeDeviceName === 'string' && !remoteNames.includes(homeDeviceName)) remoteNames.push(homeDeviceName);

  const network = {
    available: net?.available === true,
    homeDeviceId,
    homeDeviceName: typeof homeDeviceName === 'string' ? homeDeviceName : null,
    homeLocal,
    localMembers: localMembers.map(memberView),
    remoteMembers: remoteMembers.map(memberView),
    remoteDevices: remoteNames,
    hint: null,
  };

  // 3) 远端信息 → 可行动的诊断文案（设置页直接显示，不用它自己拼话）。
  const remoteOnly = matchPaths.length === 0;
  if (remoteMembers.length > 0) {
    const shown = remoteMembers.slice(0, 4).map((member) => `${member.deviceName ?? member.deviceId}：${member.path}（${member.role ?? '?'}${member.prefer === true ? '，优先' : ''}）`);
    const more = remoteMembers.length > 4 ? ` 等 ${String(remoteMembers.length)} 条` : '';
    hints.push(`该工作区在 ${remoteNames.join('、')} 上还有一份：${shown.join('；')}${more}。会话的 cwd 必须在本机，所以子插件是**按设备**挂的——那边要单独声明这一行；改用 workspace: ${groupId ?? '<id>'} 绑定后，同一份声明两台都能用`);
  }
  if (remoteOnly) {
    const where = remoteNames.length > 0 ? remoteNames.join('、') : (groupId ?? '另一台设备');
    hints.push(`本机没有这个工作区的任何路径（它只存在于 ${where}）：本机不会有会话命中它，这条声明在本机是空转的。请在 ${where} 上声明同一行，或给本机补一条附加路径（mesh_workspace_paths）`);
    network.hint = `该工作区在本机没有路径（属于 ${where}）：本机不会挂载它；请在 ${where} 上声明同一行`;
  } else if (remoteMembers.length > 0) {
    network.hint = `该工作区在 ${remoteNames.join('、')} 上另有一份：那边要单独声明同一行（推荐用 workspace: ${groupId ?? '<id>'} 绑定）`;
  }
  if (memberCount > 0) {
    hints.push(`本机附加路径 ${String(memberCount)} 条也参与匹配（mirror/scratch，来自设备网格账目；声明里写 includeMembers: false 可关掉）`);
  }

  return {
    ...workspace,
    key: workspace.key ?? workspaceKeyOf(workspace),
    workspaceId: groupId ?? effectiveId,
    registryTitle: registryEntry?.title ?? null,
    registryPath: registryEntry?.path ?? null,
    matchPaths,
    sessionIds: Array.isArray(registryEntry?.sessionIds) ? [...registryEntry.sessionIds] : null,
    network,
    remoteOnly,
    hints,
  };
}

/**
 * 把有效清单解析成「本机可匹配的路径集合 + 网络信息」。
 *
 * 纯函数：registry / mesh 是调用方（index.js）取好的 JSON 投影；服务缺席时传
 * emptyRegistryIndex()/emptyMeshIndex() 即可——那时除了声明里的 path，什么也不加，
 * 行为与没有设备网格、没有注册表的旧版本完全一致。
 * @param list - mergeWorkspaces 的输出。
 * @param registry - 注册表投影。
 * @param mesh - 设备网格投影。
 * @returns 解析后的工作区记录数组。
 */
export function resolveWorkspaces(list, registry, mesh) {
  const reg = registry ?? emptyRegistryIndex();
  const net = mesh ?? emptyMeshIndex();
  return list.map((workspace) => resolveWorkspaceRecord(workspace, reg, net));
}

export function workspaceSignature(workspace) {
  return JSON.stringify({
    path: workspace.path,
    match: workspace.match,
    plugins: (workspace.plugins ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      disabled: row.disabled === true,
      config: row.config ?? null,
      isolate: row.isolate ?? null,
      source: row.source,
      conflict: row.conflict === true,
    })),
  });
}

/** 状态文件里可挂载的行（有效清单 → 真正要装的模块标识集合）。 */
export function rowSpecifiers(workspaces) {
  const set = new Set();
  for (const workspace of workspaces) {
    for (const row of workspace.plugins) {
      if (row.disabled === true || row.conflict === true) continue;
      set.add(row.name);
    }
  }
  return [...set];
}

// ── 落盘 ──────────────────────────────────────────────────────────────────

/**
 * 原子写状态文件（临时文件 + rename，同一目录内保证原子性）。
 * @param path - 目标路径。
 * @param state - 已归一的状态对象（直接序列化）。
 * @returns 写入字节数。
 */
export function writeStateFile(path, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error;
  }
  return Buffer.byteLength(text, 'utf8');
}

/**
 * 读状态文件。文件不存在＝空状态（不是错误）；解析/校验失败时返回空状态 +
 * errors，调用方负责展示。
 * @param path - 状态文件路径。
 * @returns `{ state, errors, warnings, exists, bytes }`。
 */
export function readStateFile(path) {
  if (!existsSync(path)) {
    // 文件不存在是**正常**状态（还没保存过），不是错误：ok=true + 空清单。
    return { state: blankState(), errors: [], warnings: [], exists: false, bytes: 0, ok: true };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { state: blankState(), errors: [`读取状态文件失败：${message(error)}`], warnings: [], exists: true, bytes: 0, ok: false };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { state: blankState(), errors: [`状态文件不是合法 JSON：${message(error)}`], warnings: [], exists: true, bytes: Buffer.byteLength(text, 'utf8'), ok: false };
  }
  const normalized = normalizeState(raw);
  // ok=false（读坏/内容不合法）时调用方应沿用上一份可用清单：一份坏文件不该让
  // 本文件声明的所有工作区凭空消失、把活会话上的子插件卸掉。
  return { ...normalized, exists: true, bytes: Buffer.byteLength(text, 'utf8'), ok: normalized.errors.length === 0 };
}

/**
 * 把一个值变成「一定能 JSON.stringify」的形态。
 *
 * 为什么需要：清单里的 config 来自组合行（YAML 里的 `!!js` 会被求值成活对象）或状态
 * 文件。活对象/循环引用会让 /state 的响应序列化失败——而序列化发生在响应头之后，
 * 会直接踩到「二次写响应 → 未处理 rejection → DSH fail-loud 退出进程」那条线。
 * 这里用 JSON.stringify 本身当探针：能过就原样返回，过不了就换成占位文案并标记，
 * 让上层能提示用户而不是把整个页面打崩。
 * @param value - 待检查的值。
 * @returns `{ ok, value }`：ok=false 时 value 是可序列化的占位文本。
 */
export function jsonSafe(value) {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    JSON.stringify(value);
    return { ok: true, value };
  } catch {
    return { ok: false, value: '[config 含无法序列化的值（活对象/循环引用/函数），本页不能编辑或保存它]' };
  }
}

/** 错误/任意值 → 单行文本。 */
export function message(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
