# TODO-060: Move Test Config Cleanup into afterEach Hook

**Status:** complete
**Priority:** P3
**Category:** test-reliability

## Problem

In `tests/xero/history.test.ts`, the temporary `.xero-config.json` file was
cleaned up manually within the test body (line 86). If the test fails before
reaching that cleanup line, the file persists on disk and can leak state into
subsequent test runs.

## Fix

- Made the existing `afterEach` hook `async` and added
  `await unlink('.xero-config.json').catch(() => undefined)` to it.
- Removed the manual `unlink` call from the end of the "groups transactions"
  test body.
- The `.catch(() => undefined)` swallows ENOENT so the hook is safe for tests
  that never create the file.

## Files Changed

- `tests/xero/history.test.ts`
