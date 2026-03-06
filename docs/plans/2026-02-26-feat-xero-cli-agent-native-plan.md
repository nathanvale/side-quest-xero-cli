---
title: "feat: xero-cli -- agent-native CLI for Xero bank reconciliation"
type: feat
status: active
date: 2026-02-26
---

# xero-cli -- Agent-Native CLI for Xero Bank Reconciliation

> **Consolidated Plan** -- This is the single source of truth. All technical details from the 4 superseded plans have been inlined here. No cross-references needed.

## The Problem

Nathan has 300-400 unreconciled bank transactions per quarter in Xero. Each one needs an account code assigned (6310 Software, 6440 Motor Vehicle, 6420 Entertainment, etc.) before it can be reconciled. He can't produce financial statements until they're all done. Currently he does them one-by-one in the Xero web app. It takes hours.

## The Approach

Split the work into two layers:

1. **`xero-cli`** -- a dumb CLI that talks to the Xero API. JSON in, JSON out. It reads transactions, reads the chart of accounts, reads history, creates reconciliation entries. It has no opinions about which account code to use. Zero AI dependencies.

2. **Claude Code skill** -- teaches Claude how to use `xero-cli` to pull transactions, analyze them against the chart of accounts and past reconciliation patterns, propose account codes, and execute reconciliation after user approval.

```
+-----------------------------------------+
|  Claude Code                            |
|  "Here are 387 unreconciled txns.       |
|   Based on your chart of accounts and   |
|   how you categorized similar ones      |
|   before, here's what I'd suggest..."   |
+-----------------------------------------+
|  Skill: xero-reconcile                  |
|  Teaches Claude the workflow + CLI cmds |
+-----------------------------------------+
|  xero-cli (dumb pipe)                   |
|  auth | transactions | accounts |       |
|  invoices | history | reconcile |       |
|  status | help                          |
+-----------------------------------------+
```

The CLI follows the agent-native patterns from `/Users/nathanvale/code/claude-code-config/skills/patterns/SKILL.md`:
- Dual-mode output (human / JSON)
- Typed exit codes (0-5, 130)
- Structured JSON errors on stderr
- Auto non-TTY detection (pipes JSON automatically)
- Field projection (`--fields` for token economy)
- Self-documenting help system
- Structured logging via LogTape (JSON Lines on stderr for agent diagnostics)
- Fire-and-forget events to configurable observability server (dashboards, history, monitoring)

---

## How a User Consumes This

### First time: Auth

```bash
$ bun run xero-cli auth
Opening Xero login in your browser...
Waiting for callback on 127.0.0.1:5555...

✓ Authenticated as "Nathan Vale Consulting" (AU)
  Tenant ID saved to .xero-config.json
  Tokens saved to macOS Keychain
```

### Pull unreconciled transactions

```bash
# Human mode (default in terminal)
$ bun run xero-cli transactions --unreconciled
Found 387 unreconciled transactions (Jan 1 - Mar 31, 2026)

  Date        Amount      Contact/Description          Type
  2026-01-03  -$5.30      SUMO SALAD MELBOURNE         SPEND
  2026-01-03  -$49.99     GITHUB INC                   SPEND
  2026-01-04  -$142.50    SHELL COLES EXPRESS           SPEND
  2026-01-04  +$2,450.00  ACME CORP PTY LTD            RECEIVE
  ... (383 more)

# Summary mode for large results (default when >50 rows in terminal)
$ bun run xero-cli transactions --unreconciled --summary
Found 387 unreconciled transactions (Jan 1 - Mar 31, 2026)

  By Type:    SPEND: 342 (-$47,230.50)  |  RECEIVE: 45 (+$89,100.00)
  By Month:   Jan: 128  |  Feb: 134  |  Mar: 125
  Top 5:      SHELL COLES EXPRESS (23x)  |  GITHUB INC (6x)  |  SUMO SALAD (12x) ...

  Use --limit 20 to see first 20 rows, or --json for full data.

# JSON mode (for Claude / agents)
$ bun run xero-cli transactions --unreconciled --json
{"status":"data","data":{"command":"transactions","count":387,"transactions":[...]}}
# Field projection (token-efficient for agents)
$ bun run xero-cli transactions --unreconciled --json --fields BankTransactionID,Total,Contact.Name,Date
```

### Pull chart of accounts

```bash
$ bun run xero-cli accounts --json
{"status":"data","data":{"command":"accounts","count":45,"accounts":[
  {"Code":"6310","Name":"Software & SaaS","Type":"EXPENSE","Status":"ACTIVE"},
  {"Code":"6420","Name":"Entertainment","Type":"EXPENSE","Status":"ACTIVE"},
  {"Code":"6440","Name":"Motor Vehicle Expenses","Type":"EXPENSE","Status":"ACTIVE"},
  ...
]}}
```

### Pull reconciliation history (for Claude to learn patterns)

```bash
$ bun run xero-cli history --since 2025-07-01 --json
{"status":"data","data":{"command":"history","count":892,"transactions":[
  {"Contact":"GITHUB INC","AccountCode":"6310","AmountMin":-49.99,"AmountMax":-49.99,"Count":6},
  {"Contact":"SHELL COLES EXPRESS","AccountCode":"6440","AmountMin":-42.50,"AmountMax":-185.00,"Count":23},
  {"Contact":"SUMO SALAD","AccountCode":"6420","AmountMin":-5.30,"AmountMax":-18.90,"Count":12},
  ...
]}}
```

### Execute reconciliation (batch)

```bash
# Reconcile transactions with account codes (JSON input on stdin)
$ echo '[
  {"BankTransactionID":"abc-123","AccountCode":"6420"},
  {"BankTransactionID":"def-456","AccountCode":"6310"},
  {"BankTransactionID":"ghi-789","InvoiceID":"inv-001","Amount":2450.00,"CurrencyCode":"AUD"}
]' | bun run xero-cli reconcile --json

{"status":"data","data":{
  "command":"reconcile",
  "summary":{"total":3,"succeeded":3,"failed":0},
  "results":[
    {"BankTransactionID":"abc-123","status":"reconciled","AccountCode":"6420"},
    {"BankTransactionID":"def-456","status":"reconciled","AccountCode":"6310"},
    {"BankTransactionID":"ghi-789","status":"reconciled","InvoiceID":"inv-001","PaymentID":"pay-001"}
  ]
}}
```

### The Claude Code skill ties it all together

```
User: /xero-reconcile

Claude: Pulling unreconciled transactions...
        $ bun run xero-cli transactions --unreconciled --json

        Found 387 unreconciled transactions (Q1 2026).

        Pulling your chart of accounts...
        $ bun run xero-cli accounts --json

        Pulling reconciliation history for pattern matching...
        $ bun run xero-cli history --since 2025-07-01 --json

        Based on your accounts and past patterns, here's my analysis:

        === INVOICE MATCHES (12) ===
        $2,450.00  ACME CORP PTY LTD    -> Invoice INV-0234
        $890.00    WEB AGENCY PTY       -> Invoice INV-0241
        ...

        === CONFIDENT CATEGORIZATIONS (318) ===
        $5.30    SUMO SALAD MELBOURNE        -> 6420 Entertainment    (seen 12x before)
        $49.99   GITHUB INC                  -> 6310 Software/SaaS   (seen 6x before)
        $142.50  SHELL COLES EXPRESS         -> 6440 Motor Vehicle    (seen 23x before)
        $29.00   SPOTIFY                     -> 6310 Software/SaaS   (seen 6x before)
        $3,200.00 ATO PAYMENT               -> 8100 Tax Payments     (seen 4x before)
        ...

        === NEEDS YOUR INPUT (57) ===
        $500.00   TRANSFER FROM SAVINGS      -> Transfer? Which account?
        $1,234.56 UNKNOWN DIRECT DEBIT       -> Can't determine
        ...

        Want me to reconcile the 330 confident ones? (12 invoices + 318 categorized)
        The 57 uncertain ones I'll export as CSV for you to review.

User: yes, go ahead

Claude: Reconciling 330 transactions...
        $ echo '[...]' | bun run xero-cli reconcile --json

        ✓ 330/330 reconciled successfully

        Summary:
          Account codes assigned: 318 (6310 Software: 42, 6420 Entertainment: 89, 6440 Motor Vehicle: 67, ...)
          Invoice matches: 12 (total: $41,230.00 AUD)
          Skipped (already processed): 0
          Failed: 0

        ✓ Report saved to .xero-reconcile-runs/2026-02-26T14-30-00.ndjson
        ✓ 57 uncertain items exported to xero-needs-review-2026-02-26.csv

        57 remaining. Want to go through them now?
```

**Uncertain transaction round-trip workflow:**
1. Claude exports uncertain transactions as CSV: `xero-needs-review-YYYY-MM-DD.csv`
2. CSV columns: `BankTransactionID,Date,Amount,Contact,Description,SuggestedAccountCode,Confidence,Notes`
3. Nathan reviews in spreadsheet, fills in `AccountCode` column for each row
4. Nathan tells Claude: "import my decisions from xero-needs-review-2026-02-26.csv"
5. Claude reads the CSV, extracts rows where `AccountCode` is filled, constructs reconcile JSON, pipes to `bun run xero-cli reconcile --execute --json`
6. **Validation:** Claude validates CSV before import: rejects rows with missing BankTransactionID, invalid AccountCode format, or BankTransactionIDs not in the current unreconciled set
7. The CLI provides `reconcile --from-csv <file>` for deterministic CSV ingestion (Phase 4 -- deferred because the CSV is generated by Claude, so the format is controlled and predictable). The CLI validates the CSV schema (required columns: BankTransactionID, AccountCode; optional: InvoiceID, Amount, CurrencyCode), converts to the standard reconcile JSON format, and processes as normal. Implementation: simple line-by-line parsing in `parseReconcileCsv()` in `reconcile.ts` -- no CSV library needed since the file is machine-generated with no complex quoting. Shares the 5MB file size limit with stdin. The skill orchestrates: "Import your decisions: `bun run xero-cli reconcile --from-csv xero-needs-review-2026-02-26.csv --execute --json`"

---

## Architecture

### CLI Commands

| Command | Purpose | Key Flags |
|---------|---------|-----------|
| `auth` | OAuth2 PKCE flow, save tokens to Keychain | -- |
| `transactions` | Read bank transactions | `--unreconciled`, `--since`, `--until`, `--this-quarter`, `--last-quarter`, `--page`, `--limit`, `--summary` |
| `accounts` | Read chart of accounts | `--type` (EXPENSE, REVENUE, etc.) |
| `invoices` | Read outstanding invoices | `--status` (AUTHORISED), `--type` (ACCPAY, ACCREC) |
| `history` | Read past reconciled transactions | `--since` (required), `--contact`, `--account-code` |
| `reconcile` | Create reconciliation entries | Reads JSON from stdin. `--dry-run` (default), `--execute`, `--from-csv <file>` |
| `status` | Check auth + API connectivity | -- |
| `help` | Self-documenting help topics | `help transactions`, `help contract`, etc. |

### Global Flags (every command)

| Flag | Purpose |
|------|---------|
| `--json` | JSON envelope on stdout |
| `--quiet` | Minimal output |
| `--verbose` | Show info-level logs on stderr |
| `--debug` | Show debug-level logs on stderr (implies verbose) |
| `--events-url` | Observability server URL (overrides env var and auto-discovery) |
| `--version` | Print CLI version and exit |

### List Flags (transactions, accounts, invoices, history only)

| Flag | Purpose |
|------|---------|
| `--fields` | Comma-separated field projection (dot-path supported, e.g. `Contact.Name`) |

### Exit Codes

| Code | Constant | Meaning | Agent Action |
|------|----------|---------|-------------|
| 0 | `EXIT_OK` | Success | Proceed |
| 1 | `EXIT_RUNTIME` | Runtime error (API failure, network) | Retry or escalate |
| 2 | `EXIT_USAGE` | Bad arguments | Fix command syntax |
| 3 | `EXIT_NOT_FOUND` | Resource not found (no transactions, no config) | Create the resource first |
| 4 | `EXIT_UNAUTHORIZED` | Auth failure (expired tokens, Keychain denied) | Run `auth` command |
| 5 | `EXIT_CONFLICT` | Conflict (concurrent execute, locked state, 412 stale data) | Wait and retry |
| 130 | `EXIT_INTERRUPTED` | SIGINT / Ctrl+C | User cancelled |

### JSON Output Contract

**Stdout purity guarantee:** When JSON mode is active (explicit `--json` or auto non-TTY), stdout contains EXACTLY one JSON object followed by a newline. No other output (log messages, progress, warnings) ever appears on stdout. All diagnostic output goes to stderr. This is enforced by architecture: only `writeSuccess()` writes to stdout, and LogTape/progress are configured for stderr-only sinks.

**Success:**
```json
{"status":"data","schemaVersion":1,"data":{"command":"transactions","count":387,"transactions":[...]}}
```

`schemaVersion` is included in every success envelope. Increment on breaking changes to protect agents from unexpected schema drift.

**Error (on stderr):**
```json
{"status":"error","message":"Tokens expired","error":{"name":"PermissionError","code":"E_UNAUTHORIZED","action":"RUN_AUTH","retryable":false}}
```

**Error envelope fields:**
- `action` -- machine-readable next step: `RUN_AUTH`, `RETRY_WITH_BACKOFF`, `FIX_ARGS`, `WAIT_AND_RETRY`, `ESCALATE` (maps from exit code)
- `retryable` -- boolean indicating whether the same request could succeed on retry
- These fields are deterministic per error code, enabling agents to branch without heuristics

### Output Formatting (reference pattern from @side-quest/observability)

```typescript
const SCHEMA_VERSION_OUTPUT = 1

function writeSuccess<T>(ctx: OutputContext, data: T, humanLines: string[], quietLine: string): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ status: 'data', schemaVersion: SCHEMA_VERSION_OUTPUT, data })}\n`)
    return
  }
  if (ctx.quiet) {
    process.stdout.write(`${quietLine}\n`)
    return
  }
  process.stdout.write(`${humanLines.join('\n')}\n`)
}

/** Map error codes to deterministic agent action hints.
 *  Uses errorCode (not just exitCode) for finer granularity.
 *  Exit code 1 and 5 are subcategorized by error code. */
const ERROR_CODE_ACTIONS: Record<string, { action: string; retryable: boolean }> = {
  // Exit 0
  'E_OK': { action: 'NONE', retryable: false },
  // Exit 1 subcategories
  'E_NETWORK': { action: 'CHECK_NETWORK', retryable: false },
  'E_FORBIDDEN': { action: 'CHECK_SCOPES', retryable: false },
  'E_SERVER_ERROR': { action: 'RETRY_WITH_BACKOFF', retryable: true },
  'E_RATE_LIMITED': { action: 'WAIT_AND_RETRY', retryable: true },
  'E_API_ERROR': { action: 'RETRY_WITH_BACKOFF', retryable: true },
  'E_RUNTIME': { action: 'ESCALATE', retryable: false },
  // Exit 2
  'E_USAGE': { action: 'FIX_ARGS', retryable: false },
  // Exit 3
  'E_NOT_FOUND': { action: 'ESCALATE', retryable: false },
  // Exit 4
  'E_UNAUTHORIZED': { action: 'RUN_AUTH', retryable: false },
  // Exit 5 subcategories
  'E_LOCK_CONTENTION': { action: 'WAIT_AND_RETRY', retryable: true },
  'E_STALE_DATA': { action: 'REFETCH_AND_RETRY', retryable: true },
  'E_API_CONFLICT': { action: 'INSPECT_AND_RESOLVE', retryable: false },
  'E_CONFLICT': { action: 'WAIT_AND_RETRY', retryable: true },
  // Exit 130
  'E_INTERRUPTED': { action: 'NONE', retryable: false },
}

