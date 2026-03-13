# Workflow: CSV Review Loop

Use this when you want the lowest-friction reconciliation path:

1. Build or refresh the quarter seal
2. Export the review CSV
3. Upload to Google Sheets via `gsheet-sync.py`
4. Let Nathan review in Sheets at his own pace
5. Download, validate, merge updates, and iterate
6. Export POST bodies only when the CSV is ready
7. Execute the confirmed queue with `xero-cli`
8. Rollback if needed with `reconcile-delete`

## Variables

Set these before running any commands. Substitute the concrete quarter values -- never run placeholders literally.

```bash
Q=4          # Quarter number (1-4)
FY=25        # Two-digit financial year
SEAL="data/.quarter-cache-fy${FY}-q${Q}.json"
CSV="data/reconcile-review-fy${FY}-q${Q}.csv"
QUEUE="data/.post-queue-fy${FY}-q${Q}.json"
POST_RUN="data/.post-run-fy${FY}-q${Q}.json"
DELETE_RUN="data/.delete-run-fy${FY}-q${Q}.json"
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

## Phase 5: Prepare and execute the POST run

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

Begin the guarded post run:

```bash
python3 scripts/read-reconcile-csv.py \
  begin-post-run "$QUEUE" \
  --output "$POST_RUN" \
  --confirm "WRITE Q${Q} FY${FY}"
```

That writes the preview, queue hash, idempotency keys, and result log path before any real POST execution starts.

Dry-run first to preview without writes:

```bash
bun run xero-cli reconcile-post \
  --queue "$QUEUE" --post-run "$POST_RUN" --dry-run
```

Execute the queue:

```bash
bun run xero-cli reconcile-post \
  --queue "$QUEUE" --post-run "$POST_RUN" --execute
```

This command reuses the CLI's normal auth/token handling, preserves the post-run state after every attempt, and appends one JSON log line per posted/retryable/errored row.

## Phase 6: Rollback with reconcile-delete (if needed)

If posted transactions need to be undone, create a delete-run from the post-run state:

```bash
python3 scripts/read-reconcile-csv.py \
  begin-delete-run "$POST_RUN" \
  --output "$DELETE_RUN" \
  --confirm "DELETE Q${Q} FY${FY}"
```

Dry-run first:

```bash
bun run xero-cli reconcile-delete --post-run "$DELETE_RUN" --dry-run
```

Execute the deletes:

```bash
bun run xero-cli reconcile-delete --post-run "$DELETE_RUN" --execute
```

This sets `Status: "DELETED"` on each posted BankTransaction via the Xero API. Works for SPEND and RECEIVE types. After deletion, the same items can be re-posted with a fresh post-run (new idempotency keys).
