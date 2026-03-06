---
status: complete
priority: p1
issue_id: "105"
tags: [cli, errors, exit-codes, agent-contract]
dependencies: []
---

# Exit code and error type mismatches

## Problem Statement

Several code paths throw plain `Error` or use wrong error types, causing agents to receive `E_RUNTIME / ESCALATE` for recoverable conditions, and exit code 1 for errors that should map to specific exit codes (4 for unauthorized, 3 for usage).

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 2.

- **H3: `XeroApiError` always exits `EXIT_RUNTIME`** - `src/cli/output.ts:685-692` returns `EXIT_RUNTIME` (1) for all `XeroApiError` instances regardless of error code. `deriveExitCodeHint()` exists and correctly maps codes, but is only used for the JSON hint field, not the actual process exit code. An `E_SCOPE_RESTRICTED` error exits 1 instead of 4.
- **H1: Lock contention throws plain `Error`** - `src/state/lock.ts:35,53` throws `new Error('Another reconcile run is in progress')` instead of `XeroConflictError` with `E_LOCK_CONTENTION`. Agents get `ESCALATE` instead of `WAIT_AND_RETRY`.
- **H2: Reconcile preflight throws plain `Error`** - `src/cli/commands/reconcile.ts:779,789` throws bare `Error` for "Already reconciled", "Not found", and "Invalid AccountCode(s)". Agents can't distinguish these conditions.

## Proposed Solutions

### Option 1: Fix all three throw sites + exit code return

**Approach:**
1. `output.ts:692` - Replace `return EXIT_RUNTIME` with `return deriveExitCodeHint(err.code)` for `XeroApiError`
2. `lock.ts:35,53` - Replace `throw new Error(...)` with `throw new XeroConflictError('...', { code: 'E_LOCK_CONTENTION', recoverable: true })`
3. `reconcile.ts:779` - Throw `XeroApiError` with `E_STALE_DATA` (already registered) for already-reconciled/not-found IDs
4. `reconcile.ts:789` - Throw `XeroApiError` with `E_USAGE` for invalid account codes

**Effort:** 45 minutes

**Risk:** Low

## Recommended Action

Option 1. All fixes are straightforward type changes at throw sites.

## Technical Details

**Affected files:**
- `src/cli/output.ts:685-692` - exit code return
- `src/state/lock.ts:35,53` - error type
- `src/cli/commands/reconcile.ts:779,789` - error type
- `src/xero/errors.ts` - may need import adjustments

**Related:** `E_LOCK_CONTENTION` and `E_STALE_DATA` are already registered in `ERROR_CODE_ACTIONS` but never thrown (dead hint entries).

## Acceptance Criteria

- [ ] `XeroApiError` exit code uses `deriveExitCodeHint(err.code)` not hardcoded `EXIT_RUNTIME`
- [ ] Lock contention throws `XeroConflictError` with `code: 'E_LOCK_CONTENTION'`
- [ ] Reconcile preflight errors use structured error types with appropriate codes
- [ ] Add test: `E_SCOPE_RESTRICTED` exits with code 4
- [ ] Add test: lock contention produces `E_LOCK_CONTENTION` in error envelope
- [ ] Add test: reconcile preflight errors produce specific codes, not `E_RUNTIME`

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 2 identified all three issues as HIGH severity
- `E_LOCK_CONTENTION` and `E_STALE_DATA` already exist in `ERROR_CODE_ACTIONS` but are dead entries
- The exit code bug affects all `XeroApiError` subtypes, not just `E_SCOPE_RESTRICTED`

**Learnings:**
- `deriveExitCodeHint` is well-implemented but disconnected from the actual exit path
- Wiring `E_STALE_DATA` to the preflight check solves both the dead-entry issue and the missing-code issue
