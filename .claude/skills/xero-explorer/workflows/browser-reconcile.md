# Workflow: Browser-Based Reconciliation

Orchestrator workflow for Opus. Dispatches `/browse`
(`browser-automation:ba-browse`) to execute pre-validated reconciliation
actions on the Xero Reconcile UI.

**Throughput note:** reconcile is single-worker only. The legacy
parallel worker fan-out is retired because `/browse` enforces the
same-domain concurrency rule for `go.xero.com`. Track future restoration
in project memory rather than reintroducing `worker-N` sessions here.

## Architecture

```
Opus (orchestrator)                    /browse + browser-agent (executor)
┌──────────────────────┐               ┌──────────────────────────────┐
│ Build queue-backed   │               │ go-xero canonical domain     │
│ batch instructions   │  dispatch →   │ target flows + selectors     │
│ Validate bank rules  │               │ + playbooks/scripts          │
│ Track progress       │  ← report     │                              │
│ Show ADHD UX         │               │ Fills, clicks OK, reports    │
└──────────────────────┘               └──────────────────────────────┘
```

**Opus decides.** `/browse` executes. No financial reasoning lives in
the browser layer.

## Prerequisites

1. **Post queue ready:** `data/.post-queue-fy{YY}-q{N}.json` exists with all APPROVE'd items
2. **Browser session active:** `/browse go.xero.com healthcheck`
   returns `Status: SUCCESS`
3. **Xero logged in:** User is authenticated in the Xero browser session
4. **Bank account ID known:** From `.xero-config.json` or seal

## Variables

```bash
Q=4          # Quarter number (1-4)
FY=25        # Two-digit financial year
QUEUE="data/.post-queue-fy${FY}-q${Q}.json"
BANK_ACCOUNT_ID="..."  # From .xero-config.json or seal
BATCH_SIZE=3  # Lines per /browse dispatch (configurable)
```

## Orchestration Loop

### Step 1: Verify browser state

```text
Skill("browser-automation:ba-browse", "go.xero.com healthcheck")
```

If `NEEDS_HUMAN`, relay the `human_action` from the report and resume
with the same `resume_run_id` after Nathan re-authenticates.

### Step 2: Build the next visible batch

Review the headed Xero Reconcile page and extract from each visible
statement line:
- Date
- Description (bank narrative)
- Amount (Spent or Received)
- Whether a bank rule pre-filled the form (Who/What values, blue OK button)

### Step 3: Lookup and validate (BATCH_SIZE lines)

For each visible line (up to BATCH_SIZE), run the lookup script:

```bash
python3 scripts/reconcile-browser-lookup.py "$QUEUE" \
  --amount 18.30 --date 2025-04-01 --desc "TRIALTO"
```

Then determine the action:

| Condition | Action |
|-----------|--------|
| No queue match (different quarter) | Skip -- don't include in batch |
| Empty form | `FILL Who="contact" What="code"` |
| Bank rule + account code matches queue | `CLICK_OK` |
| Bank rule + account code MISMATCHES queue | `CLEAR_AND_FILL What="correct_code"` |
| Invoice match tab (teal highlight) | `CLICK_OK` |

**Bank rule validation is Opus's job.** Read the pre-filled account code from the screenshot, compare against queue data. Only send `CLICK_OK` if exact match.

### Step 4: Dispatch `/browse`

Dispatch the canonical `go-xero` batch executor:

```text
Skill(
  "browser-automation:ba-browse",
  "go.xero.com reconcile-batch BATCH_SIZE=3 LINE_1=CLICK_OK LINE_2='FILL Who=\"KMART 1147 CHADSTONE AU\" What=\"911\"' LINE_3='CLEAR_AND_FILL What=\"485\"'"
)
```

The payload should stay ordered and explicit. `/browse` owns the DOM
interaction details and returns a canonical managed-domain report.

### Step 5: Verify and continue

Parse the canonical report:
- Check the new reconcile count dropped by the expected amount (from `findings.reconcile_count`)
- If `status: NEEDS_HUMAN`, relay `resume_run_id`, `human_action`,
  and `screenshot_path` to the user and wait for re-login
- If any lines reported `SKIPPED`, investigate before sending the next
  batch
- Use a fresh visual check before assembling the next sequential batch
- Show progress (see ADHD UX below)

### Step 6: Repeat

Continue Steps 2-5 until:
- All queue items are reconciled (count dropped by total queue size)
- OR the visible statement lines are all from a different quarter (dates outside range)

## Edge Cases

### Statement line not in queue
- From a different quarter or deliberately skipped
- Don't include in the agent batch -- leave it untouched

### Multiple items with same amount + date
- Use `--desc` parameter in lookup script for disambiguation
- If still ambiguous, process the first match

### Session expired
- `/browse` returns `Status: NEEDS_HUMAN` with a resume block
- Ask user to re-login in the headed Chrome window
- Resume from the returned `resume_run_id`

### Date boundary
- When visible lines cross into the next quarter (e.g., 1 Jul appears after 30 Jun items)
- Stop sending lines past the quarter boundary to the agent

## Progress Display (ADHD UX)

After each batch:

```
Browser reconcile Q4 FY25: 147/287 done (51%) | 1046→899
██████████░░░░░░░░░░ 51%
```

Milestones at 10%, 25%, 50%, 75%, 90%, 100%.

## Rollback

Browser-reconciled transactions cannot be un-reconciled via API. Use "Remove & Redo" in the Xero UI (Account Transactions -> select -> Remove & Redo).
