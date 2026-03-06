import { afterEach, describe, expect, it } from 'bun:test'
import { emitEvent, resolveEventsConfig } from '../src/events'
import { withPatchedFetch } from './helpers/test-isolation'

describe('resolveEventsConfig', () => {
	afterEach(() => {
		delete process.env.XERO_EVENTS
		delete process.env.XERO_EVENTS_URL
	})

	it('disables events when XERO_EVENTS=0', () => {
		process.env.XERO_EVENTS = '0'
		const config = resolveEventsConfig({ eventsUrl: 'https://events.example.test' })
		expect(config.url).toBeNull()
	})

	it('prefers explicit --events-url over env var', () => {
		process.env.XERO_EVENTS_URL = 'https://env.example.test'
		const config = resolveEventsConfig({ eventsUrl: 'https://flag.example.test' })
		expect(config.url).toBe('https://flag.example.test/')
	})

	it('falls back to env when flag URL is invalid', () => {
		process.env.XERO_EVENTS_URL = 'https://env.example.test'
		const config = resolveEventsConfig({ eventsUrl: 'ftp://invalid.example.test' })
		expect(config.url).toBe('https://env.example.test/')
	})

	it('returns null when only invalid URL is provided', () => {
		const config = resolveEventsConfig({ eventsUrl: 'file:///tmp/events.sock' })
		expect(config.url).toBeNull()
	})
})

describe('emitEvent', () => {
	it('retries once on transient fetch failure', async () => {
		let calls = 0
		let lastBody: Record<string, unknown> | null = null
		await withPatchedFetch(
			() =>
				(async (_input, init) => {
					calls += 1
					lastBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
					if (calls === 1) {
						throw new Error('temporary failure')
					}
					return new Response(null, { status: 204 })
				}) as typeof fetch,
			async () => {
				emitEvent({ url: 'https://events.example.test' }, 'xero-cli-started', {
					command: 'status',
				})
				await waitFor(() => calls === 2)
			},
		)

		expect(calls).toBe(2)
		expect(lastBody).not.toBeNull()
		expect(lastBody?.schemaVersion).toBe(1)
	})

	it('bounds attempts to max retry count when endpoint keeps failing', async () => {
		let calls = 0
		await withPatchedFetch(
			() =>
				(async () => {
					calls += 1
					return new Response(null, { status: 500 })
				}) as typeof fetch,
			async () => {
				emitEvent({ url: 'https://events.example.test' }, 'xero-cli-started', {
					command: 'status',
				})
				await waitFor(() => calls === 2)
			},
		)

		expect(calls).toBe(2)
	})
})

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	throw new Error('Timed out waiting for async event emission')
}
