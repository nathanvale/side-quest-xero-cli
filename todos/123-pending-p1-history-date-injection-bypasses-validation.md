---
status: complete
priority: p1
issue_id: "123"
tags: [security, validation, history, odata]
dependencies: []
---

# history `--since` date injection bypasses parseDateParts validation

## Problem Statement

The `transactions` command uses `parseDateParts(since)` with calendar round-trip validation. The `history` command constructs its OData filter by raw string interpolation: `Date>=DateTime(${options.since.split('-').join(',')})`. This means `history --since "2024-99-99"` or injection attempts produce malformed OData literals sent directly to the API.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 5 TODO-603, Agent 6 TODO-704.

- `src/cli/commands/history.ts:130`: raw `options.since.split('-').join(',')` -- no validation
- `src/cli/commands/transactions.ts:39-40`: `parseDateParts` with proper Date round-trip
- Two commands with divergent safety levels for the same argument

## Proposed Solutions

Export `parseDateParts` from `transactions.ts` (or move to `src/xero/date.ts`) and use it in `runHistory`.

## Recommended Action

Extract `parseDateParts` to a shared utility and use it in both commands.

## Acceptance Criteria

- [ ] `parseDateParts` extracted to shared location (e.g., `src/xero/date.ts`)
- [ ] `runHistory` uses `parseDateParts` for `--since` validation
- [ ] Invalid dates produce `E_USAGE` error with clear message
- [ ] Year range guard added (2000-2100)
- [ ] Exactly 3 date parts validated (no extra segments)

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 5 TODO-603 and Agent 6 TODO-704, TODO-715
- Verified TODO-063 (complete) added date-parts validation but only in transactions, not history
