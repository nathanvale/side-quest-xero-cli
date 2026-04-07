#!/usr/bin/env bash
set -euo pipefail

ok() { echo "[OK] $*"; }
warn() { echo "[WARN] $*"; }
fail() { echo "[FAIL] $*"; exit 1; }

expect_exit() {
  local expected="$1"
  local cmd="$2"
  set +e
  eval "$cmd" >/tmp/smoke-guards.out 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -ne "$expected" ]]; then
    echo "Command: $cmd"
    echo "Expected exit: $expected, got: $rc"
    echo "--- output ---"
    cat /tmp/smoke-guards.out
    fail "unexpected exit code"
  fi
}

# Pick an unused synthetic quarter slot for non-mutating state validation tests.
pick_synthetic_quarter() {
  local fy q state_path sl_path
  for fy in 90 91 92 93 94 95 96 97 98 99; do
    for q in 1 2 3 4; do
      state_path="data/.xero-explorer-state-fy${fy}-q${q}.json"
      sl_path="data/statement-lines-fy${fy}-q${q}.ndjson"
      if [[ ! -e "$state_path" && ! -e "$sl_path" ]]; then
        echo "$q $fy $state_path $sl_path"
        return 0
      fi
    done
  done
  return 1
}

echo "Running xero-explorer smoke guards..."

python3 -m py_compile \
  scripts/manage-quarters.py \
  scripts/parse-qif.py \
  scripts/xero-convert.py \
  scripts/xero-env.py \
  scripts/cleanup-tempdir.py \
  scripts/hook-smoke.py \
  scripts/xero-reconcile-report.py \
  scripts/atomic-json-write.py \
  scripts/xero-ndjson-peek.py \
  scripts/xero-contact-lookup.py \
  scripts/xero-cli-extract.py
ok "Python syntax checks passed"

bash -n \
  scripts/xero-explorer-runner.sh \
  scripts/xero-statement-lines-finalize.sh
ok "Shell syntax checks passed"

if rg -n '^\s*python3?\s+-c\b|^\s*python3?\s+<<' .claude/skills/xero-explorer >/tmp/smoke-inline.out 2>&1; then
  echo "--- inline interpreter patterns found ---"
  cat /tmp/smoke-inline.out
  fail "xero-explorer docs contain inline interpreter commands that hooks will block"
fi
ok "xero-explorer docs avoid inline interpreter commands"

if ! rg -n "python3 scripts/xero-cli-extract.py all" .claude/skills/xero-explorer/workflows/extract.md >/dev/null 2>&1; then
  fail "extract workflow is missing CLI-first accounting extraction command"
fi
ok "extract workflow includes CLI-first accounting extraction"

if ! rg -n 'browser-automation:ba-browse", "api-explorer.xero.com healthcheck' .claude/skills/xero-explorer/workflows/extract.md >/dev/null 2>&1; then
  fail "extract workflow is missing /browse healthcheck dispatch"
fi
ok "extract workflow dispatches /browse healthcheck"

if ! rg -n "extract-bankstatementsplus" .claude/skills/xero-explorer/workflows/extract.md >/dev/null 2>&1; then
  fail "extract workflow is missing /browse statement-line extraction dispatch"
fi
ok "extract workflow dispatches /browse statement-line extraction"

if find .claude/agents -maxdepth 1 -type f -name 'xero-*-agent.md' | grep -q .; then
  fail "retired xero browser agent files still exist"
fi
if find .claude/skills -maxdepth 1 -mindepth 1 -type d -name 'xero-*' ! -name 'xero-cli' ! -name 'xero-explorer' | grep -q .; then
  fail "retired xero browser skill directories still exist"
fi
ok "retired xero browser agents and skills are removed"

bash -n scripts/smoke-hooks.sh
ok "Hook smoke script syntax checks passed"

# CLI guardrails
expect_exit 1 "python3 scripts/manage-quarters.py"
ok "manage-quarters usage exits non-zero"

