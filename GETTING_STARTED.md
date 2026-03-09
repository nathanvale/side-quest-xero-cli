# Getting Started

Minimal first-run path for `xero-cli`.

## 1. Create a Xero app

In the Xero developer portal:

- App type: `Auth code with PKCE`
- Redirect URI: `http://localhost:5555/callback`
- Company/application URL: `http://localhost`

## 2. Configure local env

```bash
cp .env.example .env
```

Add your client ID:

```bash
XERO_CLIENT_ID=YOUR_CLIENT_ID_HERE
```

## 3. Run a preflight check

```bash
bun run xero-cli status
```

This tells you whether config, Keychain access, and API connectivity are ready.

## 4. Authenticate

```bash
bun run xero-cli auth
```

This opens the browser, completes OAuth, writes tokens to macOS Keychain, and saves `.xero-config.json`.

## 5. Explore safely

Read-only commands:

```bash
bun run xero-cli accounts
bun run xero-cli transactions --unreconciled
bun run xero-cli history --since 2026-01-01
bun run xero-cli payments --since 2026-01-01
```

Write path:

```bash
echo '[{"BankTransactionID":"...","AccountCode":"400"}]' | bun run xero-cli reconcile --dry-run --json
```

Only switch to `--execute` after reviewing the dry-run result.

## Common issues

- `Missing .env file`: create `.env` from `.env.example`.
- `redirect_uri mismatch`: Xero requires the redirect URI to match exactly.
- `Keychain access denied`: allow Terminal access in macOS Privacy & Security.
- `needs-auth`: rerun `bun run xero-cli auth`.
