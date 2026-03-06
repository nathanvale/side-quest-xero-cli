---
status: complete
priority: p3
issue_id: "063"
tags: [validation, cli, dates]
dependencies: []
---

# parseDateParts doesn't validate calendar ranges

## Problem Statement

`parseDateParts` in `src/cli/commands/transactions.ts` splits a date string and converts to integers but doesn't verify they form a valid calendar date. Invalid inputs like `2026-13-45` pass through and produce nonsensical OData DateTime literals that the Xero API would reject or misinterpret.

## Resolution

Added calendar range validation to `parseDateParts`:

1. Month must be 1-12 (explicit range check)
2. Day must be valid for the given month/year (round-trip through `Date.UTC` and verify components match -- catches Feb 30, Feb 29 on non-leap years, day 32, etc.)
3. Throws `Error('Invalid date: ...')` with a descriptive message on invalid input

Exported the function so it can be directly unit-tested.

## Files Changed

- `src/cli/commands/transactions.ts` - Added validation logic to `parseDateParts`, exported function
- `tests/cli/transactions.test.ts` - Added 10 unit tests covering valid dates, leap years, and all invalid-date error paths

## Work Log

### 2026-02-27 - Implemented

**By:** Claude Code
**Actions:** Added month range check (1-12), Date.UTC round-trip validation for day validity, descriptive error messages. Added comprehensive test suite (10 tests, all passing).
