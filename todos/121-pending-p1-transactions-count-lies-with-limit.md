---
status: complete
priority: p1
issue_id: "121"
tags: [cli, output, agent-contract, transactions]
dependencies: []
---

# transactions `count` field lies when `--limit` is used

## Problem Statement

When `--limit N` is applied, `writeSuccess` reports `count: transactions.length` (the full API count) but the `transactions` array contains only the limited slice. An agent parsing `count=287` but receiving 20 records has a broken contract.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 1 TODO-201.

- `src/cli/commands/transactions.ts:215-217`: `limited = transactions.slice(0, options.limit)`
- Lines 226, 246: `count: transactions.length` uses full count, not limited count
- Agent sees `count=287` but array has 20 items -- machine-readable lie

## Proposed Solutions

Change `count: transactions.length` to `count: limited.length` and add `totalFetched: transactions.length` to preserve the full-count signal without corrupting the record count.

## Recommended Action

Direct fix -- change the two `writeSuccess` calls.

## Acceptance Criteria

- [ ] `count` equals the number of records in the `transactions` array
- [ ] `totalFetched` field added showing the pre-limit count
- [ ] Both JSON and human output paths updated

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Filed from Agent 1 TODO-201
