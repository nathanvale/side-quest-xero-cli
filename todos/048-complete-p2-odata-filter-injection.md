---
status: complete
priority: p2
issue_id: "048"
tags: [code-review, security]
dependencies: []
---

# OData Filter Injection via User-Controlled Strings

## Problem Statement

User-supplied `--contact`, `--account-code`, `--status`, and `--type` values are interpolated directly into Xero API `where` clause strings without sanitization. A crafted value like `--contact 'foo" || Status!="DELETED'` could manipulate the Xero OData filter.

## Findings

- **Source:** Security Sentinel (MEDIUM-1)
- **Files:** `src/cli/commands/history.ts` (219-225), `accounts.ts` (148-149), `invoices.ts` (156-161), `transactions.ts` (254-256)
- **Impact:** Limited blast radius (attacker already has auth tokens), but relevant in agent-native context where a compromised agent could craft queries to return unintended data sets.

## Proposed Solutions

### Option A: Regex validation on filter values
- Reject values containing double quotes, ampersands, pipe characters, and OData operators
- Pros: Simple, effective
- Cons: May be overly restrictive for legitimate values
- Effort: Small
- Risk: Low

### Option B: Allowlist validation per flag
- `--status`: Only known Xero statuses (AUTHORISED, PAID, DRAFT, etc.)
- `--type`: Only known Xero account/transaction types
- `--contact`: Alphanumeric + spaces + common punctuation
- Pros: Most secure, self-documenting
- Cons: Needs maintenance if Xero adds new statuses
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] `--contact 'foo" || 1==1'` returns a validation error, not injected query
- [x] All filter flags validated before interpolation
- [x] Tests for injection attempts

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Security Sentinel MEDIUM-1 |
| 2026-02-27 | Resolved: added `escapeODataValue` helper in `src/xero/odata.ts` | Reject-on-detect approach (throw on unsafe chars) is safer than silent escaping. Applied to history.ts, accounts.ts, invoices.ts. Tests in `tests/xero/odata.test.ts`. |
