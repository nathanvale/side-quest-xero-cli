---
status: complete
priority: p2
issue_id: "077"
tags: [agent-native, auth, testing]
dependencies: ["075"]
---

# Add auth headless contract tests

## Problem Statement

There are no explicit tests for auth JSON-stream invariants in headless mode. The auth command's stdout behavior in headless mode is untested, meaning regressions in the output contract would go undetected.

## Findings

- `tests/cli/command.test.ts` has auth tests but none exercise headless mode
- The headless auth URL output (`{"authUrl":"..."}`) is not verified
- The interaction between headless URL output and final writeSuccess envelope is not tested
- Todo 071 added headless support without corresponding tests

**Source:** Agent-native parity review (Warning #2)

## Proposed Solutions

### Option 1: Add stdout capture tests for headless auth

**Approach:** Add test cases that:
1. Set `XERO_HEADLESS=1` and mock the OAuth flow
2. Capture all stdout writes
3. Assert the exact JSON structure(s) emitted
4. Verify no human-readable text leaks to stdout

**Effort:** 45 minutes

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [x] Test for headless auth verifies authUrl JSON on stdout
- [x] Test verifies final success envelope structure
- [x] Test confirms no stderr content leaks to stdout
- [x] Test for interactive mode verifies no JSON authUrl on stdout
- [x] Tests prevent regressions from future auth output changes

## Work Log

### 2026-02-27 - Filed from agent-native review

**By:** Claude Code

**Actions:**
- Filed from agent-native parity review (Warning #2)
- Confirmed no existing headless auth tests in command.test.ts

### 2026-02-27 - Implemented contract tests

**By:** Claude Code

**Actions:**
- Created `tests/cli/auth-headless.test.ts` with 14 tests across 5 describe blocks
- Tests cover: isHeadless() detection, phase 1 auth_url shape, phase 2 result envelope, full two-phase NDJSON contract, and interactive mode (no phase discriminator)
- Verified no human-readable text leaks to stdout in headless mode
- Verified stderr receives no JSON envelope fragments
- Verified interactive mode omits phase field entirely (not just undefined, key absent)
- All 14 tests passing
