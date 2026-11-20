import { describe, expect, it } from 'vitest'
import { Engine, EngineError } from '../src/core/engine.js'
import { CRITIC_SCHEMA, PLAN_SCHEMA } from '../src/core/prompts.js'
import type { ActivationRequest, SubagentPort } from '../src/core/ports.js'
import type { JsonValue, OrchestratorEvent } from '../src/core/types.js'
import {
  FakeClock,
  ScriptedPort,
  makeJournal,
  outcome,
  ports,
  rawPlan,
  request,
  resetUsage,
  usage,
} from './helpers.js'

const engine = (subagents: SubagentPort, clock = new FakeClock(), events: OrchestratorEvent[] = []) =>
  new Engine(ports(subagents, clock, makeJournal(), (e) => events.push(e)))

describe('engine: happy paths', () => {
  it('runs a diamond DAG with parallelism, synthesis, events, and journaling', async () => {
    resetUsage()
    const events: OrchestratorEvent[] = []
    const journal = makeJournal()
    const clock = new FakeClock()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'synthesis') return { outcome: outcome({ text: 'SYNTHESIS DONE' }), usage: usage() }
      return { outcome: outcome({ text: 'result of ' + String(req.taskId) }), usage: usage() }
    })
    const run = await new Engine(ports(sub, clock, journal, (e) => events.push(e))).run(
      request({
        plan: rawPlan([
          { id: 'a', title: 'A', role: 'worker', prompt: 'do a' },
          { id: 'b', title: 'B', role: 'worker', prompt: 'do b' },
          { id: 'c', title: 'C', role: 'worker', prompt: 'do c', dependsOn: ['a', 'b'] },
        ]),
      }),
    )
    expect(run.status).toBe('succeeded')
    expect(run.plan?.tasks.map((task) => task.id)).toEqual(['a', 'b', 'c'])
    expect(sub.maxActive).toBeGreaterThanOrEqual(2)
    expect(run.tasks['a']?.status).toBe('succeeded')
    expect(run.tasks['c']?.output?.text).toBe('result of c')
    expect(run.tasks['c']?.output?.childId).toBe('child-3')
    const cStart = sub.starts.find((s) => s.request.taskId === 'c')
    expect(cStart?.request.prompt).toContain('INPUTS FROM COMPLETED DEPENDENCIES')
    expect(cStart?.request.prompt).toContain('result of a')
    expect(run.synthesis).toBe('SYNTHESIS DONE')
    expect(run.budget.activations).toBe(4)
    expect(run.budget.usage.totalTokens).toBe(600)
    expect(run.report).toContain('# Orchestration')
    expect(run.report).toContain('## Synthesis')
    const kinds = events.map((e) => e.type)
    expect(kinds[0]).toBe('run/created')
    expect(kinds.filter((k) => k === 'run/plan').length).toBe(1)
    expect(kinds.filter((k) => k === 'task/started').length).toBe(3)
    expect(kinds[kinds.length - 1]).toBe('run/ended')
    expect(journal.finalized).toHaveLength(1)
    expect(journal.events.length).toBe(events.length)
  })

  it('respects maxParallel=1 by serializing the wave', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    const base = request({ plan: rawPlan([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) })
    const run = await engine(sub).run({ ...base, defaults: { ...base.defaults, maxParallel: 1 } })
    expect(run.status).toBe('succeeded')
    expect(sub.maxActive).toBe(1)
  })

  it('skips synthesis when disabled by defaults', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    const base = request({ plan: rawPlan([{ id: 'a' }]) })
    const run = await engine(sub).run({ ...base, defaults: { ...base.defaults, synthesize: false } })
    expect(run.status).toBe('succeeded')
    expect(run.synthesis).toBeUndefined()
    expect(sub.byKind('synthesis')).toHaveLength(0)
  })
})

