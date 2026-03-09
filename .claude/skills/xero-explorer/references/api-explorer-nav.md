# API Explorer Navigation Reference

Patterns for driving the Xero API Explorer at `api-explorer.xero.com` via `agent-browser`.

## Command Syntax

The `agent-browser` CLI uses these patterns throughout the skill:

```bash
agent-browser --headed snapshot -i          # Capture page accessibility tree (use -i for concise output)
agent-browser --headed get url              # Print the current page URL
agent-browser --headed open "URL"           # Navigate to a URL
agent-browser --headed click @REF           # Click an element by its snapshot ref
agent-browser --headed find role button click --name "TEXT"         # Find a button by accessible name and click it
agent-browser --headed find role button click --name "TEXT" --exact # Same but exact-match only (no substring)
agent-browser --headed fill @REF "value"    # Set an input field's value (always prefer over `type`)
agent-browser --headed wait MS              # Pause for MS milliseconds
agent-browser --headed press "KEY"          # Press a keyboard key (e.g., "ctrl+a", "Enter")
```

All commands require `--headed` so the user can observe and intervene.

## Session Setup

```bash
# Open API Explorer (use --headed so user can see/intervene)
agent-browser --headed open "https://api-explorer.xero.com/"
agent-browser --headed wait 3000

# Verify logged in -- tenant selector should be visible
agent-browser --headed snapshot -i | grep "Tenant"
```

If not logged in, the user must authenticate manually (browser-based Xero login).

## The Select Pattern

The API Explorer has 3 cascading dropdowns: API -> Endpoint -> Operation.
Each must be selected in order. The pattern is always:

1. **Snapshot** to get current refs (they change after every navigation)
2. **Click** the dropdown button
3. **Wait 500ms** for the dropdown to render
4. **Find and click** the option by exact name
5. **Wait 500ms** before the next interaction

```bash
# Example: Select Accounting API -> Accounts -> Get Accounts
agent-browser --headed snapshot -i   # get fresh refs

# API dropdown (look for "API Select API" or "API Xero Accounting API-button")
agent-browser --headed click @API_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select API Xero Accounting API"

# Endpoint dropdown
agent-browser --headed wait 500
agent-browser --headed snapshot -i   # refs changed!
agent-browser --headed click @ENDPOINT_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select endpoint Accounts" --exact

# Operation dropdown
agent-browser --headed wait 500
agent-browser --headed snapshot -i   # refs changed again
agent-browser --headed click @OPERATION_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select operation Get Accounts" --exact
```

## Retry Wrapper (DX Standard)

For any critical interaction (`click`, `find ... click`, `fill`):

1. Verify target element exists in snapshot first
2. Retry up to 3 times with backoff `500ms`, `1000ms`, `2000ms`
3. Re-snapshot before every retry
4. On final failure, stop and report actionable recovery

Example approach:

```bash
# pseudo-flow
agent-browser --headed snapshot -i > /tmp/snap.txt
grep -q "Select endpoint Accounts" /tmp/snap.txt || echo "selector missing"
# retry with backoff if missing/click fails
```

## Making Requests

```bash
# Wait for Make request button to be enabled
agent-browser --headed wait 1000
agent-browser --headed find role button click --name "Make request"

# Wait for response -- varies by dataset size
# Accounts:            5000ms
# BankTransactions:   10000ms (large dataset)
# Invoices:            5000ms
# Contacts:            8000ms (large dataset)
# BankStatementsPlus: 15000ms (Finance API, large dataset)
agent-browser --headed wait WAIT_MS
```

## Copying Responses

The response body is in a read-only code area. Use the copy button:

