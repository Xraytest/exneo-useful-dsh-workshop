/**
 * dsh-session-orb — a session-completion orb that belongs to no window.
 *
 * v1 drew the orb inside the DSH renderer (`shell.overlay`). That is why it
 * disappeared when the window hid to the tray, why its "always on top" was only
 * a CSS z-index inside a page, and why a hidden window throttled its timers to
 * roughly one tick a minute.
 *
 * v2 splits the job along the process boundary instead:
 *
 *   Host (this file)          owns detection, persistence, and the protocol
 *     ├─ hub.js               polls sessionController, decides "a turn ended"
 *     ├─ native.js            compiles/supervises the helper, restarts it
 *     └─ transport.js         private bridge to the helper + renderer routes
 *
 *   Renderer (client.js)      settings page only; no orb DOM, no detection
 *
 *   Helper (native/*.cs)      a real top-level layered window in its own process
 *
 * The window the user sees is therefore independent of every DSH window: it
 * survives minimise, hide-to-tray and window destruction, and its topmost bit is
 * a Windows extended style rather than a stacking hint inside a page.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { Hub } from './host/hub.js';
import { NativeOrb } from './host/native.js';
import { Log, PLUGIN_ID, Store, VERSION, resolveDataDir } from './host/store.js';
import { OrbBridge, createRendererRoutes } from './host/transport.js';

/** Events that mean "the session list changed, poll now". */
const WAKE_EVENTS = [
  'api-session/status',
  'api-session/added',
  'api-session/activity',
  'api-session/removed',
  'api-session/error',
  'agent/status',
];

export const inject = ['webServer'];

export function apply(ctx) {
  const pluginRoot = import.meta.dirname;
  const log = new Log(resolveDataDir());
  const store = new Store(resolveDataDir());
  if (store.loadError !== null) log.warn(`orb: state load problem — ${store.loadError}`);

  let webServer = null;
  try {
    webServer = ctx.get('webServer');
  } catch (error) {
    log.error(`orb: webServer service unavailable — ${String(error?.message ?? error)}`);
  }
  if (webServer === null || webServer === undefined) {
    log.error('orb: no webServer service; the settings page cannot reach this plugin');
    return;
  }

  const hub = new Hub({
    store,
    log,
    getProvider: () => {
      try {
        return ctx.get('sessionController');
      } catch {
        return null;
      }
    },
  });

  const native = new NativeOrb({
    pluginRoot,
    log,
    onEvent: (event) => onNativeEvent(event),
  });

  /** Never exposed to the renderer: it authenticates the helper process. */
  const token = randomBytes(24).toString('hex');

  const bridge = new OrbBridge({
    log,
    token,
    getState: () => hub.snapshot(),
    onEvent: (event) => onNativeEvent(event),
  });

  /** @type {{origin: string, token: string, lang: string} | null} */
  let spawnOptions = null;

  const routes = createRendererRoutes({
    hub,
    store,
    native,
    log,
    VERSION,
    PLUGIN_ID,
    runtimeStatus: () => ({
      // Deliberately omits the token: this object is served to the renderer.
      bridge: bridge.status(),
      native: native.status(),
      pluginRoot,
      dataDir: resolveDataDir(),
      platform: process.platform,
      pid: process.pid,
      spawn: spawnOptions === null ? null : { origin: spawnOptions.origin, lang: spawnOptions.lang },
    }),
  });

  /** @param {object} event */
  function onNativeEvent(event) {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (type === 'ready') {
      log.info(`orb: helper ready (pid ${String(event.pid ?? '?')}, dpi ${String(event.scale ?? '?')})`);
    } else if (type === 'bubble-click') {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
      if (sessionId !== '') {
        hub.pushCommand('open-session', { sessionId });
        hub.advance('bubble-click');
      }
    } else if (type === 'bubble-close') {
      hub.advance('bubble-close');
    } else if (type === 'ball-click') {
      // Without a notice the helper already brought DSH forward; nothing to do.
      if (hub.queue.length > 0) hub.advance('ball-click');
    } else if (type === 'drag-end') {
      const x = Number(event.x);
      const y = Number(event.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        store.setPosition({ x, y });
        hub.bump();
      }
    } else if (type === 'log' && typeof event.message === 'string') {
      log.info(`orb[helper]: ${event.message.slice(0, 500)}`);
    } else if (type === 'error' && typeof event.message === 'string') {
      log.warn(`orb[helper]: ${event.message.slice(0, 500)}`);
    } else if (type === 'fatal') {
      log.error(`orb[helper]: ${String(event.message ?? 'fatal')}`);
      native.state = 'failed';
      native.reason = String(event.message ?? 'helper reported a fatal error');
      hub.bump();
    }
    native.handleEvent(event);
  }

  // The state stream is the only thing the helper needs to render.
  const unsubscribe = hub.subscribe((state) => {
    bridge.pushState(state);
  });

  /** @type {NodeJS.Timeout | null} */
  let routeRetry = null;
  /** @type {(() => void)[]} */
  const wakeOffs = [];

  function mountRoutes(attempt = 0) {
    try {
      routes.mount(webServer);
      log.info(`orb: ${String(routes.paths.length)} renderer route(s) mounted`);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (attempt < 12 && /duplicate .*route/i.test(message)) {
        routeRetry = setTimeout(() => {
          routeRetry = null;
          mountRoutes(attempt + 1);
        }, 250);
        routeRetry.unref?.();
        return;
      }
      log.error(`orb: could not mount routes — ${message}`);
    }
  }

  function subscribeWakeEvents() {
    for (const name of WAKE_EVENTS) {
      try {
        const off = ctx.on(name, () => hub.wake());
        if (typeof off === 'function') wakeOffs.push(off);
      } catch {
        // Not every Host build declares every event; a missing one is not fatal
        // because the poll runs regardless.
      }
    }
  }

  async function boot() {
    try {
      const port = await bridge.listen();
      log.info(`orb: bridge ready on 127.0.0.1:${String(port)}`);
    } catch (error) {
      // Without the bridge the helper is deaf; still mount routes so the
      // settings page can explain what is wrong.
      log.error(`orb: bridge failed to listen — ${String(error?.message ?? error)}`);
    }
    spawnOptions = { origin: bridge.origin, token, lang: hub.lang };
    hub.start();
    void hub.tick();
    if (process.platform !== 'win32') {
      log.warn('orb: the native helper is Windows-only; the orb window will not appear here');
    }
    await native.start(spawnOptions);
    log.info(`orb: native status ${native.state}${native.reason === null ? '' : ` (${native.reason})`}`);
  }

  mountRoutes();
  subscribeWakeEvents();
  void boot().catch((error) => log.error(`orb: boot failed — ${String(error?.stack ?? error)}`));

  ctx.effect(() => () => {
    log.info('orb: plugin disposing');
    if (routeRetry !== null) {
      clearTimeout(routeRetry);
      routeRetry = null;
    }
    for (const off of wakeOffs.splice(0)) {
      try {
        off();
      } catch {
        // Ignore: the context may already be torn down.
      }
    }
    unsubscribe();
    native.dispose();
    bridge.dispose();
    hub.stop();
    routes.unmount();
    store.flush();
    store.dispose();
  }, 'dsh-session-orb: bridge, helper and routes');

  log.info(`orb: ${PLUGIN_ID} ${VERSION} applied (root ${join(pluginRoot, 'host')})`);
}