describe('engine: validation and schema', () => {
  it('rejects an invalid caller-supplied plan without any activation', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    const run = await engine(sub).run(request({ plan: { tasks: [] } }))
    expect(run.status).toBe('failed')
    expect(run.failure).toContain('caller-supplied plan is invalid')
    expect(run.plan).toBeUndefined()
    expect(sub.starts).toHaveLength(0)
    expect(run.report).toContain('No plan was admitted')
  })

  it('enforces outputSchema: invalid JSON retries, valid structured output passes', async () => {
    resetUsage()
    let workCalls = 0
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['items'],
    } as const
    const sub = new ScriptedPort((req) => {
      if (req.kind !== 'work') return { outcome: outcome({ text: 'x' }) }
      workCalls += 1
      if (workCalls === 1) return { outcome: outcome({ text: 'no json at all' }) }
      return { outcome: outcome({ text: 'here', structured: { items: ['x'] } }) }
    })
    const run = await engine(sub).run(request({ plan: rawPlan([{ id: 'a', outputSchema: schema }]) }))
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.attempts).toHaveLength(2)
    expect(run.tasks['a']?.attempts[0]?.failure).toBe('schema-invalid')
    expect(sub.prompts()[1]).toContain('no JSON object found')
    expect(run.tasks['a']?.output?.structured).toEqual({ items: ['x'] })
  })

  it('parses fenced JSON from a provider without native structured output', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { outcome: outcome({ text: 'answer follows' + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) + 'json' + String.fromCharCode(10) + '{"items":["a"]}' + String.fromCharCode(10) + String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96) }) }
      return { outcome: outcome({ text: 'ok' }) }
    })
    sub.supportsStructuredOutput = false
    const run = await engine(sub).run(
      request({
        plan: rawPlan([{ id: 'a', outputSchema: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'] } }]),
      }),
    )
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.output?.structured).toEqual({ items: ['a'] })
    expect(sub.prompts()[0]).toContain('fenced block')
  })
})

describe('engine: critic', () => {
  it('rejects on critic verdict, feeds fixes back, accepts on retry', async () => {
    resetUsage()
    let verdicts = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'critic') {
        verdicts += 1
        return verdicts === 1
          ? { outcome: outcome({ structured: { pass: false, reason: 'too thin', fixes: ['add depth analysis'] } }) }
          : { outcome: outcome({ structured: { pass: true, reason: 'good' } }) }
      }
      return { outcome: outcome({ text: 'work result ' + String(req.attempt) }) }
    })
    const base = request({ plan: rawPlan([{ id: 'a', verify: true, acceptance: ['must be deep'] }]) })
    const run = await engine(sub).run({ ...base, defaults: { ...base.defaults, verify: true } })
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.attempts).toHaveLength(2)
    expect(run.tasks['a']?.attempts[0]?.failure).toBe('critic-rejected')
    expect(sub.byKind('critic')).toHaveLength(2)
    const retryPrompt = sub.byKind('work')[1]?.request.prompt
    expect(retryPrompt).toContain('add depth analysis')
    expect(sub.byKind('critic')[0]?.request.outputSchema).toEqual(CRITIC_SCHEMA)
    expect(sub.byKind('critic')[0]?.request.prompt).toContain('must be deep')
  })

  it('a broken critic accepts work with a recorded caveat instead of failing it', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'critic') return { outcome: outcome({ text: 'crashed', stopReason: 'error' }) }
      return { outcome: outcome({ text: 'good work' }) }
    })
    const base = request({ plan: rawPlan([{ id: 'a', verify: true }]) })
    const run = await engine(sub).run({ ...base, defaults: { ...base.defaults, verify: true } })
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.detail).toContain('verification unavailable')
  })
})

