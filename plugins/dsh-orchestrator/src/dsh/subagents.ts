/**
 * The SubagentPort implementation over the harness subagent seam
 * (ctx.subagents.startActivation). One instance serves one run; names are
 * de-duplicated against the parent's live children, routes become
 * AgentOptions overrides, and core schemas are projected onto the harness's
 * enforced structured-output subset before they leave the engine.
 * @module dsh-orchestrator/dsh/subagents
 */
import { usageFrom } from '../core/budget.js'
import { projectToHarnessSubset } from '../core/jsonschema.js'
import type { ActivationHandle, ActivationOutcome, ActivationRequest, SubagentPort } from '../core/ports.js'
import type { JsonObject, JsonValue, Route, Usage } from '../core/types.js'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

/** Structural slice of ctx.subagents this adapter needs. */
export interface SubagentsService {
  getProvider(name: string): SubagentProviderInfo | undefined
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
  startActivation(spec: SubagentSpec): Promise<SubagentActivationLike>
}

export interface SubagentProviderInfo {
  readonly name: string
  readonly capabilities: {
    readonly agentOptions: boolean
    readonly agentPreset: boolean
    readonly outputSchema: boolean
    readonly depthLimit: boolean
  }
  readonly inheritsParentContext: boolean
  /** Presence marks a local (continuable) backend; external backends omit it. */
  readonly prepareContinuable?: () => unknown
}

/** Structural slice of the activation spec (see @deepseek-ai/dsh-subagent types). */
export interface SubagentSpec {
  readonly provider: string
  readonly label: string
  readonly name?: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
  readonly cwd?: string
  readonly agentOptions?: AgentOptions
  readonly outputSchema?: ObjectJsonSchema
  readonly maxDepth?: number
}

export interface SubagentResultLike {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

export interface SubagentActivationLike {
  readonly childId: string
  readonly name: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

export interface HarnessSubagentsOptions {
  readonly service: SubagentsService
  /** Registered backend name; defaults to 'spawn'. */
  readonly provider?: string
  /** Recursion cap handed to every child; omitted reads the host setting. */
  readonly maxDepth?: number | 'provider-managed'
  /** Child working directory; omitted inherits the parent's. */
  readonly cwd?: string
}

const NAME_MAX = 32

/** Normalize a name hint into the harness child-name shape. */
export function sanitizeChildName(hint: string): string {
  const slug = hint
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
  if (slug === 'lead' || slug.length === 0) return 'worker'
  return slug
}

/** Map a core Route onto harness AgentOptions overrides. */
export const routeAgentOptions = (route: Route): AgentOptions | undefined => {
  const options: Record<string, unknown> = {}
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    const value = route[key]
    if (typeof value === 'string' && value.length > 0) options[key] = value
  }
  if (typeof route.maxTokens === 'number') options['maxTokens'] = route.maxTokens
  return Object.keys(options).length > 0 ? (options as AgentOptions) : undefined
}

const outputText = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')

export class HarnessSubagents implements SubagentPort {
  readonly providerName: string
  supportsStructuredOutput: boolean
  supportsRouting: boolean
  private readonly usedNames = new Map<string, Set<string>>()

  constructor(private readonly options: HarnessSubagentsOptions) {
    this.providerName = options.provider ?? 'spawn'
    const provider = options.service.getProvider(this.providerName)
    this.supportsStructuredOutput = provider?.capabilities.outputSchema ?? false
    this.supportsRouting = provider?.capabilities.agentOptions ?? false
  }

  private uniqueName(hint: string, parentKey: string): string {
    const used = this.usedNames.get(parentKey) ?? new Set<string>()
    this.usedNames.set(parentKey, used)
    const base = sanitizeChildName(hint)
    let name = base
    let index = 2
    while (used.has(name)) {
      const suffix = '-' + String(index)
      name = base.slice(0, NAME_MAX - suffix.length) + suffix
      index += 1
    }
    used.add(name)
    return name
  }

  async start(request: ActivationRequest): Promise<ActivationHandle> {
    const parent = request.parent.agent as Agent
    const provider = this.options.service.getProvider(this.providerName)
    if (provider === undefined) {
      throw new Error('no subagent provider registered for ' + JSON.stringify(this.providerName))
    }
    // External one-shot backends reject a name together with caller delivery;
    // the host auto-names (agent-N) when the field is absent.
    const external =
      provider.capabilities.agentOptions === false &&
      provider.capabilities.agentPreset === false &&
      provider.capabilities.outputSchema === false &&
      provider.capabilities.depthLimit === false
    const name = external ? undefined : this.uniqueName(request.nameHint, request.parent.sessionId)
    const route = request.route
    const agentOptions = route === undefined ? undefined : this.supportsRouting ? routeAgentOptions(route) : undefined
    if (route !== undefined && !this.supportsRouting && Object.keys(route).length > 0) {
      // Route requests exist but the backend cannot honour them; run inherited.
    }
    const schema: JsonObject | undefined = request.outputSchema
    const outputSchema = schema === undefined ? undefined : provider.capabilities.outputSchema
      ? (projectToHarnessSubset(schema) as unknown as ObjectJsonSchema)
      : undefined
    const maxDepth = provider.capabilities.depthLimit ? this.options.service.resolveMaxDepth(this.options.maxDepth) : undefined
    const baseSpec: SubagentSpec = {
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
    }
    let activation: SubagentActivationLike
    try {
      activation = await this.options.service.startActivation(baseSpec)
    } catch (error) {
      // A sibling of the same parent already holds this name (it may come from
      // another run or the model's own subagent tool): fall back to auto-naming.
      const code = (error as { code?: string }).code
      const duplicate = code === 'DUPLICATE_AGENT_NAME' || /DUPLICATE_AGENT_NAME/.test(String((error as Error).message))
      if (!duplicate || baseSpec.name === undefined) throw error
      const { name: _collision, ...autoNamed } = baseSpec
      activation = await this.options.service.startActivation(autoNamed)
    }
    return {
      childId: activation.childId,
      name: activation.name,
      result: activation.result.then((result): ActivationOutcome => this.toOutcome(result, outputSchema !== undefined)),
      dispose: () => activation.dispose().catch(() => undefined),
    }
  }

  private toOutcome(result: SubagentResultLike, structuredRequested: boolean): ActivationOutcome {
    const structured = result.structured
    return {
      text: outputText(result.output),
      ...(structuredRequested && structured !== undefined && isPlain(structured) ? { structured: structured as JsonValue } : {}),
      stopReason: result.stopReason,
      ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
    }
  }
}

const isPlain = (value: unknown): boolean => {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return true
  if (kind === 'number') return Number.isFinite(value)
  if (kind !== 'object') return false
  if (Array.isArray(value)) return value.every(isPlain)
  const proto = Object.getPrototypeOf(value as object)
  if (proto !== Object.prototype && proto !== null) return false
  return Object.values(value as Record<string, unknown>).every(isPlain)
}

/** Fold one session assistant-message usage record into the tracker. */
export function foldUsage(target: Usage, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const delta = usageFrom(raw as Record<string, number>)
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheWriteTokens += delta.cacheWriteTokens
  target.totalTokens += delta.totalTokens
}