---
status: complete
priority: p1
issue_id: "139"
tags: [events, error-handling, agent-contract]
dependencies: []
---

# xero-command-error event never emitted on error paths

## Problem Statement

The error path in `command.ts` emits `xero-cli-completed` and `xero-command-completed` with `status: 'failed'`, but no dedicated `xero-command-error` event. An agent cannot reliably distinguish a non-zero-exit completed from a runtime exception without inspecting the `status` field.

Also: `xero-cli-completed` and `xero-command-completed` are emitted as duplicates with identical payloads -- no documented distinction.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agent 3 TODO-400, TODO-402.

- `src/cli/command.ts:862-913`: error path emits only completed events
- Both `xero-cli-completed` and `xero-command-completed` fire with identical payloads in all branches

## Proposed Solutions

1. Emit `xero-command-error` with `{ command, errorCode, errorFamily, exitCode, durationMs, message }` before the completed event in error branches
2. Document or deduplicate `xero-cli-completed` vs `xero-command-completed`

## Acceptance Criteria

- [x] `xero-command-error` emitted on all error paths with error code, family, and sanitized message
- [x] Duplicate completed events documented or deduplicated

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agent 3 TODO-400 and TODO-402

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Added `xero-command-error` emission in CLI catch path with code/family/exit/duration/message
- Documented the dual completed events as intentional backward-compatibility behavior
