---
status: complete
priority: p3
issue_id: "717"
tags: [context-injection, status, agent-native]
dependencies: []
---

# Add availableScopes to status check output

## Problem Statement

Agents must infer available OAuth scopes from error payloads (`scopeRequired`, `scopeMissing`). The status command doesn't proactively report which scopes are authorized. This forces reactive discovery instead of proactive preflight checking.

## Findings

- Context Injection scored **47/50 (94%)** -- this is a minor gap
- Scopes hardcoded in auth.ts but not queryable via CLI
- `error.scopeMissing` only surfaces on API call failure
- Would help agents avoid Finance API scope errors upfront

## Proposed Solutions

### Option 1: Add scopes check to status command

**Approach:** New check: `{ name: "scopes", status: "ok", authorizedScopes: [...] }`

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] Status command includes `scopes` check
- [ ] `authorizedScopes` array in status data
- [ ] Agents can preflight-check before attempting scope-restricted APIs

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Context Injection audit identified scope visibility as minor gap (1 point)
