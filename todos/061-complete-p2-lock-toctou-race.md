---
status: complete
priority: p2
issue_id: "061"
tags: [safety, state, concurrency]
dependencies: ["032"]
---

# TOCTOU race in acquireLock writeFile

## Problem Statement

In `src/state/lock.ts`, there is a time-of-check-to-time-of-use (TOCTOU) race between `readLock()`/`unlink()` and the subsequent `writeFile()` call. A concurrent process can create the lock file in that window. While `writeFile` already uses the `wx` flag (O_CREAT | O_EXCL) for atomic create-or-fail, the resulting EEXIST error surfaces as a raw Node.js filesystem error rather than the user-friendly "Another reconcile run is in progress" message.

## Findings

- The `wx` flag was already in place from todo 032, so the race does not cause data corruption -- it only produces a confusing error message.
- The fix is to catch the EEXIST error from `writeFile` and re-throw with the standard user-facing message.

**Source:** Code review finding

## Proposed Solutions

### Option 1: Wrap writeFile in try/catch for EEXIST (implemented)

**Approach:** Catch errors from the `writeFile` call. If `error.code === 'EEXIST'`, throw `new Error('Another reconcile run is in progress')`. Re-throw all other errors unchanged.

**Effort:** 5 minutes | **Risk:** Low

## Acceptance Criteria

- [x] EEXIST from concurrent lock creation produces "Another reconcile run is in progress" message
- [x] Non-EEXIST errors are re-thrown unchanged
- [x] Existing lock acquisition logic is preserved

## Work Log

### 2026-02-27 - Implemented

**By:** Claude Code
**Actions:** Wrapped `writeFile` in try/catch in `src/state/lock.ts`. EEXIST errors now produce the user-friendly message. All other errors propagate unchanged.
