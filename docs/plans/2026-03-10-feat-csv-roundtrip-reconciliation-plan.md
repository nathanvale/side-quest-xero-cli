---
title: "feat: CSV round-trip reconciliation via Google Sheets"
type: feat
status: active
date: 2026-03-10
origin: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md
builds-on: docs/plans/2026-03-05-feat-finance-api-statement-line-reconciliation-plan.md
---

# CSV Round-Trip Reconciliation via Google Sheets

## Enhancement Summary

**Deepened on:** 2026-03-10
**Sections enhanced:** 8
**Research lenses used:** `best-practices-researcher`, `framework-docs-researcher`, `repo-research-analyst`, `architecture-strategist`, `security-sentinel`, `performance-oracle`, `pattern-recognition-specialist`, `kieran-python-reviewer`, `spec-flow-analyzer`, `learnings-researcher`, `cli-agent-reliability-auditor`, `code-simplicity-reviewer`, `document-review`

### Key Improvements

1. Tightened the **quarter seal** into a versioned artifact with explicit source fingerprints, invalidation reasons, and degraded-mode handling when history refresh is unavailable.
2. Grounded the **CSV contract** in Python's `csv` module behavior: `newline=''`, UTF-8, `DictReader`/`DictWriter`, `QUOTE_ALL`, strict header validation, and duplicate-ID detection.
3. Clarified **Google Sheets backup assumptions**: rely on Sheets UI version history for human rollback, because the Drive revisions API can return incomplete revision lists for heavily edited Sheets files.
4. Added missing **edge-case handling** for blank grouping rows, apostrophe-prefixed IDs, duplicate `StatementLineID` values, stable merge ordering, sync lag, and repeat-safe POST preparation.

### New Considerations Discovered

- Xero's Finance API `BankStatementsPlus` request window is capped at 12 months and rejects future `ToDate` values, so quarter-scoped sealing is a naturally safe boundary.
- Xero's OAuth scope model changed on **March 2, 2026** for newly created apps, but `finance.bankstatementsplus.read` still sits in the extra-certification Finance API bucket.
- The local integration learning from **2026-03-05** remains critical: bank statement lines and `BankTransactions` are different data models, so `statementLineId` must stay the immutable join key through every phase.

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

### Research Insights

**Best Practices:**
- Keep the review artifact human-first and offline-friendly, but keep the machine contract anchored on immutable `statementLineId` values from statement lines rather than any derived bank-transaction view.
- Treat the review CSV as the human source of truth for approvals, while the quarter seal remains the machine source of truth for original statement-line facts and lookup data.

**Implementation Details:**
```json
{
  "schemaVersion": 1,
  "quarter": "Q4 FY25",
  "statementLineKey": "statementLineId",
  "reviewArtifact": "reconcile-review-fy25-q4.csv",
  "authoritativeFacts": "data/.quarter-cache-fy25-q4.json"
}
```

**Edge Cases:**
- If a late extraction changes the statement-line set after a review CSV already exists, the seal must invalidate the CSV and force regeneration rather than attempting a partial merge.
- If multiple bank accounts share similar payees, the seal must carry the bank account identity so the POST phase cannot drift across accounts.

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

### Research Insights

**Best Practices:**
- Add `schemaVersion`, `createdBy`, and a `sourceManifest` to the seal so "is this still valid?" is based on file fingerprints and input metadata, not just counts.
- Record explicit seal degradation state when the Accounting API history refresh fails, so later phases can distinguish "no history exists" from "history was unavailable".
- Make `SummaryOnly=true` explicit in BankStatementsPlus extraction unless a later phase proves it needs the heavier nested line-item payload.

**Performance Considerations:**
- Quarter-scoped extraction stays comfortably inside Xero's 12-month Finance API limit and avoids accidental wide queries.
- Refresh the expensive history cache only when the existing cache is stale or its source fingerprint changed; otherwise reuse the sealed copy.

