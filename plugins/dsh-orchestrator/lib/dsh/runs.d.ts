import type { OrchestratorEvent, Plan, RunRecord, TriggerInfo } from '../core/types.js';
export interface LiveRun {
    /** Engine-event-fed mutable snapshot; replaced by the final record on settle. */
    record: RunRecord;
    plan: Plan | undefined;
    /** Ends when the engine settles; resolves with the final record. */
    settled: Promise<RunRecord>;
    /** Abort the whole run; safe to call more than once. */
    cancel(reason?: string): void;
    /** Human-facing one-liner for listings. */
    summary(): string;
}
/** Seed a live record for a run the engine is about to create internally. */
export declare function liveRecord(id: string, goal: string, trigger: TriggerInfo, startedAt: number): RunRecord;
/** Fold one engine event into the live snapshot. Unknown shapes are ignored. */
export declare function applyEvent(record: RunRecord, event: OrchestratorEvent): void;
export declare class RunRegistry {
    private readonly live;
    private readonly finished;
    private readonly finishedLimit;
    constructor(finishedLimit?: number);
    /** Track one engine execution; call before awaiting the engine promise. */
    register(record: RunRecord, settled: Promise<RunRecord>, cancel: (reason?: string) => void): LiveRun;
    get(runId: string): LiveRun | undefined;
    running(): LiveRun[];
    /** Newest finished runs first; live runs are excluded. */
    history(limit?: number): RunRecord[];
    /** The compact orch_status listing. */
    listing(limit?: number): string[];
    /** Full status projection for one run, live or historical. */
    describe(runId: string): {
        record: RunRecord;
        plan: Plan | undefined;
        live: boolean;
        report: string;
    } | undefined;
}
/** Trigger metadata for a tool-initiated run. */
export declare const toolTrigger: (name?: string) => TriggerInfo;
