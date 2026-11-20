/**
 * Durable-ish run journal: one JSONL event stream plus one final record per
 * run, under a data directory the plugin entry chooses (default
 * ~/.dsh/dsh-orchestrator/runs). Failures are swallowed on purpose — a journal
 * problem must never take an orchestration down.
 * @module dsh-orchestrator/dsh/journal
 */
import { mkdirSync, appendFileSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
const CLIP = 8_000;
/** Best-effort lossless projection of one event for the JSONL stream. */
const project = (value, depth = 0) => {
    if (value === null || typeof value !== 'object' || depth > 6)
        return value;
    if (Array.isArray(value))
        return value.map((entry) => project(entry, depth + 1));
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'function' || typeof entry === 'symbol')
            continue;
        if (typeof entry === 'string' && entry.length > CLIP) {
            out[key] = entry.slice(0, CLIP) + '…[' + String(entry.length) + ' chars]';
            continue;
        }
        out[key] = project(entry, depth + 1);
    }
    return out;
};
const safeJson = (line) => {
    try {
        return JSON.stringify(project(JSON.parse(line)));
    }
    catch {
        return line.length > CLIP ? line.slice(0, CLIP) : line;
    }
};
export class FileJournal {
    dir;
    log;
    streams = new Map();
    constructor(options) {
        this.dir = options.dir;
        this.log = options.log ?? ((message, error) => console.warn('[dsh-orchestrator]', message, error ?? ''));
        try {
            mkdirSync(this.dir, { recursive: true });
        }
        catch (error) {
            this.log('journal directory unavailable; runs stay in memory only', error);
        }
    }
    /** Path of the JSONL event stream for one run. */
    eventsPath(runId) {
        return join(this.dir, runId + '.events.jsonl');
    }
    /** Path of the final record for one run. */
    recordPath(runId) {
        return join(this.dir, runId + '.record.json');
    }
    append(event) {
        const runId = 'runId' in event ? event.runId : undefined;
        if (!runId || !/^[A-Za-z0-9._-]{1,64}$/.test(runId))
            return;
        try {
            if (!this.streams.has(runId)) {
                mkdirSync(this.dir, { recursive: true });
                this.streams.set(runId, this.eventsPath(runId));
            }
            appendFileSync(this.eventsPath(runId), safeJson(JSON.stringify({ ...event, time: event.time })) + '\n');
        }
        catch (error) {
            this.log('journal append failed for run ' + runId, error);
        }
    }
    finalize(record) {
        const run = record;
        const runId = run?.id;
        if (!runId || !/^[A-Za-z0-9._-]{1,64}$/.test(runId))
            return;
        try {
            mkdirSync(this.dir, { recursive: true });
            writeFileSync(this.recordPath(runId), safeJson(JSON.stringify({ ...run, tasks: projectTasks(run) }, null, 2)));
            this.streams.delete(runId);
        }
        catch (error) {
            this.log('journal finalize failed for run ' + String(runId), error);
        }
    }
    /** Historical runs, newest first, for the orch_status listing. */
    list(limit = 20) {
        try {
            if (!existsSync(this.dir))
                return [];
            const entries = readdirSync(this.dir)
                .filter((name) => name.endsWith('.record.json'))
                .map((name) => ({ name, path: join(this.dir, name), mtime: statSync(join(this.dir, name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, Math.max(1, limit));
            return entries.flatMap((entry) => {
                try {
                    const raw = JSON.parse(readFileSync(entry.path, 'utf8'));
                    return [{
                            id: String(raw.id ?? entry.name.replace(/\.record\.json$/, '')),
                            status: String(raw.status ?? 'unknown'),
                            goal: String(raw.goal ?? ''),
                            ...(typeof raw.endedAt === 'number' ? { endedAt: raw.endedAt } : {}),
                            bytes: statSync(entry.path).size,
                        }];
                }
                catch {
                    return [];
                }
            });
        }
        catch {
            return [];
        }
    }
    /** Load one final record; undefined when the run is unknown or unreadable. */
    read(runId) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId))
            return undefined;
        try {
            const path = this.recordPath(runId);
            if (!existsSync(path))
                return undefined;
            return JSON.parse(readFileSync(path, 'utf8'));
        }
        catch {
            return undefined;
        }
    }
}
/** Strip the bulky attempt history from persisted task records. */
function projectTasks(run) {
    if (!run)
        return undefined;
    const out = {};
    for (const [id, record] of Object.entries(run.tasks ?? {})) {
        out[id] = {
            spec: record.spec,
            status: record.status,
            ...(record.output ? { output: record.output } : {}),
            ...(record.route ? { route: record.route } : {}),
            ...(record.routeSource ? { routeSource: record.routeSource } : {}),
            ...(record.failure ? { failure: record.failure } : {}),
            ...(record.detail ? { detail: record.detail } : {}),
            attempts: (record.attempts ?? []).map((attempt) => ({
                attempt: attempt.attempt,
                kind: attempt.kind,
                ...(attempt.childName ? { childName: attempt.childName } : {}),
                ...(attempt.stopReason ? { stopReason: attempt.stopReason } : {}),
                ...(attempt.failure ? { failure: attempt.failure } : {}),
                ...(attempt.detail ? { detail: attempt.detail } : {}),
                ...(attempt.usage ? { usage: attempt.usage } : {}),
            })),
        };
    }
    return out;
}
