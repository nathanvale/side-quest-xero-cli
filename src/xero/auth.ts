import { timingSafeEqual } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { sanitizeErrorMessage } from '../cli/output'
import type { EventsConfig } from '../events'
import { emitEvent } from '../events'
import { getXeroLogger } from '../logging'
import { isProcessAlive } from '../util/process'
import { loadEnvConfig, saveXeroConfig } from './config'
import { XeroApiError, XeroAuthError, XeroConflictError } from './errors'

const authLogger = getXeroLogger(['auth'])

const KEYCHAIN_SERVICE = 'xero-cli'
const KEYCHAIN_ACCOUNT = 'default'
const TOKEN_URL = 'https://identity.xero.com/connect/token'
const CONNECTIONS_URL = 'https://api.xero.com/connections'
const REVOCATION_URL = 'https://identity.xero.com/connect/revocation'
const REDIRECT_URI = 'http://localhost:5555/callback'
const AUTH_TIMEOUT_MS = 300_000
const REFRESH_LOCK_FILE = '.xero-token-refresh.lock'
const REFRESH_LOCK_TIMEOUT_MS = 30_000
const AUTH_FETCH_TIMEOUT_MS = 30_000

interface TokenPayload {
	readonly access_token: string
	readonly refresh_token: string
	readonly expires_in: number
	readonly scope?: string
}

export interface StoredTokens {
	readonly accessToken: string
	readonly refreshToken: string
	readonly expiresAt: number
	readonly scope?: string
}

const TokenSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number().int().positive(),
	scope: z.string().optional(),
})

interface ConnectionResponse {
	readonly tenantId: string
	readonly tenantName: string
}

const TokenPayloadSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	scope: z.string().optional(),
})

const ConnectionsResponseSchema = z.array(
	z.object({
		tenantId: z.string().min(1),
		tenantName: z.string().min(1),
	}),
)
const RefreshLockSchema = z.object({
	pid: z.number().int().positive().optional(),
	createdAt: z.number().int().nonnegative().optional(),
})

/** Check if running in a test environment (bun test sets NODE_ENV=test). */
function isTestEnvironment(): boolean {
	return process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test'
}

function base64UrlEncode(data: Uint8Array): string {
	return Buffer.from(data)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
}

function generateCodeVerifier(): string {
	const buffer = new Uint8Array(48)
	crypto.getRandomValues(buffer)
	return base64UrlEncode(buffer)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	)
	return base64UrlEncode(new Uint8Array(hash))
}

function buildAuthUrl(
	codeChallenge: string,
	state: string,
	scope: string,
): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: loadEnvConfig().clientId,
		redirect_uri: REDIRECT_URI,
		scope,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state,
	})
	return `https://login.xero.com/identity/connect/authorize?${params}`
}

/** Detect whether we are running in a headless/non-interactive environment. */
export function isHeadless(): boolean {
	if (process.env.XERO_HEADLESS === '1') return true
	return !process.stdout.isTTY
}

function openBrowser(url: string): void {
	Bun.spawn(['open', url], { stdio: ['ignore', 'ignore', 'ignore'] })
}

