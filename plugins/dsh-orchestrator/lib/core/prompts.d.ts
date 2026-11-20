/**
 * Model-facing prompt text and the structured contracts the orchestrator asks
 * its own helper subagents to satisfy. Kept in core so the engine is testable
 * without a harness and every prompt is one reviewable artifact.
 * @module dsh-orchestrator/core/prompts
 */
import type { JsonObject, Plan, TaskOutput, TaskSpec } from './types.js';
/** Plan contract handed to the planner subagent as its structured output schema. */
export declare const PLAN_SCHEMA: JsonObject;
/** Critic contract. */
export declare const CRITIC_SCHEMA: JsonObject;
export interface PlannerInput {
    readonly goal: string;
    readonly context?: string;
    readonly maxTasks: number;
    readonly roles: readonly string[];
    readonly structuredOutputSupported: boolean;
}
export declare function plannerPrompt(input: PlannerInput): string;
export declare function planRepairPrompt(issues: readonly string[], previous: unknown): string;
export interface ReplanInput {
    readonly goal: string;
    readonly plan: Plan;
    readonly failures: ReadonlyArray<{
        id: string;
        title: string;
        detail: string;
    }>;
    readonly succeeded: readonly string[];
    readonly remainingBudgetNote?: string;
}
export declare function replanPrompt(input: ReplanInput): string;
export interface WorkerInput {
    readonly goal: string;
    readonly task: TaskSpec;
    readonly dependencies: ReadonlyArray<{
        spec: TaskSpec;
        output: TaskOutput;
    }>;
    readonly dependencyContextChars: number;
    readonly attempt: number;
    readonly previousFeedback?: string;
    readonly structuredOutputSupported: boolean;
}
export declare function workerPrompt(input: WorkerInput): string;
export interface CriticInput {
    readonly goal: string;
    readonly task: TaskSpec;
    readonly output: TaskOutput;
    readonly schemaViolations: readonly string[];
}
export declare function criticPrompt(input: CriticInput): string;
export interface SynthesisInput {
    readonly goal: string;
    readonly customPrompt?: string;
    readonly results: ReadonlyArray<{
        spec: TaskSpec;
        output?: TaskOutput;
        status: string;
        detail?: string;
    }>;
    readonly resultChars: number;
}
export declare function synthesisPrompt(input: SynthesisInput): string;
