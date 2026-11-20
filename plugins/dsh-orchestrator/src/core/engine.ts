/**
 * The orchestration engine: plan → route → parallel DAG execution → verify →
 * re-plan → synthesize. Pure logic over `EnginePorts`; no harness imports.
 * @module dsh-orchestrator/core/engine
 */
import { Budget, abortError } from './budget.js'
import { dependentsOf, readyTasks } from './graph.js'
import { extractJsonObject, validateJson } from './jsonschema.js'
import { DEFAULT_PLAN_LIMITS, normalizePlan, type PlanLimits } from './plan.js'
import type { ActivationHandle, ActivationOutcome, ActivationRequest, EnginePorts } from './ports.js'
import {
  CRITIC_SCHEMA,
  PLAN_SCHEMA,
  criticPrompt,
  planRepairPrompt,
  plannerPrompt,
  replanPrompt,
  synthesisPrompt,
  workerPrompt,
} from './prompts.js'
import { renderReport } from './report.js'
import { DEFAULT_RETRY, backoffDelay, isRetryable, type RetryPolicy } from './retry.js'
import { resolveFallbacks, resolveRoute } from './router.js'
import {
  emptyUsage,
  type AttemptRecord,
  type FailureKind,
  type JsonObject,
  type JsonValue,
  type Plan,
  type Route,
  type RunRecord,
  type RunRequest,
  type TaskId,
  type TaskOutput,
  type TaskSpec,
  type TaskStatus,
} from './types.js'

export class EngineError extends Error {
  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message)
    this.name = 'EngineError'
  }
}

type AttemptJudgement =
  | { readonly ok: true; readonly output: TaskOutput; readonly caveat?: string }
  | { readonly ok: false; readonly failure: FailureKind; readonly detail: string }

