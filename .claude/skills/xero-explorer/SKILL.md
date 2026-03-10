---
name: xero-explorer
description: >
  Reconcile Xero statement lines and extract accounting data via the
  Xero API Explorer browser + xero-cli hybrid flow when OAuth scope is constrained. Use when the user asks
  to pull Xero data, extract ledgers, reconcile transactions, check
  reconciliation progress, remaining unreconciled transactions, or work
  around the OAuth 403 block.
argument-hint: "{extract|reconcile|status|quarter-status|new-quarter}"
disable-model-invocation: true
---

# xero-explorer

Orchestrate Xero accounting operations through a hybrid flow:
- `xero-cli` for standard Accounting API endpoints
- `agent-browser` only for Finance API statement lines (`BankStatementsPlus`)

Designed to minimize browser automation while restricted scopes remain blocked.

## Core Principles

- **Ask before extracting.** Extraction is slow (multiple API calls via browser). Always ask whether to re-pull or use existing `data/*.ndjson` files.
- **Read first, write last.** All reconciliation writes require explicit user confirmation.
- **Preserve the clipboard.** After copying API responses, immediately save to file before any other clipboard operation. Clear clipboard after saving.
- **Secure by default.** Financial data files use 0o600 permissions. State writes use atomic temp+rename.
- **Hook-safe commands only.** Use checked-in scripts; avoid inline interpreter commands (`python -c`, heredocs) in workflows.

## ADHD UX Guidelines

Applied to all reconciliation interactions:

- **Batch approval, not one-by-one** -- group confident matches: "42 items -> Software ($2,340). Approve?"
- **Progress is dopamine** -- ASCII progress bar + "147/300 done (49%)" + time remaining after every action, milestones at first-item/10%/25%/50%/75%/90%
- **Research the mysteries proactively** -- WebSearch vendors before presenting, show evidence
- **Let me stop anytime** -- save state after every confirmation, resume exactly where you left off
- **Keep it visual** -- tables over paragraphs, summary first, details on demand
- **Warm up first** -- present easy matches first to build momentum before harder items
- **Celebrate completion** -- session summary with stats, top categories, best streak
- **Mission-based sessions** -- default to short missions (for example, "25 items or 15 minutes"), then offer continue/stop
- **Energy-aware defaults** -- ask for focus level (`low`/`normal`/`deep`) and adapt batch size + prompt density
- **Fun with purpose** -- show XP/streak language tied to tax readiness, not fluff
- **Boss battle separation** -- keep Round 3 unknowns as an optional dedicated pass so hard items do not poison momentum
- **Boredom interrupts** -- detect skips/slow pace and suggest quick switches (mode swap, easier batch, short break)

## Australian Financial Quarters

Australia's financial year runs July to June, named after the year it **ends**. So Jul 2024 - Jun 2025 = FY25 (ends in 2025).

When the user references a quarter (e.g., "reconcile Q1", "extract Q4 FY25"), map it using this table:

### FY25 (Jul 2024 - Jun 2025)

| Quarter | Period | FromDate | ToDate |
|---------|--------|----------|--------|
| Q1 FY25 | Jul 1 - Sep 30, 2024 | `2024-07-01` | `2024-09-30` |
| Q2 FY25 | Oct 1 - Dec 31, 2024 | `2024-10-01` | `2024-12-31` |
| Q3 FY25 | Jan 1 - Mar 31, 2025 | `2025-01-01` | `2025-03-31` |
| Q4 FY25 | Apr 1 - Jun 30, 2025 | `2025-04-01` | `2025-06-30` |

### FY26 (Jul 2025 - Jun 2026)

| Quarter | Period | FromDate | ToDate |
|---------|--------|----------|--------|
| Q1 FY26 | Jul 1 - Sep 30, 2025 | `2025-07-01` | `2025-09-30` |
| Q2 FY26 | Oct 1 - Dec 31, 2025 | `2025-10-01` | `2025-12-31` |
| Q3 FY26 | Jan 1 - Mar 31, 2026 | `2026-01-01` | `2026-03-31` |
| Q4 FY26 | Apr 1 - Jun 30, 2026 | `2026-04-01` | `2026-06-30` |

### How to derive any quarter

```
FY = year the financial year ENDS (June)
Q1 = Jul-Sep (first calendar year)
Q2 = Oct-Dec (first calendar year)
Q3 = Jan-Mar (second calendar year = FY year)
Q4 = Apr-Jun (second calendar year = FY year)

FromDate/ToDate: Q{N} FY{YY} ->
  Q1: {YY-1}-07-01 to {YY-1}-09-30
  Q2: {YY-1}-10-01 to {YY-1}-12-31
  Q3: {YY}-01-01 to {YY}-03-31
  Q4: {YY}-04-01 to {YY}-06-30
```

