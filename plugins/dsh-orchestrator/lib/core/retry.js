export const DEFAULT_RETRY = {
    maxAttempts: 2,
    initialDelayMs: 500,
    maxDelayMs: 8000,
    jitterRatio: 0.2,
};
/** Failures worth another attempt; a critic rejection carries new feedback. */
export function isRetryable(kind) {
    switch (kind) {
        case 'timeout':
        case 'child-error':
        case 'schema-invalid':
        case 'critic-rejected':
        case 'start-failed':
            return true;
        case 'aborted':
        case 'refusal':
        case 'budget':
        case 'dependency':
        case 'infra':
            return false;
    }
}
/** Exponential backoff with symmetric jitter, clamped to `maxDelayMs`. */
export function backoffDelay(attempt, policy, random) {
    const exponent = Math.max(0, attempt - 1);
    const raw = policy.initialDelayMs * 2 ** exponent;
    const capped = Math.min(raw, policy.maxDelayMs);
    const spread = capped * policy.jitterRatio;
    const jitter = (random() * 2 - 1) * spread;
    return Math.max(0, Math.round(capped + jitter));
}