interface SettleResult {
  readonly outcome?: ActivationOutcome
  readonly failure?: FailureKind
  readonly detail?: string
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Engine {
  constructor(
    private readonly ports: EnginePorts,
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly planLimits?: PlanLimits,
  ) {}

  /**
   * The plan ceilings for one run: the run's own maxTasks limit is
   * authoritative over the engine-wide default, so a caller ceiling rejects an
   * oversized plan up front instead of truncating it mid-flight.
   */
  private planLimitsFor(request: RunRequest): PlanLimits {
    const base = this.planLimits ?? DEFAULT_PLAN_LIMITS
    return { ...base, ...(request.limits.maxTasks !== undefined ? { maxTasks: request.limits.maxTasks } : {}) }
  }

  /** Execute one orchestration to settlement. Never throws for run-level failures. */
  async run(request: RunRequest): Promise<RunRecord> {
    const { clock } = this.ports
    const budget = new Budget(request.limits, clock)
    const run: RunRecord = {
      id: request.id,
      goal: request.goal,
      parentSessionId: request.parent.sessionId,
      status: 'running',
      createdAt: clock.now(),
      startedAt: clock.now(),
      tasks: {},
      budget: budget.snapshot(),
      replans: 0,
      trigger: request.trigger,
    }
    this.publish(run.id, { type: 'run/created', runId: run.id, goal: run.goal, trigger: request.trigger })

    let plan: Plan | undefined
    try {
      plan = await this.obtainPlan(request, budget, run)
      this.publish(run.id, { type: 'run/plan', runId: run.id, plan, replan: false })
      run.plan = plan

      for (;;) {
        this.registerTasks(run, plan)
        await this.executeGraph(run, plan, request, budget)
        const failures = this.blockingFailures(run, plan)
        const canReplan =
          failures.length > 0 &&
          run.replans < request.defaults.maxReplans &&
          !request.signal.aborted &&
          budget.exhausted() === undefined
        if (!canReplan) break
        const next = await this.replan(run, plan, failures, request, budget)
        if (!next) break
        run.replans += 1
        plan = next
        run.plan = plan
        this.publish(run.id, { type: 'run/plan', runId: run.id, plan, replan: true })
      }

      await this.synthesize(run, plan, request, budget)
      run.status = request.signal.aborted ? 'cancelled' : this.statusOf(run, plan)
    } catch (error) {
      run.status = request.signal.aborted ? 'cancelled' : 'failed'
      run.failure =
        error instanceof EngineError && error.issues.length > 0
          ? messageOf(error) + ': ' + error.issues.join('; ')
          : messageOf(error)
      this.publish(run.id, { type: 'run/diagnostic', runId: run.id, message: run.failure })
    } finally {
      run.endedAt = clock.now()
      run.budget = budget.snapshot()
      run.report = renderReport(run, plan)
      this.publish(run.id, {
        type: 'run/ended',
        runId: run.id,
        status: run.status,
        ...(run.failure ? { failure: run.failure } : {}),
      })
      this.ports.journal.finalize(run)
    }
    return run
  }

  // ---------------------------------------------------------------- planning

  private async obtainPlan(request: RunRequest, budget: Budget, run: RunRecord): Promise<Plan> {
    if (request.plan !== undefined) {
      const result = normalizePlan(request.plan, request.goal, this.planLimitsFor(request))
      if (!result.ok) throw new EngineError('caller-supplied plan is invalid', result.issues)
      return result.plan
    }
    const limits = this.planLimitsFor(request)
    const maxTasks = limits.maxTasks
    const roles = Object.keys(request.routing.roles)
    let raw: unknown
    let issues: readonly string[] = []
    const attempts = 1 + Math.max(0, request.defaults.maxPlanRepairs)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const prompt =
        attempt === 1
          ? plannerPrompt({
              goal: request.goal,
              ...(request.context ? { context: request.context } : {}),
              maxTasks,
              roles: roles.length > 0 ? roles : ['researcher', 'coder', 'reviewer', 'writer'],
              structuredOutputSupported: this.ports.subagents.supportsStructuredOutput,
            })
          : planRepairPrompt(issues, raw)
      try {
        raw = await this.helper(request, budget, {
          kind: 'plan',
          attempt,
          label: `plan: ${request.goal.slice(0, 60)}`,
          nameHint: `orch-${request.id}-plan${attempt}`,
          prompt,
          schema: PLAN_SCHEMA,
          role: 'planner',
          timeoutMs: request.defaults.timeoutMs,
        })
      } catch (error) {
        issues = [`planner activation failed: ${messageOf(error)}`]
        this.publish(run.id, {
          type: 'run/diagnostic',
          runId: run.id,
          message: `plan attempt ${attempt} failed: ${issues.join('; ')}`,
        })
        if (request.signal.aborted) break
        continue
      }
      const result = normalizePlan(raw, request.goal, limits)
      if (result.ok) return result.plan
      issues = result.issues
      this.publish(run.id, {
        type: 'run/diagnostic',
        runId: run.id,
        message: `plan attempt ${attempt} rejected: ${issues.join('; ')}`,
      })
      if (request.signal.aborted) break
    }
    throw new EngineError(`planner produced no valid plan after ${attempts} attempt(s)`, issues)
  }

  private async replan(
    run: RunRecord,
    plan: Plan,
    failures: readonly TaskSpec[],
    request: RunRequest,
    budget: Budget,
  ): Promise<Plan | undefined> {
    const succeeded = plan.tasks.filter((task) => run.tasks[task.id]?.status === 'succeeded').map((task) => task.id)
    const prompt = replanPrompt({
      goal: request.goal,
      plan,
      failures: failures.map((task) => ({
        id: task.id,
        title: task.title,
        detail: run.tasks[task.id]?.detail ?? run.tasks[task.id]?.failure ?? 'unknown failure',
      })),
      succeeded,
      ...(budget.exhausted() ? { remainingBudgetNote: budget.exhausted()! } : {}),
    })
    let raw: unknown
    try {
      raw = await this.helper(request, budget, {
        kind: 'replan',
        attempt: run.replans + 1,
        label: `replan: ${request.goal.slice(0, 60)}`,
        nameHint: `orch-${request.id}-replan${run.replans + 1}`,
        prompt,
        schema: PLAN_SCHEMA,
        role: 'planner',
        timeoutMs: request.defaults.timeoutMs,
      })
    } catch (error) {
      this.publish(run.id, { type: 'run/diagnostic', runId: run.id, message: `replan failed: ${messageOf(error)}` })
      return undefined
    }
    const result = normalizePlan(raw, request.goal, this.planLimitsFor(request))
    if (!result.ok) {
      this.publish(run.id, {
        type: 'run/diagnostic',
        runId: run.id,
        message: `replan rejected: ${result.issues.join('; ')}`,
      })
      return undefined
    }
    const kept = plan.tasks.filter((task) => run.tasks[task.id]?.status === 'succeeded')
    const keptIds = new Set(kept.map((task) => task.id))
    const fresh = result.plan.tasks.filter((task) => !keptIds.has(task.id))
    const merged: Plan = { ...result.plan, goal: plan.goal, tasks: [...kept, ...fresh] }
    const check = normalizePlan(merged, request.goal, this.planLimitsFor(request))
    if (!check.ok) {
      this.publish(run.id, {
        type: 'run/diagnostic',
        runId: run.id,
        message: `merged replan rejected: ${check.issues.join('; ')}`,
      })
      return undefined
    }
    // Reset the records the new plan replaces, preserving attempt history.
    for (const task of fresh) {
      const record = run.tasks[task.id]
      if (record && record.status !== 'succeeded') {
        run.tasks[task.id] = { spec: task, status: 'pending', attempts: record.attempts }
      }
    }
    return check.plan
  }

