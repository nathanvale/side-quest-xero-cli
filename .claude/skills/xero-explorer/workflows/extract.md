# Workflow: Extract Data

Pull accounting and finance data from Xero API Explorer into local NDJSON files.

Tooling policy:
- Use `/browse` (`browser-automation:ba-browse`) for all API Explorer UI
  interactions in this workflow.
- Do not dispatch legacy Xero browser agents or call `agent-browser`
  directly from this workflow.

## Context

Read before proceeding:
- [API Explorer navigation](../references/api-explorer-nav.md) - legacy
  interaction patterns now mirrored into the canonical
  `api-explorer-xero` domain assets used by `/browse`

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

Dispatch `/browse` to verify the API Explorer session is ready:

```text
Skill("browser-automation:ba-browse", "api-explorer.xero.com healthcheck")
```

Parse the canonical managed-domain report:
- `SUCCESS` -> continue to Step 3
- `NEEDS_HUMAN` -> relay the reason to the user (for example,
  "Please log in to Xero API Explorer in your browser"), preserve the
  `resume_run_id`, then re-dispatch healthcheck
- `FAILED` -> investigate the reason, attempt recovery (open API Explorer URL manually), then re-dispatch

### Step 3: CLI auth + tenant preflight

Confirm the active tenant matches your target org:
```bash
bun run xero-cli status --json
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

This step uses the **Finance API**, not the Accounting API. `/browse`
owns the browser sequence: ensuring the correct API, filling
parameters, making the request, copying the response, and returning a
canonical report with the staged response path.

Before dispatching, ensure BANK_ACCOUNT_ID is available:

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

Dispatch `/browse`:

```text
Skill(
  "browser-automation:ba-browse",
  "api-explorer.xero.com extract-bankstatementsplus for Q{N} FY{YY} ({FromDate}..{ToDate}) using BANK_ACCOUNT_ID={BANK_ACCOUNT_ID}"
)
```

Parse the canonical report:
- `SUCCESS` -> `### Findings` includes the staged raw response path
  (referred to below as `RESPONSE_PATH`). Continue to envelope
  inspection.
- `NEEDS_HUMAN` -> relay to user, preserving `resume_run_id`,
  `human_action`, and `screenshot_path`. After re-login, resume the same
  flow.
- `FAILED` -> investigate reason, attempt recovery.

After successful extraction, continue with envelope inspection and conversion:

1. **Inspect response structure** -- the envelope is uncertain:
```bash
python3 scripts/xero-convert.py inspect-envelope "$RESPONSE_PATH"
```

If `inspect-envelope` fails (non-zero exit, invalid JSON, or unrecognized structure):
1. Save a copy of the staged raw response to `data/.debug-envelope-raw.json` for inspection
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
  "$RESPONSE_PATH" \
  "data/.xero-bankstatementsplus-envelope.json"
```

2. **Convert + update quarter state** (single command):
```bash
./scripts/xero-statement-lines-finalize.sh "$Q" "$FY" "$RESPONSE_PATH"
```

### Step 5: API Explorer navigation (canonical domain assets)

Browser-based API Explorer navigation is now handled by the canonical
`api-explorer-xero` managed domain used by `/browse`. The target flows
own the dropdown cascade patterns, retry logic, and response-copy
handling.

For any additional API Explorer operations not covered by the task types
above, dispatch `/browse` with the appropriate domain and target flow.
See the [API Explorer navigation reference](../references/api-explorer-nav.md)
only as maintenance context for the underlying patterns.

### Step 6: Clean up and report

The raw browser payload stays under `/browse`'s caller-owned transaction
path for resume/debug purposes. Do not delete those staged files as part
of the normal extract workflow.

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
- [ ] Raw JSON response remains available via `/browse` transaction state for resume/debug
- [ ] Raw JSON response path captured from the canonical `/browse` report
- [ ] Record counts reported to user
- [ ] Statement lines saved to quarter-scoped file (e.g., `statement-lines-fy25-q4.ndjson`)
- [ ] `quarters.json` updated with extraction results
- [ ] Extraction count matches bank export count (Match column shows OK)
