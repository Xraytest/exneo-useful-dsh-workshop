/**
 * dsh-admin-channel -- 会话级管理员权限通道（host 半边）。
 *
 * 用户侧入口在「工作箱」(dsh-workbench) 的「管理员权限通道」开关；这个插件只负责：
 *
 *   1. 提供模型工具 `admin_exec`：把命令交给本会话的常驻提权进程执行；
 *   2. 提供工作箱用的同源路由：
 *        GET  /dsh-admin-channel/status?sessionId=…
 *        POST /dsh-admin-channel/action  { sessionId, enabled }
 *      启动动作会拉起**一次** UAC（launch.ps1 → broker.ps1），之后不再逐次确认；
 *   3. 会话级生命周期：只有**开启它的那个会话**能执行；会话销毁、空闲超时、
 *      插件卸载都会关闭提权进程。
 *
 * 安全边界（详见 README）：
 *   · 提权进程只接受 **DSH host 进程** 的连接（GetNamedPipeClientProcessId 校验）；
 *   · 每次启动生成 256 位随机令牌，每个请求都要带；
 *   · 管道 ACL 只给当前用户 / Administrators / SYSTEM；
 *   · 通道不落盘、不跨进程恢复，host 退出即断管，broker 自行退出；
 *   · 启动动作只能由用户在工作箱里发起（模型工具**不能**启动通道）。
 *
 * @module dsh-admin-channel
 */

// 版本化 specifier：Loader / Node ESM 按完整 URL 缓存模块，改过 lib/channel.js 后
// 必须让这条 import 的 URL 也跟着 entry-vN 一起换，否则旧 index 会继续用旧 channel。
import { createAdminChannelManager } from './lib/channel.js?v=ac-7';

export const name = 'admin-channel';

/** 工具注册表是硬依赖；webServer 用 ctx.inject 等它出现（冷启动顺序不固定）。 */
export const inject = ['tools'];

const ROUTE = '/dsh-admin-channel';

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 * @returns {boolean}
 */
function sendJson(res, status, value) {
  if (res.headersSent === true || res.writableEnded === true) {
    res.destroy?.();
    return false;
  }
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = JSON.stringify({ error: '响应无法序列化为 JSON' });
    status = 500;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
  return true;
}

/**
 * 浏览器请求守卫：本插件的路由只服务 host 内部回环（工作箱在 host 进程里 fetch），
 * 不接受任何页面发起的调用。页面请求一定带 Origin 或 Sec-Fetch-*，一律拒绝。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isBrowserRequest(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') return true;
  const site = req.headers['sec-fetch-site'];
  return typeof site === 'string' && site !== '';
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve(value ?? {});
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return finish(undefined, {});
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return finish(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 }));
        }
        return finish(undefined, value);
      } catch {
        return finish(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', (error) => finish(Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 })));
  });
}

/**
 * 工具描述：模型是唯一读者，写清楚“用户先开通道”和“不要自行提权”。
 * @returns {string}
 */
function toolDescription() {
  return [
    'Run a PowerShell command with full administrator rights through the administrator channel of THIS session.',
    'The channel is opened only by the user: they flip "管理员权限通道" in the workbench (输入框工具行 → 工作箱),',
    'which raises exactly one UAC prompt. After that, commands sent here run in a resident elevated process and',
    'no further UAC prompts appear until the channel is closed (session end, idle timeout, or the user turns it off).',
    'Use this tool only when an ordinary pwsh/bash command fails because it needs administrator rights',
    '(Access denied, requires elevation, service/registry/driver/system changes).',
    'If the channel is not running the tool fails with instructions: ask the user to enable it in the workbench;',
    'never try to elevate with runas, scheduled tasks, services or other tricks, and never retry in a loop.',
    'Each call runs in a fresh hidden Windows PowerShell process. Pass cwd to set the working directory and',
    'timeout_ms for long commands. Output is UTF-8; large output is truncated at the configured limit.',
    'The reported exit code is the PowerShell process exit code: end the command with `exit N` to report a',
    'failure explicitly (a non-terminating PowerShell error alone still exits 0).',
  ].join(' ');
}

/**
 * @param {unknown} args
 * @returns {{ command: string, cwd?: string, timeoutMs?: number }}
 */
