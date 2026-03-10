# Workflow: Rapid-Fire Reconcile Fallback

Match unreconciled statement lines to accounts and POST reconciliation entries
through the Xero API Explorer browser.

CSV-first is now the recommended review path for most quarters:
- Build the seal
- Export the review CSV
- Copy to Google Drive
- Review in Sheets over time
- Read back / merge iterations
- Use rapid-fire only as a fallback for the final stubborn items

See [csv-review.md](csv-review.md) for the full offline review loop.

Use this workflow only when:
- the user explicitly asks for live terminal/browser reconciliation
- or the CSV loop is down to a small set of stubborn items where rapid-fire review is faster than another spreadsheet round

## Context

Read before proceeding:
- [API Explorer navigation](../references/api-explorer-nav.md) - browser interaction patterns
- [Matching rules](../references/matching-rules.md) - categorization, contact lookup, POST templates
- [State schema](../references/state-schema.md) - state file lifecycle and write discipline
- [Reconcile test matrix](../references/reconcile-test-matrix.md) - edge-case checks for undo/resume/preview

Tooling policy:
- Use checked-in scripts for inspection/conversion (`scripts/*.py`, `scripts/*.sh`).
- Do not use inline interpreter execution (`python -c`, `python <<'PYEOF'`) because hooks block it.
- Prefer these hook-safe inspection commands instead of ad-hoc shell pipelines:
  - `python3 scripts/xero-ndjson-peek.py "$SL_FILE" 3 statementLineId payee amount postedDate isReconciled`
  - `python3 scripts/xero-ndjson-peek.py data/accounts.ndjson 5 Code Name Type AccountID TaxType`
  - `python3 scripts/xero-contact-lookup.py summary data/bank-transactions.ndjson`
  - `python3 scripts/xero-contact-lookup.py build data/bank-transactions.ndjson data/.xero-contact-lookup.json`

## Phase A: Setup

Goal: confirm we have valid data, a mode selection, and classified transactions before presenting anything.

### Canonical entrypoint (recommended)

Use the runner to avoid placeholder mistakes:

```bash
# Concrete example
./scripts/xero-explorer-runner.sh 4 25 batch
# Concrete dry-run example
./scripts/xero-explorer-runner.sh 4 25 rapid-fire --dry-run

# Variableized template
export Q=4
export FY=25
./scripts/xero-explorer-runner.sh "$Q" "$FY" batch
# or dry-run
./scripts/xero-explorer-runner.sh "$Q" "$FY" rapid-fire --dry-run
```

Never execute placeholder literals (`Q`, `FY`) directly.

Before long sessions, run:

```bash
./scripts/xero-browser-healthcheck.sh
```

### Step 1: Resolve and lock target quarter

Quarter selection is mandatory for reconciliation.

```bash
python3 scripts/manage-quarters.py status
```

If the user passed a quarter (for example, `Q1 FY26`), use that. Otherwise ask them to choose one.

Resolve the quarter-scoped statement-line file:

```bash
# Concrete example
export Q=4
export FY=25
export SL_FILE="data/$(python3 scripts/manage-quarters.py filename 4 25)"
export STATE_FILE="$(python3 scripts/manage-quarters.py statefile 4 25)"
echo "Target quarter: Q4 FY25"
echo "Statement lines file: $SL_FILE"
echo "State file: $STATE_FILE"

# Template
export SL_FILE="data/$(python3 scripts/manage-quarters.py filename "$Q" "$FY")"
export STATE_FILE="$(python3 scripts/manage-quarters.py statefile "$Q" "$FY")"
echo "Target quarter: Q{N} FY{YY}"
echo "Statement lines file: $SL_FILE"
echo "State file: $STATE_FILE"

# Fail fast if statement lines file is missing
if [ ! -f "$SL_FILE" ]; then
  echo "ERROR: $SL_FILE not found. Run /xero-explorer extract for this quarter first."
  exit 1
fi
```
Never execute placeholder literals (`Q`, `FY`) directly.

Use this same quarter in all progress updates and summaries.

### Step 1b: Run Quarter Gate preflight (mandatory)

