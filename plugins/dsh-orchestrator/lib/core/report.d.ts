import type { Plan, RunRecord } from './types.js';
/** Render the durable human-facing summary of one run. */
export declare function renderReport(run: RunRecord, plan?: Plan): string;
