---
status: complete
priority: p3
issue_id: "097"
tags: [agent-native, observability, events, state]
dependencies: []
---

# Emit state checkpoint events for crash recovery visibility

## Problem Statement

The reconcile pipeline writes state checkpoints periodically to enable crash recovery. The observability server has no visibility into checkpoint timing, which means:

- No way to verify checkpoints are actually being written
- No way to calculate data-at-risk window (items processed since last checkpoint)
- Can't detect checkpoint write failures (silent data loss risk)
- Can't track checkpoint frequency across different batch sizes

## Proposed Events

| Event | When | Payload |
|-------|------|---------|
| `xero-state-checkpoint` | After each state batch flush | `{ processedCount, totalCount, checkpointNumber }` |
| `xero-state-recovered` | When reconcile resumes from crashed state | `{ recoveredCount, totalCount }` |

## Insertion Points

- `src/state/state.ts` or wherever `StateBatcher` flushes
- The `reconcileLogger.debug('State checkpoint flushed ...')` call added in TODO 089 marks the exact spot

## Effort

10 minutes

## Risk

None

## Acceptance Criteria

- [ ] `xero-state-checkpoint` emitted on each state flush
- [ ] `xero-state-recovered` emitted when resuming from previous state
- [ ] Payload includes progress metrics (processed/total)

## Work Log

### 2026-02-27 - Implemented state checkpoint and recovery events

**By:** Claude Code

- Added `onFlush` callback parameter to `StateBatcher` constructor in `src/state/state.ts`
- `StateBatcher.flush()` now tracks a `flushCount` and invokes the callback with `{ checkpointNumber }`
- In `src/cli/commands/reconcile.ts`:
  - After `loadState()`, detect recovered state and emit `xero-state-recovered` with `{ recoveredCount, totalCount }`
  - Pass `onFlush` callback to `StateBatcher` that emits `xero-state-checkpoint` with `{ processedCount, totalCount, checkpointNumber }`
- Both periodic flushes (every 50 items) and the final explicit flush emit the checkpoint event

### 2026-02-27 - Filed from observability brainstorm

**By:** Claude Code
