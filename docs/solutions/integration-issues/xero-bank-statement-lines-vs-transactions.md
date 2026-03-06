---
title: Xero Bank Statement Lines vs BankTransactions - API Endpoint Mismatch
date: 2026-03-05
category: integration-issues
tags:
  - xero-api
  - bank-reconciliation
  - api-scope-restrictions
  - finance-api
  - pkce-authentication
  - bank-statement-lines
  - jax-ai-reconciliation
  - xero-partner-certification
  - community-intelligence
severity: high
component: xero-cli
symptoms:
  - transactions --unreconciled command returns 0 results
  - Xero web UI shows 1046 unreconciled items for same period
  - Data mismatch between CLI output and web interface
root_cause: Wrong API endpoint - /BankTransactions returns accounting entries, not bank statement lines. Correct endpoint (BankStatementsPlus) requires scope restricted to certified partner apps
resolution_status: blocked
blocker: finance.bankstatementsplus.read scope unavailable to uncertified PKCE apps
related_apis:
  - /api.xro/2.0/BankTransactions (accounting entries - accessible)
  - /finance.xro/1.0/BankStatementsPlus/statements (statement lines - restricted)
  - /api.xro/2.0/Reports/BankStatement (deprecated/restricted)
---

# Xero Bank Statement Lines vs BankTransactions

## Problem

The `xero-cli` tool's `transactions --unreconciled` command returned 0 results when querying Q2 2025 (April-June), but the Xero web UI's reconciliation page displayed **1046 items** requiring reconciliation.

The CLI queries the `/BankTransactions` API endpoint with `IsReconciled==false`, which is the wrong data source entirely.

## Investigation

### Step 1: Verify CLI Works

```bash
bun run xero-cli status --json
# diagnosis: "ok" -- auth and config are fine

bun run xero-cli transactions --unreconciled --since 2025-04-01 --until 2025-06-30 --summary
# Returns: 0 results
```

### Step 2: Remove Filters to Check Data Exists

```bash
bun run xero-cli transactions --json --fields BankTransactionID,Total,IsReconciled
# Returns: 9060 total transactions
# Only 24 have IsReconciled: false (all dated 2015)
```

The API has data, but only 24 unreconciled items -- all from 2015, not 2025.

### Step 3: Verify Against Xero UI

Opened Xero web UI via `agent-browser`. The homepage showed:

- **"Reconcile 1046 items"** button on Business Transaction Account
- Clicking through showed transactions dated April 2025 onward
- Items were bank statement lines (left side of reconciliation screen)

### Step 4: Test Alternative Endpoints

| Endpoint | Result | Notes |
|----------|--------|-------|
| `/BankTransactions?IsReconciled==false` | 24 items (2015) | Wrong data source |
| `/Reports/BankStatement` | 401 Unauthorized | Needs `accounting.reports.bankstatement.read` -- unavailable |
| `/BankStatements` | 404 Not Found | Doesn't exist |
| `BankStatementsPlus` (Finance API) | **200 OK** (via API Explorer) | Returns all 1046 statement lines |

### Step 5: Scope Testing

Attempted to add required scopes to our PKCE app:

```
accounting.reports.bankstatement.read  --> "Invalid scope for client"
finance.bankstatementsplus.read        --> "Invalid scope for client"
```

Both scopes are restricted to certified/partner Xero applications.

## Root Cause

Xero's API has two completely distinct data models for bank data:

| Concept | API Endpoint | What It Returns | Scope |
|---------|-------------|-----------------|-------|
| **BankTransactions** | `/api.xro/2.0/BankTransactions` | Accounting entries already in Xero's books | `accounting.transactions` (standard) |
| **Statement Lines** | `/finance.xro/1.0/BankStatementsPlus/statements` | Raw bank feed imports waiting to be matched | `finance.bankstatementsplus.read` (partner only) |

The Xero reconciliation UI shows **statement lines** (left side) that need to be matched to **accounting transactions** (right side). Our CLI was querying accounting transactions, which is the wrong side of the reconciliation equation.

### Key Insight

"Unreconciled" means different things in each context:

- **BankTransactions `IsReconciled==false`**: An accounting entry exists but hasn't been matched to a bank statement line
- **Statement Lines in the UI**: Raw bank feed data that hasn't been matched to any accounting entry at all

The 1046 items are statement lines with no corresponding accounting entries yet.

## Solution

The correct endpoint for accessing bank statement lines is:

```
GET https://api.xero.com/finance.xro/1.0/BankStatementsPlus/statements
  ?BankAccountID={uuid}
  &FromDate=YYYY-MM-DD
  &ToDate=YYYY-MM-DD
```

**Required scope:** `finance.bankstatementsplus.read`

**Response structure (per statement line):**

```json
{
  "statementLineId": "1dd20d85-5be5-410c-a94e-533a84c9e395",
  "postedDate": "2025-04-01",
  "payee": "Transfer to xx9027 NetBank Nathan Pay",
  "amount": -6249.33,
  "transactionDate": "2025-04-01",
  "type": "STMTTRNTYPE/DEBIT",
  "isReconciled": false,
  "isDuplicate": false,
  "isDeleted": false,
  "payments": [],
  "bankTransactions": []
}
```

