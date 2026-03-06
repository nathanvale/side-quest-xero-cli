---
title: xero-cli test matrix
updated: 2026-02-26
---

# xero-cli test matrix

- Output envelope includes `schemaVersion` and structured errors
  - `tests/cli/command.test.ts`
- Reconcile input validation (duplicates, required fields)
  - `tests/xero/reconcile.test.ts`
- Reconcile response validation (BankTransaction/Payment)
  - `tests/xero/validators.test.ts`
- Reconcile integration flows (happy path, mixed failure, resume, stale, invoice batch, token refresh, dry-run)
  - `tests/xero/reconcile.integration.test.ts`
- Filesystem security (state/config perms + symlink rejection)
  - `tests/state/security.test.ts`
- History grouping and output
  - `tests/xero/history.test.ts`
