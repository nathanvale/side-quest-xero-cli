# Workflow: Extract Data

Pull accounting and finance data from Xero API Explorer into local NDJSON files.

Tooling policy:
- Use `agent-browser` for all API Explorer UI interactions in this workflow.
- Do not switch to alternate browser tools mid-run; it increases token usage and breaks selector continuity.

## Context

Read before proceeding:
- [API Explorer navigation](../references/api-explorer-nav.md) - how to navigate the API Explorer UI with agent-browser (includes API switching and parameter filling patterns)

## Process

### Step 0: Determine target quarter

If the user specified a quarter (e.g., "extract Q1 FY26"), use it. Otherwise, show available quarters and ask:

```bash
python3 scripts/manage-quarters.py status
```

Ask: "Which quarter do you want to extract statement lines for?"

Once a quarter is selected, resolve the dates:

```bash
# Concrete example
python3 scripts/manage-quarters.py dates 1 26

# Template
python3 scripts/manage-quarters.py dates "$Q" "$FY"
```

This gives you the `FromDate` and `ToDate` for the BankStatementsPlus API call in Step 4e.
Never execute placeholder literals (`Q`, `FY`) directly.

### Step 0b: Run Quarter Gate preflight (mandatory)

Do not continue unless the quarter is complete and the quarter's bank export exists and date range matches.

```bash
# Concrete example
python3 scripts/manage-quarters.py gate 1 26

# Template
python3 scripts/manage-quarters.py gate "$Q" "$FY"
```

Validate first/last transaction dates are in the selected quarter before extracting.

### Step 1: Check existing data

Show accounting data (shared across all quarters):

```bash
mtime() {
  if stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" >/dev/null 2>&1; then
    stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1"   # macOS/BSD
  else
    stat -c '%y' "$1" | cut -d'.' -f1        # Linux
  fi
}
for f in data/accounts.ndjson data/bank-transactions.ndjson data/invoices.ndjson data/contacts.ndjson; do
  if [ -f "$f" ]; then
    echo "$(basename $f): $(wc -l < $f) records, last modified $(mtime "$f")"
  else
    echo "MISSING: $(basename $f)"
  fi
done
```

Show quarter-scoped statement lines:

```bash
ls -la data/statement-lines-fy*.ndjson 2>/dev/null
```

Ask: "Accounting data files already exist. Re-extract those too, or just statement lines for [target quarter]?"

Options:
1. **Full extract** -- Pull accounting data + statement lines for target quarter
2. **Statement lines only** -- Just extract for the target quarter (faster)
3. **Skip extraction** -- Use existing data

If no accounting data files exist, default to full extract.

If `data/.xero-explorer-env.json` exists, show current persisted bank account:

```bash
python3 scripts/xero-env.py get-bank-account-id 2>/dev/null || true
```

### Step 2: Ensure browser session

```bash
agent-browser --headed get url
# --expect-api: any | finance | accounting
#   any: just verify browser is on API Explorer (don't care which API)
#   finance: verify Finance API is selected
#   accounting: verify Accounting API is selected
./scripts/xero-browser-healthcheck.sh --expect-api any
```

If not on API Explorer:
```bash
agent-browser --headed open "https://api-explorer.xero.com/"
agent-browser --headed wait 3000
```

Check for the tenant selector to confirm we're logged in:
```bash
agent-browser --headed snapshot -i | grep "Tenant"
```

If no tenant visible, tell user to log in manually and wait.

### Step 3: CLI auth + tenant preflight

Confirm tenant is "Arthur & B Consulting":
```bash
bun src/cli/command.ts status --json
```

If CLI status reports auth/config warnings, run:
```bash
bun src/cli/command.ts auth
```

**Note:** Steps 4a-4d use direct `xero-cli` API calls (Accounting API). Step 4e uses browser Finance API (`BankStatementsPlus`).

### Step 4: Extract each dataset

**Execution guidance:** Prefer checked-in scripts (`scripts/xero-cli-extract.py`, `scripts/xero-convert.py`, `scripts/manage-quarters.py`, `scripts/xero-env.py`) for repeatable conversions.

Ensure `data/` directory exists with secure permissions:

```bash
mkdir -p data && chmod 700 data
```

Create a private temp directory for raw Finance API responses:

```bash
TMPDIR=$(mktemp -d)
echo "Using temp dir: $TMPDIR"
```

Define a clipboard capture helper (macOS/Linux/Wayland compatible, Finance step only):

```bash
clipboard_to_file() {
  local out="$1"
  if command -v pbpaste >/dev/null 2>&1; then
    pbpaste > "$out"
    command -v pbcopy >/dev/null 2>&1 && echo -n "" | pbcopy
    return 0
  fi
  if command -v wl-paste >/dev/null 2>&1; then
    wl-paste --no-newline > "$out"
    return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard -out > "$out"
    return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    xsel --clipboard --output > "$out"
    return 0
  fi
  return 1
}
```