  // --------------------------------------------------------------- execution

  private registerTasks(run: RunRecord, plan: Plan): void {
    for (const task of plan.tasks) {
      if (!run.tasks[task.id]) {
        run.tasks[task.id] = { spec: task, status: 'pending', attempts: [] }
      }
    }
  }

  private async executeGraph(run: RunRecord, plan: Plan, request: RunRequest, budget: Budget): Promise<void> {
    const running = new Map<TaskId, Promise<void>>()
    const statusOf = (id: TaskId): TaskStatus => run.tasks[id]?.status ?? 'pending'
    for (;;) {
      if (request.signal.aborted) {
        this.markRemaining(run, plan, 'cancelled', 'aborted', 'run cancelled')
        break
      }
      const exhausted = budget.exhausted()
      if (exhausted) {
        this.publish(run.id, { type: 'run/budget', runId: run.id, reason: exhausted })
        this.markRemaining(run, plan, 'skipped', 'budget', exhausted)
        break
      }
      this.cascadeSkips(run, plan)
      for (const task of readyTasks(plan.tasks, statusOf)) {
        if (running.size >= Math.max(1, request.defaults.maxParallel)) break
        if (budget.exhausted()) break
        const admitted = budget.admit()
        if (!admitted.ok) {
          this.publish(run.id, { type: 'run/budget', runId: run.id, reason: admitted.reason })
          this.finishTask(run, task.id, 'skipped', 'budget', admitted.reason)
          continue
        }
        const promise = this.runTask(run, plan, task, request, budget).finally(() => {
          running.delete(task.id)
        })
        running.set(task.id, promise)
      }
      if (running.size === 0) break
      await Promise.race([...running.values()])
    }
    await Promise.allSettled([...running.values()])
  }

  private cascadeSkips(run: RunRecord, plan: Plan): void {
    const blocked = plan.tasks.filter((task) => {
      const status = run.tasks[task.id]?.status
      if (status !== 'pending') return false
      return task.dependsOn.some((dep) => {
        const depStatus = run.tasks[dep]?.status
        return depStatus === 'failed' || depStatus === 'skipped' || depStatus === 'cancelled'
      })
    })
    for (const task of blocked) {
      this.finishTask(run, task.id, 'skipped', 'dependency', 'a dependency did not succeed')
    }
    if (blocked.length > 0) {
      for (const id of dependentsOf(plan.tasks, blocked.map((task) => task.id))) {
        if (run.tasks[id]?.status === 'pending') {
          this.finishTask(run, id, 'skipped', 'dependency', 'an upstream dependency did not succeed')
        }
      }
    }
  }

  private markRemaining(
    run: RunRecord,
    plan: Plan,
    status: TaskStatus,
    failure: FailureKind,
    detail: string,
  ): void {
    for (const task of plan.tasks) {
      if (run.tasks[task.id]?.status === 'pending') this.finishTask(run, task.id, status, failure, detail)
    }
  }

