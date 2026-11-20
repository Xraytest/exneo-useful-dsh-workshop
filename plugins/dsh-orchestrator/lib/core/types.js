/**
 * Pure orchestration vocabulary. Nothing in `src/core` imports the harness, so
 * the whole engine is testable without a running dsh.
 * @module dsh-orchestrator/core/types
 */
export const emptyUsage = () => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
});
export const isTerminalTask = (status) => status === 'succeeded' || status === 'failed' || status === 'skipped' || status === 'cancelled';
export const isTerminalRun = (status) => status !== 'running';
