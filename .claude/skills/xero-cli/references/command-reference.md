# Command Reference

All `xero-cli` commands, flags, and examples.

## Global Flags

| Flag | Purpose |
|------|---------|
| `--json` | JSON envelope on stdout (auto-enabled when stdout is not a TTY) |
| `--quiet` | Minimal single-line output |
| `--verbose` | Show info-level logs on stderr |
| `--debug` | Show debug-level logs on stderr (implies verbose) |
| `--events-url` | Send telemetry events to observability server URL |
| `--help` | Show help text |
| `--version` | Print CLI version and exit |

## Commands

### status

Preflight check for env, config, keychain, state file, lock file, audit dir, and API connectivity.

```bash
bun run xero-cli status --json
```

**Success:** `data.checks` array + `data.diagnosis: "ok"`.
**Error:** `error.context.checks` array + `error.context.diagnosis` + `error.context.nextAction`.

**Diagnosis values:**

| Diagnosis | nextAction | Meaning |
|-----------|-----------|---------|
| `ok` | `NONE` | All checks passed |
| `invalid-config` | `FIX_CONFIG` | Env var or config file issue (inspect `checks` to distinguish) |
| `needs-auth` | `RUN_AUTH` | Tokens missing or expired |
| `keychain-locked` | `UNLOCK_KEYCHAIN` | macOS Keychain locked |
| `keychain-denied` | `ALLOW_KEYCHAIN` | Keychain access denied |
| `api-error` | `RETRY` | Xero API unreachable |
| `fs-error` | `CHECK_FS` | State/lock/audit file error |

**Individual checks** (in `checks` array):

| Check | Validates |
|-------|----------|
| `env` | `XERO_CLIENT_ID` in `.env` |
| `config` | `.xero-config.json` exists and valid |
| `keychain` | OAuth tokens in macOS Keychain |
| `state_file` | Reconciliation state file integrity |
| `lock_file` | No stale lock |
| `audit_dir` | Audit directory exists |
| `api` | Xero Organisation API reachable |

Each check has `status` (`ok` | `warning` | `error`) and optional `message`.

### auth

OAuth2 PKCE flow. Starts a callback server on `localhost:5555` and opens a browser.

```bash
bun run xero-cli auth
bun run xero-cli auth --auth-timeout 120   # Custom timeout (default 300s)
```

**Headless mode:** When stdout is not a TTY or `XERO_HEADLESS=1`, emits two NDJSON lines:
1. `{"status":"data","schemaVersion":1,"data":{"authUrl":"https://login.xero.com/..."},"phase":"auth_url"}`
2. `{"status":"data","schemaVersion":1,"data":{"command":"auth","tenantId":"...","orgName":"..."},"phase":"result"}`

Parse as line-delimited JSON. The `phase` field discriminates the two outputs.

### transactions (alias: `tx`)

Pull bank transactions.

```bash
bun run xero-cli transactions --unreconciled --json
bun run xero-cli transactions --unreconciled --summary
bun run xero-cli transactions --unreconciled --json --page 1        # Server-side pagination (1-based)
bun run xero-cli transactions --unreconciled --json --limit 20      # Client-side limit
```

**Date filters** (mutually exclusive shortcuts):

```bash
bun run xero-cli transactions --since 2026-01-01 --until 2026-03-31 --json
bun run xero-cli transactions --this-quarter --json
bun run xero-cli transactions --last-quarter --json
```

**Conflict rules:** `--this-quarter` and `--last-quarter` cannot be combined with `--since` or `--until`. Combining them produces a usage error.

Note: `--summary` without an explicit date range defaults to the current quarter.

**Field projection:**

```bash
bun run xero-cli transactions --unreconciled --json --fields BankTransactionID,Total,Contact.Name,Date
```

### accounts (alias: `acct`)

Pull chart of accounts.

```bash
bun run xero-cli accounts --json
bun run xero-cli accounts --type REVENUE --json
bun run xero-cli accounts --json --fields Code,Name,Type
```

### history (alias: `hist`)

Pull reconciliation history. `--since` is required.

```bash
bun run xero-cli history --since 2025-01-01 --json
bun run xero-cli history --since 2025-01-01 --contact "Acme Corp" --json
bun run xero-cli history --since 2025-01-01 --account-code 400 --json
bun run xero-cli history --since 2025-01-01 --json --fields Contact,AccountCode,Count,AmountMin,AmountMax
```

### invoices (alias: `inv`)

