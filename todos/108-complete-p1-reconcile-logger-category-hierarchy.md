---
status: complete
priority: p1
issue_id: "108"
tags: [logging, logtape, reconcile]
dependencies: []
---

# Reconcile logger category breaks xero.cli.* hierarchy

## Problem Statement

The reconcile command logger uses `getXeroLogger(['reconcile'])` which resolves to `['xero', 'reconcile']`, placing it outside the `xero.cli.*` subtree that all other CLI command loggers use. Any agent or tooling filtering on `xero.cli.*` silently drops all reconcile logs.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 3.

- `src/cli/commands/reconcile.ts:39` - `const reconcileLogger = getXeroLogger(['reconcile'])`
- All other CLI commands use `getXeroLogger(['cli', '<command>'])`:
  - `auth.ts:17` -> `['xero', 'cli', 'auth']`
  - `accounts.ts:37` -> `['xero', 'cli', 'accounts']`
  - `contacts.ts:41` -> `['xero', 'cli', 'contacts']`
  - `transactions.ts:126` -> `['xero', 'cli', 'transactions']`
  - `history.ts:95` -> `['xero', 'cli', 'history']`
  - `invoices.ts:45` -> `['xero', 'cli', 'invoices']`
  - `status.ts:50` -> `['xero', 'cli', 'status']`
- Reconcile is the only outlier: `['xero', 'reconcile']`

## Proposed Solutions

### Option 1: One-line fix

**Approach:** Change `getXeroLogger(['reconcile'])` to `getXeroLogger(['cli', 'reconcile'])`.

**Effort:** 5 minutes

**Risk:** Low

## Recommended Action

Option 1. Trivial fix.

## Acceptance Criteria

- [ ] `reconcileLogger` category resolves to `['xero', 'cli', 'reconcile']`
- [ ] All CLI command loggers share the `xero.cli.*` subtree

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 3 mapped the full logger category tree and identified the asymmetry
- Confirmed this is a copy-paste error, not an intentional design choice
