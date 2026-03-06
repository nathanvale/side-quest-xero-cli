---
status: complete
priority: p2
issue_id: "143"
tags: [errors, config, lock, validation]
dependencies: []
---

# lock.ts and config.ts JSON.parse unguarded -- SyntaxError escapes

## Problem Statement

`readLock` (lock.ts:40) and `loadXeroConfig` (config.ts:62) call `JSON.parse` without catching `SyntaxError`. Corrupt files produce unstructured errors. The keychain path was fixed in round 2 (via `parseJsonSafely`), but these two paths were missed.

Also: `XeroAuthError` branch in `handleCommandErrorWithContext` always returns `EXIT_UNAUTHORIZED` regardless of error code -- should use `deriveExitCodeHint`.

Also: `revokeToken` uses `E_UNAUTHORIZED` for 5xx responses.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 2, 5, 6 (TODO-304, TODO-305, TODO-306, TODO-307, TODO-600, TODO-705).

## Proposed Solutions

1. Wrap `JSON.parse` in `readLock` -- treat SyntaxError as corrupt lock (return null, log warning)
2. Wrap `JSON.parse` in `loadXeroConfig` -- throw `XeroAuthError` with `E_UNAUTHORIZED/RUN_AUTH`
3. `handleCommandErrorWithContext`: use `deriveExitCodeHint(err.code)` for `XeroAuthError`
4. `revokeToken`: throw `XeroApiError/E_SERVER_ERROR` for 5xx

## Acceptance Criteria

- [x] Corrupt lock file treated as stale (warning logged, overwritten)
- [x] Corrupt config file produces `E_UNAUTHORIZED` with `RUN_AUTH` hint
- [x] `XeroAuthError` exit codes derived from `deriveExitCodeHint`
- [x] `revokeToken` 5xx uses `E_SERVER_ERROR`

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated across Agents 2, 5, 6

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Hardened `readLock()` JSON parse to treat corrupt payloads as stale with warning
- Updated `handleCommandErrorWithContext` to derive exit code from `XeroAuthError.code`
- Updated token revoke handling to classify 5xx as `E_SERVER_ERROR`
