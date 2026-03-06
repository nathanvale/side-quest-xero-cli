---
status: complete
priority: p2
issue_id: "073"
tags: [validation, reconcile, zod]
dependencies: []
---

# 073: Reject reconcile inputs that specify no reconciliation target

## Problem Statement

The `ReconcileItemSchema` in `src/cli/commands/reconcile.ts` only enforced mutual exclusivity (can't have both AccountCode AND InvoiceID), but didn't require at least one. Items with only a BankTransactionID were silently ignored -- no result entry, no failure -- giving users a false "complete" response.

## Findings

The execution loop at lines 854-980 uses `if (input.AccountCode)` and `if (input.InvoiceID)` branches with no else path. Items matching neither branch produced no result entry and were not counted in the summary.

## Recommended Action

Add a second Zod `.refine()` requiring at least one of AccountCode or InvoiceID. This catches the problem at validation time with a clear error message.

## Acceptance Criteria

- [x] Inputs with neither AccountCode nor InvoiceID are rejected at parse time
- [x] Clear error message: "Either AccountCode or InvoiceID is required"
- [x] Existing valid inputs still pass validation
- [x] Build and typecheck pass

## Work Log

### 2026-02-27 - Fix applied

**By:** Claude Code

**Actions:**
- Added `.refine((value) => value.AccountCode || value.InvoiceID, { message: 'Either AccountCode or InvoiceID is required' })` to `ReconcileItemSchema` (`src/cli/commands/reconcile.ts:55-57`)
- Verified build and typecheck pass
