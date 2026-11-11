/**
 * DSH Host 服务适配层。
 *
 * 这一层是**唯一**接触 DSH 服务的地方，集中处理三件事：
 *   1. 服务缺失时失败关闭（`ctx.get` 抛错或返回 undefined → 明确错误，不静默降级）；
 *   2. 把 DSH 的 `Session` / `SessionHeader` / `SessionEvent` 映射成桥接用的纯 JSON；
 *   3. 发送 / 中断 / 创建会话时的身份解析（`sendMessage` 要求「确切的在线 Agent」）。
 *
 * 用到的 Host 契约：
 *   · `ctx.get('sessions')`  → list / get / create，以及
 *     `Session.snapshotEvents(from, toExclusive)` / `deriveMessages()` / `eventAt(seq)`
 *   · `ctx.get('agents')`    → list / get / roots
 *   · `ctx.get('subagents')` → sendMessage(sender, targetId, content, { signal }) /
 *     interrupt(targetSessionId, authority)
 *   · `ctx.get('sessionTitle')` → get / rename
 *
 * `sessions.create()` 的签名是从本机安装的 Host 包里核实出来的
 * （`SessionStore.create(id, { seed, meta, inheritedEventCount, eventState })`，
 * `meta` 接受 `cwd` / `parentSession` / `origin` / `delegationDepth` / `agentPreset`）。
 * 它做了特性探测：缺失时返回 501，不臆造替代路径。
 *
 * @module prts-omni-bridge/lib/sessions
 */

/** 单个事件的字节上限，防止一条巨型事件把响应体撑爆。 */
const MAX_EVENT_JSON_BYTES = 256 * 1024;

/** 单页事件数上限。 */
const MAX_EVENT_PAGE = 500;

/** 单次拉取的消息条数上限。 */
const MAX_MESSAGES = 500;

/**
 * 安全取服务：拿不到就抛错（失败关闭）。
 *
 * 错误带 `status = 503`：服务缺失是「Host 暂时没这个能力」，不是插件的内部bug。
 * 没有 status 时 lib/http.js 会按 500 处理，监控上会把「依赖没就绪」误报成崩溃。
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function service(ctx, name) {
  const value = typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  if (value === undefined || value === null) {
    const error = /** @type {any} */ (new Error(`Host 服务 "${name}" 不可用`));
    error.status = 503;
    throw error;
  }
  return value;
}

/**
 * @param {any} ctx
 * @returns {any}
 */
export function sessionsService(ctx) {
  return service(ctx, 'sessions');
}

/**
 * @param {any} ctx
 * @returns {any}
 */
export function agentsService(ctx) {
  return service(ctx, 'agents');
}

/**
 * @param {any} ctx
 * @returns {any}
 */
export function subagentsService(ctx) {
  return service(ctx, 'subagents');
}

/**
 * sessionTitle 是可选服务：缺失时标题留空，不影响其他能力。
 * @param {any} ctx
 * @returns {any | undefined}
 */
