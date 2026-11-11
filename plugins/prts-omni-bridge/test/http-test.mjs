/**
 * HTTP 服务集成自测：起真实 server（127.0.0.1 随机端口），
 * 覆盖路由分发、令牌校验、body 上限、会话映射、工具开关与 WS 升级。
 *
 * 运行：node --test test/http-test.mjs
 */

import assert from 'node:assert/strict';
import { get, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBridge, isLoopbackAddress, isLoopbackRequest } from '../lib/http.js?v=1';
import { loadOrCreateToken } from '../lib/token.js?v=1';
import { FrameParser, OPCODE, encodeFrame, unmask } from '../lib/ws.js?v=1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * undici（全局 fetch）的坏端口黑名单。
 *
 * 本机动态端口范围是 1024-15000，里面正好包含 undici 的 19 个 badPorts
 * （6000、6566、6665-6669、6679、6697、10080 …）。`listen(0)` 随机命中其中一个时，
 * `fetch()` 会抛 `TypeError: fetch failed / cause: Error: bad port` —— 实测
 * 27 跑 2 挂。这里既把这些端口排除掉，也全面改用 node:http 客户端。
 */
const BAD_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/**
 * 假 DSH ctx。
 * @param {{ sessions?: any[], agents?: any[] }} [input]
 */
function fakeCtx(input = {}) {
  const sessions = new Map((input.sessions ?? []).map((session) => [session.id, session]));
  const agents = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  const titles = new Map();
  const tools = [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {}, required: [] } }];
  /** 记录 tools.execute 收到的输入，用于断言 Host 契约字段。 */
  const toolCalls = [];
  return {
    get: (key) => {
      if (key === 'sessions') return {
        list: () => [...sessions.values()],
        get: (id) => sessions.get(id),
        create: (id, options) => {
          const newId = id ?? `session-${sessions.size + 1}`;
          const session = {
            id: newId,
            header: { version: 4, id: newId, createdAt: Date.now(), isSeeded: false, ...(options?.meta ?? {}) },
            seq: 0,
            snapshotEvents: (from = 0, to = 0) => Object.freeze([]),
            deriveMessages: () => [],
          };
          sessions.set(newId, session);
          return session;
        },
      };
      if (key === 'agents') return {
        list: () => [...agents.values()],
        get: (id) => agents.get(id),
        roots: () => [...agents.values()].filter((agent) => agent.root === true),
      };
      if (key === 'subagents') return {
        sendMessage: async () => 'msg-1',
        interrupt: () => {},
      };
      if (key === 'sessionTitle') return {
        get: (session) => (titles.has(session.id) ? { title: titles.get(session.id) } : undefined),
        rename: (session, title) => { titles.set(session.id, title); },
      };
      if (key === 'tools') return {
        schemas: () => tools,
        execute: async (exec) => {
          // 断言 ToolExecutionInput 契约：callId 与 signal 都必须真的传进来
          assert.ok(typeof exec.callId === 'string' && exec.callId !== '', 'tools.execute 缺少 callId');
          assert.ok(exec.signal && typeof exec.signal.throwIfAborted === 'function', 'tools.execute 缺少 signal');
          assert.equal(exec.name, exec.name);
          toolCalls.push(exec);
          return { ok: true, name: exec.name, arguments: exec.arguments };
        },
      };
      return undefined;
    },
    toolCalls,
  };
}

/**
 * @param {string} id
 * @param {Array<Record<string, unknown>>} [events]
 */
function fakeSession(id, events = []) {
  const log = events.map((event, index) => ({ ...event, seq: index, time: 1000 + index }));
  return {
    id,
    header: { version: 4, id, createdAt: 1700000000000, isSeeded: false },
    seq: log.length,
    inheritedEventCount: 0,
    snapshotEvents(from = 0, to = this.seq) { return Object.freeze(this.log.slice(from, to)); },
    deriveMessages() { return []; },
    log,
  };
}

let root;
let token;
let base;
let bridge;
let ctx;

/**
 * 起一个桥接，避开 undici 坏端口。
 * @param {any} targetCtx
 * @param {Record<string, unknown>} [config]
 */
