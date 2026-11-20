/**
 * The single seam between the pure engine and a host harness. Everything the
 * engine does to the outside world goes through these ports, so an offline test
 * can drive a complete orchestration with a scripted implementation.
 * @module dsh-orchestrator/core/ports
 */
import type { Clock } from './budget.js';
import type { JsonObject, JsonValue, OrchestratorEvent, ParentHandle, Route } from './types.js';
export type ActivationKind = 'plan' | 'replan' | 'work' | 'critic' | 'synthesis';
export interface ActivationRequest {
    readonly runId: string;
    readonly kind: ActivationKind;
    /** Task id for `work` / `critic`; undefined for run-level helpers. */
    readonly taskId?: string;
    readonly attempt: number;
    /** Short durable label shown in the harness child catalog. */
    readonly label: string;
    /** Preferred child name; the adapter sanitizes and de-duplicates it. */
    readonly nameHint: string;
    readonly prompt: string;
    readonly parent: ParentHandle;
    readonly signal: AbortSignal;
    readonly outputSchema?: JsonObject;
    readonly route?: Route;
    readonly timeoutMs?: number;
}
export interface ActivationOutcome {
    readonly text: string;
    readonly structured?: JsonValue;
    /** Harness stop reason: `completed`, `error`, `aborted`, `max-tokens`, … */
    readonly stopReason: string;
    readonly diagnostic?: string;
}
export interface ActivationHandle {
    readonly childId: string;
    readonly name: string;
    /** Settles for child-level failures; rejects only on infrastructure faults. */
    readonly result: Promise<ActivationOutcome>;
    dispose(): Promise<void>;
}
export interface SubagentPort {
    /** Provider name used for activations, for reporting. */
    readonly providerName: string;
    /** Whether the provider can enforce `outputSchema` natively. */
    readonly supportsStructuredOutput: boolean;
    /** Whether the provider accepts provider/model overrides. */
    readonly supportsRouting: boolean;
    start(request: ActivationRequest): Promise<ActivationHandle>;
}
/** Durable-ish append-only run journal. Failures must never fail a run. */
export interface Journal {
    append(event: OrchestratorEvent & {
        readonly time: number;
    }): void;
    /** Persist the final record so `orch_status` can read historical runs. */
    finalize(record: unknown): void;
}
export declare const noopJournal: Journal;
export interface EnginePorts {
    readonly subagents: SubagentPort;
    readonly clock: Clock;
    readonly random: () => number;
    readonly journal: Journal;
    readonly emit: (event: OrchestratorEvent) => void;
    /** Token accounting observed for one child session, when the host exposes it. */
    readonly usageOf?: (childId: string) => import('./types.js').Usage | undefined;
    readonly log?: (message: string, error?: unknown) => void;
}
export type { Clock };
