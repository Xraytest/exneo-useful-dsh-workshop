#!/usr/bin/env bash
# ultracode-pack state machine: enter | exit | status | tick
# State: .zcode/ultracode-mode.json (workspace root, run from there)
# Log:   .zcode/ultracode-log.jsonl  (enter/sparse/tick/exit events)
set -euo pipefail

STATE=".zcode/ultracode-mode.json"
LOG=".zcode/ultracode-log.jsonl"
cmd="${1:-status}"
if [ $# -gt 1 ]; then shift; else shift 2>/dev/null || true; fi
threshold="${1:-5}"

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { mkdir -p .zcode; printf '{"event":"%s","ts":"%s"}\n' "$1" "$(now)" >> "$LOG"; }

read_field() { # $1=file $2=key $3=default
  if [ -f "$1" ]; then
    sed -n "s/.*\"$2\" *: *\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
  else
    echo "$3"
  fi
}

write_state() { # $1=active $2=entered_at $3=turns $4=threshold
  mkdir -p .zcode
  printf '{"active": %s, "entered_at": "%s", "turns_since_reminder": %s, "threshold": %s}\n' \
    "$1" "$2" "$3" "$4" > "$STATE"
}

case "$cmd" in
  enter)
    case "$threshold" in (*[!0-9]*|'') threshold=5;; esac
    [ "$threshold" -ge 1 ] || threshold=5
    write_state true "$(now)" 0 "$threshold"
    log enter
    echo "ACTIVE threshold=$threshold"
    ;;
  exit)
    write_state false "$(read_field "$STATE" entered_at "$(now)")" \
      "$(read_field "$STATE" turns_since_reminder 0)" "$(read_field "$STATE" threshold 5)"
    log exit
    echo "INACTIVE"
    ;;
  status)
    if [ -f "$STATE" ]; then cat "$STATE"; else echo '{"active": false}'; fi
    ;;
  tick)
    active=$(read_field "$STATE" active false)
    if [ "$active" != "true" ]; then echo "INACTIVE"; exit 0; fi
    th=$(read_field "$STATE" threshold "$threshold")
    case "$th" in (*[!0-9]*|'') th=5;; esac
    n=$(($(read_field "$STATE" turns_since_reminder 0) + 1))
    if [ "$n" -ge "$th" ]; then
      write_state true "$(read_field "$STATE" entered_at "$(now)")" 0 "$th"
      log sparse
      echo "REMIND $th"
    else
      write_state true "$(read_field "$STATE" entered_at "$(now)")" "$n" "$th"
      log tick
      echo "OK $n"
    fi
    ;;
  *)
    echo "usage: ultracode-state.sh {enter [threshold]|exit|status|tick [threshold]}" >&2
    exit 2
    ;;
esac
