---
title: "feat: Improve xero-explorer reconcile workflow"
type: feat
status: active
date: 2026-03-03
origin: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md
---

# Improve xero-explorer Reconcile Workflow

## Enhancement Summary

**Deepened on:** 2026-03-03 (round 2)
**Sections enhanced:** 12
**Research agents used (round 1):** skill-authoring, agent-native-architecture, pattern-recognition, architecture-strategist, code-simplicity, security-sentinel, data-integrity-guardian, best-practices-researcher
**Research agents used (round 2):** skill-reviewer, skill-smoketest, agent-native-architecture, ADHD-UX-researcher, Xero-API-researcher, NDJSON-processing-researcher, pattern-recognition, security-sentinel

### Key Improvements (round 1)

1. **Simplified file structure** -- reduced from 7 files (2 modified + 5 new) to 4 files (2 modified + 2 new). Mode-specific workflows and vendor research inlined into `reconcile.md`.
2. **Per-transaction status map** replaces five parallel ID arrays -- single lookup tells you everything about an item.
3. **Two-point state write discipline** -- explicit save after user approval AND after each successful POST, preventing data loss on interruption.
4. **POST fallback path** designed upfront -- if API Explorer POST fails verification, export to JSON for manual upload without rewriting the entire interaction model.
5. **Security hardening** -- atomic writes with 0o600 permissions, vendor name sanitization before external search, private temp directory for staging.
6. **Context budget management** -- load transaction details on demand per round, not all at once.

### Key Improvements (round 2)

7. **Dropped `roundProgress` entirely** -- `lastProcessedId` assumes stable UUID ordering (they have none). Resume derives remaining work from per-transaction status: `status == 'classified'` in round N. Two independent reviewers flagged this.
8. **Added `errored` terminal status** -- distinguishes POST failures from user-skipped items. Enables retry on resume.
9. **Concrete NDJSON processing pattern** -- projection scripts and SQLite in-memory for grouping, with token budget estimates per phase.
10. **POST body templates** -- exact JSON format for SPEND and RECEIVE reconciliation, preventing agent hallucination of field names.
11. **ADHD UX depth** -- ASCII progress bar + time estimate, streak counter for rapid-fire, warm-up framing for Round 1, fibonacci milestone pattern, enhanced session summary.
12. **Browser self-correction hints** -- explicit recovery strategies for DOM-level failures, not just HTTP error codes.
13. **`allowed-tools` expanded** to `Bash` -- `Bash(agent-browser *)` blocks python3, ls, and all non-agent-browser commands.
14. **State writes via stdin/heredoc** -- never interpolate user-controlled data (vendor names) into Python `-c` strings.

### Simplifications Applied (round 1)

- Dropped separate `reconcile-batch.md` and `reconcile-rapid.md` files -- inlined as sections in `reconcile.md` (20-30 lines of difference, not a file split)
- Dropped separate `vendor-research.md` -- inlined into `matching-rules.md` (used in one place)
- Dropped `deferredIds` mechanism -- excepted items fall back to Round 3 instead of a separate queue
- Dropped transport-agnostic abstraction -- premature given OAuth has been blocked for months. One comment marks the future swap point.
- Dropped `schemaVersion` -- no migration code, Claude reads the new instructions
- Replaced 7-day staleness hard block with warning only -- the already-reconciled error handler covers actual conflicts

### Simplifications Applied (round 2)

- Dropped `roundProgress` -- redundant with per-transaction status map. Resume = filter by status.
- Dropped `processedCount` -- derivable from transaction statuses. Storing it creates a consistency obligation.
- Renamed `code` to `accountCode` -- matches Xero API convention used everywhere else in the codebase.
- Renamed `currentRound` to `activeRound` -- avoids confusion with per-transaction `round` field.

## Overview

Upgrade the `xero-explorer` reconcile skill from a bare-bones baseline to a full ADHD-friendly reconciliation workflow. Two user-selectable modes (batch approval, rapid-fire), three confidence-based rounds, mystery vendor research, resumable state, and progress visibility. Designed to make 300 monthly BAS transactions feel manageable instead of soul-crushing.

(see brainstorm: docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md)

## Problem Statement

