---
status: complete
priority: p2
issue_id: "112"
tags: [api, auth, resilience, errors]
dependencies: []
---

# Malformed API response and CSV parse errors unhandled

## Problem Statement

`response.json()` calls in both API and auth layers are unguarded -- a malformed response (HTML maintenance page, truncated JSON) throws `SyntaxError` that gets classified as `E_RUNTIME` or `E_NETWORK`, misleading agents. CSV parse errors in reconcile also escape as plain `Error`.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agents 2, 6.

- **M5 (Agent 6): Unguarded `response.json()`** - `api.ts:229` and `auth.ts:343,369,390` all call `response.json() as T` without try/catch. A `SyntaxError` from non-JSON response body gets misclassified.
- **M4 (Agent 2): CSV re-throw without structured hint** - `reconcile.ts:706-712` catches CSV parse errors and re-throws without wrapping. Agents get `E_RUNTIME / ESCALATE` instead of `E_USAGE / FIX_ARGS`.

## Proposed Solutions

### Option 1: Wrap all `response.json()` + CSV re-throw

**Approach:**
1. Wrap `response.json()` in try/catch at all call sites. On `SyntaxError`, throw `XeroApiError` with new `E_MALFORMED_RESPONSE` code and `recoverable: false`.
2. Add `E_MALFORMED_RESPONSE` to `ERROR_CODE_ACTIONS` with `action: 'ESCALATE'` and context including URL + status.
3. Wrap CSV re-throw: `throw new XeroApiError(msg, { code: 'E_USAGE', recoverable: false })`.

**Effort:** 45 minutes

**Risk:** Low

## Acceptance Criteria

- [ ] All `response.json()` calls wrapped with structured error on `SyntaxError`
- [ ] `E_MALFORMED_RESPONSE` registered in `ERROR_CODE_ACTIONS`
- [ ] CSV parse errors produce `E_USAGE` code
- [ ] Add test: HTML response body produces `E_MALFORMED_RESPONSE`
- [ ] Add test: CSV missing column produces `E_USAGE`

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 6 identified 4 unguarded `response.json()` sites
- Agent 2 identified CSV re-throw gap
