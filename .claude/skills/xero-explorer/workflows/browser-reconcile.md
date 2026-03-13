# Workflow: Browser-Based Reconciliation

Automate the Xero Reconcile UI via `agent-browser` to fill Who/What/Why and click OK for each statement line. This replaces the `reconcile-post` CLI approach which only created orphaned transactions.

## Prerequisites

1. **Post queue ready:** `data/.post-queue-fy{YY}-q{N}.json` exists with all APPROVE'd items
2. **Browser session active:** `agent-browser --headed get url` returns a valid page
3. **Xero logged in:** User is authenticated in the Xero browser session
4. **Bank account ID known:** From the quarter seal or config

## Variables

```bash
Q=4          # Quarter number (1-4)
FY=25        # Two-digit financial year
QUEUE="data/.post-queue-fy${FY}-q${Q}.json"
BROWSER_STATE="data/.browser-reconcile-state-fy${FY}-q${Q}.json"
BANK_ACCOUNT_ID="..."  # From .xero-config.json or seal
```

## How the Xero Reconcile UI Works

The Reconcile tab at `go.xero.com/BankRec/BankRec.aspx?accountID={id}` shows ~10 statement lines at a time.

**Each statement line has:**
- **Left panel:** Statement line details (date, description, amount -- from the bank feed)
- **Right panel:** Reconciliation form with tabs: Match | **Create** | Transfer | Discuss

**Create tab fields (what we use):**
- **Who** -- Contact name (autocomplete input)
- **What** -- Account code (searchable dropdown, shows "code - name")
- **Why** -- Description (free text, optional)
- **Tax Rate** -- auto-set based on account code (leave as default)

**Bank rule behavior:**
- Some lines have Xero bank rules that pre-fill Who/What/Why + show a blue **OK** button
- **NEVER blindly click OK.** Always read the pre-filled values and validate against our queue data first:
  - Contact name matches (or is an acceptable alias)
  - Account code matches exactly
- If validated -> click OK (fastest path)
- If mismatch -> clear fields and fill from queue data (treat as Path B)
- If empty -> fill from queue data (Path B)

## Automation Loop

### Step 1: Navigate to Reconcile page

```
agent-browser --headed navigate "https://go.xero.com/BankRec/BankRec.aspx?accountID=$BANK_ACCOUNT_ID"
```

### Step 2: Snapshot and parse visible statement lines

Take a screenshot to see the current batch of ~10 statement lines. From the left panels, extract:
- Date
- Description (bank narrative)
- Amount (positive = money in, negative = money out)

### Step 3: Match visible lines to queue items

For each visible statement line, find the corresponding queue item:

```bash
python3 scripts/reconcile-browser-lookup.py "$QUEUE" \
  --amount 18.30 --date 2025-04-01 --desc "TRIALTO"
```

**Matching priority:**
1. **Amount (exact)** + **Date (exact)** -- primary match
2. **Description contains payee substring** -- tiebreaker for same-amount-same-date duplicates
3. If no match found, the statement line is from a different quarter or was skipped -- leave it

### Step 4: Process each statement line

For each matched line, determine the action:

**Path A: Bank rule pre-filled -- VALIDATE FIRST**
1. Read the pre-filled Who (contact) and What (account code) from the form
2. Compare against our queue data for this statement line:
   - **Account code must match exactly** (e.g., queue says 6310, form shows 6310)
   - **Contact name must match** (exact or known alias -- e.g., "GitHub, Inc" vs "GITHUB")
3. If BOTH match -> click **OK** (fastest path, log as `method: "bank-rule-validated"`)
4. If EITHER mismatches -> **do NOT click OK**. Clear the fields and fall through to Path B
   - Log the mismatch: `"bank-rule rejected: expected 6310/GitHub, got 6420/GITHUB INC"`
   - This protects against stale or incorrect bank rules

**Path B: Fill from queue data**
1. Click the **Create** tab if not already active
2. Fill **Who**: Type the contact name in the Who input field
   - Wait for autocomplete dropdown to appear
   - Select the matching contact from the dropdown
   - If no autocomplete match, the typed name creates a new contact (acceptable)
3. Fill **What**: Type the account code number in the What dropdown
   - The dropdown filters as you type
   - Select the matching "code - name" option
4. Fill **Why** (optional): Type the description from queue data
5. **Before clicking OK:** Take a screenshot and visually confirm the filled values match the queue data
6. Click **OK**

**Path C: No match in queue**
- This statement line is from a different quarter, was skipped, or is a transfer
- Leave it untouched (do not click Options -> Skip)
- Move to the next visible line

### Step 5: Save progress after each OK

After each successful OK click:
1. Record the statementLineId as `reconciled` in the browser state file
2. The page will partially refresh (the reconciled line disappears)
3. Take a new screenshot to see the updated state

### Step 6: Handle page refresh

