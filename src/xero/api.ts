import { setTimeout as delay } from 'node:timers/promises'
import type { z } from 'zod'
import { type EventsConfig, emitEvent } from '../events'
import { getLogContext, getXeroLogger } from '../logging'
import { XeroApiError, XeroAuthError, XeroConflictError } from './errors'

const DEFAULT_BASE_URL = 'https://api.xero.com/api.xro/2.0'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_LIMIT = 2
const MAX_RETRY_AFTER_MS = 60_000
const MAX_BACKOFF_MS = 15_000
let unauthorizedRefreshInFlight: Promise<{ accessToken: string }> | null = null

interface XeroFetchOptions<T> {
	readonly accessToken: string
	readonly tenantId: string
	readonly timeoutMs?: number
	readonly retryLimit?: number
	readonly eventsConfig?: EventsConfig
	readonly schema?: z.ZodType<T>
	readonly onUnauthorized?: () => Promise<{ accessToken: string }>
	readonly onRetry?: (info: {
		readonly reason: 'rate-limit' | 'server-error' | 'timeout'
		readonly backoffMs: number
		readonly status?: number
	}) => void
}

const apiLogger = getXeroLogger(['api'])

function redactTenantId(tenantId: string): string {
	if (tenantId.length <= 8) return '[REDACTED]'
	return `${tenantId.slice(0, 4)}...${tenantId.slice(-4)}`
}

function diagnosticUrl(input: URL): string {
	const clone = new URL(input.toString())
	clone.search = ''
	clone.hash = ''
	return clone.toString()
}

function resolveBaseUrl(): string {
	return process.env.XERO_API_BASE_URL ?? DEFAULT_BASE_URL
}

function shouldRetryStatus(status: number): boolean {
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	)
}

function isScopeRestrictedMessage(message: string): boolean {
	const normalized = message.toLowerCase()
	return (
		normalized.includes('unauthorized_client') &&
		(normalized.includes('invalid scope') ||
			normalized.includes('scope for client'))
	)
}

function headersToRecord(
	headers: RequestInit['headers'] | undefined,
): Record<string, string> {
	if (!headers) return {}
	const out: Record<string, string> = {}
	if (headers instanceof Headers) {
		for (const [key, value] of headers.entries()) {
			out[key] = value
		}
		return out
	}
	if (Array.isArray(headers)) {
		for (const [key, value] of headers) {
			if (!key) continue
			if (typeof value !== 'string') continue
			out[key] = value
		}
		return out
	}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === 'string') out[key] = value
	}
	return out
}

function sanitizeHeadersForLogging(
	headers: RequestInit['headers'] | undefined,
	tenantId: string,
): Record<string, string> {
	const raw = headersToRecord(headers)
	const lowerCased = Object.fromEntries(
		Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]),
	)
	const sanitized: Record<string, string> = {
		accept: lowerCased.accept ?? 'application/json',
		'content-type': lowerCased['content-type'] ?? 'application/json',
		authorization: 'Bearer [REDACTED]',
		'xero-tenant-id': redactTenantId(tenantId),
	}
	for (const [key, value] of Object.entries(lowerCased)) {
		if (
			key.includes('authorization') ||
			key.includes('token') ||
			key.includes('secret')
		) {
			sanitized[key] = '[REDACTED]'
			continue
		}
		if (key === 'xero-tenant-id') {
			sanitized[key] = redactTenantId(value)
			continue
		}
		sanitized[key] = value
	}
	return sanitized
}