#### 4a-4d: Accounting datasets via CLI (default path)

Extract Accounts, BankTransactions, Invoices, Contacts via `xero-cli`:

```bash
python3 scripts/xero-cli-extract.py all
```

Auto-route rule for agent execution:
- If CLI returns JSON error with `error.action: USE_BROWSER_FALLBACK` or `error.code: E_SCOPE_RESTRICTED`, do not loop retries.
- Move directly to browser fallback flow (Step 4e) and continue extraction.

Persist `BANK_ACCOUNT_ID` once accounts are available:

```bash
if ! BANK_ACCOUNT_ID="$(python3 scripts/xero-env.py get-bank-account-id 2>/dev/null)"; then
  python3 scripts/xero-env.py detect-bank-account-id data/accounts.ndjson || true
  BANK_ACCOUNT_ID="$(python3 scripts/xero-env.py get-bank-account-id 2>/dev/null || true)"
fi

if [ -n "${BANK_ACCOUNT_ID:-}" ]; then
  echo "Using BANK_ACCOUNT_ID=$BANK_ACCOUNT_ID"
  echo "Tip: run this in your shell to persist for this session:"
  python3 scripts/xero-env.py export-snippet || true
else
  echo "BANK_ACCOUNT_ID not set yet. If multiple bank accounts exist, run:"
  echo "  python3 scripts/xero-env.py set-bank-account-id <AccountID>"
fi
```

If only one accounting dataset needs refresh, run one of:

```bash
python3 scripts/xero-cli-extract.py accounts
python3 scripts/xero-cli-extract.py bank-transactions
python3 scripts/xero-cli-extract.py invoices
python3 scripts/xero-cli-extract.py contacts
python3 scripts/xero-cli-extract.py payments
```

#### 4e: BankStatementsPlus (Finance API)

This step uses the **Finance API**, not the Accounting API. Follow the "Switching APIs" pattern from api-explorer-nav.md.

1. **Switch to Finance API:**
```bash
agent-browser --headed snapshot -i | grep "API"
# Replace @API_REF with the current API selector ref from snapshot:
agent-browser --headed click @API_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select API Xero Finance API"
agent-browser --headed wait 1000
agent-browser --headed snapshot -i
./scripts/xero-browser-healthcheck.sh --expect-api finance
```

If this healthcheck fails after API switch, do not continue.
- Treat it as likely session expiry or wrong API.
- Ask user to re-authenticate in the same browser session.
- Re-run Step 4e from API selection.

2. **Select endpoint:** BankStatementsPlus

3. **Select operation:** Get Bank Statements Plus

4. **Fill parameters** (see "Filling Parameters" in api-explorer-nav.md):
   - `BankAccountID`: use `$BANK_ACCOUNT_ID` from your environment (must match selected tenant)
   - `FromDate`: Use the value from `python3 scripts/manage-quarters.py dates Q FY` (Step 0)
   - `ToDate`: Use the value from `python3 scripts/manage-quarters.py dates Q FY` (Step 0)

Before filling the form:

```bash
if [ -z "${BANK_ACCOUNT_ID:-}" ]; then
  BANK_ACCOUNT_ID="$(python3 scripts/xero-env.py get-bank-account-id 2>/dev/null || true)"
fi

if [ -z "${BANK_ACCOUNT_ID:-}" ]; then
  echo "Missing BANK_ACCOUNT_ID."
  echo "Run: python3 scripts/xero-env.py detect-bank-account-id data/accounts.ndjson"
  echo "Or set explicitly: python3 scripts/xero-env.py set-bank-account-id <AccountID>"
  exit 1
fi
```

5. **Make request**, wait 15s, copy response:
```bash
agent-browser --headed wait 1000
agent-browser --headed find role button click --name "Make request"
agent-browser --headed wait 15000
agent-browser --headed find role button click --name "response-body-copy"
sleep 1
if clipboard_to_file "$TMPDIR/xero-bankstatementsplus-raw.json"; then
  echo "Saved clipboard response to $TMPDIR/xero-bankstatementsplus-raw.json"
else
  echo "Clipboard tools unavailable. Save the response body manually to $TMPDIR/xero-bankstatementsplus-raw.json"
  exit 1
fi
```

If the copied payload is login HTML or non-JSON, treat this as auth expiry:
- stop conversion,
- ask user to re-authenticate in the same `agent-browser` session,
- rerun Step 4e from API selection.

6. **Inspect response structure first** -- the envelope is uncertain:
```bash
python3 scripts/xero-convert.py inspect-envelope "$TMPDIR/xero-bankstatementsplus-raw.json"
```

If `inspect-envelope` fails (non-zero exit, invalid JSON, or unrecognized structure):
1. Save the raw clipboard content to `data/.debug-envelope-raw.json` for inspection
2. Report the error to the user with the raw structure summary
3. Do not attempt to convert -- ask user whether to retry extraction or inspect manually

