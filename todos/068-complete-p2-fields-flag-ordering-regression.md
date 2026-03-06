---
status: complete
priority: p2
issue_id: "068"
tags: [code-review, quality, cli]
dependencies: []
---

# Fix `--fields` parsing regression for history/invoices

**Duplicate of #046.** Resolved together in the same fix.

## Resolution

See todo 046 for details. The `fieldsRaw` guard in `parseCli` was moved after the `history` and `invoices` command branches so `--fields` is accepted for all four list commands.

## Work Log

### 2026-02-27 - Initial Discovery

**By:** Codex

**Actions:**
- Reviewed parse order and command branches.
- Confirmed logic contradiction in parser flow.

### 2026-02-27 - Resolved as duplicate of 046

**By:** Agent

**Actions:**
- Fixed alongside todo 046 by reordering the `fieldsRaw` guard in `src/cli/command.ts`.
- Added parser-level tests covering all --fields permutations.
