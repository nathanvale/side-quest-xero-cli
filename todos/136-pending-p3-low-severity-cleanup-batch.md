---
status: complete
priority: p3
issue_id: "136"
tags: [cleanup, docs, minor]
dependencies: []
---

# Low-severity cleanup batch

## Problem Statement

Collection of low-severity findings from audit swarm round 2 that can be addressed as polish work.

## Findings

### Output
1. **accounts.ts missing `satisfies` type annotation** (Agent 1 TODO-203): inconsistent with other list commands
2. **reconcile `reportResult` fires when progressMode=off** (Agent 1 TODO-204): minor channel contamination
3. **help command emits unstructured text on stdout** (Agent 1 TODO-207): mitigated by auto-detect

### Logging
4. **`shouldUseFingersCrossed` uses raw CLI flag, not effective level** (Agent 3 TODO-411): can double-output
5. **Logger category missing `commands` segment** (Agent 3 TODO-412): naming convention not documented
6. **`parseKeychainOutput` no warn before throw** (Agent 3 TODO-413): reduces diagnostic context
7. **`xero-fetch-completed` missing contentLength** (Agent 3 TODO-414): latency attribution gap

### State
8. **Sync fs calls in async functions** (Agent 4 TODO-509, TODO-510): `existsSync`, `lstatSync` block event loop
9. **Lock/state paths CWD-relative** (Agent 4 TODO-511): not XDG-compliant (also Agent 5 TODO-607)
10. **Audit file zero-byte on crash** (Agent 4 TODO-512): minor nuisance

### Auth/API
11. **OAuth callback missing Cache-Control** (Agent 5 TODO-612): browser may cache
12. **AUTH_TIMEOUT_MS not configurable** (Agent 5 TODO-613): hardcoded 5 minutes
13. **transactions page not validated >= 1** (Agent 5 TODO-614): page=-1 silently empty
14. **isTokenExpired 5-min skew not documented** (Agent 5 TODO-615): intentional but undocumented
15. **OData escapeODataValue blocklist vs allowlist** (Agent 6 TODO-714): weaker security model
16. **sanitizeCliOptions double-cast** (Agent 6 TODO-716): type escape hatch
17. **Token written to env var visible in /proc on Linux** (Agent 5 TODO-611): macOS-only currently

## Acceptance Criteria

- [ ] Items addressed as convenient during related work
- [ ] No individual item is blocking

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Batched all ~20 low-severity findings into single tracking todo
