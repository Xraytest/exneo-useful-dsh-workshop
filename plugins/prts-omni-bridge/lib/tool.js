/**
 * Host 模型工具 `prts_omni`。
 *
 * 让模型能（在用户授权范围内）查看桥接状态、给会话发消息、中断回合、派生新会话。
 * 工具本身不直接碰 HTTP：它走的是和 REST 路由**同一套** DSH 服务适配层，
 * 所以两条路径的权限与错误语义一致。
 *
 * @module prts-omni-bridge/lib/tool
 */

/**
 * 工具描述：模型是唯一读者，写清楚边界与失败模式。
 * @returns {string}
 */
function toolDescription() {
  return [
    'Drive the PRTS Omni bridge: list this Host\'s sessions, send a message into one,',
    'interrupt a running turn, or spawn a derived session.',
    'list_sessions returns each session id, title, cwd and parent lineage.',
    'send delivers text to a session as a human turn; pass interrupt=true to stop the',
    'running turn first. DSH authorizes delivery by the target session\'s live parent Agent,',
    'so a session whose parent is offline is rejected with UNAUTHORIZED — report that',
    'instead of retrying.',
    'spawn creates a new session; branch copies the lineage of an existing session,',
    'goal is delivered as that session\'s first message, and model cannot be set at',
    'creation time (it belongs to a request header, not to the session).',
    'This tool never returns the pairing token and never executes another Host tool.',
  ].join(' ');
}

/**
 * 输出 schema：标准 JSON Schema 子集（与 parameters 同一套关键字）。
 * @returns {Record<string, unknown>}
 */
function outputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      action: { type: 'string' },
      // list_sessions
      sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      total: { type: 'integer' },
      truncated: { type: 'boolean' },
      // send / interrupt / spawn
      sessionId: { type: 'string' },
      senderAgentId: { type: 'string' },
      messageId: { type: 'string' },
      interrupted: { type: 'boolean' },
      created: { type: 'boolean' },
      title: { type: 'string' },
      parentSession: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      warnings: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
    },
    required: ['ok', 'action'],
  };
}

/**
 * 把工具结果渲染成模型可读的文本。
 * @param {string} action
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
function renderResult(action, value) {
  if (value.ok === false) return `[prts_omni ${action} 失败] ${String(value.error ?? '')}`;
  const lines = [`[prts_omni ${action}]`];
  if (action === 'list_sessions') {
    const sessions = Array.isArray(value.sessions) ? value.sessions : [];
    lines.push(`共 ${Number(value.total ?? sessions.length)} 个会话${value.truncated === true ? '（已截断）' : ''}`);
    for (const session of sessions) {
      const id = String(session.id ?? '');
      const title = typeof session.title === 'string' && session.title !== '' ? session.title : '(无标题)';
      const parent = typeof session.parentSession === 'string' ? ` ← ${session.parentSession}` : '';
      lines.push(`- ${id}  ${title}${parent}`);
    }
    return lines.join('\n');
  }
  if (action === 'send') {
    lines.push(`sessionId: ${String(value.sessionId ?? '')}`);
    lines.push(`senderAgentId: ${String(value.senderAgentId ?? '')}`);
    if (value.interrupted === true) lines.push('已先中断正在进行的回合');
    return lines.join('\n');
  }
  if (action === 'interrupt') {
    lines.push(`已请求中断 ${String(value.sessionId ?? '')}`);
    return lines.join('\n');
  }
  if (action === 'spawn') {
    lines.push(`sessionId: ${String(value.sessionId ?? '')}`);
    if (typeof value.title === 'string' && value.title !== '') lines.push(`title: ${value.title}`);
    if (typeof value.parentSession === 'string') lines.push(`branch: ${value.parentSession}`);
    const warnings = Array.isArray(value.warnings) ? value.warnings : [];
    for (const warning of warnings) lines.push(`警告：${String(warning)}`);
    return lines.join('\n');
  }
  return lines.join('\n');
}

/**
 * 构造 `prts_omni` 工具定义。
 *
 * ⚠ `parameters` 必须是**标准 JSON Schema**：顶层 `type:'object'` + `properties` +
 * `required` 数组。`ctx.tools.register()` 原样透传给模型供应商，写成作者方言
 * （每个属性上挂 `required:true`、顶层没有 `type:'object'`）会让部分供应商
 * 直接拒绝整个请求。
 *
 * @param {{ getContext: () => any }} options 延迟取 ctx，避免装配期就抓服务
 * @returns {Record<string, any>}
 */
