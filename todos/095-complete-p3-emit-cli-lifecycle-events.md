---
status: complete
priority: p3
issue_id: "095"
tags: [agent-native, observability, events, cli]
dependencies: []
---

# Emit CLI lifecycle events for command usage tracking

## Problem Statement

The observability server has no visibility into which CLI commands are run, how often, or how they exit. This data would power:

- Usage dashboards (which commands does Nathan actually use?)
- Error rate tracking (which commands fail most?)
- Session patterns (typical command sequences during tax reconciliation)
- Agent vs human usage breakdown (JSON mode = agent, human mode = Nathan)

## Proposed Events

| Event | When | Payload |
|-------|------|---------|
| `xero-cli-started` | CLI entry point | `{ command, mode (json/human/quiet), args (sanitized) }` |
| `xero-cli-completed` | CLI exit | `{ command, exitCode, durationMs, mode }` |
| `xero-cli-error` | Unhandled error | `{ command, error, exitCode }` |

These complement the existing `cliLogger.info()` calls added in TODO 091 -- the logger writes to stderr for humans, the events go to the dashboard.

## Insertion Points

- `src/cli/command.ts` -- `runCli()` already tracks command name, start time, and exit code for logging
- The same data can be passed to `emitEvent()` with zero additional computation

## Effort

10 minutes

## Risk

None

## Acceptance Criteria

- [x] `xero-cli-started` emitted at CLI entry with command name and mode
- [x] `xero-cli-completed` emitted at CLI exit with exit code and duration
- [x] No sensitive data in payloads (no tokens, no file paths)
- [x] Agent mode (`--json`) distinguishable from human mode in events

## Work Log

### 2026-02-27 - Filed from observability brainstorm

**By:** Claude Code

### 2026-02-27 - Implemented CLI lifecycle events

**By:** Claude Code

Added `emitEvent` calls to `src/cli/command.ts`:
- `xero-cli-started` emitted after command parsing with `{ command, mode }` payload
- `xero-cli-completed` emitted on all three exit paths (success, interrupt, error) with `{ command, exitCode, durationMs, mode }` payload
- Mode resolved via `resolveMode()` helper: `'json'` / `'quiet'` / `'human'`
- No sensitive data included in any payload
