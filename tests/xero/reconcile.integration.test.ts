import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runReconcile } from '../../src/cli/commands/reconcile'
import { resolveEventsConfig } from '../../src/events'
import { InMemoryAuthProvider, resetAuthProvider, setAuthProvider } from '../../src/xero/auth'
import { resetEnvConfigCache } from '../../src/xero/config'
import {
	withCapturedOutput,
	withPatchedBunStdin,
	withPatchedFetch,
} from '../helpers/test-isolation'
import { createXeroMockServer, type MockRoute } from '../helpers/xero-mock-server'

function createTestTokens() {
	return {
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: Date.now() + 10 * 60_000,
	}
}

function reconcileContext() {
	return {
		json: true,
		quiet: true,
		headless: false,
		logLevel: 'silent' as const,
		progressMode: 'off' as const,
		eventsConfig: resolveEventsConfig(),
	}
}

async function withMockServer<T>(routes: MockRoute[], fn: (url: string) => Promise<T>): Promise<T> {
	const server = createXeroMockServer(routes)
	try {
		return await fn(server.url)
	} finally {
		server.stop()
	}
}

async function runReconcileWithInput(input: string, execute: boolean) {
	let stdout = ''
	const exitCode = await withPatchedBunStdin(input, async () =>
		withCapturedOutput(async (capture) => {
			const result = await runReconcile(reconcileContext(), {
				command: 'reconcile',
				execute,
				fromCsv: null,
			})
			stdout = capture.getStdout()
			return result
		}),
	)
	return { exitCode, stdout }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), 'xero-cli-'))
	const originalCwd = process.cwd()
	process.chdir(dir)
	try {
		return await fn(dir)
	} finally {
		process.chdir(originalCwd)
		await rm(dir, { recursive: true, force: true })
	}
}

async function writeConfig(): Promise<void> {
	await writeFile('.xero-config.json', JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }), {
		mode: 0o600,
	})
}

function baseRoutes(
	ids: string[],
	totals: number[],
	options?: { includePost?: boolean },
): MockRoute[] {
	const routes: MockRoute[] = [
		{
			method: 'GET',
			path: '/BankTransactions',
			response: (req) => {
				const url = new URL(req.url)
				const idsParam = url.searchParams.get('IDs')
				// Batch prefetch: return full records for the requested IDs
				if (idsParam) {
					const requestedIds = idsParam.split(',')
					return {
						status: 200,
						body: {
							BankTransactions: requestedIds.map((id) => {
								const idx = ids.indexOf(id)
								return {
									BankTransactionID: id,
									Type: 'SPEND',
									Total: idx >= 0 ? (totals[idx] ?? 10) : 10,
									BankAccount: { AccountID: 'bank-1' },
									LineItems: [],
								}
							}),
						},
					}
				}
				// Unreconciled snapshot: return the full list
				return {
					status: 200,
					body: {
						BankTransactions: ids.map((id, index) => ({
							BankTransactionID: id,
							Type: 'SPEND',
							Total: totals[index] ?? 0,
						})),
					},
				}
			},
		},
		{
			method: 'GET',
			path: '/Accounts',
			response: {
				status: 200,
				body: { Accounts: [{ Code: '400', Status: 'ACTIVE' }] },
			},
		},
		{
			method: 'GET',
			path: /^\/BankTransactions\//,
			response: (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? ''
				return {
					status: 200,
					body: {
						BankTransactions: [
							{
								BankTransactionID: id,
								Total: 10,
								BankAccount: { AccountID: 'bank-1' },
								LineItems: [],
							},
						],
					},
				}
			},
		},
	]
	if (options?.includePost ?? true) {
		routes.push({
			method: 'POST',
			path: /^\/BankTransactions\//,
			response: (req) => {
				const id = new URL(req.url).pathname.split('/').pop() ?? ''
				const idx = ids.indexOf(id)
				return {
					status: 200,
					body: {
						BankTransactions: [
							{ BankTransactionID: id, Total: idx >= 0 ? (totals[idx] ?? 10) : 10 },
						],
					},
				}
			},
		})
	}
	return routes
}

beforeEach(() => {
	process.env.XERO_CLIENT_ID = 'test-client-id'
	resetEnvConfigCache()
})

afterEach(() => {
	resetAuthProvider()
	delete process.env.XERO_API_BASE_URL
	delete process.env.XERO_EVENTS_URL
	delete process.env.XERO_EVENTS
	delete process.env.XERO_CLIENT_ID
	resetEnvConfigCache()
})

