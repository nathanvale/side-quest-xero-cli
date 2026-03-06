---
status: complete
priority: p2
issue_id: "116"
tags: [auth, state, concurrency]
dependencies: []
---

# Lock file path and refresh lock robustness

## Problem Statement

The refresh lock file is CWD-relative (defeating cross-directory concurrency protection) and the stale-lock cleanup swallows all errors including non-ENOENT failures.

## Findings

Discovered by reliability audit swarm (2026-03-06), Agent 6.

- **L2: Lock path is CWD-relative** - `auth.ts:399-401` uses `process.cwd()/${REFRESH_LOCK_FILE}`. Concurrent agent invocations from different directories get different lock files, making the mutex ineffective.
- **M3: Stale-lock cleanup swallows errors** - `auth.ts:428` catches all errors from `unlink()` including `EPERM`. Only `ENOENT` should be swallowed (benign race); real permission errors should propagate.

## Proposed Solutions

### Option 1: Stable lock path + error discrimination

**Approach:**
1. Move lock file to `os.tmpdir()` or `os.homedir()/.cache/xero-cli/`
2. In stale-lock cleanup catch, rethrow non-ENOENT errors

**Effort:** 30 minutes

**Risk:** Low

## Acceptance Criteria

- [ ] Lock file path is process-independent (not CWD-relative)
- [ ] Stale-lock cleanup only swallows ENOENT
- [ ] Add test: concurrent `loadValidTokens` from different CWDs share same lock

## Work Log

### 2026-03-06 - Audit Discovery

**By:** Claude Code (reliability audit swarm)

**Actions:**
- Agent 6 identified both issues during lock protocol analysis
- Confirmed the `wx` flag provides correct exclusivity but CWD-relative path defeats it for cross-directory agents