```bash
# Find and click the copy button
agent-browser --headed find role button click --name "response-body-copy"

# CRITICAL: Wait 1s for clipboard to populate, then save IMMEDIATELY
sleep 1
if command -v pbpaste >/dev/null 2>&1; then
  pbpaste > /tmp/xero-ENDPOINT-raw.json
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

## Verifying Responses

After saving raw JSON:

```bash
# Example key values: Accounts, BankTransactions, Invoices, Contacts
python3 scripts/xero-convert.py verify-key /tmp/xero-ENDPOINT-raw.json EXPECTED_KEY
```

If Status is not "OK" or records is empty, the response may not have loaded yet.
Wait longer and re-copy.

## Converting to NDJSON

```bash
python3 scripts/xero-convert.py /tmp/xero-ENDPOINT-raw.json data/OUTPUT.ndjson KEY
```

## Common Ref Patterns

Refs change constantly. Always snapshot before interacting. Common patterns:

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

## Switching Endpoints (When API Already Selected)

If the API is already selected, you only need to change Endpoint + Operation:

```bash
agent-browser --headed snapshot -i
# Click the current endpoint button (has "-button" suffix)
agent-browser --headed click @ENDPOINT_BUTTON_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select endpoint NEW_ENDPOINT" --exact
# Then select operation...
```

## Switching APIs

To change between APIs (e.g., Accounting -> Finance), use the API dropdown. **Endpoint and Operation dropdowns reset after switching APIs** -- you must re-select them.

```bash
# 1. Snapshot to get current API dropdown ref
agent-browser --headed snapshot -i | grep "API"

# 2. Click API dropdown
agent-browser --headed click @API_REF
agent-browser --headed wait 500

# 3. Select the target API
agent-browser --headed find role button click --name "Select API Xero Finance API"

# 4. Wait for dropdowns to reset, then re-snapshot
agent-browser --headed wait 1000
agent-browser --headed snapshot -i   # endpoint/operation refs have changed!
```

After switching, proceed with the normal Select Pattern for Endpoint and Operation.

To switch back:

```bash
agent-browser --headed snapshot -i | grep "API"
agent-browser --headed click @API_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select API Xero Accounting API"
agent-browser --headed wait 1000
agent-browser --headed snapshot -i
```

## Filling Parameters

Some operations require parameters (e.g., BankStatementsPlus needs `BankAccountID`, `FromDate`, `ToDate`). Parameter input fields appear after selecting an operation.

```bash
# 1. Snapshot to find parameter input field refs
agent-browser --headed snapshot -i

# 2. Click the field to focus it
agent-browser --headed click @FIELD_REF
agent-browser --headed wait 300

# 3. Fill the value using `fill` (NOT `type`)
agent-browser --headed fill @FIELD_REF "value"
```

**IMPORTANT:** Do NOT use `type` for parameter values. The `type` command parses its argument as a CSS selector, so values containing hyphens (like UUIDs `601e62a1-...`) will break. Always use `fill @ref "value"` instead.

**Clearing existing values** (if field is pre-populated):

```bash
agent-browser --headed click @FIELD_REF
agent-browser --headed wait 300
agent-browser --headed press "ctrl+a"
agent-browser --headed fill @FIELD_REF "new value"
```

**BankStatementsPlus parameters:**

| Parameter | Example value |
|-----------|--------------|
| `BankAccountID` | `$BANK_ACCOUNT_ID` (tenant-specific) |
| `FromDate` | `2025-04-01` |
| `ToDate` | `2025-06-30` |

Fill all required parameters before clicking "Make request."

## Strict Mode Errors

If `find text` matches multiple elements, use `--exact`:

```bash
# BAD: matches "Get Bank Transactions" AND "Get Bank Transactions History"
agent-browser --headed find text "Get Bank Transactions" click

# GOOD: exact match
agent-browser --headed find role button click --name "Select operation Get Bank Transactions" --exact
```

## Session Timeout

The API Explorer session can expire after ~30 minutes of inactivity.
Signs of expiration:
- Snapshot shows login form instead of API controls
- Requests return auth errors

Recovery: Tell user to log in again in the browser window.

## Selector Health Check

Before long multi-step runs, quickly validate core selectors are present:

- API dropdown
- Endpoint dropdown
- Operation dropdown
- Make request button
- response-body-copy button

If one is missing, do not proceed with extraction/reconcile writes. Re-open API Explorer, re-snapshot, and re-validate first.
