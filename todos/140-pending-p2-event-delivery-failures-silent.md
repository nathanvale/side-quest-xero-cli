---
status: complete
priority: p2
issue_id: "140"
tags: [events, observability, logging]
dependencies: []
---

# Event delivery failures silently swallowed -- [xero,events] logger dead

## Problem Statement

When both event delivery attempts fail (network down, server unreachable), `events.ts` exits silently with no diagnostic. The `[xero, events]` logger category is registered in `logging.ts` but never imported or used in `events.ts`.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agent 3 TODO-401.

- `src/events.ts:98-103`: catch block discards all errors on final attempt
- `src/logging.ts:128-131`: `['xero', 'events']` category registered but unused

## Proposed Solutions

Import `getXeroLogger` in `events.ts`, log at `debug` level on final delivery failure.

## Acceptance Criteria

- [x] Final event delivery failure logged at debug level with event name and URL
- [x] Non-OK HTTP response logged at debug level with status code

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Filed from Agent 3 TODO-401

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Added debug diagnostics for non-OK event delivery responses and final delivery failures
- Kept failure diagnostics best-effort and non-fatal
