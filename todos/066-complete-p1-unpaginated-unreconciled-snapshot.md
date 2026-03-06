---
status: complete
priority: p1
issue_id: "066"
tags: [code-review, performance, reliability, xero]
dependencies: []
---

# Paginate unreconciled snapshot fetch in reconcile

`runReconcile` validates input IDs against a single API call to `/BankTransactions?where=IsReconciled==false`. If the account has more unreconciled transactions than one page, valid IDs can be incorrectly rejected.

## Findings

- `fetchUnreconciledSnapshot` does one request and never follows pagination ([src/cli/commands/reconcile.ts](/Users/nathanvale/code/side-quest-xero-cli/src/cli/commands/reconcile.ts:424)).
- Validation later treats any ID not in this snapshot as invalid ([src/cli/commands/reconcile.ts](/Users/nathanvale/code/side-quest-xero-cli/src/cli/commands/reconcile.ts:670)).
- Blast radius: all high-volume tenants; can block legitimate reconciliations with false negatives.

## Proposed Solutions

### Option 1: Add explicit page-walk loop (Recommended)

**Approach:** Fetch pages until empty result set, merge all IDs into snapshot map.

**Pros:** Correct behavior at scale; deterministic.

**Cons:** More API calls for large tenants.

**Effort:** Medium

**Risk:** Low

---

### Option 2: Validate per input ID instead of global snapshot

**Approach:** Query each BankTransaction by ID and validate `IsReconciled` directly.

**Pros:** No global snapshot paging logic.

**Cons:** N requests; slower and more rate-limit prone.

**Effort:** Medium

**Risk:** Medium

---

### Option 3: Feature-flag batch-size cap

**Approach:** Keep current approach but reject inputs above a safe threshold with explicit guidance.

**Pros:** Fast mitigation.

**Cons:** Not a true fix.

**Effort:** Small

**Risk:** Medium

## Recommended Action


## Technical Details

- Affected files:
- [src/cli/commands/reconcile.ts](/Users/nathanvale/code/side-quest-xero-cli/src/cli/commands/reconcile.ts:424)

## Resources

- PR branch: `feat/xero-cli-agent-native`

## Acceptance Criteria

- [x] Reconcile snapshot fetch reads all relevant pages.
- [x] Input IDs that exist in later pages are accepted.
- [x] Integration test covers >1 page unreconciled data.
- [x] Existing reconcile tests continue passing.

## Work Log

### 2026-02-27 - Initial Discovery

**By:** Codex

**Actions:**
- Inspected reconcile validation path and API calls.
- Confirmed single-page assumption in snapshot fetch.

**Learnings:**
- Validation correctness currently depends on default API page size.

### 2026-02-27 - Resolved as duplicate of 044

**By:** Claude Code

**Actions:**
- This is a duplicate of todo 044-complete-p1-unpaginated-snapshot-fetch.
- Fix applied in todo 044: added pagination loop to `fetchUnreconciledSnapshot` with `page` parameter, looping until fewer than 100 results returned.
- Integration test added covering multi-page scenario.

## Notes

- Duplicate of todo 044. Both resolved by the same fix.