describe('engine: failure handling', () => {
  it('classifies stopReason != completed as child-error and fails after retries', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { outcome: outcome({ text: 'partial', stopReason: 'error', diagnostic: 'tool crash' }) }
      return { outcome: outcome({ text: 'x' }) }
    })
    const run = await engine(sub).run(request({ plan: rawPlan([{ id: 'a' }]) }))
    expect(run.status).toBe('failed')
    expect(run.tasks['a']?.status).toBe('failed')
    expect(run.tasks['a']?.attempts).toHaveLength(2)
    expect(run.tasks['a']?.failure).toBe('child-error')
    expect(run.tasks['a']?.detail).toContain('tool crash')
  })

  it('treats a rejected activation promise as non-retryable infra', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { reject: new Error('provider exploded') }
      return { outcome: outcome({ text: 'x' }) }
    })
    const run = await engine(sub).run(request({ plan: rawPlan([{ id: 'a' }]) }))
    expect(run.status).toBe('failed')
    expect(run.tasks['a']?.attempts).toHaveLength(1)
    expect(run.tasks['a']?.failure).toBe('infra')
  })

  it('times out a hanging worker, disposes it, and retries', async () => {
    resetUsage()
    let calls = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind !== 'work') return { outcome: outcome({ text: 'x' }) }
      calls += 1
      return calls === 1 ? { hang: true } : { outcome: outcome({ text: 'recovered' }) }
    })
    const run = await engine(sub).run(
      request({ plan: rawPlan([{ id: 'a', guards: { timeoutMs: 40 } }]) }),
    )
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.attempts[0]?.failure).toBe('timeout')
    expect(run.tasks['a']?.attempts[0]?.detail).toContain('40ms')
    expect(sub.disposals).toEqual(['child-1'])
  })

  it('cancels everything on abort and disposes hanging children', async () => {
    resetUsage()
    const controller = new AbortController()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { hang: true }
      return { outcome: outcome({ text: 'x' }) }
    })
    const pending = engine(sub).run(request({ plan: rawPlan([{ id: 'a' }, { id: 'b' }]), signal: controller.signal }))
    setTimeout(() => controller.abort(), 30)
    const run = await pending
    expect(run.status).toBe('cancelled')
    expect(run.tasks['a']?.status).toBe('cancelled')
    expect(run.tasks['b']?.status).toBe('cancelled')
    expect(run.report).toContain('cancelled')
  })

  it('cascades dependency skips after a failed task', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work' && req.taskId === 'a') return { outcome: outcome({ text: 'x', stopReason: 'error' }) }
      return { outcome: outcome({ text: 'fine' }) }
    })
    const run = await engine(sub).run(
      request({
        plan: rawPlan([
          { id: 'a', critical: false },
          { id: 'b', dependsOn: ['a'], critical: false },
          { id: 'c', dependsOn: ['b'], critical: false },
          { id: 'd' },
        ]),
      }),
    )
    expect(run.status).toBe('partial')
    expect(run.tasks['a']?.status).toBe('failed')
    expect(run.tasks['b']?.status).toBe('skipped')
    expect(run.tasks['b']?.failure).toBe('dependency')
    expect(run.tasks['c']?.status).toBe('skipped')
    expect(run.tasks['d']?.status).toBe('succeeded')
  })
})

describe('engine: budget', () => {
  it('skips unaffordable tasks and skips synthesis when activations run out', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'synthesis') return { outcome: outcome({ text: 'S' }) }
      return { outcome: outcome({ text: 'work' }) }
    })
    const run = await engine(sub).run(
      request({
        plan: rawPlan([{ id: 'a' }, { id: 'b' }, { id: 'c', critical: false }]),
        limits: { maxActivations: 2 },
      }),
    )
    expect(run.tasks['a']?.status).toBe('succeeded')
    expect(run.tasks['b']?.status).toBe('succeeded')
    expect(run.tasks['c']?.status).toBe('skipped')
    expect(run.tasks['c']?.failure).toBe('budget')
    expect(run.status).toBe('partial')
    expect(run.synthesis).toBeUndefined()
    expect(run.budget.exhausted).toContain('maxActivations')
  })
})

