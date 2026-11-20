export interface SessionRoute {
    readonly provider: string;
    readonly model: string;
}
/** One session's effective settings (defaults folded in). */
export interface SessionSettings {
    readonly enabled: boolean;
    readonly backend?: string;
    readonly route?: SessionRoute;
    readonly reasoningEffort?: string;
    /** Worker concurrency cap for runs started in this session (1..8). */
    readonly maxParallel?: number;
    /** Forced wait mode for orch_run in this session; undefined = per-call/model choice. */
    readonly waitMode?: 'await' | 'background';
    /** Ordered fallback subagent routes appended after the plugin routing fallbacks. */
    readonly fallbacks?: SessionRoute[];
    readonly hasOverride: boolean;
}
export declare const DEFAULT_SESSION_SETTINGS: SessionSettings;
export declare class SessionState {
    private readonly file;
    private readonly log?;
    private doc;
    private loadError;
    constructor(file: string, log?: ((message: string, error?: unknown) => void) | undefined);
    private reload;
    private persist;
    /** Write through the read-before-write merge so sibling processes keep their entries. */
    private update;
    stateOf(sessionId: string): SessionSettings;
    get error(): string | undefined;
    setEnabled(sessionId: string, enabled: boolean): void;
    setRoute(sessionId: string, route: SessionRoute | undefined): void;
    setReasoningEffort(sessionId: string, effort: string | undefined): void;
    setBackend(sessionId: string, backend: string | undefined): void;
    setMaxParallel(sessionId: string, maxParallel: number | undefined): void;
    setWaitMode(sessionId: string, waitMode: 'await' | 'background' | undefined): void;
    setFallbacks(sessionId: string, fallbacks: SessionRoute[] | undefined): void;
    clear(sessionId: string): void;
}
