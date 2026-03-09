# Matching Rules Reference

Categorization rules, contact lookup, vendor research, and POST body templates for reconciliation.

> Canonical rules for `/xero-explorer` as of 2026-03-05.

Changelog:
- 2026-03-10: added CLI history lookup as primary account code source
- 2026-03-09: extracted deterministic confidence weights to `confidence-weights.json`

## Sync Contract

Source of truth for matching logic is this file:
- `/xero-explorer` references/matching-rules.md

When changing matching logic, include:
1. Updated date in this header note
2. A short changelog line in this file
3. Reconcile test matrix spot-check for confidence band behavior

## Contact Name Normalization

Bank descriptions are inconsistent (e.g., "GITHUB INC" vs "GITHUB.COM" vs "GH *GITHUB"). Apply:

1. Strip common suffixes: PTY LTD, INC, LLC, CORP, LIMITED, P/L
2. Strip common prefixes: SQ *, CRD, PP *, SP *
3. Normalize whitespace (collapse multiple spaces, trim)
4. Case-insensitive comparison
5. If match confidence is low, mark as **Needs input** rather than assuming

## Reconciliation History Lookup (primary source)

The CLI `history` command queries Xero's Accounting API for past reconciled
transactions grouped by contact. This is the **most reliable source** for
account codes because it returns the actual codes used in Xero, unlike
`bank-transactions.ndjson` which often has empty `LineItems`.

### Single contact lookup

```bash
bun run xero-cli history --since 2024-01-01 --contact "Body Fit Training Sydney" --json
```

Returns: `AccountCode`, `Count`, `AmountMin`, `AmountMax`, `Type`, `MostRecentDate`.

### Bulk history export (all contacts)

```bash
bun run xero-cli history --since 2024-01-01 --json
```

Returns all contacts with reconciliation history. Use this to build a
comprehensive lookup during Phase A setup.

### Account code lookup by code

```bash
bun run xero-cli history --since 2024-01-01 --account-code 485 --json
```

Useful for verifying what else is assigned to a given code.

### Custom fields

```bash
bun run xero-cli history --since 2024-01-01 --json --fields Contact,AccountCode,Count,AmountMin,AmountMax
```

### When to use history lookup

- **Phase A setup:** Run bulk history export and cache results for the session
- **Round 1 classification:** History match = highest confidence signal
- **Round 2 research:** Check history before WebSearch -- vendor may have been
  reconciled under a different payee spelling
- **Dispute resolution:** When unsure about a code, show the user their own
  history: "You've assigned Body Fit to 485 (Subscriptions) 38 times"

### History cache file

Save bulk history output during Phase A for fast lookups:

```bash
bun run xero-cli history --since 2024-01-01 --json > data/.xero-history-cache.json
```

This is a session artifact (not quarter-scoped). Refresh if older than 7 days.

## Contact Lookup from Bank Transactions (secondary source)

Statement lines only have a `payee` field (plain text). Build a contact lookup from historical bank transactions for ContactID matching:

```bash
python3 scripts/xero-contact-lookup.py summary data/bank-transactions.ndjson
python3 scripts/xero-contact-lookup.py build data/bank-transactions.ndjson data/.xero-contact-lookup.json
```

The generated lookup file includes:
- `lookup[normalized_name] -> { ContactID, ContactName, AccountCode, Count, AmountMin, AmountMax, AccountCodeCounts }`
- `stats` coverage fields so you can detect weak historical data (for example, missing `LineItems.AccountCode`).

**Note:** `bank-transactions.ndjson` often has empty `LineItems` (no account
codes). Use the CLI `history` command as the primary account code source.
This lookup is still valuable for **ContactID resolution** (linking to existing
Xero contacts in POST bodies).

**Match found** = reuse ContactID (Xero links to existing contact).
**No match** = use `payee` as `Contact.Name` in the POST body (Xero auto-creates the contact).

## Confidence Classification

**Decision tree for each statement line:**

1. Normalized payee matches contact lookup AND amount within historical range -- **High confidence** (Round 1)
2. Normalized payee matches contact lookup BUT amount outside range -- **Medium confidence** (Round 1, but flag the amount anomaly)
3. No contact match, but payee has identifiable business name -- **Research candidate** (Round 2)
4. Generic description ("DIRECT DEBIT", "TRANSFER", "CASH") -- **Unknown** (Round 3)
5. No match, no identifiable name -- **Unknown** (Round 3)

**Amount range matching:** If transaction amount is outside historical `AmountMin`/`AmountMax` for a contact (with 20% tolerance), reduce confidence even if contact name matches.

### Confidence scoring contract (for deterministic grouping)

Use this scoring model to avoid drift. The machine-readable source of truth is
`references/confidence-weights.json`.

- Base score starts at `0`
- `+80` CLI history match (account code confirmed from Xero reconciliation history)
- `+70` exact normalized payee match in contact lookup (ContactID only, no account code)
- `+15` amount within historical range (or 20% tolerance)
- `+10` recurrence count >= 3 (from CLI history `Count` field)
- `+10` stable historical account code (single code in history, no conflicts)
- `-25` amount anomaly outside tolerance
- `-20` generic payee tokens (`DIRECT DEBIT`, `TRANSFER`, `PAYMENT`, `CASH`)
- `-15` no contact history + ambiguous vendor

