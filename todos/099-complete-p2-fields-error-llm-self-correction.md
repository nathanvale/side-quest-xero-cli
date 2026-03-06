---
status: complete
priority: p2
issue_id: "099"
tags: [agent-native, dx, fields, llm]
dependencies: []
---

# Improve --fields error for LLM self-correction

## Problem Statement

The `parseFields()` error in `src/cli/command.ts:544-548` includes `invalidFields` and `validFieldsHint` in the error context, but the hint text is generic: "Fields must be comma-separated dot paths (A-Z, a-z, 0-9, _, .)."

The plan (line 1664-1668) specifies a more actionable hint for LLM-generated commands: "Use --help <command> to see available fields. Fields are PascalCase (e.g., Contact.Name, BankTransactionID)."

LLMs generating CLI commands commonly get casing wrong (e.g., `contact.name` instead of `Contact.Name`). The error should guide self-correction with concrete examples.

## Findings

- `src/cli/command.ts:546-547` -- current hint is character-set focused, not casing-focused
- The plan specifies PascalCase guidance with examples
- The `context` object already flows into the JSON error envelope at `src/cli/output.ts:127`
- Agents parsing the error envelope get `error.context.validFieldsHint` for self-correction

## Proposed Fix

Update the `validFieldsHint` string and add common field examples to help LLMs self-correct.

**Effort:** 5 minutes

**Risk:** None

## Acceptance Criteria

- [ ] `validFieldsHint` mentions PascalCase convention
- [ ] Hint includes concrete field examples (e.g., Contact.Name, BankTransactionID)
- [ ] JSON error envelope includes actionable hint for LLM self-correction
- [ ] Test verifies hint content in error output

## Work Log

### 2026-02-27 - Filed from plan audit

**By:** Claude Code

**Actions:**
- Identified gap between plan spec (line 1664) and current implementation
- Confirmed error context already flows into JSON envelope
