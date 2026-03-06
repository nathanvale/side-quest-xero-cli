---
status: complete
priority: p2
issue_id: "111"
tags: [auth, errors, agent-hints]
dependencies: []
---

# Auth error classification gaps

## Problem Statement

Multiple auth code paths use generic or wrong error codes, giving agents misleading recovery hints. Token refresh failures, connection fetch errors, and revocation failures all need proper classification.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agents 2, 6.

- **M2 (Agent 6): `refreshToken` doesn't classify by HTTP status** - `auth.ts:385` always throws `E_UNAUTHORIZED`. A `400 invalid_grant` (correct: `RUN_AUTH`) and `503` (correct: `RETRY_WITH_BACKOFF`) produce identical envelopes.
- **M6 (Agent 2): `fetchConnections` mapped to `E_API_ERROR`** - `auth.ts:362-364` uses `E_API_ERROR` not `E_UNAUTHORIZED` for 401/403 during connections fetch. Agent gets `RETRY_WITH_BACKOFF` instead of `RUN_AUTH`.
- **M7 (Agent 2): `revokeToken` failure maps to `E_UNAUTHORIZED / RUN_AUTH`** - `auth.ts:547-550` causes agents to loop on re-auth when revocation fails. Should be best-effort or `E_RUNTIME`.
- **M5 (Agent 2): `waitForAuthCode` bare throws** - `auth.ts:485,507` throws `XeroAuthError` without `code` option for state mismatch and timeout. Both default to `E_UNAUTHORIZED / RUN_AUTH` which creates retry loops.
- **L2 (Agent 3): `auth.ts:661` loses error context** - Token refresh save failure logs `warn` without the error object.

## Proposed Solutions

### Option 1: Classify each throw site

**Approach:**
1. `refreshToken` - branch on HTTP status: 400 -> `E_UNAUTHORIZED`, 5xx -> `E_SERVER_ERROR`, network -> `E_NETWORK`
2. `fetchConnections` - apply same branching as `mapHttpError` for 401/403
3. `revokeToken` - swallow errors as best-effort (standard OAuth pattern) or remap to `E_RUNTIME`
4. `waitForAuthCode` state mismatch -> `E_USAGE`, timeout -> `E_UNAUTHORIZED` with `nextCommand` suggesting `--auth-timeout`
5. Save failure warn -> include error message in structured log properties

**Effort:** 1 hour

**Risk:** Low

## Acceptance Criteria

- [ ] `refreshToken` classifies by HTTP status family
- [ ] `fetchConnections` uses proper 401/403 branching
- [ ] `revokeToken` is best-effort (doesn't abort auth flow)
- [ ] `waitForAuthCode` throws with explicit error codes
- [ ] Token save failure log includes error details
- [ ] Add test: `refreshToken` 503 produces `E_SERVER_ERROR`
- [ ] Add test: `fetchConnections` 401 produces `E_UNAUTHORIZED`

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agents 2 and 6 independently identified auth classification gaps
- 5 distinct throw sites need classification fixes
