---
status: complete
priority: p1
issue_id: "118"
tags: [api, type-safety, agent-contract, zod]
dependencies: []
---

# xeroFetch casts API responses with `as T` -- no runtime validation

## Problem Statement

`xeroFetch<T>` at `src/xero/api.ts:237` casts JSON responses directly to `T` with a bare type assertion. Every API call trusts that Xero returns the expected shape. A renamed field, new envelope, or missing array silently corrupts output. TODO-112 (complete) addressed malformed JSON (SyntaxError from `response.json()`), but did not add schema validation for the parsed shape.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agents 5, 6.

- **Agent 6 TODO-700:** `data = (await response.json()) as T` -- no Zod schema enforcement
- **Agent 6 TODO-719:** Callers use `response.BankTransactions ?? []` but don't guard against non-array values (`"string" ?? []` returns `"string"`)
- **Agent 5 TODO-609:** `fetchConnections` response not validated -- missing/wrong-shaped array crashes with unstructured TypeError
- **Agent 6 TODO-701:** `ConnectionResponse[]` typed but not validated at runtime
- **Agent 6 TODO-712:** `ConnectionResponse` interface fields (`tenantId`, `tenantName`) not verified before writing to config

All `xeroFetch<...>` call sites affected: accounts, contacts, transactions, history, invoices, reconcile, auth connections.

## Proposed Solutions

### Option A: Optional Zod schema in xeroFetch (recommended)
Add `schema?: ZodSchema<T>` to `XeroFetchOptions`. When present, call `schema.parse(data)` after JSON parse. Callers opt in incrementally. Start with highest-risk endpoints (reconcile, connections).

### Option B: Type guard functions per response type
Define `isValidBankTransactionsResponse(data): data is BankTransactionsResponse` guards. More manual, no library dependency.

### Option C: Response envelope wrapper
Create a `ValidatedResponse<T>` that enforces validation at construction time.

## Recommended Action

Option A. Add `schema` to `XeroFetchOptions`, validate when provided, throw `XeroApiError` with `E_MALFORMED_RESPONSE` on mismatch. Define Zod schemas for all response types in `src/xero/types.ts`.

## Acceptance Criteria

- [ ] `XeroFetchOptions` accepts optional `schema: ZodSchema<T>`
- [ ] When schema provided, `xeroFetch` validates parsed response and throws `E_MALFORMED_RESPONSE` on mismatch
- [ ] `ConnectionResponse[]` validated with Zod before use in auth flow
- [ ] `BankTransactionsResponse` validated in reconcile fetch path
- [ ] All list command response types have Zod schemas defined
- [ ] Agent receives structured error with field-level mismatch details on validation failure

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 6 TODO-700, TODO-701, TODO-709, TODO-712, TODO-719 and Agent 5 TODO-609
- Verified TODO-112 (complete) only addressed SyntaxError, not shape validation