expect_exit 1 "python3 scripts/manage-quarters.py next-action 1"
ok "next-action partial args rejected"

expect_exit 1 "python3 scripts/manage-quarters.py mark-imported 1 99"
ok "mark-imported unknown quarter fails"

expect_exit 1 "python3 scripts/manage-quarters.py update-extraction 1 99 10"
ok "update-extraction unknown quarter fails"

# Runner argument validation
expect_exit 1 "./scripts/xero-explorer-runner.sh 5 25 batch"
ok "runner rejects invalid quarter"

expect_exit 1 "./scripts/xero-explorer-runner.sh 4 badfy batch"
ok "runner rejects invalid FY"

expect_exit 1 "./scripts/xero-explorer-runner.sh 4 25 batch --dry-run --extra"
ok "runner rejects extra args"

# parse-qif guardrails
expect_exit 1 "python3 scripts/parse-qif.py"
ok "parse-qif requires exactly one path"

expect_exit 2 "python3 scripts/parse-qif.py /tmp/definitely-missing-file.qif"
ok "parse-qif missing file exits with code 2"

# Domain checks against known repo state (non-mutating)
if [[ -f data/bank-export-fy25-q4-apr-jun.qif ]]; then
  expect_exit 0 "python3 scripts/manage-quarters.py gate 4 25"
  ok "gate passes for known completed quarter with present QIF"
else
  warn "Skipped gate(4,25) success check (QIF fixture missing)"
fi

expect_exit 2 "python3 scripts/manage-quarters.py gate 4 26"
ok "future quarter gate blocks with code 2"

expect_exit 2 "python3 scripts/manage-quarters.py validate-state 4 25"
ok "validate-state missing file returns code 2"

./scripts/smoke-hooks.sh
ok "ADHD hook behavior smoke tests passed"

# Lifecycle validation (synthetic state files, cleaned up automatically)
if SLOT="$(pick_synthetic_quarter)"; then
  read -r Q_SYN FY_SYN STATE_SYN SL_SYN <<<"$SLOT"
  trap 'rm -f "$STATE_SYN" "$SL_SYN"' EXIT

  cat > "$SL_SYN" <<'EOF'
{"statementLineId":"sid-1","payee":"TEST","amount":-10.0,"postedDate":"2025-04-01"}
EOF

  cat > "$STATE_SYN" <<EOF
{
  "quarter": "Q${Q_SYN} FY${FY_SYN}",
  "statementLinesFile": "${SL_SYN}",
  "transactions": {
    "sid-1": {
      "status": "classified",
      "confirmedAt": "2026-03-05T10:00:00+11:00"
    }
  }
}
EOF
  expect_exit 11 "python3 scripts/manage-quarters.py validate-state ${Q_SYN} ${FY_SYN}"
  ok "validate-state rejects invalid lifecycle (classified with confirmedAt)"

  cat > "$STATE_SYN" <<EOF
{
  "quarter": "Q${Q_SYN} FY${FY_SYN}",
  "statementLinesFile": "${SL_SYN}",
  "transactions": {
    "sid-1": {
      "status": "posted",
      "confirmedAt": "2026-03-05T10:00:00+11:00"
    }
  }
}
EOF
  expect_exit 11 "python3 scripts/manage-quarters.py validate-state ${Q_SYN} ${FY_SYN}"
  ok "validate-state rejects posted transaction missing postedAt"

  cat > "$STATE_SYN" <<EOF
{
  "quarter": "Q${Q_SYN} FY${FY_SYN}",
  "statementLinesFile": "${SL_SYN}",
  "transactions": {
    "sid-1": {
      "status": "confirmed",
      "confirmedAt": "2026-03-05T10:00:00+11:00"
    }
  }
}
EOF
  expect_exit 0 "python3 scripts/manage-quarters.py validate-state ${Q_SYN} ${FY_SYN}"
  ok "validate-state accepts valid lifecycle state"
else
  warn "Skipped lifecycle validation tests (no synthetic quarter slot available)"
fi

echo "All smoke guards passed."
