---
status: pending
priority: p2
issue_id: "712"
tags: [architecture, tools-as-primitives, agent-native]
dependencies: []
---

# Extract transactions quarter logic and history grouping into reusable functions

## Problem Statement

`transactions.ts` embeds quarter resolution (`resolveQuarterRange`) and summary aggregation (`summarizeTransactions`) directly in the command handler. `history.ts` embeds grouping logic (`groupHistory`). These are domain functions that should be importable/reusable, not buried in CLI commands.

## Findings

- `resolveQuarterRange` and `summarizeTransactions` are pure functions trapped inside command handlers
- `groupHistory` performs in-memory grouping/aggregation coupled to the fetch step
- Cannot reuse quarter logic or grouping from other commands or tests
- Classified as WORKFLOW in agent-native audit (should be PRIMITIVE + utility functions)

## Proposed Solutions

### Option 1: Extract to src/xero/query/ and src/xero/transform/

**Approach:** Move pure functions to library layer. Commands import and compose them.

```typescript
// src/xero/query/date-ranges.ts
export function resolveQuarterRange(kind: 'this' | 'last'): DateRange

// src/xero/transform/transactions.ts
export function summarizeTransactions(txns: BankTransactionRecord[]): Summary
export function groupTransactionsByContactAndAccount(txns: BankTransactionRecord[]): HistoryRow[]
```

**Pros:**
- Functions become independently testable and reusable
- Commands become thin orchestrators

**Cons:**
- Minor refactor overhead

**Effort:** 1-2 hours

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `resolveQuarterRange` exported from shared module
- [ ] `summarizeTransactions` exported from shared module
- [ ] `groupHistory` extracted and exported
- [ ] Command handlers import from shared modules
- [ ] All existing tests pass
- [ ] `bun run validate` passes

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Identified embedded domain logic in transactions.ts and history.ts
- Part of Tools as Primitives remediation (scored 25%)
