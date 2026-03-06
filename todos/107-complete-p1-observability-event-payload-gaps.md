---
status: complete
priority: p1
issue_id: "107"
tags: [events, observability, agent-contract]
dependencies: []
---

# Observability event payload gaps and missing discriminators

## Problem Statement

Several critical events have incomplete payloads or missing discriminators, making it impossible for agents to reliably correlate, filter, or act on event data.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 4.

- **H9: `xero-cli-completed` has no status discriminator** - `src/cli/command.ts:792,806,828` emits the same event name for success, failure, and interruption. Only `exitCode` signals failure -- no `status` field. Agents can't distinguish clean completion from error without inspecting stderr.
- **H10: `xero-auth-failed` silently suppressed** - `src/cli/commands/auth.ts:124-138` only emits when `err instanceof Error`. Non-Error throws are silently dropped. Also, `errorForEvent.message` is not sanitized -- potential token leak into events channel.
- **H11: `xero-reconcile-item-conflict` incomplete** - `src/cli/commands/reconcile.ts:1099` only sends `bankTransactionId`. Missing `durationMs`, `error`, `accountCode`/`invoiceId` that sibling events include.
- **H12: Invoice-payment success sends `accountCode: undefined`** - `src/cli/commands/reconcile.ts:1065` sends `accountCode: undefined` which `JSON.stringify` silently drops. Missing `invoiceId` and `paymentId` that are in scope.

## Proposed Solutions

### Option 1: Fix all four event payloads

**Approach:**
1. `command.ts:792,806,828` - Add `status: 'success' | 'failed' | 'interrupted'` to all three emissions
2. `auth.ts:124-138` - Always emit `xero-auth-failed` regardless of error type; sanitize message with `sanitizeErrorMessage()`
3. `reconcile.ts:1099` - Add `durationMs`, `error`, `accountCode`/`invoiceId` to conflict event
4. `reconcile.ts:1065` - Replace `accountCode: undefined` with `invoiceId` and `paymentId`; add `type: 'invoice-payment'` (already present)

**Effort:** 45 minutes

**Risk:** Low

## Recommended Action

Option 1. All changes are additive field additions to existing payloads.

## Technical Details

**Affected files:**
- `src/cli/command.ts:792,806,828`
- `src/cli/commands/auth.ts:124-138`
- `src/cli/commands/reconcile.ts:1065,1099`

## Acceptance Criteria

- [ ] `xero-cli-completed` includes `status` field discriminating success/failure/interruption
- [ ] `xero-auth-failed` always emits, even for non-Error throws
- [ ] `xero-auth-failed` message is passed through `sanitizeErrorMessage()`
- [ ] `xero-reconcile-item-conflict` includes `durationMs`, `error`, context fields
- [ ] Invoice-payment success event includes `invoiceId`, `paymentId` instead of `accountCode: undefined`
- [ ] Add test: `xero-cli-completed` status field matches exit code semantics
- [ ] Add test: `xero-auth-failed` emits for thrown string values

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 4 catalogued all 22 events emitted across the codebase
- Identified 4 HIGH payload issues and 4 missing events at critical decision points
- Missing events (lower priority): dry-run items, cli-failed distinct event, usage-error, auth-refresh-started

**Learnings:**
- The `JSON.stringify` silent-drop of `undefined` is a recurring trap
- Events are fire-and-forget by design, but payload completeness matters for agent consumption
