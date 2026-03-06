---
status: complete
priority: p1
issue_id: "072"
tags: [lock, concurrency, race-condition]
dependencies: []
---

# 072: Keep active reconcile lock from expiring after 30 seconds

## Problem Statement

The lock acquisition logic in `src/state/lock.ts` deleted an existing lock whenever it was older than `LOCK_TIMEOUT_MS` (30s), even if the owning PID was still alive. Any reconcile run lasting longer than 30 seconds could have its lock stolen by a second process, creating race conditions against shared state/audit files.

## Findings

The condition `age < LOCK_TIMEOUT_MS && isProcessAlive(existing.pid)` used AND logic, meaning either condition failing would allow lock deletion. A long-running but healthy process would lose its lock purely due to age.

## Recommended Action

Remove the age-based timeout entirely. Only delete a stale lock when the owning PID is no longer running. The `LOCK_TIMEOUT_MS` constant was removed as dead code.

## Acceptance Criteria

- [x] Lock held by a live PID is never deleted regardless of age
- [x] Lock held by a dead PID is always cleaned up
- [x] Build and typecheck pass

## Work Log

### 2026-02-27 - Fix applied

**By:** Claude Code

**Actions:**
- Removed `age < LOCK_TIMEOUT_MS` from guard condition in `acquireLock()` (`src/state/lock.ts:35`)
- Removed unused `LOCK_TIMEOUT_MS` constant
- Verified build and typecheck pass
