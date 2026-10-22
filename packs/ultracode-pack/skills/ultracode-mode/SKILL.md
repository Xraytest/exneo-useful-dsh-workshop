---
name: ultracode-mode
description: Manage ultracode standing mode — turn it on/off, report status, and run the per-turn tick of the enter / sparse re-reminder / exit state machine. Use when the user says "ultracode on", "ultracode off", "ultracode status", "关闭ultracode", "开启ultracode", when the /ultracode command passes on|off|status, or when the ultracode skill hands over a standing-mode transition. State lives in .zcode/ultracode-mode.json in the workspace root.
---

# Ultracode standing mode

Standing mode makes every substantive task run through ultracode without
needing the keyword — the port of Claude Code's session-scoped `ultracode`
settings key. State is a single JSON file, workspace-scoped:

```json
{"active": true, "entered_at": "2026-10-01T09:00:00Z", "turns_since_reminder": 0, "threshold": 5}
```

## Transitions

All transitions go through the bundled script, run from the workspace root:

```bash
"<plugin-root>/scripts/ultracode-state.sh" enter [threshold]   # default threshold: 5
"<plugin-root>/scripts/ultracode-state.sh" exit
"<plugin-root>/scripts/ultracode-state.sh" status
"<plugin-root>/scripts/ultracode-state.sh" tick [threshold]    # used by the ultracode skill each substantive turn
```

If the script is unavailable (no Node/python3), edit
`.zcode/ultracode-mode.json` directly with file tools and keep the same
fields; append the same one-line events to `.zcode/ultracode-log.jsonl`.

**On (`enter`)** — sets `active:true`, zeroes the counter, logs `enter`, and
you announce the entry using the **full reminder** text from the ultracode
skill, Step 3. Mirrors the original `ultra_effort_enter` attachment.

**Off (`exit`)** — sets `active:false`, logs `exit`, and you announce the
**exit reminder** once: "Ultracode is off — the Workflow tool's standard
opt-in rule applies again." Mirrors `ultra_effort_exit`.

**Status** — print the raw state plus a one-line interpretation (active since
when, turns until next sparse reminder).

**Tick** — called by the ultracode skill at the start of each substantive
turn while standing mode is active. Increments `turns_since_reminder`; when
the counter reaches `threshold`, resets it and signals `REMIND` so the
ultracode skill re-injects the **sparse reminder**. Mirrors the original
`IZo` state machine: enter once, sparse re-assertion every N real user turns,
exit once.

## Rules

- Interactive toggles never outlive the session's intent: the state file is
  workspace-scoped precisely so the user can see and clear it — tell them the
  file path when they toggle.
- Turning the mode on does not retroactively orchestrate past turns; it takes
  effect from the next substantive task.
- If the state file is corrupted or missing fields, recreate it with
  defaults and say so.
