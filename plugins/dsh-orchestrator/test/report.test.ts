import { describe, expect, it } from 'vitest'
import { Engine } from '../src/core/engine.js'
import { renderReport } from '../src/core/report.js'
import { FakeClock, ScriptedPort, makeJournal, outcome, ports, rawPlan, request, resetUsage } from './helpers.js'

describe('renderReport', () => {
  it('renders a successful run with plan, artifacts, and synthesis', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'synthesis') return { outcome: { text: 'final answer', stopReason: 'completed' } }
      return { outcome: { text: 'did ' + String(req.taskId), stopReason: 'completed' } }
    })
    const run = await new Engine(ports(sub, new FakeClock(), makeJournal())).run(
      request({ plan: rawPlan([{ id: 'a', title: 'Alpha', prompt: 'x' }, { id: 'b', title: 'Beta', prompt: 'y', dependsOn: ['a'] }]) }),
    )
    const report = renderReport(run, run.plan)
    expect(report).toContain('# Orchestration')
    expect(report).toContain('- goal: build the thing')
    expect(report).toContain('**a**')
    expect(report).toContain('**b**')
    expect(report).toContain('— Beta')
    expect(report).toContain('depends on: a')
    expect(report).toContain('## Artifacts')
    expect(report).toContain('child sc-1')
    expect(report).toContain('## Synthesis')
    expect(report).toContain('final answer')
    expect(report).not.toContain('## Unresolved')
  })

  it('renders unresolved critical tasks and handles missing plans', async () => {
    resetUsage()
    const sub = new ScriptedPort((req) => {
      if (req.kind === 'work') return { outcome: outcome({ text: 'x', stopReason: 'error' }) }
      return { outcome: outcome({ text: 'x' }) }
    })
    const failed = await new Engine(ports(sub, new FakeClock(), makeJournal())).run(
      request({ plan: rawPlan([{ id: 'a', title: 'Broken', prompt: 'x' }]) }),
    )
    const failedReport = renderReport(failed, failed.plan)
    expect(failedReport).toContain('## Unresolved')
    expect(failedReport).toContain('child-error')
    const crashed = await new Engine(ports(sub, new FakeClock(), makeJournal())).run(request({ plan: { tasks: [] } }))
    const crashedReport = renderReport(crashed)
    expect(crashedReport).toContain('No plan was admitted')
  })
})