---
status: complete
priority: p3
issue_id: "718"
tags: [prompt-native, documentation, agent-native]
dependencies: []
---

# Extract Zod schemas to a skill reference doc

## Problem Statement

Reconcile input validation schemas (Zod) are hardcoded in reconcile.ts. Agents must read source code to understand validation rules. A skill reference doc would make schemas visible without code access.

## Findings

- UUID shape regex, account code regex, mutual exclusivity rules all in code
- Agents can't discover valid input shapes without reading reconcile.ts
- Prompt-Native Features scored 68% -- this would push toward 75%

## Proposed Solutions

### Option 1: Create xero-cli/references/input-schemas.md

**Approach:** Document the Zod schemas as YAML/JSON specs in a skill reference file.

**Effort:** 30 minutes

**Risk:** Low (documentation only, must stay in sync)

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] Input schema reference doc created
- [ ] ReconcileItemSchema documented with field types and constraints
- [ ] Mutual exclusivity rules documented (AccountCode vs InvoiceID)

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Prompt-Native audit identified Zod schemas as code-defined features that could be prompt-native