async function startBridge(targetCtx, config = {}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = createBridge({
      ctx: targetCtx,
      config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: false, maxSessions: 50, ...config },
      token,
      heartbeatMs: 2000,
      eventPollMs: 60,
    });
    const endpoint = await candidate.start();
    const port = Number(endpoint.split(':')[1]);
    if (!BAD_PORTS.has(port)) return { bridge: candidate, endpoint };
    await candidate.stop();
  }
  throw new Error('找不到可用的测试端口（坏端口太多？）');
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prts-http-'));
  process.env.PRTS_OMNI_BRIDGE_HOME = root;
  const loaded = await loadOrCreateToken();
  token = loaded.token;
  ctx = fakeCtx({
    sessions: [
      fakeSession('s-alpha', [
        { type: 'user/message', data: { role: 'user', content: [] } },
        { type: 'tool/call', data: { name: 'bash' } },
      ]),
      fakeSession('s-beta'),
    ],
    agents: [{ id: 's-alpha', root: true }],
  });
  const started = await startBridge(ctx);
  bridge = started.bridge;
  base = `http://${started.endpoint}`;
});

test.afterEach(async () => {
  await bridge.stop();
  delete process.env.PRTS_OMNI_BRIDGE_HOME;
  await rm(root, { recursive: true, force: true });
});