Persist envelope detection so verification is one-time per environment:

```bash
ENVELOPE_FILE="data/.xero-bankstatementsplus-envelope.json"
```

- If `ENVELOPE_FILE` is missing: ask for confirmation once, then save detected path and key sample.
- If it exists and still matches the detected structure: continue automatically.
- If detected structure differs from saved profile: stop and ask for re-confirmation, then update the profile.

Save profile:

```bash
python3 scripts/xero-convert.py write-envelope-profile \
  "$TMPDIR/xero-bankstatementsplus-raw.json" \
  "data/.xero-bankstatementsplus-envelope.json"
```

7. **Convert + update quarter state** (single command):
```bash
./scripts/xero-statement-lines-finalize.sh "$Q" "$FY" "$TMPDIR/xero-bankstatementsplus-raw.json"
```

8. **Switch back to Accounting API** (clean session state):
```bash
agent-browser --headed snapshot -i | grep "API"
# Replace @API_REF with the current API selector ref from snapshot:
agent-browser --headed click @API_REF
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select API Xero Accounting API"
agent-browser --headed wait 1000
agent-browser --headed snapshot -i
./scripts/xero-browser-healthcheck.sh --expect-api accounting
```

### Step 5: API Explorer navigation pattern

For each endpoint switch, use this exact sequence:

```bash
# 1. Click endpoint dropdown (ref may vary -- snapshot first)
agent-browser --headed snapshot -i | grep "Endpoint"
# Replace @ENDPOINT_REF with the current endpoint selector ref from snapshot:
agent-browser --headed click @ENDPOINT_REF

# 2. Wait for dropdown to open
agent-browser --headed wait 500

# 3. Select endpoint by exact name
agent-browser --headed find role button click --name "Select endpoint ENDPOINT_NAME" --exact

# 4. Wait, then open operation dropdown
agent-browser --headed wait 500
agent-browser --headed snapshot -i | grep "Operation"
# Replace @OPERATION_REF with the current operation selector ref from snapshot:
agent-browser --headed click @OPERATION_REF

# 5. Select operation by exact name
agent-browser --headed wait 500
agent-browser --headed find role button click --name "Select operation OPERATION_NAME" --exact

# 6. Make request
agent-browser --headed wait 1000
agent-browser --headed find role button click --name "Make request"

# 7. Wait for response, then copy
agent-browser --headed wait WAIT_MS
agent-browser --headed find role button click --name "response-body-copy"
sleep 1
if clipboard_to_file "$TMPDIR/OUTPUT_FILE"; then
  echo "Saved clipboard response to $TMPDIR/OUTPUT_FILE"
else
  echo "Clipboard tools unavailable. Save response manually to $TMPDIR/OUTPUT_FILE"
  exit 1
fi
```

**Critical:** Always `wait 500` between dropdown interactions. The UI needs time to render options.

**Critical:** Always snapshot to get current refs before clicking. Refs change after navigation.

### Step 6: Clean up and report

Hook-safe temp cleanup:
- Do not use `rm -rf` (blocked by ADHD safety guard).
- Use the checked-in cleanup script:

```bash
python3 scripts/cleanup-tempdir.py "$TMPDIR" || true
```

If cleanup is skipped, OS temp cleanup is acceptable (`/tmp`, `/private/tmp`, `/var/folders/...`).

Report results:

```bash
echo "Extraction complete:"
for f in data/accounts.ndjson data/bank-transactions.ndjson data/invoices.ndjson data/contacts.ndjson; do
  if [ -f "$f" ]; then
    count=$(wc -l < "$f")
    size=$(du -h "$f" | cut -f1)
    echo "  $(basename $f): $count records ($size)"
  fi
done
echo ""
echo "Statement lines (per quarter):"
for f in data/statement-lines-fy*.ndjson; do
  if [ -f "$f" ]; then
    count=$(wc -l < "$f")
    size=$(du -h "$f" | cut -f1)
    echo "  $(basename $f): $count records ($size)"
  fi
done
echo ""
echo "Quarter status:"
python3 scripts/manage-quarters.py status
```

## Success Criteria

- [ ] All requested datasets extracted and saved as NDJSON
- [ ] Each file has >0 records
- [ ] Files are valid NDJSON (one JSON object per line)
- [ ] Files written with 0o600 permissions
- [ ] data/ directory is 0700
- [ ] Raw JSON responses cleaned up via `cleanup-tempdir.py` (or left in system temp as fallback)
- [ ] Clipboard cleared after each copy
- [ ] Record counts reported to user
- [ ] Statement lines saved to quarter-scoped file (e.g., `statement-lines-fy25-q4.ndjson`)
- [ ] `quarters.json` updated with extraction results
- [ ] Extraction count matches bank export count (Match column shows OK)
