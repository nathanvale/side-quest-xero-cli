---
status: complete
priority: p1
issue_id: "100"
tags: [agent-native, docs, skill, exit-codes, error-handling]
dependencies: []
---

# Document exit codes and machine-readable action values in skill

## Problem Statement

The xero-cli skill docs (`error-handling.md`) list error codes with prose descriptions but omit two critical pieces agents need:

1. **Exit codes** -- 7 exit codes exist (0, 1, 2, 3, 4, 5, 130) but none are documented
2. **Machine-readable `action` values** -- `FIX_ARGS`, `RUN_AUTH`, `WAIT_AND_RETRY`, etc. exist in `ERROR_CODE_ACTIONS` but docs only have prose like "Fix arguments"

Without these, agents can't programmatically interpret exit codes or use the action hints in error envelopes.

## Findings

- `src/cli/output.ts:9-19` -- defines EXIT_OK(0), EXIT_RUNTIME(1), EXIT_USAGE(2), EXIT_NOT_FOUND(3), EXIT_UNAUTHORIZED(4), EXIT_CONFLICT(5), EXIT_INTERRUPTED(130)
- `src/cli/output.ts:49-68` -- defines ERROR_CODE_ACTIONS with 15 code-to-action mappings
- `error-handling.md` has the error codes table but no exit code column and no action values

## Proposed Fix

Add exit code column to existing error codes table and add a new "Action Values" section to `error-handling.md`.

**Effort:** 15 minutes

## Acceptance Criteria

- [x] All 7 exit codes documented with meaning
- [x] All ERROR_CODE_ACTIONS values documented (FIX_ARGS, RUN_AUTH, WAIT_AND_RETRY, etc.)
- [x] Error codes table includes exit code mapping
- [x] Agent can programmatically map exit code to recovery strategy

## Work Log

- **2026-02-27** -- Added Exit Codes table (7 codes), Machine-Readable Action Values table (10 actions), and Exit Code column to existing Error Codes table in `error-handling.md`.
