---
status: complete
priority: p1
issue_id: "084"
tags: [agent-native, types, reconcile]
dependencies: []
---

# BankTransactionRecord defined 3 times with different shapes

## Problem Statement

`BankTransactionRecord` (or equivalent bank transaction types) are defined in 3 different places with subtly different shapes. This creates type drift where code compiled against one definition silently accepts/rejects fields from another.

## Findings

- Multiple type definitions for bank transaction records across the codebase
- Shapes differ in which fields are required vs optional
- No single canonical source of truth
- Subtle bugs possible when passing records between modules expecting different shapes

**Source:** Architect Pass 1 (Critical issue #3)

## Proposed Solutions

### Option 1: Consolidate to single canonical type

**Approach:** Define one `BankTransactionRecord` type in a shared location (e.g., `src/xero/types.ts`) and import everywhere. Use `Pick<>` or `Omit<>` for narrower views.

**Effort:** 45 minutes

**Risk:** Low (type-only refactor, no runtime changes)

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [x] Single canonical `BankTransactionRecord` type definition
- [x] All usages import from the canonical location
- [x] TypeScript compiler catches shape mismatches
- [x] No runtime behavior changes

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from Architect Pass 1 (Critical issue #3)
- Identified 3 separate definitions with different shapes

### 2026-02-27 - Consolidated to canonical types

**By:** Claude Code

**Actions:**
- Created `src/xero/types.ts` with canonical `BankTransactionRecord`, `LineItemRecord`, and `BankTransactionsResponse` types
- The canonical type is a superset of all fields from the 3 previous definitions (transactions.ts, reconcile.ts, history.ts)
- Removed local `BankTransactionRecord` from `src/cli/commands/transactions.ts` (had `Date?`, `Reference?`, `Contact?` but lacked `LineItems`, `BankAccount`, etc.)
- Removed local `BankTransactionRecord` from `src/cli/commands/history.ts` (had `CurrencyCode?`, simpler `LineItems` shape but lacked `BankAccount`, validation fields)
- Removed local `BankTransactionRecord`, `LineItemRecord`, `BankTransactionsResponse` from `src/cli/commands/reconcile.ts` (had `BankTransactionID` as required string, validation fields, but lacked `Date?`, `Reference?`, `Contact?`, `CurrencyCode?`)
- Updated all three files to import from `../../xero/types`
- Renamed local `TransactionsResponse` usages to `BankTransactionsResponse` for consistency
- Verified: tsc --noEmit passes with 0 errors, biome lint clean
