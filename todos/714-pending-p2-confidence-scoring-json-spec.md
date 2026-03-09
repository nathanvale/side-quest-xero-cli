---
status: pending
priority: p2
issue_id: "714"
tags: [prompt-native, matching, agent-native]
dependencies: []
---

# Extract confidence scoring rules to a JSON spec in skills

## Problem Statement

Confidence scoring for reconciliation matching is defined as prose rules in `matching-rules.md`. Agents must interpret natural language to derive point values. A JSON scoring matrix would make matching deterministic and auditable.

## Findings

- Prompt-Native Features scored **68/100 (68%)** in agent-native audit
- Current scoring: base score, contact match, amount range, recurrence, account stability, anomalies
- Banding: High (>=75), Medium (45-74), Low (<45)
- Rules are prose -- agents infer rather than reference exact values

## Proposed Solutions

### Option 1: JSON scoring matrix in skill reference

**Approach:** Create `xero-explorer/references/confidence-weights.json` with exact point values.

```json
{
  "exactPayeeMatch": 70,
  "amountInRange": 15,
  "recurrenceGte3": 10,
  "accountCodeStability": 5,
  "bands": { "high": 75, "medium": 45, "low": 0 }
}
```

**Pros:**
- Removes ambiguity, deterministic scoring
- Agent-editable without code changes
- Auditable -- can diff scoring changes

**Cons:**
- Must keep JSON and prose in sync

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

To be filled during triage.

## Acceptance Criteria

- [ ] JSON scoring matrix created in skill references
- [ ] Matching-rules.md references the JSON spec
- [ ] Scoring bands defined with exact thresholds

## Work Log

### 2026-03-09 - Filed from agent-native audit

**By:** Claude Code

**Actions:**
- Prompt-Native audit identified confidence scoring as top candidate for JSON extraction
- Would push prompt-native score from 68% to ~75%
