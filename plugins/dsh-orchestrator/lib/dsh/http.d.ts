/**
 * Minimal HTTP route helpers shared by the workbench-facing routes:
 * same-origin guard, JSON replies, and a bounded body reader. Mirrors the
 * conventions used by dsh-workbench / dsh-dual-agent owners.
 * @module dsh-orchestrator/dsh/http
 */
export interface JsonReply {
    (status: number, value: unknown): void;
}
export interface RouteHandler {
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, json: JsonReply): Promise<void> | void;
}
export interface WebServerLike {
    register(route: {
        kind: 'exact';
        path: string;
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
    }): () => void;
    readonly port?: number;
}
export declare function sameOrigin(req: {
    headers: Record<string, string | string[] | undefined>;
}): boolean;
export declare function jsonOf(res: import('node:http').ServerResponse): JsonReply;
export declare function readBody(req: import('node:http').IncomingMessage, limit?: number): Promise<{
    ok: true;
    text: string;
} | {
    ok: false;
    error: string;
}>;
export declare const queryOf: (req: {
    url?: string | undefined;
}, key: string) => string;
