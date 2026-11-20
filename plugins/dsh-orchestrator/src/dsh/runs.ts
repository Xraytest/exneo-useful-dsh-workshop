/**
 * Live run registry: the bridge between tool calls and in-flight engines.
 * orch_run registers a run here with a live record that engine events keep
 * current, orch_status/orch_cancel read from here, and settled records move
 * into a bounded in-memory history with the FileJournal as the durable tier.
 * @module dsh-orchestrator/dsh/runs
 */
import { renderReport } from '../core/report.js'
import type { OrchestratorEvent, Plan, RunRecord, TaskStatus, TriggerInfo } from '../core/types.js'

export interface LiveRun {
  /** Engine-event-fed mutable snapshot; replaced by the final record on settle. */
  record: RunRecord
  plan: Plan | undefined
  /** Ends when the engine settles; resolves with the final record. */
  settled: Promise<RunRecord>
  /** Abort the whole run; safe to call more than once. */
  cancel(reason?: string): void
  /** Human-facing one-liner for listings. */
  summary(): string
}

const emptyBudget = (): RunRecord['budget'] => ({
  limits: {},
  elapsedMs: 0,
  activations: 0,
  tasks: 0,
  outputChars: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
})

/** Seed a live record for a run the engine is about to create internally. */
export function liveRecord(id: string, goal: string, trigger: TriggerInfo, startedAt: number): RunRecord {
  return {
    id,
    goal,
    parentSessionId: '',
    status: 'running',
    createdAt: startedAt,
    startedAt,
    tasks: {},
    budget: emptyBudget(),
    replans: 0,
    trigger,
  }
}

/** Fold one engine event into the live snapshot. Unknown shapes are ignored. */
export function applyEvent(record: RunRecord, event: OrchestratorEvent): void {
  if (event.type === 'run/plan') {
    record.plan = event.plan
    for (const task of event.plan.tasks) {
      if (record.tasks[task.id] === undefined) {
        record.tasks[task.id] = { spec: task, status: 'pending', attempts: [] }
      }
    }
    return
  }
  if (event.type === 'task/started') {
    const task = record.tasks[event.taskId]
    if (task) task.status = 'running'
    return
  }
  if (event.type === 'task/ended') {
    const task = record.tasks[event.taskId]
    if (task) task.status = event.status as TaskStatus
    return
  }
  if (event.type === 'run/budget') record.budget = { ...record.budget, exhausted: event.reason }
  if (event.type === 'run/ended') record.status = event.status
}

export class RunRegistry {
  private readonly live = new Map<string, LiveRun>()
  private readonly finished: RunRecord[] = []
  private readonly finishedLimit: number

  constructor(finishedLimit = 20) {
    this.finishedLimit = Math.max(1, finishedLimit)
  }

  /** Track one engine execution; call before awaiting the engine promise. */
  register(record: RunRecord, settled: Promise<RunRecord>, cancel: (reason?: string) => void): LiveRun {
    const run: LiveRun = {
      record,
      plan: record.plan,
      settled,
      cancel: (reason?: string) => cancel(reason),
      summary: () => summarize(record, true),
    }
    this.live.set(record.id, run)
    void settled
      .then((final) => {
        run.record = final
        this.finished.unshift(final)
        if (this.finished.length > this.finishedLimit) this.finished.pop()
      })
      .catch(() => undefined)
      .finally(() => {
        this.live.delete(record.id)
      })
    return run
  }

  get(runId: string): LiveRun | undefined {
    return this.live.get(runId)
  }

  running(): LiveRun[] {
    return [...this.live.values()]
  }

  /** Newest finished runs first; live runs are excluded. */
  history(limit = 20): RunRecord[] {
    return this.finished.slice(0, Math.max(1, limit))
  }

  /** The compact orch_status listing. */
  listing(limit = 20): string[] {
    const live = this.running().map((run) => summarize(run.record, true))
    const done = this.history(limit).map((record) => summarize(record, false))
    return [...live, ...done].slice(0, Math.max(1, limit))
  }

  /** Full status projection for one run, live or historical. */
  describe(runId: string): { record: RunRecord; plan: Plan | undefined; live: boolean; report: string } | undefined {
    const run = this.live.get(runId)
    if (run) return { record: run.record, plan: run.plan ?? run.record.plan, live: true, report: renderReport(run.record, run.plan ?? run.record.plan) }
    const done = this.finished.find((record) => record.id === runId)
    if (done === undefined) return undefined
    return { record: done, plan: done.plan, live: false, report: done.report ?? renderReport(done, done.plan) }
  }
}

function summarize(record: RunRecord, running: boolean): string {
  const state = running ? 'running' : record.status
  const tasks = Object.values(record.tasks ?? {})
  const done = tasks.filter((task) => task.status === 'succeeded').length
  const trigger = record.trigger.name === undefined ? '' : ' via ' + record.trigger.name
  return '[' + state + '] ' + record.id + ' - ' + String(done) + '/' + String(tasks.length) + ' tasks' + trigger + ' - ' + record.goal.slice(0, 80)
}

/** Trigger metadata for a tool-initiated run. */
export const toolTrigger = (name = 'orch_run'): TriggerInfo => ({ kind: 'tool', name })