After all visible lines in a batch are processed:
- The page auto-refreshes with the next batch of ~10 lines
- If no more lines appear, the quarter is complete
- Take a screenshot to confirm

### Step 7: Repeat until done

Continue Steps 2-6 until:
- All queue items are marked as `reconciled` in the browser state
- OR the Reconcile page shows no more statement lines for the quarter's date range

## Field Filling Patterns

### Who (Contact) Input

```
# Using agent-browser fill on the Who input
agent-browser --headed fill @who-input-ref "Contact Name"
# Wait for autocomplete dropdown
agent-browser --headed screenshot
# Click the matching autocomplete suggestion
agent-browser --headed click @autocomplete-option-ref
```

**Gotcha:** Use `fill` not `type` for contact names -- `type` breaks on special characters and UUIDs. The autocomplete dropdown appears after a brief delay (~500ms).

### What (Account Code) Dropdown

```
# Click the What dropdown to open it
agent-browser --headed click @what-dropdown-ref
# Type the account code to filter
agent-browser --headed fill @what-search-ref "6310"
# Select the matching option ("6310 - Software & SaaS")
agent-browser --headed click @filtered-option-ref
```

### Why (Description) Input

```
agent-browser --headed fill @why-input-ref "Monthly subscription"
```

### OK Button

```
agent-browser --headed click @ok-button-ref
```

The OK button may be blue (bank rule pre-filled) or grey (manual fill). Both are clickable after fields are filled.

## Edge Cases

### Statement line not in queue
- From a different quarter, deliberately skipped, or a transfer between accounts
- **Action:** Leave untouched, move to next line

### Bank rule suggestion is wrong
- Pre-filled Who/What doesn't match our queue data
- **This is the dangerous case** -- clicking OK would reconcile with the wrong account/contact
- **Action:** Log the mismatch details, clear the fields, fill from queue data
- Clear by selecting the field and replacing the content
- After filling, verify the corrected values before clicking OK

### Multiple items with same amount + date
- Use description substring matching to disambiguate
- The lookup script handles this with `--desc` parameter
- If still ambiguous, process the first match and mark the ambiguity in state

### Transfer type items
- Transfers between bank accounts use the **Transfer** tab, not Create
- Identified by: queue item has a `transferAccountCode` field
- **Action:** Click Transfer tab, select the target account, click OK

### Session expired
- Xero redirects to login page after ~30 minutes of inactivity
- **Detection:** Screenshot shows login form instead of Reconcile page
- **Action:** Stop processing, save state, ask user to log in again
- Resume from saved state after re-authentication

### Unexpected modal or overlay
- Xero occasionally shows modals (subscription nag, feature announcement)
- **Action:** Dismiss the modal, take a fresh screenshot, continue

### Page shows no statement lines
- Either all lines are reconciled, or the date range filter excludes them
- **Action:** Check the date range filter on the page matches the quarter dates
- If correct and empty -> quarter reconciliation is complete

## Progress Tracking

### Browser State File

`data/.browser-reconcile-state-fy{YY}-q{N}.json`

```json
{
  "quarter": "Q4 FY25",
  "bankAccountId": "...",
  "startedAt": "2026-03-14T10:00:00+11:00",
  "totalItems": 287,
  "queuePath": "data/.post-queue-fy25-q4.json",
  "items": {
    "<statementLineId>": {
      "status": "reconciled",
      "reconciledAt": "2026-03-14T10:05:00+11:00",
      "method": "bank-rule" | "manual-fill",
      "contact": "GitHub",
      "accountCode": "6310"
    }
  },
  "savedAt": "2026-03-14T10:05:00+11:00"
}
```

**Status values:**
- `pending` -- in queue, not yet processed
- `reconciled` -- OK clicked successfully
- `skipped` -- not found on Reconcile page (already reconciled or different quarter)
- `errored` -- fill or click failed (retryable)

### Progress Display

After each batch, show progress:

```
Browser reconcile Q4 FY25: 47/287 done (16%) | batch 5 | ~24 min remaining
Last 10: GitHub, AWS, Stripe, Uber Eats, ...
```

## ADHD UX

- **Mission cap:** Default 50 items or 20 minutes per session
- **Progress bar:** Show after every OK click
- **Batch milestones:** Celebrate at 10%, 25%, 50%, 75%, 90%, 100%
- **Quick wins first:** Sort visible lines by whether they have bank rule matches (faster) before manual fills

## Error Recovery

If the browser automation fails mid-session:

1. State file has all progress up to the last successful OK
2. Resume by navigating back to the Reconcile page
3. The lookup script skips already-reconciled items
4. Statement lines that were successfully OK'd won't appear again on the page

## Verification

After completing a reconciliation session:

1. Check the Reconcile page -- should show fewer (or zero) unreconciled items for the quarter's date range
2. Navigate to Account Transactions to verify the reconciled entries
3. Compare browser state counts against the original queue item count
