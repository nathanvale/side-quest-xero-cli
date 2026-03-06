import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, unlink } from 'node:fs/promises'
import { runHistory } from '../../src/cli/commands/history'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import { withPatchedFetch } from '../helpers/test-isolation'

function createTestTokens() {
	return {
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: Date.now() + 60_000,
	}
}

describe('history', () => {
	beforeEach(() => {
		process.env.XERO_CLIENT_ID = 'test-client-id'
		resetEnvConfigCache()
	})

	afterEach(async () => {
		delete process.env.XERO_TEST_TOKENS
		delete process.env.XERO_CLIENT_ID
		resetEnvConfigCache()
		await unlink('.xero-config.json').catch(() => undefined)
	})

	it('requires --since', async () => {
		const ctx = {
			json: true,
			quiet: true,
			headless: false,
			logLevel: 'silent' as const,
			progressMode: 'off' as const,
			eventsConfig: resolveEventsConfig(),
		}
		const exitCode = await runHistory(ctx, {
			command: 'history',
			since: null,
			contact: null,
			accountCode: null,
			fields: null,
		})
		expect(exitCode).toBe(2)
	})

	it('groups transactions', async () => {
		process.env.XERO_TEST_TOKENS = JSON.stringify(createTestTokens())
		await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
			mode: 0o600,
		})
		await chmod('.xero-config.json', 0o600)

		const ctx = {
			json: true,
			quiet: true,
			headless: false,
			logLevel: 'silent' as const,
			progressMode: 'off' as const,
			eventsConfig: resolveEventsConfig(),
		}
		const exitCode = await withPatchedFetch(
			() =>
				(async () =>
					new Response(
						JSON.stringify({
							BankTransactions: [
								{
									BankTransactionID: 'tx-1',
									Contact: { Name: 'ACME' },
									Total: -10,
									DateString: '2026-01-01',
									Type: 'SPEND',
									CurrencyCode: 'AUD',
									LineItems: [{ AccountCode: '400' }],
								},
								{
									BankTransactionID: 'tx-2',
									Contact: { Name: 'ACME' },
									Total: -15,
									DateString: '2026-01-02',
									Type: 'SPEND',
									CurrencyCode: 'AUD',
									LineItems: [{ AccountCode: '400' }],
								},
							],
						}),
						{ status: 200 },
					)) as typeof fetch,
			async () =>
				await runHistory(ctx, {
					command: 'history',
					since: '2026-01-01',
					contact: null,
					accountCode: null,
					fields: null,
				}),
		)
		expect(exitCode).toBe(0)
	})
})
