/**
 * DAG mechanics: validation, topological waves, readiness, and failure cascades.
 * @module dsh-orchestrator/core/graph
 */
import type { TaskId, TaskSpec, TaskStatus } from './types.js'

export interface GraphIssue {
  readonly code: 'empty' | 'duplicate-id' | 'unknown-dependency' | 'self-dependency' | 'cycle'
  readonly message: string
  readonly taskIds: readonly TaskId[]
}

/** Validate structure only; semantic limits live in `plan.ts`. */
export function validateGraph(tasks: readonly TaskSpec[]): GraphIssue[] {
  const issues: GraphIssue[] = []
  if (tasks.length === 0) {
    return [{ code: 'empty', message: 'plan contains no tasks', taskIds: [] }]
  }
  const seen = new Set<TaskId>()
  for (const task of tasks) {
    if (seen.has(task.id)) {
      issues.push({ code: 'duplicate-id', message: `duplicate task id "${task.id}"`, taskIds: [task.id] })
    }
    seen.add(task.id)
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        issues.push({ code: 'self-dependency', message: `task "${task.id}" depends on itself`, taskIds: [task.id] })
      } else if (!seen.has(dep)) {
        issues.push({
          code: 'unknown-dependency',
          message: `task "${task.id}" depends on unknown task "${dep}"`,
          taskIds: [task.id, dep],
        })
      }
    }
  }
  const cycle = findCycle(tasks)
  if (cycle.length > 0) {
    issues.push({ code: 'cycle', message: `dependency cycle: ${cycle.join(' -> ')}`, taskIds: cycle })
  }
  return issues
}

/** Kahn's algorithm; returns one cycle witness when the graph cannot be drained. */
function findCycle(tasks: readonly TaskSpec[]): TaskId[] {
  const indegree = new Map<TaskId, number>()
  const edges = new Map<TaskId, TaskId[]>()
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    indegree.set(task.id, 0)
    edges.set(task.id, [])
  }
  for (const task of tasks) {
    for (const dep of new Set(task.dependsOn)) {
      if (!ids.has(dep) || dep === task.id) continue
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1)
      edges.get(dep)!.push(task.id)
    }
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id)
  let drained = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    drained += 1
    for (const next of edges.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, degree)
      if (degree === 0) queue.push(next)
    }
  }
  if (drained === tasks.length) return []
  // Walk the residual graph until a node repeats: that walk is a real cycle.
  const residual = [...indegree].filter(([, degree]) => degree > 0).map(([id]) => id)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const path: TaskId[] = []
  const visited = new Set<TaskId>()
  let cursor: TaskId | undefined = residual[0]
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor)
    path.push(cursor)
    cursor = byId.get(cursor)?.dependsOn.find((dep) => indegree.get(dep) !== 0 && ids.has(dep))
  }
  return cursor ? [...path.slice(path.indexOf(cursor)), cursor] : residual
}

/** Dependency layers; every task in a wave may run in parallel. */
export function topologicalWaves(tasks: readonly TaskSpec[]): TaskId[][] {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn.filter((dep) => dep !== task.id))]))
  const known = new Set(tasks.map((task) => task.id))
  for (const deps of remaining.values()) {
    for (const dep of [...deps]) if (!known.has(dep)) deps.delete(dep)
  }
  const waves: TaskId[][] = []
  while (remaining.size > 0) {
    const wave = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id)
    if (wave.length === 0) break
    waves.push(wave)
    for (const id of wave) remaining.delete(id)
    for (const deps of remaining.values()) for (const id of wave) deps.delete(id)
  }
  return waves
}

/** Tasks whose dependencies all succeeded and that have not started. */
export function readyTasks(
  tasks: readonly TaskSpec[],
  statusOf: (id: TaskId) => TaskStatus,
): TaskSpec[] {
  return tasks.filter(
    (task) =>
      statusOf(task.id) === 'pending' &&
      task.dependsOn.every((dep) => dep === task.id || statusOf(dep) === 'succeeded'),
  )
}

/** Every transitive dependent of the given tasks (excluding the seeds). */
export function dependentsOf(tasks: readonly TaskSpec[], seeds: readonly TaskId[]): Set<TaskId> {
  const out = new Set<TaskId>()
  const frontier = [...seeds]
  while (frontier.length > 0) {
    const id = frontier.pop()!
    for (const task of tasks) {
      if (task.dependsOn.includes(id) && !out.has(task.id) && !seeds.includes(task.id)) {
        out.add(task.id)
        frontier.push(task.id)
      }
    }
  }
  for (const seed of seeds) out.delete(seed)
  return out
}
