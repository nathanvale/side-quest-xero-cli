---
status: complete
priority: p2
issue_id: "110"
tags: [cli, errors, agent-hints]
dependencies: ["105"]
---

# Missing and contradictory ERROR_CODE_ACTIONS entries

## Problem Statement

Several error codes are thrown but have no entry in `ERROR_CODE_ACTIONS`, falling through to a generic `ESCALATE` fallback. Other entries have contradictory `retryable`/`safeToRetrySameInput` fields that mislead agents.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agents 1, 2, 5.

**Missing entries:**
- `E_KEYCHAIN_LOCKED` - thrown at `auth.ts:126`, falls to `ESCALATE`. Should be `UNLOCK_KEYCHAIN` with `retryable: true`
- `E_KEYCHAIN_DENIED` - thrown at `auth.ts:132`, falls to `ESCALATE`. Should be `ALLOW_KEYCHAIN`
- `E_KEYCHAIN_ERROR` - thrown at `auth.ts:134`, falls to `ESCALATE`. Should be `ESCALATE` with `errorFamily: 'auth'`

**Contradictory entries:**
- `E_API_ERROR` (`output.ts:203-214`) - `retryable: true`, `safeToRetrySameInput: true` but used for non-retriable 400s. Split needed for 4xx vs ambiguous errors.
- `E_NETWORK` (`output.ts:139-150`) - `retryable: false` but `safeToRetrySameInput: true`. Contradiction.
- `E_CONFLICT` (`output.ts:304-316`) - `retryable: true` but `safeToRetrySameInput: false`. Ambiguous.

**Dead entries (never thrown):**
- `E_FORBIDDEN` (`output.ts:152-161`) - 403 uses `E_UNAUTHORIZED` or `E_SCOPE_RESTRICTED` instead
- `E_STALE_DATA` (`output.ts:281-295`) - should be wired to reconcile preflight (see #105)
- `E_API_CONFLICT` (`output.ts:296-303`) - never thrown

## Proposed Solutions

### Option 1: Add missing, fix contradictions, wire or remove dead entries

**Approach:**
1. Add `E_KEYCHAIN_LOCKED`, `E_KEYCHAIN_DENIED`, `E_KEYCHAIN_ERROR` with appropriate actions
2. Split `E_API_ERROR` into `E_API_ERROR` (ambiguous, retryable) and `E_REQUEST_ERROR` (4xx, not retryable)
3. Fix `E_NETWORK`: set `retryable: false`, `safeToRetrySameInput: false` (internal retries exhausted)
4. Fix `E_CONFLICT`: set `retryable: false` or `safeToRetrySameInput: true` -- pick one
5. Wire `E_STALE_DATA` per #105, remove or wire `E_FORBIDDEN` and `E_API_CONFLICT`

**Effort:** 1 hour

**Risk:** Low

## Acceptance Criteria

- [ ] All thrown error codes have matching `ERROR_CODE_ACTIONS` entries
- [ ] No `retryable`/`safeToRetrySameInput` contradictions
- [ ] No dead entries in `ERROR_CODE_ACTIONS`
- [ ] Add test: every error code thrown in codebase has an `ERROR_CODE_ACTIONS` entry (completeness test)

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Catalogued all thrown error codes vs registered actions
- Identified 3 missing, 3 contradictory, 3 dead entries
