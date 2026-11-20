# dsh-orchestrator

An orchestration plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it plans a task DAG, dispatches parallel subagents, routes roles to provider/model/effort, verifies results with critic passes, replans after critical failures, and synthesizes one final answer.

```
goal ──▶ planner ──▶ [ task ──▶ worker ──▶ critic? ]×DAG ──▶ synthesis ──▶ report
                      └────────── retry / replan / budget ──────────┘
```

## Tools

| Tool | What it does |
|---|---|
| `orch_run` | Plan and run one orchestration. `wait=await` (default) blocks the call and returns the final report; `wait=background` returns a run id immediately. |
| `orch_status` | Without `runId`: list live and recent runs. With `runId`: the full report — plan, task statuses, failures, synthesis. Reads live runs, in-memory history, and the durable journal. |
| `orch_cancel` | Cancel one live run, or every live run with `runId=all`. |

Workers are **fresh subagents** (the `spawn` backend): they have no memory of the calling conversation, so the planner writes self-contained prompts for every task. Task prompts, acceptance criteria, dependency outputs, and retry feedback all flow through the engine's prompt builders in `src/core/prompts.ts`.

## Tool options (orch_run)

`goal` (required) · `context` · `plan` (caller-authored plan as JSON text, skips the planner) · `runId` · `wait` · `maxParallel` · `maxActivations` · `maxTasks` · `timeoutMs` · `maxAttempts` · `maxReplans` · `verify` · `synthesize`.

A caller-supplied plan is `{"tasks":[{id,title,role,prompt,dependsOn,acceptance,critical,verify,outputSchema}]}`; ids match `^[a-z][a-z0-9_-]{0,31}$`, `outputSchema` must be an object-rooted JSON Schema using `type/oneOf/properties/required/additionalProperties/items/enum/const` (local bounds like `minLength` are validated by the engine but projected away for the harness).

## Configuration

Plugin config (Plugins page row, `cordis.patch.yml`, or profile patch):

```yaml
- id: orchestrator
  name: dsh-orchestrator
  config:
    provider: spawn            # ctx.subagents backend
    history: 20                # finished runs kept in memory
    defaults:                   # per-run defaults
      timeoutMs: 1200000        # per-activation timeout
      maxAttempts: 2
      verify: false             # critic pass on every task
      maxParallel: 3
      maxReplans: 1
      maxPlanRepairs: 1
      synthesize: true
      dependencyContextChars: 4000
    limits:                     # hard ceilings, all optional (sample shows every knob; the shipped default carries only maxActivations: 40)
      maxActivations: 40
      maxTasks: 24
      maxWallMs: 3600000
      maxOutputChars: 2000000
      maxTokens: 4000000
    routing:                    # role → route resolution
      roles:
        coder: { provider: p2, model: m2 }
        reviewer: { reasoningEffort: high }
      rules:
        - name: heavy-research
          match: { role: researcher }
          route: { model: big-context }
      default: { provider: p1 }
```

Routing precedence: explicit task route → first matching rule (wildcards allowed) → role map → `default` → inherit the parent's route. Routes become `agentOptions` overrides on each child. Note: a route that sets `provider`/`model` without `reasoningEffort` intentionally drops the parent's effort.

`routing.fallbacks` (optional, 0.3.0): the worker retry chain — attempt 1 uses the primary route, attempt 2 the first fallback, and so on (duplicates of the primary are dropped, past the end the last entry repeats; planner / critic / synthesis always stay on the primary route).


## Toolbox switch and per-session subagent menu

The dsh-workbench toolbox carries an Orchestrator switch (per session). **New sessions start disabled** — `orch_run` stays hidden and session-event triggers stay paused until the switch is turned on for that session. The switch persists per session in BOTH directions (on and off both stored under `$DSH_HOME/dsh-orchestrator/sessions.json`) and remains freely changeable at any time.

The row's secondary menu (子代理设置, v2 layout; everything per-session, live, changeable):

