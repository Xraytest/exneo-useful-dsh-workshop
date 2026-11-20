import { type PlanLimits } from './plan.js';
import type { EnginePorts } from './ports.js';
import { type RetryPolicy } from './retry.js';
import { type RunRecord, type RunRequest } from './types.js';
export declare class EngineError extends Error {
    readonly issues: readonly string[];
    constructor(message: string, issues?: readonly string[]);
}
export declare class Engine {
    private readonly ports;
    private readonly retry;
    private readonly planLimits?;
    constructor(ports: EnginePorts, retry?: RetryPolicy, planLimits?: PlanLimits | undefined);
    /**
     * The plan ceilings for one run: the run's own maxTasks limit is
     * authoritative over the engine-wide default, so a caller ceiling rejects an
     * oversized plan up front instead of truncating it mid-flight.
     */
    private planLimitsFor;
    /** Execute one orchestration to settlement. Never throws for run-level failures. */
    run(request: RunRequest): Promise<RunRecord>;
    private obtainPlan;
    private replan;
    private registerTasks;
    private executeGraph;
    private cascadeSkips;
    private markRemaining;
    private runTask;
    /** Classify one settled attempt, then optionally run the critic. */
    private judge;
    private verifyTask;
    private helper;
    /** Await an activation under a deadline; always dispose and drain on expiry. */
    private settle;
    private synthesize;
    private blockingFailures;
    private statusOf;
    private finishTask;
    private publish;
}
