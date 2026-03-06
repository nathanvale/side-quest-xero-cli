---
status: complete
priority: p3
issue_id: "096"
tags: [agent-native, observability, events, api]
dependencies: []
---

# Emit dedicated xero-rate-limited event for Xero API 429s

## Problem Statement

The plan specifies `xero-rate-limited` as a dedicated event, but rate limits are currently folded into the generic `xero-fetch-retry` event. A dedicated rate limit event would enable:

- Rate limit frequency dashboards (how often does Nathan hit Xero's limits?)
- Rate limit timing patterns (which time of day? which operations trigger it?)
- Retry-After header tracking (is Xero's backoff increasing over time?)
- Alerting when rate limits spike (possible runaway agent loop)

## Current State

- `src/xero/api.ts:181` -- emits `xero-fetch-retry` with `{ reason: 'rate-limited', retryAfter, attempt }`
- The `reason: 'rate-limited'` field is there, but the observability server would need to filter `xero-fetch-retry` events by reason rather than having a clean dedicated event name

## Proposed Solution

Add a separate `emitEvent(config, 'xero-rate-limited', { ... })` call in the 429 handler branch (api.ts:155), alongside the existing `xero-fetch-retry` event. Include:

- `retryAfterMs` -- the actual backoff duration
- `url` -- which endpoint was rate-limited (helps identify hot paths)
- `attempt` -- which retry attempt triggered it

## Effort

5 minutes

## Risk

None

## Acceptance Criteria

- [ ] `xero-rate-limited` event emitted on 429 response
- [ ] Payload includes retryAfterMs, url path, attempt number
- [ ] Existing `xero-fetch-retry` event unchanged (backward compatible)

## Work Log

### 2026-02-27 - Filed from observability brainstorm

**By:** Claude Code

### 2026-02-27 - Implemented dedicated xero-rate-limited event

**By:** Claude Code

Added `emitEvent(config, 'xero-rate-limited', { url, retryAfterMs, attempt })` in the 429 handler branch of `src/xero/api.ts` (line 165). The new event is emitted alongside the existing `xero-fetch-retry` event, which remains unchanged for backward compatibility.
