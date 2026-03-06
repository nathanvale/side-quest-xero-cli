---
title: "feat: Finance API extraction + statement-line reconciliation"
type: feat
status: completed
date: 2026-03-05
origin: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md
supersedes: docs/plans/2026-03-03-feat-xero-explorer-reconcile-improvement-plan.md
---

# Finance API Extraction + Statement-Line Reconciliation

## Enhancement Summary

This plan merges two workstreams into a single implementation:

1. **Finance API extraction** -- add BankStatementsPlus (Finance API) to the xero-explorer extract workflow, producing `data/statement-lines.ndjson`
2. **Statement-line reconciliation** -- rewrite the reconcile workflow to use statement lines as the source of "what needs reconciling" instead of bank transactions

Both build on the brainstorm's ADHD-friendly design (two modes, three rounds, resumable state, progress visibility) and the previous plan's architecture decisions (per-transaction status map, two-point state writes, SQLite projection, POST templates).

### Key Shift from Previous Plan

The previous plan assumed `bank-transactions.ndjson` (Accounting API) was the reconciliation source. We discovered that the Xero API Explorer has access to the Finance API's BankStatementsPlus endpoint (partner-only scope, unavailable to our PKCE app), which returns **statement lines** -- the actual bank feed items that Xero's UI shows in the "Reconcile" screen.

This changes:
- **Read side:** statement lines are the reconciliation source (unreconciled = `isReconciled == false` AND `bankTransactions` is empty)
- **Write side:** unchanged -- POST BankTransactions to Accounting API, Xero auto-matches to statement lines when amount + date + bank account align
- **Data model:** camelCase statement line fields replace PascalCase Accounting API fields

(see brainstorm: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md)

## Problem Statement

Nathan processes ~300 bank transactions quarterly for BAS. The PKCE app can't access `finance.bankstatementsplus.read` (partner-only scope), but the Xero API Explorer has broader scopes -- we proved this by getting 200 OK with 1046 statement lines for Q2 2025.

The baseline `xero-explorer` skill only supports the Accounting API and has a skeleton reconcile workflow. We need:

