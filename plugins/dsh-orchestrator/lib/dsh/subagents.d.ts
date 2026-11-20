import type { ActivationHandle, ActivationRequest, SubagentPort } from '../core/ports.js';
import type { Route, Usage } from '../core/types.js';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
/** Structural slice of ctx.subagents this adapter needs. */
export interface SubagentsService {
    getProvider(name: string): SubagentProviderInfo | undefined;
    resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined;
    startActivation(spec: SubagentSpec): Promise<SubagentActivationLike>;
}
export interface SubagentProviderInfo {
    readonly name: string;
    readonly capabilities: {
        readonly agentOptions: boolean;
        readonly agentPreset: boolean;
        readonly outputSchema: boolean;
        readonly depthLimit: boolean;
    };
    readonly inheritsParentContext: boolean;
    /** Presence marks a local (continuable) backend; external backends omit it. */
    readonly prepareContinuable?: () => unknown;
}
/** Structural slice of the activation spec (see @deepseek-ai/dsh-subagent types). */
export interface SubagentSpec {
    readonly provider: string;
    readonly label: string;
    readonly name?: string;
    readonly prompt: ContentBlock[];
    readonly parent: Agent;
    readonly signal: AbortSignal;
    readonly delivery: 'parent' | 'caller';
    readonly cwd?: string;
    readonly agentOptions?: AgentOptions;
    readonly outputSchema?: ObjectJsonSchema;
    readonly maxDepth?: number;
}
export interface SubagentResultLike {
    readonly output: readonly ContentBlock[];
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: string;
}
export interface SubagentActivationLike {
    readonly childId: string;
    readonly name: string;
    readonly result: Promise<SubagentResultLike>;
    dispose(): Promise<void>;
}
export interface HarnessSubagentsOptions {
    readonly service: SubagentsService;
    /** Registered backend name; defaults to 'spawn'. */
    readonly provider?: string;
    /** Recursion cap handed to every child; omitted reads the host setting. */
    readonly maxDepth?: number | 'provider-managed';
    /** Child working directory; omitted inherits the parent's. */
    readonly cwd?: string;
}
/** Normalize a name hint into the harness child-name shape. */
export declare function sanitizeChildName(hint: string): string;
/** Map a core Route onto harness AgentOptions overrides. */
export declare const routeAgentOptions: (route: Route) => AgentOptions | undefined;
export declare class HarnessSubagents implements SubagentPort {
    private readonly options;
    readonly providerName: string;
    supportsStructuredOutput: boolean;
    supportsRouting: boolean;
    private readonly usedNames;
    constructor(options: HarnessSubagentsOptions);
    private uniqueName;
    start(request: ActivationRequest): Promise<ActivationHandle>;
    private toOutcome;
}
/** Fold one session assistant-message usage record into the tracker. */
export declare function foldUsage(target: Usage, raw: unknown): void;
