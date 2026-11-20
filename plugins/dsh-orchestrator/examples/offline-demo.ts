/**
 * Offline demonstration of the pure orchestration engine.
 * No harness, no network: a scripted SubagentPort plays planner, workers,
 * critic, and synthesizer so the whole DAG lifecycle is visible end to end.
 *
 * Run: npm run demo
 */
import { Engine } from '../src/core/engine.js'
import { systemClock } from '../src/core/budget.js'
import { noopJournal } from '../src/core/ports.js'
import type { ActivationOutcome, ActivationRequest, SubagentPort } from '../src/core/ports.js'
import type { RunRecord } from '../src/core/types.js'

/** Deterministic stand-in for the harness subagent provider. */
const scripted: SubagentPort = {
  providerName: 'offline-demo',
  supportsStructuredOutput: true,
  supportsRouting: true,
  async start(request: ActivationRequest) {
    const tag = request.kind + (request.taskId ? ':' + request.taskId : '') + '#' + String(request.attempt)
    console.log('  -> start ' + tag)
    let outcome: ActivationOutcome
    if (request.kind === 'plan' || request.kind === 'replan') {
      outcome = {
        text: 'plan',
        structured: {
          goal: 'Survey the repo and write a one-page brief',
          rationale: 'scan first, summarize last',
          tasks: [
            { id: 'scan', title: 'Scan the repository', role: 'researcher', prompt: 'List the modules and their roles.', acceptance: ['every package is named'] },
            { id: 'assess', title: 'Assess quality', role: 'reviewer', prompt: 'Judge test coverage.', dependsOn: ['scan'], acceptance: ['risks are listed'] },
            { id: 'brief', title: 'Write the brief', role: 'writer', prompt: 'Write a one-page brief.', dependsOn: ['scan', 'assess'], critical: true },
          ],
          synthesis: { enabled: true },
        },
        stopReason: 'completed',
      }
    } else if (request.kind === 'critic') {
      outcome = {
        text: 'looks complete',
        structured: { pass: true, reason: 'all acceptance criteria are met' },
        stopReason: 'completed',
      }
    } else if (request.kind === 'synthesis') {
      outcome = {
        text: 'Three tasks completed: the repo scan found the modules, the review found no blockers, and the brief is written.',
        stopReason: 'completed',
      }
    } else if (request.taskId === 'scan') {
      outcome = { text: 'Modules found: core (engine), adapters, tools.', stopReason: 'completed' }
    } else if (request.taskId === 'assess') {
      outcome = { text: 'Coverage is good; one risk: the adapter is not yet wired.', stopReason: 'completed' }
    } else {
      outcome = { text: 'The brief is written and attached.', stopReason: 'completed' }
    }
    return {
      childId: 'demo-child-' + tag,
      name: 'demo-' + tag,
      result: Promise.resolve(outcome),
      dispose: async () => {},
    }
  },
}

const run: RunRecord = await new Engine({
  subagents: scripted,
  clock: systemClock,
  random: () => 0.5,
  journal: { ...noopJournal, append: (event) => console.log('  [event] ' + event.type) },
  emit: () => {},
}).run({
  id: 'demo-run',
  goal: 'Survey the repo and write a one-page brief',
  parent: { sessionId: 'demo-session', agent: null },
  limits: { maxActivations: 12 },
  defaults: {
    timeoutMs: 60_000,
    maxAttempts: 2,
    verify: false,
    maxParallel: 3,
    maxReplans: 1,
    maxPlanRepairs: 1,
    synthesize: true,
    dependencyContextChars: 4000,
  },
  routing: { roles: { researcher: { reasoningEffort: 'low' } }, rules: [] },
  trigger: { kind: 'programmatic', name: 'offline-demo' },
  signal: new AbortController().signal,
})

console.log()
console.log(run.report ?? '')
console.log()
console.log('final status: ' + run.status + ' - activations: ' + String(run.budget.activations) + ' - replans: ' + String(run.replans))
if (run.status !== 'succeeded') process.exitCode = 1
