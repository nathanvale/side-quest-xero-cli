import { randomUUID } from 'node:crypto'

type MockResponseValue = { status: number; body: unknown }

export interface MockRoute {
	readonly method: string
	readonly path: string | RegExp
	readonly response:
		| MockResponseValue
		| MockResponseValue[]
		| ((req: Request, callIndex: number) => MockResponseValue)
}

export function createXeroMockServer(routes: MockRoute[]): {
	url: string
	stop: () => void
} {
	const calls = new Map<string, number>()
	const baseUrl = `http://xero.mock.${randomUUID()}`
	const originalFetch = globalThis.fetch

	function matchRoute(req: Request): MockRoute | null {
		const url = new URL(req.url)
		for (const route of routes) {
			if (route.method.toUpperCase() !== req.method.toUpperCase()) continue
			if (typeof route.path === 'string' && route.path === url.pathname)
				return route
			if (route.path instanceof RegExp && route.path.test(url.pathname))
				return route
		}
		return null
	}

	const handler = (req: Request): Response => {
		const route = matchRoute(req)
		if (!route) {
			return new Response(JSON.stringify({ error: 'Not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		const key = `${req.method}:${req.url}`
		const count = calls.get(key) ?? 0
		calls.set(key, count + 1)

		let response: MockResponseValue
		if (Array.isArray(route.response)) {
			if (route.response.length === 0) {
				throw new Error(`Mock route has empty response array: ${req.url}`)
			}
			response =
				route.response[Math.min(count, route.response.length - 1)] ??
				route.response[0]!
		} else if (typeof route.response === 'function') {
			response = route.response(req, count)
		} else {
			response = route.response
		}

		return new Response(JSON.stringify(response.body), {
			status: response.status,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	const toRequest = (
		input: Parameters<typeof fetch>[0],
		init: Parameters<typeof fetch>[1],
	): Request => {
		if (input instanceof Request) return new Request(input, init)
		if (input instanceof URL) return new Request(input.toString(), init)
		return new Request(input, init)
	}

	const mockFetch = (async (input, init) => {
		const request = toRequest(input, init)
		const requestUrl = new URL(request.url)
		const base = new URL(baseUrl)
		if (requestUrl.origin !== base.origin) {
			return await originalFetch(input, init)
		}
		return handler(request)
	}) as typeof fetch
	if (originalFetch.preconnect) {
		mockFetch.preconnect = originalFetch.preconnect.bind(originalFetch)
	}
	globalThis.fetch = mockFetch

	return {
		url: baseUrl,
		stop: () => {
			if (globalThis.fetch === mockFetch) {
				globalThis.fetch = originalFetch
			}
		},
	}
}
