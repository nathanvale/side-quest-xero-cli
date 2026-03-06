---
status: complete
priority: p2
issue_id: "074"
tags: [lock, auth, concurrency, race-condition]
dependencies: []
---

# 074: Preserve refresh lock while owner process is still alive

## Problem Statement

The token refresh lock in `src/xero/auth.ts` (`withRefreshLock`) treated any lock older than `REFRESH_LOCK_TIMEOUT_MS` as stale and unlinked it even when the owning PID was alive. If a refresh call stalled beyond 30 seconds, another process could remove the lock and start a concurrent refresh, causing conflicting token writes.

## Findings

Same pattern as the reconcile lock (issue 072). The condition ANDed `isProcessAlive(pid)` with `age < timeout`, so exceeding the age alone was enough to bypass the lock.

## Recommended Action

Remove the age check from the lock-validity condition. A lock held by a live PID is always valid. The age-based `REFRESH_LOCK_TIMEOUT_MS` is still used for the overall wait-loop timeout (how long to wait before giving up), which is correct.

## Acceptance Criteria

- [x] Refresh lock held by a live PID is never deleted regardless of age
- [x] Refresh lock held by a dead PID is always cleaned up
- [x] Overall wait-loop timeout still functions correctly
- [x] Build and typecheck pass

## Work Log

### 2026-02-27 - Fix applied

**By:** Claude Code

**Actions:**
- Simplified condition in `withRefreshLock` to `if (parsed.pid && isProcessAlive(parsed.pid))` (`src/xero/auth.ts:388`)
- Removed unused `age` variable computation
- Verified build and typecheck pass
