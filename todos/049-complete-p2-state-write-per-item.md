---
status: complete
priority: p2
issue_id: "049"
tags: [code-review, performance]
dependencies: []
---

# State File Write-Per-Item Causes Quadratic I/O in Reconcile

## Problem Statement

Every successfully reconciled transaction triggers `markProcessed` + `saveState`. Each `markProcessed` creates a full shallow copy of the `processed` record via spread, then `saveState` serializes the entire state to JSON and writes it atomically. For 1,000 items with 5,000 previously processed, this produces ~5.5M key slot copies and 3,000 filesystem operations.

## Findings

- **Source:** Performance Oracle (CRITICAL-1)
- **Files:** `src/cli/commands/reconcile.ts` (801-802, 869-870), `src/state/state.ts` (64-83, 86-94)
- **Impact:** Hundreds of MB of transient allocations, potentially seconds of pure serialization overhead at scale

## Proposed Solutions

### Option A: Batch state writes (IMPLEMENTED)
- Accumulate all changes in memory, write once at end of batch (or every 50 items)
- Pros: Eliminates quadratic I/O
- Cons: Slightly more state loss risk on crash (mitigated by audit trail)
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] State file written at most once per batch (or per checkpoint interval)
- [x] Reconcile 1,000 items without noticeable I/O overhead
- [x] Audit trail still captures per-item results

## Resolution

Added `StateBatcher` class to `src/state/state.ts` that:
- Mutates an internal processed map in place (avoids O(n^2) spread copies)
- Auto-flushes to disk every 50 items as a checkpoint
- Flushes remaining state at end of reconciliation loop
- Preserves existing `markProcessed`/`saveState` exports for backward compatibility

Updated `src/cli/commands/reconcile.ts` to use `StateBatcher` instead of per-item `markProcessed` + `saveState` calls.

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Performance Oracle CRITICAL-1 |
| 2026-02-27 | Implemented StateBatcher with checkpoint flush | Reduced ~3,000 fs ops to ~20 for 1,000 items |
