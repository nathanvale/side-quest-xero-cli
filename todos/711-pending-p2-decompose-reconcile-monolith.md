---
status: pending
priority: p2
issue_id: "711"
tags: [architecture, tools-as-primitives, agent-native]
dependencies: []
---

# Decompose reconcile.ts monolith into engine/validator/session modules

## Problem Statement

`reconcile.ts` is 1554 lines, the largest file in the CLI. It tightly couples input validation, lock acquisition, API fetching, reconciliation logic, and audit trail recording into a single command handler. This violates the "Tools as Primitives" principle -- the command is a workflow, not a composable primitive.

## Findings

- Agent-native audit scored Tools as Primitives at **2/8 (25%)** -- the weakest principle
- `reconcile.ts` orchestrates: input parsing -> lock -> preflight fetch -> reconcile -> audit
- Cannot partially execute (e.g., "validate without reconciling")
- Cannot reuse reconciliation logic with different input/output formats
- Heavy side effects (state mutations, file I/O) make testing difficult

## Proposed Solutions

### Option 1: Vertical decomposition into focused modules

**Approach:** Split into `src/xero/reconcile/` directory with engine.ts, validator.ts, session.ts, parser.ts, types.ts. Command handler becomes a thin ~100-line orchestrator.

**Pros:**
- Each module is independently testable
- Engine logic reusable for future batch modes
- Clear separation of concerns

**Cons:**
- Significant refactor effort
- Risk of introducing bugs during extraction

**Effort:** 4-6 hours

**Risk:** Medium

### Option 2: Extract only pure functions, keep command structure

**Approach:** Move `validateReconcileInput`, `reconcileTransaction`, and audit logic into separate files but keep orchestration in reconcile.ts.

**Pros:**
- Less disruptive
- Testability improves for extracted functions

**Cons:**
- Doesn't fully solve composability
- reconcile.ts still large

**Effort:** 2-3 hours

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] reconcile.ts reduced to <200 lines (orchestration only)
- [ ] Validation, engine, session, parser in separate modules
- [ ] All existing tests pass
- [ ] New unit tests for extracted modules
- [ ] `bun run validate` passes

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Agent-native architecture audit identified reconcile.ts as the primary Tools as Primitives violation
- Scored 2/8 (25%) on the principle due to monolithic command handlers

**Learnings:**
- Only `accounts` and `contacts` qualify as true primitives currently
