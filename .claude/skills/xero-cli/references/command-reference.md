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

Returns `diagnosis` field: `ok`, `needs-auth`, `invalid-config`, `api-error`, `keychain-locked`, `keychain-denied`, `fs-error`. Also returns a `nextAction` hint.

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
