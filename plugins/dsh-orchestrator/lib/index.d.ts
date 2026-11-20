import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { type OrchestratorEvent } from './core/types.js';
export declare const name = "dsh-orchestrator";
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** One orchestration started. @mode emit */
        'orchestrator/run-start'(payload: {
            runId: string;
            goal: string;
        }): void;
        /** One orchestration settled. @mode emit */
        'orchestrator/run-end'(payload: {
            runId: string;
            status: string;
        }): void;
        /** Raw engine event stream for observers and UI tails. @mode emit */
        'orchestrator/event'(event: OrchestratorEvent): void;
    }
}
/** One route override: provider, model, reasoning effort, and/or output tokens. */
export interface RouteOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    maxTokens?: number;
}
/** One opt-in session-event trigger: matching user text starts a background run. */
export interface TriggerRule {
    name?: string;
    textIncludes: string;
    source?: Array<'user' | 'schedule'>;
    goal: string;
    context?: string;
    once?: boolean;
}
/** Plugin configuration; every field except the provider is optional. */
export interface Config {
    provider: string;
    maxDepth?: number | 'provider-managed';
    dataDir?: string;
    history: number;
    defaults: {
        timeoutMs?: number;
        maxAttempts?: number;
        verify?: boolean;
        maxParallel?: number;
        maxReplans?: number;
        maxPlanRepairs?: number;
        synthesize?: boolean;
        dependencyContextChars?: number;
    };
    limits: {
        maxWallMs?: number;
        maxActivations?: number;
        maxTasks?: number;
        maxOutputChars?: number;
        maxTokens?: number;
    };
    routing: {
        roles?: Record<string, RouteOptions>;
        rules?: Array<{
            name?: string;
            match: {
                role?: string;
                taskId?: string;
                titleIncludes?: string;
            };
            route: RouteOptions;
        }>;
        default?: RouteOptions;
    };
    triggers?: TriggerRule[];
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): () => void;
export default apply;
