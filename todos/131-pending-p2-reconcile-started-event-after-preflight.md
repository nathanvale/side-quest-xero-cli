---
status: complete
priority: p2
issue_id: "131"
tags: [observability, events, reconcile]
dependencies: []
---

# reconcile-started event emitted after preflight, not before

## Problem Statement

`xero-reconcile-started` is emitted at line 874, after lock acquisition, token loading, snapshot fetch, account codes fetch, and invalid IDs validation. If any preflight step fails, no start event is emitted. Also: no `runId` correlation ID is injected via `withContext`.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 3 TODO-404, TODO-406.

- `src/cli/commands/reconcile.ts:874`: event emitted after all preflight
- No `withContext({ runId })` call wrapping command execution
- `getLogContext()` returns null `runId` for all API requests during reconcile

## Proposed Solutions

1. Move `xero-reconcile-started` to immediately after input validation, before API calls
2. Wrap `runReconcile` in `withContext({ runId: generateRunId() })` for correlation

## Acceptance Criteria

- [ ] `xero-reconcile-started` emitted before any API call
- [ ] `runId` injected via `withContext` and appears in all logs and events
- [ ] Preflight failures still emit `xero-command-error` event

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 3 TODO-404 and TODO-406
