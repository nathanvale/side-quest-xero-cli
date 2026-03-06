---
status: complete
priority: p1
issue_id: "700"
tags: [type-safety, api, zod, agent-contract]
dependencies: []
---

# xeroFetch falls back to bare `as T` cast when no schema is provided

## Problem Statement

`src/xero/api.ts` line 363 contains:

```ts
: (rawData as T)
```

When callers omit `schema`, the parsed JSON body is cast directly to `T` with no runtime validation. The schema field is optional, meaning any call site that forgets `schema:` silently bypasses the entire validation layer. This is the residual of TODO-118 (pending, round 2) -- the infra exists but the fallback remains a bare cast.

## Affected Call Sites Without Schema

From audit of all `xeroFetch<...>` call sites, the following pass **no** `schema` option:

1. `accounts.ts:80` -- `xeroFetch<AccountsResponse>` -- no schema
2. `contacts.ts:67` -- `xeroFetch<ContactsResponse>` -- no schema
3. `invoices.ts:99` -- `xeroFetch<InvoicesResponse>` -- no schema
4. `reconcile.ts:513` -- `fetchAccounts` -- `xeroFetch<AccountsResponse>` -- no schema
5. `reconcile.ts:625` -- `fetchInvoices` -- `xeroFetch<InvoicesResponse>` -- no schema
6. `reconcile.ts:652` -- `createPayments` -- `xeroFetch<PaymentsResponse>` -- no schema

The validated call sites (BankTransactions paths) correctly pass `BankTransactionsResponseSchema`.

## Impact

If Xero returns an unexpected shape (API version change, wrong envelope), the code silently proceeds with `undefined` fields. For the reconcile path this can cause:
- `response.Accounts ?? []` passes validation but `account.Code` is undefined -- `accountCodes` Set contains `undefined`
- `response.Invoices ?? []` iterates but `invoice.InvoiceID` is undefined -- `invoicesById` keyed by `undefined` (NaN key)
- `response.Payments ?? []` passes `assertValidPaymentResponse` but with wrong fields

## Required Fix

Define Zod schemas for `AccountsResponse`, `ContactsResponse`, `InvoicesResponse`, `PaymentsResponse` in `src/xero/types.ts` and pass them to all `xeroFetch` call sites. The `schema` field should remain optional for backward compatibility but callers must explicitly opt in.

Alternatively: make `schema` required in `XeroFetchOptions<T>` (breaking change, but enforces at compile time).

## Acceptance Criteria

- [ ] `AccountsResponse`, `ContactsResponse`, `InvoicesResponse`, `PaymentsResponse` have Zod schemas
- [ ] All six unschemed call sites pass a validated schema
- [ ] Response shape mismatch throws `XeroApiError` with `E_MALFORMED_RESPONSE` and field-level `details`
- [ ] No `as T` cast remains reachable at runtime for any production call path

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor

**Actions:**
- Identified six xeroFetch call sites missing runtime schema validation
- Confirmed BankTransactions paths are correctly validated (these are NOT affected)
- Confirmed TODO-118 (round 2) is the parent finding -- this TODO narrows it to the exact unschemed call sites
