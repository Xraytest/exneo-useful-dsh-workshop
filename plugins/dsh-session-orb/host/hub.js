/**
 * Session state aggregation — the part of v1 that lived in the renderer and
 * therefore died with the window.
 *
 * v1 derived "a session finished" inside `OrbLayer` from `ctx.sessions.list()`
 * snapshots taken while the page was visible. Once the DSH window hides to the
 * tray, Chromium throttles that renderer to ~1 tick/minute and every notice
 * arrives late (or never). The Host process keeps running while the window is
 * hidden, so the detection moves here: one poll of `sessionController.list()`
 * plus event wake-ups, and the outcome is pushed to the native orb process.
 *
 * Detection semantics are deliberately identical to v1 (`client.js` reconcile):
 *  - the first pass only establishes a baseline, it can never report a notice;
 *  - only a `running: true -> false` transition counts, and only once;
 *  - a row with `origin === 'subagent'` never produces a notice;
 *  - the transition is re-checked after `confirmMs`; a session that resumed in
 *    that window suppresses the notice instead of flashing a false positive;
 *  - a resume after the bubble appeared retracts it and counts as suppressed.
 */
import { basename } from 'node:path';

/** Notices kept at once; the oldest is dropped. Matches v1's MAX_QUEUE. */
const MAX_QUEUE = 4;
/** Commands the renderer has not drained yet. */
const MAX_COMMANDS = 8;
/** A command older than this is dropped: the window was hidden too long. */
const COMMAND_TTL_MS = 60_000;
/** Poll interval while the Host is healthy. */
const POLL_MS = 1200;

/** @param {unknown} row */
function runningFlagOf(row) {
  const running = row?.running;
  return typeof running === 'boolean' ? running : null;
}

/** Pick the calmer of the two detectors: no bus event, no poll, nothing.
 * @param {unknown} row */
function titleOf(row) {
  if (row === null || typeof row !== 'object') return '';
  for (const key of ['title', 'displayTitle', 'name']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 200);
  }
  const values = row.projections?.values;
  if (values !== null && typeof values === 'object') {
    for (const [key, value] of Object.entries(values)) {
      if (!/title|name|label/i.test(key)) continue;
      const text =
        typeof value === 'string' ? value : typeof value?.title === 'string' ? value.title : Array.isArray(value) ? '' : '';
      if (typeof text === 'string' && text.trim() !== '') return text.trim().slice(0, 200);
    }
  }
  return '';
}

/** Last resort: the working directory's name reads better than an empty bubble.
 * @param {unknown} row */
function fallbackTitle(row) {
  const cwd = row?.cwd;
  if (typeof cwd !== 'string' || cwd === '') return '';
  const name = basename(cwd.replace(/[\\/]+$/, ''));
  return name === '' || name === '.' ? '' : name;
}