export function createPrtsOmniTool(options) {
  /**
   * 从执行上下文里取 agentId。
   *
   * 提成工厂闭包内的函数，是为了让 `presentCall` 也能安全调用：以前
   * `agentId` 是 `execute()` 里的局部 const，`presentCall` 一引用就
   * ReferenceError（Host 渲染工具调用卡住时会走这条路）。
   *
   * ⚠ Host 契约是 `presentCall?(args)`，**只传 args**，所以 presentCall 里
   * 多半取不到 exec；取不到就返回空串，由调用方决定不带这个字段，
   * 绝不因为拿不到上下文就抛异常。
   *
   * @param {any} exec
   * @returns {string}
   */
  const agentIdOf = (exec) => (typeof exec?.agent?.id === 'string' ? exec.agent.id : '');

  return {
    name: 'prts_omni',
    description: toolDescription(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list_sessions', 'send', 'interrupt', 'spawn'],
          description: 'Which bridge operation to perform.',
        },
        sessionId: {
          type: 'string',
          description: 'Target session id. Required for send and interrupt.',
        },
        text: {
          type: 'string',
          description: 'Message text for send. Required when action is send.',
        },
        interrupt: {
          type: 'boolean',
          description: 'For send: interrupt the running turn before delivering.',
        },
        title: {
          type: 'string',
          description: 'For spawn: the new session title.',
        },
        branch: {
          type: 'string',
          description: 'For spawn: an existing session id to derive the new session from.',
        },
        goal: {
          type: 'string',
          description: 'For spawn: text delivered as the new session\'s first message.',
        },
        model: {
          type: 'string',
          description: 'For spawn: requested model. Not settable at creation; reported back as a warning.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: outputSchema(),
      render: (args, value) => [{
        type: 'text',
        text: renderResult(String(args?.action ?? ''), value ?? {}),
      }],
    },
    async execute(args, exec) {
      const agentId = agentIdOf(exec);
      const action = typeof args?.action === 'string' ? args.action : '';
      const ctx = options.getContext();
      if (ctx === undefined || ctx === null) {
        return { ok: false, action, error: '桥接上下文尚未就绪（插件未激活）' };
      }
      try {
        // 动态引入适配层，让工具与 http 路由共用同一套实现
        const adapter = await import('./sessions.js?v=1');
        switch (action) {
          case 'list_sessions':
            return { ok: true, action, ...adapter.listSessions(ctx, {}) };
          case 'send': {
            const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
            if (sessionId === '') return { ok: false, action, error: 'sessionId 必填' };
            const text = typeof args?.text === 'string' ? args.text : '';
            if (text.trim() === '') return { ok: false, action, error: 'text 必填且不能为空白' };
            if (args?.interrupt === true) adapter.interruptSession(ctx, sessionId);
            return { ok: true, action, ...(await adapter.sendMessage(ctx, sessionId, text)) };
          }
          case 'interrupt': {
            const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : '';
            if (sessionId === '') return { ok: false, action, error: 'sessionId 必填' };
            return { ok: true, action, ...adapter.interruptSession(ctx, sessionId) };
          }
          case 'spawn':
            return {
              ok: true,
              action,
              ...(await adapter.createSession(ctx, {
                title: typeof args?.title === 'string' ? args.title : undefined,
                model: typeof args?.model === 'string' ? args.model : undefined,
                branch: typeof args?.branch === 'string' ? args.branch : undefined,
                goal: typeof args?.goal === 'string' ? args.goal : undefined,
              })),
            };
          default:
            return { ok: false, action, error: `未知动作 "${action}"` };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, action, error: message };
      }
    },
    presentCall(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'prts_omni';
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      // 契约只保证传 args；exec 缺失时 agentIdOf 返回空串，字段被省掉而不是抛错
      const agentId = agentIdOf(exec);
      return {
        card: 'generic',
        title: action,
        description: 'PRTS Omni 桥接',
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agentId === '' ? {} : { agentId }),
      };
    },
    presentResult(_args, result) {
      const value = result?.value ?? {};
      const text = renderResult(String(value.action ?? ''), value);
      return { card: 'generic', content: [{ type: 'text', text }] };
    },
  };
}