For unreconciled items: `isReconciled === false` and `bankTransactions` array is empty.

## Current Blocker

The `finance.bankstatementsplus.read` scope is **restricted to Xero certified partner apps**. Uncertified PKCE applications cannot request it -- the OAuth2 flow rejects with:

```
Error: unauthorized_client
Invalid scope for client
```

This was confirmed by testing via the API Explorer (which has broader scopes and returned 200 OK with full data) vs our registered PKCE app (which got the scope rejection).

## Workarounds

### Option 1: Apply for Xero Partner Certification (Recommended)

- Submit app for certification via Xero's Partner Program
- Unlocks restricted scopes including `finance.bankstatementsplus.read`
- Timeline: 2-4 weeks typical review period
- Required for production use

### Option 2: Automate the Web UI (Short-term)

- Use `agent-browser` to automate Xero's reconciliation UI
- Extract statement lines from the DOM
- Fragile (UI changes break it), but functional for personal use
- Note: The `xero-explorer` skill already implements a browser-based workflow for OAuth-blocked scenarios

### Option 3: Pivot CLI Scope

- Accept that `--unreconciled` returns accounting transactions only
- Document the limitation clearly in CLI help text
- Focus CLI on what the accessible API does well: categorization, invoice matching, history analysis

### Option 4: Dual-Mode (Agent-Native)

- Keep API-based `--unreconciled` for accounting transactions
- Add `--statement-lines` flag using agent-browser for full reconciliation data
- Document both modes and their trade-offs

## Prevention Strategies

### UI-First Verification Protocol

Before building any feature against a Xero API endpoint:

1. **Open the Xero UI** for the feature you're building against
2. **Count and compare**: Verify API result count matches UI display count
3. **Inspect structure**: Confirm API fields represent what the UI shows
4. **Document the mapping**: Link UI feature -> API endpoint -> data model

### Scope Testing Hierarchy

1. **API Explorer first**: Has broadest permissions -- confirms data exists
2. **Dev app second**: Tests with your actual scopes -- identifies restrictions
3. **Document restrictions**: Note which scopes are partner-only vs standard

### API Concept Mapping

Maintain a reference mapping Xero UI features to API endpoints:

```
UI Feature              -> API Endpoint           -> Required Scope
Bank Reconciliation     -> BankStatementsPlus      -> finance.bankstatementsplus.read (partner)
Bank Transactions       -> BankTransactions        -> accounting.transactions (standard)
Chart of Accounts       -> Accounts                -> accounting.settings.read (standard)
Invoices                -> Invoices                -> accounting.transactions (standard)
```

## Related Documentation

### Internal

- `xero-cli` skill: `.claude/skills/xero-cli/SKILL.md`
- `xero-reconcile` skill: `.claude/skills/xero-reconcile/SKILL.md`
- `xero-explorer` skill: `.claude/skills/xero-explorer/SKILL.md` (browser-based fallback)
- Error handling reference: `.claude/skills/xero-cli/references/error-handling.md`

### External

