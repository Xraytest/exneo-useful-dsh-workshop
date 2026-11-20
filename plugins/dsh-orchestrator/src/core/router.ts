/**
 * Role / rule based routing: which provider, model, and reasoning effort a task
 * runs on. Pure and deterministic — the first matching rule wins.
 * @module dsh-orchestrator/core/router
 */
import type { Route, RouteSource, RoutingConfig, TaskSpec } from './types.js'

export interface ResolvedRoute {
  readonly route: Route | undefined
  readonly source: RouteSource
  readonly ruleName?: string
}

/** Wildcard match supporting `*` (any run of characters). Case-insensitive. */
export function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value.toLowerCase())
}

export const EMPTY_ROUTING: RoutingConfig = { roles: {}, rules: [] }

/**
 * Resolve the route for one task.
 * Precedence: explicit task route → first matching rule → role map → default → inherit.
 */
export function resolveRoute(task: TaskSpec, routing: RoutingConfig): ResolvedRoute {
  if (task.route && Object.keys(task.route).length > 0) {
    return { route: task.route, source: 'task' }
  }
  for (const rule of routing.rules) {
    const { role, taskId, titleIncludes } = rule.match
    if (role !== undefined && !wildcardMatch(role, task.role)) continue
    if (taskId !== undefined && !wildcardMatch(taskId, task.id)) continue
    if (titleIncludes !== undefined && !task.title.toLowerCase().includes(titleIncludes.toLowerCase())) continue
    if (role === undefined && taskId === undefined && titleIncludes === undefined) continue
    return { route: rule.route, source: 'rule', ...(rule.name ? { ruleName: rule.name } : {}) }
  }
  const byRole = routing.roles[task.role]
  if (byRole) return { route: byRole, source: 'role' }
  if (routing.default) return { route: routing.default, source: 'default' }
  return { route: undefined, source: 'inherit' }
}

/** Route label identity used to dedupe the chain (provider/model/effort). */
const routeKey = (route: Route): string =>
  [route.provider ?? '', route.model ?? '', route.reasoningEffort ?? ''].join('/**/')

/**
 * The deduplicated fallback list for one task: everything configured under
 * routing.fallbacks, minus a duplicate of the primary route. The ENGINE owns
 * the slot layout — attempt 1 is always the primary (possibly undefined =
 * inherit), fallbacks start at attempt 2, and past the end the last repeats.
 */
export function resolveFallbacks(task: TaskSpec, routing: RoutingConfig): Route[] {
  const primary = resolveRoute(task, routing).route
  const out: Route[] = []
  for (const fallback of routing.fallbacks ?? []) {
    if (primary !== undefined && routeKey(fallback) === routeKey(primary)) continue
    if (out.some((entry) => routeKey(entry) === routeKey(fallback))) continue
    out.push(fallback)
  }
  return out
}

/** Merge a resolved route over a base route; defined fields win. */
export function mergeRoute(base: Route | undefined, override: Route | undefined): Route | undefined {
  if (!base) return override
  if (!override) return base
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) if (value !== undefined) merged[key] = value
  return Object.keys(merged).length > 0 ? (merged as Route) : undefined
}

/** Human-readable route label for reports and events. */
export function routeLabel(route: Route | undefined): string {
  if (!route) return 'inherit'
  const parts = [route.provider, route.model].filter(Boolean).join('/')
  const effort = route.reasoningEffort ? `@${route.reasoningEffort}` : ''
  return `${parts || 'inherit'}${effort}`
}