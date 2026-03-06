---
status: complete
priority: p2
issue_id: "064"
tags: [csv, validation, schema]
dependencies: []
---

# AccountCode Required in CSV Validation but Optional in Schema

## Problem Statement

In `src/cli/commands/reconcile.ts`, the `loadCsv` function required `AccountCode` as a mandatory CSV column and silently skipped rows missing it. However, `ReconcileItemSchema` marks `AccountCode` as `.optional()` and the `ReconcileInputBase` interface declares it as `AccountCode?: string`. This mismatch silently dropped invoice-based reconciliation rows that legitimately omit `AccountCode`.

## Findings

- `ReconcileItemSchema` (line 66-69): `AccountCode` is `.optional()`
- `ReconcileInputBase` (line 122): `AccountCode?: string`
- `loadCsv` required array (line 361): included `AccountCode` -- mismatch
- `loadCsv` row skip (line 374): `!record.AccountCode` -- silently dropped valid rows
- `AccountCode` was also assigned directly without `|| undefined`, unlike sibling fields

**Source:** Code review finding

## Resolution

### Changes Made

1. Removed `AccountCode` from the `required` columns array -- only `BankTransactionID` is required
2. Removed `!record.AccountCode` from the row-skip condition -- only skip rows missing `BankTransactionID`
3. Changed `AccountCode` assignment to use `|| undefined` to coerce empty strings, consistent with `InvoiceID`, `Amount`, and `CurrencyCode`

**Effort:** 5 minutes | **Risk:** Low

## Acceptance Criteria

- [x] `AccountCode` removed from required CSV columns
- [x] Rows without `AccountCode` no longer silently skipped
- [x] `BankTransactionID` remains the only required field
- [x] Empty `AccountCode` values coerced to `undefined` (consistent with other optional fields)
- [x] CSV validation aligns with `ReconcileItemSchema`

## Work Log

### 2026-02-27 - Resolved

**By:** Claude Code
**Actions:** Removed `AccountCode` from required array and row-skip condition in `loadCsv`. Added `|| undefined` coercion for `AccountCode` to match sibling fields.