| Group | Setting | Semantics |
| --- | --- | --- |
| Status | top status line | compact summary of what is currently in effect (enabled / model / concurrency / wait / fallbacks) |
| Model & reasoning | default model | this session's `routing.default`; explicit role/rule routes in plugin config still win |
| | reasoning effort | **listed from the selected model's actual metadata** (llm `resolveModelInfo`) — no longer a hardcoded trio; when metadata is unavailable only 「模型默认」 remains |
| | subagent backend | spawn (fresh sessions) / fork (inherits the parent's completed turns) |
| Concurrency & wait | concurrency cap | `maxParallel` for runs started in this session (1..8); an explicit orch_run argument wins |
| | wait mode | background = every `orch_run` in this session returns the run id immediately (the cure for long foreground waits); await = block until done |
| Fallbacks | retry chain (max 6) | workers advance along it on retries; appended after the plugin's `routing.fallbacks`; reorder/remove inline |

Overall precedence: **explicit orch_run argument > session menu setting > plugin config** (within routing: explicit task route / rule / role map > session default route).

## Session-event triggers (opt-in)

Add `triggers` to the plugin config and a matching user message starts a background orchestration automatically:

```yaml
    triggers:
      - name: nightly-digest
        textIncludes: /digest
        goal: Compose the nightly workspace digest and write it to docs/digest.md
        context: Work from the current workspace; summarize changed files and open todos.
        once: true          # at most once per session (default)
      - name: scheduled-audit
        textIncludes: /audit
        source: [schedule]   # also match schedule-delivered prompts
        goal: Audit the terra_chat deployment
```

A trigger only fires while its session has a **live agent** (the delegation seam requires the exact live parent); matched-but-idle sessions are logged and skipped. Schedule-driven orchestration composes with DSH's own schedule system: a scheduled prompt delivered to a session can simply call `orch_run`, or match a `source: [schedule]` trigger as above.
## Journal and events

- Runs append a `<runId>.events.jsonl` event stream and a `<runId>.record.json` final record under `$DSH_HOME/dsh-orchestrator/runs` (override with `dataDir`).
- Cordis events: `orchestrator/run-start`, `orchestrator/run-end`, and the raw `orchestrator/event` stream (all `@mode emit`) for UI tails and observers.
- Token accounting folds each child session's `assistant/message` usage into the run budget.

## Architecture

```
src/core/   pure engine, no harness imports (types, graph, plan, router,
           budget, retry, jsonschema, prompts, engine, report)
src/dsh/    harness adapter (journal, config, runs, subagents port)
src/index.ts plugin entry: tools, config, events, usage accounting
test/       71 vitest cases; the engine runs offline against a scripted port
examples/offline-demo.ts   npm run demo — full lifecycle without a harness
```

The engine (`src/core/engine.ts`) executes: plan (with repair attempts) → parallel DAG waves (`maxParallel`) → schema/stop-reason judgement → optional critic → retry with backoff → dependency-failure cascade → replan (keep succeeded tasks) → budget guards → synthesis. Failure kinds: `timeout`, `aborted`, `child-error`, `schema-invalid`, `critic-rejected`, `start-failed`, `budget`, `dependency`, `infra`; only the first five retry.

## Install

Requires DSH >= 0.2.0-rc.1 (declared in `engines.dsh`).

```bash
npm install && npm run build
dsh plugin --profile desktop add <repo>/plugins/dsh-orchestrator
# or via GUI: Plugins → Install → <repo>/plugins/dsh-orchestrator
```

Then restart DSH (or let HMR reconcile). Verify with `plugin_manager list_plugins` and ask a session for its new `orch_run` tool.

## Limitations

- `spawn` children cannot be delegated further once the host depth cap is reached; configure `maxDepth` to change the ceiling.
- A degraded critic never destroys good work: when the verifier itself fails, the task succeeds with a recorded caveat.
- `wait=background` runs survive the tool call but nothing pushes their result into the parent conversation; poll `orch_status`.
- The engine enforces its own per-activation timeouts; the harness adds no transport-level timeout to `startActivation`.