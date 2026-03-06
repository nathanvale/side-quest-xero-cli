---
status: complete
priority: p2
issue_id: "144"
tags: [reconcile, errors, validation]
dependencies: []
---

# parseJsonInput stdin JSON.parse unguarded -- SyntaxError becomes E_RUNTIME

## Problem Statement

`reconcile.ts:238` calls `JSON.parse(raw)` without try/catch. Malformed JSON from stdin produces `SyntaxError` that maps to `E_RUNTIME/ESCALATE` instead of `E_USAGE/FIX_ARGS`. An agent piping bad JSON gets no actionable hint.

## Findings

Discovered by reliability audit swarm round 3 (2026-03-06), Agents 2, 4 (TODO-308, TODO-503).

## Proposed Solutions

Wrap `JSON.parse` in `parseJsonInput` with try/catch, throw `XeroApiError` with `E_USAGE`.

## Acceptance Criteria

- [x] Malformed stdin JSON produces `E_USAGE/FIX_ARGS` error
- [x] Error message includes parse failure detail

## Work Log

### 2026-03-06 - Filed from audit swarm round 3

**By:** Claude Code

**Actions:**
- Consolidated Agent 2 TODO-308 and Agent 4 TODO-503

### 2026-03-06 - Resolved

**By:** Codex

**Actions:**
- Wrapped stdin JSON parse in `parseJsonInput` with `try/catch`
- Malformed stdin JSON now maps to `XeroApiError` with `E_USAGE`
