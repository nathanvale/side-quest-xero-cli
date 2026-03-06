---
status: complete
priority: p1
issue_id: "044"
tags: [code-review, performance, correctness]
dependencies: []
---

# Unpaginated Unreconciled Snapshot Fetch (Data Correctness Bug)

## Problem Statement

The reconcile command fetches all unreconciled transactions in a single unpaginated request. Xero's API returns max 100 records per page by default. Any tenant with >100 unreconciled transactions will have an incomplete snapshot, causing valid transaction IDs to be incorrectly rejected as "reconciled/missing."

This is a **silent data correctness bug**, not just a performance issue.

## Findings

- **Source:** Performance Oracle, Learnings Researcher
- **File:** `src/cli/commands/reconcile.ts` (lines 424-451)
- **Evidence:** `fetchUnreconciledSnapshot` calls `/BankTransactions?where=IsReconciled==false` with no `?page=` parameter
- **Impact:** False rejection of valid inputs for any tenant with >100 unreconciled transactions

## Proposed Solutions

### Option A: Paginate the snapshot fetch
- Loop with `?page=1`, `?page=2`, etc. until empty response
- Pros: Complete data, simple logic
- Cons: Multiple API calls for large tenants
- Effort: Small
- Risk: Low

### Option B: Targeted validation with input IDs
- Instead of fetching all unreconciled, fetch only the specific IDs from the input batch via `/BankTransactions?IDs={comma-separated}`
- Pros: Far more efficient, exact match
- Cons: Changes validation semantics slightly
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] Tenants with >100 unreconciled transactions can reconcile successfully
- [x] Test with mock server returning paginated responses
- [x] No false rejections of valid BankTransactionIDs

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Performance Oracle identified as P0 correctness bug |
| 2026-02-27 | Fixed: added pagination loop to fetchUnreconciledSnapshot | Option A implemented - page-walk loop with PAGE_SIZE=100. Integration test added with 100-item page 1 + page 2 item to verify. See also todo 066 (duplicate). |
