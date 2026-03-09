# Input Schemas

Machine-readable contract summary for `xero-cli` write inputs.

## Reconcile JSON Input

Top-level shape:

```json
[
  {
    "BankTransactionID": "11111111-1111-1111-1111-111111111111",
    "AccountCode": "400"
  }
]
```

Constraints:

- Input must be a JSON array
- Minimum items: `1`
- Maximum items: `1000`
- `BankTransactionID` must match UUID shape
- `AccountCode` and `InvoiceID` are mutually exclusive
- One of `AccountCode` or `InvoiceID` is required
- Duplicate `BankTransactionID` values are rejected for the whole payload

Per-item fields:

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `BankTransactionID` | string | yes | UUID-shaped Xero bank transaction ID |
| `AccountCode` | string | conditional | 1-10 alphanumeric chars |
| `InvoiceID` | string | conditional | UUID-shaped Xero invoice ID |
| `Amount` | number | invoice only | Positive number, required with `InvoiceID` |
| `CurrencyCode` | string | invoice only | Non-empty, required with `InvoiceID` |

## Reconcile CSV Input

Supported columns:

- `BankTransactionID` required
- `AccountCode` optional
- `SuggestedAccountCode` optional fallback when `AccountCode` is absent
- `InvoiceID` optional
- `Amount` optional unless using `InvoiceID`
- `CurrencyCode` optional unless using `InvoiceID`

Rules:

- CSV path must stay within the repo working directory
- CSV path must use `.csv` extension
- CSV file must not be a symlink
- Empty files are rejected
- Invalid `Amount` values return `E_USAGE`

## Source of Truth

Runtime validation lives in `src/xero/reconcile/types.ts` and
`src/xero/reconcile/input.ts`.
