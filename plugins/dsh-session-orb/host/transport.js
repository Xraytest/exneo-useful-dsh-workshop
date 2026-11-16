/**
 * Two transports, deliberately separate.
 *
 * 1. A private HTTP server on 127.0.0.1:<ephemeral> that only the native helper
 *    talks to. It carries the state stream (SSE), the liveness ping and the
 *    click/drag events. Keeping it off the DSH web server means no part of the
 *    native protocol is reachable through the Web UI, and it lets us own the
 *    timeouts an endless SSE response needs.
 *
 * 2. Routes on the DSH `webServer` for the renderer: the settings page reads and
 *    writes state there. Every one of them demands the `x-dsh-orb: 1` header.
 *    That works because `forwardWebRequest` (main.js:15877-15908) deletes only
 *    host/origin/cookie/sec-fetch-site and forwards every other header, so a
 *    custom header survives the `dsh-app://app` hop, while a plain navigation or
 *    a cross-site form post cannot produce it.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 15_000;
/** Header every renderer request must carry. */
const CSRF_HEADER = 'x-dsh-orb';
/** Header the native helper must carry. */
const TOKEN_HEADER = 'x-orb-token';

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** @returns {Promise<any>} */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve({});
      return;
    }
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    const fail = (error) => {
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      reject(error);
    };
    req.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY) {
        fail(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error?.message ?? error)}`));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Private channel used by the native helper. */
export class OrbBridge {
  /** @param {{log: import('./store.js').Log, onEvent: (event: object) => void, getState: () => object, token: string}} options */
  constructor({ log, onEvent, getState, token }) {
    this.log = log;
    this.onEvent = onEvent;
    this.getState = getState;
    this.token = token;
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    /** @type {import('node:http').Server | null} */
    this.server = null;
    this.port = 0;
    /** @type {NodeJS.Timeout | null} */
    this.heartbeat = null;
    this.requests = 0;
    this.lastEventAt = 0;
    this.lastEventType = null;
  }

  get origin() {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  async listen() {
    const server = createServer((req, res) => {
      this.requests += 1;
      this.handle(req, res).catch((error) => {
        this.log.warn(`orb bridge: ${String(error?.message ?? error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        else res.end();
      });
    });
    // An SSE response outlives any sensible request timeout; never cut it.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 120_000;
    server.setTimeout(0);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(undefined);
      });
    });
    const address = server.address();
    this.port = address !== null && typeof address === 'object' ? address.port : 0;
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.writeRaw(client, ': hb\n\n');
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.log.info(`orb bridge: listening on ${this.origin}`);
    return this.port;
  }

  /** @param {import('node:http').ServerResponse} res @param {string} text */
  writeRaw(res, text) {
    try {
      res.write(text);
    } catch {
      this.clients.delete(res);
    }
  }

  /** @param {object} state */
  pushState(state) {
    if (this.clients.size === 0) return;
    const frame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of this.clients) this.writeRaw(client, frame);
  }

  /** @param {import('node:http').IncomingMessage} req */
  authorized(req) {
    const header = req.headers[TOKEN_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && constantTimeEqual(value, this.token);
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', this.origin);
    const path = url.pathname;
    if (!this.authorized(req)) {
      sendJson(res, 403, { ok: false, error: 'orb token required' });
      return;
    }
    if (path === '/orb/stream' || path === '/orb/config') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Sniffing protection for old Chromium hosts is irrelevant here, but the
      // explicit no-transform hint keeps proxies from buffering the stream.
      res.write(': connected\n\n');
      this.clients.add(res);
      this.writeRaw(res, `event: hello\ndata: ${JSON.stringify(this.getState())}\n\n`);
      // Pull the native side back into sync immediately after a reconnect.
      res.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
      const drop = () => {
        this.clients.delete(res);
      };
      req.on('close', drop);
      req.on('aborted', drop);
      res.on('error', drop);
      return;
    }
    if (path === '/orb/ping') {
      sendJson(res, 200, { ok: true, state: this.getState() });
      return;
    }
    if (path === '/orb/event') {
      const body = await readJsonBody(req);
      this.lastEventAt = Date.now();
      this.lastEventType = typeof body?.type === 'string' ? body.type : 'unknown';
      try {
        this.onEvent(body ?? {});
      } catch (error) {
        this.log.warn(`orb bridge: event handler failed: ${String(error?.message ?? error)}`);
      }
      sendJson(res, 200, { ok: true, seen: this.lastEventType });
      return;
    }
    if (path === '/orb/shutdown') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'unknown orb route' });
  }

  status() {
    return {
      origin: this.origin,
      clients: this.clients.size,
      requests: this.requests,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
    };
  }

  dispose() {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // Already closed.
      }
    }
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * Renderer-facing routes on the DSH web server.
 *
 * @param {object} options
 * @param {import('./hub.js').Hub} options.hub
 * @param {import('./store.js').Store} options.store
 * @param {import('./native.js').NativeOrb} options.native
 * @param {import('./store.js').Log} options.log
 * @param {() => object} options.runtimeStatus
 * @param {() => ({origin: string, token: string, lang: string} | null)} options.nativeOptions
 */
