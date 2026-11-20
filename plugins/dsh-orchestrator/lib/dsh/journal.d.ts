import type { Journal } from '../core/ports.js';
import type { OrchestratorEvent, RunRecord } from '../core/types.js';
export interface FileJournalOptions {
    /** Root directory for run files. */
    readonly dir: string;
    /** Diagnostics sink; defaults to console. */
    readonly log?: (message: string, error?: unknown) => void;
}
export declare class FileJournal implements Journal {
    private readonly dir;
    private readonly log;
    private readonly streams;
    constructor(options: FileJournalOptions);
    /** Path of the JSONL event stream for one run. */
    eventsPath(runId: string): string;
    /** Path of the final record for one run. */
    recordPath(runId: string): string;
    append(event: OrchestratorEvent & {
        time: number;
    }): void;
    finalize(record: unknown): void;
    /** Historical runs, newest first, for the orch_status listing. */
    list(limit?: number): Array<{
        id: string;
        status: string;
        goal: string;
        endedAt?: number;
        bytes: number;
    }>;
    /** Load one final record; undefined when the run is unknown or unreadable. */
    read(runId: string): RunRecord | undefined;
}
