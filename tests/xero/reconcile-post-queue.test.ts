import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { jsonSha256, runReconcilePostQueue } from '../../src/cli/commands/reconcile-post'
import { resolveEventsConfig } from '../../src/events'
import { resetEnvConfigCache } from '../../src/xero/config'
import { withCapturedOutput, withPatchedFetch } from '../helpers/test-isolation'

const STATEMENT_LINE_ID = '11111111-1111-1111-1111-111111111111'
const BASE_BODY = {
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
}

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

async function writeQueueAndState(
	logFile: string,
	options?: {
		readonly queueHash?: string
		readonly itemStatus?: 'confirmed' | 'posted' | 'errored'
		readonly nextRetryAt?: string | null
		readonly tenantPauseUntil?: string | null
		readonly sameKeyRetryUntil?: string | null
		readonly writeInterlock?: string
	},
): Promise<void> {
	const queueHash = options?.queueHash ?? 'queue-hash-1'
	await writeFile(
		'queue.json',
		JSON.stringify(
			{
				schemaVersion: 1,
				quarter: 'Q4 FY25',
				queueHash,
				items: [
					{
						statementLineId: STATEMENT_LINE_ID,
						status: 'APPROVE',
						body: BASE_BODY,
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
				queueHash,
				writeInterlock: options?.writeInterlock ?? 'WRITE Q4 FY25',
				logFile,
				items: {
					[STATEMENT_LINE_ID]: {
						statementLineId: STATEMENT_LINE_ID,
						status: options?.itemStatus ?? 'confirmed',
						idempotencyKey: 'idem-1',
						requestHash: jsonSha256(BASE_BODY),
						responseCode: null,
						bankTransactionId: null,
						errorReason: null,
						postedAt: null,
						nextRetryAt: options?.nextRetryAt ?? null,
						tenantPauseUntil: options?.tenantPauseUntil ?? null,
						sameKeyRetryUntil: options?.sameKeyRetryUntil ?? null,
					},
				},
			},
			null,
			2,
		),
		'utf8',
	)
}

async function setupExecutePrereqs(): Promise<void> {
	process.env.XERO_API_BASE_URL = 'http://xero.test'
	process.env.XERO_TEST_TOKENS = JSON.stringify(freshTokens())
	await Bun.write('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
		mode: 0o600,
	})
	await chmod('.xero-config.json', 0o600)
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

	it('matches the Python hash fixture for canonical queue payloads', () => {
		expect(jsonSha256(BASE_BODY)).toBe(
			'35b63a14fbd0cc33885bf533bc4158f2afd056f20e8d55e94920fb380c57a50a',
		)
	})

	it('posts confirmed queue items and persists post-run state', async () => {
		await withTempDir(async () => {
			await setupExecutePrereqs()
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'))

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
			expect(savedState.items[STATEMENT_LINE_ID].status).toBe('posted')
			expect(savedState.items[STATEMENT_LINE_ID].bankTransactionId).toBe('btx-1')

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

	it('records retry metadata when Xero rate limits the queue run', async () => {
		await withTempDir(async () => {
			await setupExecutePrereqs()
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'))

			let requestCount = 0
			await withPatchedFetch(
				() =>
					(async (url) => {
						if (new URL(url.toString()).pathname === '/BankTransactions') {
							requestCount += 1
							return new Response(JSON.stringify({ error: 'slow down' }), {
								status: 429,
								headers: { 'retry-after': '1' },
							})
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
						expect(exitCode).toBe(1)
						const payload = JSON.parse(capture.getStdout().trim())
						expect(payload.data.summary.retryable).toBe(1)
					})
				},
			)

			expect(requestCount).toBe(4)
			const savedState = JSON.parse(await readFile('post-run.json', 'utf8'))
			expect(savedState.items[STATEMENT_LINE_ID].status).toBe('confirmed')
			expect(typeof savedState.items[STATEMENT_LINE_ID].nextRetryAt).toBe('string')
			const logEntry = JSON.parse((await readFile('post-run.log.ndjson', 'utf8')).trim())
			expect(logEntry.result).toBe('retryable')
			expect(typeof logEntry.nextRetryAt).toBe('string')
		})
	})

	it('pauses the tenant when Xero is offline', async () => {
		await withTempDir(async () => {
			await setupExecutePrereqs()
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'))

			await withPatchedFetch(
				() =>
					(async (url) => {
						if (new URL(url.toString()).pathname === '/BankTransactions') {
							return new Response(JSON.stringify({ error: 'offline' }), {
								status: 503,
							})
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
						expect(exitCode).toBe(1)
						const payload = JSON.parse(capture.getStdout().trim())
						expect(payload.data.summary.retryable).toBe(1)
					})
				},
			)

			const savedState = JSON.parse(await readFile('post-run.json', 'utf8'))
			expect(typeof savedState.items[STATEMENT_LINE_ID].tenantPauseUntil).toBe('string')
		})
	}, 12_000)

	it('keeps the same idempotency window after a transport error', async () => {
		await withTempDir(async () => {
			await setupExecutePrereqs()
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'))

			await withPatchedFetch(
				() =>
					(async (url) => {
						if (new URL(url.toString()).pathname === '/BankTransactions') {
							throw new TypeError('socket hang up')
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
						expect(exitCode).toBe(1)
						const payload = JSON.parse(capture.getStdout().trim())
						expect(payload.data.summary.retryable).toBe(1)
					})
				},
			)

			const savedState = JSON.parse(await readFile('post-run.json', 'utf8'))
			expect(typeof savedState.items[STATEMENT_LINE_ID].sameKeyRetryUntil).toBe('string')
			expect(savedState.items[STATEMENT_LINE_ID].status).toBe('confirmed')
		})
	})

	it('blocks execution while a retry pause is still active', async () => {
		await withTempDir(async () => {
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'), {
				nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
			})

			await withCapturedOutput(async (capture) => {
				const exitCode = await runReconcilePostQueue(reconcilePostCtx(), {
					command: 'reconcile-post',
					execute: true,
					queue: './queue.json',
					postRun: './post-run.json',
				})
				expect(exitCode).toBe(1)
				const payload = JSON.parse(capture.getStdout().trim())
				expect(payload.error.code).toBe('E_RATE_LIMITED')
			})
		})
	})

	it('blocks execution when the same-key retry window has expired', async () => {
		await withTempDir(async () => {
			await writeQueueAndState(path.join(process.cwd(), 'post-run.log.ndjson'), {
				sameKeyRetryUntil: new Date(Date.now() - 60_000).toISOString(),
			})

			await withCapturedOutput(async (capture) => {
				const exitCode = await runReconcilePostQueue(reconcilePostCtx(), {
					command: 'reconcile-post',
					execute: true,
					queue: './queue.json',
					postRun: './post-run.json',
				})
				expect(exitCode).toBe(5)
				const payload = JSON.parse(capture.getStdout().trim())
				expect(payload.error.code).toBe('E_CONFLICT')
			})
		})
	})
})
