import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, unlink, writeFile } from 'node:fs/promises'
import { parseCsvLine, runReconcile, validateCsvPath } from '../../src/cli/commands/reconcile'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import {
	withCapturedOutput,
	withPatchedBunStdin,
	withPatchedFetch,
} from '../helpers/test-isolation'

/** Generate fresh test tokens to avoid time-based flakes from module-level Date.now(). */
function freshTokens() {
	return {
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: Date.now() + 10 * 60_000,
	}
}

const BASE_INPUT = JSON.stringify([
	{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
])

function reconcileCtx() {
	return {
		json: true,
		quiet: true,
		headless: false,
		logLevel: 'silent' as const,
		progressMode: 'off' as const,
		eventsConfig: resolveEventsConfig(),
	}
}

describe('reconcile', () => {
	beforeEach(() => {
		process.env.XERO_CLIENT_ID = 'test-client-id'
		resetEnvConfigCache()
	})

	afterEach(() => {
		delete process.env.XERO_API_BASE_URL
		delete process.env.XERO_TEST_TOKENS
		delete process.env.XERO_CLIENT_ID
		resetEnvConfigCache()
	})

	it('fails on duplicate BankTransactionID', async () => {
		const input = JSON.stringify([
			{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
			{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
		])

		await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
			mode: 0o600,
		})
		await chmod('.xero-config.json', 0o600)
		process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())

		try {
			await withPatchedBunStdin(input, async () => {
				await withCapturedOutput(async (capture) => {
					const exitCode = await runReconcile(reconcileCtx(), {
						command: 'reconcile',
						execute: false,
						fromCsv: null,
					})
					expect(exitCode).toBe(2)
					// JSON mode: error envelopes go to stdout so agents parse a single stream
					const payload = JSON.parse(capture.getStdout().trim())
					expect(payload.error.code).toBe('E_USAGE')
					expect(payload.message).toContain('Duplicate BankTransactionID')
				})
			})
		} finally {
			await unlink('.xero-config.json').catch(() => undefined)
		}
	})

	it('dry-run returns ok with mock server', async () => {
		process.env.XERO_API_BASE_URL = 'http://xero.test'
		try {
			await Bun.write(
				'.xero-config.json',
				JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }),
				{
					mode: 0o600,
				},
			)
			await chmod('.xero-config.json', 0o600)
			process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())

			const exitCode = await withPatchedFetch(
				() =>
					(async (url) => {
						const pathname = new URL(url.toString()).pathname
						if (pathname.startsWith('/BankTransactions')) {
							return new Response(
								JSON.stringify({
									BankTransactions: [{ BankTransactionID: '11111111-1111-1111-1111-111111111111' }],
								}),
								{
									status: 200,
								},
							)
						}
						if (pathname.startsWith('/Accounts')) {
							return new Response(
								JSON.stringify({ Accounts: [{ Code: '400', Status: 'ACTIVE' }] }),
								{
									status: 200,
								},
							)
						}
						return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
					}) as typeof fetch,
				async () =>
					await withPatchedBunStdin(BASE_INPUT, async () => {
						return await runReconcile(reconcileCtx(), {
							command: 'reconcile',
							execute: false,
							fromCsv: null,
						})
					}),
			)

			expect(exitCode).toBe(0)
		} finally {
			await unlink('.xero-config.json').catch(() => undefined)
		}
	})

	it('returns typed status enums', async () => {
		process.env.XERO_API_BASE_URL = 'http://xero.test'
		try {
			await Bun.write(
				'.xero-config.json',
				JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }),
				{
					mode: 0o600,
				},
			)
			await chmod('.xero-config.json', 0o600)
			process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())

			await withPatchedFetch(
				() =>
					(async (url) => {
						const pathname = new URL(url.toString()).pathname
						if (pathname.startsWith('/BankTransactions')) {
							return new Response(
								JSON.stringify({
									BankTransactions: [{ BankTransactionID: '11111111-1111-1111-1111-111111111111' }],
								}),
								{ status: 200 },
							)
						}
						if (pathname.startsWith('/Accounts')) {
							return new Response(
								JSON.stringify({ Accounts: [{ Code: '400', Status: 'ACTIVE' }] }),
								{
									status: 200,
								},
							)
						}
						return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
					}) as typeof fetch,
				async () =>
					await withPatchedBunStdin(BASE_INPUT, async () => {
						await withCapturedOutput(async (capture) => {
							const exitCode = await runReconcile(reconcileCtx(), {
								command: 'reconcile',
								execute: false,
								fromCsv: null,
							})
							expect(exitCode).toBe(0)
							const payload = JSON.parse(capture.getStdout())
							const statuses = payload.data.results.map(
								(result: { status: string }) => result.status,
							)
							for (const status of statuses) {
								expect(['reconciled', 'skipped', 'failed', 'dry-run']).toContain(status)
							}
						})
					}),
			)
		} finally {
			await unlink('.xero-config.json').catch(() => undefined)
		}
	})

	it('maps CSV schema errors to E_USAGE', async () => {
		process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())
		await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
			mode: 0o600,
		})
		await chmod('.xero-config.json', 0o600)
		await writeFile('bad-reconcile.csv', 'AccountCode\n400\n', 'utf8')

		try {
			await withCapturedOutput(async (capture) => {
				const exitCode = await runReconcile(reconcileCtx(), {
					command: 'reconcile',
					execute: false,
					fromCsv: './bad-reconcile.csv',
				})

				expect(exitCode).toBe(2)
				const payload = JSON.parse(capture.getStdout().trim())
				expect(payload.error.code).toBe('E_USAGE')
			})
		} finally {
			await unlink('bad-reconcile.csv').catch(() => undefined)
			await unlink('.xero-config.json').catch(() => undefined)
		}
	})
})