function parseJsonWithSchema<T>(
	raw: string,
	schema: z.ZodType<T>,
	fallbackMessage: string,
): T {
	try {
		const parsed = JSON.parse(raw) as unknown
		const validated = schema.safeParse(parsed)
		if (!validated.success) {
			throw new XeroAuthError(fallbackMessage, {
				code: 'E_MALFORMED_RESPONSE',
				recoverable: false,
			})
		}
		return validated.data
	} catch {
		throw new XeroAuthError(fallbackMessage, {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
}

function parseKeychainOutput(raw: string): StoredTokens | null {
	if (!raw.trim()) return null
	const parsed = parseJsonWithSchema<StoredTokens>(
		raw,
		TokenSchema,
		'Corrupted tokens in Keychain. Re-auth required.',
	)
	return parsed
}

function classifyKeychainError(message: string): {
	readonly code: string
	readonly message: string
} {
	const normalized = message.toLowerCase()
	if (normalized.includes('could not be found')) {
		return { code: 'E_NOT_FOUND', message: 'Keychain entry not found' }
	}
	if (normalized.includes('user interaction is not allowed')) {
		return { code: 'E_KEYCHAIN_LOCKED', message: 'Keychain is locked' }
	}
	if (
		normalized.includes('authorization denied') ||
		normalized.includes('not permitted')
	) {
		return { code: 'E_KEYCHAIN_DENIED', message: 'Keychain access denied' }
	}
	return { code: 'E_KEYCHAIN_ERROR', message: `Keychain error: ${message}` }
}

async function readKeychain(): Promise<StoredTokens | null> {
	if (process.env.XERO_TEST_TOKENS) {
		if (!isTestEnvironment()) {
			authLogger.warn(
				'XERO_TEST_TOKENS is set but NODE_ENV/BUN_ENV is not "test" -- ignoring for safety.',
			)
		} else {
			const parsed = parseJsonWithSchema<StoredTokens>(
				process.env.XERO_TEST_TOKENS,
				TokenSchema,
				'Invalid XERO_TEST_TOKENS payload',
			)
			return parsed
		}
	}
	authLogger.debug('Reading tokens from Keychain.')
	const proc = Bun.spawn([
		'security',
		'find-generic-password',
		'-s',
		KEYCHAIN_SERVICE,
		'-a',
		KEYCHAIN_ACCOUNT,
		'-w',
	])

	const output = await streamToString(proc.stdout ?? null)
	const errorOutput = await streamToString(proc.stderr ?? null)
	const exitCode = await proc.exited
	if (exitCode === 0) {
		const tokens = parseKeychainOutput(output)
		authLogger.debug('Keychain read result: token={token}', {
			token: tokens ? 'present' : 'missing',
		})
		return tokens
	}
	const info = classifyKeychainError(errorOutput.trim())
	if (info.code === 'E_NOT_FOUND' || errorOutput.trim() === '') {
		authLogger.debug('Keychain entry not found.')
		return null
	}
	throw new XeroAuthError(info.message, {
		code: info.code,
		recoverable: false,
	})
}

/**
 * Write tokens to the macOS Keychain.
 *
 * Security: The token payload is passed via an environment variable rather than
 * a command-line argument. CLI args are visible to all users via `ps aux`, but
 * env vars are only readable by the process owner (not exposed by `ps` on
 * macOS). We spawn `sh -c` which reads $__XERO_KCP and forwards it as the
 * `-w` value to `security add-generic-password`.
 */
async function writeKeychain(tokens: StoredTokens): Promise<void> {
	if (process.env.XERO_TEST_TOKENS && isTestEnvironment()) return
	authLogger.debug('Writing tokens to Keychain.')
	const payload = JSON.stringify(tokens)
	const proc = Bun.spawn(
		[
			'sh',
			'-c',
			`security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -U -w "$__XERO_KCP"`,
		],
		{
			env: { ...process.env, __XERO_KCP: payload },
		},
	)
	const errorOutput = await streamToString(proc.stderr ?? null)
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const info = classifyKeychainError(errorOutput.trim())
		throw new XeroAuthError(info.message, {
			code: info.code,
			recoverable: false,
		})
	}
}

async function deleteKeychain(): Promise<void> {
	if (process.env.XERO_TEST_TOKENS && isTestEnvironment()) return
	authLogger.debug('Deleting tokens from Keychain.')
	const proc = Bun.spawn([
		'security',
		'delete-generic-password',
		'-s',
		KEYCHAIN_SERVICE,
		'-a',
		KEYCHAIN_ACCOUNT,
	])
	const errorOutput = await streamToString(proc.stderr ?? null)
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const info = classifyKeychainError(errorOutput.trim())
		if (info.code === 'E_NOT_FOUND') return
		throw new XeroAuthError(info.message, {
			code: info.code,
			recoverable: false,
		})
	}
}

export interface AuthProvider {
	readonly loadTokens: () => Promise<StoredTokens | null>
	readonly saveTokens: (tokens: StoredTokens) => Promise<void>
	readonly deleteTokens: () => Promise<void>
}

class KeychainAuthProvider implements AuthProvider {
	async loadTokens(): Promise<StoredTokens | null> {
		return await readKeychain()
	}
	async saveTokens(tokens: StoredTokens): Promise<void> {
		await writeKeychain(tokens)
	}
	async deleteTokens(): Promise<void> {
		await deleteKeychain()
	}
}

export class InMemoryAuthProvider implements AuthProvider {
	private tokens: StoredTokens | null

	constructor(tokens?: StoredTokens | null) {
		this.tokens = tokens ?? null
	}

	async loadTokens(): Promise<StoredTokens | null> {
		return this.tokens
	}

	async saveTokens(tokens: StoredTokens): Promise<void> {
		this.tokens = tokens
	}

	async deleteTokens(): Promise<void> {
		this.tokens = null
	}
}

let authProvider: AuthProvider = new KeychainAuthProvider()

export function setAuthProvider(provider: AuthProvider): void {
	authProvider = provider
}

export function resetAuthProvider(): void {
	authProvider = new KeychainAuthProvider()
}

async function streamToString(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return ''
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	while (true) {
		const { value, done } = await reader.read()
		if (done) break
		if (value) chunks.push(value)
	}
	return Buffer.concat(chunks).toString('utf8')
}

function stateEquals(a: string, b: string): boolean {
	const left = Buffer.from(a)
	const right = Buffer.from(b)
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

async function authFetch(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, {
			...init,
			signal: init.signal ?? AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
		})
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new XeroApiError('Auth request timed out', {
				code: 'E_NETWORK',
				recoverable: true,
				context: { url },
			})
		}
		throw new XeroApiError('Auth network error', {
			code: 'E_NETWORK',
			recoverable: true,
			context: { url },
		})
	}
}

