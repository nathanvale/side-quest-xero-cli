import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, unlink } from 'node:fs/promises'
import { runStatus } from '../../src/cli/commands/status'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import { withCapturedOutput, withPatchedFetch } from '../helpers/test-isolation'

function statusCtx() {
	return {
		json: true,
		quiet: true,
		headless: false,
		logLevel: 'silent' as const,
		progressMode: 'off' as const,
		eventsConfig: resolveEventsConfig(),
	}
}

describe('status', () => {
	beforeEach(() => {
		process.env.XERO_CLIENT_ID = 'test-client-id'
		process.env.XERO_TEST_TOKENS = JSON.stringify({
			accessToken: 'token',
			refreshToken: 'refresh',
			expiresAt: Date.now() + 10 * 60_000,
			scope: 'accounting.transactions accounting.contacts accounting.settings.read offline_access',
		})
		resetEnvConfigCache()
	})

	afterEach(async () => {
		delete process.env.XERO_CLIENT_ID
		delete process.env.XERO_TEST_TOKENS
		resetEnvConfigCache()
		await unlink('.xero-config.json').catch(() => undefined)
	})

	it('returns availableScopes in status output', async () => {
		await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
			mode: 0o600,
		})
		await chmod('.xero-config.json', 0o600)

		await withPatchedFetch(
			() =>
				(async () =>
					new Response(JSON.stringify({ Organisations: [{ Name: 'Test Org' }] }), {
						status: 200,
					})) as typeof fetch,
			async () =>
				await withCapturedOutput(async (capture) => {
					const exitCode = await runStatus(statusCtx())
					expect(exitCode).toBe(0)
					const payload = JSON.parse(capture.getStdout())
					expect(payload.data.availableScopes).toContain('accounting.transactions')
					expect(
						payload.data.checks.find((check: { name: string }) => check.name === 'scopes')?.status,
					).toBe('ok')
				}),
		)
	})
})
