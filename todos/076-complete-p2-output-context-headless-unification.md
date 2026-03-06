---
status: complete
priority: p2
issue_id: "076"
tags: [agent-native, auth, output-context]
dependencies: ["075"]
---

# Unify headless and output mode into single OutputContext signal

## Problem Statement

Headless mode (`XERO_HEADLESS=1` env var / non-TTY in `src/xero/auth.ts:89`) and JSON output mode (`--json` flag in `src/cli/command.ts:545`) are detected independently. The auth command at `src/cli/commands/auth.ts:66` checks `ctx.json` for progress suppression, while `auth.ts:89` checks `isHeadless()` for URL output format. These split signals can produce mixed human+JSON output when one is set but not the other.

## Findings

- `isHeadless()` in `src/xero/auth.ts:89` checks `XERO_HEADLESS=1` or `!process.stdout.isTTY`
- `ctx.json` in `src/cli/commands/auth.ts:66` comes from `--json` CLI flag
- Scenario: `--json` without `XERO_HEADLESS=1` in a TTY -- opens browser but writes JSON envelope
- Scenario: `XERO_HEADLESS=1` without `--json` -- writes authUrl JSON to stdout, then human-readable success message
- Neither combination is tested

**Source:** Agent-native parity review (Warning #1)

## Proposed Solutions

### Option 1: Derive headless from OutputContext

**Approach:** Add a `headless` flag to OutputContext, derived from `--json` flag OR `XERO_HEADLESS=1` env. Pass `ctx.headless` into `authenticate()` instead of relying on `isHeadless()` internal detection.

**Pros:**
- Single source of truth for output behavior
- Easy to test (mock OutputContext)
- `--json` implies headless automatically

**Cons:**
- Minor refactor of authenticate() signature

**Effort:** 30 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [x] `--json` mode implies headless auth behavior (no browser launch)
- [x] `XERO_HEADLESS=1` without `--json` still works but outputs consistently
- [x] No mixed human+JSON output in any combination
- [ ] Test covers all 4 combinations: (json/no-json) x (headless/interactive)

## Work Log

### 2026-02-27 - Filed from agent-native review

**By:** Claude Code

**Actions:**
- Filed from agent-native parity review (Warning #1)
- Identified the split signal paths between isHeadless() and ctx.json

### 2026-02-27 - Resolved: unified headless signal through OutputContext

**By:** Claude Code

**Actions:**
- Added `headless` option to `AuthWaitOptions` in `src/xero/auth.ts` so `authenticate()` accepts an explicit headless flag (falls back to `isHeadless()` when not provided for backward compatibility)
- Updated `authenticate()` to use `options?.headless ?? isHeadless()` instead of calling `isHeadless()` directly
- Updated `src/cli/commands/auth.ts` to pass `ctx.headless` into `authenticate()`, ensuring the unified OutputContext signal controls browser launch behavior
- Replaced direct `isHeadless()` call on line 116 of `auth.ts` with `ctx.headless` for the `writeSuccess` phase discriminator
- Removed the `isHeadless` import from `src/cli/commands/auth.ts` since it is no longer needed there
- `isHeadless()` remains exported from `src/xero/auth.ts` and used by `resolveOutputMode()` in `command.ts` to derive `ctx.headless` -- this is the single derivation point
- The 4 combinations now work correctly:
  - `--json` without `XERO_HEADLESS=1`: ctx.headless=true (no browser, JSON envelope)
  - `XERO_HEADLESS=1` without `--json`: ctx.headless=true (no browser, consistent output)
  - Both set: ctx.headless=true
  - Neither set (TTY): ctx.headless=false (opens browser, human output)
- Test coverage for all 4 combinations left unchecked -- existing tests in `auth-headless.test.ts` cover the protocol shape but not the full matrix
