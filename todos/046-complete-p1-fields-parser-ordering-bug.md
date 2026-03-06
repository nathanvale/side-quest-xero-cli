---
status: complete
priority: p1
issue_id: "046"
tags: [code-review, bug]
dependencies: []
---

# --fields Flag Rejected for history and invoices Commands

## Problem Statement

The CLI parser checks `if (fieldsRaw)` and returns a usage error BEFORE it reaches the `history` and `invoices` command branches. This means `--fields` works for `accounts` and `transactions` (checked earlier) but is always rejected for `history` and `invoices` -- even though the error message itself claims those commands support it.

## Findings

- **Source:** TypeScript Reviewer, Agent-Native Reviewer, Architecture Strategist (all three independently confirmed)
- **File:** `src/cli/command.ts` (lines 512-518)
- **Evidence:** The `fieldsRaw` guard runs before `history` (line 519) and `invoices` branches. The `runHistory` and `runInvoices` functions correctly implement field projection, but never receive non-null fields from the parser.
- **SKILL.md impact:** The agent skill recommends `--fields` for all list commands but it fails at runtime for history/invoices.

## Resolution

Applied Option A: moved the `fieldsRaw` guard below the `history` and `invoices` command branches so all four list commands (accounts, transactions, history, invoices) can use `--fields`. The guard still rejects `--fields` for non-list commands (reconcile, help, auth, status).

Also exported `parseCli` to enable direct parser-level unit tests and added 6 new tests covering --fields acceptance/rejection for all relevant commands.

## Acceptance Criteria

- [x] `bun run xero-cli history --since 2025-01-01 --fields Contact,Count --json` works
- [x] `bun run xero-cli invoices --fields InvoiceID,Total --json` works
- [x] Test coverage for --fields with all list commands

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Confirmed by 3 independent reviewers |
| 2026-02-27 | Fixed: moved fieldsRaw guard after history/invoices branches | Ordering-dependent guards are fragile; parser tests catch these regressions |