export function createRendererRoutes({ hub, store, native, log, runtimeStatus, nativeOptions, VERSION, PLUGIN_ID }) {
  /** @type {Set<() => void>} */
  const disposers = [];

  /**
   * @param {'GET'|'POST'} method
   * @param {string} path
   * @param {(input: {req, res, body}) => Promise<any>} handler
   */
  function register(method, path, handler) {
    return {
      method,
      path,
      handler: async (req, res) => {
        const header = req.headers[CSRF_HEADER];
        if ((Array.isArray(header) ? header[0] : header) !== '1') {
          // Reads are cheap but not harmless: they expose session ids and titles.
          sendJson(res, 403, { ok: false, error: `missing ${CSRF_HEADER}: 1 header` });
          return;
        }
        if ((req.method ?? 'GET').toUpperCase() !== method) {
          sendJson(res, 405, { ok: false, error: `use ${method}` });
          return;
        }
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        try {
          const result = await handler({ req, res, body });
          if (result !== undefined && !res.headersSent) sendJson(res, 200, result ?? { ok: true });
        } catch (error) {
          log.warn(`orb route ${path}: ${String(error?.message ?? error)}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    };
  }

  /** @type {{method: string, path: string, handler: Function}[]} */
  const routes = [
    register('GET', '/session-orb/selfcheck', async () => ({
      ok: true,
      plugin: PLUGIN_ID,
      version: VERSION,
      now: Date.now(),
      native: native.status(),
      hub: hub.summary(),
      runtime: runtimeStatus(),
      store: { dir: store.dir, file: store.file, loadError: store.loadError, titles: store.titles.size },
      log: log.tail(12),
    })),
    register('GET', '/session-orb/state', async () => ({
      ok: true,
      version: VERSION,
      settings: store.settings,
      position: store.position,
      lang: hub.lang,
      labels: hub.labels(),
      notice: hub.snapshot().notice,
      summary: hub.summary(),
      native: native.status(),
      // The renderer settings page shows bridge health; a hardcoded null made
      // it claim "no bridge" while the helper was connected over it.
      bridge: runtimeStatus().bridge ?? null,
    })),
    register('POST', '/session-orb/settings', async ({ body }) => {
      const patch = body?.patch ?? body ?? {};
      const settings = store.patchSettings(patch);
      hub.armNoticeTimer();
      hub.bump();
      log.info(`orb: settings patched ${JSON.stringify(Object.keys(patch))}`);
      return { ok: true, settings };
    }),
    register('POST', '/session-orb/position', async ({ body }) => {
      const position = store.setPosition({ x: body?.x, y: body?.y });
      hub.bump();
      return { ok: true, position };
    }),
    register('POST', '/session-orb/titles', async ({ body }) => {
      const changed = store.mergeTitles(body?.titles ?? {});
      if (changed > 0) hub.bump();
      return { ok: true, changed };
    }),
    register('POST', '/session-orb/report', async ({ body }) => {
      const renderer = hub.markRenderer({
        visible: typeof body?.visible === 'boolean' ? body.visible : null,
        lang: typeof body?.lang === 'string' ? body.lang : null,
        url: typeof body?.url === 'string' ? body.url : null,
        box: body?.box ?? null,
      });
      if (typeof body?.note === 'string' && body.note !== '') log.info(`renderer: ${body.note.slice(0, 500)}`);
      return { ok: true, renderer };
    }),
    register('GET', '/session-orb/commands', async () => ({ ok: true, commands: hub.drainCommands() })),
    register('POST', '/session-orb/action', async ({ body }) => {
      const action = typeof body?.action === 'string' ? body.action : '';
      if (action === 'reset-position') {
        store.setPosition(null);
        hub.bump();
        return { ok: true, position: null };
      }
      if (action === 'test-notice') {
        hub.confirm({
          id: `test-${Date.now().toString(36)}`,
          title: typeof body?.title === 'string' && body.title !== '' ? body.title : hub.labels().kicker,
        });
        return { ok: true, queue: hub.summary().queue };
      }
      if (action === 'dismiss') {
        return { ok: true, dismissed: hub.advance('renderer') };
      }
      if (action === 'revive-native') {
        // `runtimeStatus().spawn` is the *renderer-facing* view of the spawn
        // options and deliberately hides the bridge token. Reviving from it
        // handed the helper `--token undefined`: the ball came up, could not
        // authenticate, and died a minute later, taking the orb with it.
        const options = nativeOptions();
        if (options === null) {
          return { ok: false, error: 'the orb bridge has not been started yet', native: native.status() };
        }
        const status = await native.revive(options);
        return { ok: status.state !== 'failed', native: status };
      }
      if (action === 'open-latest') {
        const queue = hub.summary().queue;
        if (queue.length === 0) return { ok: false, error: 'no pending notice' };
        hub.pushCommand('open-session', { sessionId: queue[0].sessionId });
        hub.advance('renderer');
        return { ok: true, sessionId: queue[0].sessionId };
      }
      return { ok: false, error: `unknown action: ${action}` };
    }),
  ];

  return {
    routes,
    /**
     * @param {{register: (route: any) => () => void}} webServer
     */
    mount(webServer, { onDuplicate } = {}) {
      for (const route of routes) {
        const wire = () => {
          const dispose = webServer.register({ kind: 'exact', path: route.path, handler: route.handler });
          disposers.push(typeof dispose === 'function' ? dispose : () => {});
        };
        try {
          wire();
        } catch (error) {
          // A stale copy of this plugin can still hold the path; the retry loop
          // in index.js owns the timing, so just report and let it retry.
          onDuplicate?.(route.path, error);
          throw error;
        }
      }
      return disposers.length;
    },
    unmount() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // Ignore: the server may already be gone.
        }
      }
    },
    paths: routes.map((route) => route.path),
  };
}

export { CSRF_HEADER, TOKEN_HEADER };