describe('validateCsvPath', () => {
	it('rejects absolute paths outside cwd', async () => {
		await expect(validateCsvPath('/etc/passwd')).rejects.toThrow(/CSV path must be within/)
	})

	it('rejects traversal paths', async () => {
		await expect(validateCsvPath('../../../etc/passwd')).rejects.toThrow(/CSV path must be within/)
	})

	it('rejects paths without .csv extension', async () => {
		await expect(validateCsvPath('./data.txt')).rejects.toThrow(/must have a .csv extension/)
	})

	it('rejects paths with no extension', async () => {
		await expect(validateCsvPath('./data')).rejects.toThrow(/must have a .csv extension/)
	})

	it('accepts relative .csv path within cwd', async () => {
		await expect(validateCsvPath('./data.csv')).resolves.toBeUndefined()
	})

	it('accepts nested .csv path within cwd', async () => {
		await expect(validateCsvPath('./exports/reconcile.csv')).resolves.toBeUndefined()
	})

	it('accepts absolute .csv path within cwd', async () => {
		const csvPath = `${process.cwd()}/data.csv`
		await expect(validateCsvPath(csvPath)).resolves.toBeUndefined()
	})

	it('rejects traversal disguised with .csv extension', async () => {
		await expect(validateCsvPath('../../../etc/passwd.csv')).rejects.toThrow(
			/CSV path must be within/,
		)
	})

	it('accepts path with custom base directory', async () => {
		await expect(validateCsvPath('/tmp/exports/data.csv', '/tmp/exports')).resolves.toBeUndefined()
	})

	it('rejects path outside custom base directory', async () => {
		await expect(validateCsvPath('/etc/passwd.csv', '/tmp/exports')).rejects.toThrow(
			/CSV path must be within/,
		)
	})
})

describe('parseCsvLine', () => {
	it('splits plain unquoted fields', () => {
		expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
	})

	it('trims whitespace from unquoted fields', () => {
		expect(parseCsvLine(' a , b , c ')).toEqual(['a', 'b', 'c'])
	})

	it('handles quoted fields containing commas', () => {
		expect(parseCsvLine('"Smith, John",400,USD')).toEqual(['Smith, John', '400', 'USD'])
	})

	it('handles escaped double-quotes inside quoted fields', () => {
		expect(parseCsvLine('"He said ""hello""",b')).toEqual(['He said "hello"', 'b'])
	})

	it('preserves empty fields', () => {
		expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c'])
	})

	it('handles a single field', () => {
		expect(parseCsvLine('only')).toEqual(['only'])
	})

	it('handles empty input', () => {
		expect(parseCsvLine('')).toEqual([''])
	})

	it('handles quoted field at end of line', () => {
		expect(parseCsvLine('a,"b,c"')).toEqual(['a', 'b,c'])
	})

	it('handles multiple quoted fields', () => {
		expect(parseCsvLine('"a,1","b,2","c,3"')).toEqual(['a,1', 'b,2', 'c,3'])
	})

	it('handles mixed quoted and unquoted fields', () => {
		expect(parseCsvLine('id,"last, first",code')).toEqual(['id', 'last, first', 'code'])
	})
})
