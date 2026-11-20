/**
 * The Orchestrator side of the dsh-workbench secondary menu contract:
 * build a declarative panel spec from this session's settings, and fold
 * incoming ops back into the session store. dsh-workbench renders the
 * generic widgets (heading/note/switch/select/text/buttons); every piece of
 * Orchestrator semantics stays here. HTTP is mounted by src/index.ts.
 *
 *   GET  /dsh-orchestrator/menu?sessionId=…        → spec
 *   POST /dsh-orchestrator/menu {sessionId, op, …}  → new spec (errors carry menuStatus)
 * @module dsh-orchestrator/dsh/workbench-menu
 */
import type { SessionRoute, SessionState } from './session-state.js';
export interface ModelCatalog {
    readonly groups: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly models: ReadonlyArray<{
            readonly id: string;
            readonly name?: string;
        }>;
    }>;
    readonly error?: string;
}
export interface WorkbenchMenuHub {
    readonly state: SessionState;
    /** Provider/model catalog (from the llm service); may carry an error. */
    catalog(): Promise<ModelCatalog>;
    /** Locally registered subagent backends, e.g. ['spawn', 'fork']. */
    backends(): string[];
}
export declare const splitRoute: (value: string) => SessionRoute | undefined;
export declare function menuError(message: string, status?: number): Error & {
    menuStatus: number;
};
export declare function attachWorkbenchMenu(hub: WorkbenchMenuHub): {
    buildSpec: (sessionId: string) => Promise<Record<string, unknown>>;
    applyOp: (body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
