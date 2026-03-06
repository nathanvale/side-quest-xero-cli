---
status: complete
priority: p2
issue_id: "092"
tags: [agent-native, observability, events, reconcile]
dependencies: []
---

# Emit xero-reconcile-started event at batch start

## Problem Statement

The plan specifies `xero-reconcile-started` as an event name, but no `emitEvent` call exists at the start of the reconciliation batch. `xero-reconcile-completed` is emitted at the end (line 1148), so the observability server knows when a run finishes but not when it begins. This gap means:

- No way to calculate actual reconcile duration server-side
- No way to detect stuck/hung reconcile runs (started but never completed)
- Dashboard can't show "in-progress" reconciliations

## Findings

- `src/cli/commands/reconcile.ts:656` -- `reconcileLogger.info('Reconcile run started ...')` exists but no corresponding `emitEvent`
- `src/cli/commands/reconcile.ts:1148` -- `emitEvent(ctx.eventsConfig, 'xero-reconcile-completed', ...)` exists
- The data for the start event is already available at line 656: mode (execute/dry-run), fromCsv source, item count (after preflight)
- Two possible insertion points: line 656 (immediate, before preflight) or after preflight completes (includes item count)

## Proposed Solutions

### Option 1: Emit after preflight (preferred)

**Approach:** Add `emitEvent(ctx.eventsConfig, 'xero-reconcile-started', { mode, total, fromCsv })` after the unreconciled snapshot is fetched and item count is known. This gives the observability server the most useful data.

**Effort:** 5 minutes

**Risk:** None

## Acceptance Criteria

- [ ] `xero-reconcile-started` event emitted before per-item processing begins
- [ ] Payload includes `mode` (execute/dry-run), `total` (item count), `fromCsv` (source)
- [ ] Event appears in observability server when reconcile runs
- [ ] Paired with existing `xero-reconcile-completed` for duration calculation

## Work Log

### 2026-02-27 - Filed from plan audit

**By:** Claude Code

**Actions:**
- Identified missing event from plan spec cross-reference
- Confirmed logger call exists at the right location but emitEvent is absent

### 2026-02-27 - Implemented

**By:** Claude Code

**Actions:**
- Added `emitEvent(ctx.eventsConfig, 'xero-reconcile-started', { mode, total, fromCsv })` at line 797 in reconcile.ts
- Placed after preflight phase (all fetches/validations complete, totalCount known) and before per-item processing loop
- Payload includes mode ('execute' or 'dry-run'), total (input item count), and fromCsv (source path or null)
- Pairs with existing `xero-reconcile-completed` event at line 1153 for duration calculation
