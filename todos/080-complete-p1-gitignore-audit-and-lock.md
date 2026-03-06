---
status: complete
priority: p1
issue_id: "080"
tags: [agent-native, security, gitignore]
dependencies: []
---

# .xero-reconcile-runs/ and lock file not in .gitignore

## Problem Statement

The `.gitignore` includes `.xero-reconcile-state.json` but NOT `.xero-reconcile-runs/` or `.xero-reconcile-lock.json`. The audit NDJSON files contain BankTransactionIDs, AccountCodes, InvoiceIDs, and PaymentIDs -- financial data that should never be committed to the repository.

## Findings

- `.gitignore` has `.xero-reconcile-state.json` but missing:
  - `.xero-reconcile-runs/` (audit trail with financial data)
  - `.xero-reconcile-lock.json` (process lock file)
- A `git add .` or `git add -A` would commit financial data
- Two-line addition to `.gitignore`

**Source:** Security Pass 2 (Critical issue #2)

## Proposed Solutions

### Option 1: Add to .gitignore

**Approach:** Add both entries to `.gitignore`.

**Effort:** 2 minutes

**Risk:** None

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] `.xero-reconcile-runs/` in `.gitignore`
- [ ] `.xero-reconcile-lock.json` in `.gitignore`
- [ ] Existing `.xero-reconcile-state.json` entry unchanged

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from Security Pass 2 (Critical issue #2)
- Confirmed state file is already gitignored but runs dir and lock file are not

### 2026-02-27 - Resolved

**By:** Claude Code

**Actions:**
- Added `.xero-reconcile-runs/` to `.gitignore` (audit trail directory with financial data)
- Added `.xero-reconcile-lock.json` to `.gitignore` (process lock file)
- Both entries placed adjacent to existing `.xero-reconcile-state.json` entry
- Existing entries unchanged