Nathan processes ~300 bank transactions monthly for BAS. The manual Xero UI process is mind-numbingly boring after 10 years. The baseline `xero-explorer` skill can extract data and has a skeleton reconcile workflow, but lacks: intelligent categorization, vendor research, mode selection, resumability, and progress feedback. The existing CLI-based `/xero-reconcile` skill has mature matching logic but requires OAuth (currently blocked by a WAF 403 -- GitHub issue #10).

## Proposed Solution

Enhance the `xero-explorer` reconcile workflow with:

1. **Mode selection** -- batch or rapid-fire, chosen during setup
2. **Three-round processing** -- auto-matched, AI-researched, truly unknown
3. **Vendor research** -- WebSearch/Firecrawl for mystery transactions
4. **Resumable state** -- JSON state file tracks progress across sessions
5. **Progress visibility** -- running counts and milestone callouts

All changes are to skill markdown files only -- no TypeScript code changes.

## Technical Approach

### Architecture

The skill stays as markdown instruction files that guide Claude's behavior. No new TypeScript code.

| File | Change |
|------|--------|
| `.claude/skills/xero-explorer/SKILL.md` | Add mode routing, ADHD UX guidelines, state file reference, direct links to references |
| `.claude/skills/xero-explorer/workflows/reconcile.md` | Full rewrite: mode selection, three rounds, research, state, progress, batch/rapid presentation inline |
| `.claude/skills/xero-explorer/references/matching-rules.md` | New: categorization rules from xero-reconcile + vendor research protocol |
| `.claude/skills/xero-explorer/references/state-schema.md` | New: state file JSON schema, lifecycle, write discipline, validation |

**Frontmatter changes:**

```yaml
allowed-tools: Bash
```

The previous `Bash(agent-browser *)` glob blocks `python3`, `ls`, `for`, and all other non-agent-browser commands. The skill needs unrestricted Bash for Python data processing, file checks, and state management. Agent-browser is just one of many Bash commands used.

### Research Insights: File Structure

The skill-authoring review confirmed: keep SKILL.md under 500 lines, references one level deep, avoid splitting small presentation differences into separate files. Mode-specific workflows (batch vs rapid) are 20-30 lines of difference -- sections within `reconcile.md`, not separate files. Vendor research is used in exactly one step of one workflow -- inline it into `matching-rules.md` as a sub-section.

**Skill-reviewer finding (round 2):** Reference files must be linked directly from SKILL.md, not only from within `reconcile.md`. The reconcile workflow can assume references are already loaded. This maintains one-level-deep referencing: SKILL.md -> [any reference], never workflow -> reference.

**Smoketest finding (round 2):** The `description` frontmatter needs trigger phrases for the "status" route. Current description covers extract/reconcile but not status-checking language. Add: "check reconciliation progress, remaining unreconciled transactions."

**Final structure (6 files total):**
```
SKILL.md                           (entry point, intake, principles, ~100 lines)
workflows/extract.md               (unchanged)
workflows/reconcile.md             (rewrite: ~250 lines with inline mode sections)
references/api-explorer-nav.md     (unchanged)
references/matching-rules.md       (NEW: matching + vendor research)
references/state-schema.md         (NEW: state lifecycle + validation)
```

### Key Design Decisions

**Mode selection inside reconcile workflow, not at SKILL.md intake**

SKILL.md keeps 3 intake options (extract / reconcile / status), not 4. Batch vs rapid-fire is a presentation mode within reconcile, not a top-level workflow. Mode is selected at Phase A Step 3 of `reconcile.md` and fixed for the session. Mode switching mid-session is explicitly prohibited -- if the user asks, save state and restart with the new mode.

**Research insight:** Skill authoring best practice is to keep SKILL.md as a navigation layer. Mode selection belongs in the workflow where it applies.

**Three rounds, confidence descending (from brainstorm)**

Round 1 (auto-matched) clears the obvious bulk. Round 2 (AI-researched) handles mysteries with evidence. Round 3 (truly unknown) gets Nathan's brain. This matches the production fintech pattern of auto-apply / suggest / manual tiers.

**Research insight (bank categorization):** QuickBooks' Txn-Bert uses a three-tier architecture: TopK nearest-neighbor (68%), specialist model (25%), LLM fallback (7%). Our three rounds map directly to this: Round 1 = nearest-neighbor from history, Round 2 = AI-researched (LLM + web search), Round 3 = manual. Amount range matching from history (`AmountMin`/`AmountMax`) should reduce Round 1 confidence when a transaction amount is far outside the vendor's historical range.

**Per-transaction status map instead of parallel ID arrays**

Simplified model: one status map, single lookup per transaction.

```json
"transactions": {
  "<BankTransactionID>": {
    "status": "classified|confirmed|posted|skipped|errored",
    "round": 1,
    "accountCode": "6310",
    "confirmedAt": "2026-03-03T10:30:00",
    "postedAt": null,
    "errorReason": null
  }
}
```

Status lifecycle: `classified` (Phase A assigns round + suggested code) -> `confirmed` (user approved) -> `posted` (POST succeeded). Terminal states: `skipped` (user chose not to reconcile) and `errored` (POST failed with reason). See `state-schema.md` for the canonical state diagram.

Resume = filter by status. Remaining work in round N = `transactions where round == N AND status == 'classified'`. No cursor, no array intersection, no ordering dependency.

**Research insight (round 2, pattern-recognition + agent-native):** `lastProcessedId` assumes stable ordering but UUIDs have no natural sort order. If the NDJSON file is re-extracted between sessions, ordering changes and the cursor becomes meaningless. Both reviewers independently recommended dropping it in favor of status-map-only resume.

**Excepted items fall to Round 3, no deferred queue**

"Approve all except 7, 23" pulls those items out of the batch and into Round 3 (one-at-a-time with full context). No `deferredIds`, no stable numbering requirement across the session.

**No transport-agnostic abstraction**

There is one transport: `agent-browser`. OAuth is blocked with no known resolution timeline. When it unblocks, a few lines change. The abstraction saves nothing now and costs cognitive load. A comment in `reconcile.md` marks the section that changes: `# Transport: API Explorer browser (swap to direct API when OAuth unblocks -- GitHub #10)`.

**Carry forward xero-reconcile matching rules (from existing skill)**

The following rules from `.claude/skills/xero-reconcile/SKILL.md` are carried forward verbatim into `references/matching-rules.md`:

- Contact name normalization (strip PTY LTD, INC, etc., normalize whitespace, case-insensitive)
- Invoice derivation (Amount and CurrencyCode from BankTransaction, not Invoice)
- BankTransactionID immutability (never reconstruct, carry unchanged)
- Confidence threshold (low confidence = Needs input, never assume)

**Pattern insight:** The matching rules reference should note at the top: "Copied from xero-reconcile/SKILL.md on 2026-03-03. Changes should be applied to both skills to prevent drift."

### Implementation Phases

#### Step 1: Create reference files (state-schema.md + matching-rules.md)

Create the reference files that other workflows depend on.

**`references/state-schema.md`**

State file at `data/.xero-reconcile-state.json`:

```json
{
  "extractedAt": "2026-03-03T09:00:00",
  "startedAt": "2026-03-03T10:30:00",
  "mode": "batch",
  "activeRound": 2,
  "totalAtStart": 300,
  "writeStrategy": "api-explorer-post",
  "transactions": {
    "btxn-uuid-a": { "status": "posted", "round": 1, "accountCode": "6310", "confirmedAt": "...", "postedAt": "...", "errorReason": null },
    "btxn-uuid-b": { "status": "confirmed", "round": 2, "accountCode": "6420", "confirmedAt": "...", "postedAt": null, "errorReason": null },
    "btxn-uuid-c": { "status": "skipped", "round": 3, "accountCode": null, "confirmedAt": null, "postedAt": null, "errorReason": null },
    "btxn-uuid-d": { "status": "errored", "round": 1, "accountCode": "6310", "confirmedAt": "...", "postedAt": null, "errorReason": "400: Validation failed - TaxType mismatch" }
  },
  "researchCache": {
    "mokosz elwood": {
      "query": "Mokosz Elwood business Australia",
      "result": "Cafe/restaurant in Elwood, VIC",
      "suggestedCode": "6420",
      "confidence": "medium",
      "searchedAt": "2026-03-03T10:35:00"
    }
  },
  "savedAt": "2026-03-03T11:15:00"
}
```

**Naming conventions:** All timestamp fields use `{verb}At` pattern (`extractedAt`, `startedAt`, `confirmedAt`, `postedAt`, `searchedAt`, `savedAt`). `activeRound` distinguishes the session's processing cursor from per-transaction `round` classification.

**State file path note:** This is intentionally different from the CLI's path (`<root>/.xero-reconcile-state.json` in `src/state/state.ts`). The CLI and explorer workflows use separate state files to avoid collision. The `data/` location matches the convention that all financial data lives in `data/` (gitignored).

**Write discipline (from agent-native review -- critical):**

State must be written at two explicit moments around the POST:

1. **IMMEDIATELY after user approval** (before any POST attempt) -- set status to `confirmed`, write state to disk. Only then attempt POST.
2. **AFTER each successful POST response** -- set status to `posted`, update `postedAt`, write state to disk.

Never batch these. Write after every individual action. Use atomic write via stdin (never interpolate user data into Python `-c` strings):

```bash
python3 << 'PYEOF'
import json, sys, os
# State dict is constructed and passed via heredoc, not string interpolation
state = json.loads("""STATE_JSON_HERE""")
path = 'data/.xero-reconcile-state.json'
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(state, f, indent=2)
os.rename(tmp, path)
PYEOF
```

**Security insight (round 2):** The original Python `-c` pattern with string interpolation is vulnerable to injection via vendor names containing quotes or escape sequences. The heredoc pattern with `'PYEOF'` (single-quoted, preventing shell expansion) eliminates this class of vulnerability.

**State validation on load:**

1. JSON parses without error
2. All transaction IDs in `transactions` map exist in `data/bank-transactions.ndjson`
3. No transaction has both `confirmedAt` set and `status: classified` (invalid lifecycle state)
4. All `status` values are one of: `classified`, `confirmed`, `posted`, `skipped`, `errored`

If validation fails, halt with a clear message. Keep corrupt file as `.xero-reconcile-state.json.corrupt-TIMESTAMP` for forensics.

**Fresh start vs resume semantics:**

- **Resume:** load state, POST any `confirmed` items first (recovering from interruption), then continue with remaining `classified` items in the `activeRound`.
- **Fresh start:** archive state to `.xero-reconcile-state.prev.json`, create new state. Ask: "Keep the research cache for vendors already looked up?"

**Resume context injection (from agent-native review, round 2):**

On resume, inject this context BEFORE any user interaction:
1. Read state file -> extract: mode, active round, progress counts
2. Print summary: "Resuming from [date]. Mode: batch. R1: 180 done. R2: 12/45 done. 33 remaining."
3. Load ONLY remaining `classified` items for the active round (via projection script)
4. Do NOT reload completed rounds into context
5. If researchCache has entries for remaining Round 2 items, mention: "Cached research for N vendors from previous session."

**`writeStrategy` field (from architecture review):**

```json
"writeStrategy": "api-explorer-post" | "manual-export"
```

If POST verification fails, set to `manual-export`. Phase C then exports confirmed items to `data/pending-reconciliation.json` for manual upload instead of browser POST. Switching strategies is a one-field change.

**`references/matching-rules.md`**

Consolidate from `/xero-reconcile` skill:
- Contact name normalization algorithm
- Invoice matching rules (Amount from BankTransaction, currency match check)
- BankTransactionID immutability
- Confidence classification decision tree
- Historical pattern matching (contact + amount range -> account code)
- Amount range matching: if transaction amount is outside historical `AmountMin`/`AmountMax` for a contact, reduce confidence even if contact name matches

**Unknown vendor research protocol (inlined from original vendor-research.md):**

1. Extract search terms: strip Square prefix "SQ *", card suffixes "Card xx1234", special characters `" ' \ / & | < > % # @ ! $ ^ * ( ) { } [ ]`, and control characters (newlines, carriage returns, null bytes, Unicode U+0000-U+001F, U+007F-U+009F). Truncate to 80 characters. Never include dollar amounts or account codes.
2. First search: `"{vendor name} {location if present} business Australia"`
3. If inconclusive, second search: `"{vendor name} what is"`
4. Maximum 2 search attempts per vendor, maximum 30 external searches per session
5. Cache results keyed by **normalized** vendor name (lowercased, prefixes stripped, whitespace collapsed). Include `normalizedKey` in the cache entry for self-documentation.
6. Classify: Confident / Partial ("low confidence, your call") / No result (promote to Round 3)
7. Group researched items by suggested account code for batch presentation

**Security insight:** Add consent prompt at Round 2 start: "Round 2 will search for N vendor names externally via WebSearch. OK to proceed?" Vendor names are real financial data being sent to third-party services.

**POST body templates (from agent-native review, round 2 -- critical):**

Include these in `matching-rules.md` to prevent agent hallucination of field names:

```json
// SPEND/RECEIVE transaction reconciliation
// POST /BankTransactions/{BankTransactionID}
{
  "BankTransactions": [{
    "BankTransactionID": "<from extracted data, NEVER reconstructed>",
    "Type": "<SPEND or RECEIVE, from extracted data>",
    "Contact": { "ContactID": "<from extracted data>" },
    "LineItems": [{
      "Description": "<from extracted data or user override>",
      "Quantity": 1,
      "UnitAmount": "<absolute value of Total>",
      "AccountCode": "<the approved account code>",
      "TaxType": "INPUT for SPEND, OUTPUT for RECEIVE"
    }],
    "IsReconciled": true
  }]
}
```

**Xero API research insight (round 2):** `TaxType` must match the transaction direction -- `INPUT` for SPEND (purchases), `OUTPUT` for RECEIVE (income). Using the wrong type returns "The TaxType code cannot be used with account code." The existing CLI code at `src/cli/commands/reconcile.ts` hardcodes `INPUT` unconditionally -- this is a known bug for RECEIVE transactions.

**Xero reconciliation caveat:** Setting `IsReconciled: true` via API is the conversion/migration pattern. For orgs using bank feeds, this marks the transaction reconciled without matching a statement line -- the statement line still appears unreconciled in the Xero UI. The browser-based approach may actually provide "truer" reconciliation since it goes through Xero's UI workflow. Xero officially declined the feature request for true API-based statement reconciliation.

#### Step 2: Rewrite reconcile.md

**`workflows/reconcile.md`** -- the main orchestrator.

Structure the workflow as **phases with success criteria**, not just sequential steps. Each phase has a goal, numbered steps, and a verification gate.

**NDJSON processing pattern (from round 2 research):**

Use Python with in-memory SQLite for classification and grouping. This loads once (~200ms), then every subsequent query is near-instant with minimal output. Prescribe a projection script that extracts only needed fields:

```python
# Phase A classification: build index of unreconciled transactions
python3 << 'PYEOF'
import json, sqlite3

db = sqlite3.connect(':memory:')
db.execute('''CREATE TABLE txn (
    id TEXT PRIMARY KEY, contact TEXT, type TEXT,
    total REAL, date TEXT, account_code TEXT, reconciled INT
)''')

with open('data/bank-transactions.ndjson') as f:
    for line in f:
        t = json.loads(line)
        db.execute('INSERT OR IGNORE INTO txn VALUES (?,?,?,?,?,?,?)', (
            t['BankTransactionID'],
            t.get('Contact', {}).get('Name', ''),
            t.get('Type', ''),
            t.get('Total', 0),
            t.get('DateString', '')[:10],
            (t.get('LineItems') or [{}])[0].get('AccountCode', ''),
            1 if t.get('IsReconciled') else 0
        ))
db.commit()

# Summary output (~200 tokens, not 54K for raw records)
for r in db.execute('''
    SELECT contact, type, COUNT(*) cnt, ROUND(SUM(ABS(total)),2) total
    FROM txn WHERE reconciled=0
    GROUP BY contact, type ORDER BY total DESC LIMIT 25
'''):
    print(f"{r[2]:>4}  ${r[3]:>10,.2f}  {r[1]:>7}  {r[0]}")
PYEOF
```

**Token budget estimates per phase:**

| Phase | Loaded into context | Est. tokens |
|-------|-------------------|-------------|
| Phase A (classification) | SQLite summary of 300 records | ~2K |
| Round 1 batch presentation | One account code group (15-25 items, projected) | ~2-5K |
| Round 2 vendor research | One vendor + search results | ~3K |
| Round 3 manual | One transaction (full record) | ~200 |
| Phase C POST | Batch of 10 full records + browser snapshots | ~5-10K |

**Phase A: Setup**

Goal: confirm we have valid data and a mode selection before presenting anything.

- Step 1: Check for state file. If found, show summary, ask resume or fresh.
- Step 2: Check data files exist with timestamps. Staleness: warn if `extractedAt` (from state, not mtime) is older than 48h. Warn (not block) if older than 7 days.
- Step 3: Mode selection -- batch (1) or rapid-fire (2). Record in state.
- Step 4: Load and classify transactions into three rounds using SQLite projection. Store in state. Report counts.

Verification: count transactions by `round` field -- round 1 + round 2 + round 3 = total unreconciled. If counts don't add up, report discrepancy before continuing.

**Phase B: Rounds 1-3 (presentation and confirmation)**

Goal: get user approval for all categorizable transactions.

- Round 1 (auto-matched): present via selected mode, save state after each confirmation
  - **Warm-up framing:** "Starting with the easy ones to build momentum. These are recurring charges that match your history exactly."
  - Show confidence reason per item: "(matched 11 previous months)"
  - Use larger review groups in Round 1 (up to 25 items) since cognitive load per item is low
- Round 2 (AI-researched): run vendor research, cache results, present via selected mode
  - **Transition message:** "Round 1 complete: N easy matches done! Round 2: M items need a closer look. Take a break if you need one -- your progress is saved."
- Round 3 (truly unknown): always one-at-a-time regardless of mode, maximum context
  - **Transition message:** "Round 3: N items I couldn't match. Want to tackle them now, or handle them later?"
  - Frame Round 3 as optional to prevent ADHD task avoidance

After each round: "Round N complete. X/Total done (Y%)"

**Milestone callouts** at: first item, 10%, 25%, 50%, 75%, 90%, 100%. Keep language short and varied -- novelty sustains attention. Examples:

```
First one done! 299 to go.
30 done -- 10% through. Building momentum.
Quarter done! 75 reconciled, 225 to go.
HALFWAY. 150 down. The hardest part is behind you.
Three quarters! 225 done. The home stretch.
Almost there -- just 30 left!
All 300 reconciled. Done.
```

**Progress display format:**

```
Round 1 -- Easy matches
[====================............] 147/300 (49%)  ~8 min left
Last: Spotify ($14.99) -> 6310 Software/SaaS
```

- ASCII bar provides pre-attentive visual signal (ADHD brains process visual patterns faster than parsing numbers)
- Time remaining estimate combats ADHD time blindness
- "Last action" echo provides instant feedback confirmation (zero reward gap)

**Context budget (from agent-native review):** Do not hold full transaction records from completed rounds. After Round 1, only Round 2 and 3 IDs need to be in context. Load transaction details on demand by ID via projection script. If the current round is Round 2 or later AND more than 100 transactions have been processed in this session, save state and suggest: "Context is getting long -- progress saved. Run `/xero-explorer reconcile` to resume."

**Phase C: POST confirmed items**

Goal: post all `confirmed` transactions to Xero.

- Check browser session validity before each batch (make a cheap GET as probe, not just DOM text check)
- POST in batches of 10
- Two-point state writes per item (see state-schema.md)
- Use POST body templates from matching-rules.md -- never construct from memory
- After verifying first POST succeeds, minimize browser snapshots for subsequent POSTs (check status code element only, don't re-snapshot full page)
- Handle errors:
  - Already-reconciled in Xero: log BankTransactionID + "reconciled externally -- verify account code in Xero", add to CSV export (not silent skip)
  - 401/403: session expired, save state, tell user to re-login
  - 400: log error with full response body, set status to `errored` with `errorReason`, continue
  - 5xx: retry once after 5s, then stop and save state
- Progress: "Batch 3/12: 30 posted | X/Total (Y%)"
- If `writeStrategy` is `manual-export`: export to `data/pending-reconciliation.json` instead of browser POST

Add this comment in `reconcile.md` at the POST section:
```
# Transport: API Explorer browser
# Swap to direct API when OAuth unblocks -- GitHub #10
```

POST navigation via `agent-browser` follows patterns in `references/api-explorer-nav.md`.

**Browser self-correction (from agent-native review, round 2):**

If agent-browser returns an unexpected page state:
1. Take a snapshot to verify current page
2. If on wrong page: navigate back to API Explorer BankTransactions endpoint
3. If modal/dialog blocking: dismiss it, re-snapshot
4. If form fields not populated after fill: re-read DOM, try clicking the input first
5. After 3 consecutive browser failures on the same action: save state, report to user

**Phase D: Summary and export**

Goal: report results and export skipped items.

```
SESSION COMPLETE

  Reconciled:  287 transactions
  Skipped:       8 (exported to data/needs-review.csv)
  Errors:        5 (exported to data/needs-review.csv with error reasons)
  Total value:  $34,521.80 across 42 contacts

  By round:
    Auto-matched (R1):   247 posted
    AI-researched (R2):   38 posted
    Unknown (R3):          2 posted

  Top categories:
    6310 Software/SaaS      42 items   $2,340.50
    6420 Entertainment       89 items   $1,230.80
    6440 Motor Vehicle       67 items   $4,560.00

  Session stats:
    Duration:    12 min
    Avg pace:    24 items/min
    Best streak: 31 in a row

  Your Feb 2026 books are 96% reconciled.
  13 items in data/needs-review.csv whenever you're ready.
```

Export skipped AND errored items to `data/needs-review.csv` (with 0o600 permissions, atomic write). Include externally-reconciled items with "verify account code" note. Errored items include the `errorReason`. Compatible with `/xero-review` import.

**Session completion (from agent-native review):** After summary and CSV export, the session is complete. Do not prompt for more input or suggest next steps unless Nathan asks.

**Batch mode presentation (inline section):**

- Group by suggested account code, all line items numbered
- Max 15 items per review group (25 for Round 1 warm-up). If a group exceeds the cap, split into sub-groups.
- Per group: show items, then "Approve all N? (yes / except N,N / change code / skip group)"
- "except N,N" pulls those items into Round 3
- "change code" re-assigns the group, then re-confirms
- For Round 2 items, add research evidence per line item

**Rapid-fire mode presentation (inline section):**

- One at a time, suggested code pre-filled
- `[147/300] GITHUB ($9.00, 2026-02-01, SPEND) -> 6310 Software/SaaS (12 prior matches)`
- Enter = approve, type code = override, "skip" = skip
- **Streak counter:** "Streak: 12 in a row!" -- reset without fanfare on skip/reject (celebrate wins, don't punish breaks)
- **Pace indicator:** "Pace: ~4 items/min" -- informational, not pressuring
- Progress updates after each item

#### Step 3: Update SKILL.md

Update the root SKILL.md with:
- Updated `description` frontmatter with trigger phrases for all three routes (extract, reconcile, status)
- Updated `allowed-tools: Bash` (not `Bash(agent-browser *)`)
- Intake routing: extract (1) / reconcile (2) / status (3)
- Updated `argument-hint: "{extract|reconcile|status}"`
- Data directory table (add state file and needs-review.csv)
- ADHD UX guidelines section
- **Direct links to reference files** from SKILL.md's reconcile intake (not only from within reconcile.md): "Before starting reconciliation, read references/matching-rules.md and references/state-schema.md."

ADHD UX guidelines (applied to all reconciliation interactions):

- **Batch approval, not one-by-one** -- group confident matches, "42 items -> Software ($2,340). Approve?"
- **Progress is dopamine** -- ASCII progress bar + "147/300 done (49%)" + time remaining after every action, milestones at first-item/10%/25%/50%/75%/90%
- **Research the mysteries proactively** -- WebSearch vendors before presenting, show evidence
- **Let me stop anytime** -- save state after every confirmation, resume exactly where you left off
- **Keep it visual** -- tables over paragraphs, summary first, details on demand
- **Warm up first** -- present easy matches first to build momentum before harder items
- **Celebrate completion** -- session summary with stats, top categories, best streak

#### Step 4: Security fixes to extract.md (prerequisite, not in original scope)

The security review found that the extract workflow (which creates the NDJSON files this plan depends on) has critical permission gaps. These should be fixed before or alongside the reconcile rewrite:

- NDJSON files written with default umask (0644, world-readable) -- should use `os.open()` with 0o600
- `data/` directory should be 0700
- `/tmp/xero-*` hardcoded paths should use `mktemp -d` (plan already specifies this for reconcile)
- Clipboard should be cleared after each `pbpaste` save: `echo -n "" | pbcopy`

These are quick fixes to existing `extract.md` and `api-explorer-nav.md` files.

## Acceptance Criteria

### Functional

- [ ] Mode selection works at Phase A Step 3 of reconcile workflow (batch vs rapid-fire)
- [ ] Three rounds process in confidence-descending order
- [ ] All items numbered in batch mode, max 15 per review group (25 for Round 1)
- [ ] Batch mode supports "approve all except N,N" syntax (excepted items go to Round 3)
- [ ] Round 2 runs WebSearch for unknown vendors (max 2 searches per vendor, max 30 per session, with consent prompt)
- [ ] Research results cached in state file by normalized vendor name
- [ ] Failed research promotes item to Round 3
- [ ] State file saves at two points: after user approval AND after each successful POST
- [ ] Resume loads state, POSTs `confirmed` items first, continues with remaining `classified` items in active round
- [ ] `errored` items exported to CSV with error reasons, retryable on next resume
- [ ] Data staleness warning using `extractedAt` (not file mtime)
- [ ] Browser session probed with authenticated GET before each POST batch
- [ ] Externally-reconciled transactions logged with "verify account code" note, included in CSV export
- [ ] Skipped and errored items exported to CSV with 0o600 permissions, compatible with `/xero-review`
- [ ] Progress bar + percentage + time estimate shown after every action
- [ ] Milestone callouts at first-item, 10%, 25%, 50%, 75%, 90%
- [ ] `writeStrategy` field supports `api-explorer-post` and `manual-export` modes
- [ ] POST body uses correct `TaxType` per transaction direction (INPUT for SPEND, OUTPUT for RECEIVE)
- [ ] Round 3 presented as optional ("tackle now or handle later?")

### Carry-Forward Rules (from xero-reconcile)

- [ ] Contact name normalization applied per existing algorithm
- [ ] Invoice Amount/CurrencyCode derived from BankTransaction
- [ ] BankTransactionID carried unchanged through entire pipeline
- [ ] Low confidence = Needs input, never assume
- [ ] Amount range outside historical pattern reduces confidence

### Security

- [ ] State file written with atomic temp+rename, 0o600 permissions, via stdin/heredoc pattern
- [ ] CSV export written with atomic temp+rename, 0o600 permissions
- [ ] Vendor names sanitized before external search queries (strip special chars, control characters, cap 80 chars)
- [ ] Consent prompt before Round 2 external searches, with total search cap of 30 per session
- [ ] Raw API responses staged in `mktemp -d` private directory (not `/tmp`), cleaned up after conversion
- [ ] NDJSON files written with 0o600 permissions (fix in extract.md)
- [ ] `data/` directory set to 0700
- [ ] Clipboard cleared after each pbpaste save

## Critical Prerequisite: POST via API Explorer

Before implementing Step 2 Phase C (POST confirmed items), manually verify that the Xero API Explorer browser UI supports POST operations with a JSON body via `agent-browser`.

**Decision gate:** If POST verification fails, set `writeStrategy: "manual-export"` in state schema. Phase C exports confirmed items to `data/pending-reconciliation.json` for manual upload. All other phases (categorization, presentation, state management) work regardless.

**Also verify during POST testing:** Xero API research (round 2) indicates that POSTing `IsReconciled: true` on an already-reconciled transaction returns HTTP 200 (idempotent, silent success). Non-existent BankTransactionID returns 404 or `HasValidationErrors: true`. Document the actual API Explorer behavior, which may differ from direct API calls.

**Xero reconciliation caveat:** The `IsReconciled: true` API approach is the conversion/migration pattern. For bank-feed accounts, the statement line may still appear unreconciled in Xero's UI. The browser-based approach through the API Explorer may provide "truer" reconciliation.

This blocks Step 2 Phase C (POST) but does not block everything else.

## Future Roadmap (not now, from brainstorm)

- **Audit mode:** review past categorizations for consistency across historical data
- **Incremental stop-hook mode:** Claude Code stop-hook surfaces one unreconciled transaction between tasks
- **Direct API mode:** when OAuth unblocks, skip browser automation entirely

## Open Questions (from brainstorm)

1. **Rapid-fire defaults:** pre-fill and require enter (safer) vs auto-approve with undo (faster)? Recommendation: require enter. Auto-approve needs an undo buffer which adds state complexity for marginal speed gain. Revisit if Nathan finds enter-to-approve too slow.

2. **Xero auto-suggest awareness:** can we detect which transactions Xero would auto-match from extracted data, or do we need to check the UI? Recommendation: rely on our own matching from extracted history data. Xero's auto-suggest is a UI feature based on weighted k-NN over reconciliation history -- our Round 1 matching replicates this approach.

## Dependencies & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| API Explorer doesn't support POST | Blocks write path | `writeStrategy: "manual-export"` fallback designed upfront; all categorization phases work regardless |
| Browser session expires mid-reconcile | Lost POST progress | Authenticated GET probe before each batch; two-point state writes track confirmed-vs-posted per item |
| Data extracted days ago is stale | Reconcile conflicts with Xero | Staleness warning using `extractedAt`; externally-reconciled items detected and exported with "verify" note |
| WebSearch returns garbage for vendor research | Round 2 inflation into Round 3 | Max 2 searches per vendor, 30 per session; partial results shown to user; no silent promotion |
| Context window exhaustion | Agent cannot continue mid-round | Projection scripts minimize token usage; deterministic checkpoint rule (100+ items processed -> save and stop); resume derives work from status map |
| State file corruption | Re-present all confirmed items | Validation on load; corrupt file preserved for forensics; atomic write prevents partial writes |
| Matching rules drift from xero-reconcile | Inconsistent categorization | Copy-date note at top of matching-rules.md; changes applied to both skills |
| TaxType mismatch on RECEIVE transactions | 400 error from Xero | POST template specifies INPUT for SPEND, OUTPUT for RECEIVE; `errored` status captures the reason for retry |
| Browser DOM failures (modals, stale state) | POST hangs or misroutes | Self-correction hints: snapshot, navigate back, dismiss dialog, 3-failure circuit breaker |
| Python injection via crafted vendor names | Arbitrary code execution | Stdin/heredoc pattern for all state writes; never interpolate user data into `-c` strings |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md](docs/brainstorms/2026-03-03-xero-explorer-reconcile-brainstorm.md) -- key decisions carried forward: two modes, three rounds, resumable state, ADHD UX principles

### Internal References

- Existing reconcile skill: `.claude/skills/xero-reconcile/SKILL.md` (matching rules, contact normalization, invoice derivation)
- Current xero-explorer skill: `.claude/skills/xero-explorer/SKILL.md` (baseline to build on)
- API Explorer navigation: `.claude/skills/xero-explorer/references/api-explorer-nav.md`
- State management pattern: `src/state/state.ts` (atomic write, permissions, StateBatcher)
- File security: `src/util/fs.ts` (assertSecureFile, symlink checks)
- Xero API types: `src/xero/types.ts` (BankTransactionRecord shape)
- CLI reconcile TaxType bug: `src/cli/commands/reconcile.ts:948` (hardcodes INPUT for all types)
- OAuth block: GitHub issue #10

### External Research (round 1)

- [Google ADK Resume Docs](https://google.github.io/adk-docs/runtime/resume/) -- checkpoint-write-advance pattern for resumable workflows
- [QuickBooks Rel-Cat Paper (2025)](https://arxiv.org/html/2506.09234v1) -- three-tier bank transaction categorization architecture
- [Anthropic Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) -- progressive disclosure, SKILL.md as navigation layer
- [Software As Craft: Discovery Trees](https://softwareascraft.com/adhd/discovery-trees-visualizing-tasks/) -- ADHD-friendly externalized working memory
- [Conductor State Management](https://deepwiki.com/gemini-cli-extensions/conductor/8.2-state-management-and-resumability) -- checkpoint-based resume architecture

### External Research (round 2)

- [Xero BankTransactions API](https://developer.xero.com/documentation/api/accounting/banktransactions) -- POST endpoint, IsReconciled semantics, batch support
- [Xero Rate Limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits) -- 60/min per tenant, 5000/day
- [Xero Tax in Xero Guide](https://developer.xero.com/documentation/guides/how-to-guides/tax-in-xero) -- TaxType must match transaction direction
- [Xero UserVoice: Reconcile via API (Declined)](https://xero.uservoice.com/forums/5528-xero-api/suggestions/2884040-reconcile-via-the-api) -- true statement matching not available via API
- [Motivation Deficit in ADHD and Dopamine Reward Pathway (PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3010326/) -- variable ratio reinforcement for sustained engagement
- [Closing the Dopamine Gap: Celebrating Wins with ADHD (ADD Resource Center)](https://www.addrc.org/closing-the-dopamine-gap-how-to-actually-celebrate-wins-with-adhd/) -- zero reward gap, externalized progress
- [Using Behavior Momentum for Task Initiation (Ambitions ABA)](https://www.ambitionsaba.com/resources/using-behavior-momentum-to-increase-task-initiation) -- high-probability request sequences for warm-up
- [Pomodoro Technique for ADHD (Inflow)](https://www.getinflow.io/post/pomodoro-technique-adhd-productivity) -- 15-25 min focus windows, explicit break permission
- [CLI UX Best Practices: Progress Displays (Evil Martians)](https://evilmartians.com/chronicles/cli-ux-best-practices-3-patterns-for-improving-progress-displays) -- multi-signal progress patterns
- [sqlite-utils CLI (Simon Willison)](https://sqlite-utils.datasette.io/en/stable/cli.html) -- NDJSON-to-SQL processing patterns