/**
 * 发一个请求。用 node:http 而不是全局 fetch：绕开 undici 坏端口黑名单，
 * 也避免 undici 连接池残留 keep-alive handle 让测试进程不肯退出。
 *
 * @param {string} path 相对路径（拼在 base 后）或完整 URL
 * @param {{ method?: string, token?: string | null, body?: unknown, headers?: Record<string, string> }} [options]
 */
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.token !== null) headers.authorization = `Bearer ${options.token ?? token}`;
    let payload;
    if (options.body !== undefined) {
      payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const target = new URL(path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`);
    const req = httpRequest({
      host: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: Number(res.statusCode ?? 0), json, text, headers: res.headers });
      });
      // 服务端可能在响应写完后立刻拆连接（例如 413 路径）：已经拿到状态码就别挂住
      res.on('aborted', () => resolve({ status: Number(res.statusCode ?? 0), json: undefined, text: '', headers: res.headers }));
      res.on('error', () => resolve({ status: Number(res.statusCode ?? 0), json: undefined, text: '', headers: res.headers }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test('health 与 auth/token 在回环免令牌可用', async () => {
  const health = await request('/prts-omni/v1/health', { token: null });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.headers['cache-control'], 'no-store');

  const auth = await request('/prts-omni/v1/auth/token', { token: null });
  assert.equal(auth.status, 200);
  assert.equal(auth.json.token, token);
});

test('会话接口无令牌返回 401', async () => {
  const response = await request('/prts-omni/v1/sessions', { token: null });
  assert.equal(response.status, 401);
  assert.equal(response.json.error, '缺少或错误的配对令牌');
  // 401 响应体绝不能泄漏令牌
  assert.equal(response.text.includes(token), false);
});

test('错误令牌返回 401', async () => {
  const response = await request('/prts-omni/v1/sessions', { token: 'x'.repeat(64) });
  assert.equal(response.status, 401);
});

test('X-PRTS-Token 头也能通过认证', async () => {
  const response = await request('/prts-omni/v1/sessions', { token: null, headers: { 'x-prts-token': token } });
  assert.equal(response.status, 200);
});

test('未认证时未知路由/方法不匹配也返回 401（不泄露路由表）', async () => {
  // 令牌校验必须发生在路由解析之前：否则未认证客户端能靠 404/405 差异枚举路由表
  const unknown = await request('/prts-omni/v1/nope', { token: null });
  assert.equal(unknown.status, 401);
  const wrongMethod = await request('/prts-omni/v1/sessions', { method: 'DELETE', token: null });
  assert.equal(wrongMethod.status, 401);
  // 带 Origin 的跨站未认证请求同样是 401，而不是先给出 403
  const crossOrigin = await request('/prts-omni/v1/nope', { token: null, headers: { origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 401);
  // 认证之后才恢复 404/405/403 的区分
  assert.equal((await request('/prts-omni/v1/nope')).status, 404);
  assert.equal((await request('/prts-omni/v1/sessions', { method: 'DELETE' })).status, 405);
  assert.equal((await request('/prts-omni/v1/sessions', { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('坏百分号转义返回 400 而不是 500', async () => {
  for (const path of ['/prts-omni/v1/sessions/%ZZ', '/prts-omni/v1/sessions/%E0%A4%A', '/prts-omni/v1/sessions/s-%zz']) {
    const response = await request(path);
    assert.equal(response.status, 400, `${path} 应返回 400`);
    assert.match(response.json.error, /百分号转义/u);
  }
  // 服务仍然活着
  const health = await request('/prts-omni/v1/health');
  assert.equal(health.status, 200);
  // 合法的转义仍然正常解码
  const encoded = await request(`/prts-omni/v1/sessions/${encodeURIComponent('s-alpha')}`);
  assert.equal(encoded.status, 200);
  assert.equal(encoded.json.id, 's-alpha');
});

test('isLoopbackAddress 归一化判定', () => {
  // 以前靠四个字面量硬编码，其中 '::ffff:::1' 是永不命中的死字符串
  for (const address of ['127.0.0.1', '::1', '7f00:1', '127.5.6.7', '127.0.0.1', '::ffff:127.0.0.1', '::ffff:127.9.9.9', '0:0:0:0:0:0:0:1', '7f00:0:1']) {
    assert.equal(isLoopbackAddress(address), true, `${address} 应判定为回环`);
  }
  for (const address of ['', '0.0.0.0', '::', '203.0.113.5', '203.0.113.10', '::ffff:203.0.113.5', '2001:db8::1', 'localhost', '126.0.0.1', '128.0.0.1']) {
    assert.equal(isLoopbackAddress(address), false, `${address} 不应判定为回环`);
  }
  // isLoopbackRequest 走同一条归一化逻辑
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:10.0.0.5' } }), false);
  assert.equal(isLoopbackRequest({}), false);
});

test('GET /sessions 返回映射后的会话列表', async () => {
  const response = await request('/prts-omni/v1/sessions');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.sessions.map((s) => s.id), ['s-alpha', 's-beta']);
  assert.equal(response.json.total, 2);
  assert.equal(response.json.sessions[0].formatVersion, 4);
});

test('limit 缺省/非法时回落到 maxSessions，正值夹到 maxSessions', async () => {
  const limited = await startBridge(ctx, { maxSessions: 1 });
  try {
    const viaQuery = async (query) => {
      const endpoint = limited.endpoint;
      return new Promise((resolve, reject) => {
        const target = new URL(`http://${endpoint}`);
        const req = get({
          host: target.hostname,
          port: Number(target.port),
          path: `/prts-omni/v1/sessions${query}`,
          headers: { authorization: `Bearer ${token}` },
          agent: false,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject);
      });
    };

    // 缺省 → maxSessions
    assert.equal((await viaQuery('')).sessions.length, 1);
    // ?limit= 为空 → 以前绕过上限返回全部，现在回落到 maxSessions
    assert.equal((await viaQuery('?limit=')).sessions.length, 1);
    // ?limit=abc → 以前是 NaN 绕过上限，现在回落到 maxSessions
    assert.equal((await viaQuery('?limit=abc')).sessions.length, 1);
    // 负值 / 0 同样回落
    assert.equal((await viaQuery('?limit=0')).sessions.length, 1);
    assert.equal((await viaQuery('?limit=-3')).sessions.length, 1);
    // 正值夹到 maxSessions
    const clamped = await viaQuery('?limit=99999');
    assert.equal(clamped.sessions.length, 1);
    assert.equal(clamped.truncated, true);
  } finally {
    await limited.bridge.stop();
  }
});

