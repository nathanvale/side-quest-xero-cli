---
status: complete
priority: p1
issue_id: "101"
tags: [agent-native, docs, skill, output-contract]
dependencies: []
---

# Document full JSON envelope schemas in skill (warnings, context, phase)

## Problem Statement

The skill docs show a minimal JSON envelope example but omit three fields agents need:

1. **`warnings` array** in success envelope -- emitted when --fields has typos (all-undefined detection)
2. **`context` object** in error envelope -- carries structured metadata like `invalidFields`, `validFieldsHint` for LLM self-correction
3. **`phase` discriminator** in headless auth -- the NDJSON two-phase contract uses `phase: "auth_url"` and `phase: "result"` but docs say `{"authUrl":"..."}`

## Findings

- SKILL.md line 38: success envelope shown without `warnings` or `phase`
- SKILL.md line 43: error envelope shown without `context`
- command-reference.md line 36: headless auth says `{"authUrl":"..."}` but actual output is `{"phase":"auth_url","authUrl":"..."}`
- `src/cli/output.ts` -- `writeSuccess` has `warnings` and `phase` params; `writeError` has `context` param

## Proposed Fix

Update SKILL.md output contract section with complete schemas for both success and error envelopes, including optional fields. Update headless auth section in command-reference.md with the correct NDJSON two-phase format.

**Effort:** 20 minutes

## Acceptance Criteria

- [x] Success envelope schema shows optional `warnings` array and `phase` field
- [x] Error envelope schema shows optional `context` object with example fields
- [x] Headless auth section shows correct NDJSON two-phase contract with phase discriminators
- [x] Agent can parse all possible envelope shapes

## Work Log

### 2026-02-27

- Updated SKILL.md Output Contract section with full success envelope (added `warnings` and `phase` fields with explanations)
- Updated SKILL.md Output Contract section with full error envelope (added `context` object with `invalidFields`/`validFieldsHint` example)
- Updated command-reference.md headless auth section to show correct NDJSON two-phase format with `phase` discriminator
- Marked TODO as complete
