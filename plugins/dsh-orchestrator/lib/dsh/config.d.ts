/**
 * Configuration normalization shared by the plugin config, the orch_run tool
 * options, and the trigger paths. Pure: unknown JSON in, validated
 * {@link RunTuning} out, with per-field provenance kept out of the way.
 * @module dsh-orchestrator/dsh/config
 */
import type { BudgetLimits, JsonObject, RoutingConfig } from '../core/types.js';
export interface RunDefaults {
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly verify: boolean;
    readonly maxParallel: number;
    readonly maxReplans: number;
    readonly maxPlanRepairs: number;
    readonly synthesize: boolean;
    readonly dependencyContextChars: number;
}
export interface RunTuning {
    readonly limits: BudgetLimits;
    readonly defaults: RunDefaults;
    readonly routing: RoutingConfig;
}
export declare const DEFAULT_TUNING: RunTuning;
/** Merge a raw plugin/tool config blob over the shipped defaults. */
export declare function tuningFromConfig(raw: unknown, base?: RunTuning): RunTuning;
/**
 * Merge per-call orch_run options over a base tuning. Only fields the call
 * actually sets move; a plan handed to orch_run is not handled here.
 */
export declare function tuningForCall(raw: unknown, base: RunTuning): RunTuning;
/** Sanitize a caller-provided run id into a filesystem-safe slug. */
export declare function safeRunId(raw: unknown, fallback: string): string;
/** Prove a value is a plain object-rooted JSON value (for tool input trust). */
export declare function asJsonObject(value: unknown): JsonObject | undefined;
