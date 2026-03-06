---
status: complete
priority: p2
issue_id: "054"
tags: [code-review, bug]
dependencies: []
---

# shutdownLogging() is a No-Op (Promise.race Always Resolves at 0ms)

## Problem Statement

`shutdownLogging()` races a 0ms timeout against a 500ms timeout. The 0ms timer always wins, so the function resolves immediately without flushing LogTape sinks. Buffered log entries (especially from the `fingersCrossed` sink) are lost on exit.

## Findings

- **Source:** TypeScript Reviewer, Architecture Strategist, Code Simplicity Reviewer (all three flagged independently)
- **File:** `src/logging.ts` (lines 90-98)
- **CodeRabbit also flagged (2026-02-27):**
  - `src/logging.ts:89-98` - shutdownLogging races 0ms vs 500ms (same issue)
  - `src/logging.ts:64-84` - `configure()` call is voided, swallowing async errors. Should either await or wrap in try/catch.

## Proposed Solutions

### Option A: Call LogTape dispose()
- Replace the race with `await dispose()` from LogTape, with a timeout wrapper
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [x] `shutdownLogging()` actually flushes buffered log entries
- [x] Graceful timeout if flush takes too long

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Created from code review | 3 agents independently flagged |
| 2026-02-27 | Fixed: replaced 0ms no-op with LogTape dispose(), added .catch() to configure() | LogTape exports dispose() which flushes all sinks |