1. Finance API extraction capability (API switching, parameter filling)
2. Statement lines as the reconciliation source (more accurate than bank transactions for determining what's unreconciled)
3. The full ADHD-friendly workflow: mode selection, three rounds, vendor research, resumable state, progress visibility

## Proposed Solution

Extend the xero-explorer skill with:

1. **Finance API support in extract** -- API switching pattern, parameter filling, BankStatementsPlus extraction
2. **Statement-line reconciliation** -- filter unreconciled statement lines, match to contacts/accounts, POST BankTransactions
3. **Mode selection** -- batch or rapid-fire, chosen during setup
4. **Three-round processing** -- auto-matched, AI-researched, truly unknown
5. **Vendor research** -- WebSearch/Firecrawl for mystery transactions
6. **Resumable state** -- JSON state file tracks progress across sessions
7. **Progress visibility** -- running counts, ASCII progress bar, milestone callouts

All changes are to skill markdown files only -- no TypeScript code changes.

## Technical Approach

### Architecture

The skill stays as markdown instruction files that guide Claude's behavior.

| File | Change | Lines (est.) |
|------|--------|-------------|
| `.claude/skills/xero-explorer/SKILL.md` | Add statement-lines to data table, update intake routing, mode routing, ADHD UX guidelines, state file reference, direct links to references | ~130 |
| `.claude/skills/xero-explorer/workflows/extract.md` | Add step 4e (BankStatementsPlus via Finance API), update step 1 dataset list | ~220 |
| `.claude/skills/xero-explorer/workflows/reconcile.md` | Full rewrite: statement-line source, mode selection, three rounds, research, state, progress, batch/rapid presentation inline | ~300 |
| `.claude/skills/xero-explorer/references/api-explorer-nav.md` | Add "Switching APIs" section, "Filling Parameters" section, update wait times + ref patterns tables | ~200 |
| `.claude/skills/xero-explorer/references/matching-rules.md` | New: categorization rules from xero-reconcile + vendor research + POST body templates | ~150 |
| `.claude/skills/xero-explorer/references/state-schema.md` | New: state file JSON schema, lifecycle, write discipline, validation | ~120 |

**Frontmatter changes:**

```yaml
allowed-tools: Bash
```

The previous `Bash(agent-browser *)` glob blocks `python3`, `ls`, `for`, and all other non-agent-browser commands. The skill needs unrestricted Bash for Python data processing, file checks, and state management.

### File Structure (8 files total)

```
SKILL.md                           (entry point, intake, principles, ~130 lines)
workflows/extract.md               (rewrite: add Finance API step, ~220 lines)
workflows/reconcile.md             (rewrite: statement-line source, ~300 lines)
references/api-explorer-nav.md     (extend: API switching + parameters, ~200 lines)
references/matching-rules.md       (NEW: matching + vendor research + POST templates)
references/state-schema.md         (NEW: state lifecycle + validation)
```

**Skill-authoring guidance:** Keep SKILL.md under 500 lines, references one level deep, avoid splitting small presentation differences into separate files. Mode-specific workflows (batch vs rapid) are 20-30 lines of difference -- sections within `reconcile.md`, not separate files.

**Reference linking:** Reference files must be linked directly from SKILL.md, not only from within `reconcile.md`. The reconcile workflow can assume references are already loaded.

### Key Design Decisions

**Statement lines as reconciliation source (NEW)**

Statement lines from BankStatementsPlus represent the actual bank feed items. Field mapping from previous bank-transaction model:

| Statement Line Field | Was (BankTransaction) | Notes |
|---------------------|----------------------|-------|
| `statementLineId` | `BankTransactionID` | Unique identifier |
| `payee` | `Contact.Name` | Vendor/payee name |
| `amount` | `Total` | Signed -- negative = SPEND, positive = RECEIVE |
| `postedDate` | `Date` | Transaction date |
| `isReconciled` | `IsReconciled` | Boolean |
| `bankTransactions` | n/a | Array of matched BankTransactions (empty = unreconciled) |

**Filtering logic:** unreconciled = `isReconciled == false` AND `bankTransactions` is empty (or missing).

**Bank transactions become optional** -- `bank-transactions.ndjson` is still useful for contact history lookup (normalized payee -> ContactID/ContactName mapping) but is no longer required for reconciliation.

**BankStatementsPlus response envelope is uncertain (RISK)**

The envelope structure could be `statements[].lines[]`, `statementLines` flat array, or another shape. The extract step defensively inspects the raw JSON before converting, with three fallback paths. First run needs manual verification of `/tmp/xero-bankstatementsplus-raw.json`.

**Mode selection inside reconcile workflow, not at SKILL.md intake**

SKILL.md keeps 3 intake options (extract / reconcile / status), not 4. Batch vs rapid-fire is a presentation mode within reconcile, not a top-level workflow.

**Three rounds, confidence descending (from brainstorm)**

Round 1 (auto-matched) clears the obvious bulk. Round 2 (AI-researched) handles mysteries with evidence. Round 3 (truly unknown) gets Nathan's brain.

**Per-transaction status map**

Single status map keyed by `statementLineId` (was `BankTransactionID`):

```json
"transactions": {
  "<statementLineId>": {
    "status": "classified|confirmed|posted|skipped|errored",
    "round": 1,
    "accountCode": "6310",
    "contactId": "uuid or null",
    "contactName": "payee from statement line",
    "confirmedAt": "2026-03-05T10:30:00",
    "postedAt": null,
    "errorReason": null
  }
}
```

Resume = filter by status. Remaining work in round N = `transactions where round == N AND status == 'classified'`.

**POST target is still Accounting API /BankTransactions**

The write side stays on Accounting API. We POST new BankTransactions that Xero auto-matches to statement lines when amount + date + bank account align. The POST body construction changes to derive from statement line fields.

**No transport-agnostic abstraction**

One transport: `agent-browser`. A comment marks the swap point for when OAuth unblocks.

### Implementation Phases

#### Phase 1: Extend api-explorer-nav.md (API switching + parameters)

Two new sections:

**"Switching APIs"** -- pattern for changing from Accounting to Finance API:

```bash
# 1. Snapshot to get current API dropdown ref
agent-browser --headed snapshot -i | grep "API"

# 2. Click API dropdown
agent-browser --headed click @API_REF
agent-browser --headed wait 500

# 3. Select Finance API
agent-browser --headed find role button click --name "Select API Xero Finance API"
agent-browser --headed wait 1000

# 4. Re-snapshot -- endpoint/operation dropdowns RESET after API switch
agent-browser --headed snapshot -i
```

**"Filling Parameters"** -- pattern for input fields that appear after selecting an operation:

```bash
# BankStatementsPlus requires: BankAccountID, FromDate, ToDate
# 1. Snapshot to find parameter input field refs
agent-browser --headed snapshot -i

# 2. Click field, wait for focus, type value
agent-browser --headed click @FIELD_REF
agent-browser --headed wait 300
agent-browser --headed type "value"

# Note: Clear existing values first if field is pre-populated
# agent-browser --headed click @FIELD_REF
# agent-browser --headed press "ctrl+a"
# agent-browser --headed type "new value"
```

**Update wait times table:**

| Endpoint | Wait (ms) |
|----------|-----------|
| Accounts | 5000 |
| BankTransactions | 10000 |
| Invoices | 5000 |
| Contacts | 8000 |
| **BankStatementsPlus** | **15000** |

**Update common ref patterns table** to include Finance API refs:

| Element | Typical ref name pattern |
|---------|------------------------|
| API dropdown (Finance) | `API Xero Finance API-button` |
| BankStatementsPlus endpoint | `Endpoint BankStatementsPlus-button` |
| Parameter fields | `BankAccountID`, `FromDate`, `ToDate` |

#### Phase 2: Extend extract.md (add step 4e)

**Update Step 1** (check existing data) to include `statement-lines.ndjson` in the dataset list:

```bash
for f in data/accounts.ndjson data/bank-transactions.ndjson data/invoices.ndjson data/contacts.ndjson data/statement-lines.ndjson; do
  if [ -f "$f" ]; then
    echo "$(basename $f): $(wc -l < $f) records, modified $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' $f)"
  else
    echo "MISSING: $f"
  fi
done
```

Update dataset count references from "4 datasets" to "5 datasets."

**Add note to Step 3** that step 4e handles its own API selection (Finance API), all other steps use Accounting API.

**Add step 4e: BankStatementsPlus via Finance API**

After step 4d (Contacts):

1. **Switch to Finance API** using the "Switching APIs" pattern from api-explorer-nav.md
2. **Select endpoint:** BankStatementsPlus
3. **Select operation:** Get Bank Statements Plus
4. **Fill parameters:**
   - BankAccountID: `601e62a1-d42b-42da-a9fe-2a0a9e703a3b`
   - FromDate: `2025-04-01`
   - ToDate: `2025-06-30`
5. **Make request**, wait 15s, copy response
6. **Inspect response structure first** -- the envelope is uncertain:

```python
python3 << 'PYEOF'
import json
data = json.load(open('/tmp/xero-bankstatementsplus-raw.json'))
print("Top-level keys:", list(data.keys()))
print("Top-level types:", {k: type(v).__name__ for k, v in data.items()})

# Try known envelope patterns
if 'statements' in data:
    stmts = data['statements']
    print(f"statements: {len(stmts)} entries")
    if stmts and 'lines' in stmts[0]:
        lines = [l for s in stmts for l in s.get('lines', [])]
        print(f"statements[].lines[]: {len(lines)} total lines")
        print("First line keys:", list(lines[0].keys()) if lines else "empty")
elif 'statementLines' in data:
    lines = data['statementLines']
    print(f"statementLines: {len(lines)} entries")
    print("First line keys:", list(lines[0].keys()) if lines else "empty")
else:
    # Fallback: find any array with statementLineId fields
    for k, v in data.items():
        if isinstance(v, list) and v and isinstance(v[0], dict) and 'statementLineId' in v[0]:
            print(f"Found lines in '{k}': {len(v)} entries")
            print("First line keys:", list(v[0].keys()))
            break
    else:
        print("WARNING: Could not find statement lines in response!")
        print("Manual inspection needed: /tmp/xero-bankstatementsplus-raw.json")
PYEOF
```

7. **Convert to NDJSON** once envelope is confirmed:

```python
python3 << 'PYEOF'
import json, os

data = json.load(open('/tmp/xero-bankstatementsplus-raw.json'))

# Adjust extraction path based on inspection results above
# Example for statements[].lines[]:
lines = [l for s in data.get('statements', []) for l in s.get('lines', [])]
# OR for flat statementLines:
# lines = data.get('statementLines', [])

path = 'data/statement-lines.ndjson'
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    for line in lines:
        f.write(json.dumps(line) + '\n')
os.rename(tmp, path)
print(f'statement-lines.ndjson: {len(lines)} records')
PYEOF
```

8. **Verify count:** `wc -l data/statement-lines.ndjson` -- expect ~1046 for Q2 2025
9. **Switch back to Accounting API** (clean session state for subsequent operations)

#### Phase 3: Create reference files (state-schema.md + matching-rules.md)

**`references/state-schema.md`**

State file at `data/.xero-reconcile-state.json`:

```json
{
  "extractedAt": "2026-03-05T09:00:00",
  "startedAt": "2026-03-05T10:30:00",
  "mode": "batch",
  "activeRound": 2,
  "totalAtStart": 300,
  "dataSource": "statement-lines",
  "writeStrategy": "api-explorer-post",
  "bankAccountId": "601e62a1-d42b-42da-a9fe-2a0a9e703a3b",
  "transactions": {
    "<statementLineId>": {
      "status": "posted",
      "round": 1,
      "accountCode": "6310",
      "contactId": "uuid-from-lookup",
      "contactName": "GITHUB",
      "confirmedAt": "...",
      "postedAt": "...",
      "errorReason": null
    }
  },
  "researchCache": {
    "mokosz elwood": {
      "query": "Mokosz Elwood business Australia",
      "result": "Cafe/restaurant in Elwood, VIC",
      "suggestedCode": "6420",
      "confidence": "medium",
      "searchedAt": "2026-03-05T10:35:00"
    }
  },
  "savedAt": "2026-03-05T11:15:00"
}
```

**Naming conventions:** All timestamp fields use `{verb}At` pattern. `activeRound` distinguishes the session's processing cursor from per-transaction `round` classification.

**Write discipline (critical):**

State must be written at two explicit moments:
1. **IMMEDIATELY after user approval** (before any POST attempt) -- set status to `confirmed`, write to disk
2. **AFTER each successful POST response** -- set status to `posted`, update `postedAt`, write to disk

Use atomic write via stdin/heredoc (never interpolate user data into Python `-c` strings):

```bash
python3 << 'PYEOF'
import json, os
state = json.loads("""STATE_JSON_HERE""")
path = 'data/.xero-reconcile-state.json'
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(state, f, indent=2)
os.rename(tmp, path)
PYEOF
```

**State validation on load:**
1. JSON parses without error
2. All transaction IDs in `transactions` map exist in `data/statement-lines.ndjson`
3. No transaction has both `confirmedAt` set and `status: classified` (invalid lifecycle)
4. All `status` values are one of: `classified`, `confirmed`, `posted`, `skipped`, `errored`

If validation fails, halt. Keep corrupt file as `.xero-reconcile-state.json.corrupt-TIMESTAMP`.

**Resume semantics:**
- Load state, POST any `confirmed` items first (recovering from interruption), then continue with remaining `classified` items in `activeRound`
- Inject context: "Resuming from [date]. Mode: batch. R1: 180 done. R2: 12/45 done. 33 remaining."
- Load ONLY remaining `classified` items for active round (via projection script)

**`references/matching-rules.md`**

Consolidate from `/xero-reconcile` skill:
- Contact name normalization algorithm (strip PTY LTD, INC, etc., normalize whitespace, case-insensitive)
- Invoice matching rules (Amount from BankTransaction, currency match check)
- Confidence classification decision tree
- Historical pattern matching (contact + amount range -> account code)
- Amount range matching: outside historical range reduces confidence

**Contact lookup from bank-transactions.ndjson (optional enrichment):**

Since statement lines only have `payee` (plain text), we build a contact lookup from historical bank transactions:

```python
# Build: normalized_payee -> { ContactID, ContactName }
# from bank-transactions.ndjson where IsReconciled == true
contact_lookup = {}
for txn in reconciled_bank_transactions:
    name = txn['Contact']['Name']
    normalized = normalize(name)  # strip PTY LTD, lowercase, collapse whitespace
    contact_lookup[normalized] = {
        'ContactID': txn['Contact']['ContactID'],
        'ContactName': name
    }
```

Match found = reuse ContactID (Xero links to existing contact). No match = use `payee` as `Contact.Name` (Xero auto-creates contact).

**Unknown vendor research protocol:**
1. Extract search terms: strip Square prefix "SQ *", card suffixes, special characters, control characters. Truncate to 80 chars.
2. First search: `"{vendor name} {location if present} business Australia"`
3. If inconclusive, second search: `"{vendor name} what is"`
4. Max 2 searches per vendor, max 30 per session
5. Cache by normalized vendor name
6. Consent prompt at Round 2 start

**POST body templates (critical -- prevents agent hallucination):**

For each approved statement line, POST to Accounting API `/BankTransactions`:

```json
{
  "Type": "SPEND or RECEIVE (negative amount = SPEND, positive = RECEIVE)",
  "Contact": {
    "ContactID": "from lookup (if found)",
    "Name": "payee from statement line"
  },
  "LineItems": [{
    "Description": "payee from statement line",
    "Quantity": 1,
    "UnitAmount": "abs(amount)",
    "AccountCode": "approved code",
    "TaxType": "INPUT for SPEND, OUTPUT for RECEIVE"
  }],
  "BankAccount": { "AccountID": "601e62a1-d42b-42da-a9fe-2a0a9e703a3b" },
  "Date": "postedDate from statement line",
  "CurrencyCode": "AUD",
  "IsReconciled": true
}
```

**Xero auto-matching caveat:** When a BankTransaction is POSTed with matching amount + date + bank account, Xero auto-matches it to the corresponding statement line. This is the mechanism that "reconciles" -- the statement line's `bankTransactions` array gains an entry, and `isReconciled` flips to `true`. Document this in reconcile.md so the agent understands WHY the POST works even though we're not directly updating statement lines.

**TaxType note:** `INPUT` for SPEND (purchases), `OUTPUT` for RECEIVE (income). Wrong type returns "The TaxType code cannot be used with account code."

#### Phase 4: Rewrite reconcile.md (statement-line source)

**Phase A: Setup**

Goal: confirm valid data and mode selection.

- Step 1: Check for state file. If found, show summary, ask resume or fresh.
- Step 2: Check data files:
  - **Critical:** `data/statement-lines.ndjson` (required -- this is what we reconcile)
  - **Critical:** `data/accounts.ndjson` (required -- chart of accounts)
  - **Optional:** `data/bank-transactions.ndjson` (enrichment -- contact history lookup)
  - **Optional:** `data/invoices.ndjson` (enrichment -- invoice matching)
  - Staleness: warn if `extractedAt` older than 48h, warn (not block) if older than 7 days.
- Step 3: Mode selection -- batch (1) or rapid-fire (2). Record in state.
- Step 4: Load and classify statement lines using SQLite projection:

```python
python3 << 'PYEOF'
import json, sqlite3

db = sqlite3.connect(':memory:')
db.execute('''CREATE TABLE stmt (
    id TEXT PRIMARY KEY, payee TEXT, amount REAL,
    posted_date TEXT, is_reconciled INT, has_match INT
)''')

with open('data/statement-lines.ndjson') as f:
    for line in f:
        s = json.loads(line)
        db.execute('INSERT OR IGNORE INTO stmt VALUES (?,?,?,?,?,?)', (
            s['statementLineId'],
            s.get('payee', ''),
            s.get('amount', 0),
            s.get('postedDate', '')[:10],
            1 if s.get('isReconciled') else 0,
            1 if s.get('bankTransactions') else 0
        ))
db.commit()

# Unreconciled = not reconciled AND no matched bank transactions
unreconciled = db.execute(
    'SELECT COUNT(*), ROUND(SUM(ABS(amount)),2) FROM stmt WHERE is_reconciled=0 AND has_match=0'
).fetchone()
print(f'Unreconciled: {unreconciled[0]} statement lines (${unreconciled[1]:,.2f})')

# Break down by DEBIT/CREDIT
for r in db.execute('''
    SELECT
        CASE WHEN amount < 0 THEN 'SPEND' ELSE 'RECEIVE' END as type,
        COUNT(*), ROUND(SUM(ABS(amount)),2)
    FROM stmt WHERE is_reconciled=0 AND has_match=0
    GROUP BY type
'''):
    print(f'  {r[0]}: {r[1]} items (${r[2]:,.2f})')

# Top payees
print('\nTop unreconciled payees:')
for r in db.execute('''
    SELECT payee, COUNT(*) cnt, ROUND(SUM(ABS(amount)),2) total
    FROM stmt WHERE is_reconciled=0 AND has_match=0
    GROUP BY payee ORDER BY total DESC LIMIT 15
'''):
    print(f"  {r[1]:>4}  ${r[2]:>10,.2f}  {r[0]}")
PYEOF
```

Verification: round 1 + round 2 + round 3 = total unreconciled.

**Phase B: Rounds 1-3 (presentation and confirmation)**

Goal: get user approval for all categorizable statement lines.

- Round 1 (auto-matched): present via selected mode, save state after each confirmation
  - Warm-up framing: "Starting with the easy ones to build momentum."
  - Show confidence reason per item: "(matched 11 previous months)"
  - Larger review groups (up to 25 items) since cognitive load is low
- Round 2 (AI-researched): run vendor research, cache results, present via selected mode
  - Transition: "Round 1 complete: N easy matches done! Round 2: M items need a closer look."
  - Consent prompt before external searches
- Round 3 (truly unknown): always one-at-a-time, maximum context
  - Transition: "Round 3: N items I couldn't match. Want to tackle them now, or handle them later?"
  - Frame as optional to prevent ADHD task avoidance

**Batch mode:**
- Group by suggested account code, all line items numbered
- Max 15 items per review group (25 for Round 1)
- "Approve all N? (yes / except N,N / change code / skip group)"
- "except N,N" pulls items into Round 3

**Rapid-fire mode:**
- One at a time, suggested code pre-filled
- `[147/300] GITHUB ($9.00, 2026-02-01, SPEND) -> 6310 Software/SaaS (12 prior matches)`
- Enter = approve, type code = override, "skip" = skip
- Streak counter, pace indicator

**Progress display:**

```
Round 1 -- Easy matches
[====================............] 147/300 (49%)  ~8 min left
Last: Spotify ($14.99) -> 6310 Software/SaaS
```

Milestones at: first item, 10%, 25%, 50%, 75%, 90%, 100%.

**Context budget:** Do not hold full records from completed rounds. After 100+ items processed, suggest save-and-resume.

**Phase C: POST confirmed items**

Goal: post all `confirmed` statement lines as BankTransactions to Xero.

- Check browser session validity before each batch
- **Ensure Accounting API is selected** (extract may have left us on Finance API)
- POST in batches of 10
- Two-point state writes per item
- Use POST body templates from matching-rules.md
- Handle errors:
  - 401/403: session expired, save state, tell user to re-login
  - 400: log error, set `errored` with `errorReason`, continue
  - 5xx: retry once after 5s, then stop and save state
- Progress: "Batch 3/12: 30 posted | X/Total (Y%)"
- If `writeStrategy` is `manual-export`: export to `data/pending-reconciliation.json`

```
# Transport: API Explorer browser
# Swap to direct API when OAuth unblocks -- GitHub #10
```

**Browser self-correction:**
1. Snapshot to verify current page
2. Wrong page: navigate back to API Explorer BankTransactions endpoint
3. Modal blocking: dismiss, re-snapshot
4. Fields not populated: re-read DOM, click input first
5. After 3 consecutive failures: save state, report to user

**Phase D: Summary and export**

```
SESSION COMPLETE

  Reconciled:  287 statement lines
  Skipped:       8 (exported to data/needs-review.csv)
  Errors:        5 (exported to data/needs-review.csv with error reasons)
  Total value:  $34,521.80 across 42 contacts

  By round:
    Auto-matched (R1):   247 posted
    AI-researched (R2):   38 posted
    Unknown (R3):          2 posted

  Top categories:
    6310 Software/SaaS      42 items   $2,340.50
    6420 Entertainment       89 items   $1,230.80
    6440 Motor Vehicle       67 items   $4,560.00

  Session stats:
    Duration:    12 min
    Avg pace:    24 items/min
    Best streak: 31 in a row

  Your Feb 2026 books are 96% reconciled.
  13 items in data/needs-review.csv whenever you're ready.
```

#### Phase 5: Update SKILL.md

**Data Directory table:**

| File | Source | Key / Filter |
|------|--------|-------------|
| `data/accounts.ndjson` | GET Accounting API /Accounts | `Accounts` |
| `data/bank-transactions.ndjson` | GET Accounting API /BankTransactions | `BankTransactions` |
| `data/invoices.ndjson` | GET Accounting API /Invoices | `Invoices` |
| `data/contacts.ndjson` | GET Accounting API /Contacts | `Contacts` |
| `data/statement-lines.ndjson` | GET Finance API /BankStatementsPlus | `statements[].statementLines[]` (inspect first run) |
| `data/.xero-reconcile-state.json` | Generated by reconcile workflow | Resumable state |
| `data/needs-review.csv` | Generated by reconcile workflow | Skipped + errored items |

**Intake routing:**

1. **Extract data** -- pull from Xero API Explorer
2. **Reconcile** -- match unreconciled statement lines to accounts and POST
3. **Status** -- check reconciliation progress

Routing logic:
- Check for `statement-lines.ndjson` (required for reconciliation)
- `bank-transactions.ndjson` is optional (contact history enrichment)
- If `statement-lines.ndjson` missing: suggest extract first
- If present: ask which workflow

**Updated frontmatter:**

```yaml
description: >
  Reconcile Xero statement lines and extract accounting data via the
  Xero API Explorer browser when OAuth is blocked. Use when the user asks
  to pull Xero data, extract ledgers, reconcile transactions, check
  reconciliation progress, or work around the OAuth 403 block.
argument-hint: "{extract|reconcile|status}"
allowed-tools: Bash
```

**ADHD UX guidelines section:**
- Batch approval, not one-by-one
- Progress is dopamine -- ASCII bar + percentage + time estimate + milestones
- Research mysteries proactively
- Let me stop anytime -- state saves after every confirmation
- Keep it visual -- tables over paragraphs
- Warm up first -- easy matches build momentum
- Celebrate completion -- session summary with stats

**Direct reference links** from SKILL.md reconcile intake: "Before starting reconciliation, read references/matching-rules.md and references/state-schema.md."

#### Phase 6: Security fixes to extract.md (prerequisite)

- NDJSON files written with `os.open()` + 0o600 (not default umask)
- `data/` directory set to 0700
- `/tmp/xero-*` paths use `mktemp -d` private directory
- Clipboard cleared after each `pbpaste` save: `echo -n "" | pbcopy`

## System-Wide Impact

### Interaction Graph

1. Extract workflow calls Finance API (new) + Accounting API (existing) via agent-browser
2. Finance API returns statement lines -> stored as NDJSON
3. Reconcile workflow reads statement-lines.ndjson + optionally bank-transactions.ndjson
4. Classification assigns rounds + suggested account codes -> state file
5. User approval -> state file update -> POST BankTransactions via Accounting API
6. Xero auto-matches POSTed BankTransaction to corresponding statement line
7. Statement line's `isReconciled` flips to true in Xero (not in our local data)

### Error Propagation

- Finance API 401/403: extract stops, user re-authenticates
- Malformed BankStatementsPlus response: extract halts at inspection step, raw JSON preserved
- Statement line POST 400: `errored` status with reason, exported to CSV, retryable
- Browser session timeout: state saved, user re-authenticates, resume picks up `confirmed` items
- State file corruption: validation fails, corrupt file preserved, halt with message

### State Lifecycle Risks

- Partial POST failure: two-point writes ensure `confirmed` vs `posted` distinction -- resume POSTs `confirmed` items first
- Re-extraction between sessions: statement line IDs may change if Xero updates data. State validation checks IDs exist in current NDJSON.
- Mode switch mid-session: prohibited -- save state, restart with new mode

### API Surface Parity

The `/xero-reconcile` CLI skill uses the same matching rules. Changes should be applied to both. `matching-rules.md` carries a copy-date note.

## Acceptance Criteria

### Functional -- Extract

- [x] API switching pattern documented in api-explorer-nav.md
- [x] Parameter filling pattern documented in api-explorer-nav.md
- [x] Step 4e extracts BankStatementsPlus from Finance API
- [x] Response envelope inspected defensively before NDJSON conversion
- [x] `data/statement-lines.ndjson` created with ~1046 records (Q2 2025)
- [x] Session returns to Accounting API after Finance API extraction
- [x] Step 1 dataset list includes statement-lines.ndjson

### Functional -- Reconcile

- [x] Statement lines are the reconciliation source (not bank transactions)
- [x] `statement-lines.ndjson` is required, `bank-transactions.ndjson` is optional
- [x] Unreconciled filter: `isReconciled == false` AND `bankTransactions` empty
- [x] Report by SPEND/RECEIVE (based on sign of `amount`)
- [x] Contact lookup built from bank-transactions.ndjson (if present)
- [x] Match found = reuse ContactID; no match = Xero auto-creates from payee name
- [x] Mode selection works at Phase A Step 3 (batch vs rapid-fire)
- [x] Three rounds process in confidence-descending order
- [x] All items numbered in batch mode, max 15 per group (25 for Round 1)
- [x] Batch mode supports "approve all except N,N" syntax
- [x] Round 2 runs WebSearch with consent prompt (max 2 per vendor, 30 per session)
- [x] Research results cached by normalized vendor name
- [x] State file saves at two points: after approval AND after POST
- [x] Resume POSTs `confirmed` items first, then continues `classified`
- [x] `errored` items exported to CSV with reasons, retryable on resume
- [x] POST body uses correct TaxType per direction (INPUT/SPEND, OUTPUT/RECEIVE)
- [x] Progress bar + percentage + time estimate after every action
- [x] Milestone callouts at first-item, 10%, 25%, 50%, 75%, 90%
- [x] `writeStrategy` supports `api-explorer-post` and `manual-export`
- [x] Round 3 framed as optional

### Security

- [x] State file: atomic write, 0o600, stdin/heredoc pattern
- [x] CSV export: atomic write, 0o600
- [x] Vendor names sanitized before external search (strip special chars, cap 80 chars)
- [x] NDJSON files written with 0o600
- [x] `data/` directory set to 0700
- [x] Raw responses in `mktemp -d`, cleaned after conversion
- [x] Clipboard cleared after each pbpaste save

## Critical Prerequisite: POST via API Explorer

Before implementing Phase C, manually verify that the Xero API Explorer supports POST operations with a JSON body via `agent-browser`.

If POST fails, set `writeStrategy: "manual-export"`. Phase C exports to JSON for manual upload. All other phases work regardless.

**Xero reconciliation caveat:** POSTing `IsReconciled: true` via API is the conversion/migration pattern. For bank-feed accounts, Xero auto-matches the BankTransaction to the statement line based on amount + date + bank account. This is the mechanism that makes the statement line show as reconciled in the Xero UI.

## Biggest Risk

The BankStatementsPlus response envelope structure is uncertain. Step 4e in extract.md defensively inspects the raw JSON before converting to NDJSON, with three fallback paths (`statements[].lines[]`, `statementLines`, or any array with `statementLineId` fields). First run needs manual verification of `/tmp/xero-bankstatementsplus-raw.json`.

## Verification

1. After extract 4e: `wc -l data/statement-lines.ndjson` should show ~1046 records
2. After classification: round 1 + round 2 + round 3 = total unreconciled
3. After posting a test batch of 5: check Xero UI reconciliation count decreased
4. After full reconciliation: "Reconcile 0 items" on Xero homepage

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| BankStatementsPlus envelope unknown | Extract step may fail | Defensive inspection with 3 fallback paths; raw JSON preserved |
| API Explorer doesn't support POST | Blocks write path | `writeStrategy: "manual-export"` fallback |
| Statement line IDs change on re-extract | State file references stale IDs | Validation on load checks IDs exist in current NDJSON |
| Browser session expires mid-reconcile | Lost POST progress | GET probe before batch; two-point state writes |
| Data staleness | Reconcile conflicts | Staleness warning using `extractedAt` |
| WebSearch returns garbage | Round 2 inflates to Round 3 | Max 2 searches, 30 cap; partial results shown |
| Context window exhaustion | Agent stops mid-round | Projection scripts; 100-item checkpoint rule |
| State file corruption | Re-present confirmed items | Validation; corrupt file preserved |
| TaxType mismatch on RECEIVE | 400 from Xero | POST template specifies correct mapping |
| Matching rules drift from xero-reconcile | Inconsistent categorization | Copy-date note in matching-rules.md |
| Python injection via vendor names | Code execution | Stdin/heredoc pattern; never interpolate into `-c` |

## Future Roadmap (not now, from brainstorm)

- **Audit mode:** review past categorizations for consistency
- **Incremental stop-hook mode:** surface one unreconciled transaction between tasks
- **Direct API mode:** when OAuth unblocks, skip browser automation
- **Date range parameterization:** currently hardcoded Q2 2025 dates for BankStatementsPlus

## Open Questions

1. **Rapid-fire defaults:** pre-fill and require enter (safer) vs auto-approve with undo (faster)? Recommendation: require enter.

2. **BankStatementsPlus date range:** Currently hardcoded to Q2 2025. Should we parameterize in the skill instructions, or always prompt the user?

3. **Statement line field names:** We assume `statementLineId`, `payee`, `amount`, `postedDate`, `isReconciled`, `bankTransactions` based on Xero Finance API docs. First extraction will confirm.

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md](docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md) -- two modes, three rounds, resumable state, ADHD UX
- **Previous plan (superseded):** [docs/plans/2026-03-03-feat-xero-explorer-reconcile-improvement-plan.md](docs/plans/2026-03-03-feat-xero-explorer-reconcile-improvement-plan.md) -- architecture decisions, security hardening, deepening rounds 1-2

### Internal References

- Existing reconcile skill: `.claude/skills/xero-reconcile/SKILL.md`
- Current xero-explorer skill: `.claude/skills/xero-explorer/SKILL.md`
- API Explorer navigation: `.claude/skills/xero-explorer/references/api-explorer-nav.md`
- State management pattern: `src/state/state.ts`
- Xero API types: `src/xero/types.ts`
- CLI reconcile TaxType bug: `src/cli/commands/reconcile.ts:948`
- OAuth block: GitHub issue #10

### External Research (from previous plan)

- [Xero BankTransactions API](https://developer.xero.com/documentation/api/accounting/banktransactions) -- POST endpoint, IsReconciled semantics
- [Xero Rate Limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits) -- 60/min per tenant
- [Xero Tax Guide](https://developer.xero.com/documentation/guides/how-to-guides/tax-in-xero) -- TaxType must match direction
- [Xero UserVoice: Reconcile via API (Declined)](https://xero.uservoice.com/forums/5528-xero-api/suggestions/2884040-reconcile-via-the-api)
- [QuickBooks Rel-Cat Paper (2025)](https://arxiv.org/html/2506.09234v1) -- three-tier categorization
