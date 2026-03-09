---
name: xero-cli
description: >
  Reference documentation for the xero-cli tool. Covers all commands, flags,
  output contracts, error codes, and safety rules. Claude loads this
  automatically when working with Xero bank transactions, reconciliation,
  account codes, or invoices.
user-invocable: false
allowed-tools: Bash(bun run xero-cli *)
---

# xero-cli Reference

CLI for reading and writing Xero bank transaction data. JSON in, JSON out.

Run all commands from the side-quest-xero-cli project root (where `package.json` lives).

## Commands

| Command | Alias | Purpose |
|---------|-------|---------|
| `status` | -- | Preflight check (auth, config, API connectivity) |
| `auth` | -- | OAuth2 PKCE flow (browser-based, human interaction required) |
| `transactions` | `tx` | Read bank transactions |
| `accounts` | `acct` | Read chart of accounts |
| `invoices` | `inv` | Read invoices |
| `payments` | `pay` | Read payments |
| `history` | `hist` | Read past reconciled transactions (grouped by contact) |
| `reconcile` | `rec` | Create reconciliation entries (stdin JSON or CSV) |

For complete flag reference and examples, read [references/command-reference.md](references/command-reference.md).

For reconcile input shapes, read [references/input-schemas.md](references/input-schemas.md).

For error codes, retry policy, and batch strategy, read [references/error-handling.md](references/error-handling.md).

## Output Contract

**Success (stdout):**
```json
{"status":"data","schemaVersion":1,"data":{"command":"...","count":N,...},"warnings":["field 'Contcat.Name' was undefined in all records -- check spelling."],"phase":"result"}
```

