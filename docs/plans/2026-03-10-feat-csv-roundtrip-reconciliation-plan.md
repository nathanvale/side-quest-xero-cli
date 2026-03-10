---
title: "feat: CSV round-trip reconciliation via Google Sheets"
type: feat
status: active
date: 2026-03-10
origin: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md
builds-on: docs/plans/2026-03-05-feat-finance-api-statement-line-reconciliation-plan.md
---

# CSV Round-Trip Reconciliation via Google Sheets

## Overview

Replace the interactive terminal-based reconciliation review (Phase B of the existing
reconcile workflow) with a CSV round-trip through Google Sheets. The AI classifies all
statement lines, exports a CSV to Google Drive, the user reviews/corrects in Sheets,
and the AI reads the corrected CSV back to POST reconciliations.

This approach eliminates the biggest ADHD friction points: real-time decision pressure,
context window limits, and OAuth dependency during review.

## Problem Statement

The existing interactive reconciliation workflow has three compounding problems:

1. **Activation energy** -- starting a session requires OAuth, browser sessions, and
   uninterrupted focus. If any of those aren't available, you can't start.
2. **Context window pressure** -- processing 287 items interactively risks hitting
   context limits, requiring save-and-resume cycles that break flow.
3. **Real-time decision fatigue** -- approving items one-by-one or in groups requires
   sustained attention. ADHD makes this the hardest possible UX.

