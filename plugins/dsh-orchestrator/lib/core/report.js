/**
 * Deterministic Markdown rendering of one finished (or crashed) run.
 * The same text goes to the tool result, the journal, and the final
 * 'orch_status' projection, so it stays pure and dependency-free.
 * @module dsh-orchestrator/core/report
 */
import { routeLabel } from './router.js';
const STATUS_ICON = {
    pending: '…',
    running: '▶',
    succeeded: '✔',
    failed: '✘',
    skipped: '⏭',
    cancelled: '⊘',
};
const clip = (text, max) => text.length <= max ? text : text.replace(/\s+/g, ' ').slice(0, max - 1) + '…';
const formatDuration = (ms) => {
    if (!Number.isFinite(ms) || ms < 0)
        return 'n/a';
    if (ms < 1000)
        return String(Math.round(ms)) + 'ms';
    if (ms < 60_000)
        return (ms / 1000).toFixed(1) + 's';
    const minutes = Math.floor(ms / 60_000);
    return minutes + 'm' + Math.round((ms % 60_000) / 1000) + 's';
};
const formatTokens = (tokens) => tokens >= 1_000_000
    ? (tokens / 1_000_000).toFixed(1) + 'M'
    : tokens >= 10_000
        ? Math.round(tokens / 1000) + 'k'
        : String(tokens);
/** Render the durable human-facing summary of one run. */
export function renderReport(run, plan) {
    const lines = [];
    const duration = (run.endedAt ?? run.startedAt ?? run.createdAt) - (run.startedAt ?? run.createdAt);
    const budget = run.budget;
    lines.push('# Orchestration ' + JSON.stringify(run.id) + ' — ' + run.status);
    lines.push('');
    lines.push('- goal: ' + run.goal);
    lines.push('- status: ' +
        run.status +
        (run.failure ? ' (' + clip(run.failure, 300) + ')' : '') +
        ' · duration: ' +
        formatDuration(duration) +
        ' · trigger: ' +
        run.trigger.kind +
        (run.trigger.name ? ' (' + run.trigger.name + ')' : ''));
    lines.push('- activations: ' +
        budget.activations +
        (budget.limits.maxActivations !== undefined ? '/' + String(budget.limits.maxActivations) : '') +
        ' · tasks: ' +
        budget.tasks +
        (budget.limits.maxTasks !== undefined ? '/' + String(budget.limits.maxTasks) : '') +
        ' · replans: ' +
        String(run.replans));
    const tokens = budget.usage.totalTokens;
    lines.push('- tokens: ' +
        formatTokens(tokens) +
        ' (in ' + formatTokens(budget.usage.inputTokens) +
        ' / out ' + formatTokens(budget.usage.outputTokens) +
        ' / cache read ' + formatTokens(budget.usage.cacheReadTokens) +
        ') · output: ' +
        String(budget.outputChars) +
        ' chars');
    if (budget.exhausted)
        lines.push('- budget stop: ' + budget.exhausted);
    lines.push('');
    lines.push('## Plan');
    if (plan) {
        if (plan.rationale)
            lines.push(clip(plan.rationale, 400));
        for (const [index, task] of plan.tasks.entries()) {
            const record = run.tasks[task.id];
            const status = record?.status ?? 'pending';
            const attempts = record?.attempts.length ?? 0;
            const route = record?.route;
            const failure = record?.failure ? ' — ' + record.failure : '';
            lines.push(String(index + 1) +
                '. ' +
                STATUS_ICON[status] +
                ' **' + task.id + '**' +
                ' (' + task.role + (route ? ' @ ' + routeLabel(route) : '') + ')' +
                ' — ' + clip(task.title, 90) +
                ' [' + status + (attempts > 1 ? ' ×' + String(attempts) : '') + failure + ']');
            if (record?.detail && status !== 'succeeded')
                lines.push('   - ' + clip(record.detail, 300));
            if (task.dependsOn.length > 0)
                lines.push('   - depends on: ' + task.dependsOn.join(', '));
        }
    }
    else {
        lines.push('No plan was admitted (the planner never produced a valid plan).');
    }
    const outputs = plan?.tasks.filter((task) => run.tasks[task.id]?.output) ?? [];
    if (outputs.length > 0) {
        lines.push('');
        lines.push('## Artifacts');
        for (const task of outputs) {
            const output = run.tasks[task.id]?.output;
            if (!output)
                continue;
            lines.push('- **' + task.id + '** → child ' + output.childName + ' (' + output.childId + ')');
        }
    }
    if (run.synthesis) {
        lines.push('');
        lines.push('## Synthesis');
        lines.push(run.synthesis);
    }
    const unresolved = plan?.tasks.filter((task) => {
        const status = run.tasks[task.id]?.status ?? 'pending';
        return status !== 'succeeded' && task.critical;
    });
    if (unresolved && unresolved.length > 0) {
        lines.push('');
        lines.push('## Unresolved');
        for (const task of unresolved) {
            const record = run.tasks[task.id];
            lines.push('- **' + task.id + '**: ' +
                (record?.status ?? 'pending') +
                (record?.failure ? ' (' + record.failure + ')' : '') +
                (record?.detail ? ' — ' + clip(record.detail, 200) : ''));
        }
    }
    return lines.join('\n');
}
