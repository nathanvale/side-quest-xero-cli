---
status: complete
priority: p2
issue_id: "715"
tags: [crud, feature, agent-native]
dependencies: []
---

# Add payments read command for reconciliation audit trails

## Problem Statement

The CLI creates payments via `reconcile --execute` (PUT /Payments) but has no way to list or verify payments afterwards. CRUD Completeness scored **2/6 (33%)** -- adding a `payments` read command is the highest-value CRUD addition.

## Findings

- Payments entity: Create (via reconcile), Read (missing), Update (via reconcile), Delete (missing)
- No way to verify payments created during reconciliation
- Agents cannot audit what was created without checking Xero UI directly
- History command groups by contact/account but doesn't show individual payment records

## Proposed Solutions

### Option 1: Add `payments` command

**Approach:** New command `bun run xero-cli payments --json --since YYYY-MM-DD --fields PaymentID,Amount,Date,Invoice.InvoiceNumber,Account.Code`

**Pros:**
- Completes the reconciliation audit trail
- Enables agents to verify their own work
- Consistent with existing command patterns

**Cons:**
- New command to maintain
- Xero Payments API pagination needed

**Effort:** 2-3 hours

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] `payments` command with alias `pay`
- [ ] `--since` and `--until` date filters
- [ ] `--fields` projection support
- [ ] JSON output following existing envelope contract
- [ ] Pagination support

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- CRUD audit identified Payments.Read as highest-value missing operation
