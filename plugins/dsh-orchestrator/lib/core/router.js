/** Wildcard match supporting `*` (any run of characters). Case-insensitive. */
export function wildcardMatch(pattern, value) {
    const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}
export const EMPTY_ROUTING = { roles: {}, rules: [] };
/**
 * Resolve the route for one task.
 * Precedence: explicit task route → first matching rule → role map → default → inherit.
 */
export function resolveRoute(task, routing) {
    if (task.route && Object.keys(task.route).length > 0) {
        return { route: task.route, source: 'task' };
    }
    for (const rule of routing.rules) {
        const { role, taskId, titleIncludes } = rule.match;
        if (role !== undefined && !wildcardMatch(role, task.role))
            continue;
        if (taskId !== undefined && !wildcardMatch(taskId, task.id))
            continue;
        if (titleIncludes !== undefined && !task.title.toLowerCase().includes(titleIncludes.toLowerCase()))
            continue;
        if (role === undefined && taskId === undefined && titleIncludes === undefined)
            continue;
        return { route: rule.route, source: 'rule', ...(rule.name ? { ruleName: rule.name } : {}) };
    }
    const byRole = routing.roles[task.role];
    if (byRole)
        return { route: byRole, source: 'role' };
    if (routing.default)
        return { route: routing.default, source: 'default' };
    return { route: undefined, source: 'inherit' };
}
/** Merge a resolved route over a base route; defined fields win. */
export function mergeRoute(base, override) {
    if (!base)
        return override;
    if (!override)
        return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(override))
        if (value !== undefined)
            merged[key] = value;
    return Object.keys(merged).length > 0 ? merged : undefined;
}
/** Human-readable route label for reports and events. */
export function routeLabel(route) {
    if (!route)
        return 'inherit';
    const parts = [route.provider, route.model].filter(Boolean).join('/');
    const effort = route.reasoningEffort ? `@${route.reasoningEffort}` : '';
    return `${parts || 'inherit'}${effort}`;
}
