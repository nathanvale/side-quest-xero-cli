---
status: complete
priority: p1
issue_id: "122"
tags: [observability, events, agent-contract]
dependencies: []
---

# 6 of 8 commands emit zero observability events

## Problem Statement

Only `auth` and `reconcile` are wired to the events channel. The `accounts`, `contacts`, `history`, `invoices`, `transactions`, and `status` commands emit no `emitEvent` calls. An agent consuming these commands through the observability server has no telemetry signal.

TODO-095 (complete) added CLI lifecycle events, but only for reconcile and auth. The other 6 commands remain dark.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 3 TODO-401.

- `src/cli/commands/accounts.ts` - zero events
- `src/cli/commands/contacts.ts` - zero events
- `src/cli/commands/history.ts` - zero events
- `src/cli/commands/invoices.ts` - zero events
- `src/cli/commands/transactions.ts` - zero events
- `src/cli/commands/status.ts` - zero events

## Proposed Solutions

Each command should emit at minimum:
- `xero-command-started` (name, args)
- `xero-command-completed` (name, durationMs, count)
- `xero-command-error` (name, error code) on failure

Implement in `src/cli/command.ts` as a wrapper around command execution to avoid repetition.

## Recommended Action

Add event emission to the command runner infrastructure so all commands get lifecycle events automatically.

## Acceptance Criteria

- [ ] All 8 commands emit `xero-command-started` on entry
- [ ] All 8 commands emit `xero-command-completed` on success with duration and result count
- [ ] All 8 commands emit `xero-command-error` on failure with error code
- [ ] Events include command name and sanitized arguments

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Filed from Agent 3 TODO-401
- Verified TODO-095 only covered reconcile/auth lifecycle events
