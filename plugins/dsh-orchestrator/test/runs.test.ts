import { describe, expect, it, vi } from 'vitest'
import { RunRegistry, applyEvent, liveRecord } from '../src/dsh/runs.js'
import type { RunRecord } from '../src/core/types.js'

const record = (id: string, status: RunRecord['status'] = 'running'): RunRecord => ({
  id,
  goal: 'goal ' + id,
  parentSessionId: 'sess',
  status,
  createdAt: 1,
  tasks: {},
  budget: { limits: {}, elapsedMs: 0, activations: 0, tasks: 0, outputChars: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } },
  replans: 0,
  trigger: { kind: 'tool', name: 'orch_run' },
})

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('RunRegistry', () => {
  it('tracks a live run and moves it to history on settle', async () => {
    const registry = new RunRegistry()
    const rec = record('r1')
    const cancel = vi.fn()
    const done = deferred<RunRecord>()
    const live = registry.register(rec, done.promise, cancel)
    expect(registry.get('r1')).toBe(live)
    expect(registry.running()).toHaveLength(1)
    expect(registry.listing()[0]).toContain('[running] r1')
    live.cancel('stop')
    expect(cancel).toHaveBeenCalledWith('stop')
    done.resolve({ ...rec, status: 'succeeded' })
    await new Promise((r) => setTimeout(r, 5))
    expect(registry.get('r1')).toBeUndefined()
    expect(registry.history()).toHaveLength(1)
    const described = registry.describe('r1')
    expect(described?.live).toBe(false)
    expect(described?.record.status).toBe('succeeded')
    expect(described?.report).toContain('# Orchestration')
    expect(registry.listing()[0]).toContain('r1')
  })

  it('folds engine events into the live snapshot', () => {
    const rec = liveRecord('live-1', 'goal live', { kind: 'tool', name: 'orch_run' }, 5)
    applyEvent(rec, { type: 'run/plan', runId: 'live-1', plan: {
      goal: 'goal live',
      tasks: [
        { id: 'a', title: 'A', role: 'worker', prompt: 'x', dependsOn: [], acceptance: [], critical: true, verify: false },
        { id: 'b', title: 'B', role: 'worker', prompt: 'y', dependsOn: ['a'], acceptance: [], critical: true, verify: false },
      ],
      synthesis: { enabled: true },
    }, replan: false })
    applyEvent(rec, { type: 'task/started', runId: 'live-1', taskId: 'a', attempt: 1 })
    applyEvent(rec, { type: 'task/ended', runId: 'live-1', taskId: 'a', status: 'succeeded' })
    applyEvent(rec, { type: 'run/budget', runId: 'live-1', reason: 'maxActivations=4 reached' })
    expect(rec.tasks['a']?.status).toBe('succeeded')
    expect(rec.tasks['b']?.status).toBe('pending')
    expect(rec.plan?.tasks).toHaveLength(2)
    expect(rec.budget.exhausted).toBe('maxActivations=4 reached')
    const registry = new RunRegistry(4)
    const done = deferred<RunRecord>()
    const live = registry.register(rec, done.promise, () => {})
    expect(live.summary()).toContain('[running] live-1')
    expect(live.summary()).toContain('1/2 tasks')
    done.resolve({ ...rec, status: 'succeeded' })
  })

  it('bounds the finished history and ignores unknown ids', () => {
    const registry = new RunRegistry(2)
    for (const id of ['a', 'b', 'c']) {
      const done = deferred<RunRecord>()
      registry.register(record(id), done.promise, () => {})
      done.resolve({ ...record(id), status: 'failed' })
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(registry.history().map((r) => r.id)).toEqual(['c', 'b'])
      expect(registry.describe('missing')).toBeUndefined()
    })
  })
})