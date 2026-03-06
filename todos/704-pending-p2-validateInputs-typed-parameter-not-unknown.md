---
status: complete
priority: p2
issue_id: "704"
tags: [type-safety, reconcile, zod]
dependencies: []
---

# `validateInputs` parameter typed as `unknown` -- correct, but `parseJsonInput` pre-casts before calling

## Problem Statement

`validateInputs` at `src/cli/commands/reconcile.ts` line 223 correctly accepts `unknown`:

```ts
function validateInputs(inputs: unknown): ReconcileInputBase[] {
  const validated = ReconcileArraySchema.safeParse(inputs)
  ...
}
```

However, `parseJsonInput` at line 238 pre-casts the result of `JSON.parse`:

```ts
function parseJsonInput(raw: string): ReconcileInputBase[] {
  const parsed = JSON.parse(raw) as unknown  // ok: correctly cast to unknown
  return validateInputs(parsed)              // ok: passes unknown to validateInputs
}
```

This path is actually correct. However, `loadCsv` at line 369 constructs `inputs: ReconcileInputBase[]` (typed array) before passing to `validateInputs`:

```ts
const inputs: ReconcileInputBase[] = []
// ... push records with types not yet verified ...
return { inputs: validateInputs(inputs), usedFallbackColumn }
```

Here `inputs` is typed as `ReconcileInputBase[]` before Zod validation. The `Amount` field is set via `Number(record.Amount)` which can be `NaN` -- this is typed as `number` but is not a valid number. TypeScript accepts this because `NaN` satisfies the `number` type.

The `validateInputs(inputs)` call passes a TypeScript-typed array to a function accepting `unknown` -- Zod will catch issues, but the intermediate typed variable creates a false sense of safety: code between CSV parsing and `validateInputs` may rely on `ReconcileInputBase[]` type and skip guards.

## Required Fix

Change `loadCsv` to build the interim array as `unknown[]` or `Record<string, unknown>[]`:

```ts
const rawInputs: Record<string, unknown>[] = []
// ... push raw records ...
return { inputs: validateInputs(rawInputs), usedFallbackColumn }
```

## Acceptance Criteria

- [ ] CSV parse path builds array as `unknown[]` before Zod validation
- [ ] No intermediate typed assignment of unvalidated CSV data

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
