---
status: complete
priority: p1
issue_id: "138"
tags: [events, reconcile, agent-contract]
dependencies: []
---

# xero-reconcile-started event emitted twice per run with conflicting totals

## Problem Statement

`xero-reconcile-started` fires at line 702 with `total: 0` (before inputs loaded) and again at line 902 with the actual `totalCount`. Event consumers see two contradictory start events per run. An agent using events for progress tracking gets a wrong denominator from the first emission.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 1, 2, 3, 4 (TODO-201, TODO-300, TODO-403, TODO-505).

- `src/cli/commands/reconcile.ts:702-706`: first emit with `total: 0`
- `src/cli/commands/reconcile.ts:902-906`: second emit with correct total
- The first emission was likely added to satisfy "emit before preflight" from round 2, but the second was not removed

## Proposed Solutions

Remove the first emission at line 702. Keep only the authoritative one at line 902.

## Acceptance Criteria

- [x] `xero-reconcile-started` fires exactly once per run
- [x] Event payload includes correct `totalCount`

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated across 4 agents -- all independently flagged the double emission

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Removed the early `xero-reconcile-started` emit with `total: 0`
- Kept a single authoritative started event with computed `totalCount`