describe('reconcile integration scenarios', () => {
	it('happy path writes state + audit', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const routes = baseRoutes(
				[
					'11111111-1111-1111-1111-111111111111',
					'22222222-2222-2222-2222-222222222222',
					'33333333-3333-3333-3333-333333333333',
					'44444444-4444-4444-4444-444444444444',
					'55555555-5555-5555-5555-555555555555',
				],
				[10, 20, 30, 40, 50],
			)
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
				{ BankTransactionID: '22222222-2222-2222-2222-222222222222', AccountCode: '400' },
				{ BankTransactionID: '33333333-3333-3333-3333-333333333333', AccountCode: '400' },
				{ BankTransactionID: '44444444-4444-4444-4444-444444444444', AccountCode: '400' },
				{ BankTransactionID: '55555555-5555-5555-5555-555555555555', AccountCode: '400' },
			])

			const exitCode = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				const result = await runReconcileWithInput(input, true)
				return result.exitCode
			})

			expect(exitCode).toBe(0)
			const stateRaw = await readFile('.xero-reconcile-state.json', 'utf8')
			const state = JSON.parse(stateRaw) as { processed: Record<string, boolean> }
			expect(Object.keys(state.processed)).toHaveLength(5)

			const auditDir = path.join(process.cwd(), '.xero-reconcile-runs')
			const files = await readdir(auditDir)
			expect(files.length).toBeGreaterThan(0)
		})
	})

	it('mixed success and failures update state only for successes', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const routes: MockRoute[] = [
				...baseRoutes(
					[
						'11111111-1111-1111-1111-111111111111',
						'22222222-2222-2222-2222-222222222222',
						'33333333-3333-3333-3333-333333333333',
						'44444444-4444-4444-4444-444444444444',
						'55555555-5555-5555-5555-555555555555',
					],
					[10, 20, 30, 40, 50],
					{ includePost: false },
				),
				{
					method: 'POST',
					path: '/BankTransactions/44444444-4444-4444-4444-444444444444',
					response: {
						status: 200,
						body: {
							BankTransactions: [
								{
									BankTransactionID: '44444444-4444-4444-4444-444444444444',
									HasValidationErrors: true,
								},
							],
						},
					},
				},
				{
					method: 'POST',
					path: '/BankTransactions/55555555-5555-5555-5555-555555555555',
					response: [
						{ status: 429, body: { error: 'rate limit' } },
						{ status: 400, body: { error: 'rate limit' } },
					],
				},
				{
					method: 'POST',
					path: /^\/BankTransactions\//,
					response: (req) => {
						const id = new URL(req.url).pathname.split('/').pop() ?? ''
						const mixedIds = [
							'11111111-1111-1111-1111-111111111111',
							'22222222-2222-2222-2222-222222222222',
							'33333333-3333-3333-3333-333333333333',
							'44444444-4444-4444-4444-444444444444',
							'55555555-5555-5555-5555-555555555555',
						]
						const mixedTotals = [10, 20, 30, 40, 50]
						const idx = mixedIds.indexOf(id)
						return {
							status: 200,
							body: {
								BankTransactions: [
									{ BankTransactionID: id, Total: idx >= 0 ? (mixedTotals[idx] ?? 10) : 10 },
								],
							},
						}
					},
				},
			]
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
				{ BankTransactionID: '22222222-2222-2222-2222-222222222222', AccountCode: '400' },
				{ BankTransactionID: '33333333-3333-3333-3333-333333333333', AccountCode: '400' },
				{ BankTransactionID: '44444444-4444-4444-4444-444444444444', AccountCode: '400' },
				{ BankTransactionID: '55555555-5555-5555-5555-555555555555', AccountCode: '400' },
			])
			const { exitCode, stdout } = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				return await runReconcileWithInput(input, true)
			})

			// Exit code should be 1 (EXIT_RUNTIME) when any items failed
			expect(exitCode).toBe(1)
			const payload = JSON.parse(stdout)
			expect(payload.data.summary.succeeded).toBe(3)
			expect(payload.data.summary.failed).toBe(2)

			const stateRaw = await readFile('.xero-reconcile-state.json', 'utf8')
			const state = JSON.parse(stateRaw) as { processed: Record<string, boolean> }
			expect(Object.keys(state.processed)).toHaveLength(3)
		})
	})

	it('resume after interruption skips processed items', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const resumeIds = [
				'11111111-1111-1111-1111-111111111111',
				'22222222-2222-2222-2222-222222222222',
				'33333333-3333-3333-3333-333333333333',
				'44444444-4444-4444-4444-444444444444',
				'55555555-5555-5555-5555-555555555555',
			]
			const resumeTotals = [10, 20, 30, 40, 50]
			let callCount = 0
			const routes: MockRoute[] = [
				...baseRoutes(resumeIds, resumeTotals, { includePost: false }),
				{
					method: 'POST',
					path: /^\/BankTransactions\//,
					response: (req) => {
						callCount += 1
						if (callCount === 3) {
							process.emit('SIGINT')
						}
						const id = new URL(req.url).pathname.split('/').pop() ?? ''
						const idx = resumeIds.indexOf(id)
						return {
							status: 200,
							body: {
								BankTransactions: [
									{ BankTransactionID: id, Total: idx >= 0 ? (resumeTotals[idx] ?? 10) : 10 },
								],
							},
						}
					},
				},
			]
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
				{ BankTransactionID: '22222222-2222-2222-2222-222222222222', AccountCode: '400' },
				{ BankTransactionID: '33333333-3333-3333-3333-333333333333', AccountCode: '400' },
				{ BankTransactionID: '44444444-4444-4444-4444-444444444444', AccountCode: '400' },
				{ BankTransactionID: '55555555-5555-5555-5555-555555555555', AccountCode: '400' },
			])

			const { exitCode1, exitCode2, stdout2 } = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				const first = await runReconcileWithInput(input, true)
				const second = await runReconcileWithInput(input, true)
				return {
					exitCode1: first.exitCode,
					exitCode2: second.exitCode,
					stdout2: second.stdout,
				}
			})

			expect(exitCode1).toBe(130)

			expect(exitCode2).toBe(0)
			const payload = JSON.parse(stdout2)
			const skipped = payload.data.results.filter((r: { status: string }) => r.status === 'skipped')
			const reconciled = payload.data.results.filter(
				(r: { status: string }) => r.status === 'reconciled',
			)
			expect(skipped.length).toBeGreaterThanOrEqual(3)
			expect(reconciled.length).toBe(2)
		})
	})

	it('rejects duplicate BankTransactionIDs', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const routes = baseRoutes(['11111111-1111-1111-1111-111111111111'], [10])
			const input = JSON.stringify([
				{ BankTransactionID: 'dup', AccountCode: '400' },
				{ BankTransactionID: 'dup', AccountCode: '400' },
			])
			const exitCode = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				const result = await runReconcileWithInput(input, false)
				return result.exitCode
			})

			expect(exitCode).toBe(2)
		})
	})

	it('treats stale updates as skipped', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const routes: MockRoute[] = [
				...baseRoutes(['11111111-1111-1111-1111-111111111111'], [10], { includePost: false }),
				{
					method: 'POST',
					path: '/BankTransactions/11111111-1111-1111-1111-111111111111',
					response: {
						status: 409,
						body: { error: 'conflict' },
					},
				},
			]
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
			])
			const { exitCode, stdout } = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				return await runReconcileWithInput(input, true)
			})

			expect(exitCode).toBe(0)
			const payload = JSON.parse(stdout)
			const skipped = payload.data.results.filter((r: { status: string }) => r.status === 'skipped')
			expect(skipped).toHaveLength(1)
		})
	})

	it('processes invoice payments in a batch', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const invoiceIds = [
				'11111111-1111-1111-1111-111111111111',
				'22222222-2222-2222-2222-222222222222',
				'33333333-3333-3333-3333-333333333333',
			]
			const invoiceTotals: Record<string, number> = {
				'11111111-1111-1111-1111-111111111111': 120,
				'22222222-2222-2222-2222-222222222222': 80,
				'33333333-3333-3333-3333-333333333333': 50,
			}
			const routes: MockRoute[] = [
				{
					method: 'GET',
					path: '/BankTransactions',
					response: (req) => {
						const url = new URL(req.url)
						const idsParam = url.searchParams.get('IDs')
						// Batch prefetch: return full records for the requested IDs
						if (idsParam) {
							const requestedIds = idsParam.split(',')
							return {
								status: 200,
								body: {
									BankTransactions: requestedIds.map((id) => ({
										BankTransactionID: id,
										Type: 'RECEIVE',
										Total: invoiceTotals[id] ?? 10,
										BankAccount: { AccountID: 'bank-1' },
										LineItems: [],
									})),
								},
							}
						}
						// Unreconciled snapshot
						return {
							status: 200,
							body: {
								BankTransactions: invoiceIds.map((id) => ({
									BankTransactionID: id,
									Type: 'RECEIVE',
									Total: invoiceTotals[id] ?? 10,
								})),
							},
						}
					},
				},
				{
					method: 'GET',
					path: '/Accounts',
					response: {
						status: 200,
						body: { Accounts: [{ Code: '400', Status: 'ACTIVE' }] },
					},
				},
				{
					method: 'GET',
					path: /^\/Invoices/,
					response: {
						status: 200,
						body: {
							Invoices: [
								{
									InvoiceID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
									Status: 'AUTHORISED',
									AmountDue: 120,
									CurrencyCode: 'AUD',
								},
								{
									InvoiceID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
									Status: 'AUTHORISED',
									AmountDue: 80,
									CurrencyCode: 'AUD',
								},
								{
									InvoiceID: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
									Status: 'AUTHORISED',
									AmountDue: 50,
									CurrencyCode: 'AUD',
								},
							],
						},
					},
				},
				{
					method: 'GET',
					path: /^\/BankTransactions\//,
					response: (req) => {
						const id = new URL(req.url).pathname.split('/').pop() ?? ''
						return {
							status: 200,
							body: {
								BankTransactions: [
									{
										BankTransactionID: id,
										Type: 'RECEIVE',
										Total: invoiceTotals[id] ?? 10,
										BankAccount: { AccountID: 'bank-1' },
										LineItems: [],
									},
								],
							},
						}
					},
				},
				{
					method: 'PUT',
					path: '/Payments',
					response: {
						status: 200,
						body: {
							Payments: [
								{ PaymentID: 'pay-1', Amount: 120 },
								{ PaymentID: 'pay-2', Amount: 80 },
								{ PaymentID: 'pay-3', Amount: 50 },
							],
						},
					},
				},
			]
			const input = JSON.stringify([
				{
					BankTransactionID: '11111111-1111-1111-1111-111111111111',
					InvoiceID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
					Amount: 120,
					CurrencyCode: 'AUD',
				},
				{
					BankTransactionID: '22222222-2222-2222-2222-222222222222',
					InvoiceID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
					Amount: 80,
					CurrencyCode: 'AUD',
				},
				{
					BankTransactionID: '33333333-3333-3333-3333-333333333333',
					InvoiceID: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
					Amount: 50,
					CurrencyCode: 'AUD',
				},
			])
			const { exitCode, stdout } = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				return await runReconcileWithInput(input, true)
			})

			expect(exitCode).toBe(0)
			const payload = JSON.parse(stdout)
			expect(payload.data.summary.succeeded).toBe(3)

			const stateRaw = await readFile('.xero-reconcile-state.json', 'utf8')
			const state = JSON.parse(stateRaw) as { processed: Record<string, boolean> }
			expect(Object.keys(state.processed)).toHaveLength(3)
		})
	})

	it('refreshes tokens mid-run when expired', async () => {
		await withTempDir(async () => {
			setAuthProvider(
				new InMemoryAuthProvider({
					accessToken: 'expired',
					refreshToken: 'refresh',
					expiresAt: Date.now() - 1000,
				}),
			)
			await writeConfig()

			let refreshCount = 0
			const routes = baseRoutes(['11111111-1111-1111-1111-111111111111'], [10])
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
			])
			const exitCode = await withPatchedFetch(
				(originalFetch) =>
					(async (url, init) => {
						if (url.toString().startsWith('https://identity.xero.com/connect/token')) {
							refreshCount += 1
							return new Response(
								JSON.stringify({
									access_token: 'new-token',
									refresh_token: 'new-refresh',
									expires_in: 3600,
								}),
								{ status: 200 },
							)
						}
						return await originalFetch(url, init)
					}) as typeof fetch,
				async () =>
					await withMockServer(routes, async (serverUrl) => {
						process.env.XERO_API_BASE_URL = serverUrl
						const result = await runReconcileWithInput(input, true)
						return result.exitCode
					}),
			)

			expect(exitCode).toBe(0)
			expect(refreshCount).toBe(1)
		})
	})

	it('dry-run does not write state or audit', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			const routes = baseRoutes(['11111111-1111-1111-1111-111111111111'], [10])
			const input = JSON.stringify([
				{ BankTransactionID: '11111111-1111-1111-1111-111111111111', AccountCode: '400' },
			])
			const exitCode = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				const result = await runReconcileWithInput(input, false)
				return result.exitCode
			})

			expect(exitCode).toBe(0)
			await unlink('.xero-reconcile-state.json').then(
				() => {
					throw new Error('state file should not exist')
				},
				() => undefined,
			)
			await readdir(path.join(process.cwd(), '.xero-reconcile-runs')).then(
				() => {
					throw new Error('audit dir should not exist')
				},
				() => undefined,
			)
		})
	})

	it('paginates unreconciled snapshot across multiple pages', async () => {
		await withTempDir(async () => {
			setAuthProvider(new InMemoryAuthProvider(createTestTokens()))
			await writeConfig()

			// ID on page 1
			const page1Id = '11111111-1111-1111-1111-111111111111'
			// ID on page 2 -- this would be missed without pagination
			const page2Id = '22222222-2222-2222-2222-222222222222'

			// Build exactly 100 filler IDs for page 1 so pagination triggers
			const page1Filler = Array.from({ length: 99 }, (_, i) => {
				const hex = (i + 1).toString(16).padStart(8, '0')
				return `${hex}-0000-0000-0000-000000000000`
			})
			const page1Ids = [page1Id, ...page1Filler]

			const routes: MockRoute[] = [
				{
					method: 'GET',
					path: '/BankTransactions',
					response: (req) => {
						const url = new URL(req.url)
						const idsParam = url.searchParams.get('IDs')
						// Batch prefetch: return full records for the requested IDs
						if (idsParam) {
							const requestedIds = idsParam.split(',')
							return {
								status: 200,
								body: {
									BankTransactions: requestedIds.map((id) => ({
										BankTransactionID: id,
										Total: id === page2Id ? 25 : 10,
										BankAccount: { AccountID: 'bank-1' },
										LineItems: [{ AccountCode: '400' }],
									})),
								},
							}
						}
						// Paginated unreconciled snapshot
						const page = url.searchParams.get('page') ?? '1'
						if (page === '1') {
							return {
								status: 200,
								body: {
									BankTransactions: page1Ids.map((id) => ({
										BankTransactionID: id,
										Type: 'SPEND',
										Total: 10,
									})),
								},
							}
						}
						if (page === '2') {
							return {
								status: 200,
								body: {
									BankTransactions: [{ BankTransactionID: page2Id, Type: 'SPEND', Total: 25 }],
								},
							}
						}
						return { status: 200, body: { BankTransactions: [] } }
					},
				},
				{
					method: 'GET',
					path: '/Accounts',
					response: {
						status: 200,
						body: { Accounts: [{ Code: '400', Status: 'ACTIVE' }] },
					},
				},
				{
					method: 'GET',
					path: /^\/BankTransactions\//,
					response: (req) => {
						const id = new URL(req.url).pathname.split('/').pop() ?? ''
						return {
							status: 200,
							body: {
								BankTransactions: [
									{
										BankTransactionID: id,
										Total: id === page2Id ? 25 : 10,
										BankAccount: { AccountID: 'bank-1' },
										LineItems: [{ AccountCode: '400' }],
									},
								],
							},
						}
					},
				},
				{
					method: 'POST',
					path: /^\/BankTransactions\//,
					response: (req) => {
						const id = new URL(req.url).pathname.split('/').pop() ?? ''
						return {
							status: 200,
							body: {
								BankTransactions: [{ BankTransactionID: id, Total: 10 }],
							},
						}
					},
				},
			]

			// Input references the page-2 ID which would fail without pagination
			const input = JSON.stringify([
				{
					BankTransactionID: page2Id,
					AccountCode: '400',
				},
			])

			const { exitCode, stdout } = await withMockServer(routes, async (serverUrl) => {
				process.env.XERO_API_BASE_URL = serverUrl
				return await runReconcileWithInput(input, false)
			})

			// The page-2 ID should be accepted, not rejected as invalid
			expect(exitCode).toBe(0)
			const payload = JSON.parse(stdout)
			const results = payload.data.results
			expect(results).toHaveLength(1)
			expect(results[0].BankTransactionID).toBe(page2Id)
			expect(results[0].status).not.toBe('error')
		})
	})
})
