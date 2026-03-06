---
status: complete
priority: p2
issue_id: "051"
tags: [code-review, quality]
dependencies: ["047"]
---

# Extract CLI Parser Flag Helper (~100 LOC Savings)

## Problem Statement

The CLI parser repeats ~14 lines of boilerplate for each value-taking flag (`--flag value` / `--flag=value` dual pattern). There are 12 such flags, producing ~210 lines of near-identical code.

## Findings

- **Source:** TypeScript Reviewer, Code Simplicity Reviewer
- **File:** `src/cli/command.ts` (lines 155-405)

## Solution Implemented

Extracted a `parseValueFlag` helper function that handles both `--flag value` and `--flag=value` forms in a single call. Returns a discriminated union:
- `null` when the token does not match the flag name
- `{ value, nextIndex }` on successful parse
- `ParseCliError` when the value is missing

All 12 value-taking flags are now declared in a data-driven array and parsed via a single loop, replacing ~210 lines of repetitive if-blocks with ~35 lines of helper code plus a ~15-line dispatch loop.

Net reduction: ~74 lines (787 -> 713).

## Acceptance Criteria

- [x] All existing CLI tests pass (9/9)
- [x] Adding a new value flag requires <5 lines of code (just one entry in valueFlagDefs array)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | TypeScript Reviewer + Simplicity Reviewer |
| 2026-02-27 | Implemented parseValueFlag helper | Data-driven flag table + discriminated union return type |
