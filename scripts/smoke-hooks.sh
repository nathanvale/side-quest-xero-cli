#!/usr/bin/env bash
set -euo pipefail

HOOK_PATH="${HOOK_PATH:-$HOME/.claude/hooks/adhd/adhd-coach.py}"

ok() { echo "[OK] $*"; }
warn() { echo "[WARN] $*"; }

if [[ ! -f "$HOOK_PATH" ]]; then
  warn "Skipped hook smoke tests (hook not found at $HOOK_PATH)"
  exit 0
fi

python3 scripts/hook-smoke.py

ok "Hook behavior smoke tests passed"
