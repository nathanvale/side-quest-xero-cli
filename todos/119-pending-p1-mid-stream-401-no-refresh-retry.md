---
status: complete
priority: p1
issue_id: "119"
tags: [auth, api, resilience, agent-contract]
dependencies: []
---

# Mid-stream 401 causes permanent failure -- no refresh-and-retry path

## Problem Statement

`xeroFetch` throws `XeroAuthError` immediately on HTTP 401 with `recoverable: false`. There is no "refresh token and retry once" path. A token revoked server-side or rejected due to clock skew between the expiry check and the API call produces an unrecoverable failure when a single refresh would succeed.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 5 TODO-602.

- `src/xero/api.ts:106-326`: `mapHttpError(401, ...)` throws immediately
- Token expiry is checked before the call in `loadValidTokens`, but a 401 can still arrive if:
  - Token revoked server-side between check and call
  - Clock skew causes local-valid but server-rejected token
- Long-running reconcile batches are particularly vulnerable -- token may expire mid-batch

## Proposed Solutions

### Option A: Refresh callback in XeroFetchOptions (recommended)
Accept an optional `refreshTokens` callback. On first 401, call it, then retry the request once. If the retry also 401s, throw as permanent failure.

### Option B: Middleware wrapper
Wrap `xeroFetch` in a `withAutoRefresh(xeroFetch, refreshFn)` higher-order function that handles 401 retry transparently.

## Recommended Action

Option A. Minimal change to existing API surface.

## Acceptance Criteria

- [ ] `XeroFetchOptions` accepts optional `onUnauthorized: () => Promise<void>` callback
- [ ] On 401, `xeroFetch` calls callback and retries once before throwing
- [ ] Second 401 after refresh throws `E_UNAUTHORIZED` with `recoverable: false`
- [ ] Reconcile command wires `loadValidTokens` refresh into the callback
- [ ] No double-refresh: concurrent 401s from parallel requests share a single refresh

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Filed from Agent 5 TODO-602
- Verified no existing todo covers mid-stream 401 refresh (TODO-111 covered classification, not retry)
