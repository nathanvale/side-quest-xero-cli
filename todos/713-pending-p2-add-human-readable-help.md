---
status: complete
priority: p2
issue_id: "713"
tags: [capability-discovery, ux, agent-native]
dependencies: []
---

# Add human-readable --help output (currently JSON-only)

## Problem Statement

`bun run xero-cli --help` returns only JSON `{"command":"help","topic":null}`. No human-readable text listing available commands. Users cannot discover available commands from CLI alone. The project is agent-optimized but human-unfriendly.

## Findings

- Capability Discovery scored **41/55 (75%)** in agent-native audit
- Help command exists but only outputs JSON (no human text)
- Aliases (tx, acct, inv, rec, hist) documented in command-reference.md but not displayed by CLI help
- No interactive command discovery from terminal

## Proposed Solutions

### Option 1: TTY-aware help output

**Approach:** Detect TTY and output formatted text for humans, JSON for agents.

```bash
bun run xero-cli --help
# xero-cli - Xero bank transaction tool
#
# Commands:
#   status       Preflight check (auth, config, API)
#   auth         OAuth2 PKCE login
#   transactions Read bank transactions (alias: tx)
#   accounts     Read chart of accounts (alias: acct)
#   ...
```

**Pros:**
- Humans can discover commands
- Agents still get JSON when piped

**Cons:**
- Maintaining two help formats

**Effort:** 1-2 hours

**Risk:** Low

## Recommended Action

Implemented on 2026-03-09.

## Acceptance Criteria

- [ ] `bun run xero-cli --help` shows human-readable command list when TTY
- [ ] Aliases shown alongside commands
- [ ] JSON output preserved for non-TTY
- [ ] Per-command help: `bun run xero-cli transactions --help`

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Capability Discovery audit identified JSON-only help as primary gap
