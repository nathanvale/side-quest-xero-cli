---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, security, architecture]
dependencies: []
---

# Bun.secrets is not a token storage API

## Problem Statement

The plan relies on `Bun.secrets.set()` and `Bun.secrets.get()` for macOS Keychain integration to store OAuth2 tokens. **`Bun.secrets` is a read-only API** for accessing environment-level secrets -- it does not have `set`/`get` methods that work like a keychain store. This is the foundation of the auth module and blocks Phase 1 implementation.

## Findings

- `Bun.secrets` provides read-only access to environment secrets, not keychain read/write
- The plan's `saveTokens()` and `loadTokens()` functions using `Bun.secrets.set()`/`.get()` will not work
- Multiple code snippets reference this API across auth.ts and the PKCE deep-dive section
- The TypeScript reviewer flagged this as the #1 critical issue

## Proposed Solutions

### Option 1: macOS `security` CLI via Bun.spawn

**Approach:** Shell out to the `security` command-line tool for Keychain read/write.

```typescript
async function saveToKeychain(key: string, value: string): Promise<void> {
  const proc = Bun.spawn([
    'security', 'add-generic-password', '-U',
    '-s', 'side-quest-xero-cli', '-a', key, '-w', value,
  ])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`Keychain write failed for ${key}`)
}

async function loadFromKeychain(key: string): Promise<string | null> {
  const proc = Bun.spawn([
    'security', 'find-generic-password',
    '-s', 'side-quest-xero-cli', '-a', key, '-w',
  ], { stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  if (proc.exitCode !== 0) return null
  return (await new Response(proc.stdout).text()).trim()
}
```

**Pros:**
- Works on all macOS versions
- No additional dependencies
- Encrypted at rest via Keychain

**Cons:**
- Spawns a subprocess for each read/write
- macOS-only (no Linux/Windows support)

**Effort:** 1 hour

**Risk:** Low

---

### Option 2: Encrypted JSON file with user-derived key

**Approach:** Store tokens in an encrypted file using a key derived from a machine-specific secret.

**Pros:**
- Cross-platform
- No CLI spawning

**Cons:**
- Key management complexity
- Less secure than Keychain

**Effort:** 3-4 hours

**Risk:** Medium

## Recommended Action

**To be filled during triage.**

## Technical Details

**Affected files:**
- `src/xero/auth.ts` -- all token storage/retrieval functions
- Plan document -- PKCE deep-dive code snippets reference `Bun.secrets`

## Resources

- **Bun docs:** Bun.secrets is for reading secrets from environment, not keychain storage
- **macOS security CLI:** `man security` for add-generic-password / find-generic-password

## Acceptance Criteria

- [ ] Token storage uses a working API (not `Bun.secrets.set`)
- [ ] Tokens are encrypted at rest
- [ ] `saveTokens()` and `loadTokens()` pass unit tests
- [ ] Fallback chain documented if primary storage fails

## Work Log

### 2026-02-26 - Initial Discovery

**By:** Claude Code (TypeScript Reviewer + Security Sentinel)

**Actions:**
- Identified `Bun.secrets` is read-only, not a storage API
- Proposed `security` CLI alternative
- Flagged as P1 since it blocks the entire auth module
