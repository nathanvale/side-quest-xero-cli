---
status: complete
priority: p1
issue_id: "045"
tags: [api, performance, reconcile, n-plus-1]
dependencies: []
---

# N+1 API Calls in AccountCode Reconciliation Path

## Problem Statement

In `src/cli/commands/reconcile.ts`, for every input with an AccountCode (or InvoiceID), the reconcile loop made an individual GET `/BankTransactions/{id}` request to fetch the full record. A 1,000-item batch would generate 1,000 sequential API calls -- a classic N+1 pattern causing severe performance degradation and unnecessary rate-limit pressure.

## Findings

- The AccountCode path needed the full BankTransaction record for LineItems
- The InvoiceID path needed the full BankTransaction record for BankAccount.AccountID
- The invoice prefetch already used a batch pattern (`/Invoices?IDs=...`) but bank transactions did not
- Xero API supports the same `IDs` filter parameter on `/BankTransactions`

**Source:** Code review

## Solution Applied

### Batch prefetch with IDs filter parameter

**Approach:** Before the reconciliation loop, collect all unique BankTransactionIDs that need full records (those with AccountCode or InvoiceID). Fetch them in batches of 50 using the Xero `IDs` filter parameter (matching the existing invoice prefetch pattern). During reconciliation, look up from the prefetched Map instead of making individual requests.

**Changes:**
- Added `fetchBankTransactionsBatch()` function that fetches in chunks of 50
- Added prefetch step before the reconciliation loop
- Replaced both `fetchBankTransaction()` calls (AccountCode and InvoiceID paths) with Map lookups
- Added defensive error for missing prefetch entries

**Impact:** Reduces API calls from N to ceil(N/50). A 1,000-item batch goes from 1,000 calls to 20 calls.

**Effort:** 15 minutes | **Risk:** Low

## Acceptance Criteria

- [x] All BankTransaction records are batch-fetched before the reconciliation loop
- [x] No individual GET requests inside the loop for bank transaction records
- [x] Chunking at 50 IDs per request (matching invoice prefetch pattern)
- [x] Defensive error if a prefetched record is missing
- [x] TypeScript type checks pass

## Work Log

### 2026-02-27 - Implemented batch prefetch

**By:** Claude Code
**Actions:** Added `fetchBankTransactionsBatch()`, prefetch step, and replaced N+1 calls with Map lookups in both AccountCode and InvoiceID paths.