function writeError(ctx: OutputContext, message: string, errorCode: string, exitCode: ExitCode, errorName: string, context?: Record<string, unknown>): void {
  if (ctx.json) {
    const { action, retryable } = ERROR_CODE_ACTIONS[errorCode] ?? { action: 'ESCALATE', retryable: false }
    const errorPayload: Record<string, unknown> = { name: errorName, code: errorCode, action, retryable }
    if (context) errorPayload.context = context
    process.stderr.write(`${JSON.stringify({ status: 'error', message, error: errorPayload })}\n`)
    return
  }
  const line = ctx.quiet ? message : `[xero-cli] ${message}`
  process.stderr.write(`${line}\n`)
}
```

### File Structure

```
side-quest-xero-cli/
+-- src/
|   +-- cli/
|   |   +-- command.ts          # Arg parsing, command dispatch, output formatting
|   |   +-- commands/
|   |       +-- auth.ts         # OAuth2 PKCE + Keychain
|   |       +-- transactions.ts # GET /BankTransactions
|   |       +-- accounts.ts     # GET /Accounts
|   |       +-- invoices.ts     # GET /Invoices
|   |       +-- history.ts      # GET /BankTransactions (reconciled, grouped)
|   |       +-- reconcile.ts    # PUT /BankTransactions + PUT /Payments (stdin JSON)
|   |       +-- status.ts       # Preflight check (auth + API + config)
|   +-- xero/
|   |   +-- config.ts           # Load + validate env vars and .xero-config.json (Zod schema)
|   |   +-- api.ts              # xeroFetch() with retry, rate limit, error handling
|   |   +-- auth.ts             # Token management (Keychain, refresh, PKCE) -- uses raw fetch() for token refresh
|   |   +-- types.ts            # Xero API TypeScript interfaces
|   |   +-- errors.ts           # XeroAuthError, XeroApiError (with status), XeroConflictError (extends StructuredError)
|   |   +-- export.ts           # CSV/JSON export for unmatched transactions
|   +-- logging.ts              # LogTape setup (flag-to-level, sink selection, context)
|   +-- events.ts               # Event bus emitter (fire-and-forget to observability server)
|   +-- state/
|       +-- state.ts            # Reconciliation state (idempotency, via @side-quest/core/fs)
+-- tests/
|   +-- cli/
|   |   +-- command.test.ts     # Arg parsing tests
|   +-- xero/
|       +-- api.test.ts
|       +-- auth.test.ts
|       +-- reconcile.test.ts   # Reconciliation logic tests
|       +-- state.test.ts       # State management tests
+-- .claude/
|   +-- skills/
|       +-- xero-reconcile/
|           +-- SKILL.md        # Teaches Claude the workflow + CLI commands
+-- scripts/
|   +-- xero-auth-server.ts     # OAuth2 callback server (Bun.serve on 127.0.0.1:5555/callback)
+-- .env.example                # XERO_CLIENT_ID= (no secret needed with PKCE)
+-- .xero-config.json           # Runtime config: tenant ID, org name (gitignored)
+-- .xero-reconcile-state.json  # Run state for idempotency (gitignored)
+-- .xero-reconcile-runs/       # Timestamped audit reports from --execute runs (gitignored)
```

### CLI Entry Point

Add a `"xero-cli"` script to `package.json`:

```json
{
  "scripts": {
    "xero-cli": "bun src/cli/command.ts"
  }
}
```

Canonical invocation: `bun run xero-cli <command> [flags]`. This is the only documented way to run the CLI. No global `bin` install needed for a personal tool.

### Key Design Decisions

1. **CLI is a dumb pipe.** It moves data between Xero and stdout/stdin. No AI, no matching logic, no categorization. That's Claude's job.

2. **`reconcile` command reads JSON from stdin.** This is how Claude feeds it decisions. The CLI validates shape and executes.
   - **Write scope guard:** In `--execute` mode, reconcile first fetches the current unreconciled transaction IDs from Xero (`GET /BankTransactions?where=IsReconciled==false`) and validates that every `BankTransactionID` in the stdin input exists in that set. Reject any ID not in the current unreconciled set with a per-item error. This prevents writes to arbitrary transactions (e.g., already-reconciled or deleted ones) and bounds the mutation scope to the current session's candidates.
   - **AccountCode validation:** Before executing, fetch the chart of accounts and validate that every `AccountCode` in the input exists and is ACTIVE. Reject invalid codes with per-item errors rather than relying on Xero's validation alone.

3. **Two reconciliation modes in one command:**
   - **Account code assignment** -- for everyday expenses. `POST /BankTransactions/{BankTransactionID}` with updated LineItems containing the AccountCode. Xero marks as reconciled when a BankTransaction has complete LineItems with valid AccountCodes. If the BankTransaction already has LineItems with a different AccountCode, the update replaces them.
   - **Line item preservation contract:** When updating AccountCode, ONLY the AccountCode field changes. Before the POST, fetch the current BankTransaction and capture existing LineItems. In the update payload, preserve all other line item fields (Quantity, UnitAmount, TaxType, TaxAmount, LineAmount, Description). After the POST, verify the response's Total matches the pre-update Total -- if they differ, log a warning and flag in the audit report. This prevents accidental mutation of amounts or tax through line item replacement.
   - **Line item edge cases:**
     - **Zero line items:** If BankTransaction has no LineItems, create a single LineItem with the AccountCode, using the transaction's Total as LineAmount. Log as "created line item" (not "updated").
     - **Multiple line items:** If BankTransaction has >1 LineItem, update ALL of them to the new AccountCode. This is correct for simple expense categorization. If line items have DIFFERENT AccountCodes (split categorization), reject with a validation error: "BankTransaction has split line items -- manual categorization required." Do not silently overwrite intentional splits.
     - **Already-correct AccountCode:** If all LineItems already have the requested AccountCode, skip the API call and mark as `skipped` (idempotent). Do not POST unnecessarily -- avoids burning API quota and UpdatedDateUTC churn.
     - **Null/undefined LineItems:** Treat as zero line items (create a new one).
   - **Invoice matching** -- for payments against invoices. `PUT /Payments` with `IsReconciled: true`. The `Account` field in the payment request is derived from the BankTransaction's `BankAccount.AccountID` -- the bank account the transaction belongs to. During preflight, when fetching the BankTransaction pre-state snapshot, capture `BankAccount.AccountID` and carry it through to payment construction: `Account: { AccountID: bankTransaction.BankAccount.AccountID }`.
   - **Invoice validation fetch strategy:** During preflight (before any writes), batch-fetch all invoices referenced in the input. Use `GET /Invoices?IDs={comma-separated-ids}` (Xero supports comma-separated ID filter, max ~50 per request). Validate: (a) InvoiceID exists, (b) Status is AUTHORISED (not PAID/VOIDED), (c) AmountDue >= input Amount, (d) CurrencyCode matches input CurrencyCode. Cache fetched invoices for the execution phase. This avoids inline fetches during execution (deterministic latency) and bounds the cost to `ceil(invoiceCount / 50)` calls.
   - The input JSON distinguishes them: `{"BankTransactionID":"...","AccountCode":"6310"}` vs `{"BankTransactionID":"...","InvoiceID":"..."}`.
   - **Conflict rule:** If both `AccountCode` AND `InvoiceID` are present in one entry, reject with a deterministic validation error. Zod `.strict()` on each union branch enforces this.
   - **Duplicate BankTransactionID rule:** If the same BankTransactionID appears more than once in the input array, reject the entire payload with a validation error listing the duplicate IDs. Do not silently pick first/last -- duplicates indicate a bug in the caller.
   - **Empty input:** Empty array `[]` returns a validation error (`.min(1)` in Zod schema). This is intentional -- a zero-item reconcile is always a mistake.
   - **Batch strategy for account code updates:** Xero's BankTransactions endpoint does not support bulk update. Process account code entries individually with rate-limit throttling (~1100ms delay between calls, same as payment batching). Invoice matching uses batch `PUT /Payments` (batch size 25). Show progress bar with ETA for sequential operations (e.g., "Reconciling 300 transactions... [142/300] ~2m remaining").
   - **PRE-IMPLEMENTATION VALIDATION REQUIRED (BEFORE PHASE 1):** Before starting any implementation, manually validate in a Xero demo org that updating LineItems via POST /BankTransactions/{id} correctly marks transactions as reconciled. This is a plan-blocking assumption -- if it fails, the entire reconcile command design needs a fundamentally different approach. Concrete test: find an unreconciled BankTransaction, POST to update its LineItems with a valid AccountCode **and `IsReconciled: true`**, check if IsReconciled becomes true. This is the conversion/migration path Xero supports (imported transactions with no bank feed). Also test against locked periods, filed BAS periods, and already-coded transactions. Redirect URI is fixed: `http://127.0.0.1:5555/callback`. Document results. If POST doesn't reconcile, stop and redesign before investing in Phases 1-3.
   - **Fallback if POST doesn't reconcile:** If demo-org validation reveals that POST /BankTransactions/{id} with updated LineItems does NOT mark transactions as reconciled, the fallback is invoice-only matching for v1 (all reconciliation goes through PUT /Payments). Account-code assignment would be deferred or handled through a browser-automation fallback (agent-browser). This decision is made once, during Phase 3 validation, and documented in the plan.

4. **`history` command is the learning signal.** It returns past reconciled transactions grouped by contact, so Claude can say "you've categorized GITHUB INC as 6310 Software 6 times before." **`--since` is required** -- no default, to prevent unbounded API fetching that could exhaust the 5,000/day rate limit. Typical usage: `--since 2025-07-01` (last 6 months).

5. **Follows `/Users/nathanvale/code/side-quest-last-30-days/docs/plans/2026-02-25-feat-wots-logtape-observability-plan.md` patterns exactly.** Same arg parsing, same output contract, same exit codes, same error envelope. An agent that knows one knows both.

