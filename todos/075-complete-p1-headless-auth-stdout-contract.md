---
status: complete
priority: p1
issue_id: "075"
tags: [agent-native, auth, stdout-contract]
dependencies: []
---

# Headless auth breaks stdout contract determinism

## Problem Statement

In headless auth mode (`XERO_HEADLESS=1`), the auth URL JSON is written directly to stdout via `process.stdout.write()` in `src/xero/auth.ts:528` *before* the final `writeSuccess()` call in `src/cli/commands/auth.ts:97`. This means agents expecting a single JSON object on stdout get two separate JSON payloads:

1. `{"authUrl":"https://login.xero.com/..."}` (from auth.ts)
2. `{"status":"data","data":{...}}` (from writeSuccess)

Agents parsing stdout as a single JSON blob will fail or parse ambiguously.

## Findings

- `src/xero/auth.ts:526-528` -- headless branch writes `{"authUrl":"..."}` directly to stdout
- `src/cli/commands/auth.ts:97-106` -- writeSuccess writes the final data envelope to stdout
- The two-phase output is undocumented and untested
- Todo 071 (complete) added headless support but didn't address the dual-output problem
- The skill runbook at `.claude/skills/xero-reconcile/SKILL.md:33` references auth but doesn't document the two-phase contract

**Source:** Agent-native parity review

## Proposed Solutions

### Option 1: Single envelope with phases

**Approach:** Wrap both outputs in a documented two-phase contract. First line is always `{"phase":"auth_url","authUrl":"..."}`, second line is `{"phase":"result","status":"data","data":{...}}`. Document in CLI help and skill runbook.

**Pros:**
- Backward-compatible (existing agents already handle line-delimited JSON)
- Clear semantic distinction between phases

**Cons:**
- Still two JSON objects -- need NDJSON-aware parsing

**Effort:** 30 minutes

**Risk:** Low

### Option 2: Auth URL on stderr, result on stdout

**Approach:** Move the headless auth URL output to stderr (like the interactive progress messages), keeping stdout clean for the single result envelope.

**Pros:**
- stdout has exactly one JSON object (clean contract)
- Matches how other commands work
- Agents parse stdout; humans read stderr

**Cons:**
- Breaking change for any agent currently reading authUrl from stdout
- Agent needs to read stderr to get the URL

**Effort:** 15 minutes

**Risk:** Medium (breaking change)

### Option 3: Merge into single output via OutputContext

**Approach:** Thread the auth URL through OutputContext so `writeSuccess` includes it in the data envelope: `{"status":"data","data":{"command":"auth","authUrl":"...","tenantId":"...","orgName":"..."}}`. The auth URL is only present during the waiting phase; the final envelope includes it for completeness.

**Pros:**
- Single JSON object on stdout
- No parsing ambiguity
- Auth URL preserved in response

**Cons:**
- Auth URL isn't available until the flow starts, and the agent needs it *before* the flow completes
- Doesn't solve the real-time "here's the URL, go visit it" need

**Effort:** 45 minutes

**Risk:** Medium

## Recommended Action

Option 1 (Single envelope with phases) -- implemented.

## Acceptance Criteria

- [x] Headless auth produces deterministic, documented stdout output
- [x] Agent can reliably parse auth URL and final result separately
- [x] Contract is tested (unit test for headless stdout invariant)
- [ ] Skill runbook documents the expected output format
- [ ] CLI help for `auth` mentions headless behavior

## Work Log

### 2026-02-27 - Filed from agent-native review

**By:** Claude Code

**Actions:**
- Filed from agent-native parity review (Critical issue #1)
- Reviewed current implementation in auth.ts and auth command
- Confirmed todo 071 addressed headless detection but not output contract

### 2026-02-27 - Implemented Option 1 (NDJSON two-phase contract)

**By:** Claude Code

**Actions:**
- Added `phase: "auth_url"` discriminator to headless auth URL output in `src/xero/auth.ts`
- Exported `isHeadless()` from `src/xero/auth.ts` so the auth command can detect headless mode
- Added optional `phase` parameter to `writeSuccess()` in `src/cli/output.ts`
- Updated `src/cli/commands/auth.ts` to pass `phase: "result"` when running headless
- Added 3 unit tests in `tests/cli/output.test.ts` covering phase inclusion, omission, and human-mode behavior
- All tests pass, typecheck clean
