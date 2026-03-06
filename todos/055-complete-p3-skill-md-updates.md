---
status: complete
priority: p3
issue_id: "055"
tags: [code-review, documentation]
dependencies: ["046"]
---

# SKILL.md Documentation Gaps

## Problem Statement

Several CLI capabilities were not documented in the agent skill runbook.

## Findings

- **Source:** Agent-Native Reviewer
- **Items:**
  - Invoices command defaults to `Status=="AUTHORISED"` -- not documented
  - `--page` and `--limit` for transactions not mentioned
  - Auth command requires human interaction (browser OAuth) -- should note explicitly
  - Auth should emit structured `authUrl` in JSON mode for agent consumption
  - `--fields` support for history and invoices commands not documented
  - `status` command not documented in workflow
  - Account type filter, invoice filters, history filters undocumented
  - Date range flags (--since, --until, --this-quarter, --last-quarter) undocumented
  - Auto-JSON output mode for non-TTY environments undocumented
  - Command aliases undocumented
  - --auth-timeout flag undocumented

## Acceptance Criteria

- [x] SKILL.md documents invoices default filter
- [x] SKILL.md documents --page/--limit for transactions
- [x] SKILL.md notes auth requires human-in-the-loop
- [x] SKILL.md documents headless auth JSON output ({ "authUrl": "..." })
- [x] SKILL.md documents --fields for history and invoices
- [x] SKILL.md documents status command as preflight check
- [x] SKILL.md documents all command flags visible in CLI source

## Resolution

Updated SKILL.md with comprehensive documentation covering:
1. `status` command as a preflight check (new step 0)
2. Auth human interaction requirement and headless mode (`XERO_HEADLESS=1` / non-TTY)
3. `--auth-timeout` flag
4. `--page` and `--limit` for transactions
5. `--since`, `--until`, `--this-quarter`, `--last-quarter` date filters for transactions
6. `--type` filter for accounts
7. `--fields` projection for accounts
8. `--contact` and `--account-code` filters for history
9. `--fields` projection for history
10. New invoices command section (step 4a) with default filter behavior
11. `--status` and `--type` filters for invoices
12. `--fields` projection for invoices
13. Auto-JSON output mode documentation
14. Command aliases table
15. Cross-command `--fields` support summary

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Agent-Native Reviewer |
| 2026-02-27 | Resolved: updated SKILL.md with all missing docs | Cross-referenced every CLI source file against SKILL.md |