async function parseJsonResponse<T>(
	response: Response,
	url: string,
	schema: z.ZodType<T>,
): Promise<T> {
	try {
		const raw = (await response.json()) as unknown
		const validated = schema.safeParse(raw)
		if (!validated.success) {
			throw new XeroApiError(
				'Malformed JSON response from Xero auth endpoint',
				{
					code: 'E_MALFORMED_RESPONSE',
					recoverable: false,
					status: response.status,
					context: {
						url,
						status: response.status,
						details: validated.error.issues.map((issue) => issue.message),
					},
				},
			)
		}
		return validated.data
	} catch {
		throw new XeroApiError('Malformed JSON response from Xero auth endpoint', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
			status: response.status,
			context: { url, status: response.status },
		})
	}
}

async function exchangeToken(
	code: string,
	verifier: string,
): Promise<StoredTokens> {
	const { clientId } = loadEnvConfig()
	const response = await authFetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	})
	if (!response.ok) {
		const payload = await response.text().catch(() => '')
		const normalized = payload.toLowerCase()
		const scopeRestricted =
			normalized.includes('unauthorized_client') &&
			(normalized.includes('invalid scope') ||
				normalized.includes('scope for client'))
		throw new XeroApiError(`Token exchange failed: ${payload}`, {
			code: scopeRestricted ? 'E_SCOPE_RESTRICTED' : 'E_UNAUTHORIZED',
			recoverable: false,
			status: response.status,
		})
	}
	const data = await parseJsonResponse<TokenPayload>(
		response,
		TOKEN_URL,
		TokenPayloadSchema,
	)
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + data.expires_in * 1000,
		scope: data.scope,
	}
}

async function fetchConnections(
	accessToken: string,
): Promise<ConnectionResponse[]> {
	const response = await authFetch(CONNECTIONS_URL, {
		signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
		},
	})
	if (!response.ok) {
		const payload = await response.text().catch(() => '')
		const normalized = payload.toLowerCase()
		const scopeRestricted =
			normalized.includes('unauthorized_client') &&
			(normalized.includes('invalid scope') ||
				normalized.includes('scope for client'))
		if (response.status === 401 || response.status === 403) {
			throw new XeroAuthError(`Connections fetch failed: ${payload}`, {
				code: scopeRestricted ? 'E_SCOPE_RESTRICTED' : 'E_UNAUTHORIZED',
				recoverable: false,
			})
		}
		throw new XeroApiError(`Connections fetch failed: ${payload}`, {
			code: response.status >= 500 ? 'E_SERVER_ERROR' : 'E_REQUEST_ERROR',
			recoverable: false,
			status: response.status,
		})
	}
	return await parseJsonResponse<ConnectionResponse[]>(
		response,
		CONNECTIONS_URL,
		ConnectionsResponseSchema,
	)
}

