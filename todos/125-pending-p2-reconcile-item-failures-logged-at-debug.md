---
status: complete
priority: p2
issue_id: "125"
tags: [logging, reconcile, observability]
dependencies: []
---

# Per-item reconcile failures logged at debug level instead of warn

## Problem Statement

At `reconcile.ts:1154`, per-item failures (network errors, API rejections) are logged at `debug` level. In default `info` mode, these failures are invisible on stderr. Also, HTTP 5xx retries at `api.ts:201` are logged at `info` instead of `warn`.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 3 TODO-402, TODO-403. Also Agent 2 TODO-316.

- `src/cli/commands/reconcile.ts:1154`: `reconcileLogger.debug('Failed {txnId}...')` -- should be `warn`
- `src/xero/api.ts:201`: `apiLogger.info('Retrying after HTTP {status}...')` for 5xx -- should be `warn`

## Proposed Solutions

Change log levels: per-item failures to `warn`, 5xx retries to `warn`.

## Acceptance Criteria

- [ ] Per-item reconcile failures logged at `warn` level
- [ ] 5xx retry attempts logged at `warn` level
- [ ] Debug reserved for verbose/trace information only

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Consolidated Agent 3 TODO-402, TODO-403 and Agent 2 TODO-316
