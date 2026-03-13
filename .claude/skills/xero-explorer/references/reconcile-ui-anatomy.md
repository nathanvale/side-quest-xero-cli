# Xero Reconcile UI Anatomy

Reference for the DOM structure of the Xero Reconcile page, based on actual browser inspection.

## Page URL

```
https://go.xero.com/BankRec/BankRec.aspx?accountID={BANK_ACCOUNT_ID}
```

## Page Layout

The Reconcile page shows a list of unreconciled bank statement lines. Each line is a horizontal row with two panels:

### Left Panel: Statement Line Details

- **Date** -- transaction date from the bank feed
- **Description** -- bank narrative (e.g., "GITHUB.COM", "UBER EATS", "Direct Debit")
- **Spent/Received** -- amount column (negative = spent, positive = received)
- **Source** -- bank feed source indicator

### Right Panel: Reconciliation Form

Tabs across the top of the right panel:

| Tab | Purpose | When to use |
|-----|---------|-------------|
| **Match** | Match to existing invoices/bills/transactions | When a matching invoice exists |
| **Create** | Create a new transaction and reconcile in one step | **Primary path** -- our workflow |
| **Transfer** | Record a transfer between bank accounts | For inter-account transfers |
| **Discuss** | Add a comment/note (doesn't reconcile) | Rarely used |

### Create Tab Fields

When the **Create** tab is selected:

1. **Who** -- Contact name input
   - Autocomplete text field
   - Typing triggers a dropdown of matching contacts
   - Selecting from dropdown fills the contact
   - Typing a new name creates a new contact on OK

2. **What** -- Account code dropdown
   - Searchable select/dropdown
   - Type a code number (e.g., "6310") to filter
   - Shows "code - Account Name" in dropdown options
   - Selecting sets the account for the transaction

3. **Why** -- Description text input
   - Free text field
   - Optional but useful for transaction description
   - Visible in transaction reports

4. **Tax Rate** -- Tax dropdown
   - Auto-populated based on the selected account code
   - Usually "GST on Expenses" or "BAS Excluded"
   - Leave as default unless specifically needed

5. **OK Button**
   - Blue when bank rule pre-filled the form
   - Becomes clickable after Who + What are filled
   - Clicking OK creates the transaction AND reconciles it to the statement line

### Bank Rules

When Xero has a matching bank rule for a statement line:
- The Create tab fields are pre-filled (Who, What, Why)
- The OK button is blue/highlighted
- A "Bank Rule" label or indicator may appear
- If the pre-fill matches our queue data, just click OK

### Options Dropdown

Each statement line may have an **Options** button or dropdown with:
- **Create** -- same as Create tab
- **Find & Match** -- opens a search to match against existing transactions
- **Transfer** -- same as Transfer tab
- **Discuss** -- same as Discuss tab

### Batch Size

- The page shows ~10 statement lines at a time
- After clicking OK on a line, it disappears from the list
- New lines may slide into view or the page refreshes
- Scrolling down may reveal more lines (lazy loading)

### Auto-Reconcile Banner

Sometimes Xero shows a banner at the top:
- "X items have been auto-matched" with an "OK" button to confirm all
- These are bank rule matches that Xero is confident about
- If they align with our data, clicking this banner OK is the fastest path

### Date Range Filter

The page may have date range controls at the top:
- Ensure the date range covers the target quarter
- If not, adjust before processing

## Navigation After OK

After clicking OK on a statement line:
1. The line animates/slides away
2. Remaining lines shift up
3. If all visible lines are done, the page refreshes with the next batch
4. The "X items to reconcile" counter decrements

## Session Timeout

- Xero sessions timeout after ~30 minutes of inactivity
- When expired: page redirects to `login.xero.com`
- **Detection:** URL changes away from `go.xero.com/BankRec/`
- **Recovery:** User must log in again, then navigate back to Reconcile page
