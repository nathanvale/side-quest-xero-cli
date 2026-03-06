---
status: complete
priority: p2
issue_id: "094"
tags: [agent-native, observability, events, reconcile]
dependencies: []
---

# Emit per-item reconcile events for detailed pipeline visibility

## Problem Statement

The observability server receives batch-level events (`xero-reconcile-started`, `xero-reconcile-completed`) but has no visibility into individual item processing. When a 300-item batch fails at item 47, the dashboard shows a failed batch but can't show:

- Which items succeeded before the failure
- Real-time progress (items processed / total)
- Per-item duration distribution (spotting slow API calls)
- Conflict vs error breakdown at the item level

## Proposed Events

| Event | When | Payload |
|-------|------|---------|
| `xero-reconcile-item-succeeded` | After successful item reconciliation | `{ bankTransactionId, accountCode, type, durationMs }` |
| `xero-reconcile-item-failed` | After item failure | `{ bankTransactionId, error, durationMs }` |
| `xero-reconcile-item-skipped` | When item is skipped (already processed) | `{ bankTransactionId, reason }` |
| `xero-reconcile-item-conflict` | When item hits conflict (already reconciled) | `{ bankTransactionId }` |

These are fire-and-forget so they add zero latency to the reconcile pipeline.

## Considerations

- Events are fire-and-forget, so a 300-item batch generates 300 rapid `fetch()` calls
- The observability server should handle bursty traffic (it already does for @side-quest tools)
- Consider batching events client-side if volume becomes a concern (future optimization)
- BankTransactionID is safe to include (it's a UUID, not sensitive financial data)

## Effort

20 minutes

## Risk

Low -- fire-and-forget calls, no impact on reconcile performance

## Acceptance Criteria

- [x] Per-item events emitted during reconcile processing
- [x] Events include BankTransactionID, outcome, and duration
- [x] No sensitive financial data in payloads (amounts, account names excluded)
- [x] Events don't block or slow down reconcile processing

## Work Log

### 2026-02-27 - Filed from observability brainstorm

**By:** Claude Code

### 2026-02-27 - Implemented per-item reconcile events

**By:** Claude Code

Added five `emitEvent` calls in the per-item processing loop of `src/cli/commands/reconcile.ts`:

- `xero-reconcile-item-skipped` -- emitted when an item is already processed in state, payload: `{ bankTransactionId, reason: 'already-processed' }`
- `xero-reconcile-item-succeeded` (account-code path) -- emitted after successful AccountCode reconciliation, payload: `{ bankTransactionId, accountCode, type: 'account-code', durationMs }`
- `xero-reconcile-item-succeeded` (invoice-payment path) -- emitted after successful InvoiceID reconciliation, payload: `{ bankTransactionId, accountCode: undefined, type: 'invoice-payment', durationMs }`
- `xero-reconcile-item-conflict` -- emitted when a XeroConflictError is caught, payload: `{ bankTransactionId }`
- `xero-reconcile-item-failed` -- emitted on general failure, payload: `{ bankTransactionId, error, durationMs }`

Duration is measured via `performance.now()` with `itemStart` captured before the try block. No sensitive financial data (amounts, account names) is included in any payload. All events use fire-and-forget `emitEvent` so zero latency impact on the reconcile pipeline. TypeScript type check passes.
