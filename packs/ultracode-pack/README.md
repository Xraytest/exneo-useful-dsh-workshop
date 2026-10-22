# ultracode-pack

A standalone ZCode plugin replicating Claude Code's `ultracode` mechanism
(reverse-engineered from the 2.1.286 native binary): keyword-triggered
exhaustive multi-agent orchestration, plus a standing mode with the
enter / sparse re-reminder / exit state machine.

## What it replicates

| Original mechanism (Claude Code) | Port in this pack |
|---|---|
| `IS(e,"ultracode")` keyword matcher → `workflow_keyword_request` attachment ("use the Workflow tool") | `ultracode` skill triggers on the keyword; mandates Workflow/Agent orchestration for the turn |
| `ultra_effort_enter` full reminder | Full reminder text injected at mode entry / keyword turns |
| `IZo` state machine: sparse re-reminder every N user turns (`tengu_juniper_sundial`, default ~5) | `.zcode/ultracode-mode.json` counter + `tick` in `ultracode-state.sh`, threshold default 5 |
| `ultra_effort_exit` reminder | Exit reminder announced once by `ultracode-mode` off transition |
| `tengu_ultra_effort` telemetry | Local-only `.zcode/ultracode-log.jsonl` events |
| Session-scoped `ultracode` settings key (never persists via interactive toggles) | Workspace state file you can inspect and delete |

Differences by design: ZCode has no client-side `budget_tokens`/effort plumbing
to override; depth is enforced by the orchestration contract
(`ultracode-orchestrate` playbook), not by API parameters.

## Components

- `skills/ultracode/` — trigger + mode contract. Fires on the `ultracode`
  keyword (any casing/mixed language) or when standing mode is active.
- `skills/ultracode-orchestrate/` — the playbook: vehicle choice
  (CreateWorkflow vs Agent fan-out vs solo), decomposition rules, parallel
  patterns, merge discipline, adversarial verification gate.
- `skills/ultracode-mode/` — standing-mode transitions (enter/exit/status/tick).
- `commands/ultracode.md` — `/ultracode [on|off|status]`; no argument runs the
  current turn in ultracode mode.
- `scripts/ultracode-state.sh` — state machine (pure bash, no dependencies).

## Usage

```text
ultracode 把这个模块的测试补齐并保证覆盖率     # keyword turn
/ultracode on                                  # standing mode on (threshold 5)
/ultracode status
/ultracode off
```

State: `.zcode/ultracode-mode.json` · Log: `.zcode/ultracode-log.jsonl`
(both in the workspace root, safe to delete at any time).
