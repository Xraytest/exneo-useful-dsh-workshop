/**
 * Turn a model-authored (or user-authored) plan value into a validated `Plan`.
 * Every rejection carries a repair instruction the planner can act on.
 * @module dsh-orchestrator/core/plan
 */
import { validateGraph } from './graph.js';
import { assertObjectSchema, isPlainJson } from './jsonschema.js';
export const DEFAULT_PLAN_LIMITS = {
    maxTasks: 24,
    maxPromptChars: 8000,
    maxDependencies: 12,
};
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** Normalize an id into the harness-safe slug used for task ids and child names. */
export function slugify(input, fallback) {
    const slug = input
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z]+/, '')
        .replace(/-+/g, '-')
        .replace(/[-_]+$/, '')
        .slice(0, 32);
    return ID_PATTERN.test(slug) ? slug : fallback;
}
function normalizeRoute(value) {
    if (!isRecord(value))
        return undefined;
    const route = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
        const entry = asString(value[key]);
        if (entry)
            route[key] = entry;
    }
    if (typeof value['maxTokens'] === 'number' && Number.isInteger(value['maxTokens']) && value['maxTokens'] > 0) {
        route['maxTokens'] = value['maxTokens'];
    }
    return Object.keys(route).length > 0 ? route : undefined;
}
/**
 * Validate and normalize one raw plan.
 * @param raw - parsed JSON from the planner subagent or from a caller-supplied plan.
 * @param goal - run goal; used when the plan omits its own.
 * @param limits - structural ceilings enforced before any subagent starts.
 */
export function normalizePlan(raw, goal, limits = DEFAULT_PLAN_LIMITS) {
    const issues = [];
    if (!isRecord(raw))
        return { ok: false, issues: ['plan must be a JSON object with a "tasks" array'] };
    const rawTasks = raw['tasks'];
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
        return { ok: false, issues: ['plan.tasks must be a non-empty array'] };
    }
    if (rawTasks.length > limits.maxTasks) {
        issues.push(`plan.tasks has ${rawTasks.length} entries; the limit is ${limits.maxTasks}. Merge related work into fewer tasks.`);
    }
    const tasks = [];
    const usedIds = new Set();
    for (const [index, entry] of rawTasks.entries()) {
        const label = `tasks[${index}]`;
        if (!isRecord(entry)) {
            issues.push(`${label} must be an object`);
            continue;
        }
        const rawId = asString(entry['id']) ?? `task-${index + 1}`;
        const id = slugify(rawId, `task-${index + 1}`);
        if (id !== rawId)
            issues.push(`${label}.id "${rawId}" was normalized to "${id}"; ids must match ${ID_PATTERN}`);
        if (usedIds.has(id)) {
            issues.push(`${label}.id "${id}" is duplicated; every task id must be unique`);
            continue;
        }
        usedIds.add(id);
        const prompt = asString(entry['prompt']);
        if (!prompt) {
            issues.push(`${label}.prompt is required and must be a non-empty instruction`);
            continue;
        }
        if (prompt.length > limits.maxPromptChars) {
            issues.push(`${label}.prompt exceeds ${limits.maxPromptChars} characters`);
        }
        const title = asString(entry['title']) ?? id;
        const role = asString(entry['role']) ?? 'worker';
        const dependsOn = [];
        if (entry['dependsOn'] !== undefined) {
            if (!Array.isArray(entry['dependsOn'])) {
                issues.push(`${label}.dependsOn must be an array of task ids`);
            }
            else {
                for (const dep of entry['dependsOn']) {
                    const depId = asString(dep);
                    if (!depId)
                        issues.push(`${label}.dependsOn entries must be non-empty strings`);
                    else if (!dependsOn.includes(depId))
                        dependsOn.push(depId);
                }
                if (dependsOn.length > limits.maxDependencies) {
                    issues.push(`${label}.dependsOn has more than ${limits.maxDependencies} entries`);
                }
            }
        }
        const acceptance = [];
        if (entry['acceptance'] !== undefined) {
            if (!Array.isArray(entry['acceptance']))
                issues.push(`${label}.acceptance must be an array of strings`);
            else
                for (const item of entry['acceptance']) {
                    const text = asString(item);
                    if (text)
                        acceptance.push(text);
                }
        }
        let outputSchema;
        if (entry['outputSchema'] !== undefined) {
            const checked = assertObjectSchema(entry['outputSchema']);
            if (checked.ok)
                outputSchema = checked.schema;
            else
                issues.push(...checked.issues.map((issue) => `${label}.outputSchema${issue.path.slice(1)}: ${issue.message}`));
        }
        const guards = {};
        if (isRecord(entry['guards'])) {
            const timeout = entry['guards']['timeoutMs'];
            const attempts = entry['guards']['maxAttempts'];
            if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
                guards['timeoutMs'] = Math.floor(timeout);
            if (typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0)
                guards['maxAttempts'] = attempts;
        }
        tasks.push({
            id,
            title,
            role,
            prompt,
            dependsOn,
            acceptance,
            ...(outputSchema ? { outputSchema } : {}),
            ...(() => { const route = normalizeRoute(entry['route']); return route ? { route } : {}; })(),
            ...(Object.keys(guards).length > 0 ? { guards } : {}),
            critical: entry['critical'] !== false,
            verify: entry['verify'] === true,
        });
    }
    if (issues.length > 0)
        return { ok: false, issues };
    for (const issue of validateGraph(tasks))
        issues.push(issue.message);
    if (issues.length > 0)
        return { ok: false, issues };
    const synthesisRaw = isRecord(raw['synthesis']) ? raw['synthesis'] : undefined;
    const synthesisPrompt = asString(synthesisRaw?.['prompt']);
    const rationale = asString(raw['rationale']);
    const plan = {
        goal: asString(raw['goal']) ?? goal,
        tasks,
        synthesis: {
            enabled: synthesisRaw ? synthesisRaw['enabled'] !== false : true,
            ...(synthesisPrompt ? { prompt: synthesisPrompt } : {}),
        },
        ...(rationale ? { rationale } : {}),
    };
    return { ok: true, plan };
}
/** A plan whose structured payloads are all lossless JSON (journal-safe). */
export function planIsJournalSafe(plan) {
    return plan.tasks.every((task) => task.outputSchema === undefined || isPlainJson(task.outputSchema));
}
/** Compact plan projection used in prompts, reports, and tool results. */
export function planSummary(plan) {
    return plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        role: task.role,
        dependsOn: task.dependsOn,
        structured: task.outputSchema !== undefined,
        critical: task.critical,
    }));
}