function readExecArgs(args) {
  const input = args !== null && typeof args === 'object' ? args : {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.trim() === '') throw new Error('command 不能为空');
  if (command.length > 20_000) throw new Error('command 过长（上限 20000 字符）');
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() !== '' ? input.cwd.trim() : undefined;
  if (cwd !== undefined && cwd.length > 1_000) throw new Error('cwd 过长');
  const timeoutMs = Number.isFinite(input.timeout_ms) ? Number(input.timeout_ms) : undefined;
  return { command, ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderResult(value) {
  const lines = [];
  const exit = value.exitCode === null || value.exitCode === undefined ? 'exit ?' : `exit ${value.exitCode}`;
  const flags = [exit, `${Math.round(Number(value.durationMs) || 0)} ms`];
  if (value.timedOut === true) flags.push('timed out');
  if (value.truncated === true) flags.push('truncated');
  lines.push(`[${flags.join(' · ')}] 管理员权限通道（Administrator）`);
  lines.push(`> ${String(value.command ?? '')}`);
  if (typeof value.cwd === 'string' && value.cwd !== '') lines.push(`cwd: ${value.cwd}`);
  const stdout = typeof value.stdout === 'string' ? value.stdout.replace(/\s+$/u, '') : '';
  const stderr = typeof value.stderr === 'string' ? value.stderr.replace(/\s+$/u, '') : '';
  if (stdout !== '') {
    lines.push('', stdout);
  }
  if (stderr !== '') {
    lines.push('', '[stderr]', stderr);
  }
  if (stdout === '' && stderr === '') lines.push('', '(无输出)');
  return lines.join('\n');
}

/**
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const log = (level, text) => {
    try {
      ctx.logger?.[level]?.(text);
    } catch { /* 日志失败不影响插件 */ }
  };
  const manager = createAdminChannelManager({ ctx, config, log });

  const agentsOf = () => {
    try {
      return ctx.get('agents');
    } catch {
      return undefined;
    }
  };

  /**
   * 路由只服务本机回环：DSH 的 Web 服务默认绑定 127.0.0.1，但配置可能改成局域网
   * 监听；工作箱的 server-side fetch 从本机发起，所以回环检查不会误伤它。
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  const isLoopbackRequest = (req) => {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  };

  /**
   * 会话必须在本进程的 Agent 注册表里。`agents` 服务缺失时**失败关闭**，否则任何
   * 伪造的 sessionId 都能占用全局唯一的通道槽位。
   * @param {import('node:http').IncomingMessage} req
   * @param {string} sessionId
   * @returns {boolean}
   */
  const agentOnline = (req, sessionId) => {
    const agents = agentsOf();
    if (agents === undefined || agents === null || typeof agents.get !== 'function') {
      log('warn', 'dsh-admin-channel: agents 服务不可用，拒绝 action（失败关闭）');
      return false;
    }
    try {
      return agents.get(sessionId) !== undefined;
    } catch {
      return false;
    }
  };

  /**
   * 本插件的路由守卫：回环 + 非浏览器来源。浏览器页面（含 DNS rebinding）一律
   * 拒绝；工作箱在 host 进程内 fetch，不带 Origin/Sec-Fetch，可正常调用。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean} true = 已拒绝并写完响应
   */
  const rejectUnsafeRequest = (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { error: '仅接受本机回环请求' });
      return true;
    }
    if (isBrowserRequest(req)) {
      sendJson(res, 403, { error: 'cross-origin request rejected' });
      return true;
    }
    return false;
  };

  // ── 路由（工作箱在 host 进程里回环调用）─────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      log('warn', 'dsh-admin-channel: webServer 没有 register，状态路由未注册');
      return;
    }

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const handleStatus = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method Not Allowed' });
      if (rejectUnsafeRequest(req, res)) return;
      let sessionId = '';
      try {
        sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? '';
      } catch {
        sessionId = '';
      }
      return sendJson(res, 200, manager.statusOf(sessionId));
    };

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    const handleAction = async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method Not Allowed' });
      if (rejectUnsafeRequest(req, res)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, Number(error?.status) || 400, { error: error instanceof Error ? error.message : String(error) });
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (sessionId === '') return sendJson(res, 400, { error: 'sessionId 必填' });
      if (!agentOnline(req, sessionId)) {
        return sendJson(res, 409, { error: '会话不在本进程（Agent 不在线）：管理员权限通道只能挂在当前活跃会话上' });
      }
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
      try {
        if (enabled === false) return sendJson(res, 200, await manager.stop(sessionId, 'user'));
        if (enabled === true) return sendJson(res, 200, await manager.start(sessionId));
        const status = manager.statusOf(sessionId);
        if (status.phase === 'running' || status.phase === 'starting') {
          return sendJson(res, 200, await manager.stop(sessionId, 'user-toggle'));
        }
        return sendJson(res, 200, await manager.start(sessionId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /另一会话/.test(message) ? 409 : 500;
        log('warn', `dsh-admin-channel: action 失败：${message}`);
        return sendJson(res, status, { error: message });
      }
    };

    /**
     * @param {string} path
     * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<unknown>} handler
     * @param {string} label
     */
    const register = (path, handler, label) => {
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          Promise.resolve(handler(req, res)).catch((error) => {
            sendJson(res, 500, { error: `admin-channel 路由内部错误：${error instanceof Error ? error.message : String(error)}` });
          });
        },
      }), label);
    };

    register(`${ROUTE}/status`, handleStatus, 'dsh-admin-channel: status');
    register(`${ROUTE}/action`, handleAction, 'dsh-admin-channel: action');
    log('info', `dsh-admin-channel: 路由已注册 ${ROUTE}/status · ${ROUTE}/action`);
  });

  // ── 模型工具 ─────────────────────────────────────────────────────────────
  // ⚠ parameters 必须是**标准 JSON Schema**（顶层 type:'object' + properties +
  // required 数组）。ctx.tools.register() 把 parameters 原样透传给模型供应商
  // （schemaOf 不做 defineTool 的作者方言编译）；strict/非 strict 供应商都会校验
  // function.parameters 是 type:'object' 的 JSON Schema——写成作者方言（每个属性
  // 上挂 required:true、顶层没有 type:'object'）会让部分供应商直接拒绝整个请求：
  // "Invalid schema for function 'admin_exec': schema must be a JSON Schema of
  // 'type: \"object\"', got 'type: null'"。
  const definition = {
    name: 'admin_exec',
    description: toolDescription(),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'PowerShell command to run with administrator rights in this session\'s admin channel.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to the elevated process user profile directory.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds for this command (default 120000, capped at 1800000). The channel remains open after a timeout.',
        },
      },
      required: ['command'],
    },
    output: {
      // 标准.JSON Schema（与 parameters 同一子集：type/oneOf/properties/required/
      // additionalProperties/items/enum/const + 注解；oneOf 不能与 required 同层）。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          elevated: { type: 'boolean' },
          command: { type: 'string' },
          cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        required: ['ok', 'sessionId', 'elevated', 'command', 'cwd', 'exitCode', 'stdout', 'stderr', 'timedOut', 'durationMs', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      presentationMeta: (_args, value) => ({ cwd: typeof value?.cwd === 'string' ? value.cwd : '' }),
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      // Agent.id 与 Session.id 在多数部署里相同；两者都试一下，优先命中已有通道
      // 的那个键，避免因运行时身份口径不同而永远报「本会话没有开启」。
      const candidates = [agent?.id, agent?.session?.id]
        .filter((id) => typeof id === 'string' && id !== '');
      const sessionId = candidates.find((id) => manager.has(id)) ?? candidates[0];
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error('admin_exec 需要会话上下文（exec.agent 缺失）');
      }
      const input = readExecArgs(args);
      return manager.exec(sessionId, input);
    },
    presentCall(args) {
      const command = typeof args?.command === 'string' ? args.command : 'admin_exec';
      const cwd = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined;
      return {
        card: 'terminal',
        title: command,
        description: '管理员权限通道 · Administrator',
        ...(cwd === undefined ? {} : { cwd }),
      };
    },
    presentResult(_args, result) {
      if (result.isError === true) return { card: 'generic', content: result.content };
      const value = result.value ?? {};
      const output = [value.stdout, value.stderr].filter((part) => typeof part === 'string' && part !== '').join('\n');
      const exitCode = Number.isFinite(value.exitCode) ? Number(value.exitCode) : undefined;
      return {
        card: 'terminal',
        ...(output === '' ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    },
  };

  ctx.effect(() => ctx.tools.register(definition), 'dsh-admin-channel: admin_exec tool');

  // 会话销毁 → 关闭该会话的通道（提权进程只跟会话同寿）。
  // 事件契约是 payload { agent }（cordis_inspect_query 的 Event 签名）；这里同时
  // 兼容「直接传 Agent」的形状，避免版本差异导致销毁时漏关。
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload;
    const candidates = [agent?.id, agent?.session?.id]
      .filter((id) => typeof id === 'string' && id !== '');
    const sessionId = candidates.find((id) => manager.has(id)) ?? candidates[0];
    if (typeof sessionId !== 'string' || sessionId === '') return;
    void manager.stop(sessionId, 'session-disposed').catch((error) => {
      log('warn', `dsh-admin-channel: 会话销毁时关闭通道失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });

  // 插件卸载/重载 → 关闭全部通道。
  ctx.effect(() => () => manager.disposeAll(), 'dsh-admin-channel: dispose every channel');

  log('info', `dsh-admin-channel: 就绪（maxChannels=${manager.settings.maxChannels} idle=${Math.round(manager.settings.idleTimeoutMs / 60_000)}min audit=${manager.auditFile}）`);
}
