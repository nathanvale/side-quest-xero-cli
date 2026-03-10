# Workflow: CSV Review Loop

Use this when you want the lowest-friction reconciliation path:

1. Build or refresh the quarter seal
2. Export the review CSV
3. Copy it to Google Drive
4. Let Nathan review in Sheets at his own pace
5. Read back, merge updates, and iterate
6. Export POST bodies only when the CSV is ready

## Why this path exists

- Zero OAuth is required during the review phase
- The review artifact is the CSV in Google Drive, not a live terminal session
- Google Sheets version history is the human undo/rollback path
- The quarter seal freezes statement-line facts so there are no surprise "session expired" blockers during review

## Phase 1: Seal the quarter

```bash
python3 scripts/manage-quarters.py seal "$Q" "$FY"
```

This produces `data/.quarter-cache-fy{YY}-q{N}.json`.

## Phase 2: Generate and copy the review CSV

```bash
python3 scripts/export-reconcile-spreadsheet.py \
  --seal "data/.quarter-cache-fy25-q4.json" \
  --output "data/reconcile-review-fy25-q4.csv" \
  --copy-to-google-drive
```

Default mounted Drive inbox:

`/Users/nathanvale/Library/CloudStorage/GoogleDrive-hi@nathanvale.com/My Drive/00 Inbox`

Override if needed:

```bash
python3 scripts/export-reconcile-spreadsheet.py \
  --seal "data/.quarter-cache-fy25-q4.json" \
  --output "data/reconcile-review-fy25-q4.csv" \
  --copy-to-google-drive \
  --google-drive-inbox "$GDRIVE_INBOX"
```

## Phase 3: Review in Google Sheets

- Open the copied CSV in Google Sheets
- Use `Status` explicitly: `APPROVE`, `EDIT`, `SKIP`, `REVIEW`, or blank
- Use Sheets version history for rollback and milestone naming:
  - `v1 reviewed`
  - `needs research`
  - `ready to post`

The CSV in Drive is the resume point for days-later follow-up.

## Phase 4: Read back and iterate

Validate:

```bash
python3 scripts/read-reconcile-csv.py \
  read "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --seal "data/.quarter-cache-fy25-q4.json"
```

Refresh only `REVIEW` and blank rows:

```bash
python3 scripts/read-reconcile-csv.py \
  merge "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --seal "data/.quarter-cache-fy25-q4.json" \
  --output "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv"
```

If only ~10 stubborn items remain, rapid-fire terminal review is a valid fallback.

## Phase 5: Prepare the POST run

Export the queue:

```bash
python3 scripts/read-reconcile-csv.py \
  export-post-bodies "$GDRIVE_INBOX/reconcile-review-fy25-q4.csv" \
  --seal "data/.quarter-cache-fy25-q4.json" \
  --output "data/.post-queue-fy25-q4.json"
```

Begin the guarded post run:

```bash
python3 scripts/read-reconcile-csv.py \
  begin-post-run "data/.post-queue-fy25-q4.json" \
  --output "data/.post-run-fy25-q4.json" \
  --confirm "WRITE Q4 FY25"
```

That writes the preview, queue hash, idempotency keys, and result log path before any real POST execution starts.