Do not continue unless the quarter is complete and the quarter's bank export exists and the date range matches.

```bash
# Concrete example
python3 scripts/manage-quarters.py gate 4 25

# Template
python3 scripts/manage-quarters.py gate "$Q" "$FY"
```

Validate that first/last transaction dates are within the selected quarter.
If mismatch, stop and ask user to fix export/file naming before reconciliation.

### Step 2: Check for existing state

```bash
PREV_STATE_FILE="${STATE_FILE%.json}.prev.json"

if [ -f "$STATE_FILE" ]; then
  echo "State file found"
else
  echo "No state file -- fresh start"
fi
```

If state file exists, load and validate (see state-schema.md). Show summary:

```bash
python3 scripts/manage-quarters.py validate-state "$Q" "$FY"
```

```
Resuming from [date]. Mode: [mode]. R1: X done. R2: Y/Z done. N remaining.
```

Ask: "Resume where you left off, or start fresh?"

- **Resume:** POST any `confirmed` items first (recovering from interruption), then continue with `classified` items in `activeRound`
- **Fresh start:** Archive state to `$PREV_STATE_FILE`. Ask: "Keep the research cache?"
- If state exists for a different quarter/file than `SL_FILE`, stop and ask whether to switch to that quarter or archive the old state first.
- Ensure state includes `quarter`, `statementLinesFile`, and quarter-scoped `dataSource` fields before continuing.

### Step 3: Check data files

```bash
mtime() {
  if stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1" >/dev/null 2>&1; then
    stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$1"   # macOS/BSD
  else
    stat -c '%y' "$1" | cut -d'.' -f1        # Linux
  fi
}
for f in "$SL_FILE" data/accounts.ndjson; do
  if [ -f "$f" ]; then
    echo "$(basename "$f"): $(wc -l < "$f") records, modified $(mtime "$f")"
  else
    echo "CRITICAL MISSING: $f -- run /xero-explorer extract first"
  fi
done

for f in data/bank-transactions.ndjson data/invoices.ndjson data/contacts.ndjson data/payments.ndjson; do
  if [ -f "$f" ]; then
    echo "$(basename "$f"): $(wc -l < "$f") records (optional enrichment)"
  else
    echo "$(basename "$f"): not found (optional -- contact lookup won't be available)"
  fi
done
```

Optional hook-safe quick peek commands:

```bash
python3 scripts/xero-ndjson-peek.py "$SL_FILE" 3 statementLineId payee amount postedDate isReconciled
python3 scripts/xero-ndjson-peek.py data/accounts.ndjson 5 Code Name Type AccountID TaxType
```

**Critical files (required):**
- `data/statement-lines-fy{YY}-q{N}.ndjson` -- reconciliation source for the selected quarter
- `data/accounts.ndjson` -- chart of accounts

**Optional files (enrichment):**
- `data/bank-transactions.ndjson` -- contact history lookup (normalized payee -> ContactID)
- `data/invoices.ndjson` -- invoice matching for RECEIVE transactions
- `data/contacts.ndjson` -- full contact details
- `data/payments.ndjson` -- payment audit trail for post-execute verification

If critical files are missing, stop and tell user to run `/xero-explorer extract` first.

**Staleness check:** If `extractedAt` (from state file) or file mtime is older than 48 hours, warn. If older than 7 days, warn more strongly but don't block.

### Step 3b: BANK_ACCOUNT_ID preflight (required before POST phase)

Persist and validate `BANK_ACCOUNT_ID` early so POST does not fail at the final stage:

```bash
if ! BANK_ACCOUNT_ID="$(python3 scripts/xero-env.py get-bank-account-id 2>/dev/null)"; then
  python3 scripts/xero-env.py detect-bank-account-id data/accounts.ndjson || true
  BANK_ACCOUNT_ID="$(python3 scripts/xero-env.py get-bank-account-id 2>/dev/null || true)"
fi

if [ -z "${BANK_ACCOUNT_ID:-}" ]; then
  echo "Missing BANK_ACCOUNT_ID."
  echo "Run: python3 scripts/xero-env.py set-bank-account-id <AccountID>"
  exit 1
fi

echo "Using BANK_ACCOUNT_ID=$BANK_ACCOUNT_ID"
```