function resolveBackoffMs(options: {
	readonly retryAfterSeconds: number
	readonly attempt: number
	readonly reason: 'rate-limit' | 'server-error' | 'timeout'
}): number {
	const retryAfterMs =
		options.retryAfterSeconds > 0
			? Math.min(options.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
			: 0
	if (retryAfterMs > 0) return retryAfterMs
	const exponential = Math.min(
		1000 * 2 ** (options.attempt - 1),
		MAX_BACKOFF_MS,
	)
	const jitter = options.attempt > 1 ? Math.floor(Math.random() * 250) : 0
	return exponential + jitter
}

async function refreshOnceShared(
	refresh: () => Promise<{ accessToken: string }>,
): Promise<{ accessToken: string }> {
	if (unauthorizedRefreshInFlight) {
		return await unauthorizedRefreshInFlight
	}
	unauthorizedRefreshInFlight = refresh()
	try {
		return await unauthorizedRefreshInFlight
	} finally {
		unauthorizedRefreshInFlight = null
	}
}

/** Map an HTTP status to a structured error. Throws XeroAuthError for 401/403. */
function mapHttpError(
	status: number,
	message: string,
	context?: Record<string, unknown>,
): XeroApiError | XeroConflictError | never {
	if (status === 401 || status === 403) {
		const code = isScopeRestrictedMessage(message)
			? 'E_SCOPE_RESTRICTED'
			: 'E_UNAUTHORIZED'
		throw new XeroAuthError(message, {
			code,
			recoverable: false,
		})
	}
	if (status === 409 || status === 412) {
		return new XeroConflictError(message, {
			code: 'E_CONFLICT',
			recoverable: true,
		})
	}
	if (status === 429) {
		return new XeroApiError(message, {
			code: 'E_RATE_LIMITED',
			recoverable: true,
			status,
			context,
		})
	}
	if (status >= 500) {
		return new XeroApiError(message, {
			code: 'E_SERVER_ERROR',
			recoverable: true,
			status,
			context,
		})
	}
	return new XeroApiError(message, {
		code: 'E_REQUEST_ERROR',
		recoverable: false,
		status,
		context,
	})
}

/** Perform a Xero API request with retry + timeout handling. */
export async function xeroFetch<T>(
	path: string,
	init: RequestInit,
	options: XeroFetchOptions<T>,
): Promise<T> {
	const baseUrl = resolveBaseUrl().replace(/\/$/, '')
	const normalizedPath = path.startsWith('/') ? path : `/${path}`
	const url = new URL(`${baseUrl}${normalizedPath}`)
	const safeUrl = diagnosticUrl(url)
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT
	const eventsConfig = options.eventsConfig ?? { url: null }

	let token = options.accessToken
	let attempt = 0
	let didRefreshAfterUnauthorized = false
	while (true) {
		attempt += 1
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		const startTime = performance.now()

		try {
			apiLogger.debug(
				'Request {method} {url} (timeout={timeoutMs}ms, attempt={attempt})',
				{
					method: init.method ?? 'GET',
					url: safeUrl,
					timeoutMs,
					attempt,
					...getLogContext(),
				},
			)
			apiLogger.debug('Request headers {headers}', {
				headers: sanitizeHeadersForLogging(init.headers, options.tenantId),
				...getLogContext(),
			})
			emitEvent(eventsConfig, 'xero-fetch-started', {
				method: init.method ?? 'GET',
				url: safeUrl,
			})

			const response = await fetch(url, {
				...init,
				signal: controller.signal,
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
					'Xero-tenant-id': options.tenantId,
					...(init.headers ?? {}),
				},
			})

			if (!response.ok) {
				const durationMs = Math.round(performance.now() - startTime)
				apiLogger.debug(
					'Response {status} from {method} {url} in {durationMs}ms',
					{
						status: response.status,
						method: init.method ?? 'GET',
						url: safeUrl,
						durationMs,
						...getLogContext(),
					},
				)
				const payload = await response.text().catch(() => '')
				const message = payload
					? `Xero API error (${response.status}): ${payload}`
					: `Xero API error (${response.status})`

				if (
					(response.status === 401 || response.status === 403) &&
					options.onUnauthorized &&
					!didRefreshAfterUnauthorized
				) {
					didRefreshAfterUnauthorized = true
					apiLogger.warn(
						'Unauthorized response, refreshing token and retrying once.',
						{
							status: response.status,
							url: safeUrl,
						},
					)
					const refreshed = await refreshOnceShared(options.onUnauthorized)
					token = refreshed.accessToken
					continue
				}

				if (shouldRetryStatus(response.status) && attempt <= retryLimit + 1) {
					const retryAfter = Number(response.headers.get('retry-after') ?? '0')
					const reason = response.status === 429 ? 'rate-limit' : 'server-error'
					const backoff = resolveBackoffMs({
						retryAfterSeconds: retryAfter,
						attempt,
						reason,
					})
					if (response.status === 429) {
						apiLogger.warn(
							'Rate limited (429). Retry-After={retryAfter}s, backoff={backoff}ms, attempt={attempt}',
							{
								status: response.status,
								retryAfter,
								backoff,
								attempt,
								...getLogContext(),
							},
						)
						emitEvent(eventsConfig, 'xero-fetch-rate-limited', {
							url: safeUrl,
							retryAfterMs: backoff,
							attempt,
						})
					} else {
						apiLogger.warn(
							'Retrying after HTTP {status} in {backoff}ms (attempt={attempt})',
							{
								status: response.status,
								backoff,
								attempt,
								...getLogContext(),
							},
						)
					}
					options.onRetry?.({
						reason,
						backoffMs: backoff,
						status: response.status,
					})
					emitEvent(eventsConfig, 'xero-fetch-retry', {
						status: response.status,
						backoffMs: backoff,
						reason,
						url: safeUrl,
					})
					await delay(backoff)
					continue
				}

				const retryAfter = Number(response.headers.get('retry-after') ?? '0')
				throw mapHttpError(response.status, message, {
					url: safeUrl,
					retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : undefined,
				})
			}

			const durationMs = Math.round(performance.now() - startTime)
			let rawData: unknown
			try {
				rawData = await response.json()
			} catch {
				throw new XeroApiError('Malformed JSON response from Xero API', {
					code: 'E_MALFORMED_RESPONSE',
					recoverable: false,
					status: response.status,
					context: {
						url: safeUrl,
						status: response.status,
					},
				})
			}
			const data = options.schema
				? (() => {
						const validated = options.schema.safeParse(rawData)
						if (!validated.success) {
							throw new XeroApiError('Xero API response shape mismatch', {
								code: 'E_MALFORMED_RESPONSE',
								recoverable: false,
								status: response.status,
								context: {
									url: safeUrl,
									details: validated.error.issues.map((issue) => issue.message),
								},
							})
						}
						return validated.data
					})()
				: (rawData as T)
			apiLogger.debug(
				'Response {status} from {method} {url} in {durationMs}ms',
				{
					status: response.status,
					method: init.method ?? 'GET',
					url: safeUrl,
					durationMs,
					...getLogContext(),
				},
			)
			emitEvent(eventsConfig, 'xero-fetch-completed', {
				method: init.method ?? 'GET',
				url: safeUrl,
				status: response.status,
				durationMs,
				contentLength:
					Number(response.headers.get('content-length') ?? '0') || undefined,
			})
			return data
		} catch (err) {
			if (
				err instanceof XeroApiError ||
				err instanceof XeroAuthError ||
				err instanceof XeroConflictError
			) {
				emitEvent(eventsConfig, 'xero-fetch-error', {
					message: err.message,
					code: err.code,
					url: safeUrl,
				})
				throw err
			}
			if (err instanceof Error && err.name === 'AbortError') {
				if (attempt <= retryLimit + 1) {
					const backoff = resolveBackoffMs({
						retryAfterSeconds: 0,
						attempt,
						reason: 'timeout',
					})
					apiLogger.warn(
						'Retrying after timeout in {backoff}ms (attempt={attempt})',
						{
							backoff,
							attempt,
							...getLogContext(),
						},
					)
					options.onRetry?.({
						reason: 'timeout',
						backoffMs: backoff,
					})
					emitEvent(eventsConfig, 'xero-fetch-retry', {
						reason: 'timeout',
						backoffMs: backoff,
						url: safeUrl,
					})
					await delay(backoff)
					continue
				}
				emitEvent(eventsConfig, 'xero-fetch-error', {
					message: 'Request timed out',
					code: 'E_NETWORK',
					url: safeUrl,
				})
				throw new XeroApiError('Request timed out', {
					code: 'E_NETWORK',
					recoverable: true,
					context: { url: safeUrl },
				})
			}
			emitEvent(eventsConfig, 'xero-fetch-error', {
				message: 'Network error',
				code: 'E_NETWORK',
				url: safeUrl,
			})
			throw new XeroApiError('Network error', {
				code: 'E_NETWORK',
				recoverable: true,
				context: { url: safeUrl },
			})
		} finally {
			clearTimeout(timeout)
		}
	}
}
