/**
 * Retry classification and backoff. Deterministic under an injected RNG so the
 * engine's timing behaviour is testable.
 * @module dsh-orchestrator/core/retry
 */
import type { FailureKind } from './types.js';
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly jitterRatio: number;
}
export declare const DEFAULT_RETRY: RetryPolicy;
/** Failures worth another attempt; a critic rejection carries new feedback. */
export declare function isRetryable(kind: FailureKind): boolean;
/** Exponential backoff with symmetric jitter, clamped to `maxDelayMs`. */
export declare function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number;
