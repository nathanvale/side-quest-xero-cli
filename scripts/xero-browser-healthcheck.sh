#!/usr/bin/env bash
set -euo pipefail

EXPECTED_API="any"
if [[ "${1:-}" == "--expect-api" ]]; then
  EXPECTED_API="${2:-}"
  shift 2 || true
fi

if [[ "$EXPECTED_API" != "any" && "$EXPECTED_API" != "finance" && "$EXPECTED_API" != "accounting" ]]; then
  echo "Usage: ./scripts/xero-browser-healthcheck.sh [--expect-api any|finance|accounting]"
  exit 2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "Browser healthcheck failed: agent-browser is not installed or not on PATH."
  exit 1
fi

if ! agent-browser --headed snapshot -i > "$TMP"; then
  echo "Browser healthcheck failed: unable to capture browser snapshot."
  echo "Open API Explorer and ensure you are logged in, then retry."
  exit 1
fi

URL="$(agent-browser --headed get url 2>/dev/null || true)"
if ! echo "$URL" | grep -qi "api-explorer.xero.com"; then
  echo "Browser healthcheck failed: not on Xero API Explorer."
  echo "Current URL: ${URL:-unknown}"
  echo "Open https://api-explorer.xero.com/ and retry."
  exit 1
fi

required=("API" "Endpoint" "Operation" "Make request")
missing=0
for token in "${required[@]}"; do
  if ! grep -qi "$token" "$TMP"; then
    echo "Missing selector token: $token"
    missing=1
  fi
done

if ! grep -Eqi "Tenant|Arthur" "$TMP"; then
  echo "Missing tenant selector token (likely logged out)."
  missing=1
fi

if [[ "$EXPECTED_API" == "finance" ]]; then
  if ! grep -Eqi "Xero Finance API|Finance API" "$TMP"; then
    echo "Expected Finance API selected, but it was not detected."
    missing=1
  fi
fi

if [[ "$EXPECTED_API" == "accounting" ]]; then
  if ! grep -Eqi "Xero Accounting API|Accounting API" "$TMP"; then
    echo "Expected Accounting API selected, but it was not detected."
    missing=1
  fi
fi

if [[ $missing -ne 0 ]]; then
  echo "Browser healthcheck failed: expected API Explorer controls were not found."
  echo "Re-open API Explorer and re-login if needed."
  exit 1
fi

echo "Browser healthcheck OK"
