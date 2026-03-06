---
date: 2026-03-03
topic: xero-explorer-reconcile
---

# Xero Explorer Reconcile -- Brainstorm

## What We're Building

An improved reconciliation workflow for the `xero-explorer` skill that makes processing ~300 monthly bank transactions for BAS less painful. Designed for ADHD -- minimize cognitive load, maximize dopamine through visible progress, and never lose your place.

## Why This Matters

Nathan has done this manually for 10 years. Monthly BAS means ~300 transactions to categorize. Most are obvious/repetitive, some need research, a few are total mysteries. The current process is mind-numbingly boring and the all-at-once wall of transactions kills motivation.

## Key Decisions

### Two reconciliation modes

User picks at invocation time via the skill's number routing:

1. **Batch approval** -- group transactions by category, show all line items (numbered), approve the group at once. Efficiency comes from bulk approval, not hiding items.
2. **Rapid-fire** -- one transaction at a time with smart defaults pre-filled. User mostly just hits enter. Good for the tricky ones or when you're in the zone.

### Three rounds (confidence descending)

Get the easy wins first, tackle harder stuff when the pile is already smaller:

1. **Round 1: Auto-matched (high confidence)** -- Xero already knows these from history, or our pattern matching is confident. Contact name normalization, invoice matching, historical patterns. Bulk of the volume.
2. **Round 2: AI-researched (medium confidence)** -- unknown vendors where we did detective work via WebSearch/Firecrawl. Present evidence + suggested account code so Nathan can approve with confidence, not guess. Group by suggested category.
3. **Round 3: Truly unknown (low confidence)** -- generic descriptions ("DIRECT DEBIT", "TRANSFER"), no useful research results. These need Nathan's brain. Present with maximum context (similar historical amounts, possible matches).

### Every item numbered

All line items get numbers regardless of mode. Enables exception handling: "approve all except 7 and 23."

```
SOFTWARE/SAAS (42 items, $2,340.50) -> 6310

  1. GITHUB          $9.00    2026-02-01
  2. GITHUB          $9.00    2026-01-01
  3. FIGMA           $21.00   2026-02-15
  ...
  42. LINEAR          $8.00    2026-01-15

Approve all 42? (yes / review individually / change code / skip)
```

### Mystery vendor research

Before presenting unknown transactions, research them:
- Take whatever crumbs are in the description (partial company name, location, Square prefix)
- WebSearch/Firecrawl: "{vendor name} {location} business"
- Present evidence: "SQ *MOKOSZ Elwood" -> "Mokosz is a cafe in Elwood, VIC" -> suggest 6420 Entertainment
- Nathan reviews evidence and makes a quick confident decision instead of opening a browser tab

### Resumable via state file

State file (`data/.reconcile-state.json`) tracks:
- Which transaction IDs are done
- Which round we're in
- Timestamp
- Counts (done/remaining)

On skill load, check for WIP state: "You've got 87 remaining from Feb 28 -- resume?" Straight back in.

Not over-engineered -- essential for ADHD. Coming back to a blank slate after doing 200 transactions kills the motivation to start.

### Progress visibility

Running count after every action:
```
147/300 done (49%) -- 153 remaining
```

Milestone callouts at 25%, 50%, 75% to break the monotony. Show the shrinking pile, not the growing one.

### Xero-aware

Respect Xero's existing auto-suggest intelligence from its UI. Don't reinvent what Xero already knows from reconciliation history.

### Transport-agnostic design

The reconciliation logic (matching, categorization, presentation, state management) must be completely decoupled from the transport layer. This is a design constraint, not a nice-to-have.

- **Read interface:** get bank transactions, accounts, invoices, contacts
- **Write interface:** post reconciliation entries

Right now transport is "browser automation via agent-browser." When OAuth unblocks, it becomes "direct HTTP calls via xero-cli." Everything above the transport layer stays identical -- switching should be trivial.

## Future Roadmap (not now)

- **Audit mode:** review past categorizations for consistency across historical data
- **Incremental stop-hook mode:** Claude Code stop-hook surfaces one unreconciled transaction between tasks. Micro-decisions instead of batch walls.
- **Direct API mode:** when OAuth unblocks, skip browser automation entirely (enabled by transport-agnostic design)

## Open Questions

- How should Xero's own auto-suggest data factor into round 1? Can we detect which transactions Xero would auto-match from the extracted data, or do we need to check the UI?
- For rapid-fire mode, what's the right default when confidence is high -- pre-fill and require enter, or auto-approve with undo?

## Next Steps

-> `/ce:plan` to design implementation details for the xero-explorer skill
