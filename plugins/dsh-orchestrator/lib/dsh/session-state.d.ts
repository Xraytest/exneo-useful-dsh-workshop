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
    clear(sessionId: string): void;
}
