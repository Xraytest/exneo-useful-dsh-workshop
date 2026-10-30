/**
 * dsh-workbench —— 输入框工具行「工作箱」（host 半边，v1）。
 *
 * 用户指令（2026-10-22）：
 *   「将现在 UltraCode 位置改成一个工作箱图标点击后展开工作列表：列表内包含
 *    UltraCode 和 REA，复选选中后才将相关上下文注入窗口。对于 REA 不选中
 *    意味着不会有任何 REA 的上下文。」
 *
 * 定位：**编排者，不实现**。Ultracode 的注入逻辑（家族状态机、装配期直注、
 * 工具段改写）在 dsh-ultracode，REA 的工具面在 rea-mcp + rea-mcp-server，本插件
 * 一行都不复制：
 *   · Ultracode 复选 → POST /dsh-ultracode/set {sessionId, active}（同一语义：
 *     会话/家族级开关，落盘、装配期直注）；读 → /dsh-ultracode/status。
 *   · REA 复选 → POST /dsh-rea-mcp/workbench {on}（见下）；
 *   · mcp:rea 提示段 → 本插件在装配 waterfall 末尾**摘除**（见下）。
 *
 * ⚠ REA「零上下文」的两件事，缺一不可（都不在本插件外实现）：
 *   ① 工具 schema：rea-mcp 已经用 agent.ctx.tools.restrict() 把未选工具从每个
 *      Agent 的工具面摘掉（勾选状态由本插件写入其 state 文件）；
 *   ② 服务端 instructions 段（`mcp:rea`，约 1 KB 文字）：dsh-mcp-client 把它注册
 *      成全局 systemPrompt section，**没有开关**。本插件在 system-prompt/assemble
 *      waterfall 里把 `mcp:rea` 段**从装配结果里删掉**（等价于把它置空——
 *      renderPrompt 本来就丢弃空段，但直接删除更干净）。这只在「REA 未选中」时
 *      发生；选中时不碰任何段。
 *
 * 与 REA 复选的联动：rea-mcp 的 state.masterEnabled 与本插件的 workbench 选择
 * **是同一份**（都存 $DSH_HOME/rea-mcp/tools.json 的 masterEnabled）。本插件给它
 * 加一条直连路由 /dsh-rea-mcp/workbench：只翻转 masterEnabled，其余（mode、
 * enabled 白名单）原样保留——用户在设置页精挑的工具集不被工作箱破坏。
 *
 * 状态：每个会话（按 ultracode 同款**家族谱系**）一份「箱内勾选」。落盘
 * $DSH_HOME/workbench.json，形状与多进程纪律与 ultracode.json 一致（写前重读、
 * 合并盘上条目、tmp+rename 原子换名、删除不复活）。
 *
 * 交接方式：改 host 实现要换新文件名（entry-v<N>.js 的 ?v= 也要 +1），保持
 * patch 里 row id 不变（workbench），loader 才走 dispose→start。
 *
 * @module dsh-workbench
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const name = 'workbench';
export const inject = ['webServer'];

const ROUTE = '/dsh-workbench';
const ULTRA_ROUTE = '/dsh-ultracode';
const REA_ROUTE = '/dsh-rea-mcp';
const REA_SECTION = 'mcp:rea';
const STATE_VERSION = 2;

/** 箱内条目注册表：id → 驱动。新增条目只改这张表 + client 列表。 */
const ENTRIES = [
  {
    id: 'ultracode',
    label: 'Ultracode',
    description: '穷尽式多代理编排（Claude Code ultracode 静态还原）：开启即在系统提示注入 Ultracode 段并改写 Workflow 工具段。',
  },
  {
    id: 'rea',
    label: 'REA',
    description: '逆向工程工具集（207 个 MCP 工具）。未选中时工具与说明文字都不进入上下文。',
  },
];

/**
 * 箱内动作条目注册表（v2）：一次性触发，不落盘勾选。
 * `route`：动作属主插件的同源 POST 路由；`payload(sessionId)` 组装请求体。
 * 第一个条目是 dsh-dual-agent 的双主智能（2026-10-28 用户指令「启动按钮放
 * 到工具箱内」）。属主插件缺席时按钮报它的错误——不在这里伪造能力。
 * v2.1（2026-10-29）：status 探测回包的 note（阶段说明）原样透传给 client。
 */
