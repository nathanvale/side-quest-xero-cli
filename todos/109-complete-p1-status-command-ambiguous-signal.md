---
status: complete
priority: p1
issue_id: "109"
tags: [cli, status, agent-contract, output]
dependencies: []
---

# Status command emits data envelope on stdout with non-OK exit codes

## Problem Statement

`runStatus` always calls `writeSuccess` (producing a `status: 'data'` envelope on stdout) even when it returns non-OK exit codes (`EXIT_UNAUTHORIZED=4`, `EXIT_USAGE=3`, `EXIT_RUNTIME=1`). This breaks the three-channel contract: error exit codes should be accompanied by a structured error envelope on stderr, not a data envelope on stdout.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 5.

- `src/cli/commands/status.ts:286-294` - `writeSuccess` is called unconditionally, then exit code is derived from `diagnosis` string
- An agent running `status --json` that gets exit code 4 receives `{"status":"data",...}` on stdout -- not `{"status":"error",...}` on stderr
- The `diagnosis` field and `nextAction` values are inside the data payload but not surfaced as structured errors
- Contrast with all other commands which use `writeError` for failure paths

## Proposed Solutions

### Option 1: Emit both data and error envelopes for non-OK status

**Approach:** For non-OK diagnosis values, call `writeError` on stderr with the diagnosis as context, in addition to (or instead of) `writeSuccess`. The data payload remains useful for debugging, but the error envelope provides the machine-actionable signal.

**Effort:** 30 minutes

**Risk:** Low -- additive change, existing data envelope preserved

### Option 2: Restructure to only emit error envelope on failure

**Approach:** For non-OK diagnosis, skip `writeSuccess` and emit only `writeError` with the status data embedded in context.

**Effort:** 30 minutes

**Risk:** Medium -- changes existing output shape for status command

## Recommended Action

Option 1. Agents can still consume the data payload while getting a proper error signal.

## Acceptance Criteria

- [ ] Non-OK diagnosis produces a structured error envelope on stderr
- [ ] Error envelope includes `diagnosis` and `nextAction` as context fields
- [ ] Exit code matches the diagnosis severity
- [ ] Add test: `status --json` with `needs-auth` diagnosis produces both data on stdout and error on stderr

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 5 identified this as a HIGH severity contract violation
- Only the status command has this pattern; all other commands use `writeError` for failure paths
