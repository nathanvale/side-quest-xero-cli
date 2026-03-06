---
status: complete
priority: p1
issue_id: "701"
tags: [type-safety, auth, zod, runtime-validation]
dependencies: []
---

# `parseJsonSafely<T>` casts before Zod -- callers receive unvalidated `T`

## Problem Statement

`src/xero/auth.ts` lines 121-130:

```ts
function parseJsonSafely<T>(raw: string, fallbackMessage: string): T {
  try {
    return JSON.parse(raw) as T   // <-- bare cast
  } catch {
    throw new XeroAuthError(fallbackMessage, ...)
  }
}
```

The function is called at two sites:
1. **Line 134**: `parseKeychainOutput` -- immediately follows with Zod validation via `TokenSchema.safeParse`. This is safe.
2. **Line 178**: `readKeychain` (XERO_TEST_TOKENS branch) -- also followed by `TokenSchema.safeParse`. This is safe.

However, the function signature promises `T` to callers without any runtime enforcement. Any future caller that passes a different `T` and omits the follow-up Zod check will receive an unvalidated, potentially malformed object typed as `T`.

The design is fragile: type safety depends on every caller remembering to re-validate after calling `parseJsonSafely`. The function name implies safety it does not provide.

## Contrast with Auth's `parseJsonResponse`

`parseJsonResponse<T>` (lines 372-404) correctly accepts a `z.ZodType<T>` schema and validates inside. `parseJsonSafely` should follow the same pattern or be eliminated in favor of `parseJsonResponse`.

## Required Fix

Replace `parseJsonSafely<T>` with a variant that requires a schema parameter, or inline the JSON.parse + Zod.safeParse pattern at each call site (only two). The current callers already have the schema available (`TokenSchema`).

```ts
// Option A: require schema inline
function parseJsonValidated<T>(
  raw: string,
  schema: z.ZodType<T>,
  fallbackMessage: string,
): T { ... }
```

## Acceptance Criteria

- [ ] `parseJsonSafely` removed or replaced with a schema-required variant
- [ ] No bare `JSON.parse(...) as T` pattern remains in auth.ts
- [ ] Both keychain read sites validate token shape in a single function call

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
