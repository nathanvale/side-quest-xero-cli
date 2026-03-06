---
status: complete
priority: p2
issue_id: "708"
tags: [validation, date, transactions, history, agent-contract]
dependencies: []
---

# `--since` and `--until` date strings passed through without format validation

## Problem Statement

`src/cli/command.ts` stores `sinceRaw` and `untilRaw` as raw strings and passes them directly to command handlers. The date format is only validated at the OData interpolation layer via `parseDateParts` in `transactions.ts` and `history.ts`.

If an agent or user passes `--since 2024/01/01` (slashes instead of dashes) or `--since january-1-2024` (non-numeric parts), `parseDateParts` will throw a plain `Error` which surfaces as `E_RUNTIME/ESCALATE` instead of `E_USAGE/FIX_ARGS`.

### Trace

`parseDateParts` at `src/xero/date.ts` line 8:
```ts
const [year, month, day] = date.split('-').map((part) => Number(part))
if (!year || !month || !day) throw new Error(`Invalid date: ${date}`)
```

This `Error` is not a structured error. It will be caught by `handleCommandError` and mapped to `E_RUNTIME`.

### What an agent should receive

```json
{
  "action": "FIX_ARGS",
  "errorFamily": "validation",
  "userMessage": "--since must be YYYY-MM-DD format (got '2024/01/01')"
}
```

## Required Fix

Option A: Validate date format in `parseCli` before building the options object:
```ts
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
if (sinceRaw && !ISO_DATE_PATTERN.test(sinceRaw)) {
  return parseUsageError(`--since must be YYYY-MM-DD (got '${sinceRaw}')`, json, quiet)
}
```

Option B: Wrap `parseDateParts` throws in command handlers with structured re-throw.

Option A is preferred -- it moves validation to the boundary layer.

## Acceptance Criteria

- [ ] Non-YYYY-MM-DD `--since` / `--until` returns `ParseCliError` with `E_USAGE`
- [ ] Agent receives `action: 'FIX_ARGS'` for date format errors
- [ ] `parseDateParts` semantic validation (month 1-12, valid day) is still exercised

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
