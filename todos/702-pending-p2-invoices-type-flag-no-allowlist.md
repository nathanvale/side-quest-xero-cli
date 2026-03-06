---
status: complete
priority: p2
issue_id: "702"
tags: [validation, invoices, agent-contract, allowlist]
dependencies: []
---

# `invoices --type` flag not validated against an allowlist

## Problem Statement

`src/cli/command.ts` applies `ACCOUNT_TYPE_ALLOWLIST` validation for the `accounts --type` flag (lines 416-428), but the `invoices --type` and `invoices --status` flags at lines 519-531 pass the raw string value directly through with no allowlist check:

```ts
if (commandToken === 'invoices') {
  const { fields, error } = parseFields(fieldsRaw, json, quiet)
  if (error) return error
  return {
    ok: true,
    options: {
      command: 'invoices',
      ...outputMode,
      status: statusRaw,   // <-- no allowlist
      type: typeRaw,       // <-- no allowlist
      fields,
    },
  }
}
```

The Xero Invoices API has a fixed set of valid `Status` values (`DRAFT`, `SUBMITTED`, `DELETED`, `AUTHORISED`, `PAID`, `VOIDED`) and `Type` values (`ACCREC`, `ACCPAY`). Arbitrary strings produce a generic 400 error from Xero with no agent-readable code to distinguish `E_USAGE` from `E_REQUEST_ERROR`.

## Impact

An agent constructing invoice queries with a typo (e.g., `--status AUTHORIZED` vs `AUTHORISED`) receives only a raw Xero 400 error body, not a structured `E_USAGE/FIX_ARGS` hint. The agent cannot self-correct without re-querying help.

## Contrast

The `accounts` command validates type against `ACCOUNT_TYPE_ALLOWLIST` and returns:
```json
{ "action": "FIX_ARGS", "validValues": [...], "errorFamily": "validation" }
```

## Required Fix

Define `INVOICE_STATUS_ALLOWLIST` and `INVOICE_TYPE_ALLOWLIST` constants in `command.ts` and validate `statusRaw` and `typeRaw` before building the options object.

```ts
const INVOICE_STATUS_ALLOWLIST = ['DRAFT', 'SUBMITTED', 'DELETED', 'AUTHORISED', 'PAID', 'VOIDED'] as const
const INVOICE_TYPE_ALLOWLIST = ['ACCREC', 'ACCPAY'] as const
```

## Acceptance Criteria

- [ ] `--status` validated against `INVOICE_STATUS_ALLOWLIST`
- [ ] `--type` validated against `INVOICE_TYPE_ALLOWLIST`
- [ ] Invalid value returns `ParseCliError` with `errorCode: 'E_USAGE'` and `validValues` in context
- [ ] Agent receives `action: 'FIX_ARGS'` for typos

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor

**Note:** TODO-134 mentions "accounts.ts --type not validated against allowlist" but the accounts path IS guarded in command.ts. The invoices --type and --status paths are the actual gaps.
