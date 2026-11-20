/**
 * Harness adapter surface: journal, config, run registry, and the
 * subagent port. Re-exported as 'dsh-orchestrator/dsh' for hosts that want
 * to embed the adapter without the plugin entry.
 * @module dsh-orchestrator/dsh
 */
export * from './config.js';
export * from './journal.js';
export * from './runs.js';
export * from './subagents.js';
export * from './session-state.js';
export * from './workbench-menu.js';
export * from './http.js';
