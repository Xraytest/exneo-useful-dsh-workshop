/**
 * The SubagentPort implementation over the harness subagent seam
 * (ctx.subagents.startActivation). One instance serves one run; names are
 * de-duplicated against the parent's live children, routes become
 * AgentOptions overrides, and core schemas are projected onto the harness's
 * enforced structured-output subset before they leave the engine.
 * @module dsh-orchestrator/dsh/subagents
 */
import { usageFrom } from '../core/budget.js';
import { projectToHarnessSubset } from '../core/jsonschema.js';
const NAME_MAX = 32;
/** Normalize a name hint into the harness child-name shape. */
export function sanitizeChildName(hint) {
    const slug = hint
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^[^a-z]+/, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, NAME_MAX)
        .replace(/-+$/g, '');
    if (slug === 'lead' || slug.length === 0)
        return 'worker';
    return slug;
}
/** Map a core Route onto harness AgentOptions overrides. */
export const routeAgentOptions = (route) => {
    const options = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
        const value = route[key];
        if (typeof value === 'string' && value.length > 0)
            options[key] = value;
    }
    if (typeof route.maxTokens === 'number')
        options['maxTokens'] = route.maxTokens;
    return Object.keys(options).length > 0 ? options : undefined;
};
const outputText = (blocks) => blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
export class HarnessSubagents {
    options;
    providerName;
    supportsStructuredOutput;
    supportsRouting;
    usedNames = new Map();
    constructor(options) {
        this.options = options;
        this.providerName = options.provider ?? 'spawn';
        const provider = options.service.getProvider(this.providerName);
        this.supportsStructuredOutput = provider?.capabilities.outputSchema ?? false;
        this.supportsRouting = provider?.capabilities.agentOptions ?? false;
    }
    uniqueName(hint, parentKey) {
        const used = this.usedNames.get(parentKey) ?? new Set();
        this.usedNames.set(parentKey, used);
        const base = sanitizeChildName(hint);
        let name = base;
        let index = 2;
        while (used.has(name)) {
            const suffix = '-' + String(index);
            name = base.slice(0, NAME_MAX - suffix.length) + suffix;
            index += 1;
        }
        used.add(name);
        return name;
    }
    async start(request) {
        const parent = request.parent.agent;
        const provider = this.options.service.getProvider(this.providerName);
        if (provider === undefined) {
            throw new Error('no subagent provider registered for ' + JSON.stringify(this.providerName));
        }
        // External one-shot backends reject a name together with caller delivery;
        // the host auto-names (agent-N) when the field is absent.
        const external = provider.capabilities.agentOptions === false &&
            provider.capabilities.agentPreset === false &&
            provider.capabilities.outputSchema === false &&
            provider.capabilities.depthLimit === false;
        const name = external ? undefined : this.uniqueName(request.nameHint, request.parent.sessionId);
        const route = request.route;
        const agentOptions = route === undefined ? undefined : this.supportsRouting ? routeAgentOptions(route) : undefined;
        if (route !== undefined && !this.supportsRouting && Object.keys(route).length > 0) {
            // Route requests exist but the backend cannot honour them; run inherited.
        }
        const schema = request.outputSchema;
        const outputSchema = schema === undefined ? undefined : provider.capabilities.outputSchema
            ? projectToHarnessSubset(schema)
            : undefined;
        const maxDepth = provider.capabilities.depthLimit ? this.options.service.resolveMaxDepth(this.options.maxDepth) : undefined;
        const baseSpec = {
            provider: this.providerName,
            label: request.label,
            ...(name !== undefined ? { name } : {}),
            prompt: [{ type: 'text', text: request.prompt }],
            parent,
            signal: request.signal,
            delivery: 'caller',
            ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
            ...(agentOptions !== undefined ? { agentOptions } : {}),
            ...(outputSchema !== undefined ? { outputSchema } : {}),
            ...(maxDepth !== undefined ? { maxDepth } : {}),
        };
        let activation;
        try {
            activation = await this.options.service.startActivation(baseSpec);
        }
        catch (error) {
            // A sibling of the same parent already holds this name (it may come from
            // another run or the model's own subagent tool): fall back to auto-naming.
            const code = error.code;
            const duplicate = code === 'DUPLICATE_AGENT_NAME' || /DUPLICATE_AGENT_NAME/.test(String(error.message));
            if (!duplicate || baseSpec.name === undefined)
                throw error;
            const { name: _collision, ...autoNamed } = baseSpec;
            activation = await this.options.service.startActivation(autoNamed);
        }
        return {
            childId: activation.childId,
            name: activation.name,
            result: activation.result.then((result) => this.toOutcome(result, outputSchema !== undefined)),
            dispose: () => activation.dispose().catch(() => undefined),
        };
    }
    toOutcome(result, structuredRequested) {
        const structured = result.structured;
        return {
            text: outputText(result.output),
            ...(structuredRequested && structured !== undefined && isPlain(structured) ? { structured: structured } : {}),
            stopReason: result.stopReason,
            ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
        };
    }
}
const isPlain = (value) => {
    if (value === null)
        return true;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean')
        return true;
    if (kind === 'number')
        return Number.isFinite(value);
    if (kind !== 'object')
        return false;
    if (Array.isArray(value))
        return value.every(isPlain);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
        return false;
    return Object.values(value).every(isPlain);
};
/** Fold one session assistant-message usage record into the tracker. */
export function foldUsage(target, raw) {
    if (typeof raw !== 'object' || raw === null)
        return;
    const delta = usageFrom(raw);
    target.inputTokens += delta.inputTokens;
    target.outputTokens += delta.outputTokens;
    target.cacheReadTokens += delta.cacheReadTokens;
    target.cacheWriteTokens += delta.cacheWriteTokens;
    target.totalTokens += delta.totalTokens;
}