const ACTIONS = [
  {
    id: 'dual-agent',
    label: '双主智能',
    description: '执行者=后台 subagent；挑刺者=主上下文评估人格。开启后键入初始指令；完成后回到待命等补充；只有智能体主动停止才触发评估。',
    // 控件形态由属主语义决定：双主智能是「启用/关闭」的开关，不是一次触发按钮。
    kind: 'switch',
    route: '/dsh-dual-agent/action',
    payload: (sessionId, enabled) => (typeof enabled === 'boolean' ? { sessionId, enabled } : { sessionId }),
    /** 开关的读法：勾上=启用。armingLabel/runningLabel 只用于徽标与 aria 文案。 */
    runningLabel: '运行中',
    idleLabel: '待命中',
  },
  // v3（2026-10-29 用户指令「启动通道的 UI 也放在工具箱内」）：管理员权限通道。
  // 拨开 = 由属主插件弹一次 UAC 并拉起常驻提权进程；开关状态、阶段说明与悬停提示
  // 全部来自属主 /dsh-admin-channel/status（本插件只画开关，不复制任何提权逻辑）。
  {
    id: 'admin-channel',
    label: '管理员权限通道',
    description: '一会话一条：拨开时弹一次 UAC，之后本会话的提权命令不再逐次确认；随会话结束 / 空闲超时关闭。',
    kind: 'switch',
    route: '/dsh-admin-channel/action',
    payload: (sessionId, enabled) => (typeof enabled === 'boolean' ? { sessionId, enabled } : { sessionId }),
    runningLabel: '已开启',
    idleLabel: '未开启',
  },
];
const ENTRY_IDS = new Set(ENTRIES.map((entry) => entry.id));

// ── 落盘（与 ultracode.json 同款纪律） ─────────────────────────────────────

function defaultStateFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'workbench.json');
}

function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function errorText(error) {
  return String(error instanceof Error ? error.message : error);
}

/**
 * 家族键：与 dsh-ultracode 的 rootOf 同一套语义（家谱表 → 父指针 → 消息分支账本
 * → 自成一家），但**不落盘家谱**——ultracode.json 的 families 表已经记了这份关系，
 * 本插件**只读**它（一份事实只写一次；读不到就退化为「每会话一份选择」）。这让
 * 「分支上勾选 = 全家族一起勾选」与 ultracode 的家族行为对齐。
 */
function familyRootOf(store, sessionId, sessions) {
  const seen = new Set();
  let current = sessionId;
  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(current)) return sessionId;
    seen.add(current);
    const mapped = store.families[current];
    if (typeof mapped === 'string' && mapped !== '') return mapped;
    let parent;
    try {
      const live = sessions?.get?.(current);
      parent = live?.header?.parentSession;
    } catch { parent = undefined; }
    if (typeof parent !== 'string' || parent === '' || parent === current) return current;
    current = parent;
  }
  return sessionId;
}

function createStore(file, onError) {
  let doc = { version: STATE_VERSION, sessions: {} };
  let error = null;
  const read = () => {
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const sessions = parsed.sessions !== undefined && parsed.sessions !== null && typeof parsed.sessions === 'object'
        ? Object.fromEntries(Object.entries(parsed.sessions).filter(([key, value]) =>
          typeof key === 'string' && key !== '' && value !== null && typeof value === 'object' && Array.isArray((value).checked)))
        : {};
      doc = { version: STATE_VERSION, sessions };
    } catch (cause) {
      error = `读取失败（${errorText(cause)}），内存态照常，重写可自愈`;
      onError?.(cause);
    }
  };
  read();
  const write = () => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const payload = { ...doc, families: ultracodeFamiliesOf(file) };
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      error = null;
    } catch (cause) {
      try { if (existsSync(tmp)) renameSync(tmp, `${tmp}.dead`); } catch { /* 尽力 */ }
      error = `写入失败（${errorText(cause)}），选择只在内存，重启会丢`;
      onError?.(cause);
    }
  };
  return {
    file,
    get error() { return error; },
    families: {},
    checkedOf(sessionId) { return doc.sessions[sessionId] ?? { checked: [] }; },
    set(sessionId, checked) {
      // 写前重读：合并别的进程写的条目（同 ultracode 的共识规则）。
      read();
      doc.sessions[sessionId] = { checked: [...checked].sort(), updatedAt: Date.now() };
      write();
    },
    clear(sessionId) {
      read();
      delete doc.sessions[sessionId];
      write();
    },
  };
}

