---
status: complete
priority: p2
issue_id: "132"
tags: [auth, errors, exit-codes]
dependencies: []
---

# authFetch network errors use XeroAuthError -- wrong exit code

## Problem Statement

`authFetch` throws `XeroAuthError` with `E_NETWORK` for timeouts. `handleCommandErrorWithContext` checks `instanceof XeroAuthError` first and returns `EXIT_UNAUTHORIZED` (4) unconditionally. So a network timeout during auth exits with code 4 (UNAUTHORIZED) when the hint says `CHECK_NETWORK` and exit should be 1 (RUNTIME).

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 2 TODO-315. Also Agent 2 TODO-317.

- `src/xero/auth.ts:325`: `new XeroAuthError('Auth request timed out', { code: 'E_NETWORK' })`
- `src/cli/output.ts`: `instanceof XeroAuthError` -> `EXIT_UNAUTHORIZED` regardless of code
- `revokeToken` (auth.ts:648): uses `E_UNAUTHORIZED` for all failures including 5xx

## Proposed Solutions

1. `authFetch` should throw `XeroApiError` (not `XeroAuthError`) for network/timeout failures
2. `revokeToken` should throw `XeroApiError` with `E_SERVER_ERROR` for 5xx responses
3. Or: `handleCommandErrorWithContext` should consult `deriveExitCodeHint` for `XeroAuthError` too

## Acceptance Criteria

- [ ] Network timeouts during auth exit with code 1 (RUNTIME), not 4 (UNAUTHORIZED)
- [ ] `revokeToken` 5xx exits appropriately
- [ ] `deriveExitCodeHint` consulted for all error types

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 2 TODO-315 and TODO-317
