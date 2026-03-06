---
status: complete
priority: p2
issue_id: "145"
tags: [events, observability, agent-contract]
dependencies: []
---

# 6 list/status commands emit no domain-specific events

## Problem Statement

While `command.ts` now emits generic `xero-command-started/completed` lifecycle events for all commands, 6 commands emit zero domain-specific events. An observability consumer cannot see result counts, filter params, truncation warnings, or diagnosis from the events channel.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 1, 3 (TODO-203, TODO-405, TODO-406).

- accounts, contacts, transactions, invoices, history: no result-count or truncation events
- status: no diagnosis event

## Proposed Solutions

Add minimal domain events:
- List commands: `xero-list-completed` with `{ command, count }` and `xero-list-truncated` at max-pages
- Status: `xero-status-checked` with `{ diagnosis, nextAction }`

## Acceptance Criteria

- [x] Each list command emits a completed event with result count
- [x] Max-pages truncation emits a warning event
- [x] Status emits diagnosis event

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agent 1 TODO-203, Agent 3 TODO-405, TODO-406

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Added `xero-list-completed` events for accounts/contacts/transactions/invoices/history
- Added `xero-list-truncated` events for paginated list commands at max-pages boundary
- Added `xero-status-checked` diagnosis event for status command
