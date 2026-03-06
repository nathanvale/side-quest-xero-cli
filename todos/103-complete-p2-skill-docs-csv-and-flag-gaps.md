---
status: complete
priority: p2
issue_id: "103"
tags: [agent-native, docs, skill, csv, flags]
dependencies: []
---

# Document CSV fallback column, date flag conflicts, and missing flags

## Problem Statement

Several medium-severity gaps in skill docs:

1. **SuggestedAccountCode CSV fallback** -- `--from-csv` accepts `SuggestedAccountCode` as fallback for `AccountCode` but this is undocumented
2. **Date range flag conflicts** -- `--this-quarter/--last-quarter` cannot combine with `--since/--until` but docs only say "mutually exclusive shortcuts"
3. **Missing flags** -- `--events-url` and `--help` missing from global flags table
4. **No consolidated flag table** -- flags are scattered across command sections

## Findings

- command-reference.md line 116: --from-csv documented but no column name details
- command-reference.md lines 49-55: "mutually exclusive" but doesn't cover cross-flag restrictions
- command-reference.md lines 7-14: global flags table missing --events-url and --help

## Proposed Fix

1. Add CSV column format section with both AccountCode and SuggestedAccountCode
2. Add explicit conflict rules to date filter section
3. Add missing flags to global flags table

**Effort:** 15 minutes

## Acceptance Criteria

- [x] CSV section documents both AccountCode and SuggestedAccountCode columns
- [x] Date filter section explicitly states --this-quarter/--last-quarter cannot combine with --since/--until
- [x] --events-url added to global flags table
- [x] --help added to global flags table

## Work Log

- **2026-02-27** -- All four acceptance criteria resolved in command-reference.md: added CSV column names section under reconcile, added date conflict rules under transactions, added --events-url and --help to global flags table.
