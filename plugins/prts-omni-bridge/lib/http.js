/**
 * 桥接的 HTTP 服务与 WebSocket 事件流。
 *
 * 安全边界（与 dsh-admin-channel 一致，缺一不可）：
 *   · 默认只绑 127.0.0.1；`bindHost=0.0.0.0` 必须同时 `allowLan=true`，否则拒绝启动；
 *   · 除 `/health` 与 `/auth/token`（仅限本机回环免令牌）外，所有路由都要 Bearer 令牌；
 *   · 令牌校验发生在**路由解析之前**：ROUTE_PREFIX 下任何未认证请求一律 401，
 *     不会先用 404/405 把路由表泄露给未认证客户端；
 *   · 令牌只从请求头取，恒定时间比较；**永不**出现在非回环响应体或 info 日志里；
 *   · 请求体上限 64 KiB（413）；
 *   · 每个 handler 内部异常都捕获并返回 500，绝不让服务崩掉；
 *   · 拒绝浏览器来源（带 Origin / Sec-Fetch-* 的跨站请求），防 DNS rebinding。
 *
 * @module prts-omni-bridge/lib/http
 */

import { createServer } from 'node:http';

import {
  createSession,
  describeSession,
  executeTool,
  getSession,
  interruptSession,
  listSessions,
  listTools,
  readEvents,
  readMessages,
  sendMessage,
  sessionTitleService,
} from './sessions.js?v=1';
import { CLOSE_CODE, WsConnection, computeAcceptKey } from './ws.js?v=1';

/** 路由前缀。 */
export const ROUTE_PREFIX = '/prts-omni/v1';

/** 请求体上限：64 KiB。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 事件轮询间隔。 */
const EVENT_POLL_MS = 400;

/** 单个 WS 连接可订阅的会话数上限。 */
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 64;

/**
 * 写一个 JSON 响应。已经写过就只销毁，绝不重复 writeHead。
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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
  return true;
}

/**
 * 归一化后判断一个地址是否本机回环。
 *
 * 以前是四个字面量硬编码，其中 `'::ffff:::1'` 是**永不命中**的死字符串
 * （IPv4-mapped 的正确写法只有一个冒号分隔：`::ffff:127.0.0.1`）。现在剥掉
 * `::ffff:` 前缀后统一判定。
 *
 * 接受：`127.0.0.1`、`::1`、`7f00:1`、`7f00:0:1`、整个 `127.x.y.z` 段，
 * 以及它们各自加上 `::ffff:` 前缀的 IPv4-mapped 形态。
 *
 * @param {string} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  const raw = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (raw === '') return false;
  // IPv4-mapped IPv6（::ffff:127.0.0.1）剥掉前缀后按 IPv4 判定
  const bare = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  // IPv6 回环：::1 的完整/压缩写法
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  // 127.0.0.0/8 整个段都算本机回环
  if (/^127(?:\.\d{1,3}){3}$/u.test(bare)) return true;
  // ::1 的十六进制展开写法 7f00:1 / 7f00:0:1
  return bare === '7f00:1' || bare === '7f00:0:1';
}

/**
 * 是否本机回环来源。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress ?? '');
}

/**
 * 是否浏览器发起的跨站请求（带 Origin / Sec-Fetch-*）。一律拒绝。
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
 * 读取 JSON 请求体，带 64 KiB 上限。
 *
 * 超限时**先**把 413 响应写回去、等它 flush 完再销毁连接，这样客户端拿到的是
 * 一个正常的 413，而不是一条 socket 错误。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<Record<string, unknown>>}
 */
