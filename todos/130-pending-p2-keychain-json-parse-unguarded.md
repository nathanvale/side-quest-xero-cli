---
status: complete
priority: p2
issue_id: "130"
tags: [auth, validation, error-handling]
dependencies: []
---

# parseKeychainOutput JSON.parse throws SyntaxError before Zod validation

## Problem Statement

`parseKeychainOutput` at `auth.ts:109` calls `JSON.parse(raw) as StoredTokens` before Zod validation. If the keychain contains binary garbage or truncated JSON, a native `SyntaxError` propagates as an unhandled exception bypassing the structured `XeroAuthError` path. The `as StoredTokens` cast is also unnecessary since Zod accepts `unknown`.

Same pattern in `XERO_TEST_TOKENS` env var parsing.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 2 TODO-312, Agent 5 TODO-608, Agent 6 TODO-706, TODO-707, TODO-718.

- `src/xero/auth.ts:109`: `JSON.parse(raw) as StoredTokens` -- unguarded
- `src/xero/auth.ts:148`: `JSON.parse(process.env.XERO_TEST_TOKENS)` -- same pattern
- `src/xero/auth.ts:490`: refresh lock JSON also parsed without guard (Agent 6 TODO-708)

## Proposed Solutions

1. Wrap `JSON.parse` in try/catch, throw `XeroAuthError('Corrupted tokens in Keychain. Re-auth required.', { code: 'E_UNAUTHORIZED' })`
2. Remove `as StoredTokens` cast -- pass `unknown` to `TokenSchema.safeParse`
3. Add type guard for refresh lock JSON before `isProcessAlive` call

## Acceptance Criteria

- [ ] `parseKeychainOutput` catches `SyntaxError` and throws `XeroAuthError`
- [ ] `XERO_TEST_TOKENS` parse catches `SyntaxError` with structured error
- [ ] `as StoredTokens` cast removed -- Zod validates from `unknown`
- [ ] Refresh lock JSON validated before pid access

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated across 3 agents: Agent 2 TODO-312, Agent 5 TODO-608, Agent 6 TODO-706/707/708/718