export function sessionTitleService(ctx) {
  try {
    const value = ctx?.get?.('sessionTitle');
    return value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * 取一个会话的标题快照（容错）。
 * @param {any} titleService
 * @param {any} session
 * @returns {string}
 */
function titleOf(titleService, session) {
  if (titleService === undefined || typeof titleService.get !== 'function') return '';
  try {
    const snapshot = titleService.get(session);
    const title = snapshot?.title ?? snapshot?.value ?? snapshot;
    return typeof title === 'string' ? title : '';
  } catch {
    return '';
  }
}

/**
 * 把一个 Session 映射成桥接用的纯 JSON 摘要。
 * @param {any} session
 * @param {any} [titleService]
 * @returns {Record<string, unknown>}
 */
export function describeSession(session, titleService) {
  const header = session?.header ?? {};
  return {
    id: String(session?.id ?? header.id ?? ''),
    title: titleOf(titleService, session),
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : undefined,
    origin: typeof header.origin === 'string' ? header.origin : undefined,
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined,
    seq: typeof session?.seq === 'number' ? session.seq : undefined,
    inheritedEventCount: typeof session?.inheritedEventCount === 'number' ? session.inheritedEventCount : undefined,
    formatVersion: typeof header.version === 'number' ? header.version : undefined,
  };
}

/**
 * 列出会话（受 `maxSessions` 限制，按 id 稳定排序）。
 * @param {any} ctx
 * @param {{ limit?: number }} [options]
 * @returns {{ sessions: Array<Record<string, unknown>>, total: number, truncated: boolean }}
 */
export function listSessions(ctx, options = {}) {
  const sessions = sessionsService(ctx);
  if (typeof sessions.list !== 'function') throw new Error('sessions 服务没有 list()');
  const all = [...sessions.list()];
  const total = all.length;
  const requested = Number(options.limit);
  // 只有「有限且为正」的 limit 才生效；否则不限制（?limit= 为空 / abc 时不至于变成 1 条）
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : total;
  const titleService = sessionTitleService(ctx);
  const sorted = all.sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
  return {
    sessions: sorted.slice(0, limit).map((session) => describeSession(session, titleService)),
    total,
    truncated: total > limit,
  };
}

/**
 * 取单个会话；不存在返回 undefined。
 * @param {any} ctx
 * @param {string} id
 * @returns {any | undefined}
 */
export function getSession(ctx, id) {
  const sessions = sessionsService(ctx);
  if (typeof sessions.get !== 'function') throw new Error('sessions 服务没有 get()');
  return sessions.get(id);
}

/**
 * 分页读会话事件。`since` 是**包含**的起始 seq。
 * @param {any} ctx
 * @param {string} id
 * @param {{ since?: number, limit?: number }} [options]
 * @returns {{ sessionId: string, fromSeq: number, toSeqExclusive: number, nextSeq: number, events: unknown[] }}
 */
export function readEvents(ctx, id, options = {}) {
  const session = getSession(ctx, id);
  if (session === undefined) {
    const error = /** @type {any} */ (new Error(`会话 "${id}" 不存在`));
    error.status = 404;
    throw error;
  }
  if (typeof session.snapshotEvents !== 'function') {
    throw new Error('Session 没有 snapshotEvents()（Host 版本不受支持）');
  }
  const total = typeof session.seq === 'number' ? session.seq : 0;
  const since = Number.isFinite(options.since) && Number(options.since) >= 0 ? Math.floor(Number(options.since)) : 0;
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0
    ? Math.min(MAX_EVENT_PAGE, Math.floor(Number(options.limit)))
    : MAX_EVENT_PAGE;
  const toSeqExclusive = Math.min(total, since + limit);
  const events = since >= total ? [] : [...session.snapshotEvents(since, toSeqExclusive)];
  return {
    sessionId: id,
    fromSeq: since,
    toSeqExclusive,
    nextSeq: toSeqExclusive,
    total,
    events: events.map((event) => safeEvent(event)),
  };
}

/**
 * 事件序列化：超长的事件只保留信封与截断标记，绝不静默丢内容却不说明。
 * @param {any} event
 * @returns {unknown}
 */
function safeEvent(event) {
  let text;
  try {
    text = JSON.stringify(event);
  } catch {
    return { type: String(event?.type ?? ''), seq: Number(event?.seq ?? -1), time: Number(event?.time ?? 0), truncated: true };
  }
  if (text.length <= MAX_EVENT_JSON_BYTES) return event;
  return {
    type: String(event?.type ?? ''),
    seq: Number(event?.seq ?? -1),
    time: Number(event?.time ?? 0),
    truncated: true,
    originalBytes: text.length,
  };
}

/**
 * 读取派生消息历史（LLM 可见的那一层）。
 * @param {any} ctx
 * @param {string} id
 * @param {{ limit?: number }} [options]
 * @returns {{ sessionId: string, messages: unknown[], total: number }}
 */
export function readMessages(ctx, id, options = {}) {
  const session = getSession(ctx, id);
  if (session === undefined) {
    const error = /** @type {any} */ (new Error(`会话 "${id}" 不存在`));
    error.status = 404;
    throw error;
  }
  if (typeof session.deriveMessages !== 'function') {
    throw new Error('Session 没有 deriveMessages()（Host 版本不受支持）');
  }
  const all = [...session.deriveMessages()];
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0
    ? Math.min(MAX_MESSAGES, Math.floor(Number(options.limit)))
    : MAX_MESSAGES;
  const messages = all.slice(Math.max(0, all.length - limit)).map((message) => safeEvent(message));
  return { sessionId: id, messages, total: all.length };
}

/**
 * 解析「发送者」Agent。
 *
 * DSH 的 `subagents.sendMessage(sender, …)` 要求 sender 是**确切的在线 Agent**
 * （`ctx.agents.get(sender.id) === sender`），且目标必须是它的直接子会话
 * （或它自己的直接父会话）。所以：
 *   1. 目标会话有 `parentSession` 且该父会话的 Agent 在线 → 用父 Agent；
 *   2. 否则退回第一个 root Agent；
 *   3. 再否则退回任意在线 Agent。
 *
 * 这个顺序是确定性的，错误会原样透传给调用方，不吞。
 *
 * @param {any} ctx
 * @param {string} targetSessionId
 * @returns {any} Agent
 */
export function resolveSenderAgent(ctx, targetSessionId) {
  const agents = agentsService(ctx);
  const list = typeof agents.list === 'function' ? [...agents.list()] : [];
  if (list.length === 0) {
    const error = /** @type {any} */ (new Error('本 Host 进程没有在线 Agent，无法授权发送'));
    error.status = 503;
    throw error;
  }
  const target = getSession(ctx, targetSessionId);
  const parentId = target?.header?.parentSession;
  if (typeof parentId === 'string' && parentId !== '' && typeof agents.get === 'function') {
    const parent = agents.get(parentId);
    if (parent !== undefined && parent !== null) return parent;
  }
  const roots = typeof agents.roots === 'function' ? [...agents.roots()] : [];
  if (roots.length > 0) return roots[0];
  return list[0];
}

/**
 * 给目标会话发一条用户消息。
 * @param {any} ctx
 * @param {string} targetSessionId
 * @param {string} text
 * @returns {Promise<Record<string, unknown>>}
 */
export async function sendMessage(ctx, targetSessionId, text) {
  const target = getSession(ctx, targetSessionId);
  if (target === undefined) {
    const error = /** @type {any} */ (new Error(`会话 "${targetSessionId}" 不存在`));
    error.status = 404;
    throw error;
  }
  const sender = resolveSenderAgent(ctx, targetSessionId);
  const subagents = subagentsService(ctx);
  if (typeof subagents.sendMessage !== 'function') {
    throw new Error('subagents 服务没有 sendMessage()');
  }
  // options 里必须带 signal：实现内部会调 options.signal.throwIfAborted()
  const controller = new AbortController();
  const messageId = await subagents.sendMessage(
    sender,
    targetSessionId,
    [{ type: 'text', text }],
    { signal: controller.signal },
  );
  return {
    ok: true,
    sessionId: targetSessionId,
    senderAgentId: String(sender?.id ?? ''),
    messageId: typeof messageId === 'string' ? messageId : String(messageId ?? ''),
  };
}

/**
 * 中断目标会话当前的回合。
 *
 * `authority` 的契约是二选一，且**两个分支的必填字段都不能省**：
 *   · `{ kind: 'user', parentSessionId }` —— 桥接代表「人」，DSH 校验该会话
 *     确实属于这个父会话；
 *   · `{ kind: 'ancestor', agent }` —— 用一个确切的在线 Agent 作祖先权威。
 *
 * 目标会话没有 `parentSession`（根会话）时不能发 `{ kind: 'user' }`：
 * `parentSessionId` 必填，缺了 Host 无法授权。此时退回 `ancestor`，
 * 依次尝试 `agents.roots()[0]`、`agents.list()[0]`；连一个在线 Agent 都没有
 * 就抛 503（失败关闭，不静默降级成一次注定被拒的调用）。
 *
 * @param {any} ctx
 * @param {string} targetSessionId
 * @returns {Record<string, unknown>}
 */
export function interruptSession(ctx, targetSessionId) {
  const target = getSession(ctx, targetSessionId);
  if (target === undefined) {
    const error = /** @type {any} */ (new Error(`会话 "${targetSessionId}" 不存在`));
    error.status = 404;
    throw error;
  }
  const subagents = subagentsService(ctx);
  if (typeof subagents.interrupt !== 'function') {
    throw new Error('subagents 服务没有 interrupt()');
  }
  const parentSessionId = typeof target?.header?.parentSession === 'string' && target.header.parentSession !== ''
    ? target.header.parentSession
    : undefined;

  /** @type {{ kind: 'user', parentSessionId: string } | { kind: 'ancestor', agent: any }} */
  let authority;
  if (parentSessionId !== undefined) {
    authority = { kind: 'user', parentSessionId };
  } else {
    // 根会话：没有可声明的父会话地址，只能用一个确切的在线 Agent 当祖先权威
    const agents = agentsService(ctx);
    const roots = typeof agents.roots === 'function' ? [...agents.roots()] : [];
    const list = typeof agents.list === 'function' ? [...agents.list()] : [];
    const agent = roots[0] ?? list[0];
    if (agent === undefined || agent === null) {
      const error = /** @type {any} */ (new Error('目标会话没有父会话，且本 Host 进程没有在线 Agent 可作中断权威'));
      error.status = 503;
      throw error;
    }
    authority = { kind: 'ancestor', agent };
  }

  subagents.interrupt(targetSessionId, authority);
  return { ok: true, sessionId: targetSessionId, interrupted: true };
}

/**
 * 创建会话。
 *
 * `title` 走 `sessionTitle.rename()`；`branch` 走 `meta.parentSession`（派生/分支）；
 * `model` 与 `goal` **不能**通过 `sessions.create()` 设置：
 *   · model 属于 `request/header`（一次请求的属性），不是会话头的属性；
 *   · goal 需要往空会话里追加一条 user 消息。
 * 这两项会原样带回响应里的 `warnings`，不静默丢弃。
 *
 * @param {any} ctx
 * @param {{ title?: string, model?: string, branch?: string, goal?: string }} body
 * @returns {Record<string, unknown>}
 */
export async function createSession(ctx, body = {}) {
  const sessions = sessionsService(ctx);
  if (typeof sessions.create !== 'function') {
    const error = /** @type {any} */ (new Error('sessions 服务没有 create()：当前 Host 版本不支持通过桥接创建会话'));
    error.status = 501;
    throw error;
  }
  /** @type {string[]} */
  const warnings = [];

  const branch = typeof body.branch === 'string' && body.branch.trim() !== '' ? body.branch.trim() : undefined;
  if (branch !== undefined && getSession(ctx, branch) === undefined) {
    const error = /** @type {any} */ (new Error(`branch 会话 "${branch}" 不存在`));
    error.status = 400;
    throw error;
  }
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined;
  if (title !== undefined && title.length > 200) {
    const error = /** @type {any} */ (new Error('title 过长（上限 200 字符）'));
    error.status = 400;
    throw error;
  }
  const goal = typeof body.goal === 'string' && body.goal.trim() !== '' ? body.goal.trim() : undefined;
  if (goal !== undefined && goal.length > 20_000) {
    const error = /** @type {any} */ (new Error('goal 过长（上限 20000 字符）'));
    error.status = 400;
    throw error;
  }
  if (typeof body.model === 'string' && body.model.trim() !== '') {
    warnings.push('model 属于请求头（request/header）而非会话属性，桥接无法在创建时设置；请在会话内切换模型');
  }

  const session = sessions.create(undefined, {
    meta: {
      ...(branch === undefined ? {} : { parentSession: branch }),
    },
  });

  const titleService = sessionTitleService(ctx);
  if (title !== undefined && titleService !== undefined && typeof titleService.rename === 'function') {
    try {
      titleService.rename(session, title);
    } catch (error) {
      warnings.push(`title 设置失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (title !== undefined) {
    warnings.push('sessionTitle 服务不可用，title 未设置');
  }

  let goalDelivery;
  if (goal !== undefined) {
    try {
      goalDelivery = await sendMessage(ctx, String(session.id), goal);
    } catch (error) {
      warnings.push(`goal 投递失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ...describeSession(session, titleService),
    created: true,
    ...(goalDelivery === undefined ? {} : { goalDelivery }),
    warnings,
  };
}

/**
 * 列出模型可用的 Host 工具 schema。
 * @param {any} ctx
 * @returns {unknown[]}
 */
export function listTools(ctx) {
  const tools = service(ctx, 'tools');
  if (typeof tools.schemas !== 'function') throw new Error('tools 服务没有 schemas()');
  return [...tools.schemas()].map((schema) => safeEvent(schema));
}

/**
 * 执行一个 Host 工具。
 *
 * `ToolExecutionInput` 的契约是 `{ callId, name, arguments, signal }`，其中
 * `callId` 与 `signal` **都是必填**（`signal: AbortSignal` 没有 `?`）。以前只传
 * `{ name, arguments }`，实现内部调 `signal.throwIfAborted()` 时会直接 TypeError。
 *
 * @param {any} ctx
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
export async function executeTool(ctx, name, args) {
  const tools = service(ctx, 'tools');
  if (typeof tools.execute !== 'function') throw new Error('tools 服务没有 execute()');
  const callId = `prts-omni-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const controller = new AbortController();
  return tools.execute({ callId, name, arguments: args, signal: controller.signal });
}