If multiple bank accounts exist, stop and ask the user to set the intended account explicitly.

### Step 4: Mode selection

Ask user to choose reconciliation mode:

1. **Batch approval** -- group transactions by category, show all line items numbered, approve groups at once. Best for clearing the bulk efficiently.
2. **Rapid-fire** -- one transaction at a time with smart defaults pre-filled. Best for tricky items or when you're in the zone.

Dry-run is an execution flag, not a mode:
- Use runner flag `--dry-run` to run classification + preview without POST writes.

Record mode in state.

Mode can be switched during the session at safe checkpoints (between groups in batch mode, or between items in rapid-fire mode):
- Save state immediately
- Update `mode`
- Continue from the same `activeRound` and remaining IDs (no restart required)
- If execution flag is dry-run, stop automatically after safe preview and save state

Mode switch commands (operator-facing):
- `mode batch`
- `mode rapid-fire`

### Step 4b: Session shape (anti-boredom defaults)

Before presenting items, set:

- **Mission cap:** default `25 items or 15 minutes` (whichever comes first)
- **Focus level:** `low`, `normal`, or `deep`
  - `low`: smaller chunks, fewer details, more check-ins
  - `normal`: balanced
  - `deep`: larger batches, fewer interruptions

At mission boundary:
- Show a mini-win summary
- Ask: `continue next mission / switch mode / stop and save`
- Default to `stop and save` if user does not explicitly continue

### Step 5: Load and classify statement lines

```bash
python3 scripts/xero-reconcile-report.py classify-overview "$SL_FILE"
```

**Step 5a: Build reconciliation history cache (primary account code source)**

The CLI `history` command returns actual reconciled account codes from Xero - far more reliable than bank-transactions.ndjson (which often has empty LineItems). Build/refresh the cache at session start:

```bash
# Build history cache (refresh if older than 7 days)
HISTORY_CACHE="data/.xero-history-cache.json"
if [ -f "$HISTORY_CACHE" ]; then
  AGE_DAYS=$(( ($(date +%s) - $(stat -f '%m' "$HISTORY_CACHE")) / 86400 ))
  echo "History cache exists (${AGE_DAYS}d old)"
  if [ "$AGE_DAYS" -gt 7 ]; then
    echo "Cache is stale -- refreshing..."
    bun run xero-cli history --since 2024-01-01 --json > "$HISTORY_CACHE"
  fi
else
  echo "Building history cache from Xero..."
  bun run xero-cli history --since 2024-01-01 --json > "$HISTORY_CACHE"
fi
```

Use history cache during classification to look up account codes by contact:

```bash
# Single contact lookup (when needed during rounds)
bun run xero-cli history --since 2024-01-01 --contact "Body Fit Training Sydney" --json

# Verify what else uses a specific account code
bun run xero-cli history --since 2024-01-01 --account-code 485 --json
```

When history shows a contact has been consistently assigned to one account code, this is the highest confidence signal (+80 in the scoring model). Show the user their own history as evidence: "You've assigned Body Fit to 485 (Subscriptions) 38 times."

**Step 5b: Build contact lookup (secondary source - for ContactID resolution)**

Build contact lookup from `bank-transactions.ndjson` (if present) using hook-safe script commands:

```bash
python3 scripts/xero-contact-lookup.py summary data/bank-transactions.ndjson
python3 scripts/xero-contact-lookup.py build data/bank-transactions.ndjson data/.xero-contact-lookup.json
```

This lookup is still valuable for **ContactID resolution** (linking to existing Xero contacts in POST bodies), even though its account codes are unreliable.

If `reconciled with account code` is very low in the contact lookup, that's expected -- use the CLI history cache as the primary account code source instead.

Classify each unreconciled statement line into rounds:
- **Round 1 (auto-matched):** normalized payee matches history or contact lookup, amount within historical range
- **Round 2 (AI-researched):** unrecognized payee with identifiable business name
- **Round 3 (truly unknown):** generic descriptions, no useful signal

