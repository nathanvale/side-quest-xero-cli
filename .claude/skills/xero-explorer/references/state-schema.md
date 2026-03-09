# State Schema Reference

JSON state file for tracking reconciliation progress across sessions.

## File Location

`data/.xero-explorer-state-fy{YY}-q{N}.json`

This is intentionally different from the CLI's path (`<root>/.xero-reconcile-state.json`). The explorer workflow uses quarter-scoped state files so multiple quarter reconciliations do not overwrite each other.

## Schema

```json
{
  "extractedAt": "2026-03-05T09:00:00+11:00",
  "startedAt": "2026-03-05T10:30:00+11:00",
  "mode": "batch",
  "dryRun": false,
  "activeRound": 2,
  "totalAtStart": 300,
  "dataSource": "statement-lines-fy26-q1",
  "statementLinesFile": "data/statement-lines-fy26-q1.ndjson",
  "quarter": "Q1 FY26",
  "writeStrategy": "api-explorer-post",
  "bankAccountId": "<BANK_ACCOUNT_ID for selected tenant>",
  "transactions": {
    "<statementLineId>": {
      "status": "posted",
      "round": 1,
      "confidenceScore": 88,
      "confidenceBand": "high",
      "confidenceVersion": "v1",
      "accountCode": "6310",
      "contactId": "uuid-from-lookup-or-null",
      "contactName": "GITHUB",
      "confirmedAt": "2026-03-05T10:45:00+11:00",
      "postedAt": "2026-03-05T10:46:00+11:00",
      "errorReason": null
    }
  },
  "researchCache": {
    "mokosz elwood": {
      "normalizedKey": "mokosz elwood",
      "query": "Mokosz Elwood business Australia",
      "result": "Cafe/restaurant in Elwood, VIC",
      "suggestedCode": "6420",
      "confidence": "medium",
      "searchedAt": "2026-03-05T10:35:00+11:00"
    }
  },
  "approvalHistory": [
    {
      "at": "2026-03-05T10:44:00+11:00",
      "type": "group_approval",
      "statementLineIds": ["id-1", "id-2", "id-3"],
      "fromStatus": "classified",
      "toStatus": "confirmed",
      "accountCode": "6310"
    }
  ],
  "savedAt": "2026-03-05T11:15:00+11:00"
}
```

## Field Conventions

**Timestamps:** All use `{verb}At` pattern and must be ISO8601 with timezone offset (for example `+11:00`) -- `extractedAt`, `startedAt`, `confirmedAt`, `postedAt`, `searchedAt`, `savedAt`.

**`activeRound`:** The session's processing cursor (which round we're working through). Distinct from per-transaction `round` (which round a transaction was classified into).

**`mode`:** UI interaction mode only: `batch` or `rapid-fire`.

**`dryRun`:** Execution flag. If true, run through classification + safe preview but do not POST writes.

**`dataSource`:** Quarter-scoped source key (for example, `"statement-lines-fy26-q1"`).

**`confidenceScore` / `confidenceBand` / `confidenceVersion`:**
- Required for each transaction at `classified` stage and onward
- `confidenceVersion` ties classification to the scoring contract version in matching-rules
- `confidenceVersion` is derived as `"v" + confidence-weights.json schemaVersion` (e.g., schemaVersion 1 -> "v1", schemaVersion 2 -> "v2")

**`statementLinesFile`:** Exact NDJSON path for this session (for example, `data/statement-lines-fy26-q1.ndjson`).

**`quarter`:** Human-readable quarter label (for example, `Q1 FY26`), used in progress and resume messaging.

**`writeStrategy`:** Either `"api-explorer-post"` (browser automation) or `"manual-export"` (export JSON for manual upload). Switch to `manual-export` if POST verification fails.

**`approvalHistory`:** Append-only log of approvals to enable `undo last` before POST begins.

## Status Lifecycle

```
classified  ->  confirmed  ->  posted
    |               |
    v               v
  skipped        errored
```

- **classified** -- Phase A assigned a round + suggested account code
- **confirmed** -- user approved the categorization
- **posted** -- POST to Xero succeeded
- **skipped** -- user chose not to reconcile (terminal)
- **errored** -- POST failed with reason (terminal, retryable on next resume)

## Write Discipline

**Critical:** State must be written at two explicit moments:

1. **IMMEDIATELY after user approval** (before any POST attempt) -- set status to `confirmed`, write to disk. Only then attempt POST.
2. **AFTER each successful POST response** -- set status to `posted`, update `postedAt`, write to disk.

Never batch these. Write after every individual action.

### Atomic Write Pattern

Use a checked-in script for atomic writes (no inline interpreters):

```bash
# Build state JSON in a temp file using your app logic, then write atomically:
python3 scripts/atomic-json-write.py \
  data/.xero-explorer-state-fy26-q1.json \
  /tmp/xero-state-draft.json
```

**Never** use `python3 -c` with string interpolation for state writes. Vendor names containing quotes or escape sequences can cause injection.

## Validation on Load

1. JSON parses without error
2. `statementLinesFile` exists and all transaction IDs in `transactions` map exist in that file
3. No transaction has both `confirmedAt` set and `status: classified` (invalid lifecycle)
4. All `status` values are one of: `classified`, `confirmed`, `posted`, `skipped`, `errored`
5. `quarter` + `statementLinesFile` match the user-selected target quarter for this run

If validation fails, halt with a clear message. Preserve corrupt file as `.xero-explorer-state-fy{YY}-q{N}.json.corrupt-TIMESTAMP` for forensics.

Use the command below before resume/write flows:

```bash
python3 scripts/manage-quarters.py validate-state "$Q" "$FY"
```

## Resume Semantics

**Resume flow:**
1. Load state file, validate
2. POST any `confirmed` items first (recovering from interruption between confirm and POST)
3. Continue with remaining `classified` items in `activeRound`
4. Load ONLY remaining items for the active round (via projection script)
5. Do NOT reload completed rounds into context

**Context injection on resume:**
```
Resuming Q1 FY26 from [date]. Mode: batch. R1: 180 done. R2: 12/45 done. 33 remaining.
```

If `researchCache` has entries for remaining Round 2 items: "Cached research for N vendors from previous session."

**Fresh start:**
1. Archive existing state to `.xero-explorer-state-fy{YY}-q{N}.prev.json`
2. Create new state
3. Ask: "Keep the research cache for vendors already looked up?"

## Deriving Progress

All progress is derived from the transaction status map. No separate counters needed.

```python
# Total done
done = sum(1 for t in transactions.values() if t['status'] in ('posted', 'skipped'))

# Remaining in round N
remaining = sum(1 for t in transactions.values()
                if t['round'] == N and t['status'] == 'classified')

# Errored (retryable)
errored = sum(1 for t in transactions.values() if t['status'] == 'errored')
```
