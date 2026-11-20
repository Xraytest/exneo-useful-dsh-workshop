import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_LIMITS, normalizePlan, planIsJournalSafe, planSummary, slugify } from '../src/core/plan.js'
import { rawPlan } from './helpers.js'

describe('slugify', () => {
  it('normalizes arbitrary input into harness-safe ids', () => {
    expect(slugify('Scan The API!', 'x')).toBe('scan-the-api')
    expect(slugify('123 leading digits', 'x')).toBe('leading-digits')
    expect(slugify('UPPER', 'x')).toBe('upper')
    expect(slugify('---', 'fallback-here')).toBe('fallback-here')
  })
})

describe('normalizePlan', () => {
  it('normalizes a full raw plan', () => {
    const result = normalizePlan(
      rawPlan(
        [
          {
            id: 'scan-api',
            title: 'Scan the API',
            role: 'researcher',
            prompt: 'enumerate endpoints',
            dependsOn: [],
            acceptance: ['list every route'],
            critical: true,
          },
          { id: 'report', prompt: 'write it up', dependsOn: ['scan-api'] },
        ],
        { rationale: 'two steps', synthesis: { enabled: false } },
      ),
      'goal text',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.goal).toBe('goal text')
    expect(result.plan.rationale).toBe('two steps')
    expect(result.plan.synthesis.enabled).toBe(false)
    expect(result.plan.tasks[0]?.critical).toBe(true)
    expect(result.plan.tasks[1]?.critical).toBe(true)
    expect(result.plan.tasks[1]?.verify).toBe(false)
  })

  it('rejects structural violations with repairable issues', () => {
    const result = normalizePlan({ tasks: [{ id: 'b', prompt: 'x', dependsOn: ['a'] }] }, 'g')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(' ')).toContain('unknown task "a"')
  })

  it('rejects empty and non-array task lists', () => {
    expect(normalizePlan({ tasks: [] }, 'g')).toEqual({ ok: false, issues: ['plan.tasks must be a non-empty array'] })
    expect(normalizePlan('nope', 'g').ok).toBe(false)
  })

  it('normalizes illegal ids and reports the change', () => {
    const result = normalizePlan(rawPlan([{ id: 'Has Spaces!', prompt: 'x' }]), 'g')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(' ')).toContain('was normalized to')
  })

  it('enforces maxTasks', () => {
    const many = Array.from({ length: DEFAULT_PLAN_LIMITS.maxTasks + 1 }, (_, i) => ({ id: 't' + String(i), prompt: 'x' }))
    const result = normalizePlan(rawPlan(many), 'g')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(' ')).toContain('the limit is ' + String(DEFAULT_PLAN_LIMITS.maxTasks))
  })

  it('rejects non-object-rooted output schemas', () => {
    const result = normalizePlan(rawPlan([{ id: 'a', prompt: 'x', outputSchema: { type: 'array', items: { type: 'string' } } }]), 'g')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.join(' ')).toContain('object-rooted')
  })
})

describe('plan projections', () => {
  it('summarizes tasks and reports journal safety', () => {
    const result = normalizePlan(rawPlan([{ id: 'a', prompt: 'x', outputSchema: { type: 'object', additionalProperties: false, properties: {} } }]), 'g')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(planIsJournalSafe(result.plan)).toBe(true)
    expect(planSummary(result.plan)[0]).toMatchObject({ id: 'a', structured: true, critical: true })
  })
})
