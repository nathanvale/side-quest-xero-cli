---
status: complete
priority: p3
issue_id: "716"
tags: [ui-integration, observability, agent-native]
dependencies: []
---

# Emit per-page progress events for list commands

## Problem Statement

List commands (accounts, contacts, invoices, transactions, history) fetch paginated results silently. No per-page progress events are emitted. Agents cannot monitor "how far" through a large result set.

## Findings

- UI Integration scored **16/20 (80%)**
- Pagination loops have no visible feedback
- Only `xero-list-completed` emitted at end, not per-page
- Token refresh during pagination is also silent

## Proposed Solutions

### Option 1: Emit `xero-list-page-fetched` event per page

**Approach:** Add event emission in pagination loop: `{ page, pageSize, totalSoFar }`

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] `xero-list-page-fetched` event emitted per pagination page
- [ ] Event payload includes page number, pageSize, totalSoFar
- [ ] Events are fire-and-forget (no performance impact)

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- UI Integration audit identified silent pagination as anti-pattern
