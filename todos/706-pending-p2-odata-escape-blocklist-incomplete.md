---
status: complete
priority: p2
issue_id: "706"
tags: [security, odata, injection, validation]
dependencies: []
---

# `escapeODataValue` uses a blocklist -- OData injection vectors not covered

## Problem Statement

`src/xero/odata.ts` uses a blocklist approach that rejects specific dangerous patterns:
- Double quotes `"`
- Logical operators `&&`, `||`
- Comparison operators `==`, `!=`

However, a blocklist is inherently incomplete for OData injection. Unblocked vectors include:

1. **Single-quote injection**: Xero's OData can be switched to single-quote delimiters in some filter contexts. A value containing `'` could break out of a filter using single-quote delimiters.
2. **Null bytes**: `\0` can truncate strings in some implementations.
3. **Newline injection**: `\r\n` can inject new HTTP header lines if the value is incorporated into a URL parameter without proper URL encoding.
4. **Parenthesis injection**: `(Status=="AUTHORISED")` appended via `)or(` bypasses the `&&`/`||` check since it uses `or` (Xero's OData keyword).

The function's JSDoc acknowledges it uses a blocklist but does not state that `or`, `and`, `not` OData keywords are not blocked. Xero OData supports `or`, `and`, `not` as logical keywords in addition to `&&`/`||`.

## Current Behavior

```ts
escapeODataValue("AUTHORISED") or (1==1") // passes -- ')' and 'or' not blocked
```

## Required Fix

Switch to an **allowlist** approach: only permit alphanumeric characters, spaces, hyphens, and periods -- the character set actually needed for Xero field values.

```ts
const SAFE_ODATA_PATTERN = /^[A-Za-z0-9 ._-]*$/
if (!SAFE_ODATA_PATTERN.test(value)) {
  throw new ODataInjectionError('...')
}
return value
```

This would be a breaking change for any values containing `@`, `+`, `/` etc., but would be significantly more secure.

## Acceptance Criteria

- [ ] Xero OData keywords `or`, `and`, `not` are blocked (or replaced by allowlist approach)
- [ ] Single-quote characters in filter values are rejected
- [ ] Parentheses in filter values are rejected
- [ ] Test cases for each blocked pattern exist

## Work Log

### 2026-03-06 - Filed from reliability audit round 3

**By:** cli-agent-reliability-auditor

**Note:** Also mentioned as item 15 in TODO-136 (low-severity batch). Upgrading to p2 because `or` keyword bypass is unambiguous.