describe('engine: planner and replan', () => {
  it('plans through the helper, repairs once, and passes PLAN_SCHEMA', async () => {
    resetUsage()
    let plans = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'plan') {
        plans += 1
        return plans === 1
          ? { outcome: outcome({ structured: { tasks: [] } as unknown as JsonValue }) }
          : { outcome: outcome({ structured: rawPlan([{ id: 'a' }]) as unknown as JsonValue }) }
      }
      return { outcome: outcome({ text: 'done' }) }
    })
    const run = await engine(sub).run(request({}))
    expect(run.status).toBe('succeeded')
    expect(plans).toBe(2)
    const first = sub.byKind('plan')[0]?.request
    expect(first?.prompt).toContain('build the thing')
    expect(first?.prompt).toContain('PLANNING stage')
    expect(first?.outputSchema).toEqual(PLAN_SCHEMA)
    expect(first?.nameHint).toBe('orch-run-1-plan1')
    const repair = sub.byKind('plan')[1]?.request
    expect(repair?.prompt).toContain('plan.tasks must be a non-empty array')
    expect(repair?.prompt).toContain('PREVIOUS PLAN')
  })

  it('fails the run when the planner never converges', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'plan') return { outcome: outcome({ structured: { tasks: [] } }) }
      return { outcome: outcome({ text: 'x' }) }
    })
    const run = await engine(sub).run(request({}))
    expect(run.status).toBe('failed')
    expect(run.failure).toContain('no valid plan after 2 attempt')
  })

  it('replans once after a critical failure and completes via the replacement task', async () => {
    resetUsage()
    let replans = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'replan') {
        replans += 1
        return { outcome: outcome({ structured: rawPlan([{ id: 'a2', prompt: 'redo a better' }]) as unknown as JsonValue }) }
      }
      if (req.kind === 'work' && req.taskId === 'a') return { outcome: outcome({ text: 'x', stopReason: 'error' }) }
      return { outcome: outcome({ text: 'fine' }) }
    })
    const base = request({ plan: rawPlan([{ id: 'a' }, { id: 'keep' }]) })
    const run = await engine(sub).run({ ...base, defaults: { ...base.defaults, maxReplans: 1 } })
    expect(replans).toBe(1)
    expect(run.replans).toBe(1)
    expect(run.tasks['a']?.status).toBe('failed')
    expect(run.tasks['keep']?.status).toBe('succeeded')
    expect(run.tasks['a2']?.status).toBe('succeeded')
    expect(run.status).toBe('succeeded')
    const replanPrompt = sub.byKind('replan')[0]?.request.prompt ?? ''
    expect(replanPrompt).toContain('RE-PLANNING stage')
    expect(replanPrompt).toContain('- a (a):')
    expect(run.plan?.tasks.map((task) => task.id)).toContain('a2')
  })
})

describe('engine: routing', () => {
  it('resolves routes with rule > role > inherit precedence and forwards them', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    const run = await engine(sub).run(
      request({
        plan: rawPlan([
          { id: 'scan-api', title: 'Scan the API', role: 'coder' },
          { id: 'plain', role: 'coder' },
          { id: 'other', role: 'writer' },
        ]),
        routing: {
          roles: { coder: { provider: 'deepseek', model: 'coder-model' } },
          rules: [{ match: { titleIncludes: 'scan' }, route: { provider: 'glm', reasoningEffort: 'high' } }],
        },
      }),
    )
    expect(run.status).toBe('succeeded')
    expect(run.tasks['scan-api']?.route).toEqual({ provider: 'glm', reasoningEffort: 'high' })
    expect(run.tasks['scan-api']?.routeSource).toBe('rule')
    expect(run.tasks['plain']?.route).toEqual({ provider: 'deepseek', model: 'coder-model' })
    expect(run.tasks['plain']?.routeSource).toBe('role')
    expect(run.tasks['other']?.route).toBeUndefined()
    expect(run.tasks['other']?.routeSource).toBe('inherit')
    const forwarded = sub.byKind('work').map((s) => s.request.route)
    expect(forwarded[0]).toEqual({ provider: 'glm', reasoningEffort: 'high' })
  })
})

