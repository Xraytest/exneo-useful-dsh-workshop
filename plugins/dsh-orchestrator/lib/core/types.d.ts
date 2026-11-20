/**
 * Pure orchestration vocabulary. Nothing in `src/core` imports the harness, so
 * the whole engine is testable without a running dsh.
 * @module dsh-orchestrator/core/types
 */
/** Stable task identity inside one plan. */
export type TaskId = string;
/** Free-form worker role; routing maps it to a provider/model route. */
export type Role = string;
/** A model route override. Omitted fields inherit from the parent agent. */
export interface Route {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly maxTokens?: number;
}
/** Per-task guards. Omitted fields fall back to the run defaults. */
export interface TaskGuards {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
}
/** One node of the task DAG. */
export interface TaskSpec {
    readonly id: TaskId;
    readonly title: string;
    readonly role: Role;
    /** Instruction handed to the worker subagent. */
    readonly prompt: string;
    /** Tasks that must succeed before this one starts. */
    readonly dependsOn: readonly TaskId[];
    /** Human-readable acceptance criteria; also handed to the critic. */
    readonly acceptance: readonly string[];
    /** Optional object-rooted JSON Schema the worker's structured result must satisfy. */
    readonly outputSchema?: JsonObject;
    /** Explicit route; wins over every routing rule. */
    readonly route?: Route;
    readonly guards?: TaskGuards;
    /** A failed critical task fails the run (default true). */
    readonly critical: boolean;
    /** Run a critic pass on this task's result (default: run-level setting). */
    readonly verify: boolean;
}
/** A validated, normalized plan. */
export interface Plan {
    readonly goal: string;
    readonly tasks: readonly TaskSpec[];
    readonly synthesis: {
        readonly enabled: boolean;
        readonly prompt?: string;
    };
    readonly rationale?: string;
}
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
/** Plain JSON object (the only schema root the harness accepts). */
export interface JsonObject {
    readonly [key: string]: JsonValue;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
/** Token accounting, summed from the child sessions' assistant streams. */
export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
}
export declare const emptyUsage: () => Usage;
/** One worker/critic/planner attempt. */
export interface AttemptRecord {
    readonly attempt: number;
    readonly kind: 'work' | 'critic';
    readonly startedAt: number;
    endedAt?: number;
    childId?: string;
    childName?: string;
    stopReason?: string;
    /** Failure classification used for retry decisions and reporting. */
    failure?: FailureKind;
    detail?: string;
    outputChars?: number;
    usage?: Usage;
}
export type FailureKind = 'timeout' | 'aborted' | 'child-error' | 'refusal' | 'schema-invalid' | 'critic-rejected' | 'start-failed' | 'budget' | 'dependency' | 'infra';
/** The settled product of one task. */
export interface TaskOutput {
    readonly text: string;
    readonly structured?: JsonValue;
    readonly childId: string;
    readonly childName: string;
}
/** Mutable bookkeeping for one task inside a run. */
export interface TaskRecord {
    readonly spec: TaskSpec;
    status: TaskStatus;
    readonly attempts: AttemptRecord[];
    output?: TaskOutput;
    failure?: FailureKind;
    detail?: string;
    /** Route actually used, after routing resolution. */
    route?: Route;
    routeSource?: RouteSource;
}
export type RouteSource = 'task' | 'rule' | 'role' | 'default' | 'fallback' | 'inherit';
/** Hard ceilings for one run. Every field is optional; omitted means unbounded. */
export interface BudgetLimits {
    readonly maxWallMs?: number;
    readonly maxActivations?: number;
    readonly maxTasks?: number;
    readonly maxOutputChars?: number;
    readonly maxTokens?: number;
}
export interface BudgetState {
    readonly limits: BudgetLimits;
    readonly elapsedMs: number;
    readonly activations: number;
    readonly tasks: number;
    readonly outputChars: number;
    readonly usage: Usage;
    /** Set when a ceiling was hit; the run stops launching new work. */
    readonly exhausted?: string;
}
/** Where a run came from. */
export interface TriggerInfo {
    readonly kind: 'tool' | 'programmatic' | 'cron' | 'interval' | 'session-event';
    readonly name?: string;
    readonly detail?: string;
}
/** The complete durable-ish state of one orchestration. */
export interface RunRecord {
    readonly id: string;
    readonly goal: string;
    readonly parentSessionId: string;
    status: RunStatus;
    readonly createdAt: number;
    startedAt?: number;
    endedAt?: number;
    plan?: Plan;
    readonly tasks: Record<TaskId, TaskRecord>;
    budget: BudgetState;
    replans: number;
    report?: string;
    synthesis?: string;
    readonly trigger: TriggerInfo;
    failure?: string;
}
/** Everything the engine needs to start one run. */
export interface RunRequest {
    readonly id: string;
    readonly goal: string;
    readonly context?: string;
    /** A caller-supplied plan skips the planner call entirely. */
    readonly plan?: unknown;
    readonly parent: ParentHandle;
    readonly limits: BudgetLimits;
    readonly defaults: {
        readonly timeoutMs: number;
        readonly maxAttempts: number;
        readonly verify: boolean;
        readonly maxParallel: number;
        readonly maxReplans: number;
        readonly maxPlanRepairs: number;
        readonly synthesize: boolean;
        readonly dependencyContextChars: number;
    };
    readonly routing: RoutingConfig;
    readonly trigger: TriggerInfo;
    readonly signal: AbortSignal;
}
/** Opaque owner of the run. The dsh adapter narrows `agent` to `Agent`. */
export interface ParentHandle {
    readonly sessionId: string;
    readonly agent: unknown;
}
/** One routing rule; the first match wins. */
export interface RouteRule {
    readonly name?: string;
    readonly match: {
        readonly role?: string;
        readonly taskId?: string;
        readonly titleIncludes?: string;
    };
    readonly route: Route;
}
export interface RoutingConfig {
    readonly roles: Readonly<Record<string, Route>>;
    readonly rules: readonly RouteRule[];
    readonly default?: Route;
    /** Ordered fallback routes for worker retries: attempt 1 uses the primary
     * route (task/rule/role/default), attempt 2 the first fallback, and so on.
     * Planner, critic and synthesis always stay on the primary route. */
    readonly fallbacks?: readonly Route[];
}
/** Events the engine publishes; the adapter forwards them to Cordis and the journal. */
export type OrchestratorEvent = {
    readonly type: 'run/created';
    readonly runId: string;
    readonly goal: string;
    readonly trigger: TriggerInfo;
} | {
    readonly type: 'run/plan';
    readonly runId: string;
    readonly plan: Plan;
    readonly replan: boolean;
} | {
    readonly type: 'run/ended';
    readonly runId: string;
    readonly status: RunStatus;
    readonly failure?: string;
} | {
    readonly type: 'task/started';
    readonly runId: string;
    readonly taskId: TaskId;
    readonly attempt: number;
    readonly route?: Route;
    readonly routeSource?: RouteSource;
} | {
    readonly type: 'task/ended';
    readonly runId: string;
    readonly taskId: TaskId;
    readonly status: TaskStatus;
    readonly failure?: FailureKind;
    readonly detail?: string;
} | {
    readonly type: 'run/budget';
    readonly runId: string;
    readonly reason: string;
} | {
    readonly type: 'run/diagnostic';
    readonly runId: string;
    readonly message: string;
};
export declare const isTerminalTask: (status: TaskStatus) => boolean;
export declare const isTerminalRun: (status: RunStatus) => boolean;
