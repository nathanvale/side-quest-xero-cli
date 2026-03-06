---
status: complete
priority: p1
issue_id: "082"
tags: [agent-native, reconcile, csv, dx]
dependencies: []
---

# SuggestedAccountCode vs AccountCode CSV column mismatch

## Problem Statement

The skill runbook (Step 9) and `/xero-review` command export uncertain transactions with a `SuggestedAccountCode` column. But `reconcile --from-csv` in `loadCsv()` reads `record.AccountCode`. The CSV round-trip is broken -- Nathan must manually rename the column header before re-importing.

## Findings

- `.claude/commands/xero-reconcile.md` Step 9 exports `SuggestedAccountCode`
- `.claude/commands/xero-review.md` line 19 lists `SuggestedAccountCode` in expected format
- `src/cli/commands/reconcile.ts` line 366 reads `record.AccountCode`
- The round-trip from export to re-import is broken without manual column rename

**Source:** DX Pass 2 (Critical issue #1)

## Proposed Solutions

### Option 1: Accept SuggestedAccountCode as alias in loadCsv

**Approach:** In `loadCsv()`, check for `record.SuggestedAccountCode` as a fallback when `record.AccountCode` is missing.

**Effort:** 5 minutes

**Risk:** None

### Option 2: Update skill and xero-review to use AccountCode

**Approach:** Change the export column name to `AccountCode` in both the skill runbook and xero-review command.

**Effort:** 10 minutes

**Risk:** Low (changes exported format)

### Option 3: Add export-uncertain CLI subcommand

**Approach:** CLI owns the CSV export with exact columns that `loadCsv` expects.

**Effort:** 1 hour

**Risk:** Low (most robust long-term)

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] CSV exported by skill/xero-review can be re-imported by `reconcile --from-csv` without manual editing
- [ ] Column name is consistent across export and import paths

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from DX Pass 2 (Critical issue #1)
- Confirmed loadCsv reads AccountCode, skill exports SuggestedAccountCode

### 2026-02-27 - Resolved via Option 1

**By:** Claude Code

**Actions:**
- In `loadCsv()` at `src/cli/commands/reconcile.ts` line 366, added `record.SuggestedAccountCode` as a fallback when `record.AccountCode` is missing/empty
- Change: `AccountCode: record.AccountCode || record.SuggestedAccountCode || undefined`
- CSV files exported with `SuggestedAccountCode` column can now be re-imported by `reconcile --from-csv` without manual header renaming
- Both `AccountCode` and `SuggestedAccountCode` column names are accepted on import