/** 只读 ultracode.json 的 families 表（家谱事实的唯一写者是 dsh-ultracode）。 */
function ultracodeFamiliesOf(workbenchFile) {
  try {
    const ultracodeFile = join(dirname(workbenchFile), 'ultracode.json');
    if (!existsSync(ultracodeFile)) return {};
    const parsed = JSON.parse(readFileSync(ultracodeFile, 'utf8'));
    const families = parsed?.families;
    if (families === null || typeof families !== 'object' || Array.isArray(families)) return {};
    return Object.fromEntries(Object.entries(families).filter(([key, value]) =>
      typeof key === 'string' && typeof value === 'string'));
  } catch {
    return {};
  }
}

// ── HTTP 小件（同源守卫，与部署其它插件同口径） ─────────────────────────────

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

const jsonOf = (res) => (status, value) => {
  if (res.headersSent === true) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

function readBody(req, limit) {
  return new Promise((settle) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; settle(value); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, error: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', (cause) => finish({ ok: false, error: errorText(cause) }));
  });
}

/**
/**
 * 转发本进程内打到 ultracode / rea 的路由（复用它们的语义与守卫）。同进程回环：
 * 从 webServer 服务读真实监听端口（0 = OS 分配时也能拿到），再 fetch 自己。
 * 非 2xx 时抛带 {status, error} 的错误（/action 据此透传属主的 409 等语义码）。
 */
async function postJson(ctx, path, body) {
  const port = listenPortOf(ctx);
  if (port === null) throw new Error('webServer 尚未开始监听');
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!response.ok) {
    const cause = new Error(value?.error ?? `${response.status} ${response.statusText}`);
    cause.status = response.status;
    throw cause;
  }
  return value;
}