**Implementation Details:**
```json
{
  "schemaVersion": 1,
  "sealedAt": "2026-03-10T14:00:00+11:00",
  "sourceManifest": {
    "statementLines": {"path": "data/statement-lines-fy25-q4.ndjson", "sha256": "...", "size": 12345},
    "accounts": {"path": "data/accounts.ndjson", "sha256": "...", "size": 67890},
    "history": {"generatedAt": "2026-03-10T14:01:00+11:00", "status": "ok|degraded"}
  }
}
```

**Edge Cases:**
- A future-dated `ToDate` or a query period longer than 12 months should fail at seal time with a direct Xero-doc-backed error message.
- Partial seal generation must never leave a half-written cache; reuse the repo's existing atomic-write pattern and `0o600` discipline.

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

### Research Insights

**Best Practices:**
- Treat the 11-column header row as a hard contract. Read-back should reject missing, reordered, or extra columns unless an explicit compatibility path exists.
- Use Python's `csv` module in text mode with `encoding="utf-8"` and `newline=""` for both reads and writes; this is the documented way to preserve quoted commas and avoid newline corruption.
- Keep `StatementLineID` validation semantic, not regex-only: parse with `uuid.UUID(...)`, after stripping whitespace and any leading apostrophe added by Sheets.

**Performance Considerations:**
- Google Sheets supports up to 10 million cells for Sheets-created and CSV-imported spreadsheets, so 287 rows is operationally trivial.
- If the Evidence column grows unexpectedly, `csv.field_size_limit()` is available as a safety valve during read-back.

**Implementation Details:**
```python
with open(output_file, "w", encoding="utf-8", newline="") as f:
    writer = csv.DictWriter(
        f,
        fieldnames=fieldnames,
        quoting=csv.QUOTE_ALL,
        lineterminator="\n",
        extrasaction="raise",
    )
    writer.writeheader()
    writer.writerows(rows)
```

**Edge Cases:**
- Blank separator rows inserted by the user should be ignored when they contain no `StatementLineID`; row-count validation should apply to non-empty data rows only.
- Duplicate `StatementLineID` values after copy/paste should be a fatal validation error before merge or POST export.
- Status values should be trimmed and uppercased before validation so `approve`, ` APPROVE `, and `Approve` normalize deterministically.

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

### Research Insights

**Best Practices:**
- Reuse existing repo patterns where they already exist: `manage-quarters.py` already has quarter gating and atomic JSON discipline; `export-reconcile-spreadsheet.py` already has CSV and payee-normalization primitives.
- Keep the v1 design boring: mounted Google Drive plus CSV is enough. Do not pull Sheets API or Drive API writes into the first implementation unless the local file workflow proves inadequate.
- For any command that becomes a pipeline input, strongly prefer a `--json` mode with machine-readable stdout and human diagnostics on stderr.

**Security Considerations:**
- External vendor research remains opt-in because payee names are real financial data; keep the consent gate from `matching-rules.md`.
- The seal should store only the minimum secrets-free metadata needed for replay. Never copy OAuth tokens or browser artifacts into the seal.

**Edge Cases:**
- If the bank account, tenant, or quarter metadata in the seal does not match the CSV filename or intended POST target, fail closed.
- Prefer one new `read-reconcile-csv.py` with subcommands over multiple tiny scripts to avoid tool sprawl and keep the review loop discoverable.

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

##### Research Insights

**Best Practices:**
- Reuse `gate_check()` from `manage-quarters.py` instead of reimplementing quarter/date validation in a second place.
- Seal validity should compare a source manifest: path, size, modified time, and ideally a content hash for statement lines and accounts.
- Counts alone are too weak. Add a semantic fingerprint over the statement-line payload used downstream, for example sorted `statementLineId|postedDate|amount|payee` rows, so "same count, different content" invalidates cleanly.
- Persist `historyGeneratedAt`, `historySince`, `bankAccountId`, and `summaryOnly` in the seal so later debugging has enough provenance.

