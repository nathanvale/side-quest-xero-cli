---
status: complete
priority: p3
issue_id: "709"
tags: [code-quality, types, zod]
dependencies: []
---

# `src/xero/types.ts` imports `z` from 'zod' AFTER it is used

## Problem Statement

`src/xero/types.ts` line 86:
```ts
import { z } from 'zod'
```

This `import` statement appears at the **bottom** of the file, after `BankTransactionRecordSchema` and `BankTransactionsResponseSchema` that use `z.object(...)`. This works at runtime due to JavaScript hoisting of ESM imports, but violates the convention that imports appear at the top of the file.

This is a code quality issue that:
- Confuses readers who scan imports at the top and don't see `z`
- May cause lint warnings in projects with import-order rules
- Sets a confusing precedent for type files in this codebase

## Required Fix

Move `import { z } from 'zod'` to the top of the file, before the interface declarations.

## Acceptance Criteria

- [ ] `import { z } from 'zod'` is the first line (or in the standard import block) of `types.ts`

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor
