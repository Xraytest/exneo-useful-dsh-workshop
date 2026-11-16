/**
 * Persistent state for the session orb — the single source of truth shared by
 * the Web UI settings page, the Host routes and the native orb process.
 *
 * Why a file instead of `localStorage`: v1 kept settings and position in the
 * renderer, so an external window could never read them, a hidden window could
 * not even keep them in sync, and every browser profile had its own copy. The
 * orb is now a separate process, therefore its state has to live outside any
 * window: %LOCALAPPDATA%\dsh-session-orb\state.json (or the platform equivalent).
 *
 * Writes are debounced because dragging the orb produces a position update per
 * pointer-up and settings sliders emit a value per frame during a drag.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stable plugin id; also the state file prefix and the CSS/data attribute namespace. */
export const PLUGIN_ID = 'dsh-session-orb';
export const VERSION = '2.0.0';

/** Shape defaults. Mirrors the shipped look, so upgrading keeps the current orb. */
const DEFAULTS = {
  fill: 0.3,
  opacity: 0.88,
  size: 56,
  radius: 17,
  bubbleAlpha: 0.92,
  bubbleMs: 8000,
  confirmMs: 2500,
  pulse: true,
  badge: true,
  // Whether the orb is on screen at all. The helper process stays alive while
  // hidden so switching it back on is instant.
  visible: true,
};

/** Hard bounds; anything outside is clamped rather than rejected, so a stale or
 * hand-edited state file can never make the orb unusable. */
const LIMITS = {
  fill: [0.08, 0.9],
  opacity: [0.25, 1],
  size: [40, 80],
  radius: [4, 40],
  bubbleAlpha: [0.5, 1],
  bubbleMs: [2000, 30_000],
  confirmMs: [0, 15_000],
};

const MAX_TITLES = 400;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** @param {unknown} raw */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const size = clampNumber(input.size, ...LIMITS.size, DEFAULTS.size);
  // A radius above half the size is not a rounded square any more, it is a lens.
  const radiusMax = Math.min(LIMITS.radius[1], Math.round(size / 2));
  return {
    fill: round2(clampNumber(input.fill, ...LIMITS.fill, DEFAULTS.fill)),
    opacity: round2(clampNumber(input.opacity, ...LIMITS.opacity, DEFAULTS.opacity)),
    size: round2(size),
    radius: round2(clampNumber(input.radius, LIMITS.radius[0], radiusMax, Math.min(DEFAULTS.radius, radiusMax))),
    bubbleAlpha: round2(clampNumber(input.bubbleAlpha, ...LIMITS.bubbleAlpha, DEFAULTS.bubbleAlpha)),
    bubbleMs: Math.round(clampNumber(input.bubbleMs, ...LIMITS.bubbleMs, DEFAULTS.bubbleMs)),
    confirmMs: Math.round(clampNumber(input.confirmMs, ...LIMITS.confirmMs, DEFAULTS.confirmMs)),
    pulse: input.pulse === undefined ? DEFAULTS.pulse : input.pulse !== false,
    badge: input.badge === undefined ? DEFAULTS.badge : input.badge !== false,
    visible: input.visible === undefined ? DEFAULTS.visible : input.visible !== false,
  };
}

export function defaultSettings() {
  return { ...DEFAULTS };
}

/** @param {unknown} raw */
function normalizePosition(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Physical pixels can be negative on a monitor left of the primary one.
  return { x: Math.round(x), y: Math.round(y) };
}

/** Resolve the per-user state directory. Honours LOCALAPPDATA, then XDG, then home. */
export function resolveDataDir() {
  const base =
    process.env.LOCALAPPDATA ??
    process.env.XDG_STATE_HOME ??
    (process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'state'));
  return join(base, PLUGIN_ID);
}

