import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runReconcilePostQueue } from '../../src/cli/commands/reconcile-post'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import { withCapturedOutput, withPatchedFetch } from '../helpers/test-isolation'

/** Provide fresh test tokens so auth fixtures never expire mid-test. */
function freshTokens() {
	return {
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: Date.now() + 10 * 60_000,
	}
}

function reconcilePostCtx() {
	return {
		json: true,
		quiet: true,
		headless: false,
		logLevel: 'silent' as const,
		progressMode: 'off' as const,
		eventsConfig: resolveEventsConfig(),
	}
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), 'xero-cli-post-'))
	const original = process.cwd()
	process.chdir(dir)
	try {
		return await fn(dir)
	} finally {
		process.chdir(original)
		await rm(dir, { recursive: true, force: true })
	}
}

describe('reconcile-post queue execution', () => {
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

	it('posts confirmed queue items and persists post-run state', async () => {
		await withTempDir(async () => {
			process.env.XERO_API_BASE_URL = 'http://xero.test'
			process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())
			await Bun.write(
				'.xero-config.json',
				JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }),
				{ mode: 0o600 },
			)
			await chmod('.xero-config.json', 0o600)

			await writeFile(
				'queue.json',
				JSON.stringify(
					{
						schemaVersion: 1,
						quarter: 'Q4 FY25',
						queueHash: 'queue-hash-1',
						items: [
							{
								statementLineId: '11111111-1111-1111-1111-111111111111',
								status: 'APPROVE',
								body: {
									Type: 'SPEND',
									Contact: { Name: 'Github Inc' },
									LineItems: [
										{
											Description: 'Github Inc',
											Quantity: 1,
											UnitAmount: 49.99,
											AccountCode: '495',
											TaxType: 'INPUT',
										},
									],
									BankAccount: { AccountID: 'bank-1' },
									Date: '2025-04-01',
									CurrencyCode: 'AUD',
									IsReconciled: true,
								},
							},
						],
					},
					null,
					2,
				),
				'utf8',
			)
			await writeFile(
				'post-run.json',
				JSON.stringify(
					{
						schemaVersion: 1,
						quarter: 'Q4 FY25',
						queueHash: 'queue-hash-1',
						writeInterlock: 'WRITE Q4 FY25',
						logFile: path.join(process.cwd(), 'post-run.log.ndjson'),
						items: {
							'11111111-1111-1111-1111-111111111111': {
								statementLineId: '11111111-1111-1111-1111-111111111111',
								status: 'confirmed',
								idempotencyKey: 'idem-1',
								requestHash: '35b63a14fbd0cc33885bf533bc4158f2afd056f20e8d55e94920fb380c57a50a',
								responseCode: null,
								bankTransactionId: null,
								errorReason: null,
								postedAt: null,
								nextRetryAt: null,
								tenantPauseUntil: null,
								sameKeyRetryUntil: null,
							},
						},
					},
					null,
					2,
				),
				'utf8',
			)

			await withPatchedFetch(
				() =>
					(async (url, init) => {
						const endpoint = new URL(url.toString()).pathname
						if (endpoint === '/BankTransactions') {
							expect(init?.method).toBe('POST')
							const headers = new Headers(init?.headers)
							expect(headers.get('Idempotency-Key')).toBe('idem-1')
							return new Response(
								JSON.stringify({
									BankTransactions: [
										{
											BankTransactionID: 'btx-1',
											HasErrors: false,
											HasValidationErrors: false,
										},
									],
								}),
								{ status: 200 },
							)
						}
						return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
					}) as typeof fetch,
				async () => {
					await withCapturedOutput(async (capture) => {
						const exitCode = await runReconcilePostQueue(reconcilePostCtx(), {
							command: 'reconcile-post',
							execute: true,
							queue: './queue.json',
							postRun: './post-run.json',
						})
						expect(exitCode).toBe(0)
						const payload = JSON.parse(capture.getStdout().trim())
						expect(payload.data.summary.posted).toBe(1)
					})
				},
			)

			const savedState = JSON.parse(await readFile('post-run.json', 'utf8'))
			expect(savedState.items['11111111-1111-1111-1111-111111111111'].status).toBe('posted')
			expect(savedState.items['11111111-1111-1111-1111-111111111111'].bankTransactionId).toBe(
				'btx-1',
			)

			const logLines = (await readFile('post-run.log.ndjson', 'utf8')).trim().split('\n')
			expect(logLines).toHaveLength(1)
			const logEntry = JSON.parse(logLines[0] as string)
			expect(logEntry.result).toBe('posted')
			expect(logEntry.bankTransactionId).toBe('btx-1')
		})
	})

	it('fails closed when queue hash drifts from post-run state', async () => {
		await withTempDir(async () => {
			await writeFile(
				'queue.json',
				JSON.stringify({
					schemaVersion: 1,
					quarter: 'Q4 FY25',
					queueHash: 'queue-a',
					items: [],
				}),
				'utf8',
			)
			await writeFile(
				'post-run.json',
				JSON.stringify({
					schemaVersion: 1,
					quarter: 'Q4 FY25',
					queueHash: 'queue-b',
					writeInterlock: 'WRITE Q4 FY25',
					logFile: path.join(process.cwd(), 'post-run.log.ndjson'),
					items: {},
				}),
				'utf8',
			)

			await withCapturedOutput(async (capture) => {
				const exitCode = await runReconcilePostQueue(reconcilePostCtx(), {
					command: 'reconcile-post',
					execute: false,
					queue: './queue.json',
					postRun: './post-run.json',
				})
				expect(exitCode).toBe(5)
				const payload = JSON.parse(capture.getStdout().trim())
				expect(payload.error.code).toBe('E_STALE_DATA')
			})
		})
	})
})
