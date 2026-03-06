---
status: complete
priority: p2
issue_id: "141"
tags: [errors, agent-contract, hints]
dependencies: []
---

# E_NETWORK hint says retryable:false but errors set recoverable:true

## Problem Statement

`ERROR_CODE_ACTIONS.E_NETWORK` has `retryable: false` and `safeToRetrySameInput: false`. But all `XeroApiError` instances with `E_NETWORK` are thrown with `recoverable: true`. An agent sees contradictory signals in the error envelope.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 2, 5 (TODO-309, TODO-601).

- `src/cli/output.ts:139-151`: `E_NETWORK` has `retryable: false`
- `src/xero/api.ts:429,440`: thrown with `recoverable: true`
- `src/xero/auth.ts:358,364`: thrown with `recoverable: true`

## Proposed Solutions

Change `E_NETWORK` to `retryable: true, safeToRetrySameInput: true, recommendedDelayMs: 5000`.

## Acceptance Criteria

- [x] `E_NETWORK` hint `retryable` matches `recoverable` on all throw sites
- [x] `safeToRetrySameInput: true` for read-only operations

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agent 2 TODO-309 and Agent 5 TODO-601

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Updated `ERROR_CODE_ACTIONS.E_NETWORK` to `retryable: true` and `safeToRetrySameInput: true`
- Added `recommendedDelayMs: 5000` to align hinting with recoverable network throws
