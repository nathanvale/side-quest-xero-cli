---
status: complete
priority: p1
issue_id: "081"
tags: [agent-native, output, fields, dx]
dependencies: []
---

# --fields typos silently produce undefined values

## Problem Statement

`projectFields` in `src/cli/output.ts:123-145` returns `undefined` for misspelled field names with no warning. `--fields Contcat.Name` silently produces `{"Contcat.Name": undefined}` in JSON output. For agents, this is a silent data-loss bug -- reconciliation decisions get made on incomplete data.

## Findings

- `src/cli/output.ts:123-145` -- `projectFields` returns undefined for non-existent paths
- `parseFields()` (line 1656-1671 in command.ts) validates character set but not field existence
- Available fields vary per command, so parse-time validation isn't possible
- Post-projection scan is needed: if all records have undefined for a field, it's likely a typo

**Source:** DX Pass 1 (Critical issue #1)

## Proposed Solutions

### Option 1: Warn on all-undefined fields

**Approach:** After projection, scan results. If all records have `undefined` for a field, emit a warning on stderr: `"Warning: field 'Contcat.Name' was undefined in all records. Check spelling."` For JSON mode, include a `warnings` array in the envelope.

**Pros:**
- Catches the most common error (complete misspelling vs sparse data)
- Warnings go to stderr, don't break JSON on stdout
- Agent gets `warnings` array in JSON envelope

**Cons:**
- Doesn't catch partial misspellings (where some records have the field)

**Effort:** 30 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] Misspelled field names produce a stderr warning
- [ ] JSON mode includes `warnings` array in envelope when fields are all-undefined
- [ ] Correctly-spelled fields with legitimately undefined values don't trigger false warnings
- [ ] Test covers typo detection

## Work Log

### 2026-02-27 - Filed from 7-pass review

**By:** Claude Code

**Actions:**
- Filed from DX Pass 1 (Critical issue #1)
- Confirmed projectFields returns undefined silently for bad paths

### 2026-02-27 - Implemented typo detection

**By:** Claude Code

**Actions:**
- Added `detectAllUndefinedFields()` to `src/cli/output.ts` -- scans projected records and returns warning strings for fields that are undefined in ALL records
- Modified `writeSuccess()` to accept optional `warnings` parameter -- includes `warnings` array in JSON envelope, emits to stderr in human/quiet modes
- Updated all 4 command files (accounts, invoices, transactions, history) to detect and pass warnings after projection
- Added 15 tests in `tests/cli/output.test.ts` covering: typo detection, no false positives on partial undefined, empty records, multiple typos, full pipeline integration, JSON envelope warnings, human mode stderr warnings, quiet mode stderr warnings
