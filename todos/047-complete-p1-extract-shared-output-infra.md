# 047 - Extract Shared Output Infrastructure

**Status:** complete
**Priority:** P1
**Category:** refactor / DRY

## Problem

OutputContext, ExitCode, ERROR_CODE_ACTIONS, writeSuccess/Error, projectFields, and error catch patterns were copy-pasted identically across 8 files. Command-level catch blocks had inconsistent agent error metadata and missing sanitization.

## Resolution

Created `src/cli/output.ts` as the single source of truth for all CLI output infrastructure:

- **ExitCode type and constants** - EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_UNAUTHORIZED, EXIT_CONFLICT, EXIT_INTERRUPTED
- **OutputContext interface** - using the concrete EventsConfig type instead of typeof import
- **ERROR_CODE_ACTIONS** - complete mapping (15 entries) shared across all commands (previously command files had incomplete 4-entry subsets)
- **writeSuccess()** - generic success output with JSON/human/quiet modes
- **writeError()** - structured error output with built-in sanitization (previously missing from command-level catches)
- **projectFields()** - dot-path field projection for list commands
- **sanitizeErrorMessage()** - token/secret redaction (previously only in command.ts)
- **handleCommandError()** - standardized catch handler that maps StructuredError subclasses to exit codes with consistent agent metadata

### Files changed

- `src/cli/output.ts` - NEW shared output module
- `src/cli/command.ts` - removed ~170 LOC of duplicated definitions, imports from output.ts
- `src/cli/commands/accounts.ts` - removed ~100 LOC, imports from output.ts, uses handleCommandError
- `src/cli/commands/auth.ts` - removed ~70 LOC, imports from output.ts, uses handleCommandError
- `src/cli/commands/history.ts` - removed ~100 LOC, imports from output.ts, uses handleCommandError
- `src/cli/commands/invoices.ts` - removed ~100 LOC, imports from output.ts, uses handleCommandError
- `src/cli/commands/transactions.ts` - removed ~100 LOC, imports from output.ts, uses handleCommandError
- `src/cli/commands/reconcile.ts` - removed ~60 LOC, imports from output.ts, uses handleCommandError for outer catch
- `src/cli/commands/status.ts` - removed ~20 LOC, imports from output.ts

### Improvements over prior state

1. **Consistent ERROR_CODE_ACTIONS** - all commands now use the full 15-entry mapping instead of a 4-entry subset
2. **Sanitization in all error paths** - writeError() now always sanitizes, so command-level catches can't leak tokens
3. **StructuredError coverage** - handleCommandError catches the base StructuredError class too, not just the three subclasses
4. **Single maintenance point** - changes to output format, error codes, or sanitization rules only need updating in one file
