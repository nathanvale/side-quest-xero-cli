---
status: complete
priority: p1
issue_id: "137"
tags: [reconcile, data-integrity, resource-leak]
dependencies: []
---

# AuditWriter and StateBatcher not closed/flushed on exception path

## Problem Statement

Both `auditWriter` and `stateBatcher` are scoped inside the `try` block in `runReconcile`. The `finally` block only releases the lock -- it does not close the audit writer or flush the state batcher. On any exception after `auditWriter.open()`, the file handle leaks and buffered audit entries are lost. On any exception after items are marked processed, up to 49 items (checkpoint interval) of state are lost, causing duplicate Xero transactions on resume.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agent 4 TODO-500, TODO-501.

- `src/cli/commands/reconcile.ts:752-761`: auditWriter opened inside try block
- `src/cli/commands/reconcile.ts:1220-1222`: auditWriter.close() only on happy path
- `src/cli/commands/reconcile.ts:1317-1323`: finally block only releases lock
- `src/cli/commands/reconcile.ts:1216`: stateBatcher.flush() only on happy path

Also: StateBatcher concurrent flush has a gap (Agent 4 TODO-502) -- after awaiting an in-flight flush, `flush()` returns without re-checking `dirtyCount`, silently dropping items dirtied during the in-flight save.

## Proposed Solutions

1. Hoist `auditWriter` and `stateBatcher` to be accessible from `finally` block
2. In `finally`: call `stateBatcher?.flush()` and `auditWriter?.close()` with null guards
3. Fix concurrent flush: after `await this.flushInFlight`, tail-call `return this.flush()` to re-check dirty items

## Acceptance Criteria

- [x] `auditWriter.close()` called in finally block (guarded)
- [x] `stateBatcher.flush()` called in finally block (guarded)
- [x] StateBatcher.flush() re-checks dirtyCount after awaiting in-flight flush
- [x] No file handle leaks on exception paths
- [x] No state loss on exception paths

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agent 4 TODO-500, TODO-501, TODO-502

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Moved `auditWriter`/`stateBatcher` lifecycle control to `finally` in `runReconcile`
- Added guarded finalize flush/close/release cleanup paths
- Fixed `StateBatcher.flush()` to re-check dirty state after waiting for in-flight flush
