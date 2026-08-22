#!/usr/bin/env bash
# E2E purge checklist for reliability RAS/FI waves.
# Default: dry-run (print steps). Pass --execute to actually purge.
# Prefer a dedicated TEST_HOME for destructive runs.
set -euo pipefail

EXECUTE=0
TEST_HOME="${TEST_HOME:-$HOME}"
DATA_ROOT="${AGENT_INSIGHT_DATA_DIR:-$TEST_HOME/.agent-insight}"
OPENCODE_DIR="${XDG_CONFIG_HOME:-$TEST_HOME/.config}/opencode"
XIAOO_DIR="${XIAOO_HOME:-$TEST_HOME/.xiaoo}"

usage() {
  cat <<'EOF'
Usage: scripts/e2e-purge-reliability.sh [--execute] [--help]

  (no flag)   Print the purge checklist only (safe).
  --execute   Stop local services, remove Insight/RAS/FI hooks from common
              client dirs under TEST_HOME, and archive then clear DATA_ROOT.

Env:
  TEST_HOME              Home root to purge (default: $HOME)
  AGENT_INSIGHT_DATA_DIR Override data dir (default: $TEST_HOME/.agent-insight)
  XIAOO_HOME             Xiaoo config root (default: $TEST_HOME/.xiaoo)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage; exit 2 ;;
  esac
done

step() { printf '%s\n' "$*"; }

step "=== Reliability E2E purge checklist ==="
step "TEST_HOME=$TEST_HOME"
step "DATA_ROOT=$DATA_ROOT"
step "OPENCODE_DIR=$OPENCODE_DIR"
step "XIAOO_DIR=$XIAOO_DIR"
step ""
step "1) Stop services / workers / uploaders"
step "   - repo: bash scripts/stop.sh (if running)"
step "   - kill leftover: fi-worker, opencode_uploader, ras runtime"
step "2) Uninstall client Insight / RAS / FI plugins & hooks"
step "   - OpenCode: remove agent-insight / ras / fault-injection plugin entries under $OPENCODE_DIR"
step "   - Xiaoo: remove Insight/RAS/FI hooks under $XIAOO_DIR"
step "3) Archive then clear data"
step "   - backup $DATA_ROOT → ${DATA_ROOT}.bak.<timestamp> (or delete after backup)"
step "4) Confirm no residue"
step "   - no fi-worker / ras process"
step "   - OpenCode/Xiaoo configs have no agent-insight RAS/FI hooks"
step "   - $DATA_ROOT absent or empty"
step "5) Reinstall from integrate branch (setup + optional FI worker)"
step "6) Run Wave business checks"
step ""

if [ "$EXECUTE" -ne 1 ]; then
  step "(dry-run) Re-run with --execute to perform purge under TEST_HOME."
  exit 0
fi

if [ "$TEST_HOME" = "$HOME" ] && [ -z "${AGENT_INSIGHT_DATA_DIR:-}" ]; then
  echo "Refusing --execute against real \$HOME without AGENT_INSIGHT_DATA_DIR." >&2
  echo "Set TEST_HOME to a dedicated path, or set AGENT_INSIGHT_DATA_DIR." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$ROOT/scripts/stop.sh" ]; then
  step "Stopping repo services..."
  bash "$ROOT/scripts/stop.sh" || true
fi

pkill -f 'fi-worker\.js' 2>/dev/null || true
pkill -f 'opencode_uploader' 2>/dev/null || true
pkill -f 'agent_ras' 2>/dev/null || true

# OpenCode: strip known plugin dirs / config fragments when present
if [ -d "$OPENCODE_DIR" ]; then
  step "Scrubbing OpenCode plugins under $OPENCODE_DIR"
  rm -rf \
    "$OPENCODE_DIR/plugin/agent-insight" \
    "$OPENCODE_DIR/plugin/agent_insight" \
    "$OPENCODE_DIR/plugins/agent-insight" \
    "$OPENCODE_DIR/node_modules/@agent-insight" \
    2>/dev/null || true
fi

if [ -d "$XIAOO_DIR" ]; then
  step "Scrubbing Xiaoo hooks under $XIAOO_DIR"
  find "$XIAOO_DIR" -maxdepth 4 \( \
      -iname '*agent-insight*' -o -iname '*agent_insight*' -o \
      -iname '*agent-ras*' -o -iname '*fault-injection*' -o -iname '*fault_injection*' \
    \) -print -exec rm -rf {} + 2>/dev/null || true
fi

if [ -e "$DATA_ROOT" ]; then
  stamp="$(date +%Y%m%d%H%M%S)"
  backup="${DATA_ROOT}.bak.${stamp}"
  step "Archiving $DATA_ROOT → $backup"
  mv "$DATA_ROOT" "$backup"
fi

step "Purge execute finished. Reinstall from integrate branch before Wave E2E."
