---
status: complete
priority: p3
issue_id: "719"
tags: [capability-discovery, ux, agent-native]
dependencies: []
---

# Add first-run onboarding / GETTING_STARTED.md

## Problem Statement

No welcome message or first-run guidance exists. Setup guide only appears when auth fails via `printSetupGuide()`. Users must already know to run `status` or `auth` to learn how to start.

## Findings

- Capability Discovery scored 75% -- empty state guidance scored 2/5
- No GETTING_STARTED.md or root-level onboarding doc
- Status command checks show what's missing but don't guide newcomers

## Proposed Solutions

### Option 1: Create GETTING_STARTED.md + first-run detection

**Approach:** Root-level getting started doc + CLI detects first run (no .xero-config.json) and prints setup steps.

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] GETTING_STARTED.md with step-by-step setup
- [ ] CLI prints setup hint on first run (no config detected)
- [ ] Linked from README.md

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Capability Discovery audit identified missing first-run guidance
