/**
 * dsh-orchestrator — plan a task DAG, dispatch parallel subagents over
 * ctx.subagents, route roles to provider/model/effort, verify with critic
 * passes, replan on critical failures, and synthesize one final answer.
 *
 * Tools: orch_run (start, awaited or background), orch_status (list/detail),
 * orch_cancel (abort). Runs are journaled under
 * $DSH_HOME/dsh-orchestrator/runs and observed through the cordis events
 * orchestrator/run-start, orchestrator/run-end, and orchestrator/event.
 *
 * Runtime value imports stay at zero @deepseek-ai/dsh-* packages: the tool
 * definitions use the raw registration shape and every other dsh import is
 * type-only, so the plugin loads from a dev-pruned tree.
 * @module dsh-orchestrator
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Engine } from './core/engine.js';
import { systemClock } from './core/budget.js';
import { DEFAULT_PLAN_LIMITS } from './core/plan.js';
import { DEFAULT_RETRY } from './core/retry.js';
import { emptyUsage } from './core/types.js';
import { FileJournal } from './dsh/journal.js';
import { DEFAULT_TUNING, safeRunId, tuningForCall, tuningFromConfig } from './dsh/config.js';
import { RunRegistry, applyEvent, liveRecord, toolTrigger } from './dsh/runs.js';
import { HarnessSubagents, foldUsage } from './dsh/subagents.js';
import { jsonOf, queryOf, readBody, sameOrigin } from './dsh/http.js';
import { SessionState } from './dsh/session-state.js';
import { attachWorkbenchMenu } from './dsh/workbench-menu.js';
export const name = 'dsh-orchestrator';
// 'webServer' 必须 reactive 注入：dsh-web-app 的 webServer 服务在插件 apply 时可能尚未启动，
// 一次性 ctx.get 会拿到 undefined 并静默跳过路由挂载（2026-11-21 修复：改用工作箱同款
// inject 声明，cordis 会等 webServer 就绪后再 apply，路由必然可挂）。
export const inject = ['tools', 'webServer'];
export const Config = z.object({
    provider: z.string().default('spawn').description('ctx.subagents backend for workers (spawn = fresh in-process children).'),
    maxDepth: z.union([z.natural(), z.const('provider-managed')]).description('Child delegation depth cap; omitted reads the host subagent depth setting.'),
    dataDir: z.string().description('Directory for run journals; default $DSH_HOME/dsh-orchestrator/runs.'),
    history: z.number().step(1).min(1).max(200).default(20).description('Finished runs kept in memory for orch_status.'),
    defaults: z.object({
        timeoutMs: z.number().step(1).min(1000),
        maxAttempts: z.number().step(1).min(1).max(8),
        verify: z.boolean(),
        maxParallel: z.number().step(1).min(1).max(16),
        maxReplans: z.number().step(1).min(0).max(5),
        maxPlanRepairs: z.number().step(1).min(0).max(5),
        synthesize: z.boolean(),
        dependencyContextChars: z.number().step(1).min(200).max(100000),
    }).default({}),
    limits: z.object({
        maxWallMs: z.number().step(1).min(1000),
        maxActivations: z.number().step(1).min(1),
        maxTasks: z.number().step(1).min(1),
        maxOutputChars: z.number().step(1).min(1000),
        maxTokens: z.number().step(1).min(1000),
    }).default({}),
    routing: z.object({
        roles: z.any().description('Role to route map: { coder: { provider, model, reasoningEffort, maxTokens } }.'),
        rules: z.array(z.object({
            name: z.string(),
            match: z.object({ role: z.string(), taskId: z.string(), titleIncludes: z.string() }),
            route: z.object({
                provider: z.string(),
                model: z.string(),
                reasoningEffort: z.string(),
                maxTokens: z.number().step(1).min(1),
            }),
        })),
        default: z.object({
            provider: z.string(),
            model: z.string(),
            reasoningEffort: z.string(),
            maxTokens: z.number().step(1).min(1),
        }),
        fallbacks: z.array(z.object({
            provider: z.string(),
            model: z.string(),
            reasoningEffort: z.string(),
            maxTokens: z.number().step(1).min(1),
        })).description('Ordered worker retry routes: attempt 2 uses the first fallback, attempt 3 the next, and so on.'),
    }).default({}),
    triggers: z.array(z.object({
        name: z.string(),
        textIncludes: z.string().required(),
        source: z.array(z.union([z.const('user'), z.const('schedule')])),
        goal: z.string().required(),
        context: z.string(),
        once: z.boolean(),
    })),
});
const dshHome = () => {
    const configured = process.env['DSH_HOME']?.trim();
    return configured && configured.length > 0 ? configured : join(homedir(), '.dsh');
};
const newRunId = () => 'run-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
/** Deep-clean a value into lossless JSON (no undefined keys anywhere). */
const clean = (value) => {
    if (Array.isArray(value))
        return value.map(clean);
    if (typeof value === 'object' && value !== null) {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined)
                out[key] = clean(entry);
        }
        return out;
    }
    return value;
};
const textBlocks = (value) => [{ type: 'text', text: String(value) }];
export function apply(ctx, config) {
    const log = (message, error) => {
        try {
            (ctx.logger ?? console)['warn']('[dsh-orchestrator] ' + message, error ?? '');
        }
        catch { /* logging must never fail the plugin */ }
    };
    // The subagents service is resolved at call time: a headless composition
    // without it still loads the plugin, and orch_run explains what is missing.
    const subagentsService = () => {
        const service = ctx.subagents;
        if (service === undefined) {
            throw new Error('orchestrator requires the subagents service; this composition does not provide it');
        }
        return service;
    };
    const rolesRaw = config.routing?.roles;
    if (rolesRaw !== undefined && (typeof rolesRaw !== 'object' || rolesRaw === null)) {
        log('config routing.roles is not an object; the entry was dropped');
    }
    const dataDir = config.dataDir ?? join(dshHome(), 'dsh-orchestrator', 'runs');
    const journal = new FileJournal({ dir: dataDir, log });
    // Per-session toolbox settings: the workbench switch and this session's
    // subagent specification (backend + default worker route). Explicit
    // overrides only; absent keys inherit the plugin defaults.
    const sessionState = new SessionState(join(dshHome(), 'dsh-orchestrator', 'sessions.json'), log);
    const registry = new RunRegistry(config.history);
    const baseTuning = tuningFromConfig(config, DEFAULT_TUNING);
    // Token accounting per child session, fed by the durable event stream.
    // Bounded: unrelated sessions cannot grow the map without limit.
    const usage = new Map();
    const USAGE_CAP = 600;
    ctx.on('session/event', (session, event) => {
        const record = event;
        if (record?.type !== 'assistant/message')
            return;
        const raw = record.data?.usage ?? record.usage;
        if (typeof raw !== 'object' || raw === null)
            return;
        const entry = usage.get(session.id) ?? emptyUsage();
        foldUsage(entry, raw);
        usage.set(session.id, entry);
        if (usage.size > USAGE_CAP) {
            const oldest = usage.keys().next().value;
            if (oldest !== undefined)
                usage.delete(oldest);
        }
    });
    const forgetUsage = (record) => {
        for (const task of Object.values(record.tasks ?? {})) {
            for (const attempt of task.attempts ?? []) {
                if (attempt.childId)
                    usage.delete(attempt.childId);
            }
        }
    };
    const startRun = (args) => {
        const service = subagentsService();
        // Race guard: the toolbox switch can flip while a step is being prepared.
        const sessionSettings = sessionState.stateOf(args.parent.id);
        if (sessionSettings.enabled !== true) {
            throw new Error('本会话已在工具箱里关闭 Orchestrator；拨开工作箱里的开关即可恢复');
        }
        const trigger = args.triggerName !== undefined
            ? { kind: 'session-event', name: args.triggerName }
            : toolTrigger();
        let runId = safeRunId(args.runId, newRunId());
        for (let suffix = 2; registry.get(runId) !== undefined; suffix += 1) {
            runId = safeRunId(args.runId, newRunId()) + '-' + String(suffix);
        }
        const controller = new AbortController();
        const live = liveRecord(runId, args.goal, trigger, Date.now());
        const port = new HarnessSubagents({
            service,
            provider: sessionSettings.backend ?? config.provider,
            ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
        });
        const engine = new Engine({
            subagents: port,
            clock: systemClock,
            random: () => Math.random(),
            journal,
            emit: (event) => {
                try {
                    applyEvent(live, event);
                    ctx.emit('orchestrator/event', event);
                }
                catch (error) {
                    log('event forwarding failed for ' + runId, error);
                }
            },
            usageOf: (childId) => usage.get(childId),
            log,
        }, DEFAULT_RETRY, {
            ...DEFAULT_PLAN_LIMITS,
            ...(args.tuning.limits.maxTasks !== undefined ? { maxTasks: args.tuning.limits.maxTasks } : {}),
        });
        const settled = engine.run({
            id: runId,
            goal: args.goal,
            ...(args.context !== undefined ? { context: args.context } : {}),
            ...(args.plan !== undefined ? { plan: args.plan } : {}),
            parent: { sessionId: args.parent.id, agent: args.parent },
            limits: args.tuning.limits,
            defaults: args.tuning.defaults,
            routing: {
                ...args.tuning.routing,
                ...(sessionSettings.route !== undefined
                    ? {
                        default: {
                            ...sessionSettings.route,
                            ...(sessionSettings.reasoningEffort !== undefined ? { reasoningEffort: sessionSettings.reasoningEffort } : {}),
                        },
                    }
                    : {}),
                ...(sessionSettings.fallbacks !== undefined || (args.tuning.routing.fallbacks ?? []).length > 0
                    ? {
                        fallbacks: [
                            ...(args.tuning.routing.fallbacks ?? []),
                            ...(sessionSettings.fallbacks ?? []),
                        ],
                    }
                    : {}),
            },
            trigger,
            signal: controller.signal,
        });
        registry.register(live, settled, (reason) => controller.abort(reason));
        ctx.emit('orchestrator/run-start', { runId, goal: args.goal });
        void settled.then((final) => {
            forgetUsage(final);
            ctx.emit('orchestrator/run-end', { runId: final.id, status: final.status });
        }, () => undefined);
        if (args.callerSignal !== undefined) {
            const caller = args.callerSignal;
            const onAbort = () => controller.abort('caller aborted');
            caller.addEventListener('abort', onAbort, { once: true });
            void settled.finally(() => caller.removeEventListener('abort', onAbort));
        }
        return { runId, settled };
    };
    const tuningOverrides = (args) => ({
        defaults: {
            timeoutMs: args['timeoutMs'],
            maxAttempts: args['maxAttempts'],
            verify: args['verify'],
            maxParallel: args['maxParallel'],
            maxReplans: args['maxReplans'],
            synthesize: args['synthesize'],
        },
        limits: {
            maxActivations: args['maxActivations'],
            maxTasks: args['maxTasks'],
        },
    });
    const runTool = {
        name: 'orch_run',
        description: 'Plan and run one orchestrated multi-subagent task: decompose the goal into a DAG of self-contained tasks, run independent tasks in parallel, verify results, and synthesize a final report.'
            + ' Workers are fresh subagents with no memory of this conversation, so every task prompt must be self-contained.'
            + ' Returns the final report when wait=await (default) or a run id to poll with orch_status when wait=background.'
            + ' Per-session toolbox settings (model, effort, concurrency, wait mode, fallbacks) apply beneath explicit arguments.'
            + ' Use for fan-out work whose pieces are independent enough to delegate; do not use for a single quick question.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                goal: { type: 'string', description: 'The objective for the whole orchestration, in the user language.' },
                context: { type: 'string', description: 'Optional background for the planner and workers (paths, constraints, prior findings).' },
                plan: { type: 'string', description: 'Optional caller-authored plan as JSON text: a top-level object with a tasks array of {id,title,role,prompt,dependsOn,acceptance,critical,verify,outputSchema}. Skips the planner stage.' },
                runId: { type: 'string', description: 'Suggested run id (lower-case slug); collides with a live run are suffixed, and a unique one is generated when omitted.' },
                wait: { type: 'string', enum: ['await', 'background'], description: 'await (default) blocks this call until the run settles; background returns the run id immediately.' },
                maxParallel: { type: 'integer', description: 'Per-call override: concurrent workers (default from config).' },
                maxActivations: { type: 'integer', description: 'Per-call override: total subagent activations allowed.' },
                maxTasks: { type: 'integer', description: 'Per-call override: hard task ceiling — the plan is rejected, not truncated, above it.' },
                timeoutMs: { type: 'integer', description: 'Per-call override: per-activation timeout in milliseconds.' },
                maxAttempts: { type: 'integer', description: 'Per-call override: attempts per task (default 2).' },
                maxReplans: { type: 'integer', description: 'Per-call override: replans after critical failures (default 1).' },
                verify: { type: 'boolean', description: 'Per-call override: run a critic pass on every task result.' },
                synthesize: { type: 'boolean', description: 'Per-call override: merge task results into a final synthesis (default true).' },
            },
            required: ['goal'],
        },
        output: { schema: { type: 'string' }, render: (_args, value) => textBlocks(value) },
        async execute(rawArgs, exec) {
            const args = rawArgs;
            const parent = exec.agent;
            if (parent === undefined) {
                throw new Error('orch_run requires a calling agent (exec.agent was undefined)');
            }
            // 会话设置层（工具箱二级菜单）：显式工具参数 > 会话设置 > 插件配置。
            const session = sessionState.stateOf(parent.id);
            const effectiveWait = args.wait ?? session.waitMode;
            const effectiveMaxParallel = args.maxParallel ?? session.maxParallel;
            let plan;
            if (typeof args.plan === 'string' && args.plan.trim().length > 0) {
                try {
                    plan = clean(JSON.parse(args.plan));
                }
                catch (error) {
                    return 'plan is not valid JSON text: ' + String(error.message);
                }
            }
            const tuning = tuningForCall(tuningOverrides({ ...args, maxParallel: effectiveMaxParallel }), baseTuning);
            const { runId, settled } = startRun({
                goal: args.goal,
                ...(typeof args.context === 'string' && args.context.length > 0 ? { context: args.context } : {}),
                ...(plan !== undefined ? { plan } : {}),
                ...(typeof args.runId === 'string' && args.runId.length > 0 ? { runId: args.runId } : {}),
                tuning,
                parent,
                ...(effectiveWait === 'await' || effectiveWait === undefined ? { callerSignal: exec.signal } : {}),
            });
            if (effectiveWait !== 'background') {
                exec.signal.throwIfAborted();
                const final = await settled;
                return final.report ?? '';
            }
            return 'started orchestration ' + runId + ' in the background.'
                + ' Poll orch_status with runId ' + runId + ' after doing other work; the final report lands there and in the journal.'
                + ' Live runs now: ' + String(registry.running().length);
        },
        presentCall: (args) => ({ card: 'generic', title: 'Orchestrate', kind: 'other', rawInput: clean(args) }),
    };
    const statusTool = {
        name: 'orch_status',
        description: 'Inspect orchestrations: without runId, list live and recent runs; with runId, return the full run report (plan, task statuses, failures, synthesis).'
            + ' Works for live runs, finished in-memory runs, and journaled runs from earlier restarts.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                runId: { type: 'string', description: 'Run id to describe; omitted lists all runs.' },
                limit: { type: 'integer', description: 'Listing size (default 20).' },
            },
            required: [],
        },
        output: { schema: { type: 'string' }, render: (_args, value) => textBlocks(value) },
        async execute(rawArgs) {
            const args = rawArgs;
            const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 20;
            if (typeof args.runId === 'string' && args.runId.length > 0) {
                const described = registry.describe(args.runId);
                if (described !== undefined) {
                    return (described.live ? 'LIVE RUN' + String.fromCharCode(10) : '') + described.report;
                }
                const persisted = journal.read(args.runId);
                if (persisted !== undefined) {
                    return 'JOURNALED RUN' + String.fromCharCode(10) + (persisted.report ?? '');
                }
                return 'no orchestration found for runId ' + args.runId;
            }
            const lines = registry.listing(limit);
            const seen = new Set(lines.map((line) => (line.split('] ')[1] ?? '').split(' ')[0]));
            const durable = journal.list(limit).filter((entry) => !seen.has(entry.id));
            const durableLines = durable.map((entry) => '[' + entry.status + '] ' + entry.id + ' - ' + entry.goal.slice(0, 80));
            const all = [...lines, ...durableLines].slice(0, limit);
            return all.length === 0
                ? 'no orchestrations yet; start one with orch_run'
                : 'orchestrations (newest first):' + String.fromCharCode(10) + all.join(String.fromCharCode(10));
        },
        presentCall: (args) => ({ card: 'generic', title: 'Orchestration status', kind: 'read', rawInput: clean(args) }),
    };
    const cancelTool = {
        name: 'orch_cancel',
        description: 'Cancel one live orchestration by run id, or every live orchestration with runId=all. Finished runs are untouched.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                runId: { type: 'string', description: 'Run id to cancel, or the literal all for every live run.' },
            },
            required: ['runId'],
        },
        output: { schema: { type: 'string' }, render: (_args, value) => textBlocks(value) },
        async execute(rawArgs, exec) {
            const args = rawArgs;
            exec.signal.throwIfAborted();
            if (args.runId === 'all') {
                const running = registry.running();
                for (const run of running)
                    run.cancel('cancelled via orch_cancel');
                return 'cancel signal sent to ' + String(running.length) + ' live run(s)';
            }
            const run = registry.get(args.runId);
            if (run === undefined) {
                return 'no live orchestration named ' + args.runId + ' (check orch_status; finished runs cannot be cancelled)';
            }
            run.cancel('cancelled via orch_cancel');
            return 'cancel signal sent to ' + args.runId + '; in-flight children stop at their next checkpoint';
        },
        presentCall: (args) => ({ card: 'generic', title: 'Cancel orchestration', kind: 'other', rawInput: clean(args) }),
    };
    const orchestratorVisible = {
        when: ({ agent }) => agent === undefined || sessionState.stateOf(agent.id).enabled,
    };
    ctx.tools.register(runTool, orchestratorVisible);
    ctx.tools.register(statusTool);
    ctx.tools.register(cancelTool);
    // ---- dsh-workbench 面板（属主契约：/status /action /menu）----
    // 工作箱只画通用件；这三条路由是它与本插件之间的全部 HTTP 契约。
    // webServer 经 inject 声明（见文件头 export const inject）：apply 时保证就绪。
    const webServer = ctx.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') {
        log('webServer 服务不可用：工作箱面板路由未挂载（本会话仍可用 orch_* 工具）');
    }
    if (webServer !== undefined && typeof webServer.register === 'function') {
        const register = (path, handler) => {
            ctx.effect(() => webServer.register({
                kind: 'exact',
                path,
                handler: (req, res) => {
                    const json = jsonOf(res);
                    Promise.resolve(handler(req, res, json)).catch((cause) => json(500, { error: 'orchestrator 路由内部错误：' + String(cause.message) }));
                },
            }), 'dsh-orchestrator: ' + path);
        };
        // ── llm 目录 / 模型元数据缓存：菜单每 3s 轮询一次 spec，绝不能每次都真查 llm ──
        const CATALOG_TTL_MS = 60_000;
        const MODEL_INFO_TTL_MS = 120_000;
        let catalogCache = { groups: [] };
        let catalogAt = 0;
        const modelInfoCache = new Map();
        const menu = attachWorkbenchMenu({
            state: sessionState,
            catalog: async () => {
                if (Date.now() - catalogAt < CATALOG_TTL_MS)
                    return catalogCache;
                const llm = (() => {
                    try {
                        return ctx.get('llm');
                    }
                    catch {
                        return undefined;
                    }
                })();
                if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
                    return { groups: [], error: 'llm 服务不可用：无法列出模型' };
                }
                const groups = [];
                let error;
                try {
                    for (const info of llm.listProviders() ?? []) {
                        const provider = String(info?.id ?? '');
                        if (provider === '')
                            continue;
                        try {
                            const models = ((await llm.listModels?.(provider)) ?? []).map((model) => ({
                                id: String(model?.id ?? ''),
                                ...(typeof model?.name === 'string' ? { name: model.name } : {}),
                            })).filter((model) => model.id !== '');
                            groups.push({ id: provider, name: String(info?.name ?? provider), models });
                        }
                        catch { /* 单个 provider 失败不拖垮目录 */ }
                    }
                }
                catch (cause) {
                    error = '列 provider 失败：' + String(cause.message);
                }
                catalogCache = { groups: groups.filter((group) => group.models.length > 0), ...(error !== undefined ? { error } : {}) };
                catalogAt = Date.now();
                return catalogCache;
            },
            modelInfo: async (provider, model) => {
                const key = provider + '::' + model;
                const hit = modelInfoCache.get(key);
                if (hit !== undefined && Date.now() - hit.at < MODEL_INFO_TTL_MS)
                    return { efforts: hit.efforts };
                const llm = (() => {
                    try {
                        return ctx.get('llm');
                    }
                    catch {
                        return undefined;
                    }
                })();
                let efforts = null;
                if (llm !== undefined && typeof llm.resolveModelInfo === 'function') {
                    try {
                        const info = await llm.resolveModelInfo(provider, model);
                        const raw = info?.reasoning?.efforts;
                        efforts = Array.isArray(raw)
                            ? raw.map((item) => String(typeof item === 'string' ? item : item?.id ?? '')).filter((id) => id !== '')
                            : null;
                        if (efforts !== null && efforts.length === 0)
                            efforts = null;
                    }
                    catch { /* 元数据拿不到：null，面板只留「模型默认」 */ }
                }
                modelInfoCache.set(key, { at: Date.now(), efforts });
                return { efforts };
            },
            backends: () => {
                try {
                    const service = ctx.subagents;
                    if (service === undefined)
                        return [];
                    return ['spawn', 'fork'].filter((name) => service.getProvider(name) !== undefined);
                }
                catch {
                    return [];
                }
            },
        });
        const statusPayload = (sessionId) => {
            const settings = sessionState.stateOf(sessionId);
            const running = settings.enabled;
            return {
                running,
                phase: running ? 'running' : 'off',
                note: settings.route !== undefined
                    ? '子代理默认 ' + settings.route.provider + ' / ' + settings.route.model
                    : '子代理沿用插件配置',
                hint: running
                    ? '拨关后本会话记住关闭状态（orch_status / orch_cancel 仍在）'
                    : '新会话默认关闭；拨开即对本会话启用并记住选择',
                menu: { route: '/dsh-orchestrator/menu', label: '子代理设置' },
                ...(sessionState.error !== undefined ? { storeError: sessionState.error } : {}),
            };
        };
        register('/dsh-orchestrator/status', (req, res, json) => {
            if (req.method !== 'GET' && req.method !== 'HEAD')
                return json(405, { error: 'Method Not Allowed' });
            const sessionId = queryOf(req, 'sessionId');
            if (sessionId === '')
                return json(400, { error: '需要 sessionId 查询参数' });
            return json(200, statusPayload(sessionId));
        });
        register('/dsh-orchestrator/action', async (req, res, json) => {
            if (req.method !== 'POST')
                return json(405, { error: 'Method Not Allowed' });
            if (!sameOrigin(req))
                return json(403, { error: 'cross-origin request rejected' });
            const body = await readBody(req);
            if (!body.ok)
                return json(400, { error: body.error });
            let parsed;
            try {
                parsed = JSON.parse(body.text === '' ? '{}' : body.text);
            }
            catch {
                return json(400, { error: 'body 不是合法 JSON' });
            }
            const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
            if (sessionId === '')
                return json(400, { error: 'sessionId 必填' });
            sessionState.setEnabled(sessionId, parsed.enabled !== false);
            return json(200, { ok: true, ...statusPayload(sessionId) });
        });
        register('/dsh-orchestrator/menu', async (req, res, json) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
                const sessionId = queryOf(req, 'sessionId');
                if (sessionId === '')
                    return json(400, { error: '需要 sessionId 查询参数' });
                try {
                    return json(200, await menu.buildSpec(sessionId));
                }
                catch (cause) {
                    return json(500, { error: '菜单生成失败：' + String(cause.message) });
                }
            }
            if (req.method !== 'POST')
                return json(405, { error: 'Method Not Allowed' });
            if (!sameOrigin(req))
                return json(403, { error: 'cross-origin request rejected' });
            const body = await readBody(req);
            if (!body.ok)
                return json(400, { error: body.error });
            let parsed;
            try {
                parsed = JSON.parse(body.text === '' ? '{}' : body.text);
            }
            catch {
                return json(400, { error: 'body 不是合法 JSON' });
            }
            try {
                return json(200, await menu.applyOp(parsed));
            }
            catch (cause) {
                const status = typeof cause.menuStatus === 'number'
                    ? cause.menuStatus
                    : 500;
                return json(status, { error: String(cause.message) });
            }
        });
        log('工作箱路由就绪：/dsh-orchestrator/{status,action,menu}');
    }
    // ---- opt-in session-event triggers ----
    const firedTriggers = new Map();
    const triggerRules = Array.isArray(config.triggers) ? config.triggers : [];
    if (triggerRules.length > 0) {
        ctx.on('session/event', (session, event) => {
            const record = event;
            if (record?.type !== 'user/message')
                return;
            const sourceKind = record.data?.source?.kind;
            const text = (record.data?.content ?? [])
                .filter((block) => block?.type === 'text')
                .map((block) => block.text ?? '')
                .join(' ');
            for (const trigger of triggerRules) {
                const allowed = trigger.source ?? ['user'];
                if (!allowed.includes(sourceKind))
                    continue;
                if (!text.toLowerCase().includes(trigger.textIncludes.toLowerCase()))
                    continue;
                const triggerName = trigger.name ?? trigger.textIncludes;
                if (sessionState.stateOf(session.id).enabled !== true)
                    continue;
                const agent = ctx.agents?.get(session.id);
                if (agent === undefined) {
                    log('trigger ' + triggerName + ' matched session ' + session.id + ' but no live agent owns it');
                    continue;
                }
                const started = startRun({
                    goal: trigger.goal,
                    ...(trigger.context !== undefined ? { context: trigger.context } : {}),
                    tuning: baseTuning,
                    parent: agent,
                    triggerName,
                });
                // The once-quota is only consumed after a run actually started.
                if (trigger.once !== false) {
                    const sessions = firedTriggers.get(triggerName) ?? new Set();
                    sessions.add(session.id);
                    firedTriggers.set(triggerName, sessions);
                }
                log('trigger ' + triggerName + ' started run ' + started.runId + ' from session ' + session.id);
            }
        });
    }
    return () => {
        for (const run of registry.running())
            run.cancel('plugin unloaded');
    };
}
// 注意：**不要**加 `export default apply`。cordis loader 的 unwrapExports 是
// `exports.default ?? exports`——只要模块带 default 导出，具名的 name/inject/Config/apply
// 就会被整个丢弃，插件退化成裸函数立即应用：inject 失传 → apply 抢跑 webServer 启动 →
// 工作箱路由永不挂载（2026-11-21 灰行事故根因；对照 admin-channel / inject-switch / workbench
// 全部无 default 导出）。host-selftest 有对应断言防回归。
