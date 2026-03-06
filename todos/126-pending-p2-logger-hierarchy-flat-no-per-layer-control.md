---
status: complete
priority: p2
issue_id: "126"
tags: [logging, observability, configuration]
dependencies: []
---

# Logger hierarchy is flat -- no independent per-layer log level control

## Problem Statement

LogTape configuration registers a single sink for category `['xero']`. Every logger from every layer (api, auth, cli) shares one configured level. There is no way to independently tune `xero.api` vs `xero.cli.reconcile` without changing `XERO_LOG_LEVEL` globally. A debug request for reconcile detail floods with API wire logs.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 3 TODO-400.

- `src/logging.ts:98-109`: single `{ category: ['xero'], sinks: ['stderr'], lowestLevel: ... }`
- No sub-category entries for `['xero', 'api']`, `['xero', 'auth']`, `['xero', 'cli']`

## Proposed Solutions

Add per-subtree logger entries driven by env vars:
- `XERO_LOG_LEVEL_API` (default: fallback to `XERO_LOG_LEVEL`)
- `XERO_LOG_LEVEL_AUTH`
- `XERO_LOG_LEVEL_CLI`

## Acceptance Criteria

- [ ] Per-layer log level env vars supported with fallback
- [ ] `configure()` registers sub-category entries for api, auth, cli
- [ ] Documented in CLI help/skill docs

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Filed from Agent 3 TODO-400
