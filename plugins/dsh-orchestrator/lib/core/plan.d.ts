import type { Plan } from './types.js';
export interface PlanLimits {
    readonly maxTasks: number;
    readonly maxPromptChars: number;
    readonly maxDependencies: number;
}
export declare const DEFAULT_PLAN_LIMITS: PlanLimits;
export type PlanResult = {
    readonly ok: true;
    readonly plan: Plan;
} | {
    readonly ok: false;
    readonly issues: readonly string[];
};
/** Normalize an id into the harness-safe slug used for task ids and child names. */
export declare function slugify(input: string, fallback: string): string;
/**
 * Validate and normalize one raw plan.
 * @param raw - parsed JSON from the planner subagent or from a caller-supplied plan.
 * @param goal - run goal; used when the plan omits its own.
 * @param limits - structural ceilings enforced before any subagent starts.
 */
export declare function normalizePlan(raw: unknown, goal: string, limits?: PlanLimits): PlanResult;
/** A plan whose structured payloads are all lossless JSON (journal-safe). */
export declare function planIsJournalSafe(plan: Plan): boolean;
/** Compact plan projection used in prompts, reports, and tool results. */
export declare function planSummary(plan: Plan): Array<Record<string, unknown>>;
