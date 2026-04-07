# Workflow: CSV Review Loop

Use this when you want the lowest-friction reconciliation path:

1. Build or refresh the quarter seal
2. Export the review CSV
3. Upload to Google Sheets via `gsheet-sync.py`
4. Let Nathan review in Sheets at his own pace
5. Download, validate, merge updates, and iterate
6. Export the post queue when the CSV is ready
7. Browser reconciliation via Xero UI (`/browse`)

## Variables

Set these before running any commands. Substitute the concrete quarter values -- never run placeholders literally.

```bash
Q=4          # Quarter number (1-4)
FY=25        # Two-digit financial year
SEAL="data/.quarter-cache-fy${FY}-q${Q}.json"
CSV="data/reconcile-review-fy${FY}-q${Q}.csv"
QUEUE="data/.post-queue-fy${FY}-q${Q}.json"
BROWSER_STATE="data/.browser-reconcile-state-fy${FY}-q${Q}.json"
SPREADSHEET_ID="..."  # Google Sheets ID for this quarter
GID="..."             # Sheet tab gid
```

Look up the spreadsheet ID for the active quarter in memory (`project_active_quarter.md`).

## Why this path exists

- Zero OAuth is required during the review phase
- The Google Sheet is the source of truth during review -- not local CSV files
- Google Sheets version history is the human undo/rollback path
- The quarter seal freezes statement-line facts so there are no surprise "session expired" blockers during review
- Auth remains out of scope here. Do not automate login as part of the review loop; instead require a fresh extract/seal before any write phase.

## Phase 1: Seal the quarter

```bash
python3 scripts/manage-quarters.py seal "$Q" "$FY"
```

This produces `data/.quarter-cache-fy{YY}-q{N}.json`.

## Phase 2: Generate and upload the review CSV

Generate the CSV locally:

```bash
python3 scripts/export-reconcile-spreadsheet.py \
  --seal "$SEAL" \
  --output "$CSV"
```

Upload to Google Sheets:

```bash
python3 scripts/gsheet-sync.py write "$SPREADSHEET_ID" --gid "$GID" --input "$CSV"
```

## Phase 3: Review in Google Sheets

- Open the Google Sheet (source of truth during review)
- Use `Status` explicitly: `APPROVE`, `EDIT`, `SKIP`, `REVIEW`, or blank
- Use Sheets version history for rollback and milestone naming:
  - `v1 reviewed`
  - `needs research`
  - `ready to post`

The Google Sheet is the resume point for days-later follow-up.

## Phase 4: Read back and iterate

Download the latest from Sheets:

```bash
python3 scripts/gsheet-sync.py read "$SPREADSHEET_ID" --gid "$GID" --output "$CSV"
```

Validate against the seal:

```bash
python3 scripts/read-reconcile-csv.py read "$CSV" --seal "$SEAL"
```

Refresh only `REVIEW` and blank rows from the latest seal:

```bash
python3 scripts/read-reconcile-csv.py merge "$CSV" --seal "$SEAL" --output "$CSV"
```

Upload the merged result back to Sheets:

```bash
python3 scripts/gsheet-sync.py write "$SPREADSHEET_ID" --gid "$GID" --input "$CSV"
```

If only ~10 stubborn items remain, rapid-fire terminal review is a valid fallback.

## Phase 5: Prepare the post queue

Download the final reviewed CSV from Sheets:

```bash
python3 scripts/gsheet-sync.py read "$SPREADSHEET_ID" --gid "$GID" --output "$CSV"
```

Export the queue:

```bash
python3 scripts/read-reconcile-csv.py \
  export-post-bodies "$CSV" --seal "$SEAL" --output "$QUEUE"
```

Before any write phase, rebuild the current seal from a fresh extract and verify drift:

```bash
python3 scripts/manage-quarters.py seal "$Q" "$FY"

python3 scripts/read-reconcile-csv.py \
  verify-post-sync "$QUEUE" --current-seal "$SEAL"
```

If this fails, stop. Xero changed underneath the reviewed CSV, so regenerate or merge from the refreshed seal before writing.

## Phase 6: Browser reconciliation

The Xero API cannot reconcile statement lines -- it can only create orphaned transactions.
Instead, automate the Xero Reconcile UI via `/browse` to
create+reconcile in one step.

**Full workflow:** See [browser-reconcile.md](browser-reconcile.md)

**Quick summary:**

1. Run `/browse go.xero.com healthcheck`, then dispatch the next
   sequential reconcile batch through `/browse`
2. For each visible statement line (~10 per page):
   a. Match to queue item by amount + date using `scripts/reconcile-browser-lookup.py`
   b. If bank rule pre-filled: **validate** contact + account code against queue data first, then click OK
   c. If empty or mismatch: fill Who/What from queue data, then click OK
3. Page auto-refreshes with next batch after each OK
4. Progress saved to `data/.browser-reconcile-state-fy{YY}-q{N}.json`
   after each successful batch
5. Repeat until all Q{N} items are reconciled

**Rollback:** Browser-reconciled transactions cannot be un-reconciled via API. Use "Remove & Redo" in the Xero UI (Account Transactions -> select -> Remove & Redo).
