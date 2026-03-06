#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: ./scripts/xero-explorer-runner.sh <Q> <FY> <mode:batch|rapid-fire> [--dry-run]"
  echo "Example: ./scripts/xero-explorer-runner.sh 4 25 batch"
  echo "Example: ./scripts/xero-explorer-runner.sh 4 25 rapid-fire --dry-run"
  exit 1
fi

if [[ $# -gt 4 ]]; then
  echo "Invalid arguments: too many parameters."
  echo "Usage: ./scripts/xero-explorer-runner.sh <Q> <FY> <mode:batch|rapid-fire> [--dry-run]"
  exit 1
fi

Q="$1"
FY="$2"
MODE="$3"
DRY_RUN="false"
if [[ -n "${4:-}" && "${4}" != "--dry-run" ]]; then
  echo "Invalid option: ${4} (only --dry-run is supported)"
  exit 1
fi
if [[ "${4:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

if [[ "$MODE" != "batch" && "$MODE" != "rapid-fire" ]]; then
  echo "Invalid mode: $MODE (must be batch or rapid-fire)"
  exit 1
fi

if ! [[ "$Q" =~ ^[1-4]$ ]]; then
  echo "Invalid quarter: $Q (must be 1, 2, 3, or 4)"
  exit 1
fi

if ! [[ "$FY" =~ ^[0-9]{2,4}$ ]]; then
  echo "Invalid FY: $FY (must be 2 or 4 digits, e.g. 25 or 2025)"
  exit 1
fi

python3 scripts/manage-quarters.py gate "$Q" "$FY"

SL_FILE="data/$(python3 scripts/manage-quarters.py filename "$Q" "$FY")"
STATE_FILE="$(python3 scripts/manage-quarters.py statefile "$Q" "$FY")"
FY2=$(printf '%02d' $((10#$FY % 100)))
Q_LABEL="Q${Q} FY${FY2}"

echo "Explorer session config"
echo "  quarter: $Q_LABEL"
echo "  mode: $MODE"
echo "  dry-run: $DRY_RUN"
echo "  statement-lines: $SL_FILE"
echo "  state-file: $STATE_FILE"
echo ""
if [[ -f "$SL_FILE" ]]; then
  echo "Next step: run /xero-explorer reconcile $Q_LABEL"
else
  echo "Next step: run /xero-explorer extract $Q_LABEL (statement lines not found yet)"
fi
if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry-run requested: perform classification + preview only, no POST writes."
fi
