import { describe, expect, it } from 'vitest'
import { HarnessSubagents, foldUsage, routeAgentOptions, sanitizeChildName } from '../src/dsh/subagents.js'
import type { SubagentProviderInfo, SubagentResultLike, SubagentSpec, SubagentsService } from '../src/dsh/subagents.js'
import type { ActivationRequest } from '../src/core/ports.js'
import type { Usage } from '../src/core/types.js'

const spawn: SubagentProviderInfo = {
  name: 'spawn',
  capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
  inheritsParentContext: false,
  prepareContinuable: () => ({}),
}

const external: SubagentProviderInfo = {
  name: 'acp',
  capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
  inheritsParentContext: false,
}

class FakeService implements SubagentsService {
  specs: SubagentSpec[] = []
  duplicateFirst = false
  constructor(readonly provider: SubagentProviderInfo) {}
  getProvider(name: string): SubagentProviderInfo | undefined {
    return name === this.provider.name ? this.provider : undefined
  }
  resolveMaxDepth(): number | undefined { return 1 }
  async startActivation(spec: SubagentSpec) {
    if (this.duplicateFirst) {
      this.duplicateFirst = false
      const error = new Error('child name is already in use') as Error & { code?: string }
      error.code = 'DUPLICATE_AGENT_NAME'
      throw error
    }
    this.specs.push(spec)
    const result: SubagentResultLike = {
      output: [
        { type: 'text', text: 'hello' },
        { type: 'reasoning', text: 'not output' },
        { type: 'text', text: 'world' },
      ],
      ...(spec.outputSchema !== undefined ? { structured: { ok: true } } : {}),
      stopReason: 'completed',
    }
    return {
      childId: 'child-' + String(this.specs.length),
      name: spec.name ?? 'agent-' + String(this.specs.length),
      result: Promise.resolve(result),
      dispose: async () => {},
    }
  }
}

const request = (over: Partial<ActivationRequest> = {}): ActivationRequest => ({
  runId: 'run-1',
  kind: 'work',
  ...(over.taskId !== undefined ? { taskId: over.taskId } : { taskId: 't1' }),
  attempt: 1,
  label: 'work',
  nameHint: over.nameHint ?? 'orch-run-1-t1',
  prompt: over.prompt ?? 'do the work',
  parent: { sessionId: 'sess-1', agent: { id: 'sess-1' } },
  signal: over.signal ?? new AbortController().signal,
  ...(over.outputSchema !== undefined ? { outputSchema: over.outputSchema } : {}),
  ...(over.route !== undefined ? { route: over.route } : {}),
})

describe('sanitizeChildName', () => {
  it('produces harness-legal names', () => {
    expect(sanitizeChildName('orch-run-1-scan-api')).toBe('orch-run-1-scan-api')
    expect(sanitizeChildName('Has Spaces!!')).toBe('has-spaces')
    expect(sanitizeChildName('123bad')).toBe('bad')
    expect(sanitizeChildName('lead')).toBe('worker')
    expect(sanitizeChildName('---')).toBe('worker')
    expect(sanitizeChildName('x'.repeat(80))).toHaveLength(32)
  })
})

describe('routeAgentOptions', () => {
  it('maps only defined fields', () => {
    expect(routeAgentOptions({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm' })
    expect(routeAgentOptions({ reasoningEffort: 'high', maxTokens: 1000 })).toEqual({ reasoningEffort: 'high', maxTokens: 1000 })
    expect(routeAgentOptions({})).toBeUndefined()
  })
})

describe('HarnessSubagents', () => {
  it('sends a sanitized unique name, caller delivery, and a text prompt block', async () => {
    const service = new FakeService(spawn)
    const port = new HarnessSubagents({ service, provider: 'spawn' })
    const first = await port.start(request({ nameHint: 'orch run 1 t1' }))
    const second = await port.start(request({ nameHint: 'orch run 1 t1', taskId: 't2' }))
    expect(service.specs[0]?.name).toBe('orch-run-1-t1')
    expect(service.specs[0]?.delivery).toBe('caller')
    expect(service.specs[0]?.prompt).toEqual([{ type: 'text', text: 'do the work' }])
    expect(service.specs[1]?.name).toBe('orch-run-1-t1-2')
    expect(first.childId).toBe('child-1')
  })

  it('falls back to auto-naming when a sibling holds the name', async () => {
    const service = new FakeService(spawn)
    service.duplicateFirst = true
    const port = new HarnessSubagents({ service, provider: 'spawn' })
    const handle = await port.start(request())
    expect(service.specs).toHaveLength(1)
    expect(service.specs[0]?.name).toBeUndefined()
    expect(handle.name).toBe('agent-1')
  })

  it('omits the name for capability-less external backends', async () => {
    const service = new FakeService(external)
    const port = new HarnessSubagents({ service, provider: 'acp' })
    expect(port.supportsStructuredOutput).toBe(false)
    expect(port.supportsRouting).toBe(false)
    await port.start(request())
    expect(service.specs[0]?.name).toBeUndefined()
  })

  it('projects output schemas onto the harness subset before dispatch', async () => {
    const service = new FakeService(spawn)
    const port = new HarnessSubagents({ service, provider: 'spawn' })
    await port.start(
      request({
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { n: { type: 'integer', minimum: 1, description: 'count' } },
          required: ['n'],
        },
      }),
    )
    expect(service.specs[0]?.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { n: { type: 'integer', description: 'count' } },
      required: ['n'],
    })
  })

  it('maps results: text blocks joined, structured passed through', async () => {
    const service = new FakeService(spawn)
    const port = new HarnessSubagents({ service, provider: 'spawn' })
    const handle = await port.start(request({ outputSchema: { type: 'object', additionalProperties: true, properties: {} } }))
    const result = await handle.result
    expect(result.text).toBe('hello' + String.fromCharCode(10) + String.fromCharCode(10) + 'world')
    expect(result.structured).toEqual({ ok: true })
    expect(result.stopReason).toBe('completed')
  })
})

describe('foldUsage', () => {
  it('accumulates usage records defensively', () => {
    const target: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
    foldUsage(target, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    foldUsage(target, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 7, totalTokens: 10 })
    foldUsage(target, null)
    expect(target.totalTokens).toBe(25)
    expect(target.cacheReadTokens).toBe(7)
  })
})