async function refreshToken(tokens: StoredTokens): Promise<StoredTokens> {
	const refreshStart = Date.now()
	authLogger.info('Refreshing Xero access token.')
	const { clientId } = loadEnvConfig()
	const response = await authFetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: clientId,
			refresh_token: tokens.refreshToken,
		}),
		signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
	})
	if (!response.ok) {
		const payload = await response.text().catch(() => '')
		if (
			response.status === 400 ||
			response.status === 401 ||
			response.status === 403
		) {
			throw new XeroAuthError(`Token refresh failed: ${payload}`, {
				code: 'E_UNAUTHORIZED',
				recoverable: false,
			})
		}
		if (response.status >= 500) {
			throw new XeroApiError(`Token refresh failed: ${payload}`, {
				code: 'E_SERVER_ERROR',
				recoverable: true,
				status: response.status,
			})
		}
		throw new XeroApiError(`Token refresh failed: ${payload}`, {
			code: 'E_REQUEST_ERROR',
			recoverable: false,
			status: response.status,
		})
	}
	const data = await parseJsonResponse<TokenPayload>(
		response,
		TOKEN_URL,
		TokenPayloadSchema,
	)
	authLogger.info('Token refresh completed in {durationMs}ms', {
		durationMs: Date.now() - refreshStart,
	})
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + data.expires_in * 1000,
		scope: data.scope ?? tokens.scope,
	}
}

