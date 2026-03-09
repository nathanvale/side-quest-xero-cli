---
status: complete
priority: p3
issue_id: "720"
tags: [tools-as-primitives, documentation, agent-native]
dependencies: []
---

# Document invoices default filter (AUTHORISED) explicitly in help and output

## Problem Statement

The `invoices` command silently defaults to `Status=="AUTHORISED"` when no filter is specified. This hidden business policy means agents may not realize they're only seeing authorized invoices. The default should be explicit and discoverable.

## Findings

- Tools as Primitives audit classified invoices as WORKFLOW due to hidden default
- User may not realize they're only seeing authorized invoices
- No indication in output that a filter was applied

## Proposed Solutions

### Option 1: Add appliedFilters to output + document in help

**Approach:** Include `appliedFilters: { status: "AUTHORISED (default)" }` in JSON output. Add to help text.

**Effort:** 30 minutes

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] JSON output includes `appliedFilters` showing active defaults
- [ ] Help text documents the default filter
- [ ] Agent can detect when default was applied vs explicit filter

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Tools as Primitives audit identified hidden default in invoices command