test('GET /sessions/:id 与 /events 分页', async () => {
  const one = await request('/prts-omni/v1/sessions/s-alpha');
  assert.equal(one.status, 200);
  assert.equal(one.json.id, 's-alpha');

  const events = await request('/prts-omni/v1/sessions/s-alpha/events?since=0&limit=1');
  assert.equal(events.status, 200);
  assert.equal(events.json.events.length, 1);
  assert.equal(events.json.nextSeq, 1);
  assert.equal(events.json.events[0].type, 'user/message');
});

test('未知会话返回 404', async () => {
  const response = await request('/prts-omni/v1/sessions/ghost');
  assert.equal(response.status, 404);
});

test('POST /sessions/:id/message 走 sendMessage', async () => {
  const response = await request('/prts-omni/v1/sessions/s-alpha/message', {
    method: 'POST',
    body: { text: '你好' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.senderAgentId, 's-alpha');
});

test('POST /sessions/:id/message 的 text 为空白返回 400', async () => {
  const response = await request('/prts-omni/v1/sessions/s-alpha/message', { method: 'POST', body: { text: '   ' } });
  assert.equal(response.status, 400);
});

test('POST /sessions/:id/interrupt', async () => {
  const response = await request('/prts-omni/v1/sessions/s-alpha/interrupt', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.json.interrupted, true);
});

test('POST /sessions 创建会话', async () => {
  const response = await request('/prts-omni/v1/sessions', { method: 'POST', body: { title: 'T' } });
  assert.equal(response.status, 200);
  assert.equal(response.json.created, true);
  assert.equal(response.json.title, 'T');
});

test('工具路由默认 403，开启后才可用', async () => {
  const off = await request('/prts-omni/v1/tools');
  assert.equal(off.status, 403);
  const offExec = await request('/prts-omni/v1/tools/bash', { method: 'POST', body: {} });
  assert.equal(offExec.status, 403);
});

test('请求体超过 64 KiB 返回 413', async () => {
  const response = await request('/prts-omni/v1/sessions/s-alpha/message', {
    method: 'POST',
    body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(response.status, 413);
});

test('非 JSON 对象请求体返回 400', async () => {
  const response = await request('/prts-omni/v1/sessions/s-alpha/message', { method: 'POST', body: '[1,2,3]' });
  assert.equal(response.status, 400);
});

test('未知路由 404、方法不匹配 405', async () => {
  assert.equal((await request('/prts-omni/v1/nope')).status, 404);
  assert.equal((await request('/prts-omni/v1/sessions', { method: 'DELETE' })).status, 405);
});

test('带 Origin 的跨站请求被拒绝', async () => {
  const response = await request('/prts-omni/v1/sessions', { headers: { origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
});

test('服务缺失时返回 503 而不是 500', async () => {
  // agents 服务整体缺失：service() 抛的错必须带 status=503
  const broken = { get: (key) => (key === 'sessions' ? ctx.get('sessions') : undefined) };
  const brokenBridge = createBridge({
    ctx: broken,
    config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: false, maxSessions: 50 },
    token,
    heartbeatMs: 2000,
    eventPollMs: 10_000,
  });
  const endpoint = await brokenBridge.start();
  try {
    const response = await request(`http://${endpoint}/prts-omni/v1/sessions/s-alpha/message`, {
      method: 'POST',
      body: { text: 'hi' },
    });
    assert.equal(response.status, 503);
    // 服务仍然活着
    const health = await request(`http://${endpoint}/prts-omni/v1/health`, { token: null });
    assert.equal(health.status, 200);
  } finally {
    await brokenBridge.stop();
  }
});

test('handler 抛错时返回 500 且服务不崩', async () => {
  // 制造一个会让 handler 抛普通错（无 status）的 ctx
  const broken = {
    get: (key) => {
      if (key === 'sessions') {
        return {
          list: () => { throw new Error('boom'); },
          get: () => undefined,
          create: () => { throw new Error('boom'); },
        };
      }
      return undefined;
    },
  };
  const brokenBridge = createBridge({
    ctx: broken,
    config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: false, maxSessions: 50 },
    token,
    heartbeatMs: 2000,
    eventPollMs: 10_000,
  });
  const endpoint = await brokenBridge.start();
  try {
    const response = await request(`http://${endpoint}/prts-omni/v1/sessions`);
    assert.equal(response.status, 500);
    // 服务仍然活着
    const health = await request(`http://${endpoint}/prts-omni/v1/health`, { token: null });
    assert.equal(health.status, 200);
  } finally {
    await brokenBridge.stop();
  }
});

/**
 * 一个极简 WebSocket 测试客户端：用 node:net 手工做握手，
 * 帧的编解码直接复用被测模块自己的实现（避免引入第三方依赖）。
 *
 * 不用 `http.get` 的 upgrade 事件：Node 的 HTTP 客户端会把与 101 响应同段的
 * 后续字节吞掉，导致服务端紧随握手写出的 hello 帧丢失。真实 WS 客户端
 * （OkHttp / 浏览器 / ws）都是从同一条流继续解析的，没有这个问题。
 *
 * 握手阶段会校验服务端**回写**了 `sec-websocket-protocol`：按 WHATWG 规范，
 * 客户端发了非空协议列表而响应没回该头，连接必须失败。
 */
class TestWsClient {
  /**
   * @param {string} url ws://host:port/path
   * @param {string} token
   */
  static async connect(url, token) {
    const target = new URL(url);
    const crypto = await import('node:crypto');
    const net = await import('node:net');
    const key = crypto.randomBytes(16).toString('base64');
    const client = new TestWsClient();
    client.messages = [];
    client.waiters = [];
    client.closed = false;

    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: target.hostname, port: Number(target.port) });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('handshake timeout'));
      }, 3000);
      let handshake = '';
      const onConnect = () => {
        socket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
          + `host: ${target.host}\r\n`
          + 'connection: Upgrade\r\n'
          + 'upgrade: websocket\r\n'
          + `sec-websocket-key: ${key}\r\n`
          + 'sec-websocket-version: 13\r\n'
          + `sec-websocket-protocol: ${token}\r\n`
          + '\r\n',
        );
      };
      socket.on('connect', onConnect);
      const onHandshakeData = (chunk) => {
        handshake += chunk.toString('latin1');
        const boundary = handshake.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const statusLine = handshake.slice(0, handshake.indexOf('\r\n'));
        const status = Number(/^HTTP\/1\.\d (\d+)/u.exec(statusLine)?.[1] ?? 0);
        clearTimeout(timer);
        socket.removeListener('data', onHandshakeData);
        // 101 必须回写 sec-websocket-protocol，否则浏览器客户端按规范必须失败
        const headerBlock = handshake.slice(0, boundary).toLowerCase();
        if (status !== 101 || !headerBlock.includes(`sec-websocket-protocol: ${token.toLowerCase()}`)) {
          socket.destroy();
          reject(new Error(`upgrade rejected (status ${status}, echoed=${headerBlock.includes('sec-websocket-protocol:')})`));
          return;
        }
        client.socket = socket;
        socket.on('data', (later) => client.#onData(later));
        socket.on('close', () => { client.closed = true; });
        socket.on('error', () => { client.closed = true; });
        resolve(undefined);
        // 与 101 响应同段到达的字节已经是 WebSocket 帧了，必须交给帧解析器，
        // 否则服务端紧随握手写出的 hello 会被丢掉。
        const remainder = chunk.subarray(chunk.length - (handshake.length - boundary - 4));
        if (remainder.length > 0) client.#onData(remainder);
      };
      socket.on('data', onHandshakeData);
      socket.on('close', () => {
        clearTimeout(timer);
        reject(new Error('socket closed during handshake'));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return client;
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    const frames = new FrameParser({ maxFrameBytes: 8 * 1024 * 1024 }).push(chunk);
    for (const frame of frames) {
      if (frame.opcode !== OPCODE.TEXT) continue;
      const parsed = JSON.parse(frame.payload.toString('utf8'));
      this.messages.push(parsed);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(parsed)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(parsed);
        }
      }
    }
  }

  /**
   * @param {(message: any) => boolean} predicate
   * @param {number} [timeoutMs]
   */
  waitFor(predicate, timeoutMs = 4000) {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`waitFor timeout：已收到 ${JSON.stringify(this.messages).slice(0, 400)}`));
      }, timeoutMs);
    });
  }

  /** @param {Record<string, unknown>} payload */
  send(payload) {
    const mask = Buffer.from([1, 2, 3, 4]);
    const text = Buffer.from(JSON.stringify(payload));
    const masked = Buffer.from(text);
    unmask(masked, mask);
    this.socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]));
  }

  close() {
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8])));
      this.socket.destroy();
    } catch {
      /* 已关闭 */
    }
  }
}

