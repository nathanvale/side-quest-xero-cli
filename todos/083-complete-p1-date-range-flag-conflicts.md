---
status: complete
priority: p1
issue_id: "083"
tags: [agent-native, cli, parser, dx]
dependencies: []
---

# Date range flag conflicts pass parser silently

## Problem Statement

The CLI parser rejects `--this-quarter --last-quarter` but silently accepts conflicting combinations like `--this-quarter --since 2025-01-01`. The precedence is undocumented and implementation-dependent, meaning agents can construct contradictory queries that produce unpredictable results.

## Findings

- `src/cli/command.ts:386-392` -- rejects `--this-quarter` + `--last-quarter`
- Does NOT reject: `--this-quarter --since`, `--last-quarter --until`, or triple conflicts
- The `TransactionsCommand` type has all four fields as independent values
- Agents building queries programmatically can easily hit this

**Source:** DX Pass 1 (Critical issue #2)

## Proposed Solutions

### Option 1: Reject at parse time

**Approach:** If `thisQuarter` or `lastQuarter` is set and `since` or `until` is also set, return a usage error: `"--this-quarter/--last-quarter cannot be combined with --since/--until"`.

**Effort:** 15 minutes

**Risk:** None (new validation, no behavior change for valid inputs)

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `--this-quarter --since X` produces usage error
- [ ] `--last-quarter --until X` produces usage error
- [ ] Triple combinations rejected
- [ ] Valid single-flag usage unchanged
- [ ] Test covers conflict rejection

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from DX Pass 1 (Critical issue #2)
- Confirmed parser only checks quarter-vs-quarter, not quarter-vs-explicit-date

### 2026-02-27 - Implemented fix

**By:** Claude Code

**Actions:**
- Added validation in `src/cli/command.ts` after the existing quarter-vs-quarter check (line 393) that rejects `--this-quarter`/`--last-quarter` combined with `--since`/`--until`
- Error message: "--this-quarter/--last-quarter cannot be combined with --since/--until"
- Added 5 tests in `tests/cli/command.test.ts` covering: this-quarter+since, last-quarter+until, triple combination, valid single quarter flag, valid since+until without quarter flags
- All 14 tests pass
