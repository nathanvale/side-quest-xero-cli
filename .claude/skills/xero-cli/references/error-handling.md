# Error Handling

Error codes, exit codes, machine-readable action values, retry policy, stop gates, and batch strategy.

## Exit Codes

| Exit Code | Constant | Meaning |
|-----------|----------|---------|
| 0 | `EXIT_OK` | Success |
| 1 | `EXIT_RUNTIME` | Runtime error (API failure, network, unhandled) |
| 2 | `EXIT_USAGE` | Invalid arguments or flags |
| 3 | `EXIT_NOT_FOUND` | Resource not found |
| 4 | `EXIT_UNAUTHORIZED` | Token expired or invalid |
| 5 | `EXIT_CONFLICT` | Concurrent modification conflict |
| 130 | `EXIT_INTERRUPTED` | Process interrupted (SIGINT) |

## Error Codes

| Code | Exit Code | Meaning | Action |
|------|-----------|---------|--------|
| `E_UNAUTHORIZED` | 4 | Token expired or invalid | Run `auth`, then retry once |
| `E_USAGE` | 2 | Invalid arguments | Fix arguments, do not retry blindly |
| `E_RATE_LIMITED` | 1 | Xero API rate limit hit | Wait 2-5 seconds, retry same command |
| `E_CONFLICT` | 5 | Concurrent modification | Wait, retry once. If fails again, ask user |
| `E_RUNTIME` | 1 | Runtime error (API failure, network) | Check error context, escalate if not retryable |
| `E_KEYCHAIN_LOCKED` | 1 | macOS Keychain locked | Ask user to unlock Keychain |
| `E_KEYCHAIN_DENIED` | 1 | Keychain access denied | Ask user to grant Terminal access in System Settings |

## Machine-Readable Action Values

The `action` field in error envelopes provides a machine-readable hint for programmatic recovery. Agents should use these values to determine next steps without parsing prose.

| Action Value | Meaning | Retryable |
|-------------|---------|-----------|
| `NONE` | No action needed | No |
| `CHECK_NETWORK` | Check network connectivity | No |
| `CHECK_SCOPES` | Verify OAuth scopes | No |
| `RETRY_WITH_BACKOFF` | Retry with exponential backoff | Yes |
| `WAIT_AND_RETRY` | Wait then retry (rate limit/lock/conflict) | Yes |
| `ESCALATE` | Cannot auto-recover, escalate to user | No |
| `FIX_ARGS` | Fix CLI arguments | No |
| `RUN_AUTH` | Run `auth` command to re-authenticate | No |
| `REFETCH_AND_RETRY` | Re-fetch stale data, then retry | Yes |
| `INSPECT_AND_RESOLVE` | Inspect conflict details, resolve manually | No |

## Retry Policy

| Command type | Max retries | Strategy |
|-------------|-------------|----------|
| `auth` | 0 | Run auth flow (human interaction required) |
| `transactions`, `accounts`, `history`, `invoices` | 3 | Backoff: 1s, 2s, 4s |
| `reconcile` (transient errors) | 1 | Re-run same input (idempotent via state file) |
| `reconcile` (validation errors) | 0 | Fix input, do not retry blindly |

- **E_RATE_LIMITED:** Wait 2-5 seconds, retry the same command.
- **E_CONFLICT:** Wait, retry once. If it fails again, stop and ask the user.
- **E_UNAUTHORIZED:** Run auth, then retry once.
- **E_USAGE:** Fix arguments. Do not retry blindly.

If writes fail mid-run, re-run the same input. The CLI is idempotent via state file.

## Stop / Ask-User Gates

Stop and ask the user when:

- Any ambiguous categorization
- Missing or conflicting invoice data
- Significant API errors or rate limits
- Reconciliation affecting multiple accounts
- >10% of transactions remain in "Needs input" -- pause and ask for guidance
- `E_CONFLICT` repeats twice in a row

## Batch Strategy

- Chunk reconciliation into groups of **50 transactions**.
- For >200 items, loop with progress updates after each batch.
- Max 1000 items per `reconcile` invocation. Chunk larger sets across multiple calls.

## Safety Notes

- Account-code reconciliation uses `IsReconciled: true` (conversion/migration flow).
- For bank-feed accounts, this may not match statement lines.