/** ws:// 地址（base 是 http://）。 */
const wsUrl = (path) => `ws://${base.replace('http://', '')}${path}`;

test('WebSocket 升级：无令牌被拒，带令牌成功并收到 hello', async () => {
  await assert.rejects(() => TestWsClient.connect(wsUrl('/prts-omni/v1/stream'), 'x'.repeat(64)));

  const client = await TestWsClient.connect(wsUrl('/prts-omni/v1/stream'), token);
  const hello = await client.waitFor((message) => message.type === 'hello');
  assert.equal(hello.type, 'hello');
  assert.equal(hello.maxBacklog, 1000);
  assert.equal(hello.heartbeatMs, 2000);

  client.send({ type: 'subscribe', sessionIds: ['s-alpha'] });
  const subscribed = await client.waitFor((message) => message.type === 'subscribed');
  assert.deepEqual(subscribed.sessionIds, ['s-alpha']);

  // s-alpha 有 2 条事件，轮询会把它们推过来，并且带 msgSeq
  const first = await client.waitFor((message) => message.type === 'session/event');
  assert.equal(first.sessionId, 's-alpha');
  assert.equal(typeof first.msgSeq, 'number');
  const second = await client.waitFor((message) => message.type === 'session/event' && message.seq === 1);
  assert.equal(second.seq, 1);

  // ack 之后背压水位线下降
  client.send({ type: 'ack', seq: second.msgSeq });
  const client2 = client;
  await sleep(50);
  assert.equal(client2.closed, false);

  // ping/pong 控制消息
  client.send({ type: 'ping' });
  const pong = await client.waitFor((message) => message.type === 'pong');
  assert.equal(pong.type, 'pong');

  // 会话消失时服务端要明确告知，不能静默丢订阅
  bridge.dropSession('s-alpha');
  const gone = await client.waitFor((message) => message.type === 'session/gone');
  assert.equal(gone.sessionId, 's-alpha');

  client.close();
  await sleep(100);
});