**Priority of account code sources:**

1. CLI `history` command (highest -- actual reconciled account codes from Xero)
2. Contact lookup `AccountCodeCounts` (if LineItems were populated)
3. AI classification / WebSearch research (lowest)

Final banding:

- `High` confidence: score `>= 75`
- `Medium` confidence: score `45-74`
- `Low` confidence: score `< 45`

Batch size policy tied to confidence band:

- `High`: max 25 approvals per group
- `Medium`: max 12 approvals per group
- `Low`: max 5 approvals per group or one-by-one in rapid-fire

## Invoice Matching (RECEIVE Transactions)

For positive-amount statement lines (RECEIVE):

- `Amount` comes from the statement line's `amount` field (not the Invoice)
- `CurrencyCode` comes from the statement line or defaults to AUD
- If statement line currency does not match Invoice currency, flag for manual review
- Match on normalized payee + approximate amount

## Immutability Rules

- Carry `statementLineId` unchanged through the entire pipeline
- NEVER reconstruct IDs from display fields (payee, amount, date)
- If dropping a transaction from the proposal, drop the entire entry

## Unknown Vendor Research Protocol

Used in Round 2 to research unrecognized payees.

### Search term extraction

1. Strip Square prefix "SQ *", card suffixes "Card xx1234"
2. Strip special characters: `" ' \ / & | < > % # @ ! $ ^ * ( ) { } [ ]`
3. Strip control characters (newlines, carriage returns, null bytes, Unicode U+0000-U+001F, U+007F-U+009F)
4. Truncate to 80 characters
5. Never include dollar amounts or account codes

### Search strategy

1. First search: `"{vendor name} {location if present} business Australia"`
2. If inconclusive, second search: `"{vendor name} what is"`
3. Maximum 2 search attempts per vendor
4. Maximum 30 external searches per session

### Caching

Cache results keyed by **normalized** vendor name (lowercased, prefixes stripped, whitespace collapsed):

```json
{
  "mokosz elwood": {
    "normalizedKey": "mokosz elwood",
    "query": "Mokosz Elwood business Australia",
    "result": "Cafe/restaurant in Elwood, VIC",
    "suggestedCode": "6420",
    "confidence": "medium",
    "searchedAt": "2026-03-05T10:35:00"
  }
}
```

### Classification

- **Confident** -- clear business type, maps to obvious account code
- **Partial** -- "low confidence, your call" -- some info but ambiguous
- **No result** -- promote to Round 3 (truly unknown)

Group researched items by suggested account code for batch presentation.

### Security

Consent prompt at Round 2 start: "Round 2 will search for N vendor names externally via WebSearch. OK to proceed?" Vendor names are real financial data being sent to third-party services.

## POST Body Templates

For each approved statement line, POST to Accounting API `/BankTransactions`.

### SPEND Transaction (negative amount)

```json
{
  "Type": "SPEND",
  "Contact": {
    "ContactID": "<from contact lookup, omit if no match>",
    "Name": "<payee from statement line>"
  },
  "LineItems": [{
    "Description": "<payee from statement line>",
    "Quantity": 1,
    "UnitAmount": "<abs(amount)>",
    "AccountCode": "<approved account code>",
    "TaxType": "INPUT"
  }],
  "BankAccount": { "AccountID": "<BANK_ACCOUNT_ID for selected tenant>" },
  "Date": "<postedDate from statement line>",
  "CurrencyCode": "<statementLine.currencyCode || \"AUD\">",
  "IsReconciled": true
}
```

### RECEIVE Transaction (positive amount)

```json
{
  "Type": "RECEIVE",
  "Contact": {
    "ContactID": "<from contact lookup, omit if no match>",
    "Name": "<payee from statement line>"
  },
  "LineItems": [{
    "Description": "<payee from statement line>",
    "Quantity": 1,
    "UnitAmount": "<abs(amount)>",
    "AccountCode": "<approved account code>",
    "TaxType": "OUTPUT"
  }],
  "BankAccount": { "AccountID": "<BANK_ACCOUNT_ID for selected tenant>" },
  "Date": "<postedDate from statement line>",
  "CurrencyCode": "<statementLine.currencyCode || \"AUD\">",
  "IsReconciled": true
}
```

### TaxType Rules

- `INPUT` for SPEND (purchases/expenses)
- `OUTPUT` for RECEIVE (income/revenue)
- Wrong type returns: "The TaxType code cannot be used with account code."

### Auto-Matching Caveat

When a BankTransaction is POSTed with `IsReconciled: true` and the amount + date + bank account align with an existing statement line, Xero auto-matches them. This is the mechanism that makes the statement line show as reconciled in the Xero UI.

This is the conversion/migration pattern. Xero officially declined the feature request for true API-based statement reconciliation (matching a specific statement line by ID).