Pull invoices. Default filter: `Status=="AUTHORISED"` (outstanding only). Specifying any filter overrides this default.

```bash
bun run xero-cli invoices --json
bun run xero-cli invoices --status PAID --json
bun run xero-cli invoices --type ACCREC --json
bun run xero-cli invoices --status AUTHORISED --type ACCREC --json
bun run xero-cli invoices --json --fields InvoiceID,Contact.Name,Total,AmountDue,CurrencyCode
```

### reconcile (alias: `rec`)

Execute reconciliation. **Writes only with `--execute`.** Without `--execute` (or with `--dry-run`), reconcile validates input but does not write.

Max 1000 items per invocation. Chunk larger sets.

**From stdin (JSON array):**

```bash
echo '[
  { "BankTransactionID": "...", "AccountCode": "400" },
  { "BankTransactionID": "...", "InvoiceID": "...", "Amount": 1200.00, "CurrencyCode": "AUD" }
]' | bun run xero-cli reconcile --execute --json
```

**From CSV:**

```bash
bun run xero-cli reconcile --from-csv path/to/file.csv --execute --json
```

**Input rules:**
- `AccountCode` and `InvoiceID` are mutually exclusive per entry
- One of `AccountCode` or `InvoiceID` is required per entry
- Duplicate `BankTransactionID` values are rejected (entire payload)
- Empty array is rejected

**CSV column names:**
- `BankTransactionID` (required) - the transaction to reconcile
- `AccountCode` - account code for categorization
- `SuggestedAccountCode` - accepted as fallback when `AccountCode` column is absent
- `InvoiceID` - invoice to match (mutually exclusive with AccountCode)
- `Amount` - required when using InvoiceID
- `CurrencyCode` - required when using InvoiceID

## --fields Support

Available on all list commands: `accounts`, `transactions`, `history`, `invoices`. Accepts comma-separated dot-path field names (e.g., `Contact.Name`, `LineItems.AccountCode`). Fields must match `[A-Za-z0-9_.]`.

## Command Aliases

| Alias | Full command |
|-------|-------------|
| `tx` | `transactions` |
| `acct` | `accounts` |
| `inv` | `invoices` |
| `rec` | `reconcile` |
| `hist` | `history` |

## Reconciliation Pipeline Example

Complete command chain from preflight through execute:

```bash
# Step 1: Preflight -- confirm auth and API connectivity
bun run xero-cli status --json
# -> data.diagnosis: "ok", data.checks[].status all "ok"

# Step 2: Load chart of accounts (for categorization reference)
bun run xero-cli accounts --json --fields Code,Name,Type
# -> data.items[]: { Code, Name, Type }

# Step 3: Load reconciliation history (past patterns)
bun run xero-cli history --since 2025-07-01 --json --fields Contact,AccountCode,Count,AmountMin,AmountMax
# -> data.items[]: { Contact, AccountCode, Count, AmountMin, AmountMax }

# Step 4: Fetch unreconciled bank transactions (Accounting API)
bun run xero-cli transactions --unreconciled --json --fields BankTransactionID,Total,Contact.Name,Date,Type --limit 50
# -> data.items[]: { BankTransactionID, Total, Contact: { Name }, Date, Type }
# NOTE: BankTransactionID is the key -- carry it unchanged into reconcile input

# Step 5: Match and build proposal (agent logic)
# Use history patterns to assign AccountCode to each BankTransactionID

# Step 6a: Dry-run validation
echo '[
  { "BankTransactionID": "abc-123", "AccountCode": "400" },
  { "BankTransactionID": "def-456", "AccountCode": "461" }
]' | bun run xero-cli reconcile --dry-run --json
# -> Validates input without writing to Xero

# Step 6b: Execute
echo '[...]' | bun run xero-cli reconcile --execute --json
# -> Writes to Xero, returns results with status per item
```

**Data flow:** `transactions` output provides `BankTransactionID` -> agent matches with `history` patterns -> assigns `AccountCode` -> pipes into `reconcile`. The `BankTransactionID` must flow unchanged from step 4 through step 6.

## CSV Clarification

For account-code reconciliation (the common case), only two CSV columns are needed:

```csv
BankTransactionID,AccountCode
abc-123,400
def-456,461
```

`TaxType` is **not** a valid CSV column - the CLI derives tax type internally from the transaction type. Adding it will cause unexpected behavior. The full CSV column list (`InvoiceID`, `Amount`, `CurrencyCode`) is only needed for invoice-matching reconciliation.
