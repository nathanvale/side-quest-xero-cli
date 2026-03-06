---
status: complete
priority: p2
issue_id: "133"
tags: [cli, output, status, agent-contract]
dependencies: []
---

# status command still emits dual write (success + error) for non-ok diagnosis

## Problem Statement

Despite TODO-109 (complete) fixing the data-envelope-with-error-exit pattern, `runStatus` still emits `writeSuccess` followed by `writeError` when `diagnosis !== 'ok'`. In JSON mode, agents receive two JSON objects per invocation: success on stdout + error on stderr. The stdout line carries `diagnosis: 'needs-auth'` with a success envelope while stderr carries `E_UNAUTHORIZED` -- contradictory signals.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 1 TODO-200. Also Agent 2 TODO-309.

- `src/cli/commands/status.ts:276-310`: `writeSuccess` then `writeError` for non-ok
- `writeError` context lacks failing check details -- agent can't identify which check failed
- No other command uses this dual-write pattern

## Proposed Solutions

1. Emit only one envelope: either success with `warnings[]` or error-only
2. Include `failingChecks` array in error context

## Acceptance Criteria

- [ ] Single envelope per invocation in JSON mode
- [ ] Failing check details included in error context
- [ ] Exit code matches the single envelope type

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 1 TODO-200 and Agent 2 TODO-309
- Verified TODO-109 may not have fully resolved -- needs code verification