**Implementation Details:**
```json
{
  "sealStatus": "ok|degraded",
  "sealInvalidationReason": null,
  "historyGeneratedAt": "2026-03-10T14:01:00+11:00",
  "historySince": "2024-01-01",
  "bankAccountId": "uuid"
}
```

**Edge Cases:**
- If the history refresh fails, write a degraded seal only if statement lines, accounts, and contacts are still trustworthy enough for keyword-only classification.
- If the accounts file changes after seal creation, the seal should invalidate even when statement-line counts are unchanged.

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

##### Research Insights

**Best Practices:**
- Follow the priority order already documented in `matching-rules.md`: CLI history first, then contact lookup, then deterministic keyword rules, then optional external research.
- Make Evidence deterministic and compact so repeated exports do not churn the CSV unnecessarily. A `signal:value` style string is easier to diff than prose.
- Use a numeric score internally and derive `high|medium|low` bands at the end so sorting is stable and explainable.

**Implementation Details:**
```text
history:485(count=38)|amount:within-range|contact:GITHUB INC|band:high
```

**Edge Cases:**
- If history contains conflicting account codes for the same payee, downgrade confidence even if the contact match is exact.
- Blank or generic payees like `TRANSFER` or `PAYMENT` should never inherit high confidence purely from amount similarity.

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

##### Research Insights

**Best Practices:**
- Use `csv.DictReader(..., restkey="__extra__", restval="")` and fail if any row contains unexpected extra cells or missing required cells.
- Validate the header row before reading data rows so renamed columns fail fast.
- Do not use `csv.Sniffer` here. The dialect is known and fixed by contract, so auto-detection only increases ambiguity.
- Output a structured summary object that includes counts, invalid-row previews, duplicate IDs, and a stable diff list for downstream commands.

**Implementation Details:**
```python
reader = csv.DictReader(f, restkey="__extra__", restval="")
for row in reader:
    statement_line_id = row["StatementLineID"].lstrip("'").strip()
    uuid.UUID(statement_line_id)
```

**Edge Cases:**
- Validate duplicate `StatementLineID` values explicitly; row-count validation alone will miss duplicate+missing pairs.
- Ignore rows that are fully blank, but reject partially blank rows that have a status or edited account code without an ID.
- Catch `csv.Error` and surface the physical `line_num` in failures so a malformed quoted field can be repaired quickly in Sheets or a text editor.
- Prefer a stable-file check for the Google Drive path (same size + mtime across two reads) over a single `mtime < 5s` heuristic.

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

##### Research Insights

**Best Practices:**
- Preserve the original CSV order by reading all rows first, indexing updates by `StatementLineID`, and writing rows back in the exact input sequence.
- Treat `APPROVE`, `EDIT`, and `SKIP` as immutable user decisions. `REVIEW` and blank rows remain AI-updatable.
- Keep a diff summary of which rows changed during merge so each iteration is auditable before the file is copied back to Drive.

**Edge Cases:**
- If the user sorted rows manually, merge must still write back in the current visible order rather than re-sorting by confidence.
- If a row is duplicated, abort before merge rather than guessing which copy is canonical.

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

##### Research Insights

**Best Practices:**
- Keep CSV review as a reconcile-mode decision unless discoverability clearly suffers; this avoids widening the skill intake surface more than necessary.
- Document the human recovery path explicitly: use Sheets UI version history for rollback, and named versions for milestone checkpoints such as "v1 reviewed" or "ready to post".

**Edge Cases:**
- The Drive revisions API is useful for automation, but Google documents that revision listings for heavily edited Docs/Sheets/Slides can be incomplete, so UI version history is the safer human-facing rollback story.

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

##### Research Insights

