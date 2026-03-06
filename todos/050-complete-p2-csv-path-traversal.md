---
status: complete
priority: p2
issue_id: "050"
tags: [code-review, security]
dependencies: []
---

# CSV Path Traversal in --from-csv Flag

## Problem Statement

The `loadCsv()` function accepts any file path from `--from-csv` without restriction. In the agent-native context, a compromised agent could pass `--from-csv /etc/passwd` to read arbitrary files. Content would fail CSV parsing but error messages might leak partial file contents.

## Findings

- **Source:** Security Sentinel (MEDIUM-2)
- **File:** `src/cli/commands/reconcile.ts` (line 356)
- **Impact:** Low for local-only CLI (user has filesystem access), but relevant for agent-native context

## Proposed Solutions

### Option A: Path boundary check (IMPLEMENTED)
- `path.resolve(pathname).startsWith(process.cwd())` + require `.csv` extension
- Pros: Simple, effective
- Cons: May need `--allow-absolute-path` escape hatch
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] `--from-csv /etc/passwd` returns a validation error
- [x] `--from-csv ../../../etc/passwd` returns a validation error
- [x] `--from-csv ./data.csv` works as expected

## Resolution

Added `validateCsvPath()` function in `src/cli/commands/reconcile.ts` that:
1. Resolves the path with `path.resolve()` and checks it starts with the allowed base directory (defaults to `process.cwd()`)
2. Requires a `.csv` extension
3. Supports an optional `baseDir` parameter for configurability
4. Is called inside `loadCsv()` before reading the file

Added 10 unit tests in `tests/xero/reconcile.test.ts` covering:
- Absolute paths outside cwd, traversal paths, wrong extensions, no extension
- Valid relative and absolute paths within cwd
- Traversal disguised with .csv extension
- Custom base directory (accept and reject)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | Security Sentinel MEDIUM-2 |
| 2026-02-27 | Implemented path boundary check + .csv extension validation | Option A, added `validateCsvPath()` with 10 tests |
| 2026-03-06 | Fixed missing `await` on `validateCsvPath()` call in command handler (line 873); symlink guard via `lstat` was already present but bypassed without `await` | PR #11 review |
