/**
 * Run-level guard rails. Every ceiling here is measurable from facts the
 * orchestrator owns: wall time, activation count, task count, output size, and
 * tokens observed on the child sessions' assistant streams.
 * @module dsh-orchestrator/core/budget
 */
import { type BudgetLimits, type BudgetState, type Usage } from './types.js';
export interface Clock {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export declare const systemClock: Clock;
export declare function abortError(signal: AbortSignal): Error;
export declare class Budget {
    readonly limits: BudgetLimits;
    private readonly clock;
    private readonly startedAt;
    private activations;
    private tasks;
    private outputChars;
    private readonly usage;
    private exhaustedReason;
    constructor(limits: BudgetLimits, clock: Clock, startedAt?: number);
    /** Register a task the engine admitted into the run. */
    countTask(): void;
    /**
     * Atomically admit one task against every ceiling. A refused task is never
     * counted, so `maxTasks` admits exactly that many tasks and nothing more.
     */
    admit(): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    /** Reserve one subagent activation, or explain why the run must stop launching. */
    reserve(): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    /** Fold one settled attempt into the counters. */
    record(outputChars: number, usage?: Usage): void;
    /** The first ceiling that is currently exceeded, memoized once tripped. */
    exhausted(): string | undefined;
    private mark;
    snapshot(): BudgetState;
}
/** In-place token accumulation; `totalTokens` falls back to input+output+cache. */
export declare function addUsage(target: Usage, delta: Usage): void;
export declare function usageFrom(input: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
}): Usage;
