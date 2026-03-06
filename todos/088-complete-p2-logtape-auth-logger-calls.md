---
status: complete
priority: p2
issue_id: "088"
tags: [agent-native, observability, logtape, auth]
dependencies: []
---

# Add LogTape logger calls to auth.ts

## Problem Statement

`src/xero/auth.ts` has no LogTape logger. The OAuth2 PKCE flow, token refresh, and Keychain operations produce zero diagnostic output. When auth fails, agents and humans have no structured trace of what happened -- only the final error message. There is also a stray `console.warn` at line 134 that should be migrated to LogTape.

## Findings

- `src/xero/auth.ts` -- no `getXeroLogger` import, no logger instance
- `src/xero/auth.ts:134` -- stray `console.warn` (should be `logger.warn`)
- Plan category: `xero.auth` -- OAuth2 PKCE, token refresh, Keychain read/write
- Key points needing logging:
  - PKCE flow start (code verifier generated, authorize URL built)
  - Callback received (code exchange started)
  - Token refresh (lock acquired, refresh attempted, success/failure)
  - Keychain read/write (success, not-found, access-denied, locked)
  - Headless mode detection

**Source:** LogTape observability gap analysis

## Proposed Solutions

### Option 1: Add xero.auth logger per plan spec

**Approach:** Create `const authLogger = getXeroLogger(['auth'])` and add calls at key auth flow points:
- `debug` on PKCE flow start
- `debug` on callback received
- `info` on token refresh (lock acquired)
- `warn` on token refresh failure
- `debug` on Keychain read/write
- Replace `console.warn` at line 134 with `authLogger.warn()`

**Effort:** 30 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `xero.auth` logger created and used
- [ ] `console.warn` at auth.ts:134 replaced with logger.warn
- [ ] No `console.log/warn/error` calls remain in auth.ts
- [ ] Token values never logged (only `"token=present"` / `"token=missing"`)
- [ ] Auth flow traceable via `--debug`

## Work Log

### 2026-02-27 - Filed from LogTape gap analysis

**By:** Claude Code

**Actions:**
- Confirmed no logger in auth.ts
- Found stray console.warn at line 134

### 2026-02-27 - Implemented LogTape logger

**By:** Claude Code

**Actions:**
- Imported `getXeroLogger` and created `authLogger = getXeroLogger(['auth'])`
- Added `debug` on PKCE flow start (with scope)
- Added `debug` on callback received and token exchange
- Added `debug` on Keychain read/write/delete operations
- Added `debug` on Keychain read result (`token=present` / `token=missing`)
- Added `info` on token refresh lock acquired
- Added `warn` on token refresh failure (with error message, no token values)
- Added `warn` on token save failure after successful refresh
- Added `debug` on successful token refresh and save
- Added `debug` when another process already refreshed the token
- Replaced `console.warn` at line 134 with `authLogger.warn()`
- Verified zero `console.log/warn/error` calls remain
- Verified no token values are ever logged
- TypeScript type check passes