Store classifications in state file. Report counts:

```
Classification complete:
  Round 1 (auto-matched): 220 items
  Round 2 (needs research): 55 items
  Round 3 (truly unknown): 25 items
  Total: 300 items

Ready to start?
```

**Verification:** round 1 + round 2 + round 3 must equal total unreconciled. If counts don't add up, report discrepancy before continuing.

Classification contract:
- Every classified transaction must include `confidenceScore`, `confidenceBand`, and `confidenceVersion`
- `confidenceVersion` must match the scoring contract in `references/matching-rules.md`
- Do not classify without a score

## Phase B: Rounds 1-3 (Presentation and Confirmation)

Goal: get user approval for all categorizable statement lines.

### Round 1: Auto-matched (high confidence)

**Warm-up framing:** "Starting with the easy ones to build momentum. These are recurring charges that match your history exactly."

Always process the top easiest groups first (highest confidence + strongest recurrence) to create quick wins in the first 2-3 minutes.

Present via selected mode:

**Batch mode:**
- Group by suggested account code, all line items numbered
- Show confidence badge per group: `[High]`, `[Medium]`, `[Low]`
- Adaptive batch size by confidence:
  - `High`: max 25 items
  - `Medium`: max 12 items
  - `Low`: max 5 items (force smaller reviews)
- Per group show items, then ask:

```
[High] SOFTWARE/SAAS (42 items, $2,340.50) -> 495

  1. GITHUB          $9.00    2026-02-01  (matched 11 months)
  2. GITHUB          $9.00    2026-01-01  (matched 11 months)
  3. FIGMA           $21.00   2026-02-15  (matched 8 months)
  ...
  42. LINEAR          $8.00    2026-01-15  (matched 3 months)

Approve all 42? (yes / except N,N / change code / skip group)
```

- "except N,N" pulls those items into Round 3
- "change code" re-assigns the group, then re-confirms

**Rapid-fire mode:**
- One at a time, suggested code pre-filled
- `[1/300] GITHUB ($9.00, 2026-02-01, SPEND) -> 495 Software/SaaS (11 prior matches)`
- Enter = approve, type code = override, "skip" = skip
- Streak counter: "Streak: 12 in a row!" (reset without fanfare on skip)
- Pace indicator: "Pace: ~4 items/min"

**After each confirmation:** save state immediately (two-point write -- see state-schema.md).

Two-point write: (1) write state immediately after user approval (status -> confirmed),
(2) write state again after successful POST (status -> posted). This ensures no approved
item is lost if the session crashes between approval and POST.

### Undo affordance (before POST starts)

Support an `undo last` command for accidental approvals while still in Phase B:
- Revert the most recent approval event (group or single item) from `confirmed` back to `classified`
- Restore previous `accountCode`/decision metadata from `approvalHistory`
- Save state immediately after undo
- If no history exists, respond: "Nothing to undo yet."
- Undo is disabled once any item has status `posted` in the current state.
- If undo is requested after posting has started, respond: "Undo unavailable after writes begin. Use manual review/export."

**After Round 1:** "Round 1 complete: N easy matches done! Round 2: M items need a closer look. Take a break if you need one -- your progress is saved."

### Round 2: AI-researched (medium confidence)

**Consent prompt:** "Round 2 will search for N vendor names externally via WebSearch. OK to proceed?"

For each unknown vendor, run the research protocol from matching-rules.md:
1. Extract search terms (sanitize vendor name)
2. WebSearch with 2-attempt limit
3. Cache results in state
4. Classify: confident / partial / no result (promote to Round 3)

Group researched items by suggested account code for batch presentation. Include research evidence per line item:

```
ENTERTAINMENT (8 items, $340.00) -> 420

  1. SQ *MOKOSZ        $45.00   2026-02-10  "Mokosz is a cafe in Elwood, VIC"
  2. MARY'S BAR        $62.00   2026-02-14  "Bar in Fitzroy, VIC"
  ...

Approve all 8? (yes / except N,N / change code / skip group)
```