Use `FromDate`/`ToDate` when filling BankStatementsPlus parameters in the extract workflow.

**Routing hints:** "Q1" -> Jul-Sep, "Q2" -> Oct-Dec, "Q3" -> Jan-Mar, "Q4" -> Apr-Jun. If the user says just "Q1" without a FY, infer from context or ask. Note: calendar Q1 (Jan-Mar) is financial Q3 -- always clarify if ambiguous.

## Quarter Gate (REQUIRED)

**Nothing happens without a validated bank export.** Use this single command (source of truth) before extract/reconcile:

```bash
# Concrete example (Q4 FY25)
python3 scripts/manage-quarters.py gate 4 25

# Template -- substitute Q and FY before running
python3 scripts/manage-quarters.py gate Q FY
```

Gate behavior:
- Blocks future quarters with an actionable comeback date
- Blocks missing QIF with exact CommBank filename guidance
- Validates parse/date range context for completed quarters

Workflows must rely on `manage-quarters.py gate` instead of re-implementing gate logic inline.

## End-to-End Workflow

The full reconciliation pipeline for a quarter:

1. **Validate** -- `python3 scripts/manage-quarters.py gate Q FY`
2. **Export** -- Download QIF from CommBank online banking. Save to `data/bank-export-fy{YY}-q{N}-{months}.qif`
3. **Import** -- Upload QIF into Xero (manual via Xero UI; API import not yet available publicly -- Bank Feeds API is partner-only)
4. **Extract** -- Pull accounting data via `xero-cli` + statement lines via `agent-browser` (`/xero-explorer extract`)
5. **Reconcile** -- Match and POST via agent-browser (`/xero-explorer reconcile`)
6. **CSV review** -- Prefer the offline CSV loop for review and iteration before POST (`workflows/csv-review.md`)

**Why extraction can't be skipped:** The QIF bank export has the raw transactions, but extraction from Xero confirms they're actually imported and visible to Xero's reconciliation engine. Extraction provides:
- **Validation** -- QIF txn count == statement lines count means the import worked correctly
- **Statement line IDs** -- required for Xero's auto-matching when we POST BankTransactions
- **Reconciliation status** -- which lines are already reconciled vs still pending (`isReconciled`, `bankTransactions`)
- **Confidence** -- if counts don't match, something went wrong with the import -- stop before reconciling

Without extraction, you risk POSTing BankTransactions against statement lines that don't exist in Xero yet.

## Data Directory

All extracted data lives in `data/` (gitignored -- contains real financial data):

### Quarter Registry

The quarter lifecycle is tracked in `data/quarters.json`. Manage it with:

```bash
python3 scripts/manage-quarters.py init      # Scan data/ and build from existing files
python3 scripts/manage-quarters.py status     # Show quarter status table
python3 scripts/manage-quarters.py dates Q FY # Show FromDate/ToDate (e.g., dates 1 26)
```

The registry tracks each quarter through the pipeline: bank export -> Xero import -> extraction -> reconciliation.

### Bank Exports (source of truth)

Raw bank exports from CommBank. Used to validate that Xero statement line extraction is complete.

Naming convention: `bank-export-fy{YY}-q{N}-{months}.qif`

Parse one file: `python3 scripts/parse-qif.py data/bank-export-fy25-q4-apr-jun.qif`
Parse all files:
`for f in data/bank-export-*.qif; do python3 scripts/parse-qif.py "$f"; done`

### Xero Extracts

| File | Source | Key / Filter |
|------|--------|-------------|
| `data/accounts.ndjson` | `xero-cli accounts --json` (Accounting API /Accounts) | `accounts[]` |
| `data/bank-transactions.ndjson` | `xero-cli transactions --json` (Accounting API /BankTransactions) | `transactions[]` |
| `data/invoices.ndjson` | `xero-cli invoices --json` (Accounting API /Invoices) | `invoices[]` |
| `data/contacts.ndjson` | `xero-cli contacts --json` (Accounting API /Contacts) | `contacts[]` |
| `data/payments.ndjson` | `xero-cli payments --json` (Accounting API /Payments) | `payments[]` |
| `data/statement-lines-fy{YY}-q{N}.ndjson` | `agent-browser` + Finance API /BankStatementsPlus | `statements[].statementLines[]` (per quarter) |

**Statement lines are quarter-scoped** -- each quarter gets its own file so previous extractions are never overwritten.

### Reconciliation State

| File | Source | Purpose |
|------|--------|---------|
| `data/.xero-explorer-state-fy{YY}-q{N}.json` | Generated by reconcile workflow | Resumable reconciliation state (quarter-scoped) |
| `data/needs-review.csv` | Generated by reconcile workflow | Skipped + errored items for manual review |

### Validation