test('WebSocket 升级：坏令牌返回 401', async () => {
  await assert.rejects(
    () => TestWsClient.connect(wsUrl('/prts-omni/v1/stream'), 'b'.repeat(64)),
    /upgrade rejected \(status 401/,
  );
});

test('WebSocket 升级：未知路径返回 404（不是裸 destroy）', async () => {
  await assert.rejects(
    () => TestWsClient.connect(wsUrl('/prts-omni/v1/nope'), token),
    /upgrade rejected \(status 404/,
  );
});

test('WebSocket 升级：ROUTE_PREFIX 之外的路径返回 404', async () => {
  await assert.rejects(
    () => TestWsClient.connect(wsUrl('/stream'), token),
    /upgrade rejected \(status 404/,
  );
});

test('WebSocket 升级：坏 URL 返回 400 而不是裸 destroy', async () => {
  const net = await import('node:net');
  const crypto = await import('node:crypto');
  const target = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, 3000);
    let raw = '';
    socket.on('connect', () => {
      socket.write(
        'GET http://[bad HTTP/1.1\r\n'
        + `host: ${target.host}\r\n`
        + 'connection: Upgrade\r\n'
        + 'upgrade: websocket\r\n'
        + `sec-websocket-key: ${crypto.randomBytes(16).toString('base64')}\r\n`
        + 'sec-websocket-version: 13\r\n'
        + `sec-websocket-protocol: ${token}\r\n`
        + '\r\n',
      );
    });
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const boundary = raw.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(Number(/^HTTP\/1\.\d (\d+)/u.exec(raw.slice(0, raw.indexOf('\r\n')))?.[1] ?? 0));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.equal(status, 400);
});

test('stats 与 dropSession 可用', async () => {
  const stats = bridge.stats();
  assert.equal(typeof stats.connections, 'number');
  assert.equal(typeof stats.subscriptions, 'number');
  bridge.dropSession('s-alpha');
  assert.doesNotThrow(() => bridge.dropSession('s-alpha'));
});

test('工具路由在 allowToolExecution=true 时可用，且 execute 收到 callId 与 signal', async () => {
  const toolCtx = fakeCtx({ agents: [{ id: 's-alpha', root: true }] });
  const enabled = createBridge({
    ctx: toolCtx,
    config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: true, maxSessions: 50 },
    token,
    heartbeatMs: 2000,
    eventPollMs: 10_000,
  });
  const endpoint = await enabled.start();
  try {
    const list = await request(`http://${endpoint}/prts-omni/v1/tools`);
    assert.equal(list.status, 200);
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.equal(list.json.tools[0].name, 'bash');

    const run = await request(`http://${endpoint}/prts-omni/v1/tools/bash`, {
      method: 'POST',
      body: { command: 'ls' },
    });
    assert.equal(run.status, 200);
    assert.equal(run.json.name, 'bash');
    assert.equal(run.json.result.ok, true);

    // Host 契约：ToolExecutionInput 必须带 callId 与 signal（signal 非可选）
    assert.equal(toolCtx.toolCalls.length, 1);
    const exec = toolCtx.toolCalls[0];
    assert.ok(typeof exec.callId === 'string' && exec.callId !== '');
    assert.ok(exec.signal && typeof exec.signal.throwIfAborted === 'function');
    assert.equal(exec.name, 'bash');
    assert.deepEqual(exec.arguments, { command: 'ls' });
  } finally {
    await enabled.stop();
  }
});

test('get 辅助可用（Node 内置 http 客户端冒烟）', async () => {
  await new Promise((resolve, reject) => {
    const target = new URL(base);
    get({
      host: target.hostname,
      port: Number(target.port),
      path: '/prts-omni/v1/health',
      agent: false,
    }, (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
});

test('stop 之后服务不再接受连接，且可以重新启动', async () => {
  const fresh = createBridge({
    ctx,
    config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: false, maxSessions: 50 },
    token,
    heartbeatMs: 2000,
    eventPollMs: 10_000,
  });
  const endpoint = await fresh.start();
  await fresh.stop();
  await assert.rejects(() => request(`http://${endpoint}/prts-omni/v1/health`));
  // 同一个 server 对象重新监听（Loader 重载场景）
  const again = await fresh.start();
  const health = await request(`http://${again}/prts-omni/v1/health`);
  assert.equal(health.status, 200);
  await fresh.stop();
});

test('stop() 之后不残留监听 handle（下一个事件循环 tick 后清空）', async () => {
  // beforeEach 起的那个桥接还在监听，所以只能比较「增量」：
  // 先数当前有几个监听 handle，起一个新桥接应当 +1，stop 之后应当回到原数。
  const countListeners = () => process.getActiveResourcesInfo().filter((kind) => kind === 'TCPServerWrap').length;
  const before = countListeners();
  const fresh = createBridge({
    ctx,
    config: { bindHost: '127.0.0.1', port: 0, allowToolExecution: false, maxSessions: 50 },
    token,
    heartbeatMs: 2000,
    eventPollMs: 10_000,
  });
  await fresh.start();
  assert.equal(countListeners(), before + 1, '启动后应多一个监听 handle');
  await fresh.stop();
  // 关键点：close() 现在会真的销毁 WS socket，server.close() 不再被挂住，
  // 不需要 2000ms 兜底 setTimeout。handle 在紧随的几个 tick 内释放。
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (countListeners() <= before) return;
  }
  assert.fail(`stop() 之后仍残留 TCPServerWrap（before=${before}, after=${countListeners()}）`);
});
