---
status: complete
priority: p2
issue_id: "113"
tags: [events, observability, conventions]
dependencies: ["107"]
---

# Event completeness gaps and naming conventions

## Problem Statement

Several events are missing fields needed for correlation, some events are duplicated, dry-run items emit no events, and the naming convention is inconsistent.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agents 3, 4, 5.

**Missing fields:**
- `xero-fetch-completed` (`api.ts:241`) - missing `durationMs` (computed at line 230 but not included)
- `xero-fetch-error` (`api.ts:253,281,290`) - missing `url` on abort/timeout/network paths, breaking start-to-error correlation
- `xero-state-checkpoint` (`reconcile.ts:842`) - missing `checkpointId` (computed but excluded)
- `xero-auth-completed` (`auth.ts:119`) - missing `scope` (present in `xero-auth-started`)

**Duplication:**
- 429 fires both `xero-rate-limited` and `xero-fetch-retry` with overlapping payloads (`api.ts:191,216`)

**Missing events:**
- No dry-run item events (`reconcile.ts:901-920`) - agents can't verify plan via events channel
- No `xero-cli-usage-error` on parse failure (`command.ts:684-705`)
- No `xero-auth-refresh-started` (only completed/failed exist)

**Naming:**
- `xero-rate-limited` breaks `xero-<noun>-<verb>` pattern (should be `xero-fetch-rate-limited`)

**Anti-pattern:**
- `eventsConfig ?? { url: null }` repeated 9 times in `api.ts` -- should normalize at options boundary

**Schema:**
- No `schemaVersion` in event envelope (`events.ts:63-93`)
- No retry delay between `emitEvent` attempts (`events.ts:78-92`)
- `emitEvent` doesn't check HTTP response status (`events.ts:86`) -- 500 treated as success

## Proposed Solutions

### Option 1: Incremental fixes

**Approach:** Fix each gap individually. Batch the field additions, rename `xero-rate-limited`, add dry-run event, normalize eventsConfig.

**Effort:** 2 hours

**Risk:** Low

## Acceptance Criteria

- [ ] `xero-fetch-completed` includes `durationMs`
- [ ] `xero-fetch-error` includes `url` on all paths
- [ ] `xero-state-checkpoint` includes `checkpointId`
- [ ] 429 emits single consolidated event (not duplicate)
- [ ] Dry-run items emit `xero-reconcile-item-skipped` with `reason: 'dry-run'`
- [ ] Event envelope includes `schemaVersion`
- [ ] `emitEvent` checks `response.ok` and retries on failure
- [ ] `emitEvent` has inter-attempt delay (200ms minimum)
- [ ] `eventsConfig` normalized at options boundary, not per-call-site

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 4 catalogued all 22 events and found field gaps across 8 of them
- Agent 3 identified `emitEvent` doesn't check HTTP status (M6) and has no retry delay
- Agent 5 identified missing schema versioning