**Best Practices:**
- Build POST bodies from seal facts plus reviewed CSV values, then show a stable preview hash before any write step so retries are easier to reason about.
- Fail closed on unresolved contacts or account codes unless the row is intentionally `SKIP`.
- Keep the POST export idempotent at the file level by producing the same queue for the same seal + CSV inputs.
- Prefer one POST per statement line in v1. Xero's `SummarizeErrors=false` bulk mode can still return HTTP 200 while embedding per-element failures, which complicates recovery unnecessarily.
- Carry a deterministic `Idempotency-Key` on every POST attempt. Xero caches idempotent responses for 6 minutes, rejects reuse with a different request, and recommends preserving the same key only for safe retries of the same payload.
- Serialize writes. The state schema already requires "confirm -> write state -> POST -> write state", and Xero only allows 5 concurrent calls per tenant anyway, so there is no upside in parallel POSTs here.
- Define success narrowly: a row becomes `posted` only after both a successful HTTP response and a returned `BankTransactionID`/OK status have been captured in the run log.

**Implementation Details:**
```json
{
  "queueHash": "sha256(...)",
  "rows": 192,
  "approvedRows": 180,
  "editedRows": 12
}
```

```text
idempotency-key = sha256(queueHash + ":" + statementLineId)
```

```json
{
  "statementLineId": "uuid",
  "idempotencyKey": "sha256(...)",
  "attemptedAt": "2026-03-10T15:04:00+11:00",
  "responseCode": 200,
  "bankTransactionId": "uuid-or-null",
  "result": "posted|retryable|errored"
}
```

**Recovery Workflow:**
1. `confirmed` row enters POST phase with persisted `idempotencyKey` and request hash.
2. Browser/API Explorer submits exactly one BankTransaction payload.
3. If response is `200` and includes a created resource identifier, write `postedAt` and mark `status=posted`.
4. If response is `429`, pause for `Retry-After` seconds and retry the same payload with the same idempotency key.
5. If response is `503 Organisation offline`, pause the tenant for ~5 minutes, save state, then resume from `confirmed` rows first.
6. If response is `400` validation, mark the row `errored`, save the validation message, and continue or stop based on policy.
7. If response is `401`, halt the run, save state, and require re-auth before any further writes.
8. If the request outcome is unknown after timeout/network failure, retry with the same idempotency key inside the 6-minute window; after that window, verify via GET/history before generating a new key.