function readJsonBody(req, res) {
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
        sendJson(res, 413, { error: '请求体过大（上限 64 KiB）' });
        // 响应交给操作系统之后再拆连接，避免客户端只看到 socket 错误
        res.on('finish', () => req.destroy());
        finish(Object.assign(new Error('请求体过大（上限 64 KiB）'), { status: 413, responded: true }));
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
 * 路径是否存在（任意方法）。用于把「路由不存在」和「方法不对」区分成 404 / 405。
 * @param {string} pathname
 * @param {Array<{ segments: string[] }>} routes
 * @returns {boolean}
 */
function pathExists(pathname, routes) {
  const parts = pathname.split('/').filter((part) => part !== '');
  return routes.some((route) => {
    if (route.segments.length !== parts.length) return false;
    return route.segments.every((pattern, index) => pattern.startsWith(':') || pattern === parts[index]);
  });
}

/**
 * 路径里是否有无法解码的段。
 *
 * `decodeURIComponent` 对 `%ZZ`、`%E0%A4%A` 这类坏转义会抛 `URIError`。
 * 以前这个异常从 matchRoute 一路冒泡到 handler 之外，变成 500。
 * @param {string} pathname
 * @returns {boolean}
 */
function hasMalformedEscape(pathname) {
  return pathname.split('/').some((segment) => {
    if (!segment.includes('%')) return false;
    try {
      decodeURIComponent(segment);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * 安全 URL 解码：坏转义返回 undefined 表示「这一段不参与匹配」。
 * @param {string} value
 * @returns {string | undefined}
 */
function safeDecodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * 极简路由器：支持 `:name` 段。返回匹配到的参数与路由定义。
 *
 * 参数段解码失败（坏百分号转义）时该路由视为不匹配，绝不抛异常。
 *
 * @param {string} pathname
 * @param {string} method
 * @param {Array<{ method: string, segments: string[], def: any }>} routes
 * @returns {{ params: Record<string, string>, def: any } | undefined}
 */
function matchRoute(pathname, method, routes) {
  const parts = pathname.split('/').filter((part) => part !== '');
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== parts.length) continue;
    /** @type {Record<string, string>} */
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const pattern = route.segments[i];
      if (pattern.startsWith(':')) {
        const decoded = safeDecodeSegment(parts[i]);
        if (decoded === undefined) {
          ok = false;
          break;
        }
        params[pattern.slice(1)] = decoded;
      } else if (pattern !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { params, def: route.def };
  }
  return undefined;
}

/**
 * 把路径编译成段数组。
 * @param {string} path
 * @returns {string[]}
 */
function segmentsOf(path) {
  return path.split('/').filter((part) => part !== '');
}

/**
 * 从请求里取令牌：`Authorization: Bearer <t>` 或 `X-PRTS-Token: <t>`。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function tokenFromRequest(req) {
  const headers = req.headers ?? {};
  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization !== '') {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    if (match !== null) return match[1].trim();
  }
  const custom = headers['x-prts-token'];
  if (typeof custom === 'string' && custom !== '') return custom.trim();
  return '';
}

/**
 * 从 WebSocket 升级请求里取令牌。浏览器无法给 WS 设自定义头，所以额外支持
 * `Sec-WebSocket-Protocol` 首值与 `?token=` 查询参数。
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @returns {string}
 */
export function tokenFromUpgrade(req, url) {
  const fromHeaders = tokenFromRequest(req);
  if (fromHeaders !== '') return fromHeaders;
  const protocol = req.headers['sec-websocket-protocol'];
  if (typeof protocol === 'string' && protocol !== '') {
    const first = protocol.split(',')[0].trim();
    if (first !== '') return first;
  }
  const query = url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? '';
  return query.trim();
}

/**
 * 恒定时间比较（与 lib/token.js 的实现保持一致，避免跨模块循环依赖）。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function tokensEqual(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** 升级拒绝响应的原因短语（写错会让客户端看到自相矛盾的状态行）。 */
const UPGRADE_REASON_PHRASES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
};

/**
 * 拒绝一次 WebSocket 升级：先写响应、等它 flush 完再结束 socket。
 * 直接 destroy 会让客户端只看到 ECONNRESET，拿不到状态码。
 * @param {import('node:net').Socket} socket
 * @param {number} status
 */
function rejectUpgrade(socket, status) {
  const phrase = UPGRADE_REASON_PHRASES[/** @type {keyof typeof UPGRADE_REASON_PHRASES} */ (status)] ?? 'Bad Request';
  try {
    socket.write(`HTTP/1.1 ${status} ${phrase}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.end();
  } catch {
    /* 对端可能已经消失 */
  }
}

/**
 * 解析 `?limit=`。
 *
 * 以前是 `Number(url.searchParams.get('limit') ?? config.maxSessions)`：
 * `?limit=`（空串）算成 0、`?limit=abc` 算成 NaN，两者在 `listSessions` 里都被
 * 当成「不限制」，于是 `maxSessions` 上限被绕过，一次返回全部会话。
 *
 * 现在统一在路由层收敛：缺省或非法值一律回落到 `max`，正值夹到 `[1, max]`。
 *
 * @param {string | null} raw
 * @param {number} max
 * @returns {number}
 */
function parseLimitParam(raw, max) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : Number.MAX_SAFE_INTEGER;
  const value = Number(raw ?? '');
  if (!Number.isFinite(value) || value <= 0) return cap;
  return Math.min(cap, Math.floor(value));
}

/**
 * 创建桥接服务。
 *
 * @param {{
 *   ctx: any,
 *   config: { bindHost: string, port: number, allowToolExecution: boolean, maxSessions: number },
 *   token: string,
 *   logger?: { info?: (t: string) => void, warn?: (t: string) => void, error?: (t: string) => void },
 *   heartbeatMs?: number,
 *   eventPollMs?: number,
 * }} options
 * @returns {{
 *   server: import('node:http').Server,
 *   start: () => Promise<string>,
 *   stop: () => Promise<void>,
 *   stats: () => Record<string, unknown>,
 *   dropSession: (id: string) => void,
 * }}
 */
export function createBridge(options) {
  const { ctx, config, token, logger } = options;
  const heartbeatMs = options.heartbeatMs ?? 2000;
  const eventPollMs = options.eventPollMs ?? EVENT_POLL_MS;

  const log = (level, text) => {
    try {
      logger?.[level]?.(text);
    } catch {
      /* 日志失败不影响服务 */
    }
  };

  /** @type {Set<WsConnection>} */
  const connections = new Set();
  /** sessionId → 订阅它的连接集合。 */
  const subscriptions = new Map();
  /** @type {NodeJS.Timeout | undefined} */
  let poller = undefined;
  /** 已推送的事件条数（诊断用）。 */
  let pushedEvents = 0;

  /**
   * 某个会话消失时清掉它的订阅，并告知还挂在上面的连接。
   * @param {string} sessionId
   */
  const dropSession = (sessionId) => {
    const set = subscriptions.get(sessionId);
    if (set === undefined) return;
    for (const connection of set) {
      connection.subscribed?.delete(sessionId);
      // 明确告知客户端，不要让它以为还在订阅一个已经不存在的会话
      connection.sendJson({ type: 'session/gone', sessionId });
    }
    subscriptions.delete(sessionId);
  };

  // ── 路由表 ────────────────────────────────────────────────────────────────
  /** @type {Array<{ method: string, path: string, segments: string[], def: any }>} */
  const routes = [];

  /**
   * @param {string} method
   * @param {string} path
   * @param {{
   *   loopbackExempt?: boolean,
   *   requiresToolExecution?: boolean,
   *   handler: (params: Record<string, string>, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => unknown,
   * }} def
   */
  const route = (method, path, def) => {
    routes.push({ method, path, segments: segmentsOf(path), def });
  };

  const toolRoutesEnabled = () => config.allowToolExecution === true;

  route('GET', `${ROUTE_PREFIX}/health`, {
    loopbackExempt: true,
    handler: () => ({
      ok: true,
      service: 'prts-omni-bridge',
      version: 1,
      connections: connections.size,
      subscriptions: subscriptions.size,
      toolExecutionEnabled: toolRoutesEnabled(),
      lan: config.bindHost === '0.0.0.0' || config.bindHost === '::',
    }),
  });

  route('GET', `${ROUTE_PREFIX}/auth/token`, {
    loopbackExempt: true,
    handler: () => ({ token, createdAt: Date.now() }),
  });

  route('GET', `${ROUTE_PREFIX}/sessions`, {
    handler: (_params, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      return listSessions(ctx, { limit: parseLimitParam(url.searchParams.get('limit'), config.maxSessions) });
    },
  });

  route('POST', `${ROUTE_PREFIX}/sessions`, {
    handler: async (_params, req, res) => {
      const body = await readJsonBody(req, res);
      return createSession(ctx, body);
    },
  });

  route('GET', `${ROUTE_PREFIX}/sessions/:id`, {
    handler: (params) => {
      const session = getSession(ctx, params.id);
      if (session === undefined) {
        const error = /** @type {any} */ (new Error(`会话 "${params.id}" 不存在`));
        error.status = 404;
        throw error;
      }
      return describeSession(session, sessionTitleService(ctx));
    },
  });

  route('GET', `${ROUTE_PREFIX}/sessions/:id/events`, {
    handler: (params, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '200');
      return readEvents(ctx, params.id, { since, limit });
    },
  });

  route('GET', `${ROUTE_PREFIX}/sessions/:id/messages`, {
    handler: (params, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return readMessages(ctx, params.id, { limit });
    },
  });

  route('POST', `${ROUTE_PREFIX}/sessions/:id/message`, {
    handler: async (params, req, res) => {
      const body = await readJsonBody(req, res);
      const text = typeof body.text === 'string' ? body.text : '';
      if (text.trim() === '') {
        const error = /** @type {any} */ (new Error('text 必填且不能为空白'));
        error.status = 400;
        throw error;
      }
      if (text.length > 20_000) {
        const error = /** @type {any} */ (new Error('text 过长（上限 20000 字符）'));
        error.status = 400;
        throw error;
      }
      let interrupted;
      if (body.interrupt === true) interrupted = interruptSession(ctx, params.id);
      const result = await sendMessage(ctx, params.id, text);
      return { ...result, ...(interrupted === undefined ? {} : { interrupted }) };
    },
  });

  route('POST', `${ROUTE_PREFIX}/sessions/:id/interrupt`, {
    handler: (params) => interruptSession(ctx, params.id),
  });

  route('GET', `${ROUTE_PREFIX}/tools`, {
    requiresToolExecution: true,
    handler: () => ({ tools: listTools(ctx) }),
  });

  route('POST', `${ROUTE_PREFIX}/tools/:name`, {
    requiresToolExecution: true,
    handler: async (params, req, res) => {
      const body = await readJsonBody(req, res);
      return { name: params.name, result: await executeTool(ctx, params.name, body) };
    },
  });

  /**
   * 免令牌路径集合（仅本机回环可用）。
   *
   * 从路由表派生而不是手写第二份清单，避免以后加了 `loopbackExempt` 路由却忘了
   * 同步这里，导致该路由意外要求令牌。
   */
  const loopbackExemptPaths = new Set(
    routes.filter((entry) => entry.def.loopbackExempt === true).map((entry) => entry.path),
  );

  // ── WebSocket 事件流 ─────────────────────────────────────────────────────
  /**
   * 处理客户端发来的控制消息。
   * @param {string} text
   * @param {WsConnection} connection
   */
  const handleWsMessage = (text, connection) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      connection.sendJson({ type: 'error', error: '消息不是合法 JSON' });
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      connection.sendJson({ type: 'error', error: '消息必须是 JSON 对象' });
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    const subscribed = connection.subscribed ?? new Map();
    connection.subscribed = subscribed;
    switch (type) {
      case 'subscribe': {
        const ids = Array.isArray(message.sessionIds) ? message.sessionIds : [];
        for (const raw of ids) {
          if (typeof raw !== 'string' || raw === '') continue;
          if (subscribed.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
            connection.sendJson({ type: 'error', error: `单连接最多订阅 ${MAX_SUBSCRIPTIONS_PER_CONNECTION} 个会话` });
            break;
          }
          let set = subscriptions.get(raw);
          if (set === undefined) {
            set = new Set();
            subscriptions.set(raw, set);
          }
          set.add(connection);
          subscribed.set(raw, 0);
        }
        connection.sendJson({ type: 'subscribed', sessionIds: [...subscribed.keys()] });
        break;
      }
      case 'unsubscribe': {
        const ids = Array.isArray(message.sessionIds) ? message.sessionIds : [];
        for (const raw of ids) {
          if (typeof raw !== 'string') continue;
          subscribed.delete(raw);
          const set = subscriptions.get(raw);
          if (set !== undefined) {
            set.delete(connection);
            if (set.size === 0) subscriptions.delete(raw);
          }
        }
        connection.sendJson({ type: 'unsubscribed', sessionIds: [...subscribed.keys()] });
        break;
      }
      case 'ping':
        connection.sendJson({ type: 'pong', time: Date.now() });
        break;
      case 'ack':
        connection.ack(Number(message.seq));
        break;
      default:
        connection.sendJson({ type: 'error', error: `未知消息类型 "${type}"` });
        break;
    }
  };

  /**
   * 轮询订阅会话的新事件并推送。
   */
  const pollEvents = () => {
    if (connections.size === 0) return;
    for (const [sessionId, set] of [...subscriptions]) {
      if (set.size === 0) {
        subscriptions.delete(sessionId);
        continue;
      }
      let session;
      try {
        session = ctx.get('sessions')?.get?.(sessionId);
      } catch {
        session = undefined;
      }
      if (session === undefined || typeof session.snapshotEvents !== 'function') continue;
      for (const connection of [...set]) {
        const cursor = connection.subscribed?.get(sessionId) ?? 0;
        let events;
        try {
          events = [...session.snapshotEvents(cursor)];
        } catch {
          continue;
        }
        for (const event of events) {
          if (connection.isClosed) break;
          const eventSeq = Number(event?.seq ?? 0);
          // sendTracked 会分配 msgSeq 并计入背压；客户端回 ack 后水位线下降
          const msgSeq = connection.sendTracked({ type: 'session/event', sessionId, seq: eventSeq, event });
          if (msgSeq === null) break;
          pushedEvents += 1;
          connection.subscribed?.set(sessionId, eventSeq + 1);
        }
      }
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        sendJson(res, 400, { error: '非法请求路径' });
        return;
      }
      const pathname = url.pathname;
      if (!pathname.startsWith(`${ROUTE_PREFIX}/`) && pathname !== ROUTE_PREFIX) {
        sendJson(res, 404, { error: '路由不存在' });
        return;
      }
      // 坏百分号转义（%ZZ / %E0%A4%A）：decodeURIComponent 会抛 URIError，
      // 以前一路冒泡成 500。这里在解码之前就拦掉，按 400 处理。
      if (hasMalformedEscape(pathname)) {
        sendJson(res, 400, { error: '请求路径包含非法的百分号转义' });
        return;
      }

      const loopback = isLoopbackRequest(req);
      // ── 令牌校验（在路由解析**之前**）────────────────────────────────
      // 以前 404/405/403 都在令牌校验之前返回，未认证的客户端可以靠状态码
      // 差异枚举出整张路由表。现在 ROUTE_PREFIX 下任何未认证请求统一 401，
      // 只有「免令牌路径且来自本机回环」才放过。
      if (!(loopbackExemptPaths.has(pathname) && loopback)) {
        const presented = tokenFromRequest(req);
        if (presented === '' || !tokensEqual(presented, token)) {
          sendJson(res, 401, { error: '缺少或错误的配对令牌' });
          return;
        }
      }

      const matched = matchRoute(pathname, req.method ?? 'GET', routes);
      if (matched === undefined) {
        // 路径存在但方法不对 → 405，便于客户端区分「没有这个接口」和「方法用错」
        const exists = pathExists(pathname, routes);
        sendJson(res, exists ? 405 : 404, { error: exists ? '方法不被允许' : '路由不存在' });
        return;
      }

      const def = matched.def;
      if (isBrowserRequest(req)) {
        sendJson(res, 403, { error: 'cross-origin request rejected' });
        return;
      }
      if (def.requiresToolExecution === true && !toolRoutesEnabled()) {
        sendJson(res, 403, { error: '工具执行未开启（config.allowToolExecution=false）' });
        return;
      }

      try {
        const payload = await def.handler(matched.params, req, res);
        if (!res.writableEnded) sendJson(res, 200, payload ?? {});
      } catch (error) {
        // body 超限时 readJsonBody 已经写过 413 了，不要重复写
        if (res.writableEnded) return;
        const status = Number(/** @type {any} */ (error)?.status) || 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) log('warn', `prts-omni-bridge: ${req.method} ${pathname} 失败：${message}`);
        sendJson(res, status, { error: message });
      }
    })().catch((error) => {
      log('error', `prts-omni-bridge: 请求处理崩溃：${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, { error: 'prts-omni-bridge 内部错误' });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      // 坏 URL 也走 rejectUpgrade：裸 destroy 只会让客户端看到 ECONNRESET
      rejectUpgrade(socket, 400);
      return;
    }
    if (url.pathname !== `${ROUTE_PREFIX}/stream`) {
      rejectUpgrade(socket, 404);
      return;
    }
    const presented = tokenFromUpgrade(req, url);
    // 升级没有「免令牌」路径：流里全是会话内容，一律要令牌
    if (presented === '' || !tokensEqual(presented, token)) {
      log('warn', `prts-omni-bridge: WebSocket 升级被拒绝（来源 ${socket.remoteAddress ?? '?'}）`);
      rejectUpgrade(socket, 401);
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
      rejectUpgrade(socket, 400);
      return;
    }
    // 客户端用 Sec-WebSocket-Protocol 首值传令牌时，101 必须把它回写回去。
    // 按 WHATWG 规范，客户端发了非空协议列表而响应没回该头，连接必须失败——
    // 不回写就等于 README 里写的浏览器路径完全不可用。
    const clientProtocols = req.headers['sec-websocket-protocol'];
    const protocol = typeof clientProtocols === 'string' && clientProtocols.trim() !== ''
      ? clientProtocols.split(',')[0].trim()
      : undefined;
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n'
      + `sec-websocket-accept: ${computeAcceptKey(key)}\r\n`
      + (protocol === undefined || protocol === '' ? '' : `sec-websocket-protocol: ${protocol}\r\n`)
      + '\r\n',
    );

    const connection = new WsConnection(socket, {
      heartbeatMs,
      onMessage: handleWsMessage,
      onClose: (closed) => {
        connections.delete(closed);
        const subscribed = closed.subscribed;
        if (subscribed !== undefined) {
          for (const sessionId of subscribed.keys()) {
            const set = subscriptions.get(sessionId);
            if (set !== undefined) {
              set.delete(closed);
              if (set.size === 0) subscriptions.delete(sessionId);
            }
          }
        }
      },
    });
    connections.add(connection);
    connection.startHeartbeat();
    connection.sendJson({ type: 'hello', heartbeatMs, maxBacklog: connection.maxBacklog });
    // 客户端可能在握手后立刻带数据，补喂一次
    if (head !== undefined && head.length > 0) socket.emit('data', head);

    // 查询参数里带的会话直接订阅
    const wanted = url.searchParams.getAll('session').concat(url.searchParams.getAll('sessionId'));
    if (wanted.length > 0) handleWsMessage(JSON.stringify({ type: 'subscribe', sessionIds: wanted }), connection);
  });

  server.on('error', (error) => {
    log('error', `prts-omni-bridge: server 错误：${error instanceof Error ? error.message : String(error)}`);
  });

  return {
    server,
    /** @returns {Promise<string>} 实际监听地址 */
    start() {
      return new Promise((resolve, reject) => {
        const onError = (/** @type {Error} */ error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : config.port;
          const host = typeof address === 'object' && address !== null ? address.address : config.bindHost;
          poller = setInterval(pollEvents, eventPollMs);
          if (typeof poller.unref === 'function') poller.unref();
          resolve(`${host}:${port}`);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.port, config.bindHost);
      });
    },
    /** @returns {Promise<void>} */
    async stop() {
      if (poller !== undefined) {
        clearInterval(poller);
        poller = undefined;
      }
      for (const connection of [...connections]) {
        try {
          connection.close(CLOSE_CODE.GOING_AWAY, 'bridge shutting down');
        } catch {
          /* 忽略 */
        }
      }
      connections.clear();
      subscriptions.clear();
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve(undefined);
        };
        server.close(() => finish());
        // 兜底：close 在某些平台会因残留连接挂住
        setTimeout(finish, 2000).unref();
      });
    },
    stats: () => ({
      connections: connections.size,
      subscriptions: subscriptions.size,
      pushedEvents,
    }),
    dropSession,
  };
}
