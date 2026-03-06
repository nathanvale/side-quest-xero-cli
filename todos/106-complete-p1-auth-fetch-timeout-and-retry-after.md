---
status: complete
priority: p1
issue_id: "106"
tags: [auth, api, resilience, timeout, rate-limit]
dependencies: []
---

# Auth fetch timeout and Retry-After not threaded to envelope

## Problem Statement

Two critical API resilience gaps: (1) auth layer `fetch` calls have no timeout, allowing indefinite hangs, and (2) `Retry-After` header values are lost when 429 retries exhaust, causing agents to use a stale 30s fallback instead of the server-specified delay.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 6.

- **H7: No timeout on auth `fetch`** - `src/xero/auth.ts:314,353,374,536` (`exchangeToken`, `fetchConnections`, `refreshToken`, `revokeToken`) all call `fetch()` without `AbortSignal.timeout()`. If the Xero identity server hangs, the CLI hangs indefinitely. The 5-minute `AUTH_TIMEOUT_MS` only covers the OAuth callback server, not network calls.
- **H6: `Retry-After` not threaded** - `src/xero/api.ts:226` falls through to `mapHttpError()` when retries exhaust on 429, but `retryAfterMs` is not passed to the error context. The envelope falls back to the static `recommendedDelayMs: 30_000` from `ERROR_CODE_ACTIONS`, which may be far shorter than what Xero specified.
- **M1: `mapHttpError` interface lacks `context` param** - `src/xero/api.ts:61-99` takes only `(status, message)`, making it impossible to forward header-derived values.

## Proposed Solutions

### Option 1: Direct fixes at all call sites

**Approach:**
1. Add `signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)` to all 4 auth `fetch` calls
2. Catch `AbortError` and throw `XeroAuthError` with `code: 'E_NETWORK'`
3. Add `context?` parameter to `mapHttpError` and forward `retryAfterMs`
4. Thread `retryAfterMs` at the 429 exhaustion throw site in `api.ts:226`
5. Raise static fallback `recommendedDelayMs` from 30s to 60s

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Option 1. All changes are additive -- existing behavior is preserved for non-timeout/non-429 paths.

## Technical Details

**Affected files:**
- `src/xero/auth.ts:314,353,374,536` - 4 fetch calls need timeout
- `src/xero/api.ts:61-99` - `mapHttpError` interface change
- `src/xero/api.ts:226` - thread retryAfterMs
- `src/cli/output.ts:198` - raise fallback to 60_000

## Acceptance Criteria

- [ ] All auth `fetch` calls use `AbortSignal.timeout(30_000)` or configurable constant
- [ ] `AbortError` in auth produces `XeroAuthError` with `code: 'E_NETWORK'`
- [ ] `mapHttpError` accepts optional `context` param
- [ ] 429 exhaustion error envelope contains `retryAfterMs` from the actual header
- [ ] Static fallback `recommendedDelayMs` for `E_RATE_LIMITED` raised to 60_000
- [ ] Add test: auth `fetch` timeout produces structured `E_NETWORK` error
- [ ] Add test: 429 exhaustion envelope carries `retryAfterMs` from `Retry-After` header

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 6 identified both issues as HIGH severity
- Confirmed `xeroFetch` in `api.ts` already has timeout via `AbortController`, but auth layer bypasses `xeroFetch` entirely
- Xero docs specify 60 requests/minute per org with `Retry-After` headers on 429

**Learnings:**
- The auth layer was likely written before the API resilience patterns were established
- `DEFAULT_TIMEOUT_MS = 30_000` is already defined in `api.ts` and should be reused
