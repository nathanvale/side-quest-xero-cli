---
status: complete
priority: p2
issue_id: "705"
tags: [type-safety, config, zod, runtime-validation]
dependencies: []
---

# `loadXeroConfig` calls `JSON.parse` without catching SyntaxError before Zod

## Problem Statement

`src/xero/config.ts` line 62:

```ts
const raw = await readFile(configPath, 'utf8')
const parsed = XeroConfigSchema.safeParse(JSON.parse(raw))
```

`JSON.parse(raw)` is called without a try/catch. If `.xero-config.json` is corrupted (partial write, truncation, invalid UTF-8 sequences), `JSON.parse` throws a `SyntaxError`. This SyntaxError:
- Is not a `XeroApiError` or `XeroAuthError` -- it bypasses the structured error taxonomy
- Bubbles through `handleCommandError` as a plain `Error` with `E_RUNTIME/ESCALATE`
- Gives an agent no actionable recovery hint (should be `E_UNAUTHORIZED` with `nextCommand: 'auth'`)

## Contrast with Round 2 Fix

TODO-112 (complete) fixed malformed JSON in `api.ts` response handling. `config.ts` was not addressed.

## Required Fix

Wrap `JSON.parse` in a try/catch:
```ts
let parsed: unknown
try {
  parsed = JSON.parse(raw)
} catch {
  throw new XeroAuthError('Corrupted config file. Re-auth required.', {
    code: 'E_UNAUTHORIZED',
    recoverable: false,
    context: { configPath },
  })
}
const validated = XeroConfigSchema.safeParse(parsed)
```

## Acceptance Criteria

- [ ] Corrupted `.xero-config.json` produces `XeroAuthError` with `code: 'E_UNAUTHORIZED'`
- [ ] Agent receives `action: 'RUN_AUTH'` hint
- [ ] Context includes `configPath` for diagnostics

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
