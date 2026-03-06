---
status: complete
priority: p2
issue_id: "087"
tags: [agent-native, observability, logtape, api]
dependencies: []
---

# Add LogTape logger calls to api.ts

## Problem Statement

`apiLogger` is created in `src/xero/api.ts:23` (`getXeroLogger(['api'])`) but has zero `.debug()`, `.info()`, or `.warn()` calls. The `--debug` and `--verbose` flags produce no HTTP-level diagnostic output, making it impossible for agents or humans to see what API calls are happening, what status codes come back, or when retries fire.

## Findings

- `src/xero/api.ts:23` -- `const apiLogger = getXeroLogger(['api'])` exists but is never called
- Plan specifies category hierarchy: `xero.api`, `xero.api.transactions`, `xero.api.accounts`, etc.
- Plan specifies (line 2639): `--verbose` shows API calls, pagination progress
- Plan specifies (line 2640): `--debug` shows request/response, rate limit state
- Plan specifies (line 2651): Authorization headers redacted at debug level

**Source:** LogTape observability gap analysis

## Proposed Solutions

### Option 1: Add logger calls per plan spec

**Approach:** Add structured log calls at key points in `xeroFetch()` and `xeroPost()`:
- `debug` on request start (method, URL, timeout)
- `debug` on response received (status, duration)
- `info` on retry (reason, backoff, attempt number)
- `warn` on rate limit (429 status, retry-after)
- `debug` on request headers (with Authorization redacted to `"Bearer [REDACTED]"`)

**Effort:** 30 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `--debug` shows HTTP request/response details on stderr
- [ ] `--verbose` shows API call lifecycle (started, completed, retrying)
- [ ] Rate limit pauses logged at warn level
- [ ] Authorization header never appears in logs
- [ ] Structured properties used (not string interpolation)

## Work Log

### 2026-02-27 - Filed from LogTape gap analysis

**By:** Claude Code

**Actions:**
- Confirmed apiLogger exists but has zero calls
- Cross-referenced plan observability section (lines 1902-2242)

### 2026-02-27 - Implemented LogTape logger calls

**By:** Claude Code

**Actions:**
- Added `debug` log on request start with method, URL, timeout, and attempt number
- Added `debug` log for request headers with Authorization redacted to "Bearer [REDACTED]"
- Added `debug` log on response received (both OK and non-OK) with status and duration in ms
- Enhanced `warn` log on rate limit (429) with Retry-After value, backoff, and attempt number
- Enhanced `info` log on server error retry with attempt number
- Enhanced `info` log on timeout retry with attempt number
- All logs use LogTape structured property syntax (template literals, not string interpolation)
- All logs include `getLogContext()` for run-scoped correlation
- TypeScript type check passes, existing API tests pass (2/2)
