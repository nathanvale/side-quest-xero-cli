---
status: complete
priority: p2
issue_id: "134"
tags: [validation, auth, logging, security]
dependencies: []
---

# Miscellaneous medium-severity fixes (batch)

## Problem Statement

Collection of medium-severity findings that are individually small but collectively important for agent reliability.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), various agents.

### Validation gaps
1. **accounts.ts `--type` not validated against allowlist** (Agent 6 TODO-711): arbitrary strings pass through to Xero API, producing generic 400 errors instead of `E_USAGE` with `validValues`
2. **CSV Amount `Number()` NaN not caught early** (Agent 6 TODO-709): `Number('1,234.56')` returns NaN, Zod catches it but error message is not agent-friendly
3. **reconcile `parseJsonInput` double-cast** (Agent 6 TODO-705): `parsed as ReconcileInputBase[]` cast before Zod validation -- `validateInputs` should accept `unknown`
4. **`--auth-timeout` allows Infinity** (Agent 6 TODO-713): `Number.isFinite` check needed with range bounds

### Logging gaps
5. **Auth `authenticate()` no info log at URL presentation** (Agent 3 TODO-405): no log signal that browser was opened or URL emitted
6. **`refreshToken()` no start/end logging** (Agent 3 TODO-408): duration invisible, looks like a hang
7. **Events delivery final failure silent** (Agent 3 TODO-409): no warn on exhausted retries
8. **Auth interactive prompts bypass LogTape** (Agent 3 TODO-410): direct `process.stderr.write` breaks fingers-crossed buffering

### Security
9. **`validateCsvPath` called after `existsSync`** (Agent 6 TODO-710): filesystem probe before path validation
10. **API request headers not fully sanitized** (Agent 3 TODO-407): `init.headers` may contain unredacted auth

### State
11. **StateBatcher.flush() no concurrent flush guard** (Agent 4 TODO-507): double event emission possible
12. **AuditWriter not closed on flush error** (Agent 4 TODO-508): file handle leak on disk-full
13. **State file path hardcoded in reconcile.ts** (Agent 4 TODO-506): diverges from state.ts constant

## Acceptance Criteria

- [ ] Account type/invoice status validated against allowlists
- [ ] CSV Amount parsing handles locale formats with clear error
- [ ] `validateInputs` accepts `unknown` input type
- [ ] Auth timeout bounded (1-3600 seconds)
- [ ] Auth URL presentation logged at info level
- [ ] Token refresh logged with duration
- [ ] Events delivery final failure logged at warn
- [ ] `validateCsvPath` called before `existsSync`
- [ ] `init.headers` sanitized before logging
- [ ] StateBatcher guards against concurrent flush
- [ ] AuditWriter in finally block
- [ ] State path constant exported and reused

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Batched 13 medium-severity items from Agents 3, 4, 6 into single todo for efficiency
