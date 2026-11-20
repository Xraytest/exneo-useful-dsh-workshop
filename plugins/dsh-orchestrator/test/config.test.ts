import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING, safeRunId, tuningForCall, tuningFromConfig } from '../src/dsh/config.js'

describe('tuningFromConfig', () => {
  it('keeps defaults for garbage input', () => {
    expect(tuningFromConfig(null)).toEqual(DEFAULT_TUNING)
    expect(tuningFromConfig('nope')).toEqual(DEFAULT_TUNING)
    expect(tuningFromConfig({}).limits).toEqual({})
  })

  it('absorbs valid fields and drops invalid ones', () => {
    const tuning = tuningFromConfig({
      limits: { maxActivations: 12, maxTasks: -3, maxTokens: 'lots' },
      defaults: { timeoutMs: 30_000, verify: true, maxParallel: 99, synthesize: false },
      routing: {
        roles: { coder: { provider: 'p', model: 'm', junk: 1 } },
        rules: [{ name: 'research', match: { role: 'res*' }, route: { reasoningEffort: 'high' } }, { match: {}, route: {} }],
        default: { model: 'def-model' },
      },
    })
    expect(tuning.limits).toEqual({ maxActivations: 12 })
    expect(tuning.defaults.timeoutMs).toBe(30_000)
    expect(tuning.defaults.verify).toBe(true)
    expect(tuning.defaults.maxParallel).toBe(16)
    expect(tuning.defaults.synthesize).toBe(false)
    expect(tuning.routing.roles['coder']).toEqual({ provider: 'p', model: 'm' })
    expect(tuning.routing.rules).toHaveLength(1)
    expect(tuning.routing.rules[0]).toEqual({ name: 'research', match: { role: 'res*' }, route: { reasoningEffort: 'high' } })
    expect(tuning.routing.default).toEqual({ model: 'def-model' })
  })
})

describe('tuningForCall', () => {
  it('only moves the fields the call sets', () => {
    const base = tuningFromConfig({ limits: { maxActivations: 9 }, defaults: { verify: true } })
    const call = tuningForCall({ limits: { maxActivations: 4 }, defaults: { maxParallel: 2 } }, base)
    expect(call.limits).toEqual({ maxActivations: 4 })
    expect(call.defaults.maxParallel).toBe(2)
    expect(call.defaults.verify).toBe(true)
  })
})

describe('safeRunId', () => {
  it('sanitizes or falls back', () => {
    expect(safeRunId('Survey 2024!', 'run')).toBe('survey-2024')
    expect(safeRunId('../../etc/passwd', 'run')).toBe('run')
    expect(safeRunId('', 'fallback-9')).toBe('fallback-9')
    expect(safeRunId(undefined, 'fallback-9')).toBe('fallback-9')
  })
})
