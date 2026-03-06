---
status: complete
priority: p2
issue_id: "062"
tags: [code-review, bug, coderabbit]
dependencies: []
---

# parseCsvLine Fails on Quoted Fields with Commas

## Problem Statement

`parseCsvLine` in `src/cli/commands/reconcile.ts` naively splits on commas, which breaks for RFC-4180 quoted fields. A field like `"Smith, John"` would be split into two separate fields, corrupting the row parse.

## Findings

- CodeRabbit flagged lines 351-353 in `src/cli/commands/reconcile.ts`
- Current implementation: simple `.split(',')` or equivalent
- Fails for: quoted commas, escaped quotes (`""`), trailing fields
- In practice, Xero CSV exports may contain commas in contact names or descriptions
- Related to todo 050 (CSV path traversal) but this is a parsing correctness issue

## Proposed Solutions

### Option 1: Stateful inline parser

**Approach:** Replace naive split with a small stateful parser that tracks `inQuotes`, handles escaped double-quotes, and only splits on unquoted commas.

**Pros:**
- No new dependency
- Small, testable function

**Cons:**
- Need to handle edge cases carefully (RFC-4180)

**Effort:** 1 hour

**Risk:** Low

---

### Option 2: Use csv-parse library

**Approach:** Replace `parseCsvLine` with `csv-parse/sync` for robust RFC-4180 parsing.

**Pros:**
- Battle-tested, handles all edge cases
- Less code to maintain

**Cons:**
- New dependency for a single function
- Slightly heavier

**Effort:** 30 min

**Risk:** Low

## Recommended Action

Option 1 selected: stateful inline parser with no new dependencies.

## Technical Details

**Affected files:**
- `src/cli/commands/reconcile.ts:351-353` - parseCsvLine function

## Acceptance Criteria

- [x] Quoted fields with commas parse correctly
- [x] Escaped quotes (`""`) handled
- [x] Empty fields preserved
- [x] Existing non-quoted CSV input still works
- [x] Unit tests cover quoted commas, escaped quotes, empty fields

## Work Log

### 2026-02-27 - Initial Discovery

**By:** Claude Code (CodeRabbit review)

**Actions:**
- CodeRabbit flagged naive CSV splitting as potential_issue
- Confirmed parseCsvLine uses simple comma split

**Learnings:**
- Xero CSV exports can contain commas in contact/description fields
- RFC-4180 is the standard for quoted CSV fields

### 2026-02-27 - Fix Implemented

**By:** Claude Code

**Actions:**
- Replaced naive `line.split(',')` with RFC-4180-compliant stateful parser
- Parser tracks `inQuotes` state, handles escaped double-quotes (`""`), splits only on unquoted commas
- Exported `parseCsvLine` for testability
- Added 10 unit tests covering: plain fields, whitespace trimming, quoted commas, escaped quotes, empty fields, single field, empty input, quoted at end, multiple quoted, mixed quoted/unquoted
- All 10 new tests pass

**Learnings:**
- No new dependencies needed - small inline parser handles all required cases
