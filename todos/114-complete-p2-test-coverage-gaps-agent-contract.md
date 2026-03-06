---
status: complete
priority: p2
issue_id: "114"
tags: [tests, coverage, agent-contract]
dependencies: ["104", "105", "106", "107"]
---

# Test coverage gaps for agent contract invariants

## Problem Statement

28 distinct test gaps identified across the audit. The most critical gaps leave agent-facing contracts unverified -- guards exist in code but are untested, meaning regressions would be silent.

## Findings

Discovered by reliability audit swarm (2026-03-06), all 6 agents.

**Critical test gaps (no coverage at all):**
1. Reconcile `--json` stdout purity (Agents 1, 5)
2. `withContext`/`getLogContext` AsyncLocalStorage plumbing (Agent 3)
3. 429 `Retry-After` exhaustion -- `retryAfterMs` in envelope (Agent 6)
4. Auth `fetch` timeout producing structured error (Agent 6)
5. Malformed JSON response handling (Agent 6)
6. `E_LOCK_CONTENTION` error type from `acquireLock()` (Agent 2)
7. Event payload completeness for reconcile/auth events (Agent 4)
8. `ERROR_CODE_ACTIONS` completeness test (Agent 2)

**Fixture gaps:**
9. `headless: false` missing from `quietCtx()` in `output.test.ts` (Agents 1, 5)
10. `isHeadless()` TTY-dependent assertions skipped in CI (Agent 6)

**Timing-fragile tests:**
11. `events.test.ts` uses 60ms fixed sleep instead of fake timers (Agents 3, 4)

**Untested logging paths:**
12. `XERO_LOG_LEVEL` env override (Agent 3)
13. `shouldUseFingersCrossed` and JSON sink selection (Agent 3)
14. `setupLogging` failure path in JSON mode (Agents 1, 3)

## Proposed Solutions

### Option 1: Add tests incrementally alongside fixes

**Approach:** Each fix todo (104-113) includes acceptance criteria with test requirements. This todo tracks the cross-cutting gaps that don't belong to a specific fix.

**Effort:** 3-4 hours for all gaps

**Risk:** Low

## Acceptance Criteria

- [ ] `quietCtx()` includes `headless: false`
- [ ] `isHeadless()` tests use `Object.defineProperty` for TTY control
- [ ] `events.test.ts` uses `vi.useFakeTimers()` instead of 60ms sleep
- [ ] `withContext`/`getLogContext` tested for `runId` propagation
- [ ] `XERO_LOG_LEVEL` env override tested for all 3 values
- [ ] `ERROR_CODE_ACTIONS` completeness test exists
- [ ] `emitEvent` max-attempts bounding test exists

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Consolidated 28 test gaps from 6 audit agents
- Prioritized by contract criticality (agent-facing invariants first)
- Noted that many gaps are covered by acceptance criteria in fix todos 104-113
