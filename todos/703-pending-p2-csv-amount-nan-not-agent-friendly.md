---
status: complete
priority: p2
issue_id: "703"
tags: [validation, csv, reconcile, agent-contract]
dependencies: []
---

# CSV `Amount` field uses `Number()` -- NaN and locale formats pass silently to Zod

## Problem Statement

`src/cli/commands/reconcile.ts` line 365:

```ts
Amount: record.Amount ? Number(record.Amount) : undefined,
```

`Number('1,234.56')` returns `NaN`. `Number('')` returns `0` (falsy, correctly excluded). `Number('$100')` returns `NaN`. `Number('100abc')` returns `NaN`.

Zod's `.number().positive()` rejects `NaN`, but the error message is:
```
Number must be greater than 0
```

This is not agent-friendly: the agent cannot distinguish "NaN from locale-formatted input" from "negative number" from "zero". A better error is: "Amount '1,234.56' is not a valid number -- use plain decimal format (e.g. 1234.56)".

Additionally, `Number(record.Amount)` where `record.Amount` is a truthy non-numeric string (like `"abc"`) produces `NaN` which is typed as `number` -- TypeScript accepts this because `Number()` always returns `number`.

## Affected Code Path

```
loadCsv -> parseCsvLine -> record.Amount -> Number(record.Amount) -> ReconcileItemSchema.safeParse
```

## Required Fix

Replace bare `Number()` with a validated parse:
```ts
Amount: record.Amount
  ? (() => {
      const parsed = Number(record.Amount)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Amount '${record.Amount}' is not a valid positive number`)
      }
      return parsed
    })()
  : undefined,
```

Or pre-validate in `validateInputs` with a custom Zod `.transform()` that converts string to number with a descriptive error.

## Acceptance Criteria

- [ ] `Number('1,234.56')` (locale format) throws a descriptive `E_USAGE` error, not a generic Zod message
- [ ] `Number('abc')` produces a clear "not a valid number" error with the offending value
- [ ] Error message includes the raw value so an agent can diagnose and fix the CSV

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor

**Note:** Previously noted in TODO-134 item 2 without code location. This todo adds the exact line reference.
