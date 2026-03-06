---
status: complete
priority: p2
issue_id: "707"
tags: [type-safety, history, cast, correctness]
dependencies: []
---

# `history.ts` uses a double cast `as unknown as Record<string, unknown>[]` that hides type mismatch

## Problem Statement

`src/cli/commands/history.ts` lines 161-165:

```ts
const projected = options.fields
  ? projectFields(
      grouped as unknown as Record<string, unknown>[],  // double cast
      options.fields,
    )
  : grouped
```

And line 167:
```ts
const warnings = detectAllUndefinedFields(
  projected as Record<string, unknown>[],  // another cast
  options.fields,
)
```

And line 176:
```ts
transactions: projected as HistoryRow[],  // third cast on same value
```

The triple-cast chain on `projected` means the type system provides no safety guarantee at any point. `grouped` is `HistoryRow[]`, which is a properly typed array -- but the cast to `as unknown as Record<string, unknown>[]` discards all type information to satisfy `projectFields`.

The root cause is that `projectFields` accepts `T extends Record<string, unknown>` but `HistoryRow` has known typed fields (not `Record<string, unknown>`). Rather than fixing `projectFields` to handle typed records, the code casts the caller's well-typed data to bypass the constraint.

## Impact

If `HistoryRow` gains a new required field, TypeScript will not flag calls in this cast chain. The cast at line 176 (`projected as HistoryRow[]`) is particularly dangerous: `projectFields` returns `Record<string, unknown>[]` (projected fields only), and casting that back to `HistoryRow[]` asserts the projection preserved all `HistoryRow` fields -- which is only true if `options.fields` is null.

When `options.fields` is non-null, the returned `HistoryRow[]` in `writeSuccess` is actually a partial record, but TypeScript thinks it is a full `HistoryRow`. Any downstream code consuming the event payload or JSON output as `HistorySuccessData` will receive incomplete rows without type errors.

## Required Fix

Change `HistorySuccessData.transactions` to `Record<string, unknown>[]` (matching the projected type), or overload `projectFields` to preserve the output type correctly. The `satisfies HistorySuccessData` annotation on the `writeSuccess` call enforces this type, so the fix is to relax `HistorySuccessData.transactions`.

```ts
interface HistorySuccessData {
  readonly command: 'history'
  readonly count: number
  readonly transactions: HistoryRow[] | Record<string, unknown>[]
}
```

## Acceptance Criteria

- [ ] No `as unknown as` double-cast in history.ts
- [ ] `HistorySuccessData.transactions` type correctly reflects projected vs. full rows
- [ ] No `satisfies` annotation suppresses a genuine type mismatch

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
