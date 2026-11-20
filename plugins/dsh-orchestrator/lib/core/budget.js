/**
 * Run-level guard rails. Every ceiling here is measurable from facts the
 * orchestrator owns: wall time, activation count, task count, output size, and
 * tokens observed on the child sessions' assistant streams.
 * @module dsh-orchestrator/core/budget
 */
import { emptyUsage } from './types.js';
export const systemClock = {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
export function abortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    const error = new Error(typeof reason === 'string' ? reason : 'aborted');
    error.name = 'AbortError';
    return error;
}
export class Budget {
    limits;
    clock;
    startedAt;
    activations = 0;
    tasks = 0;
    outputChars = 0;
    usage = emptyUsage();
    exhaustedReason;
    constructor(limits, clock, startedAt) {
        this.limits = limits;
        this.clock = clock;
        this.startedAt = startedAt ?? clock.now();
    }
    /** Register a task the engine admitted into the run. */
    countTask() {
        this.tasks += 1;
    }
    /**
     * Atomically admit one task against every ceiling. A refused task is never
     * counted, so `maxTasks` admits exactly that many tasks and nothing more.
     */
    admit() {
        const existing = this.exhausted();
        if (existing)
            return { ok: false, reason: existing };
        if (this.limits.maxTasks !== undefined && this.tasks >= this.limits.maxTasks) {
            return { ok: false, reason: `maxTasks=${this.limits.maxTasks} reached` };
        }
        this.tasks += 1;
        return { ok: true };
    }
    /** Reserve one subagent activation, or explain why the run must stop launching. */
    reserve() {
        const existing = this.exhausted();
        if (existing)
            return { ok: false, reason: existing };
        if (this.limits.maxActivations !== undefined && this.activations >= this.limits.maxActivations) {
            return { ok: false, reason: this.mark(`maxActivations=${this.limits.maxActivations} reached`) };
        }
        this.activations += 1;
        return { ok: true };
    }
    /** Fold one settled attempt into the counters. */
    record(outputChars, usage) {
        this.outputChars += Math.max(0, outputChars);
        if (usage)
            addUsage(this.usage, usage);
        this.exhausted();
    }
    /** The first ceiling that is currently exceeded, memoized once tripped. */
    exhausted() {
        if (this.exhaustedReason)
            return this.exhaustedReason;
        const { maxWallMs, maxTasks, maxOutputChars, maxTokens } = this.limits;
        if (maxWallMs !== undefined && this.clock.now() - this.startedAt >= maxWallMs) {
            return this.mark(`maxWallMs=${maxWallMs} elapsed`);
        }
        if (maxTasks !== undefined && this.tasks > maxTasks) {
            return this.mark(`maxTasks=${maxTasks} exceeded`);
        }
        if (maxOutputChars !== undefined && this.outputChars >= maxOutputChars) {
            return this.mark(`maxOutputChars=${maxOutputChars} reached`);
        }
        if (maxTokens !== undefined && this.usage.totalTokens >= maxTokens) {
            return this.mark(`maxTokens=${maxTokens} reached`);
        }
        return undefined;
    }
    mark(reason) {
        this.exhaustedReason ??= reason;
        return this.exhaustedReason;
    }
    snapshot() {
        return {
            limits: this.limits,
            elapsedMs: this.clock.now() - this.startedAt,
            activations: this.activations,
            tasks: this.tasks,
            outputChars: this.outputChars,
            usage: { ...this.usage },
            ...(this.exhaustedReason ? { exhausted: this.exhaustedReason } : {}),
        };
    }
}
/** In-place token accumulation; `totalTokens` falls back to input+output+cache. */
export function addUsage(target, delta) {
    target.inputTokens += delta.inputTokens;
    target.outputTokens += delta.outputTokens;
    target.cacheReadTokens += delta.cacheReadTokens;
    target.cacheWriteTokens += delta.cacheWriteTokens;
    target.totalTokens += delta.totalTokens;
}
export function usageFrom(input) {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const cacheReadTokens = input.cacheReadTokens ?? 0;
    const cacheWriteTokens = input.cacheWriteTokens ?? 0;
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: input.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    };
}
