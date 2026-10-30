/**
 * 插件装配自测（不经过 DSH 运行时、不触发 UAC）：
 *   · 工具 schema / presentCall / presentResult / render 的契约；
 *   · 未开启通道时 admin_exec 的可执行错误；
 *   · /status 与 /action 的同源守卫、会话校验、关闭语义。
 *
 * 运行：node test/manager-test.mjs
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const tools = [];
const routes = new Map();

const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  on() { return () => {}; },
  get(key) {
    if (key === 'agents') {
      return {
        get(id) {
          return id === 'live-session' ? { id } : undefined;
        },
      };
    }
    return undefined;
  },
  inject(names, callback) {
    if (!names.includes('webServer')) return;
    const webCtx = {
      get(name) {
        if (name !== 'webServer') return undefined;
        return {
          register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        };
      },
      effect(fn) {
        const disposer = fn();
        return typeof disposer === 'function' ? disposer : () => {};
      },
    };
    callback(webCtx);
  },
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
};

const plugin = await import('../index.js?v=test-1');
plugin.apply(ctx, { maxChannels: 1, idleTimeoutMs: 60_000 });

let passed = 0;
const pending = [];
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
    return;
  }
  console.error(`  FAIL ${name}${detail === undefined ? '' : `：${detail}`}`);
  process.exitCode = 1;
};

const tool = tools[0];
check('注册了且只注册了 admin_exec', tools.length === 1 && tool?.name === 'admin_exec');
check('description 说明用户先开通道', String(tool?.description).includes('管理员权限通道') && String(tool?.description).includes('workbench'));

// v1.0.6：parameters 必须是标准 JSON Schema（供应商 strict 校验会拒绝作者方言）
check('parameters 是标准 JSON Schema 对象根', tool?.parameters?.type === 'object' && typeof tool?.parameters?.properties === 'object');
check('parameters.required 是顶层字符串数组', Array.isArray(tool?.parameters?.required) && tool.parameters.required.every((entry) => typeof entry === 'string'));
check('parameters.required 含 command', tool?.parameters?.required?.includes('command') === true);
check('parameters 无作者方言 required 残留', Object.values(tool?.parameters?.properties ?? {}).every((prop) => prop?.required === undefined));

// 未开启通道：可执行错误（不是崩溃）
{
  let error;
  try {
    await tool.execute({ command: 'whoami' }, { agent: { id: 'live-session' } });
  } catch (caught) {
    error = caught;
  }
  check('未开启通道时 execute 抛可执行错误', error instanceof Error && error.message.includes('管理员权限通道') && error.message.includes('工作箱'), error?.message);
}

// presentCall / presentResult / render
{
  const call = tool.presentCall({ command: 'Get-Service', cwd: 'C:\\Windows' });
  check('presentCall 是 terminal 卡片', call.card === 'terminal' && call.title === 'Get-Service' && call.cwd === 'C:\\Windows');
  const rendered = tool.output.render({ command: 'x' }, {
    exitCode: 0,
    durationMs: 12,
    stdout: 'hello',
    stderr: '',
    timedOut: false,
    truncated: false,
    command: 'x',
    cwd: null,
    sessionId: 'live-session',
    elevated: true,
    ok: true,
  });
  check('render 含 stdout 与退出码', rendered[0].type === 'text' && rendered[0].text.includes('hello') && rendered[0].text.includes('exit 0'));
  const view = tool.presentResult({ command: 'x' }, {
    isError: false,
    content: [{ type: 'text', text: 'y' }],
    value: { stdout: 'hello', stderr: 'e', exitCode: 2, timedOut: false, command: 'x', cwd: null, sessionId: 'live-session', elevated: true, ok: true, durationMs: 1, truncated: false },
  });
  check('presentResult 是带退出码的 terminal 卡片', view.card === 'terminal' && view.exitCode === 2 && view.output.includes('hello'));
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string>, url?: string }} [options]
 */
async function callRoute(path, options = {}) {
  const handler = routes.get(path);
  if (handler === undefined) throw new Error(`route missing: ${path}`);
  const req = new EventEmitter();
  req.method = options.method ?? 'GET';
  req.headers = options.headers ?? {};
  req.url = options.url ?? path;
  req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  req.destroy = () => {};
  const response = {
    headersSent: false,
    writableEnded: false,
    status: 0,
    body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) {
      this.writableEnded = true;
      this.body = String(body ?? '');
      settle();
    },
    destroy() {},
  };
  let settle;
  const finished = new Promise((resolve) => { settle = resolve; });
  const timer = setTimeout(() => settle(), 5000);
  handler(req, response);
  if (options.body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(options.body)));
      req.emit('end');
    });
  }
  await finished;
  clearTimeout(timer);
  return { status: response.status, json: response.body === '' ? null : JSON.parse(response.body) };
}

// 路由存在
check('注册了 status / action 路由', routes.has('/dsh-admin-channel/status') && routes.has('/dsh-admin-channel/action'));

// 状态路由：空闲会话 = off
{
  const result = await callRoute('/dsh-admin-channel/status', { url: '/dsh-admin-channel/status?sessionId=live-session' });
  check('status 返回 off', result.status === 200 && result.json.phase === 'off' && result.json.running === false);
  check('status 带 note/hint', typeof result.json.note === 'string' && typeof result.json.hint === 'string');
}

// 非回环来源一律拒绝（即使没有 Origin）
{
  const result = await callRoute('/dsh-admin-channel/status', {
    url: '/dsh-admin-channel/status?sessionId=live-session',
    remoteAddress: '192.168.1.50',
  });
  check('非回环来源被拒绝', result.status === 403 && String(result.json.error).includes('回环'));
}

// 浏览器来源一律拒绝
{
  const result = await callRoute('/dsh-admin-channel/status', {
    url: '/dsh-admin-channel/status?sessionId=live-session',
    headers: { origin: 'http://evil.example' },
  });
  check('带 Origin 的请求被拒绝', result.status === 403);
}

// 未知会话：409
{
  const result = await callRoute('/dsh-admin-channel/action', {
    method: 'POST',
    body: { sessionId: 'not-live', enabled: false },
  });
  check('非活跃会话返回 409', result.status === 409 && String(result.json.error).includes('会话不在本进程'));
}

// 关闭（空闲）是幂等的，且不会触发 UAC
{
  const result = await callRoute('/dsh-admin-channel/action', {
    method: 'POST',
    body: { sessionId: 'live-session', enabled: false },
  });
  check('关闭空闲通道返回 off', result.status === 200 && result.json.phase === 'off');
}

// 浏览器来源的 action 被拒绝（连停止都不接受）
{
  const result = await callRoute('/dsh-admin-channel/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { sessionId: 'live-session', enabled: false },
  });
  check('带 Sec-Fetch 的 action 被拒绝', result.status === 403);
}

console.log(`\n${passed} checks passed`);
if (pending.length > 0) console.log(pending.join('\n'));