export function resolveRefreshLockPath(): string {
	return path.join(tmpdir(), REFRESH_LOCK_FILE)
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
	const lockPath = resolveRefreshLockPath()
	const start = Date.now()
	let lockCreatedAt = 0
	while (true) {
		try {
			lockCreatedAt = Date.now()
			await writeFile(
				lockPath,
				JSON.stringify({ pid: process.pid, createdAt: lockCreatedAt }),
				{ mode: 0o600, flag: 'wx' },
			)
			break
		} catch {
			try {
				const raw = await readFile(lockPath, 'utf8')
				let parsed: { pid?: number; createdAt?: number } | null = null
				try {
					parsed = parseJsonWithSchema(
						raw,
						RefreshLockSchema,
						'Invalid token refresh lock payload',
					)
				} catch {
					authLogger.warn('Unreadable refresh lock JSON, treating as stale', {
						lockPath,
					})
					// Don't unlink -- fall through to the stale-PID check below.
					// A concurrent process may have legitimately rewritten the file.
				}
				if (parsed?.pid && isProcessAlive(parsed.pid)) {
					if (Date.now() - start > REFRESH_LOCK_TIMEOUT_MS) {
						throw new XeroConflictError('Token refresh already in progress', {
							code: 'E_LOCK_CONTENTION',
							recoverable: true,
						})
					}
					await new Promise((resolve) => setTimeout(resolve, 200))
					continue
				}
				await unlink(lockPath)
			} catch (err) {
				if (err instanceof XeroConflictError) throw err
				if (
					err instanceof Error &&
					'code' in err &&
					(err as NodeJS.ErrnoException).code &&
					(err as NodeJS.ErrnoException).code !== 'ENOENT'
				) {
					throw err
				}
				if (Date.now() - start > REFRESH_LOCK_TIMEOUT_MS) {
					throw new XeroConflictError('Token refresh already in progress', {
						code: 'E_LOCK_CONTENTION',
						recoverable: true,
					})
				}
				await new Promise((resolve) => setTimeout(resolve, 200))
			}
		}
	}

	try {
		return await fn()
	} finally {
		try {
			// Only unlink if this process still owns the lock. Another process
			// may have legitimately acquired the lock while fn() was running.
			const raw = await readFile(lockPath, 'utf8')
			const owner = JSON.parse(raw) as {
				pid?: number
				createdAt?: number
			}
			if (owner.pid === process.pid && owner.createdAt === lockCreatedAt) {
				await unlink(lockPath)
			}
		} catch (err) {
			if (
				err instanceof Error &&
				'code' in err &&
				(err as NodeJS.ErrnoException).code === 'ENOENT'
			) {
				// benign race: lock already removed
			} else {
				authLogger.warn('Failed to release refresh lock: {message}', {
					message: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}
}

interface AuthWaitOptions {
	readonly timeoutMs?: number
	readonly onTick?: (remainingMs: number) => void
	/** When true, emit auth_url as NDJSON instead of opening a browser.
	 *  Callers should derive this from OutputContext.headless so there is
	 *  a single source of truth for headless detection. */
	readonly headless?: boolean
	/** Callback for headless auth URL emission handled by the CLI output layer. */
	readonly onAuthUrl?: (authUrl: string) => void
}

function resolveAuthTimeoutMs(defaultMs: number): number {
	const raw = process.env.XERO_AUTH_TIMEOUT_MS
	if (!raw) return defaultMs
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs
	return Math.round(parsed)
}

/** Start the OAuth callback server and return the code promise. */
export async function waitForAuthCode(
	state: string,
	options?: AuthWaitOptions,
): Promise<string> {
	let resolveCode: (code: string) => void
	let rejectCode: (err: Error) => void
	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve
		rejectCode = reject
	})

	const server = Bun.serve({
		port: 5555,
		hostname: '127.0.0.1',
		fetch(req) {
			const url = new URL(req.url)
			if (url.pathname !== '/callback') {
				return new Response('Not found', { status: 404 })
			}
			const code = url.searchParams.get('code')
			const returnedState = url.searchParams.get('state')
			if (!code || !returnedState || !stateEquals(returnedState, state)) {
				rejectCode(
					new XeroAuthError('Invalid auth callback state', {
						code: 'E_USAGE',
						recoverable: false,
					}),
				)
				queueMicrotask(() => server.stop())
				return new Response('Invalid callback', { status: 400 })
			}
			resolveCode(code)
			queueMicrotask(() => server.stop())
			return new Response(
				'<h1>Authenticated</h1><p>You can close this tab.</p>',
				{
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'X-Content-Type-Options': 'nosniff',
						'Cache-Control': 'no-store, no-cache, must-revalidate',
					},
				},
			)
		},
	})

	const timeoutMs = options?.timeoutMs ?? resolveAuthTimeoutMs(AUTH_TIMEOUT_MS)
	const start = Date.now()
	const timeout = setTimeout(() => {
		rejectCode(
			new XeroAuthError(
				`Auth timed out after ${Math.round(timeoutMs / 1000)}s`,
				{
					code: 'E_UNAUTHORIZED',
					recoverable: false,
				},
			),
		)
		server.stop()
	}, timeoutMs)

	const tick = setInterval(() => {
		const remaining = timeoutMs - (Date.now() - start)
		if (remaining <= 0) return
		options?.onTick?.(remaining)
	}, 1000)

	return codePromise.finally(() => {
		clearTimeout(timeout)
		clearInterval(tick)
	})
}

/**
 * Revoke a single token via Xero's revocation endpoint.
 *
 * Per Xero PKCE docs, the Authorization header must be:
 *   Basic base64(client_id + ":")
 * (client_secret is empty for PKCE apps).
 */
async function revokeToken(token: string): Promise<void> {
	const { clientId } = loadEnvConfig()
	const credentials = Buffer.from(`${clientId}:`).toString('base64')
	const response = await authFetch(REVOCATION_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Authorization: `Basic ${credentials}`,
		},
		body: new URLSearchParams({
			token,
		}),
		signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
	})
	if (!response.ok) {
		const payload = await response.text().catch(() => '')
		if (response.status >= 500) {
			throw new XeroApiError(`Token revocation failed: ${payload}`, {
				code: 'E_SERVER_ERROR',
				recoverable: true,
				status: response.status,
			})
		}
		throw new XeroAuthError(`Token revocation failed: ${payload}`, {
			code: 'E_UNAUTHORIZED',
			recoverable: false,
		})
	}
}

async function revokeStoredTokens(tokens: StoredTokens | null): Promise<void> {
	if (!tokens) return
	try {
		await revokeToken(tokens.refreshToken)
	} catch (err) {
		authLogger.warn('Token revocation failed (continuing): {message}', {
			message: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
		})
	}
}

