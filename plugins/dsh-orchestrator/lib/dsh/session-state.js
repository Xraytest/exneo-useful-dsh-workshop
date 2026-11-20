/**
 * Per-session orchestrator settings: the toolbox switch (enabled) and the
 * session's subagent specification (backend + default worker route).
 *
 * Default policy (0.2.0): NEW SESSIONS ARE DISABLED — orch_run stays hidden
 * until the toolbox switch is turned on for that session. The switch position
 * is persisted in BOTH directions (on stores true, off stores false) and stays
 * freely changeable at any time; an entry without an explicit boolean reads as
 * disabled; clear() returns the session to the default.
 *
 * Storage: $DSH_HOME/dsh-orchestrator/sessions.json, atomic tmp+rename writes,
 * read-before-write merge across processes (same discipline as workbench.json).
 * @module dsh-orchestrator/dsh/session-state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const DEFAULT_SESSION_SETTINGS = { enabled: false, hasOverride: false };
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const validRoute = (value) => {
    if (!isRecord(value))
        return undefined;
    const provider = typeof value['provider'] === 'string' ? value['provider'].trim() : '';
    const model = typeof value['model'] === 'string' ? value['model'].trim() : '';
    return provider !== '' && model !== '' ? { provider, model } : undefined;
};
export class SessionState {
    file;
    log;
    doc = { version: 1, sessions: {} };
    loadError;
    constructor(file, log) {
        this.file = file;
        this.log = log;
        this.reload();
    }
    reload() {
        try {
            if (!existsSync(this.file))
                return;
            const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
            if (!isRecord(parsed))
                throw new Error('not an object');
            const sessions = isRecord(parsed['sessions']) ? parsed['sessions'] : {};
            const clean = {};
            for (const [id, entry] of Object.entries(sessions)) {
                if (typeof id !== 'string' || id === '' || !isRecord(entry))
                    continue;
                const stored = {};
                if (typeof entry['enabled'] === 'boolean')
                    stored.enabled = entry['enabled'];
                if (typeof entry['backend'] === 'string' && entry['backend'] !== '')
                    stored.backend = entry['backend'];
                const route = validRoute(entry['route']);
                if (route !== undefined)
                    stored.route = route;
                if (typeof entry['reasoningEffort'] === 'string' && entry['reasoningEffort'] !== '')
                    stored.reasoningEffort = entry['reasoningEffort'];
                if (typeof entry['maxParallel'] === 'number' && Number.isInteger(entry['maxParallel']) && entry['maxParallel'] >= 1 && entry['maxParallel'] <= 8)
                    stored.maxParallel = entry['maxParallel'];
                if (entry['waitMode'] === 'await' || entry['waitMode'] === 'background')
                    stored.waitMode = entry['waitMode'];
                if (Array.isArray(entry['fallbacks'])) {
                    const routes = entry['fallbacks'].map((item) => validRoute(item)).filter((item) => item !== undefined);
                    if (routes.length > 0)
                        stored.fallbacks = routes.slice(0, 6);
                }
                if (Object.keys(stored).length > 0)
                    clean[id] = stored;
            }
            this.doc = { version: 1, sessions: clean };
            this.loadError = undefined;
        }
        catch (cause) {
            this.loadError = `读取失败（${String(cause.message)}），内存态照常`;
            this.log?.('sessions.json 读取失败', cause);
        }
    }
    persist() {
        const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(tmp, `${JSON.stringify(this.doc, null, 2)}\n`, { mode: 0o600 });
            renameSync(tmp, this.file);
            this.loadError = undefined;
        }
        catch (cause) {
            try {
                if (existsSync(tmp))
                    renameSync(tmp, `${tmp}.dead`);
            }
            catch { /* 尽力 */ }
            this.loadError = `写入失败（${String(cause.message)}），设置只在内存`;
            this.log?.('sessions.json 写入失败', cause);
        }
    }
    /** Write through the read-before-write merge so sibling processes keep their entries. */
    update(sessionId, mutate) {
        this.reload();
        const next = mutate({ ...this.doc.sessions[sessionId] });
        if (Object.keys(next).length === 0)
            delete this.doc.sessions[sessionId];
        else
            this.doc.sessions[sessionId] = next;
        this.persist();
    }
    stateOf(sessionId) {
        const entry = this.doc.sessions[sessionId];
        if (entry === undefined)
            return DEFAULT_SESSION_SETTINGS;
        return {
            enabled: entry.enabled === true,
            ...(entry.backend !== undefined ? { backend: entry.backend } : {}),
            ...(entry.route !== undefined ? { route: entry.route } : {}),
            ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
            ...(entry.maxParallel !== undefined ? { maxParallel: entry.maxParallel } : {}),
            ...(entry.waitMode !== undefined ? { waitMode: entry.waitMode } : {}),
            ...(entry.fallbacks !== undefined ? { fallbacks: entry.fallbacks } : {}),
            hasOverride: true,
        };
    }
    get error() {
        return this.loadError;
    }
    setEnabled(sessionId, enabled) {
        // 0.2.0：默认关闭，所以开关的两个方向都落盘（拨开存 true，拨关存 false）。
        // 任何时候都能再改；clear() 才回到默认（关）。
        this.update(sessionId, (entry) => ({ ...entry, enabled }));
    }
    setRoute(sessionId, route) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            if (route === undefined)
                delete next.route;
            else
                next.route = route;
            return next;
        });
    }
    setReasoningEffort(sessionId, effort) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            const clean = effort !== undefined && effort !== '' ? effort : undefined;
            if (clean === undefined)
                delete next.reasoningEffort;
            else
                next.reasoningEffort = clean;
            return next;
        });
    }
    setBackend(sessionId, backend) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            const clean = backend !== undefined && backend !== '' ? backend : undefined;
            if (clean === undefined)
                delete next.backend;
            else
                next.backend = clean;
            return next;
        });
    }
    setMaxParallel(sessionId, maxParallel) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            const clean = maxParallel !== undefined ? Math.min(8, Math.max(1, Math.round(maxParallel))) : undefined;
            if (clean === undefined)
                delete next.maxParallel;
            else
                next.maxParallel = clean;
            return next;
        });
    }
    setWaitMode(sessionId, waitMode) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            if (waitMode === undefined)
                delete next.waitMode;
            else
                next.waitMode = waitMode;
            return next;
        });
    }
    setFallbacks(sessionId, fallbacks) {
        this.update(sessionId, (entry) => {
            const next = { ...entry };
            const clean = Array.isArray(fallbacks) ? fallbacks.slice(0, 6) : undefined;
            if (clean === undefined || clean.length === 0)
                delete next.fallbacks;
            else
                next.fallbacks = clean;
            return next;
        });
    }
    clear(sessionId) {
        this.update(sessionId, () => ({}));
    }
}