**Edge Cases:**
- A second POST run against the same CSV should detect the same queue hash and warn about duplicate-write risk before browser automation begins.
- If contact lookup no longer resolves a user-edited Contact name, fall back to `Contact.Name` in the POST body and surface that explicitly in preview output.
- Xero requires `Type`, `Contact`, at least one `LineItem`, and a BANK account on POST. Each line item must have a non-empty description, `Quantity > 0`, a non-zero amount, and an active `AccountCode`.
- If a retry with the same idempotency key keeps returning the same cached internal error, inspect the resource with GET before generating a new key; otherwise we risk creating duplicates after the 6-minute expiry window.
- The current `TaxType` heuristic (`INPUT` for SPEND, `OUTPUT` for RECEIVE`) is a useful default, but the plan should treat tax validation errors as expected recoverable failures because Xero validates tax/account compatibility strictly.

## Acceptance Criteria

### Quarter Seal
- [x] `manage-quarters.py seal Q FY` builds sealed cache with history, contacts, accounts
- [x] Seal includes statement line count + bank export count + match validation
- [x] Seal file has 0o600 permissions
- [x] Re-seal is a no-op if data hasn't changed (skip API call)
- [x] Seal is invalidated message when quarter data changes

### CSV Generation
- [x] Status column is first, StatementLineID is last
- [x] All 11 columns present per spec
- [x] Amounts are plain decimal, 2 places, minus for negative
- [x] Dates are YYYY-MM-DD
- [x] Evidence column explains each proposal
- [x] Confidence uses weighted scoring from confidence-weights.json
- [x] History match = +80, contact lookup = +70 (mutually exclusive)
- [x] Sorted: confidence desc, then account code, then date
- [x] File copied to Google Drive inbox path
- [x] UTF-8, no BOM, \n line endings, comma-delimited, text fields quoted

### CSV Read-Back
- [x] Validates UUID format for StatementLineID
- [x] Validates AccountCode against chart of accounts
- [x] Validates row count against seal
- [x] Reports summary: counts by status, diffs vs original
- [x] Rejects rows with invalid data (clear error messages)
- [x] Handles empty rows gracefully (users add blank rows for grouping)
- [x] Strips leading apostrophes (Google Sheets text-force artifact)

### Iteration Loop
- [x] APPROVE/EDIT/SKIP rows are never overwritten
- [x] REVIEW rows get updated proposals + evidence
- [x] Blank rows may get improved proposals
- [x] Row order preserved after merge
- [x] Google Drive version history provides undo (no manual versioning needed)

### POST Phase
- [x] Reads final CSV, filters to APPROVE + EDIT status only
- [x] Generates correct POST bodies per matching-rules.md templates
- [x] Write interlock: requires `WRITE Q4 FY25` confirmation
- [x] Safe preview shows count + total amount before writing
- [x] POST errors logged with StatementLineID + reason
- [x] Row is marked `posted` only after HTTP success plus returned created-resource identifier
- [x] 429 handling honors `Retry-After` before retry
- [x] 503 Organisation Offline pauses and resumes from saved `confirmed` rows
- [x] Unknown timeout/network result retries with the same idempotency key inside the 6-minute window
- [x] Per-row POST result log includes StatementLineID, idempotency key, response code, and resulting BankTransactionID when available

### ADHD UX
- [x] Zero OAuth required during review phase
- [x] Can start reviewing immediately after CSV is generated
- [x] Can come back hours/days later -- CSV in Drive is the resume point
- [x] Interactive rapid-fire available as fallback for last ~10 stubborn items
- [x] Quarter seal means no surprise "session expired" blockers

### Research Insights

**Best Practices:**
- Add test cases for exact header validation, duplicate IDs, blank grouping rows, apostrophe-prefixed IDs, and quoted commas in payees.
- Add a degraded-history acceptance path so the feature remains usable when the history cache refresh fails.
- Add a stable preview/hash acceptance check for POST export so repeated runs can be reasoned about safely.
- Add a canary-write acceptance path: first real POST run should support a 1-3 row trial before processing the full approved set.

**Edge Cases:**
- Row-count validation should specify "non-empty statement rows" to stay compatible with user-inserted grouping rows.
- Acceptance should explicitly cover status normalization (`approve` -> `APPROVE`) and rejection of unknown status values.
- Acceptance should explicitly cover idempotent retry behavior inside the 6-minute window and safe operator guidance once that window has expired.

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

### Research Insights

**Additional Risks:**
- **Drive revision assumptions drift from reality** | Automation relies on incomplete history | Use Sheets UI version history for human rollback; treat Drive API revisions as supplemental only
- **Duplicate write on rerun** | Same approved rows could be posted twice | Preview queue hash + explicit re-run warning before POST
- **Idempotency key expiry** | Safe retry window closes after 6 minutes | Persist per-row idempotency metadata in the queue and switch to GET-based verification before any post-expiry retry
- **Bulk POST ambiguity** | HTTP 200 can hide element-level failures when `SummarizeErrors=false` | Prefer one-row POSTs in v1, or require per-element response parsing before marking anything posted
- **Browser success != API success** | UI flow could look complete without a durable created transaction | Require captured response code + BankTransactionID before marking `posted`
- **Rate limit burst during reruns** | Resume loop could thrash on 429s | Serialize writes, honor `Retry-After`, and keep per-tenant retry state
- **External vendor research leaks payees** | Financial metadata leaves local context | Keep explicit consent gate before any WebSearch step
- **Granular-scope rollout changes auth copy** | Documentation and troubleshooting become stale | Date-stamp scope guidance and mention the March 2, 2026 Xero scope change explicitly

**Mitigation Refinement:**
- Prefer "stable file across two reads" to a single mtime check for synced Drive files.
- Prefer seal invalidation messages that name the changed input (`statement-lines`, `accounts`, `history`, `bank account`) so recovery is obvious.

## Future Considerations

- **Auto-seal on extract completion** -- run seal automatically after successful extraction
- **Google Sheets API** -- write directly to Sheets (skip CSV, get dropdowns/formatting for free)
- **Learning from corrections** -- diff EDIT rows against proposals to improve keyword rules
- **Multi-quarter batch** -- generate CSVs for all pending quarters at once
- **Direct API mode** -- when OAuth unblocks (GitHub #10), seal + POST become CLI calls

### Research Insights

**Best Practices:**
- Keep Google Sheets API work out of v1 unless raw CSV review proves insufficient; API-driven dropdowns and protected ranges are attractive, but they add OAuth, permission, and operational complexity back into the flow.
- Learning from `EDIT` rows is a strong v2 candidate because it compounds Nathan's own reconciliation history instead of importing generic heuristics.

**Defer for Simplicity:**
- Direct Drive or Sheets API automation
- Per-row collaborative comments
- Multi-quarter orchestration before single-quarter replay is stable

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

### Official docs added during deepening (2026-03-10)

- **Python `csv` module:** `newline=''` is required for file objects, `DictReader`/`DictWriter` are the right primitives here, `QUOTE_ALL` is available, and `field_size_limit()` exists if Evidence grows unexpectedly.
- **Google Sheets limits:** Sheets supports up to **10 million cells** for both Sheets-created and CSV-imported spreadsheets, so the review file size is comfortably within platform limits.
- **Google Sheets version history:** the Sheets UI supports viewing, restoring, copying, and naming earlier versions, which makes it the best rollback path for the human review loop.
- **Google Drive revisions API:** revision listings for frequently edited Docs/Sheets/Slides can be incomplete, so API revision history should not be treated as the primary audit or recovery mechanism.
- **Xero Finance API:** `GET /BankStatementsPlus/statements` requires `BankAccountID`, `FromDate`, and `ToDate`; the query period must be no more than 12 months and future end dates are rejected; `SummaryOnly` defaults to `true`.
- **Xero OAuth scopes:** apps created on or after **March 2, 2026** use granular scopes, but `finance.bankstatementsplus.read` remains in the Finance API scope set that requires additional certification.
- **Xero BankTransactions POST:** create/update requests require `Type`, `Contact`, at least one `LineItem`, and a BANK account; `LineAmountTypes` defaults to inclusive if omitted; `SummarizeErrors=false` can return HTTP 200 with element-level validation failures.
- **Xero idempotent requests:** `Idempotency-Key` applies to POST/PUT/PATCH only, responses are cached for **6 minutes**, reused keys with different payloads return HTTP 400, and repeated cached internal errors should be followed by a GET verification step before retrying with a new key.
- **Xero rate limits:** per tenant, Xero allows 5 concurrent calls in progress, 60 calls per minute, and returns `Retry-After` on minute/daily 429s; `503 Organisation offline` is documented as a temporary state where a ~5 minute retry interval is recommended.

### Internal References

- Existing classifier: `scripts/export-reconcile-spreadsheet.py` (128 keyword rules)
- Contact lookup builder: `scripts/xero-contact-lookup.py`
- Quarter management: `scripts/manage-quarters.py`
- Matching rules: `.claude/skills/xero-explorer/references/matching-rules.md`
- Confidence weights: `.claude/skills/xero-explorer/references/confidence-weights.json`
- State schema: `.claude/skills/xero-explorer/references/state-schema.md`
