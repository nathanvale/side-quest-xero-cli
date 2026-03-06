---
status: complete
priority: p2
issue_id: "127"
tags: [state, data-integrity, crash-safety]
dependencies: []
---

# saveState does not fsync before rename -- crash can lose checkpoint

## Problem Statement

`saveState` writes to a temp file then renames, but does not `fsync` the temp file before rename. On crash between write and sync, the state file may be empty. `config.ts:85` correctly calls `await handle.sync()` -- `state.ts` is missing the equivalent.

Also: the permissions post-write check deletes the state file on mode mismatch instead of correcting it with `chmod`.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 4 TODO-504, TODO-513.

- `src/state/state.ts:55-70`: `writeFile` then immediate `rename` -- no `fsync`
- `src/xero/config.ts:85`: correctly calls `await handle.sync()` -- inconsistent pattern
- `src/state/state.ts:65-70`: mode mismatch calls `unlink` -- destroys all checkpoint progress

## Proposed Solutions

1. Replace `writeFile` with `open`/`write`/`sync`/`close` sequence (matching config.ts pattern)
2. Replace `unlink` on mode mismatch with `chmod(statePath, STATE_MODE)` and re-verify

## Acceptance Criteria

- [ ] `saveState` calls `fsync` before rename
- [ ] Mode mismatch corrected with `chmod` instead of deleting state
- [ ] Pattern matches existing `config.ts` implementation

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 4 TODO-504 and TODO-513
