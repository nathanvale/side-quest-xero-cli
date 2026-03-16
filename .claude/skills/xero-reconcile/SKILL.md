---
name: xero-reconcile
description: Xero Reconcile page DOM recipes -- field filling, OK clicking, ref discovery, and mismatch correction. Used by xero-reconcile-agent.
user-invocable: false
---

# Xero Reconcile Page Recipes

DOM patterns and commands for the Xero Reconcile page at `go.xero.com/BankRec/BankRec.aspx`.

## Connection

Use `agent-browser --auto-connect` for ALL commands by default (connects to user's existing Chrome).

**Gotchas:** The agent loading this skill should check project gotchas at `docs/gotchas/browser-agent/go-xero.md` before starting.

For **parallel runs**, use `--session {session_id}` on every command instead of `--auto-connect`:

```bash
agent-browser --session xero-1 snapshot 2>&1 | head -80
agent-browser --session xero-1 click @REF
```

Each `--session` gets an isolated browser process. The orchestrator assigns session IDs.

If a session is not yet connected, use the `browser-automation` skill's Chrome Connection Protocol to launch and connect. If auth is needed (session expired, fresh session), use the `browser-automation` skill's Auth Flows.

## Ref Discovery

Refs (`@eN`) change after every DOM mutation. Always take a fresh snapshot before interacting:

```bash
agent-browser --auto-connect snapshot 2>&1 | head -80
```

Find elements by **role + text**, never by memorised ref numbers:

| Element | Find by |
|---------|---------|
| Who input | Placeholder text "Name of the contact..." |
| What dropdown | Text "Choose the account..." |
| OK button | Button with text "OK" |
| Why input | Placeholder "Enter a description..." |

When multiple statement lines are visible, each has its own set of Who/What/OK elements. Match to the correct line by position in the snapshot (first line = first set of fields).

## Action Recipes

### CLICK_OK (bank rule pre-validated)

```bash
agent-browser --auto-connect snapshot 2>&1 | head -60
# Find the first OK button ref
agent-browser --auto-connect click @REF
```

After clicking, the line disappears. Take a new snapshot before the next line.

### FILL (manual entry)

```bash
# 1. Find Who input ref
agent-browser --auto-connect snapshot 2>&1 | head -80
agent-browser --auto-connect fill @WHO_REF "Contact Name Here"

# 2. Find What dropdown ref (fresh snapshot -- refs changed after fill)
agent-browser --auto-connect snapshot 2>&1 | head -80
agent-browser --auto-connect type @WHAT_REF "CODE"
agent-browser --auto-connect press Enter

# 3. Find OK button (fresh snapshot again)
agent-browser --auto-connect snapshot 2>&1 | head -60
agent-browser --auto-connect click @OK_REF
```

**Critical:**
- `fill` for Who -- sets value directly, no autocomplete needed
- `type` for What -- triggers Xero's React dropdown filter. Then `press Enter` selects the top match
- Never use `fill` for What -- it sets the value but Xero's dropdown doesn't activate

### CLEAR_AND_FILL (bank rule mismatch)

When the What field is pre-filled with a wrong account code:

```bash
# 1. Find What dropdown ref (it shows the wrong code)
agent-browser --auto-connect snapshot 2>&1 | head -80
agent-browser --auto-connect fill @WHAT_REF ""
agent-browser --auto-connect type @WHAT_REF "CORRECT_CODE"
agent-browser --auto-connect press Enter

# 2. Find OK button
agent-browser --auto-connect snapshot 2>&1 | head -60
agent-browser --auto-connect click @OK_REF
```

## Page Behavior

- ~10 statement lines visible at a time
- After clicking OK, the line animates away and remaining lines shift up
- The "Reconcile (N)" tab header shows the current count -- read this after each OK
- If all visible lines are processed, the page auto-refreshes with the next batch

## Session Timeout Detection

If a snapshot shows a login form or the URL changes away from `go.xero.com/BankRec/`, the session has expired. Stop immediately and report:

```
SKIPPED | session expired -- user must re-login
```

## Counting

After processing all lines in the batch, take a screenshot:

```bash
agent-browser --auto-connect screenshot 2>&1 | head -5
```

The reconcile count appears in the tab: "Reconcile (759)". Report this number.
