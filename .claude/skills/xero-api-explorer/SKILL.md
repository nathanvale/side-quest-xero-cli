---
name: xero-api-explorer
description: Xero API Explorer navigation recipes -- dropdown cascades, API switching, parameter filling, response copying, healthcheck. Used by xero-extract-agent.
user-invocable: false
---

# Xero API Explorer Navigation

Patterns for driving the Xero API Explorer at `api-explorer.xero.com` via `agent-browser`.

## Connection

Use `agent-browser --auto-connect` for ALL commands. This connects to the user's existing Chrome session.

Smoke test:

```bash
agent-browser --auto-connect get url
```

Full healthcheck:

```bash
./scripts/xero-browser-healthcheck.sh --expect-api any
```

## Gotchas

Before starting any task, read domain-specific gotchas:

```bash
cat docs/gotchas/browser-agent/api-explorer-xero.md
```

If you discover a new gotcha during execution, append it to that file.

## Command Syntax

```bash
agent-browser --auto-connect snapshot -i          # Capture page accessibility tree (concise)
agent-browser --auto-connect get url              # Print the current page URL
agent-browser --auto-connect open "URL"           # Navigate to a URL
agent-browser --auto-connect click @REF           # Click an element by its snapshot ref
agent-browser --auto-connect find role button click --name "TEXT"         # Find button by name and click
agent-browser --auto-connect find role button click --name "TEXT" --exact # Exact-match only
agent-browser --auto-connect fill @REF "value"    # Set an input field's value (always prefer over `type`)
agent-browser --auto-connect wait MS              # Pause for MS milliseconds
agent-browser --auto-connect press "KEY"          # Press a keyboard key (e.g., "ctrl+a", "Enter")
```

## The Select Pattern

The API Explorer has 3 cascading dropdowns: API -> Endpoint -> Operation.
Each must be selected in order:

1. **Snapshot** to get current refs (they change after every navigation)
2. **Click** the dropdown button
3. **Wait 500ms** for the dropdown to render
4. **Find and click** the option by exact name
5. **Wait 500ms** before the next interaction

```bash
# Example: Select Accounting API -> Accounts -> Get Accounts
agent-browser --auto-connect snapshot -i   # get fresh refs

# API dropdown
agent-browser --auto-connect click @API_REF
agent-browser --auto-connect wait 500
agent-browser --auto-connect find role button click --name "Select API Xero Accounting API"

# Endpoint dropdown
agent-browser --auto-connect wait 500
agent-browser --auto-connect snapshot -i   # refs changed!
agent-browser --auto-connect click @ENDPOINT_REF
agent-browser --auto-connect wait 500
agent-browser --auto-connect find role button click --name "Select endpoint Accounts" --exact

# Operation dropdown
agent-browser --auto-connect wait 500
agent-browser --auto-connect snapshot -i   # refs changed again
agent-browser --auto-connect click @OPERATION_REF
agent-browser --auto-connect wait 500
agent-browser --auto-connect find role button click --name "Select operation Get Accounts" --exact
```

## Switching APIs

To change between APIs (e.g., Accounting -> Finance):

```bash
agent-browser --auto-connect snapshot -i | grep "API"
agent-browser --auto-connect click @API_REF
agent-browser --auto-connect wait 500
agent-browser --auto-connect find role button click --name "Select API Xero Finance API"
agent-browser --auto-connect wait 1000
agent-browser --auto-connect snapshot -i   # endpoint/operation refs have changed!
```

**Endpoint and Operation dropdowns reset after switching APIs** -- you must re-select them.

To switch back:

```bash
agent-browser --auto-connect snapshot -i | grep "API"
agent-browser --auto-connect click @API_REF
agent-browser --auto-connect wait 500
agent-browser --auto-connect find role button click --name "Select API Xero Accounting API"
agent-browser --auto-connect wait 1000
agent-browser --auto-connect snapshot -i
```

## Filling Parameters

Some operations require parameters (e.g., BankStatementsPlus needs `BankAccountID`, `FromDate`, `ToDate`).

```bash
# 1. Snapshot to find parameter input field refs
agent-browser --auto-connect snapshot -i

# 2. Click the field to focus it
agent-browser --auto-connect click @FIELD_REF
agent-browser --auto-connect wait 300

# 3. Fill the value using `fill` (NOT `type`)
agent-browser --auto-connect fill @FIELD_REF "value"
```

**IMPORTANT:** Do NOT use `type` for parameter values. The `type` command parses its argument as a CSS selector, so values containing hyphens (like UUIDs `601e62a1-...`) will break. Always use `fill @ref "value"` instead.

