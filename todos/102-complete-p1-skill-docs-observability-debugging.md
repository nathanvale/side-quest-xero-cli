---
status: complete
priority: p1
issue_id: "102"
tags: [agent-native, docs, skill, observability, debugging]
dependencies: []
---

# Document observability and debugging workflow in skill

## Problem Statement

The skill docs mention `--verbose` and `--debug` flags but don't explain:

1. What they actually do (stderr logging behavior, log levels)
2. The fingers-crossed pattern (auto-debug on failure without `--debug`)
3. The `--events-url` flag for observability server integration
4. The recommended agent debugging workflow
5. The three-tier output architecture (stdout/stderr/events)

Agents have no guidance on how to diagnose failures or enable telemetry.

## Findings

- command-reference.md lines 12-13: `--verbose` and `--debug` listed but not explained
- `--events-url` completely absent from all skill docs
- No mention of fingers-crossed sink behavior
- No mention of JSON Lines log format on stderr in agent mode
- `src/logging.ts` implements the full observability stack

## Proposed Fix

Add an "Observability & Debugging" section to SKILL.md or a new reference file covering:
- Three-tier output architecture
- Flag-to-level mapping table
- Fingers-crossed behavior explanation
- `--events-url` flag and env vars (XERO_EVENTS_URL, XERO_EVENTS=0)
- Recommended debugging workflow for agents

**Effort:** 20 minutes

## Acceptance Criteria

- [x] `--events-url` flag documented with env var alternatives
- [x] Three-tier output architecture explained (stdout/stderr/events)
- [x] Fingers-crossed behavior documented (auto-debug on failure)
- [x] Agent debugging workflow documented (normal -> auto-trace -> explicit --debug)
- [x] `XERO_EVENTS_URL` and `XERO_EVENTS=0` env vars documented

## Work Log

### 2026-02-27

Added "Observability and Debugging" section to SKILL.md before the "Safety Rules" section. Covers:
- Three-tier output architecture table (stdout/stderr/events)
- Flag-to-level mapping table (none, --quiet, --verbose, --debug)
- Fingers-crossed pattern explanation (buffered logs flushed on error)
- Events via --events-url with XERO_EVENTS_URL and XERO_EVENTS=0 env vars
- Agent debugging workflow (normal -> proactive -> deep)
- Log format details (human TTY vs agent JSON Lines, XERO_LOG_FORMAT override)
