---
status: complete
priority: p2
issue_id: "135"
tags: [auth, output, agent-contract]
dependencies: []
---

# Headless auth_url phase emitted via raw process.stdout.write, not writeSuccess

## Problem Statement

In the headless PKCE flow, the `auth_url` phase envelope is constructed and written manually at `auth.ts:681-687` using `process.stdout.write`, bypassing `writeSuccess`. If the envelope shape changes (e.g., adding `runId` or `meta` field), the auth_url phase silently diverges.

## Findings

Discovered by reliability audit swarm round 2 (2026-03-06), Agent 1 TODO-206.

- `src/xero/auth.ts:681-687`: manual envelope replicating `writeSuccess` structure
- No `sanitizeContextValue` applied to `authUrl`
- TODO-075 (complete) standardized headless auth contract but may not have addressed this specific envelope construction

## Proposed Solutions

Use `writeSuccess` or a shared envelope factory for the auth_url phase write.

## Acceptance Criteria

- [ ] auth_url phase uses `writeSuccess` or shared envelope factory
- [ ] Envelope shape matches all other writeSuccess outputs
- [ ] authUrl passes through sanitization

## Work Log

### 2026-03-06 - Filed from audit swarm round 2

**By:** Claude Code

**Actions:**
- Filed from Agent 1 TODO-206