**After Round 2:** "Round 2 complete. X/Total done (Y%). Round 3: N items I couldn't match."

### Round 3: Truly unknown (low confidence)

**Transition:** "Round 3: N items I couldn't match. Want to tackle them now, or handle them later?"

Frame Round 3 as **optional** to prevent ADHD task avoidance. If user says "later," save state and stop.
Treat Round 3 as a separate "boss battle" mission in summaries so difficult items do not dilute momentum from completed rounds.

Always one-at-a-time regardless of mode, maximum context per item:

```
[276/300] DIRECT DEBIT  -$150.00  2026-02-01

  No history match. No research results.
  No similar amounts found in history.
  Generic payee -- cannot determine vendor.

  Account code? (type code / skip / stop)
```

### Progress Display

After every action:

```
Q1 FY26 -- Round 1 -- Easy matches
[====================............] 147/300 (49%)  ~8 min left
Last: Spotify ($14.99) -> 495 Software/SaaS
Approved (not yet written): 162
Posted (written to Xero): 0
XP: 162 | Streak: 12 | Tax readiness: 54%
```

**Milestone callouts** at: first item, 10%, 25%, 50%, 75%, 90%, 100%. Keep language short and varied:

```
First one done! 299 to go.
30 done -- 10% through. Building momentum.
Quarter done! 75 reconciled, 225 to go.
HALFWAY. 150 down. The hardest part is behind you.
Three quarters! 225 done. The home stretch.
Almost there -- just 30 left!
All 300 reconciled. Done.
```

XP model (lightweight and deterministic):
- `+1` per approved item
- `+5` per completed group
- `+10` per mission complete
- Track and show personal-best pace for this quarter

Tax readiness meter:
- Derived from `(posted + confirmed) / total unreconciled`
- Skipped items are excluded -- they still need attention.
- Show as percent with one line: `Tax readiness: 54%`

### Context Budget

Do not hold full transaction records from completed rounds. After Round 1, only Round 2 and 3 IDs need to be in context. Load transaction details on demand by ID via projection script.

If more than 100 transactions have been processed in this session: save state and suggest "Context is getting long -- progress saved for Q{N} FY{YY}. Run `/xero-explorer reconcile Q{N} FY{YY}` to resume."

Adaptive pause thresholds:
- Rapid-fire: auto-pause suggestion at 80 processed items
- Batch mode: auto-pause suggestion at 120 processed items
- Hard stop at 180 processed items in one session turn: save state and require resume command

Boredom interrupt triggers:
- If skips >= 5 in the last 15 items, suggest mode switch or easier batch
- If pace drops >40% vs session median, suggest 3-minute break + resume command
- If user stalls on one item >90 seconds, offer `skip`, `need info`, or `park for boss battle`

## Phase C: POST Confirmed Items

Goal: post all `confirmed` statement lines as BankTransactions to Xero.

### Transport selection

The `writeStrategy` field in the state file (see `state-schema.md`) controls how
confirmed items are written to Xero:

- **`api-explorer-post`** (default) -- POST via the API Explorer browser automation.
  This is the active path while OAuth PKCE remains blocked (GitHub #10).
- **`manual-export`** -- fall back to exporting confirmed items as a JSON file for
  manual upload. Triggered automatically when POST verification fails (for example,
  repeated 4xx errors or browser session cannot be recovered).

When `writeStrategy` is `manual-export`, skip the POST loop below and jump
directly to the "Manual export fallback" section.

### Pre-POST checks

0. **Safe preview (mandatory):**
Show a write plan before any POST call:

```
About to write to Xero:
  Quarter: Q1 FY26
  Confirmed items: 187
  Estimated batches: 19
  By code:
    495 Software/SaaS: 74 items ($1,902.40)
    420 Entertainment: 18 items ($740.00)
    ...
```

Ask: `Proceed with writes? (yes / review / cancel)`
- `review`: return to Phase B selection flow
- `cancel`: save state and stop without POSTing
- If execution flag is `dry-run`, always stop here with: "Dry-run complete. No writes sent."

Write interlock:
- Require explicit typed confirmation: `WRITE Q{N} FY{YY}`
- Do not begin POST loop on plain `yes`
- If confirmation string doesn't match selected quarter exactly, do not write

Safe preview contract (must be internally consistent before write):

```json
{
  "quarter": "Q1 FY26",
  "confirmedCount": 187,
  "estimatedPostBatches": 19,
  "byCode": [
    { "accountCode": "495", "count": 74, "amountTotal": 1902.40 }
  ]
}
```

Validation rules:
- `sum(byCode[].count) == confirmedCount`
- `estimatedPostBatches == ceil(confirmedCount / 10)`
- Preview quarter matches selected session quarter
- If any validation rule fails, abort write phase and return to review

1. **Ensure browser session is valid:**
```bash
agent-browser --headed get url
```
If not on API Explorer, navigate there and verify login.

2. **Ensure Accounting API is selected** (extract may have left us on Finance API):
```bash
agent-browser --headed snapshot -i | grep "Accounting"
```
If not selected, switch using the "Switching APIs" pattern from api-explorer-nav.md.

3. **Select BankTransactions endpoint and POST operation.**

### POST loop

Process in batches of 10. For each confirmed statement line:

1. Construct POST body using templates from matching-rules.md:
   - `Type`: SPEND (negative amount) or RECEIVE (positive amount)
   - `Contact`: `{ "ContactID": "from lookup", "Name": "payee" }` (omit ContactID if no match)
   - `LineItems`: single item with description, amount, account code, tax type
   - `BankAccount`: `{ "AccountID": "$BANK_ACCOUNT_ID" }` (must match selected tenant)
   - `Date`: postedDate from statement line
   - `CurrencyCode`: "AUD"
   - `IsReconciled`: true

2. State is already `confirmed` (written at approval time -- two-point discipline).

3. POST via API Explorer, wait for response.

4. On success: set status to `posted`, update `postedAt`, write state to disk.

5. Progress: "Batch 3/12: 30 posted | X/Total (Y%)"

### Error handling

- **401/403:** Session expired. Save state, tell user to re-login in browser.
- **400:** Log failed statementLineId + full error response. Set status to `errored` with `errorReason`. Continue with next item.
- **5xx:** Wait 5s and retry once. If still failing, save state and stop.
- **Already reconciled in Xero:** Log statementLineId + "reconciled externally -- verify account code in Xero". Add to CSV export (not silent skip).

### Manual export fallback

If `writeStrategy` is `manual-export` (set when POST verification fails):

```bash
python3 scripts/xero-reconcile-report.py export-confirmed "$STATE_FILE"
```

### Browser self-correction

If agent-browser returns unexpected page state:
1. Snapshot to verify current page
2. Wrong page: navigate back to API Explorer BankTransactions endpoint
3. Modal/dialog blocking: dismiss it, re-snapshot
4. Form fields not populated: re-read DOM, try clicking input first
5. After 3 consecutive failures on same action: save state, report to user

### Selector health checks and retry policy

- Before each critical click sequence, verify selector exists in snapshot
- Retry policy: up to 3 attempts with backoff `0.5s`, `1s`, `2s`
- If selector still missing after retries:
  - capture snapshot excerpt and current URL
  - log a concise selector-failure record in state `errorReason`
  - stop safely with next action: `re-run extract/reconcile after UI check`

## Phase D: Summary and Export

Goal: report results and export remaining items.

```bash
python3 scripts/xero-reconcile-report.py session-summary "$STATE_FILE"
```

### Export skipped and errored items

```bash
python3 scripts/xero-reconcile-report.py export-needs-review "$STATE_FILE"
```

## Success Criteria

- [ ] Statement lines loaded and filtered (isReconciled == false AND bankTransactions empty)
- [ ] Unreconciled items classified into three rounds
- [ ] User confirmed every write before execution
- [ ] State saved after every approval and every POST
- [ ] All POSTs returned 200 OK (or errors logged with reasons)
- [ ] Skipped and errored items exported to CSV
- [ ] Progress displayed after every action
- [ ] Session summary reported