describe('engine: helpers and records', () => {
  it('records per-attempt usage and stop reasons', async () => {
    resetUsage()
    let calls = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind !== 'work') return { outcome: outcome({ text: 'x' }) }
      calls += 1
      return calls === 1
        ? { outcome: outcome({ text: 'bad', stopReason: 'error' }), usage: usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) }
        : { outcome: outcome({ text: 'ok' }), usage: usage({ inputTokens: 20, outputTokens: 8, totalTokens: 28 }) }
    })
    const run = await engine(sub).run(request({ plan: rawPlan([{ id: 'a' }]) }))
    expect(run.tasks['a']?.attempts[0]?.stopReason).toBe('error')
    expect(run.tasks['a']?.attempts[0]?.usage?.totalTokens).toBe(15)
    expect(run.tasks['a']?.attempts[1]?.usage?.totalTokens).toBe(28)
    expect(run.budget.usage.totalTokens).toBe(43)
    expect(run.tasks['a']?.attempts[0]?.childName).toBe('sc-1')
  })

  it('throws EngineError with issues for direct validation use', () => {
    const error = new EngineError('bad', ['issue one', 'issue two'])
    expect(error.issues).toEqual(['issue one', 'issue two'])
    expect(error.name).toBe('EngineError')
  })
})

describe('engine: review hardening', () => {
  it('treats refusal as a terminal, non-retryable failure', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { outcome: outcome({ text: 'no', stopReason: 'refusal', diagnostic: 'policy denied' }) }
      return { outcome: outcome({ text: 'x' }) }
    })
    const run = await engine(sub).run(request({ plan: rawPlan([{ id: 'a' }]) }))
    expect(run.status).toBe('failed')
    expect(run.tasks['a']?.failure).toBe('refusal')
    expect(run.tasks['a']?.detail).toContain('policy denied')
    expect(run.tasks['a']?.attempts).toHaveLength(1)
  })

  it('feeds a planner activation failure into the repair loop instead of failing the run', async () => {
    resetUsage()
    let calls = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'plan') {
        calls += 1
        return calls === 1 ? { reject: new Error('spawn unavailable') } : { outcome: outcome({ structured: rawPlan([{ id: 'a' }]) as unknown as JsonValue }) }
      }
      return { outcome: outcome({ text: 'done' }) }
    })
    const run = await engine(sub).run(request({}))
    expect(run.status).toBe('succeeded')
    expect(calls).toBe(2)
    expect(sub.byKind('plan')[1]?.request.prompt).toContain('planner activation failed')
  })

  it('does not record routes the backend cannot honour', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    sub.supportsRouting = false
    const run = await engine(sub).run(
      request({
        plan: rawPlan([{ id: 'a', title: 'Scan', role: 'coder' }]),
        routing: { roles: { coder: { provider: 'p', model: 'm' } }, rules: [] },
      }),
    )
    expect(run.status).toBe('succeeded')
    expect(run.tasks['a']?.route).toBeUndefined()
    expect(run.tasks['a']?.routeSource).toBe('inherit')
  })

  it('rejects an over-ceiling planner plan, repairs it, and admits exactly the ceiling', async () => {
    resetUsage()
    let plans = 0
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'plan') {
        plans += 1
        const tasks = plans === 1
          ? [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
          : [{ id: 'a' }, { id: 'b' }]
        return { outcome: outcome({ structured: rawPlan(tasks) as unknown as JsonValue }) }
      }
      if (req.kind === 'synthesis') return { outcome: outcome({ text: 'S' }) }
      return { outcome: outcome({ text: 'work' }) }
    })
    const run = await engine(sub).run(request({ limits: { maxTasks: 2 } }))
    expect(plans).toBe(2)
    expect(sub.byKind('plan')[1]?.request.prompt).toContain('the limit is 2')
    expect(run.tasks['a']?.status).toBe('succeeded')
    expect(run.tasks['b']?.status).toBe('succeeded')
    expect(run.tasks['c']).toBeUndefined()
    expect(run.budget.tasks).toBe(2)
    expect(run.status).toBe('succeeded')
  })

  it('rejects a caller plan that exceeds the per-run maxTasks instead of truncating it', async () => {
    resetUsage()
    const sub = new ScriptedPort()
    const run = await engine(sub).run(
      request({ plan: rawPlan([{ id: 'a' }, { id: 'b' }]), limits: { maxTasks: 1 } }),
    )
    expect(run.status).toBe('failed')
    expect(run.failure).toContain('caller-supplied plan is invalid')
    expect(run.failure).toContain('the limit is 1')
    expect(sub.starts).toHaveLength(0)
  })
})