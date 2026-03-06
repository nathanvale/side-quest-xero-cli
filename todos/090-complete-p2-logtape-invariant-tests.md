---
status: complete
priority: p2
issue_id: "090"
tags: [agent-native, observability, logtape, testing]
dependencies: []
---

# Add LogTape invariant tests and shutdownLogging tests

## Problem Statement

The plan specifies two categories of tests that don't exist:

1. **Log invariant tests** (`tests/cli/output-invariants.test.ts`) -- proving stdout/stderr separation holds under all flag combinations
2. **shutdownLogging() unit tests** -- verifying idempotent behavior, timeout guard, and DI parameter

Without these tests, regressions in the output contract go undetected.

## Findings

- `tests/cli/output-invariants.test.ts` does not exist
- No test file covers `shutdownLogging()` behavior
- Plan specifies (lines 2216-2231):
  - Log invariant tests: stdout has no log messages, --quiet stderr is clean, no envelope fragments in stderr
  - shutdownLogging tests: pre-setup no-op, post-failure no-op, double-call no-op, timeout guard via DI
- Plan specifies testing pattern (lines 2184-2211): buffer sink with `configure({ reset: true })` in beforeEach

**Source:** LogTape observability gap analysis

## Proposed Solutions

### Option 1: Create both test files per plan spec

**Approach:**
1. Create `tests/cli/output-invariants.test.ts` with:
   - `stdout contains only program output (no log messages)` for --json, --debug, --quiet modes
   - `stderr contains no JSON envelope fragments` for all modes
   - `--quiet stderr is empty on success`
   - Use `Bun.spawnSync` with `XERO_LOG_FORMAT=text` for determinism

2. Create `tests/logging.test.ts` with:
   - `shutdownLogging()` before `setupLogging()` -- no-op
   - `shutdownLogging()` twice -- second is no-op
   - Inject slow `disposeFn` (>500ms) -- verify returns within 600ms
   - Use `disposeFn` DI parameter, no monkeypatching

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `tests/cli/output-invariants.test.ts` exists with stdout/stderr separation tests
- [ ] `tests/logging.test.ts` exists with shutdownLogging behavior tests
- [ ] All tests pass with `bun test`
- [ ] Tests use `XERO_LOG_FORMAT=text` for non-TTY determinism

## Work Log

### 2026-02-27 - Filed from LogTape gap analysis

**By:** Claude Code

**Actions:**
- Confirmed neither test file exists
- Cross-referenced plan test specifications (lines 2184-2231)

### 2026-02-27 - Implemented both test files

**By:** Claude Code

**Actions:**
- Created `tests/cli/output-invariants.test.ts` with 4 tests:
  - stdout contains only JSON envelope in --json mode (no log messages)
  - stderr contains no JSON envelope fragments
  - --quiet stderr is empty on success
  - stdout is empty when --json error is written to stderr
- Created `tests/logging.test.ts` with 3 tests:
  - shutdownLogging() before setupLogging() is a no-op
  - shutdownLogging() called twice -- second is no-op
  - shutdownLogging() completes within reasonable time with timeout guard
- All 7 tests pass across both files
- Tests follow existing project conventions (bun:test, captureOutput pattern, LogTape reset)
