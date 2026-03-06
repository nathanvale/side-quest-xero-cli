---
status: complete
priority: p1
issue_id: "124"
tags: [state, lock, concurrency, signals]
dependencies: []
---

# SIGTERM does not release lock file

## Problem Statement

`releaseLock()` is only called from the `finally` block in `runReconcile`. SIGTERM (the default for `kill <pid>`, container shutdown, systemd `TimeoutStopSec`) causes the process to exit without running `finally` blocks. The lock file remains on disk permanently until the stale-PID check clears it.

Also: `isProcessAlive` returns `false` for EPERM (process exists but owned by another user), meaning multi-user scenarios can silently steal locks.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 4 TODO-501, TODO-502.

- SIGINT is handled via `process.once('SIGINT', handleSigint)` at reconcile.ts:668 -- sets `interrupted = true` but lock only released in `finally` after loop completes
- No SIGTERM handler exists
- `src/util/process.ts:8-15`: EPERM mapped to `false` (dead) instead of `true` (alive)

## Proposed Solutions

1. Add `process.once('SIGTERM', handleSigint)` alongside SIGINT handler
2. Fix `isProcessAlive` to return `true` for EPERM (process exists, no permission)

## Recommended Action

Both fixes are small and independent. Apply together.

## Acceptance Criteria

- [ ] SIGTERM handler added alongside SIGINT in `runReconcile`
- [ ] `isProcessAlive` distinguishes ESRCH (dead) from EPERM (alive, no permission)
- [ ] EPERM returns `true` to prevent lock stealing
- [ ] Lock file cleaned up on both SIGINT and SIGTERM

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 4 TODO-501 and TODO-502
- Verified TODO-116 (complete) fixed CWD-relative lock paths and stale-lock cleanup, but not SIGTERM or EPERM
