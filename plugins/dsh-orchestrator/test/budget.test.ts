import { describe, expect, it } from 'vitest'
import { Budget, addUsage, usageFrom } from '../src/core/budget.js'
import { FakeClock } from './helpers.js'

describe('Budget', () => {
  it('counts tasks and activations', () => {
    const budget = new Budget({}, new FakeClock())
    budget.countTask()
    budget.countTask()
    expect(budget.reserve()).toEqual({ ok: true })
    expect(budget.snapshot().tasks).toBe(2)
    expect(budget.snapshot().activations).toBe(1)
    expect(budget.exhausted()).toBeUndefined()
  })

  it('trips maxActivations permanently', () => {
    const budget = new Budget({ maxActivations: 1 }, new FakeClock())
    expect(budget.reserve()).toEqual({ ok: true })
    const second = budget.reserve()
    expect(second).toEqual({ ok: false, reason: 'maxActivations=1 reached' })
    expect(budget.exhausted()).toBe('maxActivations=1 reached')
  })

  it('trips maxWallMs from the injected clock', () => {
    const clock = new FakeClock()
    const budget = new Budget({ maxWallMs: 1000 }, clock)
    clock.advance(999)
    expect(budget.exhausted()).toBeUndefined()
    clock.advance(2)
    expect(budget.exhausted()).toBe('maxWallMs=1000 elapsed')
  })

  it('admits exactly maxTasks tasks and never counts a refused one', () => {
    const budget = new Budget({ maxTasks: 2 }, new FakeClock())
    expect(budget.admit()).toEqual({ ok: true })
    expect(budget.admit()).toEqual({ ok: true })
    const third = budget.admit()
    expect(third).toEqual({ ok: false, reason: 'maxTasks=2 reached' })
    expect(budget.snapshot().tasks).toBe(2)
    expect(budget.exhausted()).toBeUndefined()
  })

  it('folds recorded output and usage', () => {
    const budget = new Budget({ maxOutputChars: 10, maxTokens: 300 }, new FakeClock())
    budget.record(6, usageFrom({ inputTokens: 100, outputTokens: 50 }))
    expect(budget.exhausted()).toBeUndefined()
    budget.record(5, usageFrom({ inputTokens: 100, outputTokens: 50 }))
    expect(budget.exhausted()).toBe('maxOutputChars=10 reached')
    expect(budget.snapshot().usage.totalTokens).toBe(300)
  })
})

describe('usage helpers', () => {
  it('usageFrom defaults totalTokens to the component sum', () => {
    expect(usageFrom({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      totalTokens: 18,
    })
  })

  it('addUsage accumulates in place', () => {
    const target = usageFrom({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    addUsage(target, usageFrom({ inputTokens: 2, outputTokens: 3, totalTokens: 5 }))
    expect(target.totalTokens).toBe(7)
  })
})