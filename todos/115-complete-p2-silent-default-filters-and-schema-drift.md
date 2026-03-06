---
status: complete
priority: p2
issue_id: "115"
tags: [cli, output, agent-contract]
dependencies: []
---

# Silent default filters and schema drift risks

## Problem Statement

Some commands apply default filters or expand date ranges without surfacing this in the output envelope. Agents receive partial data without knowing a filter was applied. Additionally, `SCHEMA_VERSION_OUTPUT` is duplicated and the error envelope shape diverges from documentation.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agents 1, 5.

- **M3 (Agent 5): Invoices default filter** - `invoices.ts:82-84` silently applies `Status=="AUTHORISED"` when no `--status` flag. No `appliedFilters` field in output.
- **M4 (Agent 5): Transactions `--summary` date expansion** - `transactions.ts:159-163` silently expands to this-quarter. No `resolvedSince`/`resolvedUntil` in output.
- **M1 (Agent 1): Error envelope shape diverges from docs** - Actual: `{ status, message, error: { name, code, action } }`. Expected: `{ ok, error: { code, message, hint? } }`. Neither `ok` field nor `error.message` exist.
- **L3 (Agent 1): `SCHEMA_VERSION_OUTPUT` duplicated** - Both `output.ts:23` and `auth.ts:21` define `const SCHEMA_VERSION_OUTPUT = 1` independently.
- **L2 (Agent 5): Field casing inconsistency** - Accounts uses camelCase, reconcile uses PascalCase in output payloads.

## Proposed Solutions

### Option 1: Add metadata fields, fix duplication, document actual envelope

**Approach:**
1. Add `appliedFilters` to invoices success envelope when default filter active
2. Add `resolvedSince`/`resolvedUntil` to transactions summary output
3. Export `SCHEMA_VERSION_OUTPUT` from `output.ts`, import in `auth.ts`
4. Update skill docs to match actual error envelope shape (or add `ok` shim)

**Effort:** 1.5 hours

**Risk:** Low

## Acceptance Criteria

- [ ] Invoices output includes `appliedFilters` when default filter used
- [ ] Transactions summary output includes resolved date range
- [ ] `SCHEMA_VERSION_OUTPUT` exported from single source
- [ ] Error envelope shape documented accurately in skill docs
- [ ] Add test: invoices with no `--status` includes `appliedFilters` in envelope

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 5 identified silent filter issues
- Agent 1 identified schema version duplication and envelope shape divergence