export class Store {
  /** @param {string} [dir] */
  constructor(dir = resolveDataDir()) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.settings = defaultSettings();
    this.position = null;
    /** @type {Map<string, string>} */
    this.titles = new Map();
    this.loadError = null;
    this.timer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      // ENOENT is the normal first run; anything else is worth surfacing in selfcheck.
      if (error?.code !== 'ENOENT') this.loadError = String(error?.message ?? error);
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.loadError = `state.json is not valid JSON: ${String(error?.message ?? error)}`;
      return this;
    }
    if (parsed === null || typeof parsed !== 'object') return this;
    this.settings = normalizeSettings(parsed.settings);
    this.position = normalizePosition(parsed.position);
    if (parsed.titles !== null && typeof parsed.titles === 'object') {
      for (const [id, title] of Object.entries(parsed.titles)) {
        if (typeof title === 'string' && title !== '') this.titles.set(id, title.slice(0, 200));
      }
    }
    return this;
  }

  /** @param {unknown} raw */
  patchSettings(raw) {
    const patch = raw !== null && typeof raw === 'object' ? raw : {};
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.save();
    return this.settings;
  }

  /** @param {{x:number,y:number}|null} position */
  setPosition(position) {
    const next = normalizePosition(position);
    if (next !== null && this.position !== null && next.x === this.position.x && next.y === this.position.y) {
      return this.position;
    }
    this.position = next;
    this.save();
    return this.position;
  }

  /**
   * Remember session titles learned from the renderer's session list. The Host
   * has no title of its own: `SessionSummary` carries no title field, the Web UI
   * derives one from a projection the renderer applies.
   * @param {Record<string, unknown>} map
   */
  mergeTitles(map) {
    if (map === null || typeof map !== 'object') return 0;
    let changed = 0;
    for (const [id, title] of Object.entries(map)) {
      if (typeof title !== 'string') continue;
      const text = title.trim().slice(0, 200);
      if (text === '' || id === '') continue;
      if (this.titles.get(id) === text) continue;
      // Re-insert so Map iteration order keeps the most recent title last.
      this.titles.delete(id);
      this.titles.set(id, text);
      changed += 1;
    }
    while (this.titles.size > MAX_TITLES) {
      const oldest = this.titles.keys().next();
      if (oldest.done === true) break;
      this.titles.delete(oldest.value);
    }
    if (changed > 0) this.save();
    return changed;
  }

  /** @param {string} id */
  title(id) {
    return this.titles.get(id) ?? '';
  }

  save() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 220);
    // A pending debounce must not keep the Host process alive on shutdown.
    this.timer.unref?.();
  }

  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const payload = {
      version: 2,
      updatedAt: Date.now(),
      settings: this.settings,
      position: this.position,
      titles: Object.fromEntries(this.titles),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      const staging = join(this.dir, `state.json.${process.pid}.tmp`);
      writeFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(staging, this.file);
      this.loadError = null;
    } catch (error) {
      this.loadError = `could not write state.json: ${String(error?.message ?? error)}`;
    }
  }

  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Append-only text log with a size cap. The native process writes its standard
 * error here too, so a crash can be diagnosed after the fact; the in-memory
 * tail is what `/session-orb/selfcheck` returns.
 */
export class Log {
  /** @param {string} dir @param {number} [limit] */
  constructor(dir, limit = 300) {
    this.dir = dir;
    this.file = join(dir, 'orb.log');
    this.limit = limit;
    /** @type {{at:number, level:string, message:string}[]} */
    this.entries = [];
  }

  /** @param {'info'|'warn'|'error'} level @param {string} message */
  add(level, message) {
    const entry = { at: Date.now(), level, message: String(message).slice(0, 4000) };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, `${new Date(entry.at).toISOString()} ${level} ${entry.message}\n`, { flag: 'a' });
    } catch {
      // Logging must never break the orb.
    }
    return entry;
  }

  info(message) {
    return this.add('info', message);
  }

  warn(message) {
    return this.add('warn', message);
  }

  error(message) {
    return this.add('error', message);
  }

  tail(count = 40) {
    return this.entries.slice(-count);
  }
}

/** Scratch space for the compiled helper and diagnostics dumps. */
export function scratchDir() {
  return process.platform === 'win32' ? join(tmpdir(), PLUGIN_ID) : join(tmpdir(), PLUGIN_ID);
}
