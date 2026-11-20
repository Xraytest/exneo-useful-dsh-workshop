/**
 * The Orchestrator side of the dsh-workbench secondary menu contract:
 * build a declarative panel spec from this session's settings, and fold
 * incoming ops back into the session store. dsh-workbench renders the
 * generic widgets (heading/note/switch/select/text/rows/form/buttons); every
 * piece of Orchestrator semantics stays here. HTTP is mounted by src/index.ts.
 *
 *   GET  /dsh-orchestrator/menu?sessionId=…        → spec
 *   POST /dsh-orchestrator/menu {sessionId, op, …}  → new spec (errors carry menuStatus)
 *
 * v2（2026-11-21，用户任务「截断/档位不全/极长等待/并发/备选/UI 优化」）：
 *   - 思考档位不再写死 low/medium/high，改按所选模型的实际元数据动态出选项；
 *   - 新增：并发上限（maxParallel）、运行等待（waitMode）、备选子代理链
 *     （fallbacks，rows+form 维护，重试时按顺序回退）；
 *   - 文案全面收紧，避免窄浮层里长段落把控件顶出可视区（截断感的来源）。
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
export interface ModelEffortInfo {
    /** Effort ids the selected model supports; null when metadata is unavailable. */
    readonly efforts: string[] | null;
}
export interface WorkbenchMenuHub {
    readonly state: SessionState;
    /** Provider/model catalog (from the llm service); may carry an error. */
    catalog(): Promise<ModelCatalog>;
    /** Reasoning efforts supported by one model; null when unknown. */
    modelInfo(provider: string, model: string): Promise<ModelEffortInfo>;
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