After extracting statement lines, the manage-quarters script validates counts automatically:

```bash
python3 scripts/manage-quarters.py status
# Match column shows OK if extraction count == bank export count
```

## Intake

First, show quarter status:

```bash
python3 scripts/manage-quarters.py status
```

Then ask: What would you like to do?

1. **[Extract data](workflows/extract.md)** -- Pull latest data via CLI-first hybrid into NDJSON files (Accounting via CLI, Finance via browser)
2. **[Reconcile](workflows/reconcile.md)** -- Match unreconciled statement lines to accounts and POST via API Explorer
3. **Status** -- Check reconciliation progress from state file
4. **Quarter status** -- Show which quarters have bank exports, extractions, reconciliation
5. **[New quarter setup](workflows/new-quarter.md)** -- Add/validate a new quarter's QIF export before extraction

Before starting reconciliation, read:
- [references/matching-rules.md](references/matching-rules.md) -- categorization rules, contact lookup, POST templates
- [references/state-schema.md](references/state-schema.md) -- state file lifecycle and write discipline
- [workflows/csv-review.md](workflows/csv-review.md) -- sealed CSV round-trip via Google Sheets

**Routing:**
- `extract`/`pull` -> [Extract](workflows/extract.md)
- `reconcile`/`match` -> [Reconcile](workflows/reconcile.md)
- `csv`/`sheet`/`spreadsheet`/`review loop` -> [CSV Review](workflows/csv-review.md)
- `status`/`progress` -> Status Check (below)
- `quarters` -> Quarter status (below)
- `new quarter`/`setup quarter`/`download qif` -> [New quarter setup](workflows/new-quarter.md)
- `Q1`/`Q2`/`Q3`/`Q4` -> run Quarter Gate validation first, then ask extract or reconcile

**Intake logic:**
- Run `python3 scripts/manage-quarters.py status` to show pipeline overview
- If no `quarters.json`, run `python3 scripts/manage-quarters.py init` first
- Recommend canonical session bootstrap:
  - `./scripts/xero-explorer-runner.sh 4 25 batch`
  - `./scripts/xero-explorer-runner.sh 4 25 rapid-fire --dry-run`
  - Usage: `xero-explorer-runner.sh <Q> <FY> <mode> [--dry-run]`
    - `Q`: quarter number (1-4)
    - `FY`: two-digit financial year (e.g., 25 for FY25)
    - `mode`: `batch` | `rapid-fire`
    - `--dry-run`: classify + preview only, no POST writes
  - Substitute the concrete quarter values before running (never run `Q FY` placeholders literally)
  - Run `./scripts/xero-browser-healthcheck.sh` before long reconcile sessions
- For extract: ask which quarter (show available from quarters.json)
- For reconcile: check quarter-scoped `data/statement-lines-fy{YY}-q{N}.ndjson` exists
- For reconcile, start with:
  - mission size/time cap (default: 25 items or 15 minutes)
  - focus level (`low`/`normal`/`deep`)
- For missing QIF:
  - If quarter end date is in the future vs today, stop with: "Time machine check: that quarter hasn't finished yet."
  - If quarter is completed, direct user to CommBank download flow and required filename format
- `data/bank-transactions.ndjson` is optional (contact history enrichment)
- For status/progress: resolve target quarter first, then load `data/.xero-explorer-state-fy{YY}-q{N}.json`
- If quarter state file exists: mention resume option
- For portfolio guidance: run `python3 scripts/manage-quarters.py next-action`
- If user asks for status without quarter:
  - show quarter status table
  - ask one direct follow-up: "Which quarter status should I open?"
- If any CLI JSON error returns `error.action == "USE_BROWSER_FALLBACK"` or `error.code == "E_SCOPE_RESTRICTED"`:
  - do not retry the same CLI call repeatedly
  - auto-route to browser fallback path in extract workflow (Finance step)
  - explain briefly: "Scope-restricted endpoint; switching to browser fallback."

## Status Check (route 3)

Status is quarter-first. Always ask for or infer a specific quarter before loading state.

```bash
Q=1
FY=26
python3 scripts/xero-reconcile-report.py state-status "$Q" "$FY"
```

For global triage across quarters:

```bash
python3 scripts/manage-quarters.py next-action
```

Safety default:
- If user is uncertain, run reconcile in dry-run first (`--dry-run`) and require explicit write interlock phrase before POST.

## Browser Prerequisites

Before either workflow, verify the browser session:

```bash
agent-browser --headed get url
```

- If not on `api-explorer.xero.com`, navigate there and check the user is logged in
- If session expired, tell the user to log in manually then resume

## Success Criteria

- Data files are current and valid NDJSON with 0o600 permissions
- All reconciliations posted successfully
- State file tracks all progress for resumability
- No unhandled browser automation errors
