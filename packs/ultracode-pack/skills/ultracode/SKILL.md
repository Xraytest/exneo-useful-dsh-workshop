---
name: ultracode
description: Ultracode mode — keyword-triggered exhaustive multi-agent orchestration. Use whenever the user's message contains the keyword "ultracode" (any casing, anywhere in the prompt, including mixed-language prompts like "ultracode 模式" or "用ultracode跑这个"), when the user asks to turn ultracode on/off/status, or when .zcode/ultracode-mode.json shows standing mode active and the current task is substantive. Opts the turn into deep orchestration: decompose the task, fan out subagents or a workflow, verify adversarially, and optimize for the most exhaustive correct answer rather than speed or cost.
---

# Ultracode

Replicates Claude Code's `ultracode` keyword: opting a turn into multi-agent
orchestration with an exhaustive-correctness mandate, plus a standing mode with
an enter / sparse re-reminder / exit state machine.

## Step 1 — Determine which mode this turn is in

Read `.zcode/ultracode-mode.json` in the workspace root (create nothing yet).

- File exists and `"active": true` → **standing mode**. This turn runs in
  ultracode regardless of keywords. Run the tick procedure in Step 2.
- Not active, but the user's message contains `ultracode` → **keyword turn**.
  This turn only. Do not create or modify the state file.
- Neither → exit this skill; handle the request normally.

## Step 2 — Standing-mode state machine (standing mode only)

Replicates the original `IZo` state machine: full reminder on entry, sparse
re-reminder every N real user turns, exit reminder once when turned off.

Manage the state through the bundled script (run from the workspace root):

```bash
"<plugin-root>/scripts/ultracode-state.sh" tick [threshold]   # increments counter
```

- If the script prints `REMIND <n>` → re-inject the **sparse reminder** text
  (below) into your working context for this turn and reset is already done.
- If it prints `OK <n>` → continue silently.
- `threshold` defaults to 5. No-Node fallback: read the JSON, increment
  `turns_since_reminder` with the Edit tool, and apply the same rule.

Turning the mode on/off/status transitions live in the `ultracode-mode` skill
(`/<skills>/ultracode-mode/SKILL.md`); the `/ultracode on|off|status` command
uses it. When you turn the mode **on**, inject the **full reminder**; when
**off**, inject the **exit reminder** once.

## Step 3 — The mode contract (inject for this turn)

Apply these mandates to how you work this turn. They are the faithful port of
the original `ultra_effort_enter` reminder texts:

**Full reminder (mode entry or keyword turn):**

> Ultracode is on: optimize for the most exhaustive, correct answer — not the
> fastest or cheapest. Use the Workflow tool on every substantive task; token
> cost is not a constraint. Solo only on conversational/trivial turns.

**Sparse reminder (periodic re-assertion while standing):**

> Ultracode is still on — use the Workflow tool on substantive tasks; see the
> orchestration playbook for quality patterns.

**Exit reminder (once, on mode exit):**

> Ultracode is off — the Workflow tool's standard opt-in rule applies again.

## Step 4 — Orchestrate

For this turn:

1. **Solo only if the turn is conversational or trivial.** Trivial means:
   a question with no code change, a single-file edit under ~20 lines with no
   cross-file dependencies, or pure conversation. Everything else is
   substantive.
2. **Substantive tasks go through orchestration.** Under this pack's
   convention, the `ultracode` keyword (or standing mode) *is* the user's
   explicit workflow request:
   - Load the `dynamic-workflows` skill, then author and submit a
     CreateWorkflow run when the task has clean subtask boundaries and a
     checkable completion gate.
   - Otherwise fan out with the Agent tool in parallel (several agents in one
     message) — e.g. exploratory tasks where a persisted workflow script adds
     nothing.
   Read `ultracode-orchestrate` (the sibling skill) before decomposing: it
   carries the decomposition rules, parallel patterns, merge discipline and
   verification gates.
3. **Verify adversarially before declaring done.** A result is "done" only
   after a reviewer pass whose mandate is to find flaws — not to agree (see
   the playbook's verification gate).

## Notes

- Token cost is explicitly not a constraint in this mode — but every spawned
  agent must have a concrete deliverable. Idle agents are waste, not depth.
- The original injects these reminders as `isMeta` context; here the SKILL.md
  body plays that role — reread Step 3 at the start of each substantive turn
  rather than working from memory.