6. **`auth.ts` uses raw `fetch()` for token refresh.** Auth needs to make HTTP calls (token refresh) but `api.ts` needs auth (for tokens). Solution: `auth.ts` calls `fetch()` directly for the token endpoint (it's one URL). `api.ts` imports `auth.ts` for tokens. No circular dependency, no separate transport layer.

7. **Dropped xero-node SDK.** Deprecated April 28, 2026. Using direct `fetch()` against Xero REST API instead. Zero dependencies, full API coverage.

---

## Xero API Technical Specification

### API Constraints (confirmed via research)

- **No reconciliation API** -- Xero explicitly states "no immediate plans" to add this
- **Workaround:** Create payments with `isReconciled: true`; Xero auto-matches when amount/date/bank account align with a bank feed line
- **Bank Feeds API** is restricted to financial institutions -- not available
- **Rate limits:** 60 calls/min, 5,000/day per org, 5 concurrent requests
- **API budget estimate for full reconcile workflow (300 items, mixed account-code + invoice):**
  - Transactions (4 pages): ~4 calls
  - Accounts: 1 call
  - History (4 pages): ~4 calls
  - Invoices (2 pages): ~2 calls
  - Preflight write-scope validation (re-fetch unreconciled IDs): ~4 calls
  - Pre-state snapshot (1 per account-code item): ~270 calls (worst case)
  - Account-code POST (1 per item, sequential): ~270 calls
  - Payment batches (30 invoices / 25 per batch): ~2 calls
  - **Total estimate: ~557 calls for 300-item mixed run**
  - **Hard abort threshold (per-invocation):** If estimated call count for THIS `reconcile --execute` invocation exceeds 2,500 (half the daily limit), abort before execution with a warning: "This run would use ~{estimate} API calls ({percent}% of daily limit). Use --force to proceed or reduce batch size." The budget counts only calls within the current reconcile invocation, not cumulative across separate CLI invocations (each `bun run xero-cli` command is independent).
  - **Adaptive budget:** Before execution, estimate total calls from input mix and display: "Estimated API calls: {n}/{5000} daily limit"
- **OAuth2:** 30-min access tokens, single-use refresh tokens (60-day expiry if unused)
- **Granular scopes:** Apps created after 2 March 2026 MUST use granular scopes (broad scopes like `accounting.transactions` won't work). Broad scopes available until September 2027 for apps created before the cutoff. If creating the Xero app before March 2, use broad scopes; if after, use: `accounting.banktransactions accounting.payments accounting.invoices accounting.contacts accounting.settings.read offline_access`
- **`IsReconciled` filter is not "optimised"** for high-volume orgs -- always combine with Date range filter
- **Overpayments via API return validation error** -- can't overpay, must be exact or partial
- **200 responses can contain validation errors** -- always check `hasErrors` on results
- **Batch payments:** No documented batch limit -- Xero docs show multiple payments per PUT but don't specify a ceiling. Use a conservative batch size (e.g. 25) with a comment that the limit is empirically determined, not documented. Test and adjust.
- **Pagination:** 100 items per page default. Payments support `pageSize` up to 1000 for more efficient fetching. BankTransactions support `pageSize` but max not documented. Xero responses include `pagination.pageCount` and `pagination.itemCount` when available -- use `pageCount` to determine total pages rather than guessing. Increment page until `page >= pageCount` (or until items returned < pageSize as fallback if pagination metadata is absent).
- **Null handling:** Per Xero docs, "a null object may be represented as an empty array." Always use optional chaining and nullish coalescing.

### BankTransactions vs BankStatementLines

These are different things:
- **BankTransactions** = spend/receive money entries recorded in Xero's ledger. Has `IsReconciled` field. **This is what we query.**
- **BankStatementLines** = raw bank feed lines imported from bank feeds. No `IsReconciled` field. These are what's waiting to be matched.

We filter `BankTransactions` with `IsReconciled==false` to find unreconciled items. **NOTE:** The `where` clause syntax depends on the actual wire type of `IsReconciled`. If it's a boolean (per OpenAPI spec), `IsReconciled==false` is correct. If it's a string (per Xero docs), the correct syntax may be `IsReconciled=="false"`. Determine during wire type validation (PRE-IMPLEMENTATION task) and update accordingly. If Xero silently ignores an invalid filter (returning all transactions), the write scope guard would pass already-reconciled IDs through to mutation.

### TypeScript Interfaces

#### BankTransaction (GET /api.xro/2.0/BankTransactions)

```typescript
/** Fields we use from BankTransactions endpoint */
interface XeroBankTransaction {
  BankTransactionID: string
  Type: 'RECEIVE' | 'SPEND' | 'RECEIVE-OVERPAYMENT' | 'SPEND-OVERPAYMENT'
    | 'RECEIVE-PREPAYMENT' | 'SPEND-PREPAYMENT' | 'RECEIVE-TRANSFER' | 'SPEND-TRANSFER'
  Contact: {
    ContactID: string
    Name: string
  }
  BankAccount: {
    AccountID: string
    Code?: string
    Name?: string
  }
  Date: string              // .NET date format
  DateString: string        // "2014-05-26T00:00:00"
  Status: 'AUTHORISED' | 'DELETED'
  SubTotal: string          // Decimal as string: "49.90"
  TotalTax: string
  Total: string             // Decimal as string -- parse with Number()
  CurrencyCode: string      // ISO 4217 (e.g. "AUD")
  IsReconciled: string      // "true" | "false" (STRING, not boolean!)
  Reference?: string
  LineItems?: XeroLineItem[]
  UpdatedDateUTC: string
}

interface XeroLineItem {
  LineItemID: string
  Description?: string
  Quantity?: string         // Decimal as string
  UnitAmount?: string       // Decimal as string
  AccountCode?: string      // e.g. "6310"
  TaxType?: string
  TaxAmount?: string
  LineAmount?: string
}
```

**Gotcha:** `IsReconciled` is a **string** ("true"/"false"), not a boolean.

**PRE-IMPLEMENTATION: Wire type validation required.** The types above are based on Xero documentation, which may disagree with actual API responses. Before coding types.ts, make a real `GET /BankTransactions?page=1` call against the demo org and log the raw JSON. Confirm actual types of:
- `IsReconciled` -- string "true"/"false" or boolean true/false?
- `Total`, `SubTotal`, `TotalTax` -- string "49.90" or number 49.90?
- `LineItem.Quantity`, `LineItem.UnitAmount` -- string or number?

Update interfaces to match wire reality. If types are numbers (not strings), remove string-parsing logic. If types are strings, add a centralized `parseXeroDecimal()` utility:

```typescript
/** Parse Xero string-encoded decimals. Handles empty string, "0.00", and null.
 *  Returns NaN for unparseable values (callers must check). */
function parseXeroDecimal(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return value
  const parsed = Number(value)
  if (Number.isNaN(parsed)) {
    throw new XeroApiError(`Unparseable decimal value: "${value}"`)
  }
  return parsed
}
```

#### Invoice (GET /api.xro/2.0/Invoices)

```typescript
/** Fields we use from Invoices endpoint */
interface XeroInvoice {
  InvoiceID: string
  InvoiceNumber: string
  Type: 'ACCREC' | 'ACCPAY'
  Contact: {
    ContactID: string
    Name: string
  }
  Date: string              // .NET date format
  DateString: string        // "2014-05-26T00:00:00"
  DueDate: string           // .NET date format
  DueDateString: string     // "2014-06-26T00:00:00"
  Status: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED'
  SubTotal: number
  TotalTax: number
  Total: number
  AmountDue: number
  AmountPaid: number
  AmountCredited: number
  CurrencyCode: string
  CurrencyRate: number
  Reference?: string        // ACCREC only
  Payments?: XeroPayment[]
  UpdatedDateUTC: string
  HasErrors?: boolean
  ValidationErrors?: XeroValidationError[]
}
```

#### Payment (PUT /api.xro/2.0/Payments)

```typescript
/** Payment creation input */
interface XeroPaymentInput {
  Invoice: { InvoiceID: string } | { InvoiceNumber: string }
  Account: { AccountID: string } | { Code: string }
  Date: string
  Amount: number
  Reference?: string
  IsReconciled?: boolean
}

/** Payment response from Xero */
interface XeroPayment {
  PaymentID: string
  Date: string
  Amount: number                     // In invoice currency
  BankAmount: number                 // In bank account currency
  CurrencyRate: number
  Reference?: string
  IsReconciled: boolean              // NOTE: boolean (unlike BankTransaction!)
  Status: 'AUTHORISED' | 'DELETED'
  PaymentType: 'ACCRECPAYMENT' | 'ACCPAYPAYMENT' | 'ARCREDITPAYMENT' | 'APCREDITPAYMENT'
  Account: {
    AccountID: string
    Code?: string
  }
  Invoice?: {
    InvoiceID: string
    InvoiceNumber: string
    Type: 'ACCREC' | 'ACCPAY'
    Contact?: { ContactID: string; Name: string }
  }
  HasValidationErrors?: boolean
  ValidationErrors?: XeroValidationError[]
  StatusAttributeString?: 'OK' | 'WARNING' | 'ERROR'
  UpdatedDateUTC: string
}
```

**Gotchas:**
- `IsReconciled` is a **boolean** on Payment (unlike BankTransaction where it's a string!)
- `Amount` must be <= `AmountDue` on the invoice -- API rejects overpayments
- Delete a payment: `POST /Payments/{PaymentID}` with `{ "Status": "DELETED" }`
- **Rollback procedure (documented in audit report):**
  - **Payments:** For each PaymentID in the audit report, `POST /Payments/{PaymentID}` with `{"Status":"DELETED"}`. The audit report contains all PaymentIDs needed.
  - **Account codes:** For each BankTransactionID, `POST /BankTransactions/{id}` with the original LineItems from the audit report's pre-state snapshot. The audit report contains the original AccountCode and full LineItems payload for each item.
  - **Mixed success/fail:** The audit report's per-item correlation allows selective rollback of only succeeded items. Failed items need no rollback.
- Batch: `PUT /Payments?SummarizeErrors=false` with `{ "Payments": [...] }` -- no documented max, use conservative batch size (e.g. 25)

#### Account (GET /api.xro/2.0/Accounts)

```typescript
/** Chart of accounts entry */
interface XeroAccount {
  AccountID: string
  Code: string            // e.g. "6310"
  Name: string            // e.g. "Software & SaaS"
  Type: 'REVENUE' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY' | 'CURRENT' | 'FIXED'
    | 'CURRLIAB' | 'TERMLIAB' | 'DIRECTCOSTS' | 'OVERHEADS' | 'DEPRECIATION'
    | 'OTHERINCOME' | 'BANK' | 'PREPAYMENT' | 'SALES' | 'PAYGLIABILITY'
    | 'SUPERANNUATIONEXPENSE' | 'WAGESEXPENSE'
    | (string & {})  // Allow unknown types without losing autocomplete on known ones
  Status: 'ACTIVE' | 'ARCHIVED'
  TaxType?: string
  Description?: string
  Class: 'ASSET' | 'EQUITY' | 'EXPENSE' | 'LIABILITY' | 'REVENUE'
  EnablePaymentsToAccount?: boolean
}
```

#### Connection (GET /connections -- Identity API)

```typescript
/** Connection from Identity API -- bare JSON array, no envelope */
interface XeroConnection {
  id: string              // Connection UUID
  tenantId: string        // Use as xero-tenant-id header
  tenantType: 'ORGANISATION' | 'PRACTICEMANAGER' | 'PRACTICE'
  tenantName: string | null
  createdDateUtc: string  // ISO 8601
  updatedDateUtc: string
}
```

**Important:** This is the **Identity API** at `https://api.xero.com/connections` (NOT `/api.xro/2.0/`). Returns a bare JSON array -- no envelope. The `tenantId` becomes the `xero-tenant-id` header for all Accounting API calls.

#### Organisation (GET /api.xro/2.0/Organisation)

```typescript
/** Minimal org info for preflight/display */
interface XeroOrganisation {
  OrganisationID: string
  Name: string
  LegalName: string
  ShortCode: string       // Unique code e.g. "!23eYt"
  BaseCurrency: string    // ISO 4217
  CountryCode: string     // ISO 3166-2
  IsDemoCompany: boolean
  Version: string         // Region: "AU", "NZ", "UK", "US", "GLOBAL"
}
```

#### Validation Errors (batch responses)

```typescript
/** Per-item error from batch responses with ?SummarizeErrors=false */
interface XeroValidationError {
  Message: string         // Human-readable error description
}

/** Standard API error response (HTTP 400) */
interface XeroApiErrorResponse {
  ErrorNumber: number     // e.g. 10
  Type: string            // e.g. "ValidationException"
  Message: string         // e.g. "A validation exception occurred"
  Elements?: Array<{
    ValidationErrors: XeroValidationError[]
  }>
}

/** Standard Xero Accounting API response envelope.
 *  MUST be a `type` alias (not interface) because mapped types are invalid in interfaces. */
type XeroResponse<T extends string, V> = {
  Id: string
  Status: 'OK'
  DateTimeUTC: string
  pagination?: XeroPagination
} & { [K in T]: V[] }       // e.g. BankTransactions: XeroBankTransaction[]

/** Pagination metadata (present when endpoint supports paging) */
interface XeroPagination {
  page: number
  pageSize: number
  pageCount: number
  itemCount: number
}
```

**Batch behavior with `?SummarizeErrors=false`:**
- Always returns HTTP 200, even if individual items fail
- Each item gets `StatusAttributeString: "OK" | "WARNING" | "ERROR"`
- Failed items have `ValidationErrors` array and `HasValidationErrors: true`
- Without this flag, a single validation error causes HTTP 400 for the whole batch

#### Reconciliation Input (stdin JSON for `reconcile` command)

```typescript
/** Account code assignment (everyday expenses) */
interface AccountCodeReconciliation {
  BankTransactionID: string
  AccountCode: string       // e.g. "6310"
}

/** Invoice matching (payment against invoice).
 *  Amount is required to prevent silent currency/amount mismatches.
 *  The CLI validates that Amount <= Invoice.AmountDue and that
 *  CurrencyCode matches the invoice currency before creating the payment. */
interface InvoiceReconciliation {
  BankTransactionID: string
  InvoiceID: string
  Amount: number           // Required -- prevents silent mismatches. Must equal BankTransaction.Total for full reconciliation.
  CurrencyCode: string     // Required -- ISO 4217. CLI validates against invoice currency.
}

type ReconciliationEntry = AccountCodeReconciliation | InvoiceReconciliation
```

**Stdin validation (Zod schema, strict parsing):**

```typescript
const MAX_ENTRIES = 1000

const accountCodeEntrySchema = z.object({
  BankTransactionID: z.string().regex(/^[0-9a-fA-F-]{36}$/),  // UUID-shaped but not strictly v4 -- Xero may return non-canonical casing or non-v4 UUIDs
  AccountCode: z.string().regex(/^[A-Za-z0-9]{1,10}$/),  // Xero account codes can be alphanumeric, not just 4-digit. Max 10 chars per Xero docs.
}).strict()

const invoiceEntrySchema = z.object({
  BankTransactionID: z.string().regex(/^[0-9a-fA-F-]{36}$/),
  InvoiceID: z.string().regex(/^[0-9a-fA-F-]{36}$/),
  Amount: z.number().positive(),         // Required -- prevents silent amount mismatches
  CurrencyCode: z.string().length(3),    // ISO 4217 -- validated against invoice currency pre-execution
}).strict()

const reconciliationEntrySchema = z.union([accountCodeEntrySchema, invoiceEntrySchema])
const reconciliationInputSchema = z.array(reconciliationEntrySchema).min(1).max(MAX_ENTRIES)

// In reconcile command:
// SECURITY: Stream stdin with incremental byte counting and early abort.
// Bun.stdin.text() buffers the full input before returning, so a post-read
// size check doesn't prevent memory exhaustion from oversized/slow stdin.
// Instead, read chunks and abort once the limit is exceeded.
const MAX_STDIN_BYTES = 5 * 1024 * 1024
const chunks: Uint8Array[] = []
let totalBytes = 0
for await (const chunk of Bun.stdin.stream()) {
  totalBytes += chunk.byteLength
  if (totalBytes > MAX_STDIN_BYTES) {
    throw new UsageError(`Stdin input exceeds ${MAX_STDIN_BYTES} byte limit`)
  }
  chunks.push(chunk)
}
const raw = Buffer.concat(chunks).toString('utf-8')
const entries = reconciliationInputSchema.parse(JSON.parse(raw))
```

---

## Security

### PKCE OAuth2

- **No `client_secret`** -- Xero supports "Auth Code with PKCE" app type natively for CLI apps
- Code verifier (32 random bytes, base64url) + SHA-256 challenge per auth session
- OAuth2 `state` parameter via `generateSecureToken()` from `@side-quest/core/password` -- validated in callback to prevent CSRF

### macOS Keychain Token Storage

All tokens stored as a **single serialized JSON blob** in one Keychain entry, making updates atomic (all-or-nothing). This prevents torn state if a crash occurs mid-save.

**Reverse-DNS service name** avoids collisions with other tools.

```typescript
const KEYCHAIN_SERVICE = 'com.nathanvale.side-quest-xero-cli.xero'
const KEYCHAIN_ACCOUNT = 'oauth-tokens'

/** All tokens stored together for atomic read/write */
interface KeychainTokenBundle {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** Zod schema for runtime validation of Keychain data (prevents corrupted tokens flowing through) */
const keychainTokenBundleSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
})

/** Save all tokens as a single atomic Keychain entry.
 *  Pipes JSON via stdin to avoid token leakage in process arguments (ps aux). */
async function saveTokens(tokens: KeychainTokenBundle): Promise<void> {
  const json = JSON.stringify(tokens)
  const proc = Bun.spawn(['security', 'add-generic-password',
    '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-U', '-w'], {
    stdin: 'pipe',
  })
  proc.stdin.write(json)
  proc.stdin.end()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new XeroAuthError('Failed to save tokens to Keychain. Grant Terminal access: System Settings > Privacy & Security > Keychain Access.')
  }
}

/** Raw Keychain read without validation or side effects.
 *  Used by deleteTokens() to avoid recursive loop (loadTokens -> deleteTokens -> loadTokens). */
async function loadTokensRaw(): Promise<KeychainTokenBundle | null> {
  try {
    const proc = Bun.spawn(['security', 'find-generic-password',
      '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'])
    const text = await new Response(proc.stdout).text()
    const trimmed = text.trim()
    if (!trimmed) return null
    return JSON.parse(trimmed) as KeychainTokenBundle
  } catch { return null }
}

/** Load all tokens from a single Keychain entry.
 *  Validates against Zod schema -- corrupted data triggers re-auth. */
async function loadTokens(): Promise<KeychainTokenBundle | null> {
  try {
    const proc = Bun.spawn(['security', 'find-generic-password',
      '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'])
    const text = await new Response(proc.stdout).text()
    const trimmed = text.trim()
    if (!trimmed) return null
    const parsed = keychainTokenBundleSchema.safeParse(JSON.parse(trimmed))
    if (!parsed.success) {
      await deleteTokens()
      throw new XeroAuthError('Corrupted token data in Keychain. Run: bun run xero-cli auth')
    }
    return parsed.data
  } catch (err) {
    if (err instanceof XeroAuthError) throw err
    return null
  }
}

/** Revoke tokens with Xero before deleting from Keychain.
 *  Refresh tokens have 60-day lifetime -- revocation prevents misuse if compromised.
 *  SECURITY: Uses loadTokensRaw() instead of loadTokens() to avoid recursive loop.
 *  loadTokens() calls deleteTokens() on corruption, which would call loadTokens() again. */
async function deleteTokens(): Promise<void> {
  const tokens = await loadTokensRaw().catch(() => null)
  if (tokens) {
    try {
      await fetch('https://identity.xero.com/connect/revocation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: tokens.refreshToken,
          client_id: config.clientId,
        }),
      })
    } catch { /* best-effort -- still delete from Keychain */ }
  }
  const proc = Bun.spawn(['security', 'delete-generic-password',
    '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT])
  await proc.exited
}
```

### Security Rules

- **Hard-fail** if Keychain unavailable (no file-based fallback -- plaintext tokens on disk are unacceptable for a financial API tool). Distinguish between "not found" (run auth), "access denied" (Terminal lacks Keychain permission -- give actionable System Settings path), and "locked" (unlock Keychain). Never silently map permission errors to "not authenticated."
- **One-shot callback** server -- state is single-use (marked consumed after first valid callback), code parameter validated for presence before exchange, server stops via `queueMicrotask(() => server.stop())` after first valid callback, subsequent requests return 400
- **Callback `state` validation** -- use `crypto.timingSafeEqual()` for constant-time comparison of the `state` query parameter against the stored value. Reject immediately if mismatch. Clear stored state after first use.
- **Callback response** -- return static HTML only (`<h1>Authenticated</h1><p>You can close this tab.</p>`). Set `Content-Type: text/html; charset=utf-8` and `X-Content-Type-Options: nosniff`. NEVER interpolate query parameters into the response body (prevents reflected XSS).
- **Callback server binds to `127.0.0.1`** -- not `0.0.0.0`, prevents LAN access
- **Callback server uses fixed redirect URI** `http://127.0.0.1:5555/callback` -- must match the Xero app redirect URI.
- **Callback server binds port BEFORE opening browser** -- if port binding fails, error immediately. Never open the browser if the callback server isn't listening.
- **Callback server timeout** -- 300s default (5 minutes -- first-run consent with MFA needs time) via `withTimeout()` from `@side-quest/core/concurrency`. Configurable via `--auth-timeout <seconds>`. On timeout, print: "Auth timed out after {timeout}s. Run `bun run xero-cli auth` to try again." Exit code 4 (RUN_AUTH), NOT exit code 1 (RETRY_WITH_BACKOFF). During wait, print "Waiting for Xero login... (timeout in {remaining})" to stderr so Nathan knows the clock is ticking
- **Process lock** via `withFileLock()` for `--execute` mode (concurrent runs fail-fast). Lock must have: explicit timeout (30s default), stale lock detection (PID check + age-based cleanup if process is dead), and bounded wait time. If lock is orphaned by a crash, next invocation detects stale PID and reclaims.
- **`timingSafeEqual` length guard** -- before calling `crypto.timingSafeEqual()` on OAuth `state`, verify both buffers have equal byte length. Mismatched lengths cause `timingSafeEqual` to throw; guard with early reject if lengths differ.
- **Response validation** type guards before state mutation (validate PaymentID/InvoiceID exist and are correct types)
- **0o600 permissions** on state files, reports, CSV exports, AND `.xero-config.json`. On READ, verify file is not a symlink (`lstatSync` -> reject if `isSymbolicLink()`) and permissions are not more permissive than 0o600. Use atomic writes (write temp + fsync + rename) for all state/config files. **Atomic write spec:** temp file MUST be in same directory as target (ensures same filesystem for rename atomicity). Use `Bun.write()` with `{ mode: 0o600 }` for temp, then `fs.renameSync()`. Note: Bun's `Bun.write()` does not expose explicit `fsync` -- verify empirically whether Bun flushes before returning, and document the finding. If Bun doesn't guarantee flush, use `node:fs` `writeFileSync` + `fsyncSync` instead.
- **Never log tokens** -- redact Authorization headers in errors. Safe to log: transaction IDs, amounts, counts, timestamps, error messages (without headers).
- **Error context sanitization** -- NEVER pass request bodies, headers, tokens, codes, or verifiers into error constructor `context`. Safe to include: transaction IDs, amounts, counts, status codes, timestamps, endpoint paths.
- **Error message sanitization** -- before outputting error messages to stderr, strip sensitive patterns:
  ```typescript
  function sanitizeErrorMessage(message: string): string {
    return message
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
      .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=[REDACTED]')
      .replace(/code=[^&\s]+/gi, 'code=[REDACTED]')
      .replace(/code_verifier=[^&\s]+/gi, 'code_verifier=[REDACTED]')
      .replace(/client_id=[^&\s]+/gi, 'client_id=[REDACTED]')
      .replace(/xero-tenant-id:\s*[^\s,}]+/gi, 'xero-tenant-id: [REDACTED]')
  }
  ```
- **Stdin JSON validation** -- reconcile command validates all input against Zod schema before any API calls. Enforce max 1000 entries. Validate field formats (UUID-shaped regex for IDs, `^[A-Za-z0-9]{1,10}$` for AccountCode, positive number for Amount, 3-char string for CurrencyCode). Reject unexpected fields (strict parsing). Reject duplicate BankTransactionIDs. See Reconciliation Input section.
- **Token revocation** -- on re-auth or logout, revoke tokens with Xero's revocation endpoint before deleting from Keychain. Refresh tokens have 60-day lifetime.
- **Keychain data validation** -- Zod schema validation on `loadTokens()`. Corrupted data triggers deletion + re-auth prompt.
- **Auth scopes:** `accounting.transactions accounting.contacts accounting.settings.read offline_access` -- accounting.settings.read is required for GET /Accounts (chart of accounts) and GET /Organisation (preflight/status). Note: if app is created after 2 March 2026, use granular scopes instead: `accounting.banktransactions accounting.payments accounting.invoices accounting.contacts accounting.settings.read offline_access`

---

## Auth Implementation

### PKCE S256 Flow

```typescript
/** Generate a code verifier per Xero PKCE spec.
 *  Spec requires: 43-128 chars from charset [A-Z, a-z, 0-9, -._~].
 *  32 random bytes base64url-encoded produces ~43 chars (at the spec minimum).
 *  Using 48 bytes produces ~64 chars for comfortable margin. */
function generateCodeVerifier(): string {
  const buffer = new Uint8Array(48)
  crypto.getRandomValues(buffer)
  return base64url(buffer)  // ~64 chars, well within 43-128 range. MUST be unpadded, URL-safe per RFC 7636 (strip '=', replace '+' with '-', '/' with '_').
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(hash))
}

/** Build auth URL with fixed callback redirect URI. */
function getAuthorizationUrl(codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: 'http://127.0.0.1:5555/callback',
    scope: 'accounting.transactions accounting.contacts accounting.settings.read offline_access',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  return `https://login.xero.com/identity/connect/authorize?${params}`
}
```

### Token Refresh

Token refresh with cross-process file lock. Xero refresh tokens are single-use -- if two CLI processes refresh simultaneously, one invalidates the other's token. Use `withFileLock('xero-token-refresh', ...)` to serialize refresh across concurrent CLI invocations. If lock is held, wait briefly then retry (the other process's refresh will have saved fresh tokens to Keychain):

```typescript
/** Ensure we have a valid access token. Refresh if expired. */
async function ensureFreshToken(): Promise<string> {
  const tokens = await loadTokens()
  if (!tokens) throw new XeroAuthError('Not authenticated. Run: bun run xero-cli auth')

  if (!isTokenExpired(tokens.expiresAt, 5 * 60 * 1000)) {
    return tokens.accessToken
  }

  // Cross-process lock: Xero refresh tokens are single-use.
  // Without lock, concurrent CLI processes could both try to refresh,
  // one succeeds, the other invalidates the new refresh token.
  return await withFileLock('xero-token-refresh', async () => {
    // Re-check after acquiring lock -- another process may have refreshed
    const freshCheck = await loadTokens()
    if (freshCheck && !isTokenExpired(freshCheck.expiresAt, 5 * 60 * 1000)) {
      return freshCheck.accessToken
    }
    try {
      // SECURITY: Use freshCheck.refreshToken (re-read inside lock), NOT the pre-lock tokens.
      // Xero refresh tokens are single-use -- using a stale token triggers invalid_grant.
      const tokenToRefresh = freshCheck?.refreshToken ?? tokens.refreshToken
      const response = await fetchNewTokens(tokenToRefresh)
      await saveTokens({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresAt: response.expiresAt,
      })
      return response.accessToken
    } catch (refreshError) {
      // SECURITY: If Xero returned new tokens but saveTokens() failed (Keychain locked,
      // permission denied), the old refresh token is already burned. Retry save once
      // before giving up. If retry also fails, the session is unrecoverable.
      if (refreshError instanceof Error && refreshError.message.includes('Failed to save tokens')) {
        throw new XeroAuthError(
          'Token refresh succeeded but Keychain save failed. Grant Terminal Keychain access: '
          + 'System Settings > Privacy & Security > Keychain Access. Then run: bun run xero-cli auth'
        )
      }
      throw new XeroAuthError('Session expired. Run: bun run xero-cli auth')
    }
  })
}
```

### Tenant Selection

After first auth, call `GET /connections` to list connected orgs. The response is a bare JSON array (not wrapped in an envelope) with fields: `id`, `authEventId`, `tenantId`, `tenantType`, `tenantName`, `createdDateUtc`, `updatedDateUtc`. Filter to `tenantType === "ORGANISATION"` only.

**Selection logic:**
- Auto-select the first org, confirm to user ("Connected to Nathan Vale Consulting (AU)")
- If 0 orgs: error with instructions to re-auth and grant org access
- If multiple orgs: print them with tenant IDs and tell user to set `tenantId` manually in `.xero-config.json`

**Persist to `.xero-config.json`** (not `.env` -- separate static config from runtime state, written with `0o600` permissions):
```json
{
  "tenantId": "70784a63-d24b-46a9-a4db-0e70a274b056",
  "tenantName": "Nathan Vale Consulting",
  "tenantType": "ORGANISATION",
  "connectionId": "e1eede29-f875-4a5d-8470-17f6a29a88b1"
}
```

**Display:** Show org name before any actions. If `.xero-config.json` missing, prompt to run `auth` first.

**Uncertified app limits:** Uncertified apps limited to 25 tenant connections. Individual Xero orgs limited to 2 uncertified app connections. For a personal tool this is fine, but document it.

### Configuration (config.ts)

Loads and validates all configuration from env vars and `.xero-config.json`:

```typescript
import { z } from 'zod'

const configFileSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string().min(1),
  tenantType: z.literal('ORGANISATION'),
  connectionId: z.string().uuid(),
})

interface XeroConfig {
  clientId: string           // from XERO_CLIENT_ID env var (required)
  tenantId: string           // from .xero-config.json
  tenantName: string         // from .xero-config.json
  connectionId: string       // from .xero-config.json
}

/** Load config. Throws with actionable error messages:
 *  - Missing XERO_CLIENT_ID -> "Set XERO_CLIENT_ID in .env"
 *  - Missing .xero-config.json -> "Run: bun run xero-cli auth"
 *  - Invalid .xero-config.json -> "Corrupted config. Run: bun run xero-cli auth" */
function loadConfig(): XeroConfig {
  const clientId = process.env.XERO_CLIENT_ID
  if (!clientId) throw new XeroAuthError('XERO_CLIENT_ID not set. Copy .env.example to .env and add your Client ID.')

  const configPath = '.xero-config.json'
  if (!existsSync(configPath)) throw new XeroAuthError('Not configured. Run: bun run xero-cli auth')

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
  const parsed = configFileSchema.safeParse(raw)
  if (!parsed.success) throw new XeroAuthError('Corrupted .xero-config.json. Run: bun run xero-cli auth')

  return { clientId, ...parsed.data }
}

/** Get tenant ID for API calls. Called by xeroFetch(). */
function getTenantId(): string {
  return loadConfig().tenantId
}
```

---

## HTTP Layer

### Xero API Client (api.ts)

All Xero API calls go through `xeroFetch()`. Auth, retry (429/503), and error handling are centralized here. `auth.ts` uses raw `fetch()` directly for token refresh (one endpoint, no retry needed) to avoid circular imports:

```typescript
import { retry } from '@side-quest/core/utils'

const XERO_API_BASE = process.env.XERO_API_BASE_URL ?? 'https://api.xero.com/api.xro/2.0'

const XERO_REQUEST_TIMEOUT_MS = 30_000 // 30s per-request timeout (prevents hang after laptop sleep/wake)

