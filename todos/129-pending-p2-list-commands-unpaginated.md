---
status: complete
priority: p2
issue_id: "129"
tags: [api, pagination, data-completeness]
dependencies: []
---

# List commands silently truncated at Xero's 100-record page limit

## Problem Statement

`/Contacts`, `/Accounts`, and `/Invoices` are fetched without pagination. Xero returns at most 100 records per page. Orgs with more than 100 items silently receive a partial list with no truncation warning.

Also: `fetchUnreconciledSnapshot` pagination loop has no maximum-page safety guard -- potential infinite loop.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 5 TODO-604, TODO-605.

- `src/cli/commands/contacts.ts:63-72`: single GET, no pagination
- `src/cli/commands/accounts.ts:69`: single GET, no pagination
- `src/cli/commands/invoices.ts:94`: single GET, no pagination
- `src/cli/commands/reconcile.ts:468`: `while(true)` loop with no `MAX_PAGES` guard

## Proposed Solutions

1. Add pagination to list commands (or add `warnings` entry when response equals page size limit)
2. Add `MAX_PAGES = 1000` guard to `fetchUnreconciledSnapshot` with logged warning on breach

## Acceptance Criteria

- [ ] List commands paginate or warn when result count equals page limit
- [ ] `fetchUnreconciledSnapshot` has MAX_PAGES guard
- [ ] Warning logged when MAX_PAGES reached

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 5 TODO-604 and TODO-605
