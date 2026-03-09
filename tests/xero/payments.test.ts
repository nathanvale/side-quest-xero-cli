import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, unlink } from 'node:fs/promises'
import { runPayments } from '../../src/cli/commands/payments'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import { withCapturedOutput, withPatchedFetch } from '../helpers/test-isolation'

function paymentsCtx() {
	return {
		json: true,
		quiet: true,
		headless: false,
		logLevel: 'silent' as const,
		progressMode: 'off' as const,
		eventsConfig: resolveEventsConfig(),
	}
}

function createTestTokens() {
	return {
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: Date.now() + 60_000,
		scope: 'accounting.transactions offline_access',
	}
}

describe('payments', () => {
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

	it('lists payments with filters and projection', async () => {
		process.env.XERO_TEST_TOKENS = JSON.stringify(createTestTokens())
		await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
			mode: 0o600,
		})
		await chmod('.xero-config.json', 0o600)

		await withPatchedFetch(
			() =>
				(async () =>
					new Response(
						JSON.stringify({
							Payments: [
								{
									PaymentID: 'pay-1',
									Date: '2026-01-10',
									Amount: 42,
									Invoice: { InvoiceNumber: 'INV-001' },
									Account: { Code: '090' },
								},
							],
						}),
						{ status: 200 },
					)) as typeof fetch,
			async () =>
				await withCapturedOutput(async (capture) => {
					const exitCode = await runPayments(paymentsCtx(), {
						command: 'payments',
						since: '2026-01-01',
						until: '2026-03-31',
						page: null,
						limit: null,
						fields: ['PaymentID', 'Invoice.InvoiceNumber'],
					})
					expect(exitCode).toBe(0)
					const payload = JSON.parse(capture.getStdout())
					expect(payload.data.command).toBe('payments')
					expect(payload.data.count).toBe(1)
					expect(payload.data.resolvedSince).toBe('2026-01-01')
					expect(payload.data.payments[0]).toEqual({
						PaymentID: 'pay-1',
						'Invoice.InvoiceNumber': 'INV-001',
					})
				}),
		)
	})
})