**Clearing existing values** (if field is pre-populated):

```bash
agent-browser --auto-connect click @FIELD_REF
agent-browser --auto-connect wait 300
agent-browser --auto-connect press "ctrl+a"
agent-browser --auto-connect fill @FIELD_REF "new value"
```

**BankStatementsPlus parameters:**

| Parameter | Example value |
|-----------|--------------|
| `BankAccountID` | `$BANK_ACCOUNT_ID` (tenant-specific) |
| `FromDate` | `2025-04-01` |
| `ToDate` | `2025-06-30` |

Fill all required parameters before clicking "Make request."

## Making Requests

```bash
agent-browser --auto-connect wait 1000
agent-browser --auto-connect find role button click --name "Make request"

# Wait for response -- varies by dataset size
# Accounts:            5000ms
# BankTransactions:   10000ms (large dataset)
# Invoices:            5000ms
# Contacts:            8000ms (large dataset)
# BankStatementsPlus: 15000ms (Finance API, large dataset)
agent-browser --auto-connect wait WAIT_MS
```

## Copying Responses

The response body is in a read-only code area. Use the copy button:

```bash
agent-browser --auto-connect find role button click --name "response-body-copy"

# CRITICAL: Wait 1s for clipboard to populate, then save IMMEDIATELY
sleep 1
if command -v pbpaste >/dev/null 2>&1; then
  pbpaste > /tmp/xero-ENDPOINT-raw.json
  echo -n "" | pbcopy   # Clear clipboard
elif command -v wl-paste >/dev/null 2>&1; then
  wl-paste --no-newline > /tmp/xero-ENDPOINT-raw.json
elif command -v xclip >/dev/null 2>&1; then
  xclip -selection clipboard -out > /tmp/xero-ENDPOINT-raw.json
elif command -v xsel >/dev/null 2>&1; then
  xsel --clipboard --output > /tmp/xero-ENDPOINT-raw.json
else
  echo "No clipboard CLI found. Save response manually."
  exit 1
fi
```

**Never do any other clipboard operation between copy and paste.**

## Response Validation

After saving raw JSON:

```bash
python3 scripts/xero-convert.py verify-key /tmp/xero-ENDPOINT-raw.json EXPECTED_KEY
```

If Status is not "OK" or records is empty, the response may not have loaded yet. Wait longer and re-copy.

Auth expiry detection: if the copied payload is login HTML or non-JSON, stop and return `NEEDS_HUMAN` with reason "session expired."

## Retry Wrapper (DX Standard)

For any critical interaction (`click`, `find ... click`, `fill`):

1. Verify target element exists in snapshot first
2. Retry up to 3 times with backoff `500ms`, `1000ms`, `2000ms`
3. Re-snapshot before every retry
4. On final failure, stop and report actionable recovery

## Healthcheck

Run before long multi-step sequences:

```bash
./scripts/xero-browser-healthcheck.sh --expect-api any
# or
./scripts/xero-browser-healthcheck.sh --expect-api finance
./scripts/xero-browser-healthcheck.sh --expect-api accounting
```

Validates: agent-browser installed, browser reachable, on API Explorer URL, tenant visible, core selectors present, expected API selected.

## POST Pattern (BankTransactions)

For POSTing transactions via the API Explorer:

1. Ensure Accounting API is selected
2. Select BankTransactions endpoint
3. Select POST operation (not GET)
4. Paste the JSON body into the request body field
5. Click "Make request"
6. Wait 10000ms for response
7. Copy and validate response (check for 200 status)

## Common Ref Patterns

Refs change constantly. Always snapshot before interacting.

| Element | Typical ref name pattern |
|---------|------------------------|
| Tenant selector | `Tenant Arthur & B Consulting` |
| API dropdown (Accounting) | `API Select API` or `API Xero Accounting API-button` |
| API dropdown (Finance) | `API Xero Finance API-button` |
| Endpoint dropdown | `Endpoint Select endpoint` or `Endpoint NAME-button` |
| Operation dropdown | `Operation Select operation` or `Operation NAME-button` |
| Make request | `Make request` |
| Copy response | `response-body-copy` |
| Parameter fields | Input fields like `BankAccountID`, `FromDate`, `ToDate` |

## Session Timeout

The API Explorer session can expire after ~30 minutes of inactivity.
Signs: snapshot shows login form, requests return auth errors.

Recovery: Return `NEEDS_HUMAN` with reason "Xero session expired -- please log in again in the browser."