export class Hub {
  /**
   * @param {object} options
   * @param {import('./store.js').Store} options.store
   * @param {import('./store.js').Log} options.log
   * @param {() => (object | null)} [options.getProvider] resolves `sessionController` lazily
   */
  constructor({ store, log, getProvider }) {
    this.store = store;
    this.log = log;
    this.getProvider = getProvider ?? (() => null);
    /** @type {Map<string, true>} ids that were running in the previous pass */
    this.previousRunning = new Map();
    this.baseline = false;
    /** @type {Map<string, {timer: NodeJS.Timeout, title: string}>} */
    this.pendingConfirm = new Map();
    /** @type {{sessionId:string,title:string,at:number}[]} */
    this.queue = [];
    /** @type {NodeJS.Timeout | null} */
    this.noticeTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.pollTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.wakeTimer = null;
    this.polling = false;
    this.runningCount = 0;
    this.seq = 0;
    this.degraded = null;
    this.lastNotice = null;
    this.counters = { confirmed: 0, suppressed: 0, retracted: 0, skipped: 0 };
    this.renderer = { at: 0, visible: null, lang: null, url: null, box: null };
    /** @type {{id:string,type:string,sessionId?:string,at:number}[]} */
    this.commands = [];
    this.commandSeq = 0;
    /** @type {Set<(state: object) => void>} */
    this.listeners = new Set();
    this.emitScheduled = false;
    this.disposed = false;
    const locale = safeLocale();
    this.lang = locale.startsWith('zh') ? 'zh' : 'en';
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.polling) return this;
    this.polling = true;
    this.schedule();
    return this;
  }

  stop() {
    this.disposed = true;
    this.polling = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    for (const { timer } of this.pendingConfirm.values()) clearTimeout(timer);
    this.pollTimer = null;
    this.wakeTimer = null;
    this.noticeTimer = null;
    this.pendingConfirm.clear();
    this.listeners.clear();
  }

  /** Wake hint from a Host event: poll soon instead of waiting for the interval. */
  wake() {
    if (this.disposed || this.wakeTimer !== null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.tick();
    }, 140);
    this.wakeTimer.unref?.();
  }

  schedule() {
    if (!this.polling || this.disposed) return;
    this.pollTimer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  async tick() {
    const rows = await this.readSessions();
    if (this.disposed) return;
    if (rows === null) {
      this.degraded = 'sessionController.list() is unavailable in this Host';
      return;
    }
    this.degraded = null;
    try {
      this.reconcile(rows);
    } catch (error) {
      this.log.error(`reconcile failed: ${String(error?.stack ?? error)}`);
    }
  }

  /** @returns {Promise<object[] | null>} */
  async readSessions() {
    const provider = this.getProvider();
    if (provider === null || provider === undefined || typeof provider.list !== 'function') return null;
    try {
      const value = await provider.list();
      const rows = value?.sessions ?? value;
      return Array.isArray(rows) ? rows : null;
    } catch (error) {
      this.log.warn(`sessionController.list() failed: ${String(error?.message ?? error)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- detection

  /** @param {object[]} rows */
  reconcile(rows) {
    /** @type {Map<string, true>} */
    const nextRunning = new Map();
    /** @type {{id:string,title:string}[]} */
    const candidates = [];
    /** @type {string[]} */
    const resumed = [];
    /** @type {Record<string,string>} */
    const learned = {};
    let runningCount = 0;

    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const id = row.id;
      if (typeof id !== 'string' || id === '') continue;
      const was = this.previousRunning.has(id);
      const running = runningFlagOf(row);
      const title = titleOf(row);
      if (title !== '') learned[id] = title;

      if (running === null) {
        // Unreadable status: preserve the previous verdict rather than invent one.
        if (was) {
          nextRunning.set(id, true);
          runningCount += 1;
        }
        continue;
      }
      if (running) {
        nextRunning.set(id, true);
        runningCount += 1;
        if (!was) resumed.push(id);
        continue;
      }
      if (was && row.origin !== 'subagent') {
        candidates.push({ id, title: title !== '' ? title : this.store.title(id) || fallbackTitle(row) });
      } else if (was) {
        this.counters.skipped += 1;
      }
    }

    if (Object.keys(learned).length > 0) this.store.mergeTitles(learned);
    this.previousRunning = nextRunning;
    this.runningCount = runningCount;

    if (!this.baseline) {
      // Nothing may be reported before there is a previous state to compare with.
      this.baseline = true;
      this.bump();
      return;
    }

    for (const id of resumed) this.onResumed(id);
    for (const candidate of candidates) this.scheduleConfirm(candidate);
    this.bump();
  }

  /** @param {string} id */
  onResumed(id) {
    const pending = this.pendingConfirm.get(id);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.pendingConfirm.delete(id);
    }
    const retracted = this.retract(id);
    if (pending !== undefined || retracted) {
      this.counters.suppressed += 1;
      this.log.info(`orb: notice suppressed for ${id} (session resumed)`);
    }
  }

  /** @param {{id:string,title:string}} candidate */
  scheduleConfirm(candidate) {
    if (this.pendingConfirm.has(candidate.id)) return;
    const confirmMs = this.store.settings.confirmMs;
    if (confirmMs <= 0) {
      this.confirm(candidate);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingConfirm.delete(candidate.id);
      this.verify(candidate);
    }, confirmMs);
    timer.unref?.();
    this.pendingConfirm.set(candidate.id, { timer, title: candidate.title });
  }

  /** @param {{id:string,title:string}} candidate */
  verify(candidate) {
    if (this.disposed) return;
    if (this.previousRunning.has(candidate.id)) {
      // It went back to work while we were waiting to be sure.
      this.counters.suppressed += 1;
      return;
    }
    this.confirm(candidate);
  }

  /** @param {{id:string,title:string}} candidate */
  confirm(candidate) {
    const title = candidate.title !== '' ? candidate.title : this.store.title(candidate.id) || 'DSH';
    const existing = this.queue.findIndex((entry) => entry.sessionId === candidate.id);
    if (existing >= 0) this.queue.splice(existing, 1);
    const notice = { sessionId: candidate.id, title, at: Date.now() };
    this.queue.push(notice);
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
    this.lastNotice = notice;
    this.counters.confirmed += 1;
    this.log.info(`orb: notice for ${candidate.id} — ${title}`);
    this.armNoticeTimer();
    this.bump();
  }

  /** Start (or restart) the dismissal timer for the current notice. */
  armNoticeTimer() {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (this.queue.length === 0) return;
    const ms = Math.max(1000, this.store.settings.bubbleMs);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.advance('timeout');
    }, ms);
    this.noticeTimer.unref?.();
  }

  /** @param {string} reason */
  advance(reason) {
    if (this.queue.length === 0) return false;
    const [dropped] = this.queue.splice(0, 1);
    this.log.info(`orb: notice dismissed (${reason}) — ${dropped.sessionId}`);
    this.armNoticeTimer();
    this.bump();
    return true;
  }

  /** @param {string} sessionId */
  retract(sessionId) {
    const index = this.queue.findIndex((entry) => entry.sessionId === sessionId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.counters.retracted += 1;
    this.armNoticeTimer();
    this.bump();
    return true;
  }

  // ---------------------------------------------------------------- commands

  /**
   * Ask the renderer to do something only it can do (navigate to a session).
   * @param {string} type
   * @param {{sessionId?: string}} [payload]
   */
  pushCommand(type, payload = {}) {
    this.commandSeq += 1;
    const command = { id: `cmd-${this.commandSeq}`, type, ...payload, at: Date.now() };
    this.commands.push(command);
    while (this.commands.length > MAX_COMMANDS) this.commands.shift();
    this.log.info(`orb: command ${command.id} ${type} ${payload.sessionId ?? ''}`.trim());
    return command;
  }

  drainCommands() {
    const now = Date.now();
    const fresh = this.commands.filter((command) => now - command.at <= COMMAND_TTL_MS);
    const dropped = this.commands.length - fresh.length;
    this.commands = [];
    if (dropped > 0) this.log.warn(`orb: dropped ${dropped} expired command(s)`);
    return fresh;
  }

  // ---------------------------------------------------------------- state

  /** @param {{visible?: boolean|null, lang?: string|null, url?: string|null, box?: unknown}} report */
  markRenderer(report) {
    this.renderer = {
      at: Date.now(),
      visible: typeof report.visible === 'boolean' ? report.visible : this.renderer.visible,
      lang: typeof report.lang === 'string' && report.lang !== '' ? report.lang : this.renderer.lang,
      url: typeof report.url === 'string' ? report.url.slice(0, 200) : this.renderer.url,
      box: report.box ?? this.renderer.box,
    };
    if (report.lang === 'zh' || report.lang === 'en') {
      if (this.lang !== report.lang) {
        this.lang = report.lang;
        this.bump();
      }
    }
    return this.renderer;
  }

  labels() {
    return this.lang === 'zh'
      ? {
          kicker: '会话完成',
          more: '还有 {n} 条',
          dismiss: '关闭提示',
          open: '打开会话',
          unnamed: '未命名会话',
          hint: '点击回到 DSH',
        }
      : {
          kicker: 'Session finished',
          more: '{n} more',
          dismiss: 'Dismiss',
          open: 'Open session',
          unnamed: 'Untitled session',
          hint: 'Click to return to DSH',
        };
  }

  /** The state document pushed to the native orb. */
  snapshot() {
    const current = this.queue[0] ?? null;
    return {
      v: 2,
      seq: (this.seq += 1),
      at: Date.now(),
      running: this.runningCount,
      notice:
        current === null
          ? null
          : { sessionId: current.sessionId, title: current.title, more: this.queue.length - 1, at: current.at },
      settings: this.store.settings,
      position: this.store.position,
      lang: this.lang,
      labels: this.labels(),
      degraded: this.degraded,
    };
  }

  /** @param {(state: object) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Coalesce every state change in one tick into a single notification. */
  bump() {
    if (this.emitScheduled || this.disposed) return;
    this.emitScheduled = true;
    const flush = () => {
      this.emitScheduled = false;
      if (this.disposed) return;
      const state = this.snapshot();
      for (const listener of this.listeners) {
        try {
          listener(state);
        } catch (error) {
          this.log.warn(`orb: state listener failed: ${String(error?.message ?? error)}`);
        }
      }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(flush);
    else setTimeout(flush, 0);
  }

  /** Renderer-facing summary (settings page + selfcheck). */
  summary() {
    return {
      running: this.runningCount,
      notices: this.queue.length,
      runningIds: [...this.previousRunning.keys()],
      queue: this.queue.map((entry) => ({
        sessionId: entry.sessionId,
        title: entry.title,
        at: entry.at,
      })),
      pendingConfirm: [...this.pendingConfirm.keys()],
      lastNotice: this.lastNotice,
      counters: { ...this.counters },
      degraded: this.degraded,
      renderer: this.renderer,
      commands: this.commands.length,
      baseline: this.baseline,
    };
  }
}

function safeLocale() {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase();
  } catch {
    return '';
  }
}
