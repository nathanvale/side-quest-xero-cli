#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  echo "Usage: ./scripts/xero-statement-lines-finalize.sh <Q> <FY> <raw_json_path> [envelope_profile_path]"
  echo "Example: ./scripts/xero-statement-lines-finalize.sh 1 26 /tmp/xero-bankstatementsplus-raw.json"
  exit 1
fi

Q="$1"
FY="$2"
RAW_PATH="$3"
ENVELOPE_PROFILE="${4:-data/.xero-bankstatementsplus-envelope.json}"

if ! [[ "$Q" =~ ^[1-4]$ ]]; then
  echo "Invalid quarter: $Q (must be 1, 2, 3, or 4)"
  exit 1
fi

if ! [[ "$FY" =~ ^[0-9]{2,4}$ ]]; then
  echo "Invalid FY: $FY (must be 2 or 4 digits, e.g. 26 or 2026)"
  exit 1
fi

if [[ ! -f "$RAW_PATH" ]]; then
  echo "Raw response not found: $RAW_PATH"
  exit 2
fi

mkdir -p data

SL_FILE="data/$(python3 scripts/manage-quarters.py filename "$Q" "$FY")"
ENVELOPE_PATH="$(python3 scripts/xero-convert.py get-envelope-path "$ENVELOPE_PROFILE")"

python3 scripts/xero-convert.py "$RAW_PATH" "$SL_FILE" "$ENVELOPE_PATH"

LINE_COUNT="$(wc -l < "$SL_FILE" | tr -d ' ')"
python3 scripts/manage-quarters.py update-extraction "$Q" "$FY" "$LINE_COUNT"

echo "Statement lines finalized:"
echo "  file: $SL_FILE"
echo "  line_count: $LINE_COUNT"