Google Sheets as the review surface solves all three: no OAuth needed during review,
no context limits (it's a spreadsheet), and zero time pressure.

## Proposed Solution

### Architecture: Three Clean Phases

```
Phase 1: SEAL (online, once per quarter)
  Extract data + build caches + validate counts + freeze everything locally
  OAuth required: YES
  Duration: ~5 minutes
  Result: data/.quarter-cache-fy25-q4.json (sealed)

Phase 2: CLASSIFY + REVIEW (offline, iterative)
  Generate CSV from sealed cache -> Google Drive -> user reviews in Sheets
  -> read back -> improve proposals -> write CSV v2 -> repeat
  OAuth required: NO
  Duration: days/weeks, user's pace
  Result: reconcile-review-fy25-q4.csv (approved)

Phase 3: POST (online, once per quarter)
  Read final CSV -> validate -> POST to Xero via API Explorer
  OAuth required: YES
  Duration: ~10 minutes for 287 items
  Result: all APPROVED items reconciled in Xero
```

### Key Design Decisions

**Quarter Seal (new concept)**

After extraction + validation, freeze all lookup data into a single cache file:

```json
{
  "sealedAt": "2026-03-10T14:00:00+11:00",
  "quarter": "Q4 FY25",
  "fromDate": "2025-04-01",
  "toDate": "2025-06-30",
  "statementLinesFile": "data/statement-lines-fy25-q4.ndjson",
  "statementLineCount": 287,
  "bankExportCount": 287,
  "countsMatch": true,
  "history": { "...": "bulk CLI history output" },
  "contactLookup": { "...": "normalized payee -> ContactID/Name" },
  "accounts": { "...": "chart of accounts keyed by code" },
  "researchCache": {}
}
```

Once sealed, every subsequent operation (classify, generate CSV, read back, re-classify)
uses this cache. No API calls until POST phase.

Seal is invalidated only if:
- User explicitly requests re-extraction
- A new quarter's reconciliation completes (history has grown)

(see brainstorm: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md --
resumable state, transport-agnostic design)

**CSV is the source of truth during review**

The CSV in Google Drive replaces the JSON state file for the review phase. Benefits:
- Google Drive version history = free backup on every save
- Human-readable, sortable, filterable
- No JSON state corruption risk during review
- Survives days/weeks between sessions

**Explicit APPROVE required (anti-rubber-stamp)**

Status must be explicitly set -- blank rows are not processed. This prevents the
"skim and smash approve" failure mode identified in HITL research (853-like X thread
on rubber-stamping).

**Iterative loop (not one-shot)**

```
I classify -> CSV v1 -> you review (bulk approve easy ones)
  -> hand back -> I see 40 blanks + 5 REVIEWs
  -> I research, improve proposals -> CSV v2
  -> you review remaining -> hand back
  -> ... repeat until ~10 stubborn items remain
  -> optional: switch to interactive rapid-fire for the last few
  -> final CSV with all statuses filled -> POST
```

**Oldest quarters first**

Quarters must be reconciled chronologically because:
- History cache grows as you reconcile -- Q4 FY25's reconciliations improve Q1 FY26's proposals
- Xero's own matching improves with more historical data
- Avoids gaps that confuse BAS reporting

## CSV Column Layout

Status-first layout based on reconciliation UX research. Reviewer's eye lands on
their action column immediately.

| # | Column | Who fills | Editable | Notes |
|---|--------|-----------|----------|-------|
| 1 | Status | User | YES | APPROVE / EDIT / SKIP / REVIEW / (blank) |
| 2 | Date | AI | no | YYYY-MM-DD (ISO 8601) |
| 3 | Payee | AI | no | Raw bank description |
| 4 | Amount | AI | no | Plain decimal, minus for debits |
| 5 | Type | AI | no | SPEND / RECEIVE |
| 6 | AccountCode | AI | YES | Proposed code -- user overrides here |
| 7 | AccountName | AI | no | Human-readable lookup |
| 8 | Contact | AI | YES | Normalized contact -- user overrides here |
| 9 | Confidence | AI | no | high/medium/low (numeric score) |
| 10 | Evidence | AI | no | Why this was proposed |
| 11 | StatementLineID | AI | DO NOT EDIT | UUID for POST, rightmost |

### Status Values

| Status | Meaning | Next iteration behavior |
|--------|---------|------------------------|
| APPROVE | Accept proposal as-is | Locked -- never overwritten |
| EDIT | User changed AccountCode/Contact | Locked -- AI uses user's values |
| SKIP | Don't reconcile | Locked -- excluded from POST |
| REVIEW | "Help me figure this out" | AI researches + updates proposal + evidence |
| (blank) | Haven't looked at it yet | AI may improve proposal with new info |

APPROVE and EDIT are immutable. AI only updates rows that are blank or REVIEW.

### CSV Formatting Rules

- Encoding: UTF-8, no BOM
- Line endings: `\n`
- Delimiter: comma
- All text fields double-quoted (payees contain commas)
- Amounts: plain decimal, 2 places, minus for negative (no $ sign)
- Dates: YYYY-MM-DD (unambiguous across AU/US locales)
- UUIDs: hyphenated (safe from Sheets mangling)
- Sort: confidence descending, then account code, then date

### File Location

```
/Users/nathanvale/Library/CloudStorage/GoogleDrive-hi@nathanvale.com/My Drive/00 Inbox/reconcile-review-fy25-q4.csv
```

Filename encodes quarter so multiple quarters don't collide.

## Technical Approach

### What Exists vs What's New

| Component | Status | Location |
|-----------|--------|----------|
| 128-rule keyword classifier | EXISTS | `scripts/export-reconcile-spreadsheet.py` |
| CSV output with DictWriter | EXISTS | `scripts/export-reconcile-spreadsheet.py` |
| Contact lookup builder | EXISTS | `scripts/xero-contact-lookup.py` |
| NDJSON loader | EXISTS | multiple scripts |
| Payee normalizer | EXISTS | `scripts/export-reconcile-spreadsheet.py` |
| Atomic JSON writer | EXISTS | `scripts/atomic-json-write.py` |
| Quarter gate validation | EXISTS | `scripts/manage-quarters.py gate` |
| CLI history cache | BUILD | `bun run xero-cli history` -> sealed cache |
| Confidence scoring (weighted) | ENHANCE | add history-based scoring to classifier |
| Evidence/reason column | ENHANCE | add to CSV output |
| Quarter seal builder | BUILD | new script or enhance manage-quarters.py |
| CSV read-back + diff | BUILD | new script |
| CSV merge (preserve APPROVE/EDIT, update blanks) | BUILD | new script |
| Google Drive copy | TRIVIAL | `cp` to mounted path |

### Implementation Phases

#### Phase 1: Quarter Seal Script

Enhance `scripts/manage-quarters.py` with a `seal` subcommand:

```bash
python3 scripts/manage-quarters.py seal 4 25
```

This command:
1. Runs quarter gate validation (existing)
2. Checks statement lines file exists and count matches bank export
3. Builds/refreshes history cache: `bun run xero-cli history --since 2024-01-01 --json`
4. Builds contact lookup: `python3 scripts/xero-contact-lookup.py build ...`
5. Loads chart of accounts from `data/accounts.ndjson`
6. Writes `data/.quarter-cache-fy25-q4.json` with all data frozen
7. Sets file permissions to 0o600

If seal already exists and is still valid (counts match, files haven't changed),
skip the API call and report: "Seal intact. Last sealed: [timestamp]."

#### Phase 2: Enhance Classification Script

Enhance `scripts/export-reconcile-spreadsheet.py` to:

1. Accept quarter seal as input (instead of raw NDJSON + accounts separately)
2. Use CLI history as primary account code source (+80 confidence)
3. Use contact lookup for ContactID resolution (+70 confidence)
4. Apply weighted confidence scoring from `references/confidence-weights.json`
5. Generate Evidence column explaining each proposal
6. Add Status column (empty) and Contact column
7. Output new column layout (Status-first)

New invocation:

```bash
python3 scripts/export-reconcile-spreadsheet.py \
  --seal data/.quarter-cache-fy25-q4.json \
  --output "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv"
```

Backward-compatible: old positional args still work for existing usage.

#### Phase 3: CSV Read-Back Script

New script: `scripts/read-reconcile-csv.py`

```bash
python3 scripts/read-reconcile-csv.py \
  read "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --seal data/.quarter-cache-fy25-q4.json
```

This command:
1. Parses CSV with proper csv library (handles quoted commas in payees)
2. Validates StatementLineID format (UUID regex)
3. Validates AccountCode against chart of accounts in seal
4. Validates row count against seal's statement line count
5. Reports summary:
   - N APPROVED, M EDITED, P SKIPPED, Q REVIEW, R blank
   - Diffs: which rows user changed AccountCode or Contact vs original proposals
   - Invalid rows (bad account codes, mangled UUIDs)
6. Outputs structured JSON for downstream consumption

#### Phase 4: CSV Merge Script (for iterations)

New script or subcommand: `scripts/read-reconcile-csv.py merge`

```bash
python3 scripts/read-reconcile-csv.py \
  merge "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --updates data/.csv-updates-fy25-q4.json \
  --output "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv"
```

Merge rules:
- APPROVE rows: never touch (immutable)
- EDIT rows: never touch (immutable)
- SKIP rows: never touch (immutable)
- REVIEW rows: update AccountCode, AccountName, Contact, Confidence, Evidence from new proposals
- Blank rows: update all AI columns if new proposals available
- Preserve row order (user may have sorted manually)

#### Phase 5: Update xero-explorer Skill

Update `.claude/skills/xero-explorer/SKILL.md` intake to add CSV round-trip option:

```
4. **CSV review** -- Generate/read reconciliation CSV for Google Sheets review
```

Update `.claude/skills/xero-explorer/workflows/reconcile.md`:
- Phase B becomes: "Generate CSV, copy to Google Drive, wait for user review"
- Add new "CSV iteration" section for the read-back-and-improve loop
- Interactive mode (batch/rapid-fire) becomes optional fallback for last ~10 items
- Phase C (POST) reads from the final CSV instead of JSON state

Add new workflow: `.claude/skills/xero-explorer/workflows/csv-review.md` with:
- CSV generation from sealed cache
- Google Drive copy instructions
- Read-back and validation
- Iteration loop
- Transition to POST phase

#### Phase 6: POST from CSV

Enhance or create script for POST phase:

```bash
python3 scripts/read-reconcile-csv.py \
  export-post-bodies "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --seal data/.quarter-cache-fy25-q4.json \
  --output data/.post-queue-fy25-q4.json
```

This generates POST bodies for all APPROVED + EDITED rows using:
- AccountCode from CSV (user's override or AI's proposal)
- Contact from CSV (with ContactID from seal's lookup if available)
- TaxType derived from Type (INPUT for SPEND, OUTPUT for RECEIVE)
- BankAccount.AccountID from seal
- All other fields from sealed statement line data

The actual POST execution remains in the existing reconcile workflow (Phase C)
using API Explorer browser automation.

## Acceptance Criteria

### Quarter Seal
- [ ] `manage-quarters.py seal Q FY` builds sealed cache with history, contacts, accounts
- [ ] Seal includes statement line count + bank export count + match validation
- [ ] Seal file has 0o600 permissions
- [ ] Re-seal is a no-op if data hasn't changed (skip API call)
- [ ] Seal is invalidated message when quarter data changes

### CSV Generation
- [ ] Status column is first, StatementLineID is last
- [ ] All 11 columns present per spec
- [ ] Amounts are plain decimal, 2 places, minus for negative
- [ ] Dates are YYYY-MM-DD
- [ ] Evidence column explains each proposal
- [ ] Confidence uses weighted scoring from confidence-weights.json
- [ ] History match = +80, contact lookup = +70 (mutually exclusive)
- [ ] Sorted: confidence desc, then account code, then date
- [ ] File copied to Google Drive inbox path
- [ ] UTF-8, no BOM, \n line endings, comma-delimited, text fields quoted

### CSV Read-Back
- [ ] Validates UUID format for StatementLineID
- [ ] Validates AccountCode against chart of accounts
- [ ] Validates row count against seal
- [ ] Reports summary: counts by status, diffs vs original
- [ ] Rejects rows with invalid data (clear error messages)
- [ ] Handles empty rows gracefully (users add blank rows for grouping)
- [ ] Strips leading apostrophes (Google Sheets text-force artifact)

### Iteration Loop
- [ ] APPROVE/EDIT/SKIP rows are never overwritten
- [ ] REVIEW rows get updated proposals + evidence
- [ ] Blank rows may get improved proposals
- [ ] Row order preserved after merge
- [ ] Google Drive version history provides undo (no manual versioning needed)

### POST Phase
- [ ] Reads final CSV, filters to APPROVE + EDIT status only
- [ ] Generates correct POST bodies per matching-rules.md templates
- [ ] Write interlock: requires `WRITE Q4 FY25` confirmation
- [ ] Safe preview shows count + total amount before writing
- [ ] POST errors logged with StatementLineID + reason

### ADHD UX
- [ ] Zero OAuth required during review phase
- [ ] Can start reviewing immediately after CSV is generated
- [ ] Can come back hours/days later -- CSV in Drive is the resume point
- [ ] Interactive rapid-fire available as fallback for last ~10 stubborn items
- [ ] Quarter seal means no surprise "session expired" blockers

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Google Sheets mangles UUIDs | POST phase fails | Hyphenated UUIDs are safe; validation on read-back catches issues |
| User accidentally edits StatementLineID | Row becomes unprocessable | Validation rejects malformed UUIDs with clear error |
| User sorts CSV differently | Merge overwrites wrong rows | Merge keyed by StatementLineID, not row position |
| OAuth fails during seal phase | Can't build history cache | Fall back to keyword-only classification (lower confidence) |
| History cache is stale | Confidence scores too low | Warn if cache > 7 days old; suggest re-seal |
| Large CSV overwhelms Sheets | Slow performance | 287 rows is trivial for Sheets (handles 10M cells) |
| Google Drive sync lag | CSV not yet synced when read back | Verify file mtime before reading; wait/retry if < 5s old |

## Future Considerations

- **Auto-seal on extract completion** -- run seal automatically after successful extraction
- **Google Sheets API** -- write directly to Sheets (skip CSV, get dropdowns/formatting for free)
- **Learning from corrections** -- diff EDIT rows against proposals to improve keyword rules
- **Multi-quarter batch** -- generate CSVs for all pending quarters at once
- **Direct API mode** -- when OAuth unblocks (GitHub #10), seal + POST become CLI calls

## Sources & References

### Origin

- **Brainstorm:** [docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md](docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md) -- two modes, three rounds, resumable state, ADHD UX, transport-agnostic design
- **Previous plan (builds on):** [docs/plans/2026-03-05-feat-finance-api-statement-line-reconciliation-plan.md](docs/plans/2026-03-05-feat-finance-api-statement-line-reconciliation-plan.md) -- statement-line source, POST templates, matching rules, state schema

### Research (2026-03-10)

- **HITL anti-rubber-stamp:** Require explicit APPROVE, not passive acceptance (X @allgarbled, 853 likes)
- **Confidence-threshold review:** Active learning literature -- model flags low-confidence rows for human focus (IntuitionLabs)
- **"10% Rule":** Statistically sample 10% of AI output for 99% confidence; 5% for low-risk txns (Randstad Finance)
- **Preview-before-scale:** Datablist pattern -- show 10 rows first, proceed on explicit approval
- **Xero JAX:** Xero's own auto-reconciliation (Nov 2025 beta) targets 80%+ automation with human review page -- we're building the same concept via CSV while PKCE is blocked
- **CSV formatting:** UTF-8 no BOM, ISO 8601 dates, plain decimal amounts, hyphenated UUIDs safe from Sheets (multiple sources)

### Internal References

- Existing classifier: `scripts/export-reconcile-spreadsheet.py` (128 keyword rules)
- Contact lookup builder: `scripts/xero-contact-lookup.py`
- Quarter management: `scripts/manage-quarters.py`
- Matching rules: `.claude/skills/xero-explorer/references/matching-rules.md`
- Confidence weights: `.claude/skills/xero-explorer/references/confidence-weights.json`
- State schema: `.claude/skills/xero-explorer/references/state-schema.md`
