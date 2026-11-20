/** Shared test doubles for the pure core. No harness imports. */
import { expect } from 'vitest'
import type { ActivationHandle, ActivationOutcome, ActivationRequest, EnginePorts, Journal, SubagentPort } from '../src/core/ports.js'
import type { JsonValue, OrchestratorEvent, RunRequest, TaskSpec, Usage } from '../src/core/types.js'
import type { Clock } from '../src/core/budget.js'

export const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: over.inputTokens ?? 100,
  outputTokens: over.outputTokens ?? 50,
  cacheReadTokens: over.cacheReadTokens ?? 0,
  cacheWriteTokens: over.cacheWriteTokens ?? 0,
  totalTokens: over.totalTokens ?? 150,
})

export class FakeClock implements Clock {
  private nowMs: number
  readonly slept: number[] = []
  constructor(start = 1_000_000) {
    this.nowMs = start
  }
  now(): number { return this.nowMs }
  advance(ms: number): void { this.nowMs += ms }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.slept.push(ms)
    if (signal?.aborted) return Promise.reject(new Error('aborted'))
    return Promise.resolve()
  }
}

export interface Behavior {
  readonly outcome?: ActivationOutcome
  readonly reject?: Error
  readonly hang?: boolean
  readonly delayMs?: number
  readonly usage?: Usage
}

export interface RecordedStart {
  readonly request: ActivationRequest
  readonly index: number
}

/** Script-driven SubagentPort: pick a behavior per activation. */
export class ScriptedPort implements SubagentPort {
  readonly providerName = 'scripted'
  supportsStructuredOutput = true;
  supportsRouting = true;
  readonly starts: RecordedStart[] = []
  readonly disposals: string[] = []
  active = 0
  maxActive = 0
  private nextId = 0
  /** behavior chooser; return undefined to hang. */
  behavior: (req: ActivationRequest, index: number) => Behavior | undefined = () => ({})

  constructor(behavior?: (req: ActivationRequest, index: number) => Behavior | undefined) {
    if (behavior) this.behavior = behavior
  }

  prompts(): string[] { return this.starts.map((s) => s.request.prompt) }
  byKind(kind: ActivationRequest['kind']): RecordedStart[] { return this.starts.filter((s) => s.request.kind === kind) }

  async start(request: ActivationRequest): Promise<ActivationHandle> {
    const index = this.nextId
    this.nextId += 1
    this.starts.push({ request, index })
    const childId = 'child-' + String(index + 1)
    const name = 'sc-' + String(index + 1)
    const b = this.behavior(request, index) ?? {}
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    const settleLater = () => { this.active -= 1 }
    let result: Promise<ActivationOutcome>
    let hangResolver: ((outcome: ActivationOutcome) => void) | undefined
    if (b.hang) {
      result = new Promise<ActivationOutcome>((resolve) => { hangResolver = resolve })
    } else if (b.reject) {
      result = Promise.reject(b.reject)
      settleLater()
    } else {
      const outcome = b.outcome ?? { text: 'done ' + String(request.taskId ?? request.kind), stopReason: 'completed' }
      const fire = () => { settleLater(); if (b.usage) usageSink.set(childId, b.usage) }
      result = b.delayMs
        ? new Promise<ActivationOutcome>((resolve) => setTimeout(() => { fire(); resolve(outcome) }, b.delayMs))
        : Promise.resolve(outcome).then((o) => { fire(); return o })
    }
    return {
      childId,
      name,
      result,
      dispose: async () => {
        this.disposals.push(childId)
        hangResolver?.({ text: '', stopReason: 'aborted' })
      },
    }
  }
}

const usageSink = new Map<string, Usage>()
export const usageOf = (childId: string): Usage | undefined => usageSink.get(childId)
export const resetUsage = (): void => { usageSink.clear() }

export interface JournalCapture extends Journal {
  readonly events: Array<OrchestratorEvent & { time: number }>
  readonly finalized: unknown[]
}

export const makeJournal = (): JournalCapture => {
  const capture = {
    events: [] as Array<OrchestratorEvent & { time: number }>,
    finalized: [] as unknown[],
    append(event: OrchestratorEvent & { time: number }): void { capture.events.push(event) },
    finalize(record: unknown): void { capture.finalized.push(record) },
  }
  return capture
}

export const ports = (subagents: SubagentPort, clock: Clock, journal: JournalCapture, emit: (e: OrchestratorEvent) => void = () => {}): EnginePorts => ({
  subagents,
  clock,
  random: () => 0.5,
  journal,
  emit,
  usageOf,
})

export const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  id: over.id ?? 't1',
  title: over.title ?? 'task one',
  role: over.role ?? 'worker',
  prompt: over.prompt ?? 'do the thing',
  dependsOn: over.dependsOn ?? [],
  acceptance: over.acceptance ?? [],
  ...(over.outputSchema ? { outputSchema: over.outputSchema } : {}),
  ...(over.route ? { route: over.route } : {}),
  ...(over.guards ? { guards: over.guards } : {}),
  critical: over.critical ?? true,
  verify: over.verify ?? false,
})

export const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  id: over.id ?? 'run-1',
  goal: over.goal ?? 'build the thing',
  ...(over.context !== undefined ? { context: over.context } : {}),
  ...(over.plan !== undefined ? { plan: over.plan } : {}),
  parent: over.parent ?? { sessionId: 'sess-1', agent: {} },
  limits: over.limits ?? {},
  defaults: over.defaults ?? {
    timeoutMs: 500,
    maxAttempts: 2,
    verify: false,
    maxParallel: 4,
    maxReplans: 0,
    maxPlanRepairs: 1,
    synthesize: true,
    dependencyContextChars: 2000,
  },
  routing: over.routing ?? { roles: {}, rules: [] },
  trigger: over.trigger ?? { kind: 'tool' },
  signal: over.signal ?? new AbortController().signal,
})

export const rawPlan = (tasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tasks: tasks.map((t) => ({
    prompt: 'work on ' + String(t.id ?? 'task'),
    dependsOn: [],
    acceptance: [],
    ...t,
  })),
  ...extra,
})

export const outcome = (over: Partial<ActivationOutcome> = {}): ActivationOutcome => ({
  text: over.text ?? 'ok',
  ...(over.structured !== undefined ? { structured: over.structured } : {}),
  stopReason: over.stopReason ?? 'completed',
  ...(over.diagnostic !== undefined ? { diagnostic: over.diagnostic } : {}),
})

export const jsonText = (value: JsonValue): string => JSON.stringify(value)