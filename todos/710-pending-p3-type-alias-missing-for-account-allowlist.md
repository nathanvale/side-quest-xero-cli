---
status: complete
priority: p3
issue_id: "710"
tags: [type-safety, accounts, allowlist, code-quality]
dependencies: []
---

# `ACCOUNT_TYPE_ALLOWLIST` not exported or typed -- callers cannot use type-safe account type

## Problem Statement

`src/cli/command.ts` defines `ACCOUNT_TYPE_ALLOWLIST` as a `const` array but does not export it or derive a union type from it:

```ts
const ACCOUNT_TYPE_ALLOWLIST = [
  'BANK', 'CURRENT', ..., 'TERMLIAB',
] as const
```

The `AccountsCommand` interface in both `command.ts` and `accounts.ts` types `type` as `string | null`, not as `(typeof ACCOUNT_TYPE_ALLOWLIST)[number] | null`. This means:

1. The TypeScript type for `type` in `AccountsCommand` does not reflect the validated subset -- downstream code treating it as `string` has no compile-time hint that a limited set of values is valid.
2. The allowlist is defined in the CLI parsing layer but not accessible to the API layer (where it could prevent invalid OData queries at compile time).

## Required Fix

Export the allowlist and derive a type alias:
```ts
export const ACCOUNT_TYPE_ALLOWLIST = [...] as const
export type AccountType = (typeof ACCOUNT_TYPE_ALLOWLIST)[number]
```

Update `AccountsCommand.type` to `AccountType | null`. This gives downstream code type safety without runtime overhead.

## Acceptance Criteria

- [ ] `ACCOUNT_TYPE_ALLOWLIST` exported from `command.ts` or a shared constants module
- [ ] `AccountType` union type exported and used in `AccountsCommand`
- [ ] `accounts.ts` `AccountsCommand.type` uses `AccountType | null`

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
