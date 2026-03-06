---
status: complete
priority: p1
issue_id: "104"
tags: [cli, output, agent-contract, logging]
dependencies: []
---

# Structured output channel purity violations

## Problem Statement

Multiple code paths write unstructured text to stdout/stderr in JSON mode, breaking the agent-facing contract that stdout carries only JSON envelopes and stderr carries only structured diagnostics.

## Findings

Discovered by reliability audit swarm (2026-03-06), corroborated across 4 independent agents.

- **`console.error` in `setupLogging`** - `src/logging.ts:116` writes raw `console.error('[xero] Failed to configure logging:', err)` bypassing structured output. Raw `err` object is not redacted -- potential token leak to stderr. Corroborated by Agents 1, 3, 5, 6.
- **`printSetupGuide()` unguarded** - `src/cli/commands/auth.ts:59-62` writes multi-line human text to stderr unconditionally before `writeError`. In JSON mode, agents see unparseable text before the structured envelope. Corroborated by Agents 1, 5.
- **Reconcile `reportResult` on stdout** - `src/cli/commands/reconcile.ts:872` writes per-item progress lines to `process.stdout` in non-JSON/non-quiet mode. Should use `process.stderr` since stdout is reserved for the terminal envelope. Corroborated by Agents 1, 5.

## Proposed Solutions

### Option 1: Fix all three call sites directly

**Approach:**
1. `logging.ts:116` - Replace `console.error` with structured JSON write when in JSON mode, or sanitize the error: `sanitizeErrorMessage(String(err))`
2. `auth.ts:59-62` - Gate `printSetupGuide()` with `if (!ctx.json && !ctx.quiet)`
3. `reconcile.ts:872` - Change `process.stdout.write(...)` to `process.stderr.write(...)`

**Effort:** 30 minutes

**Risk:** Low

### Option 2: Add a channel-enforcement wrapper

**Approach:** Create a `safeWrite(channel, content, ctx)` helper that enforces the contract at write time, then migrate all raw writes.

**Effort:** 2 hours

**Risk:** Medium (larger change surface)

## Recommended Action

Option 1 -- direct fixes. These are small, isolated changes.

## Technical Details

**Affected files:**
- `src/logging.ts:116`
- `src/cli/commands/auth.ts:59-62`
- `src/cli/commands/reconcile.ts:860-875`

## Acceptance Criteria

- [ ] No `console.log`/`console.error`/`console.warn` calls in `src/` except guarded fallbacks
- [ ] `printSetupGuide()` only called when `!ctx.json && !ctx.quiet`
- [ ] `reportResult` writes to `process.stderr`, not `process.stdout`
- [ ] Add test: reconcile `--json` stdout contains only valid JSON lines
- [ ] Add test: `setupLogging` failure in JSON mode produces no unstructured stderr

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Identified 3 channel purity violations across 6 independent audit agents
- `logging.ts:116` is the only remaining `console.*` call in `src/`
- All findings corroborated by multiple agents

**Learnings:**
- The `setupLogging` path is especially dangerous because it's the error handler for the logging system itself -- no structured logger available
- Non-TTY auto-promotion to JSON mode means the reconcile stdout issue is currently masked in agent pipelines, but the guard is implicit and untested
