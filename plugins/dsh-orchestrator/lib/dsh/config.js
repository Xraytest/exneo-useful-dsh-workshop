export const DEFAULT_TUNING = {
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
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const positiveInt = (value, fallback, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return fallback;
    return Math.min(Math.floor(value), max);
};
const normalizeRoute = (value) => {
    if (!isRecord(value))
        return undefined;
    const route = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
        const entry = value[key];
        if (typeof entry === 'string' && entry.trim().length > 0)
            route[key] = entry.trim();
    }
    if (typeof value['maxTokens'] === 'number' && Number.isInteger(value['maxTokens']) && value['maxTokens'] > 0) {
        route['maxTokens'] = value['maxTokens'];
    }
    return Object.keys(route).length > 0 ? route : undefined;
};
const normalizeRouting = (value) => {
    if (!isRecord(value))
        return undefined;
    const roles = {};
    if (isRecord(value['roles'])) {
        for (const [role, entry] of Object.entries(value['roles'])) {
            const route = normalizeRoute(entry);
            if (route)
                roles[role] = route;
        }
    }
    const rules = [];
    if (Array.isArray(value['rules'])) {
        for (const entry of value['rules']) {
            if (!isRecord(entry) || !isRecord(entry['match']))
                continue;
            const route = normalizeRoute(entry['route']);
            if (!route)
                continue;
            const match = entry['match'];
            rules.push({
                ...(typeof entry['name'] === 'string' && entry['name'].trim() ? { name: entry['name'].trim() } : {}),
                match: {
                    ...(typeof match['role'] === 'string' ? { role: match['role'] } : {}),
                    ...(typeof match['taskId'] === 'string' ? { taskId: match['taskId'] } : {}),
                    ...(typeof match['titleIncludes'] === 'string' ? { titleIncludes: match['titleIncludes'] } : {}),
                },
                route,
            });
        }
    }
    const fallback = normalizeRoute(value['default']);
    const fallbackRoutes = [];
    if (Array.isArray(value['fallbacks'])) {
        for (const entry of value['fallbacks']) {
            const route = normalizeRoute(entry);
            if (route)
                fallbackRoutes.push(route);
        }
    }
    return {
        roles,
        rules,
        ...(fallback ? { default: fallback } : {}),
        ...(fallbackRoutes.length > 0 ? { fallbacks: fallbackRoutes } : {}),
    };
};
const normalizeLimits = (value) => {
    if (!isRecord(value))
        return {};
    const out = {};
    for (const key of ['maxWallMs', 'maxActivations', 'maxTasks', 'maxOutputChars', 'maxTokens']) {
        const entry = value[key];
        if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
            out[key] = Math.floor(entry);
    }
    return out;
};
const normalizeDefaults = (value, base) => {
    if (!isRecord(value))
        return base;
    return {
        timeoutMs: positiveInt(value['timeoutMs'], base.timeoutMs, 24 * 60 * 60_000),
        maxAttempts: positiveInt(value['maxAttempts'], base.maxAttempts, 8),
        verify: typeof value['verify'] === 'boolean' ? value['verify'] : base.verify,
        maxParallel: positiveInt(value['maxParallel'], base.maxParallel, 16),
        maxReplans: positiveInt(value['maxReplans'], base.maxReplans, 5),
        maxPlanRepairs: positiveInt(value['maxPlanRepairs'], base.maxPlanRepairs, 5),
        synthesize: typeof value['synthesize'] === 'boolean' ? value['synthesize'] : base.synthesize,
        dependencyContextChars: positiveInt(value['dependencyContextChars'], base.dependencyContextChars, 100_000),
    };
};
/** Merge a raw plugin/tool config blob over the shipped defaults. */
export function tuningFromConfig(raw, base = DEFAULT_TUNING) {
    if (!isRecord(raw))
        return base;
    return {
        limits: { ...base.limits, ...normalizeLimits(raw['limits']) },
        defaults: normalizeDefaults(raw['defaults'], base.defaults),
        routing: normalizeRouting(raw['routing']) ?? base.routing,
    };
}
/**
 * Merge per-call orch_run options over a base tuning. Only fields the call
 * actually sets move; a plan handed to orch_run is not handled here.
 */
export function tuningForCall(raw, base) {
    if (!isRecord(raw))
        return base;
    const limits = { ...base.limits, ...normalizeLimits(raw['limits']) };
    const defaults = normalizeDefaults(raw['defaults'], base.defaults);
    return { limits, defaults, routing: normalizeRouting(raw['routing']) ?? base.routing };
}
/** Sanitize a caller-provided run id into a filesystem-safe slug. */
export function safeRunId(raw, fallback) {
    const slug = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) : '';
    return /^[a-z0-9][a-z0-9._-]{0,47}$/.test(slug) ? slug : fallback;
}
/** Prove a value is a plain object-rooted JSON value (for tool input trust). */
export function asJsonObject(value) {
    return isRecord(value) ? value : undefined;
}
