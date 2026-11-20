/**
 * Retry classification and backoff. Deterministic under an injected RNG so the
 * engine's timing behaviour is testable.
 * @module dsh-orchestrator/core/retry
 */
import type { FailureKind } from './types.js'

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
}

/** Failures worth another attempt; a critic rejection carries new feedback. */
export function isRetryable(kind: FailureKind): boolean {
  switch (kind) {
    case 'timeout':
    case 'child-error':
    case 'schema-invalid':
    case 'critic-rejected':
    case 'start-failed':
      return true
    case 'aborted':
    case 'refusal':
    case 'budget':
    case 'dependency':
    case 'infra':
      return false
  }
}

/** Exponential backoff with symmetric jitter, clamped to `maxDelayMs`. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exponent = Math.max(0, attempt - 1)
  const raw = policy.initialDelayMs * 2 ** exponent
  const capped = Math.min(raw, policy.maxDelayMs)
  const spread = capped * policy.jitterRatio
  const jitter = (random() * 2 - 1) * spread
  return Math.max(0, Math.round(capped + jitter))
}