export async function authenticate(
	scope: string,
	options?: AuthWaitOptions,
): Promise<{ tenantId: string }> {
	authLogger.debug('Starting PKCE auth flow with scope={scope}', { scope })
	const verifier = generateCodeVerifier()
	const challenge = await generateCodeChallenge(verifier)
	const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)))
	const authUrl = buildAuthUrl(challenge, state, scope)

	const headless = options?.headless ?? isHeadless()
	if (headless) {
		if (!options?.onAuthUrl) {
			throw new XeroAuthError(
				'Headless auth requires an onAuthUrl callback to deliver the auth URL',
				{ code: 'E_USAGE', recoverable: false },
			)
		}
		authLogger.info('Auth URL prepared for headless flow.')
		options.onAuthUrl(authUrl)
	} else {
		authLogger.info('Opening browser for interactive auth flow.')
		openBrowser(authUrl)
	}
	const code = await waitForAuthCode(state, options)
	authLogger.debug('Auth callback received, exchanging code for tokens.')
	const tokens = await exchangeToken(code, verifier)
	const existing = await authProvider.loadTokens()
	await revokeStoredTokens(existing)
	await authProvider.saveTokens(tokens)
	authLogger.debug('Tokens saved after initial auth.')

	const connections = await fetchConnections(tokens.accessToken)
	const primary = connections[0]
	if (!primary) {
		throw new XeroAuthError('No Xero tenants available', {
			code: 'E_NOT_FOUND',
			recoverable: false,
		})
	}
	await saveXeroConfig({
		tenantId: primary.tenantId,
		orgName: primary.tenantName,
	})
	return { tenantId: primary.tenantId }
}

/** Load tokens from Keychain, validating presence. */
export async function loadTokens(): Promise<StoredTokens> {
	const tokens = await authProvider.loadTokens()
	if (!tokens) {
		throw new XeroAuthError('Not authenticated. Run: bun run xero-cli auth', {
			code: 'E_UNAUTHORIZED',
			recoverable: false,
		})
	}
	return tokens
}

/** Load tokens and refresh if expired (uses refresh lock). */
export async function loadValidTokens(
	eventsConfig?: EventsConfig,
): Promise<StoredTokens> {
	const tokens = await loadTokens()
	if (process.env.XERO_TEST_TOKENS && isTestEnvironment()) return tokens
	if (!isTokenExpired(tokens.expiresAt)) return tokens
	authLogger.debug('Token expired, attempting refresh.')
	const refreshStart = Date.now()
	return await withRefreshLock(async () => {
		authLogger.info('Token refresh lock acquired.')
		const fresh = await authProvider.loadTokens()
		if (!fresh) {
			throw new XeroAuthError('Not authenticated. Run: bun run xero-cli auth', {
				code: 'E_UNAUTHORIZED',
				recoverable: false,
			})
		}
		if (!isTokenExpired(fresh.expiresAt)) {
			authLogger.debug('Token refreshed by another process, skipping.')
			if (eventsConfig) {
				emitEvent(eventsConfig, 'xero-auth-refreshed', {
					skipped: true,
					durationMs: Date.now() - refreshStart,
				})
			}
			return fresh
		}
		let refreshed: StoredTokens
		try {
			if (eventsConfig) {
				emitEvent(eventsConfig, 'xero-auth-refresh-started', {})
			}
			refreshed = await refreshToken(fresh)
		} catch (err) {
			authLogger.warn('Token refresh failed: {message}', {
				message: err instanceof Error ? err.message : String(err),
			})
			if (eventsConfig) {
				emitEvent(eventsConfig, 'xero-auth-refresh-failed', {
					error: err instanceof Error ? err.message : String(err),
				})
			}
			throw err
		}
		try {
			await authProvider.saveTokens(refreshed)
		} catch (saveErr) {
			authLogger.warn(
				'Token refresh succeeded but failed to save tokens: {message}',
				{
					message: saveErr instanceof Error ? saveErr.message : String(saveErr),
				},
			)
			if (eventsConfig) {
				emitEvent(eventsConfig, 'xero-auth-refresh-failed', {
					error: 'Token refresh succeeded but could not save new tokens',
				})
			}
			throw new XeroAuthError(
				'Token refresh succeeded but could not save new tokens. Re-auth required.',
				{ code: 'E_UNAUTHORIZED', recoverable: false },
			)
		}
		authLogger.debug('Token refreshed and saved successfully.')
		if (eventsConfig) {
			emitEvent(eventsConfig, 'xero-auth-refreshed', {
				skipped: false,
				durationMs: Date.now() - refreshStart,
			})
		}
		return refreshed
	})
}

/** Load tokens without throwing on missing. */
export async function loadTokensRaw(): Promise<StoredTokens | null> {
	return await authProvider.loadTokens()
}

/** Best-effort check for expired tokens. */
export function isTokenExpired(
	expiresAt: number,
	skewMs = 5 * 60 * 1000,
): boolean {
	return Date.now() + skewMs >= expiresAt
}
