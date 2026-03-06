---
status: complete
priority: p2
issue_id: "142"
tags: [cli, transactions, history, output]
dependencies: []
---

# transactions human output typo + missing onUnauthorized in transactions/history

## Problem Statement

Three related issues in transactions and history commands:

1. `transactions.ts:234`: human output says `Found  transactions` (double space, missing count interpolation)
2. `transactions.ts:180`: missing `onUnauthorized` callback -- mid-stream 401 not retried (contacts/invoices/accounts all have it)
3. `history.ts:145`: same missing `onUnauthorized` callback

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 1, 2, 5 (TODO-200, TODO-311, TODO-602, TODO-603, TODO-604).

## Proposed Solutions

1. Fix interpolation: `` `Found ${limited.length} transactions` ``
2. Add `onUnauthorized` to both xeroFetch calls

## Acceptance Criteria

- [x] Human output includes actual count
- [x] Both commands pass `onUnauthorized` callback to xeroFetch
- [x] quietLine uses `limited.length` not `transactions.length`

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agents 1, 2, 5 findings

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Fixed transactions human output to interpolate actual count
- Added `onUnauthorized` callback wiring to transactions/history fetch paths
- Ensured count output uses `limited.length`
