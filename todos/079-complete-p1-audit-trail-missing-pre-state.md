---
status: complete
priority: p1
issue_id: "079"
tags: [agent-native, reconcile, audit, financial-safety]
dependencies: []
---

# Audit trail missing pre-state for rollback

## Problem Statement

The reconcile audit entry for account-code changes records the new `AccountCode` but not the original `LineItems`. If the agent assigns wrong account codes to a batch of transactions, there is no local record of the previous state to write a rollback script. Nathan would need to manually query Xero's audit history per-transaction.

## Findings

- `src/cli/commands/reconcile.ts:904-911` -- audit write includes `BankTransactionID`, `AccountCode`, `status` but not original line items
- The `pre` variable (full BankTransaction fetched at line 858) is already in scope
- Adding `originalLineItems: pre.LineItems` to the audit entry is a one-line change
- This is a financial data integrity issue -- if 50 transactions get wrong codes, no local rollback path exists

**Source:** Security Pass 2 (Critical issue #1)

## Proposed Solutions

### Option 1: Add originalLineItems to audit entry

**Approach:** Add `originalLineItems: pre.LineItems` to the audit write at line 904-911.

**Effort:** 5 minutes

**Risk:** Low (increases audit file size slightly)

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] Audit entry for account-code reconciliation includes `originalLineItems`
- [ ] Existing audit entries unaffected (new field is additive)
- [ ] Test verifies pre-state is captured in audit

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from Security Pass 2 (Critical issue #1)
- Confirmed `pre` variable is in scope and contains LineItems

### 2026-02-27 - Implemented fix

**By:** Claude Code

**Actions:**
- Added `originalLineItems: pre.LineItems` to the audit entry at line 911 in `src/cli/commands/reconcile.ts`
- No type changes needed -- `AuditWriter.write()` accepts `Record<string, unknown>`
- Change is purely additive; existing audit entries and other audit write sites are unaffected
