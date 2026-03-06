---
status: complete
priority: p2
issue_id: "093"
tags: [agent-native, observability, events, auth]
dependencies: []
---

# Emit xero-auth-refreshed event on token refresh

## Problem Statement

The plan specifies `xero-auth-refreshed` as an event name, but no `emitEvent` call exists in the token refresh path. The observability server can see auth completions and failures, but has no visibility into silent token refreshes that happen behind the scenes during every command invocation.

Token refreshes are a leading indicator of auth health -- frequent refreshes may indicate short token lifetimes, while refresh failures precede full auth breakdowns. Without this event, the observability server is blind to the most common auth operation.

## Findings

- `src/xero/auth.ts:627` -- `authLogger.debug('Token refreshed and saved successfully.')` exists but no `emitEvent`
- `src/xero/auth.ts:613` -- `authLogger.warn('Token refresh failed ...')` exists but no `emitEvent`
- The auth module doesn't import `emitEvent` or have access to `eventsConfig`
- `eventsConfig` would need to be threaded through `loadValidTokens()` or accessed via a module-level config

## Proposed Solutions

### Option 1: Thread eventsConfig through loadValidTokens

**Approach:** Add optional `eventsConfig` parameter to `loadValidTokens()`. Emit `xero-auth-refreshed` on success and `xero-auth-refresh-failed` on failure. Callers already have `ctx.eventsConfig` available.

**Effort:** 15 minutes

**Risk:** Low (additive parameter, backward-compatible via optional)

### Option 2: Module-level events config

**Approach:** Set a module-level `eventsConfig` during CLI init (like the auth provider pattern). Avoids threading through function signatures.

**Effort:** 15 minutes

**Risk:** Low

## Acceptance Criteria

- [ ] `xero-auth-refreshed` event emitted after successful token refresh
- [ ] `xero-auth-refresh-failed` event emitted on refresh failure (before throwing)
- [ ] Token values never included in event payload
- [ ] Event includes: whether refresh was skipped (another process refreshed), duration

## Work Log

### 2026-02-27 - Filed from plan audit

**By:** Claude Code

**Actions:**
- Identified missing event from plan spec cross-reference
- Confirmed logger calls exist at refresh success/failure but emitEvent is absent

### 2026-02-27 - Implemented

**By:** Claude Code

**Actions:**
- Added `emitEvent` and `EventsConfig` imports to `src/xero/auth.ts`
- Added optional `eventsConfig` parameter to `loadValidTokens()`
- Emit `xero-auth-refreshed` with `{ skipped: true, durationMs }` when another process already refreshed
- Emit `xero-auth-refreshed` with `{ skipped: false, durationMs }` after successful refresh and save
- Emit `xero-auth-refresh-failed` with `{ error }` on refresh failure or save failure
- Updated all 5 callers to pass `ctx.eventsConfig`: accounts, reconcile, transactions, invoices, history
- No token values included in any event payload
