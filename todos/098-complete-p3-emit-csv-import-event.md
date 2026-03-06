---
status: complete
priority: p3
issue_id: "098"
tags: [agent-native, observability, events, reconcile, csv]
dependencies: []
---

# Emit xero-csv-imported event when reconcile loads from CSV

## Problem Statement

When an agent or Nathan uses `reconcile --from-csv`, the observability server has no visibility into the CSV import step. This matters because:

- CSV is the handoff point between agent review and execution
- Import failures (bad columns, missing IDs) are common and debuggable
- Tracking CSV usage patterns helps understand the agent workflow
- Detecting SuggestedAccountCode vs AccountCode usage (the fallback from TODO 082)

## Proposed Events

| Event | When | Payload |
|-------|------|---------|
| `xero-csv-imported` | After successful CSV parse | `{ rowCount, columns, source (file/stdin), usedFallbackColumn }` |
| `xero-csv-import-failed` | On CSV parse/validation failure | `{ error, source }` |

## Effort

10 minutes

## Risk

None

## Acceptance Criteria

- [x] `xero-csv-imported` emitted after successful CSV load
- [x] Payload includes row count and whether SuggestedAccountCode fallback was used
- [x] `xero-csv-import-failed` emitted on parse failure

## Work Log

### 2026-02-27 - Filed from observability brainstorm

**By:** Claude Code

### 2026-02-27 - Implemented CSV import events

**By:** Claude Code

- Changed `loadCsv` return type to `CsvLoadResult` containing both `inputs` and `usedFallbackColumn` metadata
- `usedFallbackColumn` is set to `true` when any record lacks `AccountCode` but has `SuggestedAccountCode`
- Added `xero-csv-imported` event emission after successful CSV load with `rowCount`, `source`, and `usedFallbackColumn`
- Added `xero-csv-import-failed` event emission in a try/catch around `loadCsv`, re-throwing after emit so existing error handling is preserved
- Updated acceptance criteria checkboxes and status to complete
