---
status: complete
priority: p1
issue_id: "117"
tags: [errors, agent-contract, reconcile, state, config]
dependencies: []
---

# Bare `throw new Error()` bypasses structured error taxonomy

## Problem Statement

Despite TODO-105 fixing exit code mapping and lock contention errors, numerous code paths still throw plain `Error` objects that bypass the structured error taxonomy. Agents receive `E_RUNTIME/ESCALATE` with no self-recovery signal for conditions that have clear, actionable error codes.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agents 2, 4.

**reconcile.ts validators (Agent 2: TODO-300):**
- `assertValidBankTransactionResponse` (line 156-207) throws bare `Error`
- `assertValidPaymentResponse` (line 156-207) throws bare `Error`
- `validateInputs` (line 225-231) throws bare `Error`
- `readStdinWithLimit` (line 248) throws bare `Error('Input exceeds 5MB limit')`
- Per-item business logic (lines 957-1081): missing prefetch, split line items, missing invoice, currency mismatch, amount due mismatch, missing BankAccount.AccountID -- all throw bare `Error`

**state.ts (Agent 4: TODO-503, Agent 2: TODO-303):**
- `loadState` (lines 43, 46) throws bare `Error` for corrupt/mismatched state
- `saveState` (line 69) throws bare `Error` for permission issues after write

**config.ts (Agent 2: TODO-304):**
- `loadEnvConfig` (line 44) -- missing `XERO_CLIENT_ID` should be `E_USAGE`
- `loadXeroConfig` (line 65) -- corrupted config should be `E_UNAUTHORIZED` with `nextCommand: 'auth'`
- `saveXeroConfig` (line 95) -- permission error should be `E_RUNTIME`

**lock.ts (Agent 4: TODO-505, Agent 2: TODO-305):**
- `readLock` (line 24) -- symlinked lock file should be `E_LOCK_CONTENTION`

**fs.ts (Agent 2: TODO-308):**
- `assertSecureFile` (lines 12, 16) -- symlink/permission errors not structured

## Proposed Solutions

### Option A: Targeted replacement (recommended)
Replace each bare `throw new Error(...)` with the appropriate structured error class:
- `XeroApiError` with `E_USAGE` for input validation
- `XeroApiError` with `E_MALFORMED_RESPONSE` for response validation
- `XeroConflictError` with `E_LOCK_CONTENTION` for lock/state conflicts
- `XeroConflictError` with `E_STALE_DATA` for schema mismatches
- Define item-level codes (`E_VALIDATION`) for per-item reconcile failures

### Option B: Catch-all wrapper
Wrap `handleCommandErrorWithContext` to detect plain `Error` and attempt code inference from message. Too fragile.

## Recommended Action

Option A. Work through each file systematically, replacing bare `Error` with typed structured errors.

## Acceptance Criteria

- [ ] Zero `throw new Error(...)` remaining in src/ (excluding test files)
- [ ] All thrown errors carry a code from the `ERROR_CODE_ACTIONS` map
- [ ] Per-item reconcile failures include `.code` in result record and event payload
- [ ] `loadEnvConfig` missing config exits with `E_USAGE` / `FIX_ARGS`
- [ ] State corruption exits with `E_STALE_DATA` and includes `stateFile` in context

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 2 TODO-300 through TODO-305, TODO-308, and Agent 4 TODO-503 into single todo
- Cross-referenced with completed TODO-105 (exit code mapping) -- that fixed the mapping layer but not the throw sites