- [Xero BankStatementsPlus API](https://developer.xero.com/documentation/api/finance/bankstatementsplus)
- [Xero BankTransactions API](https://developer.xero.com/documentation/api/accounting/banktransactions)
- [Xero OAuth2 Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Feature Request: Uncoded Statement Lines API](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/44040909)
- [Feature Request: Reconcile via API](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/2884040)
- [BankStatement Report Breaking Change (April 2024)](https://docs.codat.io/updates/240305-deprecation-xero-bankstatement-report)

## Community Intelligence (March 2026)

Research across Reddit, X, Xero UserVoice, and developer blogs reveals this is a well-known, long-standing limitation with no resolution in sight.

### The 17-Year Feature Request

The request to "Reconcile via the API" has existed on Xero UserVoice since ~2009 (1000+ votes). Xero's official response is explicit: **"reconciling requires fine grained access to bank statement data which they are unable to share via the API for commercial reasons."** Their stated rationale: bank feed data providers (Yodlee, Plaid) don't permit downstream redistribution of statement data via third-party APIs.

### BankStatementsPlus: Gated for Lending, Not General Use

The Finance API (which houses BankStatementsPlus) is designed for **loan application use cases** -- helping lenders assess creditworthiness, not general developer automation. Requirements beyond standard OAuth:

- Separate pre-approval from Xero (commercial conversation required)
- Additional contractual terms
- Geography restrictions: UK, Australia, South Africa, NZ, Hong Kong, Singapore only
- **Hard cap of 2,000 bank statement lines per month** before additional approval gates

### April 2024 Breaking Change

Xero locked the BankStatement report behind a new scope (`accounting.reports.bankstatement.read`) and required developers to:

1. Sign a security addendum to developer T&Cs
2. Request the new scope explicitly
3. Confirm compliance directly to Xero

Without compliance, the `Balance` field stopped populating and Bank Transactions datasets failed. Framed as "security improvements" but effectively removed previously-open access.

### Partner Certification Costs

Becoming a certified Xero partner (required for restricted scopes) involves:

- Free dev accounts capped at 25 company connections
- 8+ certification checkpoints over multiple weeks of review
- Financial services apps face a separate, stricter partnership tier
- **15% revenue share** on all App Store referral revenue

### JAX: The Competitive Moat

Xero launched "Just Ask Xero" (JAX) in September 2025 -- an AI-powered reconciliation feature built into the web app. Community reaction has been hostile:

- **"Working on AI, which nobody needs for their accounting program instead of fixing issues we have been asking for, for YEARS"** -- Xero Product Ideas forum
- Multiple users demanding ability to disable JAX entirely
- Data privacy objections: users explicitly stating they do not consent to business data being used for AI training
- VentureBeat coverage: "Xero's JAX shows why accuracy and user control matter more than flashy AI features"

The pattern is clear: Xero restricts API access to bank statement data (citing commercial agreements) while building JAX to automate reconciliation in-product. Developers see this as API gating to protect a monetized feature.

### December 2025 ToS Update

Xero's updated Developer Terms of Service (December 2025) now explicitly prohibit **bots and browser extensions that simulate user actions** in the Xero web app. This makes browser automation workarounds (Option 2 and Option 4 above) a Terms of Service violation, even for personal use.

### Developer Workarounds in the Wild

- **@verbove** (X, Feb 2026): Full automation pipeline -- bank statement drops via Telegram, AI parses it, generates CSV, uploads via **Puppeteer** (not API), creates transactions, auto-categorizes. The Puppeteer workaround confirms the API limitation.
- **@SMButterworth** (X, Feb 2026): Discussing replacing Xero/QuickBooks/MYOB with primitives: "ledger database + open banking API + LLM categorisation" -- signaling platform lock-in frustration.
- **Clearing account patterns**: Some accountants use clearing accounts as a workaround, routing transactions through an intermediate account to simulate reconciliation via the standard API.
- **CSV import workflows**: Manual export from bank, transform, import into Xero -- bypassing the API entirely.

### Community Sentiment Summary

| Signal | Source | Sentiment |
|--------|--------|-----------|
| "Reconcile via the API" feature request | UserVoice (since ~2009) | Frustrated but resigned |
| JAX "ability to turn off" thread | Product Ideas forum | Hostile |
| @KoprowskiT: "still not delivered the most important features" | X (Feb 2026) | Critical |
| @verbove: Puppeteer automation pipeline | X (Feb 2026) | Routing around limitations |
| Codat: "5 things to know before integrating" | Blog (web) | Warning developers |

### Key Takeaway

This is a deliberate commercial decision by Xero, not a technical limitation. The data exists (confirmed via API Explorer), the endpoint exists (BankStatementsPlus), but access is gated behind partner certification designed for lending use cases. With JAX now monetizing reconciliation automation and the December 2025 ToS prohibiting browser automation, third-party reconciliation tools are effectively locked out.

## Related Documentation

### Internal

- `xero-cli` skill: `.claude/skills/xero-cli/SKILL.md`
- `xero-reconcile` skill: `.claude/skills/xero-reconcile/SKILL.md`
- `xero-explorer` skill: `.claude/skills/xero-explorer/SKILL.md` (browser-based fallback)
- Error handling reference: `.claude/skills/xero-cli/references/error-handling.md`

### External

- [Xero BankStatementsPlus API](https://developer.xero.com/documentation/api/finance/bankstatementsplus)
- [Xero BankTransactions API](https://developer.xero.com/documentation/api/accounting/banktransactions)
- [Xero OAuth2 Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Feature Request: Uncoded Statement Lines API](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/44040909)
- [Feature Request: Reconcile via API](https://xero.uservoice.com/forums/5528-accounting-api/suggestions/2884040) (since ~2009, 1000+ votes)
- [BankStatement Report Breaking Change (April 2024)](https://docs.codat.io/updates/240305-deprecation-xero-bankstatement-report)
- [5 Things to Know Before Integrating with Xero API](https://codat.io/blog/5-things-you-need-to-know-before-you-integrate-with-the-xero-api/) (Codat)
- [JAX "Ability to Turn Off" -- Xero Product Ideas](https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/49450391-just-ask-xero-jax-ability-to-turn-off-after-it-goes-live)
- [Xero's JAX: Accuracy and User Control](https://venturebeat.com/ai/xeros-jax-shows-why-accuracy-and-user-control-matter-more-than-flashy-ai) (VentureBeat)
- [About Auto Bank Reconciliation Powered by JAX](https://central.xero.com/s/article/About-auto-bank-reconciliation-powered-by-JAX) (Xero Central)
- [@verbove Puppeteer Automation Pipeline](https://x.com/verbove/status/2027755126576877703) (X, Feb 2026)