async function xeroFetch(path: string, options?: RequestInit): Promise<Response> {
  return retry(async () => {
    const token = await ensureFreshToken()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), XERO_REQUEST_TIMEOUT_MS)
    try {
    const response = await fetch(`${XERO_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'xero-tenant-id': getTenantId(),
        'Accept': 'application/json',
        ...options?.headers,
      },
    })
    if (response.status === 401) throw new XeroAuthError('Token expired -- re-auth needed')
    if (response.status === 412) throw new XeroConflictError('Precondition failed -- stale data, refetch before retrying', { status: 412 })
    if (response.status === 429 || response.status === 503) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 5)
      const limitProblem = response.headers.get('X-Rate-Limit-Problem') ?? 'unknown'
      // Human-visible retry notification (not just logger)
      process.stderr.write(`[xero-cli] Rate limited by Xero (${limitProblem}). Waiting ${retryAfter}s before retry...\n`)
      throw new XeroApiError(`Xero rate limit exceeded (${limitProblem}). Try again in ${retryAfter}s.`, { status: response.status, retryAfter })
    }
    if (!response.ok) throw new XeroApiError(`API error: ${response.status}`, { status: response.status })

    // Log remaining quota for proactive throttling awareness.
    // IMPORTANT: Rate-limit warnings are visible in ALL modes (not just --verbose).
    // During 5+ minute reconciliation runs, invisible throttling is unacceptable.
    const minRemaining = response.headers.get('X-MinLimit-Remaining')
    const dayRemaining = response.headers.get('X-DayLimit-Remaining')
    const appMinRemaining = response.headers.get('X-AppMinLimit-Remaining')
    if (minRemaining && Number(minRemaining) < 10) {
      // Human-visible warning (stderr, all modes) -- not just logger
      process.stderr.write(`[xero-cli] Approaching rate limit: ${minRemaining} calls left this minute. Throttling.\n`)
      logger.warn('Rate limit warning: {remaining} calls remaining this minute', { remaining: minRemaining })
    }
    if (dayRemaining && Number(dayRemaining) < 100) {
      process.stderr.write(`[xero-cli] Daily limit warning: ${dayRemaining} calls remaining today.\n`)
      logger.warn('Daily limit warning: {remaining} calls remaining today', { remaining: dayRemaining })
    }
    if (appMinRemaining && Number(appMinRemaining) < 10) {
      logger.warn('App rate limit warning: {remaining} calls remaining this minute', { remaining: appMinRemaining })
    }

    return response
    } finally {
      clearTimeout(timeoutId)
    }
  }, {
    maxAttempts: 3,
    shouldRetry: (error) => error instanceof XeroApiError && [429, 500, 503].includes(error.status),
  })
}

// POST convenience wrapper -- returns unknown to force callers through type guards
async function xeroPost(path: string, body: unknown): Promise<unknown> {
  const response = await xeroFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json()
}
```

### Batch Payment Creation

```typescript
import { chunk } from '@side-quest/core/utils'

/** Type guard for BankTransaction POST responses. Validates shape, success status,
 *  and Total match BEFORE state mutation. BankTransaction uses `HasErrors` (not
 *  `HasValidationErrors` like Payment -- different field name per endpoint).
 *  Lives in: src/cli/commands/reconcile.ts (reconciliation-specific, not generic HTTP layer).
 *  Imports: parseXeroDecimal from ../xero/types, logger from @logtape/logtape, XeroApiError from ../xero/errors. */
function assertValidBankTransactionResponse(
  response: unknown,
  expectedTotal: number,
): asserts response is { BankTransactionID: string; Total: string | number; LineItems: unknown[]; HasErrors?: boolean } {
  if (!response || typeof response !== 'object') {
    throw new XeroApiError('Malformed BankTransaction response: not an object')
  }
  const r = response as Record<string, unknown>
  if (typeof r.BankTransactionID !== 'string' || !r.BankTransactionID) {
    throw new XeroApiError('Malformed BankTransaction response: missing BankTransactionID')
  }
  // BankTransaction uses HasErrors, NOT HasValidationErrors
  if (r.HasErrors === true) {
    const errors = Array.isArray(r.ValidationErrors) ? r.ValidationErrors : []
    const msg = errors.map((e: { Message?: string }) => e.Message).filter(Boolean).join('; ')
    throw new XeroApiError(`BankTransaction update failed: ${msg || 'unknown validation error'}`)
  }
  // Verify Total hasn't changed (line item preservation contract)
  const responseTotal = parseXeroDecimal(r.Total as string | number)
  if (Math.abs(responseTotal - expectedTotal) > 0.01) {
    // Don't throw -- flag as warning in audit journal, but allow the operation
    logger.warn('Total mismatch after update: expected {expected}, got {actual}', {
      expected: expectedTotal, actual: responseTotal, bankTransactionId: r.BankTransactionID,
    })
  }
}

/** Type guard: validate required fields AND success status before state mutation.
 *  Named function (not inline) for testability and TypeScript assertion narrowing.
 *  SECURITY: Also checks HasValidationErrors and StatusAttributeString to prevent
 *  marking failed payments as reconciled. */
function assertValidPaymentResponse(
  payment: unknown,
): asserts payment is { PaymentID: string; Amount: number; Invoice: { InvoiceID: string }; StatusAttributeString?: string } {
  if (!payment || typeof payment !== 'object') {
    throw new XeroApiError('Malformed payment response: not an object')
  }
  const p = payment as Record<string, unknown>
  if (typeof p.PaymentID !== 'string' || !p.PaymentID) {
    throw new XeroApiError('Malformed payment response: missing PaymentID')
  }
  if (typeof p.Amount !== 'number') {
    throw new XeroApiError('Malformed payment response: missing Amount')
  }
  // Xero can return StatusAttributeString: "ERROR" even without HasValidationErrors
  if (p.StatusAttributeString === 'ERROR') {
    throw new XeroApiError('Payment response has ERROR status despite passing validation')
  }
  if (p.HasValidationErrors === true) {
    throw new XeroApiError('Payment response has validation errors')
  }
}

/** Check if error is retryable (429/503) vs deterministic (400/validation) */
function isRetryableError(error: unknown): boolean {
  if (error instanceof XeroApiError) {
    return error.status === 429 || error.status === 500 || error.status === 503
  }
  return false
}

const RATE_LIMIT_DELAY_MS = 1100  // ~55 req/min to leave headroom under 60/min limit

// NOTE: Xero docs don't specify a max batch size for PUT /Payments.
// Using 25 as conservative default -- test and adjust empirically.
async function createPaymentsBatched(payments: XeroPaymentInput[], batchSize = 25): Promise<PaymentResult[]> {
  const results: PaymentResult[] = []
  for (const batch of chunk(payments, batchSize)) {
    try {
      const response = await xeroPost('/Payments?SummarizeErrors=false', { Payments: batch })
      for (const payment of response.Payments ?? []) {
        if (payment.HasValidationErrors) {
          results.push({ success: false, errors: payment.ValidationErrors })
        } else {
          assertValidPaymentResponse(payment)
          await state.markProcessed(payment.Invoice.InvoiceID, payment.PaymentID)
          results.push({ success: true, payment })
        }
      }
    } catch (error) {
      if (isRetryableError(error)) {
        // Retryable (429/503) -- do NOT cascade into N individual calls
        for (const p of batch) {
          results.push({ success: false, input: p, error })
        }
      } else {
        // Non-retryable -- fall back to individual creation with throttling
        for (const p of batch) {
          try {
            const response = await xeroPost('/Payments', p)
            const created = response.Payments?.[0]
            assertValidPaymentResponse(created)
            await state.markProcessed(p.Invoice.InvoiceID, created.PaymentID)
            results.push({ success: true, payment: created })
          } catch (individualError) {
            results.push({ success: false, input: p, error: individualError })
          }
          await Bun.sleep(RATE_LIMIT_DELAY_MS)
        }
      }
    }
  }
  return results
}
```

---

## Error Handling

### Error Hierarchy

Three error classes. Each overrides the constructor to accept domain-specific options and internally maps to `StructuredError`'s positional params. `XeroApiError` carries a `status` field for branching on HTTP status codes:

```typescript
import { StructuredError } from '@side-quest/core/errors'
import { getErrorMessage } from '@side-quest/core/utils'

class XeroAuthError extends StructuredError {
  constructor(message: string, cause?: Error) {
    super(message, 'AUTH_ERROR', 'E_UNAUTHORIZED', false, {}, cause)
    this.name = 'XeroAuthError'
  }
}

class XeroApiError extends StructuredError {
  status: number
  retryAfter?: number

  constructor(message: string, options?: { status?: number; retryAfter?: number; cause?: Error }) {
    const status = options?.status ?? 0
    const recoverable = [429, 500, 503].includes(status)
    const category = status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'SERVER_ERROR' : 'API_ERROR'
    // NOTE: This constructor code (e.g., E_API_502) is for internal logging/StructuredError only.
    // The canonical error code for the JSON error envelope comes from exitCodeFromError(),
    // which maps status >= 500 to E_SERVER_ERROR. The constructor value is NOT surfaced to agents.
    const code = status === 403 ? 'E_FORBIDDEN' : status === 429 ? 'E_RATE_LIMITED' : `E_API_${status}`
    super(message, category, code, recoverable, { status }, options?.cause)
    this.name = 'XeroApiError'
    this.status = status
    this.retryAfter = options?.retryAfter
  }
}

class XeroConflictError extends StructuredError {
  constructor(message: string, options?: { status?: number; cause?: Error }) {
    super(message, 'CONFLICT', 'E_CONFLICT', true, { status: options?.status }, options?.cause)
    this.name = 'XeroConflictError'
  }
}
```

`StructuredError` from `@side-quest/core/errors` provides: `name`, `category` (NETWORK_ERROR, TIMEOUT, VALIDATION, etc.), `code` (machine-readable), `recoverable` boolean, `context` record, `cause` chain, and `toJSON()` serialization.

### Error-to-Exit-Code Mapping

Centralized mapping function. Uses `instanceof` for auth/conflict, then `error.status` for API errors:

```typescript
function exitCodeFromError(err: unknown): { exitCode: ExitCode; errorCode: string; errorName: string } {
  if (err instanceof XeroAuthError) return { exitCode: EXIT_UNAUTHORIZED, errorCode: 'E_UNAUTHORIZED', errorName: 'PermissionError' }
  if (err instanceof XeroConflictError) {
    // Distinguish lock contention from stale data from API conflict
    const status = (err as { status?: number }).status
    if (status === 412) return { exitCode: EXIT_CONFLICT, errorCode: 'E_STALE_DATA', errorName: 'ConflictError' }
    if (status === 409) return { exitCode: EXIT_CONFLICT, errorCode: 'E_API_CONFLICT', errorName: 'ConflictError' }
    return { exitCode: EXIT_CONFLICT, errorCode: 'E_LOCK_CONTENTION', errorName: 'ConflictError' }
  }
  if (err instanceof XeroApiError && err.status === 400) return { exitCode: EXIT_USAGE, errorCode: 'E_USAGE', errorName: 'UsageError' }
  // Subcategorize exit code 1 by actual failure mode (retryable field is accurate per subtype)
  if (err instanceof XeroApiError) {
    if (err.status === 403) return { exitCode: EXIT_RUNTIME, errorCode: 'E_FORBIDDEN', errorName: 'RuntimeError' }
    if (err.status === 429) return { exitCode: EXIT_RUNTIME, errorCode: 'E_RATE_LIMITED', errorName: 'RuntimeError' }
    if (err.status >= 500) return { exitCode: EXIT_RUNTIME, errorCode: 'E_SERVER_ERROR', errorName: 'RuntimeError' }
    if (err.status === 0) return { exitCode: EXIT_RUNTIME, errorCode: 'E_NETWORK', errorName: 'RuntimeError' }
    return { exitCode: EXIT_RUNTIME, errorCode: 'E_API_ERROR', errorName: 'RuntimeError' }
  }
  return { exitCode: EXIT_RUNTIME, errorCode: 'E_RUNTIME', errorName: 'RuntimeError' }
}

// Note: EXIT_CODE_ACTIONS was replaced by ERROR_CODE_ACTIONS (defined above in writeSuccess section).
// exitCodeFromError provides the errorCode, writeError looks it up in ERROR_CODE_ACTIONS.
```

### Top-Level Entry Point

The `main()` function in the Entry Point Wiring section (below, under LogTape) is the canonical entry point. It handles parse errors, logging lifecycle (setupLogging/shutdownLogging via try/finally), and the catch-all error handler. All error paths flow through `exitCodeFromError` -> `writeError`.

### Partial Failure Strategy

Best-effort with real-time reporting. Process as many transactions as possible, collect failures, report summary at the end. Never abort the whole batch because one item failed.

**Real-time per-item feedback (human mode):** Print each item's result as it completes, not just at the end. For 300-item runs that take 5+ minutes, Nathan needs to see failures building up so he can Ctrl+C early if needed:
```
[142/300] abc-123 -> 6420 Entertainment  OK
[143/300] def-456 -> 6310 Software       FAILED: Invoice already paid
[144/300] ghi-789 -> 6440 Motor Vehicle  OK
...
[300/300] Complete. 298 reconciled, 2 failed. See audit journal for details.
```

**Progress bar with rate-limit visibility:** When rate-limit pauses occur, show them in the progress: `"[142/300] Rate limited, resuming in 5s..."`

**Safe interruption (Ctrl+C / SIGINT):**
- On SIGINT during `--execute`, the CLI finishes the current in-flight API call (do NOT abort mid-request), then:
  1. Writes the audit journal with all items processed so far (marking remaining as `status: 'interrupted'`)
  2. Saves current state to the state file (all succeeded items are marked processed)
  3. Prints a clear summary: "Interrupted at item 142/300. 142 reconciled, 158 remaining."
  4. Exits with code 130 (EXIT_INTERRUPTED)
- **SIGINT granularity for batch payments:** For batched `PUT /Payments` (25 items per batch), SIGINT is checked between batches, not within a batch. A batch in-flight completes fully (all 25 items succeed or fail). The state machine represents partial acceptance within a batch: each item in the batch gets its own state entry based on the per-item response (some may succeed, some may have ValidationErrors). SIGINT flag is checked after the batch response is fully parsed and all item states are written.
- **Resume:** Re-running the same reconcile input with `--execute` skips already-processed items (via state file) and continues from where it left off. The user sees: "Skipping 142 already-processed items. Reconciling remaining 158..."
- **No checkpoint file needed** -- the existing state file IS the checkpoint. Each item is written to state immediately after successful API response.

**Preflight-to-execution staleness:**
- Preflight validates unreconciled IDs and AccountCodes, but the gap between preflight and execution means IDs could become reconciled by another user/process. **Execution-time conflict handling:** If a POST returns a validation error indicating the transaction is already reconciled, treat it as `skipped` (not `failed`). Log: "BankTransaction {id} was reconciled between preflight and execution -- skipping." This is a benign race, not an error.

---

## State Management

### Reconciliation State Machine

Formal lifecycle for each reconciliation entry. Transitions are explicit and terminal states are defined:

```
                 +-----------+
                 |  pending   |  (input parsed, not yet attempted)
                 +-----+-----+
                       |
                 +-----v-----+
                 | processing |  (API call in-flight)
                 +-----+-----+
                       |
         +--------+----+----+---------+
         |        |         |         |
    +----v---+ +--v----+ +-v-------+ +--v--------+
    |reconciled| |skipped| | failed  | |interrupted|
    +---------+ +-------+ +----+----+ +-----+-----+
                               |            |
                          (retryable?)  (on resume)
                               |            |
                          +----v----+  +----v----+
                          | pending |  | pending |
                          +---------+  +---------+
```

| From | To | Trigger |
|------|-----|---------|
| pending | processing | API call started |
| processing | reconciled | API success + type guard passes |
| processing | skipped | Already in local state (idempotent re-run) |
| processing | failed | API error or type guard failure |
| processing | interrupted | SIGINT received |
| failed | pending | Re-run with same input (if retryable) |
| interrupted | pending | Re-run with same input |

**Terminal states:** `reconciled`, `skipped`. **Retryable states:** `failed` (if error was transient), `interrupted`. **Non-retryable:** `failed` with validation error (deterministic -- same input will always fail).

**Important: The state file only persists terminal successes (reconciled).** Failed and interrupted items are identified by their *absence* from the state file. On resume, the CLI compares input BankTransactionIDs against state entries and reprocesses any missing ones. The NDJSON journal records all states (including failures and interruptions) for audit purposes, but the state file is the idempotency mechanism.

### Idempotency

Two-layer check (no explicit server-side pre-check -- Xero validation errors are the safety net):
1. Check local state file first (fast, avoids API call)
2. Attempt the API call (Xero catches duplicates via validation errors if local state was stale/missing)
3. After successful API response, write to state file immediately (atomic write via temp + fsync + rename)
4. On re-run, skip already-processed items and report them
5. If a duplicate is created despite local state miss, Xero returns a validation error -- handled in batch error parsing

```typescript
import { loadJsonStateSync, saveJsonStateSync } from '@side-quest/core/fs'

// State file uses Zod schema validation on load.
// If schema version mismatches, warn user with instructions to back up and reset.
// SECURITY: State file is a high-trust control surface. Local modification can force
// false "already processed" skips (deletion triggers full reprocessing).
// DROPPED: Content hash for tamper detection. For a personal tool, the threat model
// is "Nathan accidentally edited the JSON" or "git checkout restored old version."
// The schemaVersion validation catches structural corruption. The preflight write-scope
// guard catches stale state (re-validates all BankTransactionIDs against current Xero data).
// Between these two, tampering is already caught at the right layer.
// NOTE: lstatSync + separate open has a TOCTOU gap. Accept this risk for a personal
// tool but document it. Hard links are not addressed (only symlink rejection).

const SCHEMA_VERSION = 1

/** State entry -- discriminated union for account-code vs invoice reconciliation */
type ProcessedEntry =
  | { type: 'account-code'; updatedAt: string }
  | { type: 'payment'; paymentId: string }

/** State file schema -- validated with Zod on load */
interface ReconciliationState {
  schemaVersion: number
  processedTransactions: Record<string, ProcessedEntry>  // bankTransactionId -> entry
}

// Example .xero-reconcile-state.json:
// {
//   "schemaVersion": 1,
//   "processedTransactions": {
//     "abc-123": { "type": "account-code", "updatedAt": "2026-02-26T14:30:00Z" },
//     "def-789": { "type": "payment", "paymentId": "pay-012" }
//   }
// }
```

### Process Lock

```typescript
import { withFileLock } from '@side-quest/core/concurrency'

// Lock only applies to --execute mode (dry-run can run in parallel)
// Concurrent --execute runs fail-fast with clear error
// Lock implementation: PID-based file lock via @side-quest/core/concurrency.
// Stale lock detection: reads PID from lock file, checks if process exists (kill(pid, 0)).
// If process is dead, reclaims lock. Lock timeout: 30s (fail-fast for CLI).
// Crash semantics: if process dies holding lock, next invocation detects stale PID and reclaims.
async function executeReconciliation(entries: ReconciliationEntry[]): Promise<void> {
  await withFileLock('xero-cli-reconcile', async () => {
    // ... reconciliation logic
  })
}
```

### Preflight Checks

Before `--execute` mode, validate:
1. Tokens not expired (and refreshable)
2. API connectivity (`GET /Organisation`)
3. State path writable
4. **Period lock check** -- fetch organisation settings and warn if any target transactions fall within a locked period or filed BAS period. Do not hard-block (user may intentionally modify unlocked transactions in a locked quarter) but surface a clear warning.
5. **Write scope validation** -- fetch current unreconciled transaction IDs and chart of accounts. Validate all input BankTransactionIDs are unreconciled and all AccountCodes are valid/active. Reject invalid items before any API writes.
6. Fail fast with actionable error if any check fails

### Audit Report

Every `--execute` run writes a **single journaled event log** to `.xero-reconcile-runs/YYYY-MM-DDTHH-MM-SS-execute.ndjson` (newline-delimited JSON). Events are appended incrementally as they occur -- not buffered in memory and flushed at end. This ensures crash recovery has a complete record up to the last successful operation.

**Event types (NDJSON, one per line):**
```
{"event":"run.started","timestamp":"...","inputHash":"sha256:...","itemCount":300}
{"event":"item.pre-state","bankTransactionId":"abc-123","snapshot":{...}}
{"event":"item.request","bankTransactionId":"abc-123","method":"POST","path":"/BankTransactions/abc-123","body":{...}}
{"event":"item.response","bankTransactionId":"abc-123","status":200,"body":{...},"totalMatch":true}
{"event":"item.completed","bankTransactionId":"abc-123","result":"reconciled","durationMs":1200}
{"event":"item.failed","bankTransactionId":"def-456","error":"Validation: AccountCode not found","retryable":false}
{"event":"run.completed","summary":{"total":300,"succeeded":298,"failed":2,"skipped":0},"durationMs":330000}
```

**Atomic state+audit consistency:** State file and audit journal are co-located in the same run. The journal IS the source of truth for crash recovery. On resume, the state file is reconstructed from the journal (all `item.completed` events). This eliminates the two-file divergence risk where a crash between state write and audit write could produce inconsistent truth sources.

**Journal corruption recovery:** If the process crashes (SIGKILL, OOM, power loss) mid-write, the journal file may end with a truncated JSON line. The NDJSON reader for journal recovery MUST: (1) parse line-by-line, (2) wrap each `JSON.parse()` in try/catch, (3) skip unparseable lines with a warning logged to stderr, (4) continue processing remaining valid lines. Without this, a single truncated line makes the entire journal unparseable and the recovery mechanism fails.

**The journal includes:**
- **Full requested input** -- the complete stdin JSON as received (for exact replay), written as `run.started` event
- **Pre-state snapshot** -- for each item, the BankTransaction/Invoice state before mutation (fetched during write-scope validation)
- **Per-item request/response correlation** -- the exact API request body sent and the full API response received, keyed by BankTransactionID
- **Post-state confirmation** -- for account-code updates, the response Total vs pre-update Total (delta check)
- **All created payments** (IDs, amounts, invoices, currency)
- **All failures** (with error messages, HTTP status, Xero validation errors)
- **Summary counts** and timing (total duration, per-item avg)
- **Rollback reference** -- for payments, the PaymentID needed for `POST /Payments/{PaymentID}` with `{"Status":"DELETED"}`; for account-code updates, the original AccountCode + LineItems needed to revert

**Audit growth management:** Journal files are retained for 90 days. At the START of each `reconcile --execute` run (before the lock, before preflight), automatically prune journals older than 90 days. No separate `--prune-audits` subcommand -- Nathan will never remember to run it for a quarterly tool, and at ~2MB per run even 5 years of quarterly use produces only ~40MB. Each journal is bounded by the input size (max 1000 entries x ~2KB per item = ~2MB max per run).

---

## Arg Parser

Manual token-by-token loop over `argv.slice(2)`. No external parser. Supports both `--flag value` and `--flag=value` forms. Returns a discriminated union:

```typescript
const EXIT_OK = 0
const EXIT_RUNTIME = 1
const EXIT_USAGE = 2
const EXIT_NOT_FOUND = 3
const EXIT_UNAUTHORIZED = 4
const EXIT_CONFLICT = 5
const EXIT_INTERRUPTED = 130

type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130
type CommandName = 'auth' | 'transactions' | 'accounts' | 'invoices' | 'history' | 'reconcile' | 'status'

interface GlobalFlags {
  readonly json: boolean
  readonly quiet: boolean
  readonly verbose: boolean
  readonly debug: boolean
  readonly eventsUrl: string | null
}

/** Flags for commands that output lists (transactions, accounts, invoices, history).
 *  --fields only makes sense on commands that produce multiple records. */
interface ListFlags {
  readonly fields: readonly string[] | null
}

interface AuthCommand extends GlobalFlags {
  readonly command: 'auth'
}

interface TransactionsCommand extends GlobalFlags, ListFlags {
  readonly command: 'transactions'
  readonly unreconciled: boolean
  readonly since: string | null
  readonly until: string | null
  readonly page: number
  readonly limit: number | null
}

interface AccountsCommand extends GlobalFlags, ListFlags {
  readonly command: 'accounts'
  readonly type: string | null  // EXPENSE, REVENUE, ASSET, etc.
}

interface InvoicesCommand extends GlobalFlags, ListFlags {
  readonly command: 'invoices'
  readonly status: string       // default: AUTHORISED
  readonly type: string | null  // ACCPAY, ACCREC
}

interface HistoryCommand extends GlobalFlags, ListFlags {
  readonly command: 'history'
  readonly since: string           // REQUIRED -- no default. Prevents unbounded API fetching.
  readonly contact: string | null
  readonly accountCode: string | null
}

interface ReconcileCommand extends GlobalFlags {
  readonly command: 'reconcile'
  readonly execute: boolean     // default: false (dry-run)
  readonly fromCsv: string | null  // Path to CSV file (alternative to stdin JSON)
}

interface StatusCommand extends GlobalFlags {
  readonly command: 'status'
}

type CliOptions = AuthCommand | TransactionsCommand | AccountsCommand
  | InvoicesCommand | HistoryCommand | ReconcileCommand | StatusCommand

interface ParseCliOk { readonly ok: true; readonly options: CliOptions }
interface ParseCliError {
  readonly ok: false
  readonly exitCode: ExitCode
  readonly message: string
  readonly output: string
  readonly errorCode: string
  readonly json: boolean
  readonly quiet: boolean
}
type ParseCliResult = ParseCliOk | ParseCliError
```

### Auto Non-TTY Detection

**`--json` precedence:** Explicit `--json` flag always wins. Auto non-TTY detection is a convenience fallback. When stdout is not a TTY (piped), auto-enable JSON + quiet. When `--json` is explicitly passed, it's a no-op on non-TTY (already active) and explicitly enables JSON on TTY. Never mix human text fragments with JSON output when JSON mode is active (whether explicit or auto).

```typescript
function shouldUseAutomaticMachineMode(): boolean {
  return !isatty(1) // fd 1 = stdout
}

function applyAutomaticOutputMode(options: CliOptions, autoMachine: boolean): CliOptions {
  if (!autoMachine) return options
  // Non-TTY: force JSON + quiet
  return { ...options, quiet: true, json: true }
}

// Parser enforcement: --fields only valid on list commands
const LIST_COMMANDS = ['transactions', 'accounts', 'invoices', 'history']
if (fields && !LIST_COMMANDS.includes(normalizedCommand)) {
  return parseUsageError(
    `--fields is only valid for list commands (${LIST_COMMANDS.join(', ')})`,
    usageText(), json, quiet,
  )
}
```

### Field Projection

Applied before output formatting. Works with all output modes (JSON, human table).

```typescript
/** Parse --fields flag into validated field name array.
 *  Allowed chars: alphanumeric, dots, hyphens, underscores.
 *  Prevents injection through crafted field names.
 *  Fields are CASE-SENSITIVE (Xero uses PascalCase: Contact.Name, not contact.name).
 *  Invalid chars -> usage error (not silent ignore). */
function parseFields(raw: string | null): readonly string[] | null {
  if (raw === null) return null
  const parsed = raw.split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0)
  if (parsed.length === 0) return null
  const invalid = parsed.filter((field) => !/^[A-Za-z0-9_.-]+$/.test(field))
  if (invalid.length > 0) {
    // Include valid fields hint in error for LLM-generated commands with wrong casing
    throw new UsageError(
      `Invalid field names: ${invalid.join(', ')}. Allowed chars: A-Z, a-z, 0-9, dots, hyphens, underscores.`,
      { invalidFields: invalid, validFieldsHint: 'Use --help <command> to see available fields. Fields are PascalCase (e.g., Contact.Name, BankTransactionID).' }
    )
  }
  return parsed
}

/** Project an object down to only the requested fields. */
function projectFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const field of fields) {
    projected[field] = readPath(value, field)
  }
  return projected
}

/** Dot-path traversal for nested field access (e.g., Contact.Name). */
function readPath(value: unknown, field: string): unknown {
  const segments = field.split('.').filter((s) => s.length > 0)
  let cursor: unknown = value
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
```

Applied in list commands before output:

```typescript
const items = options.fields && options.fields.length > 0
  ? payload.map((item) => projectFields(item, options.fields!))
  : payload
```

### Help System

Three access patterns, all equivalent:

```bash
xero-cli help transactions       # help as a command
xero-cli transactions --help     # help flag on any command
xero-cli --help transactions     # help flag with topic argument
```

Topic aliases normalize common synonyms:

```typescript
const HELP_TOPIC_ALIASES: Record<string, string> = {
  tx: 'transactions', txn: 'transactions', txns: 'transactions',
  inv: 'invoices', acct: 'accounts', acc: 'accounts',
  rec: 'reconcile', output: 'contract', format: 'contract',
}

function normalizeHelpTopic(raw: string): HelpTopic | null {
  const value = raw.trim().toLowerCase()
  const aliased = HELP_TOPIC_ALIASES[value] ?? value
  // Return null for unknown topics -> parseUsageError
  return VALID_TOPICS.includes(aliased) ? aliased as HelpTopic : null
}
```

Help returned as ParseCliError with EXIT_OK and E_HELP:

```typescript
function parseHelp(json: boolean, quiet: boolean, topic: HelpTopic = 'overview'): ParseCliError {
  return {
    ok: false,
    exitCode: EXIT_OK,
    message: 'Help requested',
    output: helpText(topic),
    errorCode: 'E_HELP',
    json, quiet,
  }
}
```

Running with no args returns the complete overview: command summary, global options, per-command options, output contract shape, exit codes, examples, and available help topics.

Command aliases normalize common shorthand:

```typescript
const COMMAND_ALIASES: Record<string, string> = {
  tx: 'transactions', txn: 'transactions',
  inv: 'invoices', acct: 'accounts', acc: 'accounts',
  rec: 'reconcile',
}
const normalizedCommand = COMMAND_ALIASES[commandToken] ?? commandToken
```

Unknown flags produce a usage error (never silently ignored):

```typescript
if (token.startsWith('-')) {
  return parseUsageError(`Unknown option: ${token}`, usageText(), json, quiet)
}
```

### Typed Success Data Interfaces

Every command defines a typed interface for its writeSuccess payload:

```typescript
interface TransactionsSuccessData {
  command: 'transactions'
  count: number
  transactions: XeroBankTransaction[]
}

interface AccountsSuccessData {
  command: 'accounts'
  count: number
  accounts: XeroAccount[]
}

interface InvoicesSuccessData {
  command: 'invoices'
  count: number
  invoices: XeroInvoice[]
}

interface HistorySuccessData {
  command: 'history'
  count: number
  transactions: Array<{
    Contact: string
    AccountCode: string
    AmountMin: number
    AmountMax: number
    Count: number
    Type: 'SPEND' | 'RECEIVE'  // Sign context for categorization decisions
    CurrencyCode: string       // ISO 4217 -- important for multi-currency orgs
    MostRecentDate: string     // ISO date of most recent match -- recency signal
    ExampleTransactionIDs: string[]  // Up to 3 example IDs for agent to inspect if needed
  }>
}

/** Reconcile result status enum -- agents can branch deterministically on these values.
 *  'reconciled' = success, 'skipped' = already processed (idempotent), 'failed' = error (see error field),
 *  'dry-run' = would succeed (preview mode). */
type ReconcileResultStatus = 'reconciled' | 'skipped' | 'failed' | 'dry-run'

interface ReconcileSuccessData {
  command: 'reconcile'
  mode: 'dry-run' | 'execute'
  summary: { total: number; succeeded: number; failed: number; skipped: number }
  results: Array<{
    BankTransactionID: string
    status: ReconcileResultStatus
    AccountCode?: string
    InvoiceID?: string
    PaymentID?: string
    error?: string  // Present when status === 'failed'
  }>
}

/** Per-location health check result */
interface StatusCheck {
  name: 'env' | 'config' | 'keychain' | 'state_file' | 'lock_file' | 'audit_dir'
  status: 'ok' | 'warning' | 'error'
  detail: string
}

/** Canonical diagnosis values -- typed union, not free-form string.
 *  Each diagnosis has a corresponding nextAction for deterministic agent branching. */
type StatusDiagnosis =
  | 'healthy'
  | 'missing_client_id'
  | 'missing_config'
  | 'corrupted_config'
  | 'keychain_not_found'
  | 'keychain_access_denied'
  | 'keychain_locked'
  | 'token_expired'
  | 'token_refresh_failed'
  | 'api_unreachable'
  | 'tenant_revoked'
  | 'state_file_not_writable'
  | 'state_hash_mismatch'
  | 'stale_lock'
  | 'rate_limited'

const DIAGNOSIS_ACTIONS: Record<StatusDiagnosis, string | null> = {
  healthy: null,
  missing_client_id: 'Copy .env.example to .env and add your Client ID',
  missing_config: 'Run: bun run xero-cli auth',
  corrupted_config: 'Delete .xero-config.json and run: bun run xero-cli auth',
  keychain_not_found: 'Run: bun run xero-cli auth',
  keychain_access_denied: 'Grant Terminal Keychain access: System Settings > Privacy & Security',
  keychain_locked: 'Unlock your Keychain and retry',
  token_expired: 'Run: bun run xero-cli auth',
  token_refresh_failed: 'Run: bun run xero-cli auth (previous session expired)',
  api_unreachable: 'Check network connection. Xero status: status.xero.com',
  tenant_revoked: 'Re-authorize: bun run xero-cli auth (org access may have been revoked)',
  state_file_not_writable: 'Check file permissions on .xero-reconcile-state.json',
  state_hash_mismatch: 'State file was modified externally. Use --force to proceed or delete and re-run',
  stale_lock: 'Stale lock from crashed process. Will auto-reclaim on next run',
  rate_limited: 'Wait before retrying. Check remaining daily quota',
}

/** Status check criteria per location:
 *  | Check       | OK                              | Warning                           | Error                    |
 *  |-------------|---------------------------------|-----------------------------------|--------------------------|
 *  | env         | XERO_CLIENT_ID set              | --                                | Not set                  |
 *  | config      | File exists, Zod passes         | --                                | Missing or corrupted     |
 *  | keychain    | Tokens exist, not expired       | Tokens expiring within 5 min      | Missing or access denied |
 *  | state_file  | Exists, writable (or absent)    | --                                | Not writable             |
 *  | lock_file   | No stale lock                   | Stale lock (auto-reclaimable)     | Active lock by other PID |
 *  | audit_dir   | Exists, writable                | Missing (will create on first run)| Not writable             |
 */

interface StatusSuccessData {
  command: 'status'
  authenticated: boolean
  organisation: string
  tenantId: string
  apiConnected: boolean
  tokenExpiresIn: number | null  // Seconds until token expires (null if not authenticated)
  diagnosis: StatusDiagnosis     // Canonical diagnosis value (typed, not free-form)
  nextAction: string | null      // Actionable fix from DIAGNOSIS_ACTIONS lookup (null when healthy)
  checks: StatusCheck[]          // Per-location health checks for all 6 state locations
}

interface AuthSuccessData {
  command: 'auth'
  organisation: string
  tenantId: string
  country: string
}
```

---

## Observability

Two complementary systems:

1. **LogTape** -- structured logging to stderr for diagnostics
2. **`~/code/side-quest-observability/packages/server/`** -- fire-and-forget event posting for dashboards and monitoring

### LogTape: Structured Logging

#### The Three Output Tiers

```
Tier 1: Program output (stdout)
  - JSON envelopes, tables -- NEVER touched by logging

Tier 2: Diagnostic output (stderr)         <-- LogTape lives here
  - Progress, debug messages, warnings
  - Controlled by --verbose / --debug / --quiet

Tier 3: Side-channel output (event bus)    <-- observability-server lives here
  - Fire-and-forget events to ~/.cache/side-quest-observability/
  - For dashboards, history, voice notifications
```

#### Category Hierarchy

```
xero                          # Root -- single knob for all logging on/off
+-- xero.cli                  # Arg parsing, command dispatch, output formatting
+-- xero.auth                 # OAuth2 PKCE, token refresh, Keychain read/write
+-- xero.http                 # HTTP transport: retries, rate limits, response status codes (logged from api.ts)
+-- xero.api                  # API orchestration (domain-level logic)
|   +-- xero.api.transactions # GET /BankTransactions
|   +-- xero.api.accounts     # GET /Accounts
|   +-- xero.api.invoices     # GET /Invoices
|   +-- xero.api.payments     # PUT /Payments
|   +-- xero.api.organisation # GET /Organisation (preflight)
+-- xero.reconcile            # Reconciliation orchestration (stdin, batch, state)
+-- xero.state                # State file reads/writes, file locks, idempotency
+-- xero.rate-limit           # Token bucket decisions (wait, proceed, throttled)
```

#### Flag-to-Level Mapping

| User Intent | Flag | Level | What They See |
|------------|------|-------|---------------|
| Normal use | (none) | `warning` | Only problems |
| Curious | `--verbose` | `info` | Lifecycle events (API calls, pagination, token refresh) |
| Debugging | `--debug` | `debug` | Full diagnostic detail (request/response, rate limit state) |
| Silent | `--quiet` | `error` | Only errors |
| AI agent | `--json --quiet` | `error` + JSON | Machine-readable errors only |
| AI agent debugging | `--json --debug` | `debug` + JSON Lines | Full structured diagnostics |

#### Flag Precedence Rules

Centralized in `resolveOutputMode()` -- single source of truth for flag conflicts:

```typescript
interface OutputMode {
  level: "debug" | "info" | "warning" | "error"
  formatter: "ansi" | "json-lines"
  progressMode: "animated" | "static" | "off"
}

/** Resolve conflicting flags into a single output mode.
 *  Precedence: --debug > --quiet > --verbose > default
 *  --json affects formatter selection only, not log level. */
function resolveOutputMode(opts: LoggingOptions): OutputMode {
  // --debug wins over everything (debug intent overrides all)
  if (opts.debug) {
    return { level: "debug", formatter: selectFormatter(opts.json), progressMode: "off" }
  }
  // --quiet wins over --verbose (silence intent overrides chattiness)
  if (opts.quiet) {
    return { level: "error", formatter: selectFormatter(opts.json), progressMode: "off" }
  }
  // --verbose: lifecycle events, static progress
  if (opts.verbose) {
    return { level: "info", formatter: selectFormatter(opts.json), progressMode: "static" }
  }
  // Default: only warnings, animated spinners
  return { level: "warning", formatter: selectFormatter(opts.json), progressMode: "animated" }
}

function selectFormatter(json: boolean): "ansi" | "json-lines" {
  const formatOverride = process.env.XERO_LOG_FORMAT  // "text" | "json" | undefined
  if (formatOverride === "text") return "ansi"
  if (formatOverride === "json") return "json-lines"
  return (process.stderr.isTTY && !json) ? "ansi" : "json-lines"
}
```

**`XERO_LOG_FORMAT` env var**: Forces formatter selection regardless of TTY detection. Set `XERO_LOG_FORMAT=text` in test harness for deterministic output assertions in non-TTY (Bun.spawnSync) environments.

#### Setup Pattern

```typescript
// src/logging.ts
import {
  ansiColorFormatter,
  configure,
  dispose,
  getConsoleSink,
  jsonLinesFormatter,
} from "@logtape/logtape"

export interface LoggingOptions {
  debug: boolean
  verbose: boolean
  quiet: boolean
  json: boolean
}

let configured = false

/** Configure LogTape for CLI execution (synchronous -- no async sinks in Phase 1).
 *  AsyncLocalStorage deferred to Phase 2 when withContext() is wired up. */
export function setupLogging(opts: LoggingOptions): void {
  const mode = resolveOutputMode(opts)
  const formatter = mode.formatter === "ansi" ? ansiColorFormatter : jsonLinesFormatter

  configure({
    sinks: {
      // Use getConsoleSink on Bun (not stream sink -- avoids manual WritableStream wrapping)
      stderr: getConsoleSink({ formatter }),
    },
    loggers: [
      { category: ["xero"], sinks: ["stderr"], lowestLevel: mode.level },
    ],
  })
  configured = true
}

/** Idempotent shutdown with 500ms timeout guard.
 *  Safe to call before setupLogging(), after failed setupLogging(), or multiple times.
 *  Accepts injectable disposeFn for testing (verify timeout, slow disposal). */
export async function shutdownLogging(
  disposeFn: () => Promise<void> = dispose,
): Promise<void> {
  if (!configured) return
  configured = false
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 500))
  await Promise.race([disposeFn(), timeout])
}
```

**Bun gotcha:** `process.stderr` is NOT a `WritableStream` in Bun. `getConsoleSink()` works fine, but `getStreamSink()` needs a manual `WritableStream` wrapper.

#### Error Emission Ownership Rule

`writeError()` is the sole owner of user-facing terminal errors. `logger.error()` is for diagnostic traces only. Never duplicate the same message across both channels:

- **`writeError()`** -- user-facing error messages (validation failures, fatal errors). Writes to stderr.
- **`logger.error()`** -- diagnostic context for the same failure (retry count, response codes, timing). Never repeats the writeError message.
- The `runCli()` catch-all is the single point where errors cross from thrown exceptions to formatted stderr output.

**Global singleton:** `configure()` is called ONLY in the entry point (`cli.ts`). Library code only calls `getLogger()` -- never `configure()`. Configuring the same category twice throws `ConfigError`.

#### Entry Point Wiring

Structured as try/finally so shutdownLogging() is guaranteed on all exit paths:

```typescript
import { setupLogging, shutdownLogging } from "./logging"
import { getLogger } from "@logtape/logtape"

const logger = getLogger(["xero", "cli"])

async function main(): Promise<number> {
  const result = parseCli(process.argv.slice(2))
  if (!result.ok) {
    // Parse errors are pre-LogTape -- use existing error handling
    const ctx = { json: result.json, quiet: result.quiet }
    if (result.errorCode === 'E_HELP') {
      process.stdout.write(`${result.output}\n`)
    } else {
      writeError(ctx, result.message, result.errorCode, result.exitCode, 'UsageError')
    }
    return result.exitCode
  }

  setupLogging({
    debug: result.options.debug,
    verbose: result.options.verbose,
    quiet: result.options.quiet,
    json: result.options.json,
  })

  try {
    logger.info("CLI started: {command}", { command: result.options.command })
    return await dispatch(result.options)
  } catch (err) {
    if (isInterruptedError(err)) return EXIT_INTERRUPTED
    const { exitCode, errorCode, errorName } = exitCodeFromError(err)
    const message = err instanceof Error ? err.message : String(err)
    writeError({ json: result.options.json, quiet: result.options.quiet }, message, errorCode, exitCode, errorName)
    return exitCode
  } finally {
    await shutdownLogging()
  }
}

// SIGINT handler -- finally doesn't run on signal-induced exits
process.on('SIGINT', async () => {
  await shutdownLogging()
  process.exit(EXIT_INTERRUPTED)
})

main().then((code) => process.exit(code))
```

#### Async Context Propagation (Phase 2)

Deferred to Phase 2 -- requires `AsyncLocalStorage` in `setupLogging()`. Add when pagination and concurrent operations are implemented.

**Run-level context** wraps the entire command execution:

```typescript
import { getLogger, withContext } from "@logtape/logtape"

// In main(), after setupLogging():
await withContext({ runId: crypto.randomUUID().slice(0, 8), command: args.options.command }, async () => {
  return await dispatch(args.options)
})
```

**Page-level context** for pagination loops:

```typescript
const logger = getLogger(["xero", "api", "transactions"])

async function fetchAllPages(token: string): Promise<Transaction[]> {
  const results: Transaction[] = []
  let page = 1

  while (true) {
    const data = await withContext({ page, command: "transactions" }, async () => {
      logger.info("Fetching page {page}...", { page })
      const res = await xeroFetch(`/BankTransactions?page=${page}`, token)
      logger.debug("Page {page}: {count} items", { page, count: res.BankTransactions.length })
      return res
    })

    results.push(...data.BankTransactions)
    if (!data.BankTransactions.length) break
    page++
  }

  logger.info("Fetched {total} transactions across {pages} pages", {
    total: results.length,
    pages: page - 1,
  })
  return results
}
```

#### Fingers Crossed Sink (Phase 2+)

Deferred -- evaluate after Phase 1 ships and real usage surfaces gaps. The flag interaction with `--verbose`/`--debug`/`--quiet` is complex and not needed while the CLI is still being built.

**Design for when ready** (do not implement in Phase 1):

```typescript
// Only active in default mode (no flags). Inactive for --verbose, --debug, --quiet.
const useFingersCrossed = !opts.debug && !opts.verbose && !opts.quiet
const sink = useFingersCrossed
  ? fingersCrossed(consoleSink, {
      triggerLevel: "error",
      maxBufferSize: 500,  // ~100 pages x 5 log records/page = upper bound for pagination
    })
  : consoleSink
```

#### What NOT to Log

| Don't Log | Why | Instead |
|-----------|-----|---------|
| Raw API response bodies | Huge, may contain PII | Log item counts and status codes |
| API keys or tokens | Security risk | Log `"token=present"` / `"token=missing"` |
| Every pagination offset | High frequency, low signal | Log page start/complete and totals |
| Progress display updates | UI, not diagnostics | Keep progress rendering on stderr as-is |

#### Testing Pattern

LogTape is a global singleton. Reset between tests, use buffer sink:

```typescript
import { configure, reset } from "@logtape/logtape"
import { AsyncLocalStorage } from "node:async_hooks"
import type { LogRecord } from "@logtape/logtape"

const buffer: LogRecord[] = []

beforeEach(async () => {
  buffer.length = 0
  await configure({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: { buffer: buffer.push.bind(buffer) },
    loggers: [
      { category: ["xero"], sinks: ["buffer"], lowestLevel: "debug" },
    ],
  })
})

afterEach(async () => {
  await reset()
})
```

Assert on level, category, and context properties -- not exact message text (brittle).

**Don't mix sync/async:** `await configure()` then `resetSync()` is undefined behavior. Stick to one track.

#### Log Invariant Tests

Dedicated `tests/cli/output-invariants.test.ts` proving stdout/stderr separation:

```typescript
// These use Bun.spawnSync with XERO_LOG_FORMAT=text for determinism
test("stdout contains only program output (no log messages)", () => { /* --json mode */ })
test("stderr contains no JSON envelope fragments", () => { /* all modes */ })
test("--quiet stderr is empty on success", () => { /* no warnings, no progress, no logs */ })
```

**shutdownLogging() tests:**
- Call `shutdownLogging()` before `setupLogging()` -- should no-op
- Call `setupLogging()` with invalid config, then `shutdownLogging()` -- should no-op
- Call `shutdownLogging()` twice -- second call is no-op
- Inject slow `disposeFn` (>500ms) -- verify returns within 600ms (timeout fires)
- All via the `disposeFn` DI parameter, no monkeypatching

#### ProgressDisplay Interaction

| Flag | ProgressDisplay Mode | LogTape Level | Behavior |
|------|---------------------|---------------|----------|
| (none) | animated | warning | Spinners active, warnings only |
| --verbose | static | info | Phase names without animation, lifecycle events |
| --debug | off | debug | LogTape debug output IS the progress indicator |
| --quiet | off | error | Both suppressed, only errors |

Spinners and LogTape both write to stderr. Without mode gating, animated spinners interleave with log lines producing garbled output. The `resolveOutputMode().progressMode` field determines which mode the progress display uses.

### Event Bus: Observability Server

Fire-and-forget events to an observability server. No npm package -- just raw `fetch()`:

#### Configuration

| Source | Setting | Example |
|--------|---------|---------|
| Auto-discovery | `~/.cache/side-quest-observability/events.port` | Default -- reads port file (typically `7483`) |
| Env var | `XERO_EVENTS_URL` | `http://127.0.0.1:7483` (override for custom port) |
| Env var | `XERO_EVENTS=0` | Kill switch -- disables all emission |
| Flag | `--events-url` | `http://127.0.0.1:7483` (override, e.g. remote server) |

**Resolution order**: `--events-url` flag > `XERO_EVENTS_URL` env var > port file auto-discovery > disabled.

```typescript
// src/events.ts

interface EventsConfig {
  readonly url: string | null
}

export function resolveEventsConfig(flags: { eventsUrl?: string }): EventsConfig {
  if (process.env.XERO_EVENTS === "0") return { url: null }
  if (flags.eventsUrl) return { url: flags.eventsUrl }
  if (process.env.XERO_EVENTS_URL) return { url: process.env.XERO_EVENTS_URL }

  const portFile = join(homedir(), ".cache", "side-quest-observability", "events.port")
  try {
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10)
      if (!Number.isNaN(port) && port > 0) {
        return { url: `http://127.0.0.1:${port}` }
      }
    }
  } catch { /* silent */ }

  return { url: null }
}
```

#### Emitting Events

```typescript
const TIMEOUT_MS = 500

