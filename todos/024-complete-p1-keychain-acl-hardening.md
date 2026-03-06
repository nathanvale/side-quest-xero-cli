---
status: complete
priority: p1
issue_id: "024"
tags: [security, keychain, tokens]
dependencies: []
---

# Harden Keychain ACLs and fix non-atomic token storage

## Problem Statement

The Keychain implementation has three security issues: (1) Default ACLs may allow any same-user process to read tokens, (2) service/account namespace is too generic and could collide with other tools, (3) storing tokens as 3-4 separate Keychain entries creates non-atomic state that can be torn by crashes.

## Findings

- `security add-generic-password -s side-quest-xero-cli -a <key> -w <value> -U`
- `-U` flag silently updates existing entries -- can overwrite from another tool
- No `-T` flag (trusted application) to restrict access to specific binary
- Separate entries for `access_token`, `refresh_token`, `refresh_token_prev`, `expires_at`
- Crash between writing `refresh_token` and `access_token` leaves torn state
- Generic account names (`access_token`) could collide with other Xero tools

**Source:** Security Engineer review (Pass 3)

## Proposed Solutions

### Option 1: Single serialized token bundle (recommended)

**Approach:** Store all tokens as a single JSON blob in one Keychain entry: `{"accessToken": "...", "refreshToken": "...", "refreshTokenPrev": "...", "expiresAt": 1234}`. Single write = atomic update. Use unique service+account names.

**Pros:**
- Atomic -- all tokens updated or none
- Single entry reduces collision risk
- Simpler code (one read, one write)

**Cons:**
- Must parse JSON on read
- Slightly larger single entry

**Effort:** 1 hour

**Risk:** Low

### Option 2: Add ACL restrictions + keep separate entries

**Approach:** Use `-T /path/to/bun` flag to restrict Keychain access to the Bun binary. Use more specific account names like `side-quest-xero-cli:v1:access_token`.

**Pros:**
- Restricts which apps can read tokens
- More specific naming

**Cons:**
- Still non-atomic (4 separate entries)
- ACL path depends on Bun install location

**Effort:** 1 hour

**Risk:** Medium (path dependency)

## Recommended Action

Option 1 implemented: Single serialized token bundle.

## Acceptance Criteria

- [x] Token storage is atomic (single entry or transactional update)
- [x] Service/account names are specific enough to avoid collision
- [x] Crash during save cannot create inconsistent token state
- [x] Plan code examples updated

## Work Log

### 2026-02-26 - Filed from Codex Review

**By:** Claude Code

**Actions:**
- Security reviewer identified 3 Keychain implementation issues
- Filed from Security Engineer review (Pass 3, Critical #1, #2, #3)

**Learnings:**
- Storing related secrets as separate entries creates atomicity problems
- Keychain ACLs need explicit configuration for security-sensitive applications

### 2026-02-26 - Implemented Option 1 (Single JSON blob)

**By:** Claude Code

**Actions:**
- Changed Keychain storage from 4 separate entries to 1 JSON blob entry (`KeychainTokenBundle`)
- Updated service name from `side-quest-xero-cli` to `com.nathanvale.side-quest-xero-cli.xero` (reverse-DNS to avoid collisions)
- Updated account name from per-field keys (`access_token`, etc.) to single `oauth-tokens`
- Updated `saveTokens()` and `loadTokens()` to serialize/deserialize JSON
- Added `deleteTokens()` for logout/re-auth
- Updated `ensureFreshToken()` to use `loadTokens()` returning full bundle
- Updated `doRefresh()` to accept `KeychainTokenBundle` and do single atomic write
- Updated risk table: refresh token rotation likelihood lowered from Medium to Low
- Updated Security section bullet point to mention single JSON blob

**Learnings:**
- Single JSON blob in Keychain is simpler than managing multiple entries
- Reverse-DNS naming (`com.nathanvale.side-quest-xero-cli.xero`) is standard macOS convention for avoiding collisions
