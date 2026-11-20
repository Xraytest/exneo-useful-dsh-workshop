/**
 * Run-level guard rails. Every ceiling here is measurable from facts the
 * orchestrator owns: wall time, activation count, task count, output size, and
 * tokens observed on the child sessions' assistant streams.
 * @module dsh-orchestrator/core/budget
 */
import { emptyUsage, type BudgetLimits, type BudgetState, type Usage } from './types.js'

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortError(signal!))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' ? reason : 'aborted')
  error.name = 'AbortError'
  return error
}

export class Budget {
  private readonly startedAt: number
  private activations = 0
  private tasks = 0
  private outputChars = 0
  private readonly usage: Usage = emptyUsage()
  private exhaustedReason: string | undefined

  constructor(
    readonly limits: BudgetLimits,
    private readonly clock: Clock,
    startedAt?: number,
  ) {
    this.startedAt = startedAt ?? clock.now()
  }

  /** Register a task the engine admitted into the run. */
  countTask(): void {
    this.tasks += 1
  }

  /**
   * Atomically admit one task against every ceiling. A refused task is never
   * counted, so `maxTasks` admits exactly that many tasks and nothing more.
   */
  admit(): { ok: true } | { ok: false; reason: string } {
    const existing = this.exhausted()
    if (existing) return { ok: false, reason: existing }
    if (this.limits.maxTasks !== undefined && this.tasks >= this.limits.maxTasks) {
      return { ok: false, reason: `maxTasks=${this.limits.maxTasks} reached` }
    }
    this.tasks += 1
    return { ok: true }
  }

  /** Reserve one subagent activation, or explain why the run must stop launching. */
  reserve(): { ok: true } | { ok: false; reason: string } {
    const existing = this.exhausted()
    if (existing) return { ok: false, reason: existing }
    if (this.limits.maxActivations !== undefined && this.activations >= this.limits.maxActivations) {
      return { ok: false, reason: this.mark(`maxActivations=${this.limits.maxActivations} reached`) }
    }
    this.activations += 1
    return { ok: true }
  }

  /** Fold one settled attempt into the counters. */
  record(outputChars: number, usage?: Usage): void {
    this.outputChars += Math.max(0, outputChars)
    if (usage) addUsage(this.usage, usage)
    this.exhausted()
  }

  /** The first ceiling that is currently exceeded, memoized once tripped. */
  exhausted(): string | undefined {
    if (this.exhaustedReason) return this.exhaustedReason
    const { maxWallMs, maxTasks, maxOutputChars, maxTokens } = this.limits
    if (maxWallMs !== undefined && this.clock.now() - this.startedAt >= maxWallMs) {
      return this.mark(`maxWallMs=${maxWallMs} elapsed`)
    }
    if (maxTasks !== undefined && this.tasks > maxTasks) {
      return this.mark(`maxTasks=${maxTasks} exceeded`)
    }
    if (maxOutputChars !== undefined && this.outputChars >= maxOutputChars) {
      return this.mark(`maxOutputChars=${maxOutputChars} reached`)
    }
    if (maxTokens !== undefined && this.usage.totalTokens >= maxTokens) {
      return this.mark(`maxTokens=${maxTokens} reached`)
    }
    return undefined
  }

  private mark(reason: string): string {
    this.exhaustedReason ??= reason
    return this.exhaustedReason
  }

  snapshot(): BudgetState {
    return {
      limits: this.limits,
      elapsedMs: this.clock.now() - this.startedAt,
      activations: this.activations,
      tasks: this.tasks,
      outputChars: this.outputChars,
      usage: { ...this.usage },
      ...(this.exhaustedReason ? { exhausted: this.exhaustedReason } : {}),
    }
  }
}

/** In-place token accumulation; `totalTokens` falls back to input+output+cache. */
export function addUsage(target: Usage, delta: Usage): void {
  target.inputTokens += delta.inputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheWriteTokens += delta.cacheWriteTokens
  target.totalTokens += delta.totalTokens
}

export function usageFrom(input: {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}): Usage {
  const inputTokens = input.inputTokens ?? 0
  const outputTokens = input.outputTokens ?? 0
  const cacheReadTokens = input.cacheReadTokens ?? 0
  const cacheWriteTokens = input.cacheWriteTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: input.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  }
}