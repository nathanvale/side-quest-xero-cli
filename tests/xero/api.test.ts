import { afterEach, describe, expect, it } from 'bun:test'
import { xeroFetch } from '../../src/xero/api'
import { withPatchedFetch } from '../helpers/test-isolation'

describe('xeroFetch', () => {
	afterEach(() => {
		delete process.env.XERO_API_BASE_URL
	})

	it('retries on 500 and succeeds', async () => {
		let callCount = 0
		const retrySignals: Array<{ reason: string; backoffMs: number }> = []
		const response = await withPatchedFetch(
			() =>
				(async () => {
					callCount += 1
					if (callCount === 1) {
						return new Response(JSON.stringify({ error: 'oops' }), { status: 500 })
					}
					return new Response(JSON.stringify({ Organisations: [] }), { status: 200 })
				}) as typeof fetch,
			async () =>
				await xeroFetch(
					'/Organisation',
					{ method: 'GET' },
					{
						accessToken: 'token',
						tenantId: 'tenant',
						retryLimit: 1,
						onRetry: (info) => {
							retrySignals.push({
								reason: info.reason,
								backoffMs: info.backoffMs,
							})
						},
					},
				),
		)

		expect(response).toEqual({ Organisations: [] })
		expect(retrySignals).toEqual([{ reason: 'server-error', backoffMs: 1000 }])
	})

	it('throws on 404 without retry', async () => {
		await withPatchedFetch(
			() =>
				(async () =>
					new Response(JSON.stringify({ error: 'missing' }), {
						status: 404,
					})) as typeof fetch,
			async () => {
				await expect(
					xeroFetch(
						'/Organisation',
						{ method: 'GET' },
						{
							accessToken: 'token',
							tenantId: 'tenant',
							retryLimit: 0,
						},
					),
				).rejects.toThrow('Xero API error')
			},
		)
	})

	it('throws E_MALFORMED_RESPONSE when body is not JSON', async () => {
		await withPatchedFetch(
			() => (async () => new Response('<html>maintenance</html>', { status: 200 })) as typeof fetch,
			async () => {
				await expect(
					xeroFetch(
						'/Organisation',
						{ method: 'GET' },
						{
							accessToken: 'token',
							tenantId: 'tenant',
							retryLimit: 0,
						},
					),
				).rejects.toMatchObject({ code: 'E_MALFORMED_RESPONSE' })
			},
		)
	})

	it('emits observability events with scrubbed URLs', async () => {
		let apiCallCount = 0
		const events: Array<{ name: string; payload: Record<string, unknown> }> = []

		const response = await withPatchedFetch(
			() =>
				(async (input, init) => {
					const rawUrl = input instanceof Request ? input.url : String(input)
					if (rawUrl.includes('/events/')) {
						const body = init?.body ? JSON.parse(String(init.body)) : {}
						const name = rawUrl.split('/events/')[1] ?? 'unknown'
						events.push({ name, payload: body.payload ?? {} })
						return new Response(null, { status: 202 })
					}
					apiCallCount += 1
					if (apiCallCount === 1) {
						return new Response(JSON.stringify({ error: 'rate-limited' }), {
							status: 429,
							headers: { 'retry-after': '0' },
						})
					}
					return new Response(JSON.stringify({ Organisations: [] }), { status: 200 })
				}) as typeof fetch,
			async () =>
				await xeroFetch(
					'/Organisation?tenant=abc',
					{ method: 'GET' },
					{
						accessToken: 'token',
						tenantId: 'tenant-secret-id',
						retryLimit: 1,
						eventsConfig: { url: 'https://events.example.test' },
					},
				),
		)

		expect(response).toEqual({ Organisations: [] })
		expect(events.some((event) => event.name === 'xero-fetch-started')).toBe(true)
		expect(events.some((event) => event.name === 'xero-fetch-retry')).toBe(true)
		expect(events.some((event) => event.name === 'xero-fetch-completed')).toBe(true)
		for (const event of events) {
			if (typeof event.payload.url === 'string') {
				expect(event.payload.url).toBe('https://api.xero.com/api.xro/2.0/Organisation')
			}
		}
	})
})
