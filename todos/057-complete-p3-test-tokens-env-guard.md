---
status: complete
priority: p3
issue_id: "057"
tags: [code-review, security]
dependencies: []
---

# Gate XERO_TEST_TOKENS Behind Test Environment Check

## Problem Statement

When `XERO_TEST_TOKENS` is set, `readKeychain()` bypasses the macOS Keychain entirely. No guard prevents this from being used in production.

## Findings

- **Source:** Security Sentinel (LOW-2)
- **File:** `src/xero/auth.ts` (lines 120-131)

## Proposed Solutions

- Gate behind `NODE_ENV === 'test'` or emit a visible warning to stderr

## Acceptance Criteria

- [x] `XERO_TEST_TOKENS` only works when `NODE_ENV=test` or `BUN_ENV=test`
- [x] Warning emitted if env var is set in non-test environment

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Security Sentinel LOW-2 |
| 2026-02-27 | Implemented env guard in auth.ts | Added `isTestEnvironment()` helper; all three XERO_TEST_TOKENS checks now gated behind NODE_ENV/BUN_ENV=test; non-test usage logs warning to stderr and falls through to real Keychain |
