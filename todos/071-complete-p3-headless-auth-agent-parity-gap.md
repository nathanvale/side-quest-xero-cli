# 071 - Headless Auth Agent Parity Gap

**Status:** complete
**Priority:** P3
**Category:** agent-native parity

## Problem

In `src/xero/auth.ts`, the auth flow assumed interactive desktop use (macOS
`open` command + localhost callback). This blocked headless agents in CI/server
environments from completing OAuth.

## Fix

Added `isHeadless()` detection (`XERO_HEADLESS=1` env var or non-TTY stdout).
When headless, the auth URL is written to stdout as structured JSON
(`{ "authUrl": "..." }`) instead of launching a browser. The callback server
still works the same way -- the agent just navigates to the URL differently.

### Changes

- `src/xero/auth.ts`: Added `isHeadless()` helper; `authenticate()` now
  conditionally outputs JSON auth URL to stdout instead of calling `openBrowser()`
  when running headless.

## Verification

- Interactive (TTY): `openBrowser()` still called as before.
- Headless (`XERO_HEADLESS=1` or piped stdout): JSON with `authUrl` written to
  stdout; callback server still listens on port 5555.
