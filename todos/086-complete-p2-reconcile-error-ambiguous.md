---
status: complete
priority: p2
issue_id: "086"
tags: [agent-native, reconcile, dx, error-handling]
dependencies: []
---

# "reconciled/missing IDs" error is ambiguous

## Problem Statement

The preflight error at `src/cli/commands/reconcile.ts:755-762` fires for three distinct situations but gives one generic message: "Input contains reconciled/missing IDs". Nathan can't tell if the ID was already reconciled (race condition), doesn't exist (typo), or was mangled during spreadsheet editing.

## Findings

- `src/cli/commands/reconcile.ts:755-762` -- single error for 3 cases:
  1. Transaction already reconciled (race condition with another user)
  2. BankTransactionID doesn't exist (typo or copy-paste error)
  3. BankTransactionID mangled during spreadsheet editing
- Cross-referencing against the full transaction set would distinguish cases
- Users waste time guessing which case they're in

**Source:** DX Pass 2 (Critical issue #2)

## Proposed Solutions

### Option 1: Distinguish already-reconciled from not-found

**Approach:** Cross-reference invalid IDs against the full (including reconciled) transaction set. Emit separate error lines: "Already reconciled: abc123" vs "Not found (typo?): ghi789".

**Effort:** 30 minutes

**Risk:** Low (adds one extra API call for the full set check)

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] Already-reconciled IDs identified separately from not-found IDs
- [ ] Error message distinguishes the two cases
- [ ] Test covers both cases

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from DX Pass 2 (Critical issue #2)
- Confirmed single error message for 3 distinct failure modes

### 2026-02-27 - Implemented disambiguation

**By:** Claude Code

**Actions:**
- Replaced generic "Input contains reconciled/missing IDs" error with two distinct messages
- When invalid IDs are detected, cross-references them via `fetchBankTransactionsBatch` against the full transaction set (reconciled + unreconciled)
- IDs found in full set but not in unreconciled set get "Already reconciled: {id}"
- IDs not found in full set get "Not found: {id}"
- Each invalid ID gets its own line in the error for easy scanning