- `warnings` (optional array) - present when `--fields` contains names that resolve to undefined in all records. Indicates likely typos. When an agent sees a warning, it should check field spelling against the valid PascalCase dot-path names (e.g., `Contact.Name` not `Contcat.Name`).
- `phase` (optional string) - present in headless auth NDJSON two-phase contract. Values: `"auth_url"` (first line), `"result"` (second line). See [headless auth](references/command-reference.md#auth) for details.

**Error (stderr):**
```json
{"status":"error","message":"...","error":{"name":"UsageError","code":"E_USAGE","action":"FIX_ARGS","retryable":false,"context":{"invalidFields":["Contcat.Name"],"validFieldsHint":"Fields are PascalCase dot paths (e.g., Contact.Name, BankTransactionID)..."}}}
```

- `context` (optional object) - structured metadata for programmatic error recovery. Contents vary by error type. Example: `invalidFields` array lists the rejected field names, and `validFieldsHint` string describes the expected naming convention. Agents should use `context` to self-correct before retrying.

Auto-JSON: when stdout is not a TTY, `--json` is enabled automatically.

## Observability and Debugging

### Three-Tier Output Architecture

| Tier | Destination | Content | When |
|------|------------|---------|------|
| stdout | Program output | JSON data envelopes | Always |
| stderr | Diagnostic logs | LogTape structured logs | `--verbose` / `--debug` / on error |
| events | Observability server | Fire-and-forget telemetry | `--events-url` set |

### Flag-to-Level Mapping

| Flag | Log Level | What You See on stderr |
|------|-----------|----------------------|
| (none) | silent | Nothing on success; full debug trace on error (fingers-crossed) |
| `--quiet` | silent | Nothing (fingers-crossed disabled) |
| `--verbose` | info | CLI lifecycle, API call summaries, reconcile progress |
| `--debug` | debug | All of verbose + request/response details, parsed options, state checkpoints |

### Fingers-Crossed Pattern

When no verbosity flag is set (and not in `--json` or `--quiet` mode), the CLI buffers all log messages. If the command succeeds, the buffer is discarded (zero noise). If the command fails with an error, the entire buffered log (including debug-level messages) is flushed to stderr automatically. This gives you full diagnostic context on failures without any upfront `--debug` flag.

### Events (--events-url)

```bash
bun run xero-cli reconcile --execute --json --events-url http://localhost:3000/events
```

Or via environment variables:
- `XERO_EVENTS_URL` - observability server URL
- `XERO_EVENTS=0` - disable events even when URL is configured

Events are fire-and-forget HTTP POSTs. They never block or slow down CLI operations.

### Agent Debugging Workflow

1. **Normal run** - no flags needed. If it fails, you get a full debug trace automatically (fingers-crossed).
2. **Proactive debugging** - add `--verbose` to see lifecycle events during the run.
3. **Deep debugging** - add `--debug` to see every API call, parsed option, and state write.

### Log Format

- **Human mode (TTY stderr):** Console-formatted text via LogTape
- **Agent mode (non-TTY stderr or `--json`):** JSON Lines format on stderr (one JSON object per line)
- Override with `XERO_LOG_FORMAT=text` or `XERO_LOG_FORMAT=json`

## Safety Rules

These rules apply to ALL workflows that use xero-cli.

### Auth Prerequisite

Run `bun run xero-cli status --json` before any Xero workflow. On failure, inspect `error.context.checks` to determine the exact issue:

**When diagnosis is `invalid-config` / `FIX_CONFIG`:**

| Check that failed | Fix |
|-------------------|-----|
| `env` check has `status: "error"` | `.env` is missing `XERO_CLIENT_ID`. Tell the user to add it. Auth cannot fix this. |
| `config` check has `status: "warning"` or `"error"` | `.xero-config.json` is missing or corrupt. Auth creates this file. |
| Both `env` and `config` failed | Fix `.env` first, then run auth. Auth requires `XERO_CLIENT_ID` to work. |

**When diagnosis is `needs-auth` / `RUN_AUTH`:**
Tokens are missing or expired. Run auth.

**Running auth:**
Tell the user to run `bun run xero-cli auth` in their terminal (it opens a browser for OAuth2 and requires human interaction -- do NOT run it via Bash tool). Once they confirm auth is complete, verify with `bun run xero-cli status --json` and continue the workflow.

**Auth resilience notes:**
- Config resolution is cwd-dependent (`process.cwd()`) - always run xero-cli from the project root where `.xero-config.json` lives
- Re-verify `status --json` before starting reconcile batches, not just at session start
- If config disappears mid-session, tokens persist in macOS Keychain - only the config file needs re-creation via `auth`
- Confirm auth actually completed by checking `status --json` shows `diagnosis: "ok"` with the `api` check passing (not just config/keychain checks)

**Fallback:** If `error.context.checks` is absent (older CLI version), use `--debug` for detailed stderr output showing individual check results.

### BankTransactionID Immutability

BankTransactionID is an opaque key. Carry it unchanged from the `transactions` fetch through proposal, review, and execute.

- NEVER reconstruct IDs from display fields (Contact name, amount, date)
- If dropping a transaction from a proposal, drop the entire entry
- If an ID is not in the current unreconciled set, the CLI rejects it

### Cross-Command Auth Recovery

Read commands (`transactions`, `accounts`, `history`, `invoices`) produce output valid for the duration of Claude's context window. Re-auth does NOT invalidate previously fetched data.

If `reconcile` fails with `E_UNAUTHORIZED` mid-workflow:
1. Run `bun run xero-cli auth`
2. Re-run `reconcile` with the same stdin (idempotent resume via state file)
3. Do NOT re-fetch transactions -- data in context is still valid

### Invoice Amount/CurrencyCode Derivation

For invoice matches, derive:
- `Amount` from the BankTransaction's `Total` field
- `CurrencyCode` from the BankTransaction's `CurrencyCode` field

Both fields are required in the reconcile input. If the BankTransaction currency does not match the Invoice currency, flag for manual review.

### Contact Name Normalization

Bank descriptions are inconsistent (e.g., "GITHUB INC" vs "GITHUB.COM" vs "GH *GITHUB"). When matching against history:

- Strip common suffixes: PTY LTD, INC, LLC, CORP, LIMITED, P/L
- Normalize whitespace (collapse multiple spaces, trim)
- Case-insensitive comparison
- If match confidence is low, present to user for review rather than assuming

### Reconciliation Pipeline

Statement Lines (Finance API) and Bank Transactions (Accounting API) are **different resources**. The xero-cli `reconcile` command operates on **Bank Transactions** from the Accounting API. Do not confuse these.

**End-to-end pipeline:**

1. **Preflight** - `status --json` - confirm auth, config, API connectivity
2. **Load accounts** - `accounts --json --fields Code,Name,Type` - chart of accounts for categorization
3. **Load history** - `history --since YYYY-MM-DD --json --fields Contact,AccountCode,Count,AmountMin,AmountMax` - past reconciliation patterns
4. **Fetch unreconciled** - `transactions --unreconciled --json --fields BankTransactionID,Total,Contact.Name,Date,Type --limit 50` - the items to reconcile
5. **Match** - use history patterns to assign AccountCode to each BankTransactionID
6. **Reconcile** - pipe `[{"BankTransactionID":"...","AccountCode":"..."}]` into `reconcile --dry-run --json` first, then `--execute`

**Critical rules:**
- `reconcile` input MUST use `BankTransactionID` from the `transactions` command output (Accounting API UUIDs)
- Do NOT use statement line IDs, invoice line IDs, or any other identifier
- Do NOT add `TaxType` to reconcile input - the CLI derives it internally from the transaction type
- For account-code reconciliation, only `BankTransactionID` and `AccountCode` columns are needed

**Common mistakes:**
- Using Finance API statement line IDs instead of Accounting API BankTransactionIDs
- Adding TaxType to the reconcile payload (causes validation errors or wrong tax treatment)
- Including extra CSV columns that the CLI does not expect

### Token Budget

Never load all transactions + full history + full accounts into a single prompt. Use progressive loading:

1. `accounts --json --fields Code,Name,Type` (~2K tokens)
2. `history --since YYYY-MM-DD --json --fields Contact,AccountCode,Count,AmountMin,AmountMax` (~4K tokens)
3. `transactions --unreconciled --json --fields BankTransactionID,Total,Contact.Name,Date,Type --limit 50` (~5K tokens per chunk)
4. Match each chunk against history patterns, assign AccountCode per BankTransactionID
5. Accumulate proposals across chunks
6. Present summary to user, then `reconcile --dry-run --json`, then `--execute`

Target: <20K tokens per analysis step.
