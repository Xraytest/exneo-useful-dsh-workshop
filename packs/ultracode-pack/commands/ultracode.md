---
description: Turn ultracode mode on/off, report status, or run this turn under ultracode
argument-hint: "[on|off|status] — empty = run this turn in ultracode mode"
---

Handle the `/ultracode` command with argument `$ARGUMENTS`:

- **`on`** (or `开启`): run the `enter` transition per the `ultracode-mode`
  skill — write `.zcode/ultracode-mode.json` via the state script, then
  announce entry with the full reminder text from the `ultracode` skill.
- **`off`** (or `关闭`): run the `exit` transition and announce the exit
  reminder once.
- **`status`** (or `状态`): run the `status` transition and report the state.
- **Empty / anything else**: treat as a keyword turn — follow the `ultracode`
  skill for this turn only, with `$ARGUMENTS` (if non-empty) as the task to
  execute under the ultracode contract. Do not modify the state file.