export async function emitEvent(
  config: EventsConfig,
  eventName: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!config.url) return

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    await fetch(`${config.url}/events/${eventName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: controller.signal,
    })
  } catch {
    // Fire-and-forget -- silent on failure
  } finally {
    clearTimeout(timeout)
  }
}
```

#### Event Names

```
xero-auth-completed        # OAuth flow finished
xero-auth-refreshed        # Token refreshed
xero-auth-failed           # Auth failure
xero-transactions-fetched  # Pulled unreconciled transactions
xero-accounts-fetched      # Pulled chart of accounts
xero-reconcile-started     # Batch reconciliation started
xero-reconcile-completed   # Batch finished (with summary)
xero-reconcile-failed      # Batch failed
xero-rate-limited          # Hit Xero rate limit
```

#### Usage in Commands

```typescript
// In auth.ts -- after successful OAuth flow
const eventsConfig = resolveEventsConfig({ eventsUrl: flags.eventsUrl })
await emitEvent(eventsConfig, "xero-auth-completed", {
  tenantId: config.tenantId,
  tenantName: config.tenantName,
})

// In transactions.ts -- after pulling unreconciled transactions
await emitEvent(eventsConfig, "xero-transactions-fetched", {
  count: 387,
  unreconciled: true,
  pages: 4,
})

// In reconcile.ts -- after batch reconciliation
await emitEvent(eventsConfig, "xero-reconcile-completed", {
  total: 330,
  succeeded: 328,
  failed: 2,
  durationMs: 12400,
  mode: "execute",
})
```

---

## `@side-quest/core` Integration Map

| Function | Import Path | Replaces |
|---|---|---|
| `loadJsonStateSync(path, schema, default)` | `@side-quest/core/fs` | Custom atomic JSON read/write + schema validation |
| `saveJsonStateSync(path, state)` | `@side-quest/core/fs` | Custom atomic file write |
| `isTokenExpired(token, bufferMs?)` | `@side-quest/core/oauth` | Custom expiry check (default 5min buffer) |
| `generateSecureToken(length?, encoding?)` | `@side-quest/core/password` | Custom `crypto.getRandomValues` for OAuth2 `state` param |
| `retry(fn, options?)` | `@side-quest/core/utils` | Inline retry-on-429 logic (exp backoff + jitter) |
| `chunk(arr, size)` | `@side-quest/core/utils` | Custom batch splitting in payment creation |
| `groupBy(arr, keyFn)` | `@side-quest/core/utils` | Manual contact grouping in history command |
| `getErrorMessage(error)` | `@side-quest/core/utils` | Safe error-to-string in catch blocks |
| `StructuredError` | `@side-quest/core/errors` | Custom error base class. Constructor: `(message, category, code, recoverable, context?, cause?)`. Provides name, category, code, recoverable, context, cause, toJSON() |
| `formatCurrency(amount)` | `@side-quest/core/formatters` | Custom AUD formatting (returns "$X.XX") |
| `withTimeout(promise, ms, message?)` | `@side-quest/core/concurrency` | Custom 120s server timeout logic |
| `withFileLock(resourceId, fn, options?)` | `@side-quest/core/concurrency` | Custom process lock for --execute mode (PID-based, stale detection) |
| `commandExists(cmd)` | `@side-quest/core/spawn` | Custom agent-browser availability check (uses Bun.which, no subprocess) |

**Not using from @side-quest/core** (custom implementation needed):
- `OAuthCredentials` type -- missing `client_secret` field (PKCE has no secret)
- `RateLimiter` -- uses min-delay pattern, we need sliding-window for Xero's 60/min. But for single-user ~100-200 calls/session, inline retry on 429 is sufficient.
- `saveTokenFile()`/`loadTokenFile()` -- we use macOS Keychain, not file-based tokens

---

## Implementation Phases

### Phase Exit Criteria

Each phase has explicit exit criteria that must be met before starting the next phase. The skill (Phase 4) is developed contract-first: JSON schemas and CLI examples are drafted during Phase 2, then finalized in Phase 4.

| Phase | Exit Criteria |
|-------|--------------|
| Phase 1 | `bun run xero-cli auth` completes OAuth, `status --json` returns valid JSON, `help` prints all commands, all Phase 1 tests pass, JSON output contract schema is documented in `help contract` |
| Phase 2 | All read commands return typed JSON, `--fields` projection works, `--summary` works, demo org data validated against TypeScript interfaces, JSON schema examples committed for skill draft |
| Phase 3 | Account-code reconciliation validated in demo org, dry-run + execute modes work, state file idempotency proven, audit journal written, Payment creation works for invoice matching, all Phase 3 tests pass |
| Phase 4 | SKILL.md authored with full runbook, Claude can orchestrate complete workflow in a test session, CSV round-trip verified |

### `@side-quest/core` Stability Contract

Pin to exact version in package.json (no `^` or `~`). If `@side-quest/core` breaks:
1. **Immediate response:** Pin to last-known-good version
2. **Short-term:** Fork the specific function into `src/utils/` as a local copy
3. **Long-term:** Evaluate whether the function should stay in `@side-quest/core` or be inlined

**Compatibility approach:** No dedicated compatibility test file -- Nathan controls `@side-quest/core` and is the only consumer. If an import breaks, `bun test` will catch it immediately through the actual usage in xero-cli tests. A dedicated smoke test file adds no signal that real tests don't already provide.

### Phase 1: CLI Skeleton + Auth

**Goal:** Working CLI with `auth`, `status`, and `help` commands. Agent-native output contract.

**Files to create:**
- `src/cli/command.ts` -- arg parser, command dispatch, `writeSuccess`/`writeError`, `sanitizeErrorMessage`, output context
- `src/cli/commands/auth.ts` -- OAuth2 PKCE flow
- `src/cli/commands/status.ts` -- preflight check (validates tokens, tests API connectivity via GET /Organisation, checks state path writable)
- `src/logging.ts` -- LogTape setup (flag-to-level, sink selection, `AsyncLocalStorage` context)
- `src/events.ts` -- Event bus emitter (wraps `emitEvent` with xero-cli context)
- `src/xero/config.ts` -- config loading + Zod validation for env vars and `.xero-config.json`
- `src/xero/api.ts` -- `xeroFetch()` with retry/rate-limit (logs via `xero.api.*` categories)
- `src/xero/auth.ts` -- token management with Zod-validated Keychain load, revocation on re-auth (uses raw `fetch()` for token refresh)
- `src/xero/types.ts` -- all TypeScript interfaces from the Xero API spec above
- `src/xero/errors.ts` -- 3 error classes: `XeroAuthError`, `XeroApiError` (with status), `XeroConflictError`
- `scripts/xero-auth-server.ts` -- OAuth2 callback server (Bun.serve on 127.0.0.1:5555/callback, one-shot, 120s timeout, `crypto.timingSafeEqual` for state, static HTML response with security headers)
- `.env.example` -- `XERO_CLIENT_ID=` (no secret needed with PKCE)

**First-run setup guide (printed by `bun run xero-cli auth` when no .env exists):**
```
xero-cli setup checklist:

1. Create a Xero app at https://developer.xero.com/app/manage
   - App type: "Auth Code with PKCE"
   - Redirect URI: http://127.0.0.1:5555/callback
   - Company or application URL: http://localhost

2. Copy .env.example to .env:
   cp .env.example .env

3. Add your Client ID from the Xero app dashboard:
   XERO_CLIENT_ID=YOUR_CLIENT_ID_HERE

4. Run auth:
   bun run xero-cli auth

Common issues:
- "redirect_uri mismatch" -- Xero requires EXACT match. Use http://127.0.0.1 (not localhost)
- "Keychain access denied" -- System Settings > Privacy & Security > allow Terminal
- Multiple orgs -- after auth, check .xero-config.json for the selected org
```

**Verification:** `bun run xero-cli` prints full help. `bun run xero-cli --version` prints version. `bun run xero-cli auth` completes OAuth flow. `bun run xero-cli status --json` returns structured JSON. `bun run xero-cli status --json --debug` shows JSON Lines on stderr alongside JSON data on stdout.

### Test Infrastructure (established in Phase 1, used across all phases)

**Xero mock server architecture:** Subprocess tests (`Bun.spawnSync`) cannot see in-process stubs. The test infrastructure provides:

1. **`XERO_API_BASE_URL` env var:** All `xeroFetch()` calls use `process.env.XERO_API_BASE_URL ?? 'https://api.xero.com/api.xro/2.0'` as the base URL. In tests, set to `http://127.0.0.1:{mockPort}`.

2. **Local mock server** (`tests/helpers/xero-mock-server.ts`): A minimal Bun.serve instance that returns canned responses keyed by route + request sequence. Launched per test suite, port assigned dynamically.

```typescript
// tests/helpers/xero-mock-server.ts
type MockResponseValue = { status: number; body: unknown }

interface MockRoute {
  method: string
  path: string | RegExp
  // Single response, ordered sequence (returns responses[0], then responses[1], etc.),
  // or function receiving request + call counter for stateful logic.
  response: MockResponseValue
    | MockResponseValue[]
    | ((req: Request, callIndex: number) => MockResponseValue)
}

function createXeroMockServer(routes: MockRoute[]): { url: string; stop: () => void }
```

**Request-sequence awareness:** The mock server tracks call count per matched route. When `response` is an array, it returns `responses[min(callIndex, responses.length - 1)]` (last response repeats for overflow). When `response` is a function, the `callIndex` parameter enables stateful test scenarios like: preflight GET returns 5 unreconciled items, then post-reconcile GET returns 4. This is necessary for integration tests of the reconcile flow (preflight -> execute -> verify) without requiring separate mock server configurations per phase.

3. **Scenario-based fixtures** (`tests/fixtures/`): Versioned JSON fixtures captured and sanitized from the Xero demo org. Each scenario is a directory with route-keyed response files:
```
tests/fixtures/
  reconcile-300-mixed/
    GET-BankTransactions-page-1.json
    GET-BankTransactions-page-2.json
    GET-Accounts.json
    POST-BankTransactions-abc123.json
    PUT-Payments-batch-1.json
  reconcile-with-failures/
    ...
```

4. **Auth seam for CI:** PKCE/browser/callback/Keychain abstracted behind interfaces:
```typescript
interface AuthProvider {
  saveTokens(tokens: KeychainTokenBundle): Promise<void>
  loadTokens(): Promise<KeychainTokenBundle | null>
  deleteTokens(): Promise<void>
}
// Production: KeychainAuthProvider (uses `security` CLI)
// Tests: InMemoryAuthProvider (no Keychain dependency)
```
Set via `AUTH_PROVIDER=memory` env var in CI.

5. **LogTape test isolation:** Use `configure()` with `reset: true` in `beforeEach` for each test suite that touches logging. This resets the global singleton per-test and avoids needing `--concurrency 1`. If `configure({ reset: true })` proves insufficient (e.g., sinks leak between tests), fall back to `--concurrency 1` only for the specific affected suites (expected: at most `reconcile.test.ts` and `api.test.ts`). Prefer the reset approach to preserve test parallelism.

**Test layers:**

| Layer | What | How | Gate |
|-------|------|-----|------|
| Unit | Arg parsing, field projection, Zod schemas, error mapping | In-process, no mocks | CI |
| Slice | Single command with mock server | `Bun.spawnSync` + mock server + `XERO_API_BASE_URL` | CI |
| Integration | Full flow (stdin -> validate -> API -> state -> audit) | Mock server with scenario fixtures | CI |
| Contract | Demo org shape validation | Real API calls, read-only | Manual/periodic |
| Filesystem | Atomic writes, symlink rejection, permissions | Real FS with temp dirs + POSIX mode manipulation | CI |

**Acceptance-criteria-to-test traceability:** Maintain `docs/test-matrix.md` mapping each acceptance criterion to its test file(s) and test name(s). Updated when acceptance criteria or tests change. Format:
```markdown
| Criterion | Test File | Test Name | Status |
|-----------|-----------|-----------|--------|
| Exit codes 0-5, 130 | tests/cli/command.test.ts | "maps errors to correct exit codes" | Passing |
```

### Phase 2: Read Commands

**Goal:** `transactions`, `accounts`, `invoices`, `history` commands working with all output modes.

**Contract-first skill work:** During Phase 2, draft the JSON schemas and CLI command examples that the skill will consume. Commit these as `docs/xero-cli-contract.md` -- a canonical reference for command outputs, error shapes, and exit codes that both CLI tests and skill examples consume. This ensures the skill isn't designed against assumptions that diverge from reality.

**Files to create:**
- `src/cli/commands/transactions.ts` -- `GET /BankTransactions?where=IsReconciled==false AND Date>=DateTime(...)&page=N` with auto-pagination
- `src/cli/commands/accounts.ts` -- `GET /Accounts?where=Status=="ACTIVE"` -- chart of accounts for categorization
- `src/cli/commands/invoices.ts` -- `GET /Invoices?where=Status=="AUTHORISED"` -- outstanding invoices for matching
- `src/cli/commands/history.ts` -- `GET /BankTransactions` (reconciled), grouped by contact and account code with frequency counts

**All list commands support `--fields` for token efficiency.**

**Verification:** `bun run xero-cli transactions --unreconciled --json` returns structured data. `bun run xero-cli accounts --json` returns chart of accounts. `bun run xero-cli history --since 2025-07-01 --json` returns grouped history.

### Phase 3: Reconcile Command + State

**Goal:** `reconcile` command reads JSON from stdin, creates reconciliation entries via API.

**Files to create:**
- `src/cli/commands/reconcile.ts`
- `src/state/state.ts`

**Two reconciliation paths based on input:**

- **Account code assignment** (everyday expenses) -- `{"BankTransactionID":"...","AccountCode":"6310"}`. Updates the BankTransaction's LineItems with the AccountCode.
- **Invoice matching** (payments) -- `{"BankTransactionID":"...","InvoiceID":"..."}`. Creates a Payment with `IsReconciled: true` via `PUT /Payments`.

**Safety:** `--execute` flag required. Dry-run by default. Process lock via `withFileLock()`. State file for idempotency (no explicit server-side pre-check -- Xero validation errors are the safety net). Response validation type guards (including `HasValidationErrors` and `StatusAttributeString` checks) before state mutation.

**Verification:** Pipe test JSON to `bun run xero-cli reconcile --json`, see dry-run output. Pipe with `--execute`, confirm reconciliation in Xero web UI.

### Phase 4: Claude Code Skill

**Goal:** Skill file that teaches Claude the full workflow.

**File:** `.claude/skills/xero-reconcile/SKILL.md`

MUST be build with the Skill Creator skill (`/Users/nathanvale/.claude/plugins/marketplaces/every-marketplace/plugins/compound-engineering/skills/skill-creator/SKILL.md`)

**CLI resolution strategy:** The skill MUST NOT hardcode local paths. It uses `bun run xero-cli` (resolved via package.json script in the project root). If the skill is run outside the repo root, Claude should `cd` to the side-quest-xero-cli directory first. The skill documents this: "Run all commands from the side-quest-xero-cli project root (where package.json lives)."

The skill teaches Claude:
1. How to authenticate (`bun run xero-cli auth`)
2. How to pull unreconciled transactions and chart of accounts
3. How to analyze transaction history for pattern matching
4. How to propose account codes with confidence levels
5. How to present proposals to the user for review
6. How to execute reconciliation via stdin JSON
7. How to handle the "needs review" bucket

**The skill is where the intelligence lives.** The CLI is deliberately dumb -- the skill turns Claude into the smart layer that categorizes 300+ transactions in seconds.

**SKILL.md must be a full runbook, not a template.** It must include:
- **Decision trees** for each step (what to do when a command returns exit 1 vs 4 vs 5)
- **Retry policy per command:** auth (0 retries -- run auth), transactions/accounts/history/invoices (3 retries with backoff), reconcile (1 retry for transient errors, 0 for validation errors)
- **Token budget management:** Enforce progressive loading. Never load all 387 transactions + full history + full accounts into a single prompt. Strategy: (1) Load accounts once (~2K tokens), (2) Load history grouped (~4K tokens), (3) Load transactions in chunks of 50 (~5K tokens per chunk), (4) Analyze and propose per chunk, (5) Accumulate proposals, (6) Present summary to user. Target: <20K tokens per analysis step.
- **Failure recovery:** If reconcile fails mid-batch (exit 1), the skill should: check status, re-auth if needed, re-run reconcile with same input (idempotent resume). Do NOT re-fetch transactions (data in context is still valid).
- **Stop/ask-user gates:** Before `--execute`, ALWAYS present the full proposal to the user and wait for explicit confirmation. Never auto-execute.
- **BankTransactionID immutability:** The skill MUST carry BankTransactionID from the `transactions` fetch through proposal/review/execute as an opaque key. NEVER reconstruct IDs from display fields (Contact name, amount, date). If a transaction is removed from the proposal, drop it entirely.
- **Invoice Amount/CurrencyCode derivation:** For invoice matches, the skill gets Amount from the BankTransaction's Total field and CurrencyCode from the BankTransaction's CurrencyCode field. The skill MUST include both in the reconcile input. If the BankTransaction currency doesn't match the Invoice currency, flag for manual review.
- **Batch strategy:** Default chunk size 50 for reconcile input. For >200 items, split into multiple reconcile calls to avoid oversized stdin payloads and provide progress visibility.
- **Contact name normalization for history matching:** Exact name matching degrades with inconsistent bank descriptions (e.g., "GITHUB INC" vs "GITHUB.COM" vs "GH *GITHUB"). The skill should use fuzzy matching heuristics: strip common suffixes (PTY LTD, INC, LLC), normalize whitespace, and present low-confidence matches for user review.
- **Cross-command auth recovery:** Read commands (`transactions`, `accounts`, `history`, `invoices`) produce output valid for the duration of Claude's context window. Re-auth does NOT invalidate previously fetched data. If `reconcile` fails with exit code 4 mid-workflow: (1) run `auth`, (2) re-run `reconcile` with the same stdin (idempotent resume via state file), (3) do NOT re-fetch transactions. The skill documents this explicitly so Claude doesn't restart from scratch.

---

## Dependencies

```bash
# Runtime
bun add @side-quest/core    # fs, oauth, concurrency, errors, utils, formatters, spawn
bun add @logtape/logtape    # Structured logging -- zero-config, JSON Lines on stderr
# Event emission uses raw fetch() -- zero additional dependencies
```

---

## Acceptance Criteria

### Core CLI
- [x] `bun run xero-cli` with no args prints full self-documenting help
- [x] `bun run xero-cli --version` prints CLI version
- [x] `bun run xero-cli auth` completes OAuth2 PKCE flow, stores tokens in Keychain
- [x] `bun run xero-cli transactions --unreconciled --json` returns structured JSON
- [x] `bun run xero-cli accounts --json` returns chart of accounts
- [x] `bun run xero-cli history --since 2025-07-01 --json` returns grouped reconciliation history (--since is required)
- [x] `bun run xero-cli history --json` without --since returns a usage error
- [x] `bun run xero-cli invoices --json` returns outstanding invoices
- [x] `bun run xero-cli reconcile --execute` accepts JSON from stdin, creates entries in Xero
- [x] `bun run xero-cli status --json` returns auth + API health check
- [x] `package.json` has `"xero-cli": "bun src/cli/command.ts"` script

### Output Modes
- [x] All commands support `--json`, `--quiet`; list commands also support `--fields`
- [x] `--fields` rejected on non-list commands (auth, status, reconcile)
- [x] Non-TTY auto-detects and switches to JSON output (explicit `--json` always wins, auto non-TTY is convenience fallback)
- [x] `--fields` with invalid chars returns usage error (not silent ignore)
- [x] `--fields` is case-sensitive (PascalCase, matching Xero API: `Contact.Name` not `contact.name`)
- [x] Typed exit codes (0-5, 130) for agent branching
- [x] Structured JSON errors on stderr with dual-mode writeError (JSON or human based on context)
- [x] Top-level catch-all with `sanitizeErrorMessage()` ensures no unformatted or token-leaking errors escape
- [x] Error-to-exit-code mapping uses 3 error classes (`XeroAuthError`, `XeroApiError` with status, `XeroConflictError`)

### Help & Aliases
- [x] Help system: three access patterns (`help <topic>`, `<cmd> --help`, `--help <topic>`)
- [x] Help topics with aliases (tx -> transactions, inv -> invoices, etc.)
- [x] Command aliases (tx, inv, acct, rec) normalized to canonical names
- [x] Unknown flags produce usage error (never silently ignored)

### Data Handling
- [x] Every command defines a typed success data interface (e.g., TransactionsSuccessData)
- [x] Field projection: `projectFields()` with dot-path traversal, field name char validation, and case-sensitive matching
- [x] `xeroPost()` returns `unknown` (not `any`) -- callers must use type guards
- [x] CSV export works for unmatched/uncertain transactions (`src/xero/export.ts`)

### Logging & Observability
- [x] `--verbose` shows info-level logs (API calls, pagination progress) on stderr
- [x] `--debug` shows debug-level logs (request/response, rate limit state) on stderr
- [x] `--json --debug` outputs JSON Lines on stderr (machine-parseable for agents)
- [x] `XERO_LOG_FORMAT=text` env var forces human-readable log format for test determinism
- [x] Flag precedence: `--debug` > `--quiet` > `--verbose` > default (via resolveOutputMode())
- [x] setupLogging() is synchronous; shutdownLogging() is async with 500ms timeout guard
- [x] shutdownLogging() called via try/finally in main() and SIGINT handler
- [x] shutdownLogging() is idempotent (safe before setup, after failed setup, or when called twice)
- [x] writeError() is sole owner of user-facing errors; logger.error() is diagnostic-only (no duplicate messages)
- [x] ProgressDisplay mode gated by resolveOutputMode().progressMode (animated/static/off)
- [x] Log invariant tests: stdout has no log messages, --quiet stderr is clean, no envelope fragments in stderr
- [x] Async context propagation (Phase 2): withContext() with runId wraps entire command execution
- [x] Fingers-crossed sink (Phase 2+): deferred until real usage surfaces gaps
- [x] No tokens logged -- Authorization headers redacted at debug level
- [x] Events posted to observability server on auth, fetch, and reconcile operations
- [x] Event server URL configurable via `--events-url` flag, `XERO_EVENTS_URL` env var, or port file auto-discovery
- [x] `XERO_EVENTS=0` disables all event emission
- [x] Event emission is fire-and-forget (no-op when no server configured, never blocks CLI)

### Security
- [x] Keychain hard-fails with actionable error if unavailable (distinguishes not-found, access-denied, locked)
- [x] Keychain `loadTokens()` validates data against Zod schema -- corrupted data triggers re-auth
- [x] Token revocation via Xero endpoint before Keychain deletion on re-auth/logout
- [x] Callback server uses fixed redirect URI `http://127.0.0.1:5555/callback`
- [x] Callback server `state` parameter validated with `crypto.timingSafeEqual()`
- [x] Callback response is static HTML with `Content-Type` and `X-Content-Type-Options: nosniff` headers
- [x] Token refresh uses cross-process file lock to prevent single-use refresh token races
- [x] Token refresh uses freshCheck.refreshToken inside lock (not stale pre-lock token)
- [x] Token refresh handles Keychain save failure with actionable error (burned token recovery)
- [x] loadTokens/deleteTokens recursion eliminated (deleteTokens uses loadTokensRaw)
- [x] File lock has explicit timeout (30s), stale PID detection, and crash recovery
- [x] timingSafeEqual guarded for buffer length mismatch before comparison
- [x] base64url output is unpadded and URL-safe per RFC 7636
- [x] Error messages sanitized (Bearer tokens, access_token, refresh_token, code, code_verifier, client_id, xero-tenant-id stripped)
- [x] Reconcile stdin uses streaming byte count with early abort (not post-read check)
- [x] Reconcile stdin validated with Zod: UUID-shaped format (not strict v4), alphanumeric AccountCode (1-10 chars), max 1000 entries, strict parsing
- [x] Reconcile input rejects duplicate BankTransactionIDs (entire payload rejected with listed duplicates)
- [x] Reconcile stdin rejects entries with both AccountCode AND InvoiceID (deterministic validation error)
- [x] `.xero-config.json` and state files: written with `0o600`, atomic writes (same-dir temp+fsync+rename), read rejects symlinks and permissive modes
- [x] State file uses schemaVersion validation + preflight write-scope guard for tamper/staleness detection (content hash dropped -- disproportionate for personal tool)
- [x] Atomic writes verified: Bun.write flush behavior documented, fallback to node:fs if needed
- [x] `config.ts` validates env vars and config file with actionable error messages

### Reconciliation Safety
- [x] Re-runs are idempotent (local state file with discriminated union: account-code vs payment entries)
- [x] Account code reconciliation via `POST /BankTransactions/{id}` with rate-limit throttling
- [x] Invoice matching via batch `PUT /Payments` (batch size 25) with per-item error parsing
- [x] Batch payment creation with per-item error parsing
- [x] Preflight checks before --execute mode (including period lock warning and write scope validation)
- [x] Write scope guard: all input BankTransactionIDs validated against current unreconciled set
- [x] AccountCode pre-validation: all codes checked against active chart of accounts before writes
- [x] Invoice reconciliation requires Amount and CurrencyCode in input (validated against invoice)
- [x] Account-code updates preserve line item invariants (Quantity, UnitAmount, TaxType, etc.)
- [x] Post-update Total verified against pre-update Total (delta flagged in audit report)
- [x] Audit report includes full input, pre-state, per-item request/response, rollback references
- [x] Audit report written to .xero-reconcile-runs/ on each --execute
- [x] Response validation type guards before state mutation (checks HasValidationErrors + StatusAttributeString, not just field presence)
- [x] Process lock via withFileLock prevents concurrent --execute
- [x] PRE-IMPLEMENTATION (BEFORE PHASE 1): Account code reconciliation validated in Xero demo org (locked periods, filed BAS, already-coded transactions, redirect_uri matches fixed callback)
- [x] Default mode (no `--execute` flag) is dry-run -- shows what would happen without making changes
- [x] `reconcile` command throws at code level if `execute` is not explicitly `true` (safety interlock)
- [x] Ctrl+C during --execute finishes current API call, writes audit report for completed items, exits 130
- [x] Re-running after interruption skips already-processed items and resumes from checkpoint (via state file)

### Agent DX
- [x] Error envelope includes `action` and `retryable` fields (deterministic per error code, subcategorized)
- [x] Error envelope includes optional `context` record with safe diagnostic fields (endpoint, status, timing)
- [x] Exit code 1 errors use subcategorized codes: E_NETWORK, E_FORBIDDEN, E_SERVER_ERROR, E_RATE_LIMITED
- [x] Exit code 5 errors use subcategorized codes: E_LOCK_CONTENTION, E_STALE_DATA, E_API_CONFLICT
- [x] Stdout purity: exactly one JSON object + newline in JSON mode, no other output ever
- [x] Success envelope includes `schemaVersion` for forward compatibility
- [x] `ReconcileSuccessData.results[].status` is typed enum: `reconciled | skipped | failed | dry-run`
- [x] History output includes Type (SPEND/RECEIVE), CurrencyCode, MostRecentDate, ExampleTransactionIDs
- [x] Invalid `--fields` JSON error includes `invalidFields` and `validFieldsHint` for LLM self-correction
- [x] `assertValidBankTransactionResponse` type guard checks HasErrors and Total match before state mutation
- [x] `assertValidBankTransactionResponse` negative tests: throws on missing BankTransactionID, HasErrors: true, Total mismatch > 0.01, non-object input, null input
- [x] `assertValidPaymentResponse` negative tests: throws on missing PaymentID, missing Amount, StatusAttributeString === "ERROR", HasValidationErrors: true, non-object input, null input

### Human DX
- [x] `--summary` flag on list commands shows aggregated view for 50+ rows (counts by type/month/contact)
- [x] Date range presets: `--this-quarter`, `--last-quarter` on transactions
- [x] `status` command returns per-location health `checks` array (env, config, keychain, state_file, lock_file, audit_dir)
- [x] `status` command `diagnosis` is a typed enum (not free-form string) with canonical `nextAction` per diagnosis
- [x] Reconcile human output shows real-time per-item results as they complete (not just summary at end)
- [x] Reconcile progress bar shows rate-limit pauses distinctly
- [x] Rate-limit warnings visible in default mode (not just --verbose)
- [x] Auth callback timeout defaults to 300s (configurable via --auth-timeout), exits with code 4 on timeout
- [x] Reconcile human output includes audit digest (counts by account code, totals by type)
- [x] First-run setup guide printed when .env is missing during `auth`
- [x] Uncertain transaction CSV import via `reconcile --from-csv <file>` with schema validation
- [x] `@side-quest/core` pinned to exact version (no dedicated compat test file -- real tests catch breakage) (N/A: not used in current code)

### Testing Infrastructure
- [x] `XERO_API_BASE_URL` env var configures API base URL (tests use local mock server)
- [x] Xero mock server (`tests/helpers/xero-mock-server.ts`) with route-keyed canned responses
- [x] Scenario-based fixtures in `tests/fixtures/` with versioned JSON from demo org
- [x] Auth provider interface with `InMemoryAuthProvider` for CI (no Keychain dependency)
- [x] Logger test isolation via `configure({ reset: true })` in beforeEach (prefer over `--concurrency 1`)
- [x] Integration test layer: full stdin -> validate -> API -> state -> audit flow against mock server, covering these scenarios:
  1. Happy path -- 5 account-code items, all succeed, state file written, journal complete
  2. Mixed success/failure -- 3 succeed, 2 fail (one validation error, one 429), state has 3 entries, journal has both
  3. Resume after interruption -- run with 5 items, kill after 3, re-run same input, verify 3 skipped + 2 processed
  4. Duplicate BankTransactionID rejection -- entire payload rejected
  5. Stale preflight -- transaction reconciled between preflight and execution, treated as skipped
  6. Invoice payment batch -- 3 invoice matches in one batch, verify batch PUT and per-item state
  7. Token refresh mid-run -- token expires during run, transparent refresh, execution continues
  8. Dry-run -- same input, no --execute, verify zero state changes and zero API writes
- [x] Filesystem security tests: atomic writes, symlink rejection, permission checks (real FS, temp dirs)
- [x] Acceptance-criteria-to-test traceability matrix in `docs/test-matrix.md`
- [x] Output invariant tests assert full envelope contracts: `schemaVersion`, typed status enums, error shape

### Integration
- [x] Claude Code skill can orchestrate the full reconciliation workflow
- [x] Claude Code skill handles uncertain transaction CSV round-trip via `--from-csv`
- [x] All tests pass (`bun test`)

---

## What Changed From the Previous Plans

| Aspect | Original Plans (4 files) | This Plan (consolidated) |
|--------|-------------------------|--------------------------|
| Architecture | Monolithic CLI with matching logic | Dumb CLI pipe + Claude skill |
| Intelligence | Built into `matcher.ts` | Lives in Claude Code skill |
| Primary use case | Invoice matching | Account code categorization (300+ txns) |
| Output format | Human-only | Dual-mode (human/JSON) |
| Agent support | None (Claude command wrapper) | First-class (agent-native patterns) |
| Field projection | None | `--fields` for token economy |
| Exit codes | 0-3 (ad hoc) | 0-5, 130 (typed, semantic) |
| Error format | Thrown exceptions | Structured JSON on stderr |
| Chart of accounts | Not fetched | Core command (`accounts`) |
| History/patterns | Not fetched | Core command (`history`) |
| Reconcile input | Hardcoded matching | JSON from stdin (agent feeds it) |
| Technical details | Scattered across 4 files | Inlined in single document |
| Cross-references | "See superseded plan" | None needed |

---

## Future Enhancements (out of scope)

Researched but deferred. Claude IS the fuzzy matcher -- no need to code matching engines:

- **Advanced matching** -- token set ratio fuzzy matching, Australian bank description parser, confidence scoring
- **Browser-driven reconciliation** -- for transactions that can't be reconciled via API, using agent-browser

---

## Sources

### Agent-Native CLI Patterns
- [joelclaw.com -- "Designing CLI tools for LLM agents"](https://joelclaw.com) -- JSON-first, self-documenting
- [@yacineMTB -- "0 dependencies. It's not hard."](https://x.com) -- zero-dep philosophy
- [Lineark (@flipbit03) -- "13K tokens via MCP vs 1K via CLI"](https://x.com) -- field projection
- [Laminar -- headless agent guidelines](https://laminar.dev) -- never block stdin, JSON-strict
- [Reference implementation] (/Users/nathanvale/code/claude-code-config/skills/patterns/SKILL.md)

### Observability
- [LogTape CLI Observability Spec](~/code/side-quest-last-30-days/docs/research/logtape-cli-observability-spec.md)
- [LogTape docs](https://logtape.org/) -- zero-dependency structured logging for JS/TS
- `@side-quest` observability plugin (`~/code/side-quest-plugins/plugins/observability/hooks/emit-event.ts`)
- Observability server (`~/code/side-quest-observability/packages/server/`)

### Xero API
- [Xero PKCE Flow](https://developer.xero.com/documentation/guides/oauth2/pkce-flow)
- [Xero OAuth2 Scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Xero OAuth2 Auth Flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/)
- [BankTransactions API](https://developer.xero.com/documentation/api/accounting/banktransactions)
- [Payments API](https://developer.xero.com/documentation/api/accounting/payments)
- [Accounts API](https://developer.xero.com/documentation/api/accounting/accounts)
- [Invoices API](https://developer.xero.com/documentation/api/accounting/invoices)
- [Contacts API](https://developer.xero.com/documentation/api/accounting/contacts)
- [Organisation API](https://developer.xero.com/documentation/api/accounting/organisation)
- [Connections (Identity API)](https://developer.xero.com/documentation/guides/oauth2/tenants)
- [Response Codes](https://developer.xero.com/documentation/api/accounting/responsecodes)
- [Types & Codes Reference](https://developer.xero.com/documentation/api/accounting/types)
- [Rate Limits](https://developer.xero.com/documentation/guides/oauth2/limits)
- [Xero OpenAPI Spec v11.0.0](https://github.com/XeroAPI/Xero-OpenAPI) -- MIT license
- [PKCE for Native Apps (Xero blog)](https://devblog.xero.com/introducing-pkce-quick-easy-and-secure-use-of-oauth-2-0-for-native-apps-7696a4b83900)

### Dependencies
- [@side-quest/core](https://github.com/nathanvale/side-quest-core) -- shared utility library
- [@logtape/logtape](https://logtape.org/) -- structured logging
- [fastest-levenshtein](https://github.com/ka-weihe/fastest-levenshtein) -- (deferred: fuzzy matching)
- [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) -- (deferred: type generation)
- [openapi-fetch](https://github.com/openapi-ts/openapi-typescript/tree/main/packages/openapi-fetch) -- (deferred: typed fetch)

### Security
- [macOS Keychain via security CLI](https://www.netmeister.org/blog/keychain-passwords.html)
- [OAuth 2.0 for Native Apps (RFC 8252)](https://tools.ietf.org/html/rfc8252)

---

## Review Findings Applied (2026-02-26)

Three-pass staff engineer review via Codex. All passes returned REQUEST CHANGES. Findings patched into the plan above.

**Excluded by author decision (not bugs, intentional choices):**
- `@side-quest/core` coupling (12 imports) -- saves work, keeps patterns consistent across projects
- Observability layer scope (LogTape + event bus) -- prototype for bigger project

**Applied from Architect (Pass 1):**
- `history --since` is now required (no default) to prevent unbounded API fetching
- State strategy contradiction fixed (single model: no server pre-check, Xero validation is safety net)
- CLI packaging gap fixed (added `"xero-cli"` script to package.json)
- Account code reconciliation requires demo-org validation before Phase 3 implementation
- Progress bar with ETA for sequential reconciliation operations

**Applied from DX Advocate (Pass 2):**
- History output schema: `"Amount":"varies"` replaced with `AmountMin`/`AmountMax` numbers
- Reconcile union conflict: entries with both AccountCode AND InvoiceID produce deterministic validation error
- Field projection: invalid chars now return usage error (not silent ignore), case-sensitivity documented
- `--json` vs auto non-TTY: explicit precedence rules documented
- CLI invocation path defined (`bun run xero-cli` via package.json script)

**Applied from Security Engineer (Pass 3):**
- Stdin DoS: hard 5MB byte limit before Zod parsing
- OAuth callback: fixed redirect URI `http://127.0.0.1:5555/callback`
- Token refresh: cross-process file lock via withFileLock (prevents single-use refresh token races)
- State/config files: read-time symlink rejection + permission verification + atomic writes
- Response validation: checks HasValidationErrors + StatusAttributeString (not just field presence)
- Error sanitization: added client_id and xero-tenant-id patterns

**Review files:** `specs/reviews/xero-cli-review-pass-{1,2,3}.md`

### Round 2: 5-Pass Deep Review (2026-02-26)

Five-pass staff engineer review via Codex (3 Security + 2 DX). All passes returned REQUEST CHANGES. Findings patched into the plan above.

**Applied from Security Pass 1 (OAuth & Auth):**
- Token refresh uses freshCheck.refreshToken inside lock (not stale pre-lock tokens)
- Crash-safe strategy for refresh-token rotation: retry Keychain save, actionable error if burned
- Recursive corruption eliminated: deleteTokens uses loadTokensRaw (no validation, no side effects)
- Lock timeout/stale handling specified (30s timeout, PID-based stale detection)
- timingSafeEqual length guard added (reject before compare if buffer lengths differ)
- base64url must be unpadded per RFC 7636
- Keychain error handling distinguishes not-found, access-denied, locked

**Applied from Security Pass 2 (Input Validation & State):**
- Stdin DoS fixed: streaming byte count with early abort (not post-read Bun.stdin.text())
- AccountCode regex relaxed: `^[A-Za-z0-9]{1,10}$` (was `^\d{4}$` -- Xero codes are alphanumeric)
- UUID validation relaxed: UUID-shaped regex (not strict z.string().uuid() which may reject valid Xero IDs)
- State file tamper detection via schemaVersion + preflight write-scope guard (content hash dropped in Round 4)
- Atomic write spec: same-dir temp file, Bun.write flush verification, node:fs fallback documented
- Locking backend spec: PID-based, stale detection, crash recovery, 30s timeout
- TOCTOU risk documented (lstatSync gap accepted for personal tool)

**Applied from Security Pass 3 (Financial Data & Audit):**
- Write scope guard: reconcile validates all BankTransactionIDs against current unreconciled set
- AccountCode pre-validation against active chart of accounts before any writes
- Invoice reconciliation now requires Amount and CurrencyCode in input (prevents silent mismatches)
- Line item preservation contract: only AccountCode changes, all other fields preserved, post-update Total verified
- Audit report expanded: full input, pre-state snapshot, per-item request/response, rollback references
- Deterministic rollback procedure documented (payment deletion, account-code reversion from pre-state)
- Preflight checks include period lock warning and write scope validation

**Applied from DX Pass 1 (Agent Consumption):**
- Error envelope includes `action` and `retryable` fields (deterministic per exit code, no heuristics needed)
- Stdout purity guarantee documented (exactly one JSON object in JSON mode, enforced by architecture)
- ReconcileSuccessData.results[].status is typed enum: reconciled | skipped | failed | dry-run
- Success envelope includes schemaVersion for forward compatibility
- History output includes Type, CurrencyCode, MostRecentDate, ExampleTransactionIDs for decision context
- Invalid --fields JSON error includes invalidFields and validFieldsHint for LLM self-correction
- Duplicate BankTransactionID in reconcile input rejects entire payload
- Empty reconcile input returns validation error

**Applied from DX Pass 2 (Human Ergonomics):**
- Uncertain transaction round-trip workflow defined (CSV export -> spreadsheet review -> Claude import)
- --summary flag for large result sets (aggregated view: counts by type/month/contact)
- Date range presets: --this-quarter, --last-quarter
- Safe interruption semantics: Ctrl+C finishes current call, writes audit, resumes on re-run
- First-run setup guide printed when .env missing (step-by-step with common issues)
- Status command includes diagnosis and nextAction fields for actionable troubleshooting
- Reconcile human output includes audit digest (counts by account code, totals)

**Review files:** `specs/reviews/xero-cli-review-sec-{1,2,3}.md`, `specs/reviews/xero-cli-review-dx-{1,2}.md`

### Round 3: 6-Pass Deep Review (2026-02-26)

Six-pass staff engineer review (3 Architect + 3 DX). All passes returned REQUEST CHANGES. Findings patched into the plan above.

**Applied from Architect Pass 1 (State Machine & Data Flow):**
- Formal reconciliation state machine with explicit transitions and terminal states
- Journaled audit (NDJSON event log) replaces two-file commit for atomic state+audit consistency
- API budget estimate documented (~557 calls for 300-item mixed run) with hard abort threshold at 2,500 calls
- Invoice validation batch-fetched during preflight (not inline during execution)
- Line item edge cases defined: zero items, multiple items, split categorization rejection, already-correct skip
- Audit growth managed: 90-day retention, max ~2MB per run, auto-prune at start of each execute
- SIGINT batch granularity: between batches, not within; partial acceptance per item in batch
- Preflight-to-execution staleness handled: already-reconciled treated as `skipped`, not `failed`
- Hash recalculation scope: O(n) per save, not O(n^2)

**Applied from Architect Pass 2 (API Contract & Type System):**
- `XeroResponse<T, V>` fixed: `type` alias with intersection, not `interface` with mapped type
- `writeSuccess` now includes `schemaVersion` in JSON output
- BankTransaction wire type validation required before coding (PRE-IMPLEMENTATION task added)
- `parseXeroDecimal()` utility defined for centralized string-to-number coercion
- `assertValidBankTransactionResponse` type guard added (checks HasErrors, not HasValidationErrors)
- `XeroApiError` constructor explicitly maps to StructuredError params (category, code, recoverable)
- Payment creation derives Account from BankTransaction.BankAccount.AccountID
- `XeroAccount.Type` enum extended with BANK, PREPAYMENT, SALES, etc. + `(string & {})` escape hatch

**Applied from Architect Pass 3 (Phasing, Dependencies & Build Order):**
- Phase exit criteria defined per phase (explicit "done when" conditions)
- `@side-quest/core` stability contract: exact pin, compatibility tests, fork-on-break policy
- Fallback reconciliation path if POST doesn't reconcile (invoice-only or browser-automation)
- Contract-first skill development: JSON schemas drafted during Phase 2
- CLI resolution strategy for skill: `bun run xero-cli` from project root

**Applied from DX Pass 1 (Skill Authoring & Agent Orchestration):**
- SKILL.md must be a full runbook with decision trees, retry policies, and stop/ask-user gates
- Token budget management: progressive loading, chunked analysis, <20K tokens per step
- CLI-native CSV import: `reconcile --from-csv <file>` with schema validation
- BankTransactionID immutability enforced through entire proposal/review/execute pipeline
- Invoice Amount/CurrencyCode derivation rules documented
- Batch strategy: chunk size 50, multiple calls for >200 items
- Contact name normalization heuristics for history matching

**Applied from DX Pass 2 (Error Recovery & Cognitive Load):**
- Status command expanded: per-location health checks (6 locations), canonical diagnosis enum
- Auth callback timeout increased to 300s (configurable), exits code 4 on timeout with countdown
- Rate-limit visibility: human-visible warnings in default mode, retry notifications on stderr
- Exit code 1 subcategorized: E_NETWORK, E_FORBIDDEN, E_SERVER_ERROR, E_RATE_LIMITED
- Exit code 5 subcategorized: E_LOCK_CONTENTION, E_STALE_DATA, E_API_CONFLICT
- writeError extended with optional context record for safe diagnostic fields
- Real-time per-item failure reporting during reconciliation (not end-only)
- Cross-command auth recovery documented for skill

**Applied from DX Pass 3 (Testing Strategy & Verification):**
- XERO_API_BASE_URL env var for configurable API base in tests
- Local mock server architecture with route-keyed canned responses
- Scenario-based fixtures captured from demo org
- Auth provider interface with InMemoryAuthProvider for CI
- LogTape test isolation via --concurrency 1 for logger-sensitive suites
- Integration test layer: full stdin-to-audit flow against mock server
- Filesystem security tests with real FS and temp dirs
- Acceptance-criteria-to-test traceability matrix (docs/test-matrix.md)

**Review files:** `specs/reviews/xero-cli-review-arch-{1,2,3}.md`, `specs/reviews/xero-cli-review-dx-{skill-1,error-2,testing-3}.md`

### Round 4: 3-Pass Coherence Review (2026-02-26)

Three-pass review focused on post-68-patch coherence. All passes returned APPROVE WITH CONDITIONS (first round without REQUEST CHANGES). 10 critical issues total, mostly coherence fixes from layered editing.

**Applied from Architect Pass 1 (Internal Coherence & Contradiction Detection):**
- Dead EXIT_CODE_ACTIONS comment removed (naming mismatch from pre-Round-3)
- Audit file extension fixed from .json to .ndjson in user-facing example
- assertValidBankTransactionResponse file location specified (reconcile.ts)
- --from-csv deferred to Phase 4 with implementation details (simple line-by-line parsing)
- State machine clarified: state file only persists successes, resume works by absence
- Status check criteria table added (ok/warning/error per location)
- Dead runCli() function removed (main() supersedes)
- XeroApiError dynamic code clarified as internal-only (exitCodeFromError is canonical)
- shouldRetry aligned with isRetryableError (added 500 to HTTP retry list)

**Applied from Operator Pass 2 (Operational Failure Modes & Recovery):**
- Demo org validation moved to BEFORE Phase 1 (plan-blocking assumption, not Phase 3 pre-task)
- NDJSON journal corruption recovery specified (line-by-line parsing, try/catch, skip unparseable)
- Per-request AbortController timeout (30s) added to xeroFetch() (prevents hang after laptop sleep)
- --prune-audits replaced with automatic pruning at start of each execute run
- @side-quest/core compatibility test file dropped (real tests catch breakage)
- State file content hash dropped (schemaVersion + preflight guard already catch issues)
- API budget threshold explicitly per-invocation (not cumulative across CLI calls)
- Redirect URI validation added to demo org pre-implementation test

**Applied from Test Engineer Pass 3 (Testing Strategy & Verification):**
- MockRoute interface extended with ordered response sequences and call counter
- Negative test acceptance criteria added for assertValidBankTransactionResponse and assertValidPaymentResponse
- 8 integration test scenarios enumerated (happy path through dry-run)
- LogTape isolation strategy: prefer configure({ reset: true }) over --concurrency 1

**Review files:** `specs/reviews/xero-cli-review-r4-arch-1.md`, `specs/reviews/xero-cli-review-r4-operator-2.md`, `specs/reviews/xero-cli-review-r4-test-3.md`
