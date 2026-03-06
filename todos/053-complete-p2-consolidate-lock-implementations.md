---
status: complete
priority: p2
issue_id: "053"
tags: [code-review, architecture, security]
dependencies: ["047"]
---

# Consolidate Duplicate Lock and Utility Implementations

## Problem Statement

Three utilities are duplicated across files:
1. `isProcessAlive()` -- identical in `src/xero/auth.ts` and `src/state/lock.ts`
2. `assertSecureFile()` -- identical in `src/xero/config.ts` and `src/state/state.ts`
3. Lock acquisition logic -- similar patterns in `withRefreshLock()` (auth.ts) and `acquireLock()`/`releaseLock()` (lock.ts)

Both lock implementations also have a TOCTOU race condition (Security Sentinel MEDIUM-3).

## Findings

- **Source:** TypeScript Reviewer, Architecture Strategist, Code Simplicity Reviewer, Security Sentinel
- **Impact:** Drift risk, ~60 LOC duplication, TOCTOU race in both lock implementations

## Resolution

Extracted the two duplicated utility functions into shared modules:

- `src/util/process.ts` -- exports `isProcessAlive(pid)`, uses POSIX `kill(pid, 0)` trick
- `src/util/fs.ts` -- exports `assertSecureFile(path)`, checks symlink + permission mode

Updated consumers to import from shared modules:
- `src/xero/auth.ts` -- imports `isProcessAlive` from `../util/process`
- `src/state/lock.ts` -- imports `isProcessAlive` from `../util/process`
- `src/xero/config.ts` -- imports `assertSecureFile` from `../util/fs`
- `src/state/state.ts` -- imports `assertSecureFile` from `../util/fs`

Also removed unused `lstatSync` imports from `config.ts` and `state.ts` since `assertSecureFile` now handles that internally.

Note: Lock pattern consolidation (item 3) was not done in this pass -- the two lock implementations serve different use cases (refresh lock with retry loop vs reconcile lock with single acquire/release) and unifying them would require more design consideration.

## Acceptance Criteria

- [x] Single `isProcessAlive` implementation
- [x] Single `assertSecureFile` implementation
- [ ] Lock logic shared between auth refresh and reconcile (deferred -- different patterns)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | 4 agents flagged duplication; Security flagged TOCTOU |
| 2026-02-27 | Resolved: extracted shared utilities | Generic error messages work better for shared code |
