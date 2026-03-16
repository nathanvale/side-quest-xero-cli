# Workflow: Browser-Based Reconciliation

Orchestrator workflow for Opus. Dispatches `xero-reconcile-agent` (Haiku) to execute batches of pre-validated reconciliation actions on the Xero Reconcile UI.

## Architecture

```
Opus (orchestrator)                    Haiku (executor)
┌──────────────────────┐               ┌──────────────────────┐
│ Screenshot page      │               │ xero-reconcile-agent │
│ Parse visible lines  │  dispatch →   │   skills:            │
│ Lookup in queue      │               │   - browser-automation│
│ Validate bank rules  │  ← result     │   - xero-reconcile   │
│ Track progress       │               │                      │
│ Show ADHD UX         │               │ Finds refs, fills,   │
└──────────────────────┘               │ clicks OK, reports   │
                                       └──────────────────────┘
```

**Opus decides.** Haiku executes. No financial reasoning in the agent.

## Prerequisites

1. **Post queue ready:** `data/.post-queue-fy{YY}-q{N}.json` exists with all APPROVE'd items
2. **Browser session active:** `agent-browser --auto-connect get url` returns a valid page
3. **Xero logged in:** User is authenticated in the Xero browser session
4. **Bank account ID known:** From `.xero-config.json` or seal

## Variables

```bash
Q=4          # Quarter number (1-4)
FY=25        # Two-digit financial year
QUEUE="data/.post-queue-fy${FY}-q${Q}.json"
BANK_ACCOUNT_ID="..."  # From .xero-config.json or seal
BATCH_SIZE=3  # Lines per agent dispatch (configurable)
```

## Orchestration Loop

### Step 1: Navigate

```bash
agent-browser --auto-connect navigate "https://go.xero.com/BankRec/BankRec.aspx?accountID=$BANK_ACCOUNT_ID"
```

### Step 2: Screenshot and parse visible lines

Take a screenshot, read it, extract from each visible statement line:
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

### Step 4: Dispatch agent

Use the Agent tool to dispatch `xero-reconcile-agent`:

```
Agent(
  subagent_type="xero-reconcile-agent",
  model="haiku",
  prompt="""
BATCH_SIZE: 3

LINE 1: CLICK_OK
LINE 2: FILL Who="KMART 1147 CHADSTONE AU" What="911"
LINE 3: CLEAR_AND_FILL What="485"
"""
)
```

### Step 5: Verify and continue

Parse the agent's result. The agent returns both a legacy `RESULT:` line and a `BROWSER_REPORT`:
- Check the new reconcile count dropped by the expected amount (from `findings.reconcile_count`)
- If `status: NEEDS_HUMAN`, relay to user (session expired) and wait for re-login
- If any lines reported SKIPPED, investigate
- If `gotchas_discovered > 0`, the agent appended new issues to `docs/gotchas/browser-agent/go-xero.md`
- Take a fresh screenshot for the next batch
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
- Agent reports `SKIPPED | session expired`
- Ask user to re-login in the headed Chrome window
- Resume from current position (reconciled lines won't reappear)

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

## Parallel Mode (future)

For high-volume quarters, dispatch multiple agents with `--session` isolation:

```
Agent(session_id="xero-1", lines=[1,2,3])  ← page 1
Agent(session_id="xero-2", lines=[4,5,6])  ← page 2 (different browser tab)
```

Each agent uses `agent-browser --session {session_id}` instead of `--auto-connect`. Requires multiple Xero tabs open to different date-filtered views of the Reconcile page.

## Rollback

Browser-reconciled transactions cannot be un-reconciled via API. Use "Remove & Redo" in the Xero UI (Account Transactions -> select -> Remove & Redo).
