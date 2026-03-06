---
status: complete
priority: p1
issue_id: "120"
tags: [api, resilience, rate-limiting]
dependencies: []
---

# Retry-After header unbounded + 5xx backoff is linear without jitter

## Problem Statement

Two related resilience gaps in `xeroFetch` retry logic:

1. The `Retry-After` header value has no upper cap -- a server returning `Retry-After: 86400` causes a 24-hour sleep that silently stalls the agent.
2. Server error (5xx) backoff is linear (`1000 * attempt`: 1s, 2s, 3s) with no jitter. Concurrent CLI instances retry in lockstep, creating thundering herd effects.

TODO-106 (complete) added auth fetch timeouts and basic retry-after handling, but did not cap the value or add exponential backoff with jitter.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 5 TODO-600, TODO-601. Also Agent 6 TODO-717.

- `src/xero/api.ts:182-183`: `retryAfter * 1000` with no cap
- `src/xero/api.ts:183`: linear `1000 * attempt` for 5xx
- `retry-after` header parsed with `Number()` -- HTTP-date format (e.g., `"Thu, 06 Mar 2026 15:00:00 GMT"`) returns NaN, silently falls back to linear

## Proposed Solutions

### Option A: Cap + exponential + jitter (recommended)
1. Cap `Retry-After` at `MAX_RETRY_AFTER_MS` (60 seconds)
2. Replace linear backoff with `Math.min(2**attempt * BASE_MS + jitter, MAX_BACKOFF_MS)`
3. Add `Number.isFinite()` guard for retry-after parsing

## Recommended Action

Option A. Single function change in `xeroFetch`.

## Acceptance Criteria

- [ ] `Retry-After` capped at 60 seconds
- [ ] 5xx backoff is exponential with random jitter
- [ ] `Number.isFinite()` guard on parsed retry-after value
- [ ] Non-numeric retry-after (HTTP-date format) handled gracefully
- [ ] Constants exported for testing: `MAX_RETRY_AFTER_MS`, `BASE_BACKOFF_MS`, `MAX_BACKOFF_MS`

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 5 TODO-600, TODO-601 and Agent 6 TODO-717
- Verified TODO-106 (complete) added timeouts but not caps/jitter
