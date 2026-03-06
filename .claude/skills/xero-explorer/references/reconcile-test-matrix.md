# Reconcile DX Test Matrix

Focused checks for UX-critical reconcile behavior.

## Undo + Resume

- Approve one batch, run `undo last`, verify statuses revert from `confirmed` to `classified`
- Approve two batches, restart session, verify `approvalHistory` survives reload
- Undo with empty history returns "Nothing to undo yet"
- Undo after first `posted` item is blocked with explicit message

## Safe Preview

- With confirmed items, preview totals equal status-derived confirmed count
- `review` returns to Phase B without writes
- `cancel` saves state and exits with no POST
- `dry-run` always exits after preview with no POST calls
- Write interlock requires exact phrase `WRITE Q{N} FY{YY}` before POST begins
- Any preview schema mismatch aborts write phase

## Confidence Grouping

- High confidence groups capped at 25
- Medium confidence groups capped at 12
- Low confidence groups capped at 5
- Confidence badge shown for every batch group
- Every classified transaction has `confidenceScore`, `confidenceBand`, `confidenceVersion`

## State Pathing

- Quarter-scoped state file path resolves via `manage-quarters.py statefile Q FY`
- Q1 and Q2 sessions maintain separate state files
- Resume for one quarter does not read other quarter state files

## Quarter Gate

- Future quarter returns "not finished yet" with concrete comeback date
- Completed quarter without QIF returns CommBank download instruction and required filename
- Completed quarter with valid QIF passes gate and continues

## Browser Resilience

- Missing selector retries with backoff 0.5s/1s/2s
- After retry exhaustion, state saved and actionable next step shown
- Snapshot + URL captured in failure context
- `scripts/xero-browser-healthcheck.sh` passes before long runs

## Progress Semantics

- Progress output always includes both:
  - Approved (not written)
  - Posted (written)