  private async runTask(
    run: RunRecord,
    plan: Plan,
    task: TaskSpec,
    request: RunRequest,
    budget: Budget,
  ): Promise<void> {
    const record = run.tasks[task.id]!
    const resolved = resolveRoute(task, request.routing)
    const routingApplies = resolved.route === undefined || this.ports.subagents.supportsRouting
    if (resolved.route && routingApplies) record.route = resolved.route
    record.routeSource = routingApplies ? resolved.source : 'inherit'
    // 备选槽位：attempt 1 恒为主路由（可能是 undefined＝继承父代理），重试才落 fallback。
    const slots: (Route | undefined)[] = routingApplies
      ? [resolved.route, ...resolveFallbacks(task, request.routing)]
      : []
    const routeFor = (attempt: number): Route | undefined =>
      slots.length === 0 ? undefined : slots[Math.min(attempt - 1, slots.length - 1)]
    const maxAttempts = task.guards?.maxAttempts ?? this.retry.maxAttempts
    const timeoutMs = task.guards?.timeoutMs ?? request.defaults.timeoutMs
    let feedback: string | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (request.signal.aborted) {
        this.finishTask(run, task.id, 'cancelled', 'aborted', 'run cancelled')
        return
      }
      const reserved = budget.reserve()
      if (!reserved.ok) {
        this.publish(run.id, { type: 'run/budget', runId: run.id, reason: reserved.reason })
        this.finishTask(run, task.id, 'skipped', 'budget', reserved.reason)
        return
      }
      record.status = 'running'
      const attemptRecord: AttemptRecord = { attempt, kind: 'work', startedAt: this.ports.clock.now() }
      record.attempts.push(attemptRecord)
      const attemptRoute = routeFor(attempt)
      if (attemptRoute !== undefined) attemptRecord.route = attemptRoute
      this.publish(run.id, {
        type: 'task/started',
        runId: run.id,
        taskId: task.id,
        attempt,
        ...(attemptRoute ? { route: attemptRoute } : {}),
        ...(attemptRoute ? { routeSource: attempt === 1 ? resolved.source : 'fallback' } : {}),
      })

      const dependencies = task.dependsOn
        .map((dep) => {
          const depRecord = run.tasks[dep]
          const spec = plan.tasks.find((entry) => entry.id === dep)
          return depRecord?.output && spec ? { spec, output: depRecord.output } : undefined
        })
        .filter((entry): entry is { spec: TaskSpec; output: TaskOutput } => entry !== undefined)

      const prompt = workerPrompt({
        goal: request.goal,
        task,
        dependencies,
        dependencyContextChars: request.defaults.dependencyContextChars,
        attempt,
        ...(feedback ? { previousFeedback: feedback } : {}),
        structuredOutputSupported: this.ports.subagents.supportsStructuredOutput,
      })

      const controller = new AbortController()
      const onAbort = () => controller.abort(request.signal.reason)
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()

      let handle: ActivationHandle | undefined
      let settled: SettleResult
      try {
        handle = await this.ports.subagents.start({
          runId: run.id,
          kind: 'work',
          taskId: task.id,
          attempt,
          label: `${task.title}`.slice(0, 80),
          nameHint: `orch-${run.id}-${task.id}`,
          prompt,
          parent: request.parent,
          signal: controller.signal,
          ...(task.outputSchema ? { outputSchema: task.outputSchema } : {}),
          ...(attemptRoute ? { route: attemptRoute } : {}),
          timeoutMs,
        })
        attemptRecord.childId = handle.childId
        attemptRecord.childName = handle.name
        settled = await this.settle(handle, timeoutMs, controller.signal)
      } catch (error) {
        settled = {
          failure: controller.signal.aborted ? 'aborted' : 'start-failed',
          detail: messageOf(error),
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort)
      }

      attemptRecord.endedAt = this.ports.clock.now()
      const stopReason = settled.outcome?.stopReason
      if (stopReason !== undefined) attemptRecord.stopReason = stopReason
      const usage = handle ? this.ports.usageOf?.(handle.childId) : undefined
      const outputChars = settled.outcome?.text.length ?? 0
      attemptRecord.outputChars = outputChars
      if (usage) attemptRecord.usage = usage
      budget.record(outputChars, usage ?? emptyUsage())

      let judged: AttemptJudgement = this.judge(task, settled, request)
      if (judged.ok) {
        const output: TaskOutput = {
          ...judged.output,
          childId: handle?.childId ?? '',
          childName: handle?.name ?? '',
        }
        if ((task.verify || request.defaults.verify) && !request.signal.aborted) {
          const verdict = await this.verifyTask(run, task, output, request, budget)
          judged = verdict.pass
            ? { ok: true, output, ...(verdict.detail ? { caveat: verdict.detail } : {}) }
            : { ok: false, failure: 'critic-rejected', detail: verdict.detail ?? 'critic rejected the result' }
        } else {
          judged = { ok: true, output }
        }
      }
      if (judged.ok) {
        record.output = judged.output
        this.finishTask(run, task.id, 'succeeded')
        // After finishTask so the reset-friendly clear in finishTask cannot
        // wipe the caveat a degraded critic pass attached to this success.
        if (judged.caveat) record.detail = judged.caveat
        return
      }
      attemptRecord.failure = judged.failure
      attemptRecord.detail = judged.detail
      feedback = judged.detail
      const last = attempt === maxAttempts
      if (last || !isRetryable(judged.failure) || request.signal.aborted) {
        this.finishTask(
          run,
          task.id,
          request.signal.aborted ? 'cancelled' : 'failed',
          judged.failure,
          judged.detail,
        )
        return
      }
      const delay = backoffDelay(attempt, this.retry, this.ports.random)
      this.publish(run.id, {
        type: 'run/diagnostic',
        runId: run.id,
        message: `task ${task.id} attempt ${attempt} failed (${judged.failure}); retrying in ${delay}ms`,
      })
      try {
        await this.ports.clock.sleep(delay, request.signal)
      } catch {
        this.finishTask(run, task.id, 'cancelled', 'aborted', 'run cancelled during backoff')
        return
      }
    }
  }

  /** Classify one settled attempt, then optionally run the critic. */
  private judge(task: TaskSpec, settled: SettleResult, request: RunRequest): AttemptJudgement {
    if (settled.failure) return { ok: false, failure: settled.failure, detail: settled.detail ?? settled.failure }
    const outcome = settled.outcome
    if (!outcome) return { ok: false, failure: 'infra', detail: 'activation produced no outcome' }
    if (outcome.stopReason !== 'completed') {
      if (outcome.stopReason === 'refusal') {
        return {
          ok: false,
          failure: 'refusal',
          detail: `the child refused the task${outcome.diagnostic ? `: ${outcome.diagnostic}` : ''}`,
        }
      }
      const aborted = outcome.stopReason === 'aborted' || request.signal.aborted
      return {
        ok: false,
        failure: aborted ? 'aborted' : 'child-error',
        detail: `${outcome.stopReason}${outcome.diagnostic ? `: ${outcome.diagnostic}` : ''}`,
      }
    }
    let structured: JsonValue | undefined = outcome.structured
    if (task.outputSchema) {
      structured ??= extractJsonObject(outcome.text)
      if (structured === undefined) {
        return { ok: false, failure: 'schema-invalid', detail: 'no JSON object found in the worker result' }
      }
      const violations = validateJson(structured, task.outputSchema)
      if (violations.length > 0) {
        return { ok: false, failure: 'schema-invalid', detail: violations.join('; ') }
      }
    }
    return {
      ok: true,
      output: {
        text: outcome.text,
        childId: '',
        childName: '',
        ...(structured !== undefined ? { structured } : {}),
      },
    }
  }

  private async verifyTask(
    run: RunRecord,
    task: TaskSpec,
    output: TaskOutput,
    request: RunRequest,
    budget: Budget,
  ): Promise<{ pass: boolean; detail?: string }> {
    const { route: _workerRoute, ...taskWithoutRoute } = task
    const criticTask: TaskSpec = { ...taskWithoutRoute, id: `${task.id}-critic`, role: 'critic', dependsOn: [] }
    const resolved = resolveRoute(criticTask, request.routing)
    const reserved = budget.reserve()
    if (!reserved.ok) return { pass: true, detail: `verification skipped: ${reserved.reason}` }
    const controller = new AbortController()
    const onAbort = () => controller.abort(request.signal.reason)
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const handle = await this.ports.subagents.start({
        runId: run.id,
        kind: 'critic',
        taskId: task.id,
        attempt: 1,
        label: `verify: ${task.title}`.slice(0, 80),
        nameHint: `orch-${run.id}-${task.id}-v`,
        prompt: criticPrompt({ goal: request.goal, task, output, schemaViolations: [] }),
        parent: request.parent,
        signal: controller.signal,
        outputSchema: CRITIC_SCHEMA,
        ...(resolved.route ? { route: resolved.route } : {}),
        timeoutMs: request.defaults.timeoutMs,
      })
      const settled = await this.settle(handle, request.defaults.timeoutMs, controller.signal)
      const raw = settled.outcome?.structured ?? extractJsonObject(settled.outcome?.text ?? '')
      budget.record(settled.outcome?.text.length ?? 0, this.ports.usageOf?.(handle.childId) ?? emptyUsage())
      if (settled.failure || settled.outcome?.stopReason !== 'completed' || raw === undefined) {
        // A broken verifier must not silently pass the work, but it also must not
        // destroy a good result: report it and accept with a recorded caveat.
        return { pass: true, detail: `verification unavailable: ${settled.detail ?? settled.outcome?.stopReason ?? 'no critic output'}` }
      }
      const violations = validateJson(raw, CRITIC_SCHEMA)
      if (violations.length > 0) return { pass: true, detail: `verification malformed: ${violations.join('; ')}` }
      const verdict = raw as { pass: boolean; reason: string; fixes?: string[] }
      return verdict.pass
        ? { pass: true }
        : { pass: false, detail: `${verdict.reason}${verdict.fixes?.length ? `\nFixes:\n- ${verdict.fixes.join('\n- ')}` : ''}` }
    } catch (error) {
      return { pass: true, detail: `verification failed to start: ${messageOf(error)}` }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }

  // ----------------------------------------------------------------- helpers

  private async helper(
    request: RunRequest,
    budget: Budget,
    input: {
      kind: ActivationRequest['kind']
      attempt: number
      label: string
      nameHint: string
      prompt: string
      schema?: JsonObject
      role: string
      timeoutMs: number
    },
  ): Promise<unknown> {
    const reserved = budget.reserve()
    if (!reserved.ok) throw new EngineError(`budget exhausted before ${input.kind}: ${reserved.reason}`)
    const synthetic: TaskSpec = {
      id: input.kind,
      title: input.label,
      role: input.role,
      prompt: input.prompt,
      dependsOn: [],
      acceptance: [],
      critical: true,
      verify: false,
    }
    const resolved = resolveRoute(synthetic, request.routing)
    const handle = await this.ports.subagents.start({
      runId: request.id,
      kind: input.kind,
      attempt: input.attempt,
      label: input.label,
      nameHint: input.nameHint,
      prompt: input.prompt,
      parent: request.parent,
      signal: request.signal,
      ...(input.schema ? { outputSchema: input.schema } : {}),
      ...(resolved.route ? { route: resolved.route } : {}),
      timeoutMs: input.timeoutMs,
    })
    const settled = await this.settle(handle, input.timeoutMs, request.signal)
    budget.record(settled.outcome?.text.length ?? 0, this.ports.usageOf?.(handle.childId) ?? emptyUsage())
    if (settled.failure) throw new EngineError(`${input.kind} activation failed: ${settled.detail ?? settled.failure}`)
    if (settled.outcome?.stopReason !== 'completed') {
      throw new EngineError(`${input.kind} activation ended with ${settled.outcome?.stopReason ?? 'no result'}`)
    }
    if (!input.schema) return settled.outcome?.text ?? ''
    const raw = settled.outcome?.structured ?? extractJsonObject(settled.outcome?.text ?? '')
    if (raw === undefined) throw new EngineError(`${input.kind} produced no JSON payload`)
    return raw
  }

  /** Await an activation under a deadline; always dispose and drain on expiry. */
  private async settle(
    handle: ActivationHandle,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<SettleResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const guard = new Promise<{ kind: 'timeout' | 'aborted' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, timeoutMs))
      if (signal.aborted) resolve({ kind: 'aborted' })
      else signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true })
    })
    const work = handle.result.then(
      (outcome) => ({ kind: 'result' as const, outcome }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    try {
      const raced = await Promise.race([work, guard])
      if (raced.kind === 'result') return { outcome: raced.outcome }
      if (raced.kind === 'error') {
        return { failure: signal.aborted ? 'aborted' : 'infra', detail: messageOf(raced.error) }
      }
      // A child that ignores cancellation must not hang the run: bound the
      // dispose wait to a grace derived from the same deadline.
      const graceMs = Math.max(50, Math.min(8_000, timeoutMs))
      await Promise.race([
        handle.dispose().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
      ])
      const drained = await work
      const failure: FailureKind = raced.kind === 'timeout' ? 'timeout' : 'aborted'
      const detail =
        raced.kind === 'timeout' ? `exceeded ${timeoutMs}ms` : messageOf(abortError(signal))
      return {
        failure,
        detail,
        ...(drained.kind === 'result' ? { outcome: drained.outcome } : {}),
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async synthesize(run: RunRecord, plan: Plan, request: RunRequest, budget: Budget): Promise<void> {
    const enabled = plan.synthesis.enabled && request.defaults.synthesize
    const results = plan.tasks.map((task) => {
      const record = run.tasks[task.id]!
      return {
        spec: task,
        ...(record.output ? { output: record.output } : {}),
        status: record.status,
        ...(record.detail ? { detail: record.detail } : {}),
      }
    })
    if (!enabled || request.signal.aborted) return
    if (!results.some((result) => result.output !== undefined)) return
    try {
      const text = await this.helper(request, budget, {
        kind: 'synthesis',
        attempt: 1,
        label: `synthesize: ${request.goal.slice(0, 60)}`,
        nameHint: `orch-${run.id}-synth`,
        prompt: synthesisPrompt({
          goal: request.goal,
          ...(plan.synthesis.prompt ? { customPrompt: plan.synthesis.prompt } : {}),
          results,
          resultChars: request.defaults.dependencyContextChars,
        }),
        role: 'synthesizer',
        timeoutMs: request.defaults.timeoutMs,
      })
      if (typeof text === 'string' && text.trim().length > 0) run.synthesis = text.trim()
    } catch (error) {
      this.publish(run.id, {
        type: 'run/diagnostic',
        runId: run.id,
        message: `synthesis skipped: ${messageOf(error)}`,
      })
    }
  }

  private blockingFailures(run: RunRecord, plan: Plan): TaskSpec[] {
    return plan.tasks.filter((task) => {
      const status = run.tasks[task.id]?.status
      return task.critical && (status === 'failed' || status === 'skipped')
    })
  }

  private statusOf(run: RunRecord, plan: Plan): RunRecord['status'] {
    const statuses = plan.tasks.map((task) => run.tasks[task.id]?.status ?? 'pending')
    if (statuses.every((status) => status === 'succeeded')) return 'succeeded'
    const blocking = this.blockingFailures(run, plan)
    if (blocking.length > 0) return 'failed'
    return statuses.some((status) => status !== 'succeeded') ? 'partial' : 'succeeded'
  }

  private finishTask(
    run: RunRecord,
    taskId: TaskId,
    status: TaskStatus,
    failure?: FailureKind,
    detail?: string,
  ): void {
    const record = run.tasks[taskId]
    if (!record) return
    record.status = status
    if (failure) record.failure = failure
    else delete record.failure
    if (detail) record.detail = detail
    else delete record.detail
    this.publish(run.id, {
      type: 'task/ended',
      runId: run.id,
      taskId,
      status,
      ...(failure ? { failure } : {}),
      ...(detail ? { detail } : {}),
    })
  }

  private publish(runId: string, event: Parameters<EnginePorts['emit']>[0]): void {
    const time = this.ports.clock.now()
    try {
      this.ports.emit(event)
      this.ports.journal.append({ ...event, time })
    } catch (error) {
      this.ports.log?.(`orchestrator event listener failed for ${runId}`, error)
    }
  }
}