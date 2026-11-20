/**
 * Configuration normalization shared by the plugin config, the orch_run tool
 * options, and the trigger paths. Pure: unknown JSON in, validated
 * {@link RunTuning} out, with per-field provenance kept out of the way.
 * @module dsh-orchestrator/dsh/config
 */
import type { BudgetLimits, JsonObject, Route, RouteRule, RoutingConfig } from '../core/types.js'

export interface RunDefaults {
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly verify: boolean
  readonly maxParallel: number
  readonly maxReplans: number
  readonly maxPlanRepairs: number
  readonly synthesize: boolean
  readonly dependencyContextChars: number
}

export interface RunTuning {
  readonly limits: BudgetLimits
  readonly defaults: RunDefaults
  readonly routing: RoutingConfig
}

export const DEFAULT_TUNING: RunTuning = {
  limits: {},
  defaults: {
    timeoutMs: 20 * 60_000,
    maxAttempts: 2,
    verify: false,
    maxParallel: 3,
    maxReplans: 1,
    maxPlanRepairs: 1,
    synthesize: true,
    dependencyContextChars: 4000,
  },
  routing: { roles: {}, rules: [] },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInt = (value: unknown, fallback: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

const normalizeRoute = (value: unknown): Route | undefined => {
  if (!isRecord(value)) return undefined
  const route: Record<string, unknown> = {}
  for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
    const entry = value[key]
    if (typeof entry === 'string' && entry.trim().length > 0) route[key] = entry.trim()
  }
  if (typeof value['maxTokens'] === 'number' && Number.isInteger(value['maxTokens']) && (value['maxTokens'] as number) > 0) {
    route['maxTokens'] = value['maxTokens'] as number
  }
  return Object.keys(route).length > 0 ? (route as Route) : undefined
}

const normalizeRouting = (value: unknown): RoutingConfig | undefined => {
  if (!isRecord(value)) return undefined
  const roles: Record<string, Route> = {}
  if (isRecord(value['roles'])) {
    for (const [role, entry] of Object.entries(value['roles'])) {
      const route = normalizeRoute(entry)
      if (route) roles[role] = route
    }
  }
  const rules: RouteRule[] = []
  if (Array.isArray(value['rules'])) {
    for (const entry of value['rules']) {
      if (!isRecord(entry) || !isRecord(entry['match'])) continue
      const route = normalizeRoute(entry['route'])
      if (!route) continue
      const match = entry['match'] as Record<string, unknown>
      rules.push({
        ...(typeof entry['name'] === 'string' && entry['name'].trim() ? { name: entry['name'].trim() } : {}),
        match: {
          ...(typeof match['role'] === 'string' ? { role: match['role'] } : {}),
          ...(typeof match['taskId'] === 'string' ? { taskId: match['taskId'] } : {}),
          ...(typeof match['titleIncludes'] === 'string' ? { titleIncludes: match['titleIncludes'] } : {}),
        },
        route,
      })
    }
  }
  const fallback = normalizeRoute(value['default'])
  return { roles, rules, ...(fallback ? { default: fallback } : {}) }
}

const normalizeLimits = (value: unknown): Partial<BudgetLimits> => {
  if (!isRecord(value)) return {}
  const out: Record<string, number> = {}
  for (const key of ['maxWallMs', 'maxActivations', 'maxTasks', 'maxOutputChars', 'maxTokens'] as const) {
    const entry = value[key]
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) out[key] = Math.floor(entry)
  }
  return out
}

const normalizeDefaults = (value: unknown, base: RunDefaults): RunDefaults => {
  if (!isRecord(value)) return base
  return {
    timeoutMs: positiveInt(value['timeoutMs'], base.timeoutMs, 24 * 60 * 60_000),
    maxAttempts: positiveInt(value['maxAttempts'], base.maxAttempts, 8),
    verify: typeof value['verify'] === 'boolean' ? value['verify'] : base.verify,
    maxParallel: positiveInt(value['maxParallel'], base.maxParallel, 16),
    maxReplans: positiveInt(value['maxReplans'], base.maxReplans, 5),
    maxPlanRepairs: positiveInt(value['maxPlanRepairs'], base.maxPlanRepairs, 5),
    synthesize: typeof value['synthesize'] === 'boolean' ? value['synthesize'] : base.synthesize,
    dependencyContextChars: positiveInt(value['dependencyContextChars'], base.dependencyContextChars, 100_000),
  }
}

/** Merge a raw plugin/tool config blob over the shipped defaults. */
export function tuningFromConfig(raw: unknown, base: RunTuning = DEFAULT_TUNING): RunTuning {
  if (!isRecord(raw)) return base
  return {
    limits: { ...base.limits, ...normalizeLimits(raw['limits']) },
    defaults: normalizeDefaults(raw['defaults'], base.defaults),
    routing: normalizeRouting(raw['routing']) ?? base.routing,
  }
}

/**
 * Merge per-call orch_run options over a base tuning. Only fields the call
 * actually sets move; a plan handed to orch_run is not handled here.
 */
export function tuningForCall(raw: unknown, base: RunTuning): RunTuning {
  if (!isRecord(raw)) return base
  const limits = { ...base.limits, ...normalizeLimits(raw['limits']) }
  const defaults = normalizeDefaults(raw['defaults'], base.defaults)
  return { limits, defaults, routing: normalizeRouting(raw['routing']) ?? base.routing }
}

/** Sanitize a caller-provided run id into a filesystem-safe slug. */
export function safeRunId(raw: unknown, fallback: string): string {
  const slug = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) : ''
  return /^[a-z0-9][a-z0-9._-]{0,47}$/.test(slug) ? slug : fallback
}

/** Prove a value is a plain object-rooted JSON value (for tool input trust). */
export function asJsonObject(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined
}
