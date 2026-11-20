/**
 * DAG mechanics: validation, topological waves, readiness, and failure cascades.
 * @module dsh-orchestrator/core/graph
 */
import type { TaskId, TaskSpec, TaskStatus } from './types.js';
export interface GraphIssue {
    readonly code: 'empty' | 'duplicate-id' | 'unknown-dependency' | 'self-dependency' | 'cycle';
    readonly message: string;
    readonly taskIds: readonly TaskId[];
}
/** Validate structure only; semantic limits live in `plan.ts`. */
export declare function validateGraph(tasks: readonly TaskSpec[]): GraphIssue[];
/** Dependency layers; every task in a wave may run in parallel. */
export declare function topologicalWaves(tasks: readonly TaskSpec[]): TaskId[][];
/** Tasks whose dependencies all succeeded and that have not started. */
export declare function readyTasks(tasks: readonly TaskSpec[], statusOf: (id: TaskId) => TaskStatus): TaskSpec[];
/** Every transitive dependent of the given tasks (excluding the seeds). */
export declare function dependentsOf(tasks: readonly TaskSpec[], seeds: readonly TaskId[]): Set<TaskId>;
