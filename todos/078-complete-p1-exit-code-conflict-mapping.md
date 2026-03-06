---
status: complete
priority: p1
issue_id: "078"
tags: [agent-native, output, exit-codes]
dependencies: []
---

# handleCommandError maps XeroConflictError to wrong exit code

## Problem Statement

`handleCommandError` in `src/cli/output.ts:172-175` maps `XeroConflictError` to `EXIT_RUNTIME` (code 1) instead of `EXIT_CONFLICT` (code 5). Agents rely on exit codes to distinguish error types and take different recovery actions. A conflict (e.g., already-reconciled transaction) looks identical to a runtime crash.

## Findings

- `src/cli/output.ts:172-175` -- the `instanceof XeroConflictError` branch returns `EXIT_RUNTIME`
- `EXIT_CONFLICT` (code 5) is defined but never used in the error handler
- Agents using exit codes to decide retry vs report get wrong signal
- One-line fix

**Source:** Architect Pass 1 (Critical issue #1)

## Proposed Solutions

### Option 1: Fix the mapping

**Approach:** Change the `XeroConflictError` branch to return `EXIT_CONFLICT`.

**Effort:** 5 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [x] `handleCommandError` returns `EXIT_CONFLICT` for `XeroConflictError`
- [x] All other error mappings unchanged
- [x] Test verifies the mapping

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from Architect Pass 1 (Critical issue #1)
- Confirmed EXIT_CONFLICT is defined but unused in error handler

### 2026-02-27 - Resolved

**By:** Claude Code

**Actions:**
- Changed `EXIT_RUNTIME` to `EXIT_CONFLICT` in the `XeroConflictError` branch of `handleCommandError` (`src/cli/output.ts:174`)
- Created `tests/cli/output.test.ts` with 5 tests covering all error-to-exit-code mappings
- All tests pass (5/5)