/** 从 webServer 服务取监听端口（服务缺席/未监听 → null，调用方自行报错）。 */
function listenPortOf(ctx) {
  try {
    const server = ctx?.get?.('webServer');
    const port = server?.port;
    return typeof port === 'number' && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const configuredFile = typeof config.stateFile === 'string' ? config.stateFile.trim() : '';
  const stateFile = configuredFile === '' ? defaultStateFile() : resolve(expandHome(configuredFile));
  const store = createStore(stateFile, (cause) => {
    ctx.logger?.warn?.('dsh-workbench: 选择落盘读写失败', cause);
  });

  /** REA 是否勾选：以 rea-mcp 的 masterEnabled 为准（单一事实源）。 */
  const reaMasterEnabled = () => {
    try {
      const reaFile = reaStateFileOf();
      if (!existsSync(reaFile)) return true; // 无文件 = rea-mcp 默认全选
      const parsed = JSON.parse(readFileSync(reaFile, 'utf8'));
      return parsed?.masterEnabled !== false;
    } catch {
      return true; // 读不到按「选中」处理：宁可多注不误杀
    }
  };

  const reaStateFileOf = () => {
    const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
    return join(home, 'rea-mcp', 'tools.json');
  };

  const sessions = () => {
    try { return ctx.get('sessions'); } catch { return undefined; }
  };

  /** 本会话的勾选集合（含家族展开 + REA 实况）。 */
  const effectiveChecked = (sessionId) => {
    const rootId = familyRootOf(store, sessionId, sessions());
    const record = store.checkedOf(rootId);
    const checked = new Set(record.checked.filter((id) => ENTRY_IDS.has(id)));
    // REA 以 rea-mcp 的真实开关为准（设置页可能直接改过它）。
    if (checked.has('rea') && reaMasterEnabled() !== true) checked.delete('rea');
    if (!checked.has('rea') && reaMasterEnabled() === true) {
      // rea-mcp 开着但本箱没勾：仍然算未勾选——工作箱是入口，以箱为准。
    }
    return checked;
  };

  /** 装配期：REA 未勾选 → 摘掉 mcp:rea 提示段（instructions 唯一入口）。 */
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next();
    const agent = context === undefined ? undefined : context.agent;
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== 'string' || sessionId === '') return result;
    if (effectiveChecked(sessionId).has('rea')) return result;
    const sections = result.sections.filter((section) => section?.name !== REA_SECTION);
    if (sections.length === result.sections.length) return result;
    return { ...result, sections };
  }, { prepend: true });

  // ── 路由 ──────────────────────────────────────────────────────────────────

  const register = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      const json = jsonOf(res);
      Promise.resolve(handler(req, res, json)).catch((cause) =>
        json(500, { error: `workbench 路由内部错误：${errorText(cause)}` }));
    },
  }), `dsh-workbench: ${path}`);

  const statusOf = async (sessionId) => {
    const rootId = typeof sessionId === 'string' && sessionId !== '' ? familyRootOf(store, sessionId, sessions()) : undefined;
    const record = rootId === undefined ? { checked: [] } : store.checkedOf(rootId);
    const checked = effectiveChecked(sessionId);
    const ultracodeStatus = (async () => {
      try {
        const port = listenPortOf(ctx);
        if (port === null || typeof sessionId !== 'string' || sessionId === '') return null;
        const response = await fetch(`http://127.0.0.1:${port}${ULTRA_ROUTE}/status?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    })();
    // 动作条目的实况（v2）：逐个问属主插件的 status 路由。
    // 路由形态约定：GET <前缀>/status?sessionId=… → { running?: boolean, phase?, armed?, note?, … }。
    // running 是兼容布尔（老属主可能只回它）；phase 是三态真值（off/armed/running）。
    const actionStates = await Promise.all(ACTIONS.map(async (action) => {
      try {
        const port = listenPortOf(ctx);
        if (port === null || typeof sessionId !== 'string' || sessionId === '') return { id: action.id, running: null, available: false };
        const response = await fetch(`http://127.0.0.1:${port}${action.route.replace(/\/[^/]*$/, '')}/status?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } });
        if (!response.ok) return { id: action.id, running: null, available: false };
        const value = await response.json();
        return {
          id: action.id,
          running: value?.running === true,
          phase: typeof value?.phase === 'string' ? value.phase : undefined,
          armed: value?.armed === true,
          available: true,
          note: typeof value?.note === 'string' && value.note !== '' ? value.note : undefined,
          // v3.2：属主可透出孵化时刻（双主智能 running 中=epoch ms）；客户端据此
          // 每秒刷新「已工作 X 分 Y 秒」，不必等 8s 轮询一跳一跳。
          hatchAt: typeof value?.hatchAt === 'number' ? value.hatchAt : undefined,
          // v3.3：执行者活性（双主智能 running 中）。主对话静默时用户唯一的安全感
          // 来源：childLive=false=执行者会话已不在本进程；childStatus='idle'=本轮
          // 已停、等待编排结算。note 里也已带人话后缀，这里透出供客户端细粒度用。
          childLive: typeof value?.childLive === 'boolean' ? value.childLive : undefined,
          childStatus: typeof value?.childStatus === 'string' ? value.childStatus : undefined,
          // v3：属主可以给随阶段变化的悬停提示（如「等待 UAC 授权」/「关闭会结束提权进程」）。
          hint: typeof value?.hint === 'string' && value.hint !== '' ? value.hint : undefined,
          storeError: typeof value?.storeError === 'string' && value.storeError !== '' ? value.storeError : undefined,
        };
      } catch { return { id: action.id, running: null, available: false }; }
    }));
    return {
      sessionId,
      family: rootId ?? null,
      checked: [...checked],
      recorded: record.checked,
      entries: ENTRIES.map((entry) => ({
        ...entry,
        checked: checked.has(entry.id),
      })),
      actions: ACTIONS.map((action) => {
        const state = actionStates.find((candidate) => candidate.id === action.id);
        return {
          id: action.id,
          label: action.label,
          description: action.description,
          kind: action.kind ?? 'button',
          runningLabel: action.runningLabel,
          idleLabel: action.idleLabel,
          running: state?.running ?? null,
          // 开关的勾选态 =「已启用」（armed 或 running 都算开）。
          checked: state?.running === true || state?.armed === true,
          phase: state?.phase,
          armed: state?.armed === true,
          available: state?.available === true,
          note: state?.note,
          hatchAt: state?.hatchAt,
          childLive: state?.childLive,
          childStatus: state?.childStatus,
          hint: state?.hint,
          // 属主的落盘错误也透出（与工作箱自己的 storeError 同一可见性口径）。
          storeError: state?.storeError,
        };
      }),
      rea: {
        masterEnabled: reaMasterEnabled(),
        connected: true,
      },
      ultracode: await ultracodeStatus,
      stateFile: store.file,
      storeError: store.error,
    };
  };

  register(`${ROUTE}/status`, async (req, res, json) => {
    if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' });
    let sessionId;
    try {
      sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? undefined;
    } catch { sessionId = undefined; }
    return json(200, await statusOf(sessionId));
  });

  register(`${ROUTE}/set`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let parsed;
    try { parsed = JSON.parse(body.text === '' ? '{}' : body.text); } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
    if (sessionId === '') return json(400, { error: 'sessionId 必填' });
    if (!Array.isArray(parsed.checked)) return json(400, { error: 'checked 必须是数组' });
    const checked = [...new Set(parsed.checked.filter((id) => typeof id === 'string' && ENTRY_IDS.has(id)))];
    const issues = [];
    // ① 落自己那份（家族键）。
    const rootId = familyRootOf(store, sessionId, sessions());
    store.set(rootId, checked);
    // ② 驱动 ultracode：勾/不勾都直接写它的开关（它的落盘与家族语义由它自己保证）。
    const wantUltra = checked.includes('ultracode');
    let ultracodeResult = null;
    try {
      ultracodeResult = await postJson(ctx, `${ULTRA_ROUTE}/set`, { sessionId, active: wantUltra });
    } catch (cause) {
      issues.push(`Ultracode 开关写入失败：${errorText(cause)}`);
    }
    // ③ 驱动 REA：只翻转 masterEnabled，保留用户的工具白名单。
    const wantRea = checked.includes('rea');
    let reaResult = null;
    try {
      reaResult = await postJson(ctx, `${REA_ROUTE}/workbench`, { on: wantRea });
    } catch (cause) {
      issues.push(`REA 开关写入失败：${errorText(cause)}`);
    }
    const status = await statusOf(sessionId);
    status.issues = issues;
    return json(200, status);
  });

  register(`${ROUTE}/reset`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let sessionId;
    try { sessionId = JSON.parse(body.text === '' ? '{}' : body.text).sessionId; } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    if (typeof sessionId !== 'string' || sessionId === '') return json(400, { error: 'sessionId 必填' });
    const rootId = familyRootOf(store, sessionId, sessions());
    store.clear(rootId);
    let ultracodeResult = null;
    try { ultracodeResult = await postJson(ctx, `${ULTRA_ROUTE}/reset`, { sessionId }); } catch { /* reset 语义：清掉即可 */ }
    return json(200, await statusOf(sessionId));
  });

  // ── 动作转发（v2）：把工作箱动作按钮的一次点击转给属主插件 ─────────────────
  // 工作箱自己不实现动作语义，只做：同源守卫 → 校验动作 id → 原样转发 → 回传
  // 属主插件的回包（含它的错误——比如「会话不在线」就是 dual-agent 的真实答复）。
  register(`${ROUTE}/action`, async (req, res, json) => {
    if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
    if (!sameOrigin(req)) return json(403, { error: 'cross-origin request rejected' });
    const body = await readBody(req, 1 << 20);
    if (!body.ok) return json(400, { error: body.error });
    let parsed;
    try { parsed = JSON.parse(body.text === '' ? '{}' : body.text); } catch { return json(400, { error: 'body 不是合法 JSON' }); }
    const actionId = typeof parsed?.actionId === 'string' ? parsed.actionId : '';
    const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
    if (sessionId === '') return json(400, { error: 'sessionId 必填' });
    const action = ACTIONS.find((candidate) => candidate.id === actionId);
    if (action === undefined) return json(404, { error: `未知动作条目：${actionId === '' ? '(空)' : actionId}` });
    // 开关式动作：客户端把**目标状态**（enabled）上送，属主按目标推进，
    // 不再由属主猜「下一次点击该进哪一态」。旧式无 enabled 的请求仍兼容。
    const enabled = typeof parsed?.enabled === 'boolean' ? parsed.enabled : undefined;
    try {
      const result = await postJson(ctx, action.route, action.payload(sessionId, enabled));
      return json(200, result);
    } catch (cause) {
      // 属主插件有话直说（如 dual-agent 的 409「会话不在线」）：透传它的
      // 状态码与错误；只有网络层失败（属主进程内路由打不通）才报 502。
      if (typeof cause?.status === 'number' && cause.status >= 400 && cause.status < 600) {
        return json(cause.status, { error: cause.message });
      }
      return json(502, { error: `动作属主未响应：${errorText(cause)}` });
    }
  });

  ctx.logger?.info?.(`dsh-workbench: 就绪（state=${stateFile}）`);
}
