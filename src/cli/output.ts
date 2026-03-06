import type { EventsConfig } from '../events'
import { getLogContext } from '../logging'
import {
	StructuredError,
	XeroApiError,
	XeroAuthError,
	XeroConflictError,
} from '../xero/errors'

/** Standard exit codes for the CLI process. */
export const EXIT_OK = 0 as const
export const EXIT_RUNTIME = 1 as const
export const EXIT_USAGE = 2 as const
export const EXIT_NOT_FOUND = 3 as const
export const EXIT_UNAUTHORIZED = 4 as const
export const EXIT_CONFLICT = 5 as const
export const EXIT_INTERRUPTED = 130 as const

/** Union of all valid CLI exit codes. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130

/** Schema version embedded in all JSON output envelopes. */
export const SCHEMA_VERSION_OUTPUT = 1
const MAX_RECOMMENDED_DELAY_MS = 5 * 60 * 1000
const MAX_SANITIZE_DEPTH = 6

type LogLevel = 'silent' | 'info' | 'debug'
type ProgressMode = 'animated' | 'static' | 'off'

type ErrorFamily =
	| 'auth'
	| 'scope'
	| 'network'
	| 'rate_limit'
	| 'server'
	| 'validation'
	| 'conflict'
	| 'runtime'
	| 'interrupted'

type HintConfidence = 'high' | 'medium' | 'low'
type TransportRecommendation = 'cli' | 'browser' | 'manual'
type IdempotencyRisk = 'none' | 'low' | 'high'
type HintSource = 'cli_parser' | 'api_layer' | 'auth_layer' | 'workflow_guard'
type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical'
type Recoverability = 'resume' | 'retry' | 'manual' | 'none'

interface AgentHint {
	readonly action: string
	readonly retryable: boolean
	readonly errorFamily: ErrorFamily
	readonly confidence?: HintConfidence
	readonly blocking?: boolean
	readonly nextCommand?: string
	readonly fallbackMode?: string
	readonly transportRecommendation?: TransportRecommendation
	readonly safeToRetrySameInput?: boolean
	readonly idempotencyRisk?: IdempotencyRisk
	readonly canResume?: boolean
	readonly scopeRequired?: readonly string[]
	readonly scopeMissing?: readonly string[]
	readonly suggestedFlags?: readonly string[]
	readonly relatedCommandExamples?: readonly string[]
	readonly requiredPrereqs?: readonly string[]
	readonly suggestedFallbacks?: readonly string[]
	readonly hintSource?: HintSource
	readonly recommendedDelayMs?: number
}

const SENSITIVE_CONTEXT_KEY_PATTERN =
	/(token|secret|password|authorization|api[-_]?key|cookie|session|credential|tenant[-_]?id|xero[-_]?tenant[-_]?id)/i

function clampDelayMs(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
	return Math.min(Math.max(0, Math.round(value)), MAX_RECOMMENDED_DELAY_MS)
}

function sanitizeContextValue(value: unknown, depth = 0): unknown {
	if (depth >= MAX_SANITIZE_DEPTH) return '[TRUNCATED]'
	if (typeof value === 'string') return sanitizeErrorMessage(value)
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeContextValue(item, depth + 1))
	}
	if (value && typeof value === 'object') {
		const input = value as Record<string, unknown>
		const sanitized: Record<string, unknown> = {}
		for (const [key, raw] of Object.entries(input)) {
			if (SENSITIVE_CONTEXT_KEY_PATTERN.test(key)) {
				sanitized[key] = '[REDACTED]'
				continue
			}
			sanitized[key] = sanitizeContextValue(raw, depth + 1)
		}
		return sanitized
	}
	return value
}

function sanitizeErrorContext(
	context?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!context) return undefined
	return sanitizeContextValue(context) as Record<string, unknown>
}

/** Shared context threaded through every command for output formatting.
 *
 * `headless` is true when the CLI should avoid interactive behavior (e.g. no
 * browser launch during auth). Derived from `--json`, non-TTY stdout, or
 * the `XERO_HEADLESS=1` environment variable -- providing a single source of
 * truth so commands never need to re-detect the environment themselves.
 */
export interface OutputContext {
	readonly json: boolean
	readonly quiet: boolean
	readonly headless: boolean
	readonly logLevel: LogLevel
	readonly progressMode: ProgressMode
	readonly eventsConfig: EventsConfig
}

/**
 * Map error codes to action hints for agents.
 * Used by writeError to populate the `action` and `retryable` fields
 * in JSON error output, giving calling agents a machine-readable hint
 * about what to do next.
 */
export const ERROR_CODE_ACTIONS: Record<string, AgentHint> = {
	E_OK: {
		action: 'NONE',
		retryable: false,
		errorFamily: 'runtime',
		confidence: 'high',
		blocking: false,
		transportRecommendation: 'cli',
		idempotencyRisk: 'none',
		hintSource: 'workflow_guard',
	},
	E_NETWORK: {
		action: 'CHECK_NETWORK',
		retryable: true,
		errorFamily: 'network',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'low',
		recommendedDelayMs: 5_000,
		suggestedFallbacks: ['check_network', 'retry_command'],
		relatedCommandExamples: ['bun src/cli/command.ts status --json'],
		hintSource: 'api_layer',
	},
	E_SCOPE_RESTRICTED: {
		action: 'USE_BROWSER_FALLBACK',
		retryable: false,
		errorFamily: 'scope',
		confidence: 'high',
		blocking: false,
		fallbackMode: 'browser_finance_api',
		transportRecommendation: 'browser',
		nextCommand: '/xero-explorer extract',
		idempotencyRisk: 'none',
		scopeMissing: ['finance.bankstatementsplus.read'],
		suggestedFlags: ['--json'],
		suggestedFallbacks: ['use_browser_fallback', 'check_scopes'],
		relatedCommandExamples: ['/xero-explorer extract'],
		hintSource: 'auth_layer',
	},
	E_SERVER_ERROR: {
		action: 'RETRY_WITH_BACKOFF',
		retryable: true,
		errorFamily: 'server',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'low',
		suggestedFallbacks: ['retry_with_backoff', 'check_status'],
		hintSource: 'api_layer',
	},
	E_RATE_LIMITED: {
		action: 'WAIT_AND_RETRY',
		retryable: true,
		errorFamily: 'rate_limit',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'none',
		recommendedDelayMs: 60_000,
		suggestedFallbacks: ['wait_and_retry'],
		hintSource: 'api_layer',
	},
	E_API_ERROR: {
		action: 'RETRY_WITH_BACKOFF',
		retryable: true,
		errorFamily: 'server',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'low',
		suggestedFallbacks: ['retry_with_backoff', 'check_status'],
		hintSource: 'api_layer',
	},
	E_REQUEST_ERROR: {
		action: 'FIX_ARGS',
		retryable: false,
		errorFamily: 'validation',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: false,
		idempotencyRisk: 'none',
		suggestedFallbacks: ['fix_args', 'inspect_and_resolve'],
		hintSource: 'api_layer',
	},
	E_RUNTIME: {
		action: 'ESCALATE',
		retryable: false,
		errorFamily: 'runtime',
		confidence: 'low',
		blocking: true,
		transportRecommendation: 'manual',
		suggestedFallbacks: ['escalate'],
		hintSource: 'workflow_guard',
	},
	E_USAGE: {
		action: 'FIX_ARGS',
		retryable: false,
		errorFamily: 'validation',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		nextCommand: 'bun src/cli/command.ts help',
		idempotencyRisk: 'none',
		suggestedFlags: ['--json', '--help'],
		suggestedFallbacks: ['fix_args', 'show_help'],
		relatedCommandExamples: ['bun src/cli/command.ts help'],
		hintSource: 'cli_parser',
	},
	E_NOT_FOUND: {
		action: 'ESCALATE',
		retryable: false,
		errorFamily: 'runtime',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'manual',
		suggestedFallbacks: ['check_paths', 'escalate'],
		hintSource: 'workflow_guard',
	},
	E_UNAUTHORIZED: {
		action: 'RUN_AUTH',
		retryable: false,
		errorFamily: 'auth',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		nextCommand: 'bun src/cli/command.ts auth',
		idempotencyRisk: 'none',
		scopeRequired: ['offline_access'],
		suggestedFlags: ['--json'],
		requiredPrereqs: ['.env', '.xero-config.json', 'keychain_access'],
		suggestedFallbacks: ['run_auth', 'check_config'],
		relatedCommandExamples: [
			'bun src/cli/command.ts status --json',
			'bun src/cli/command.ts auth',
		],
		hintSource: 'auth_layer',
	},
	E_LOCK_CONTENTION: {
		action: 'WAIT_AND_RETRY',
		retryable: true,
		errorFamily: 'conflict',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'none',
		recommendedDelayMs: 3_000,
		suggestedFallbacks: ['wait_and_retry'],
		hintSource: 'workflow_guard',
	},
	E_KEYCHAIN_LOCKED: {
		action: 'UNLOCK_KEYCHAIN',
		retryable: true,
		errorFamily: 'auth',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'manual',
		safeToRetrySameInput: true,
		idempotencyRisk: 'none',
		suggestedFallbacks: ['unlock_keychain', 'run_auth'],
		hintSource: 'auth_layer',
	},
	E_KEYCHAIN_DENIED: {
		action: 'ALLOW_KEYCHAIN',
		retryable: false,
		errorFamily: 'auth',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'manual',
		safeToRetrySameInput: false,
		idempotencyRisk: 'none',
		suggestedFallbacks: ['allow_keychain', 'run_auth'],
		hintSource: 'auth_layer',
	},
	E_KEYCHAIN_ERROR: {
		action: 'ESCALATE',
		retryable: false,
		errorFamily: 'auth',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'manual',
		idempotencyRisk: 'high',
		suggestedFallbacks: ['escalate'],
		hintSource: 'auth_layer',
	},
	E_STALE_DATA: {
		action: 'REFETCH_AND_RETRY',
		retryable: true,
		errorFamily: 'conflict',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'low',
		suggestedFallbacks: ['refetch_and_retry'],
		hintSource: 'workflow_guard',
	},
	E_CONFLICT: {
		action: 'WAIT_AND_RETRY',
		retryable: true,
		errorFamily: 'conflict',
		confidence: 'medium',
		blocking: true,
		transportRecommendation: 'cli',
		safeToRetrySameInput: true,
		idempotencyRisk: 'low',
		recommendedDelayMs: 2_000,
		suggestedFallbacks: ['wait_and_retry', 'inspect_and_resolve'],
		hintSource: 'workflow_guard',
	},
	E_MALFORMED_RESPONSE: {
		action: 'ESCALATE',
		retryable: false,
		errorFamily: 'runtime',
		confidence: 'high',
		blocking: true,
		transportRecommendation: 'manual',
		safeToRetrySameInput: false,
		idempotencyRisk: 'high',
		suggestedFallbacks: ['escalate'],
		hintSource: 'api_layer',
	},
	E_INTERRUPTED: {
		action: 'NONE',
		retryable: false,
		errorFamily: 'interrupted',
		confidence: 'high',
		blocking: false,
		transportRecommendation: 'cli',
		idempotencyRisk: 'none',
		canResume: true,
		suggestedFallbacks: ['resume_previous_run'],
		hintSource: 'workflow_guard',
	},
}

/**
 * Write successful output in JSON or human mode.
 *
 * When `phase` is provided the JSON envelope includes a `phase` discriminator
 * field, enabling NDJSON two-phase contracts (e.g. headless auth emits an
 * `auth_url` line followed by a `result` line).
 */
export function writeSuccess<T>(
	ctx: OutputContext,
	data: T,
	humanLines: string[],
	quietLine: string,
	warnings?: readonly string[],
	phase?: string,
): void {
	const activeWarnings = warnings && warnings.length > 0 ? warnings : undefined
	if (ctx.json) {
		const envelope: Record<string, unknown> = {
			status: 'data',
			schemaVersion: SCHEMA_VERSION_OUTPUT,
			data,
		}
		if (phase) envelope.phase = phase
		if (activeWarnings) envelope.warnings = activeWarnings
		process.stdout.write(`${JSON.stringify(envelope)}\n`)
		return
	}
	if (activeWarnings) {
		for (const w of activeWarnings) {
			process.stderr.write(`Warning: ${w}\n`)
		}
	}
	if (ctx.quiet) {
		process.stdout.write(`${quietLine}\n`)
		return
	}
	process.stdout.write(`${humanLines.join('\n')}\n`)
}

/** Write structured errors to stderr (JSON in machine mode). */
export function writeError(
	ctx: OutputContext,
	message: string,
	errorCode: string,
	errorName: string,
	context?: Record<string, unknown>,
): void {
	const sanitized = sanitizeErrorMessage(message)
	const sanitizedContext = sanitizeErrorContext(context)
	if (ctx.json) {
		const fallback: AgentHint = {
			action: 'ESCALATE',
			retryable: false,
			errorFamily: 'runtime',
			confidence: 'low',
			blocking: true,
			transportRecommendation: 'manual',
			idempotencyRisk: 'high',
			suggestedFallbacks: ['escalate'],
			hintSource: 'workflow_guard',
		}
		const action = ERROR_CODE_ACTIONS[errorCode] ?? fallback
		const runId = getLogContext()?.runId ?? null
		const retryAfterMs = clampDelayMs(sanitizedContext?.retryAfterMs)
		const defaultDelayMs = clampDelayMs(action.recommendedDelayMs)
		const effectiveDelayMs =
			typeof retryAfterMs === 'number' ? retryAfterMs : defaultDelayMs
		const severity = deriveSeverity(action, errorCode)
		const recoverability = deriveRecoverability(action, sanitizedContext)
		const errorPayload: Record<string, unknown> = {
			name: errorName,
			code: errorCode,
			action: action.action,
			retryable: action.retryable,
			errorFamily: action.errorFamily,
			hintVersion: 2,
			userMessage: sanitized,
			agentMessage: `Action=${action.action}; retryable=${action.retryable}`,
			severity,
			recoverability,
			exitCodeHint: deriveExitCodeHint(errorCode),
		}
		errorPayload.confidence = action.confidence ?? 'medium'
		errorPayload.blocking = action.blocking ?? true
		errorPayload.transportRecommendation =
			action.transportRecommendation ?? 'manual'
		errorPayload.idempotencyRisk = action.idempotencyRisk ?? 'high'
		errorPayload.hintSource = action.hintSource ?? 'workflow_guard'
		if (action.nextCommand) errorPayload.nextCommand = action.nextCommand
		if (action.fallbackMode) errorPayload.fallbackMode = action.fallbackMode
		if (typeof action.safeToRetrySameInput === 'boolean') {
			errorPayload.safeToRetrySameInput = action.safeToRetrySameInput
		}
		if (typeof action.canResume === 'boolean') {
			errorPayload.canResume = action.canResume
		}
		if (action.scopeRequired) {
			errorPayload.scopeRequired = action.scopeRequired
		}
		if (action.scopeMissing) {
			errorPayload.scopeMissing = action.scopeMissing
		}
		if (action.suggestedFlags) {
			errorPayload.suggestedFlags = action.suggestedFlags
		}
		if (action.relatedCommandExamples) {
			errorPayload.relatedCommandExamples = action.relatedCommandExamples
		}
		if (action.requiredPrereqs) {
			errorPayload.requiredPrereqs = action.requiredPrereqs
		}
		if (action.suggestedFallbacks) {
			errorPayload.suggestedFallbacks = action.suggestedFallbacks
		}
		if (typeof retryAfterMs === 'number') {
			errorPayload.retryAfterMs = retryAfterMs
		}
		if (typeof effectiveDelayMs === 'number') {
			errorPayload.recommendedDelayMs = effectiveDelayMs
		}
		if (runId) {
			errorPayload.runId = runId
		}
		errorPayload.timeContext = {
			timestamp: new Date().toISOString(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
		}
		if (sanitizedContext && typeof sanitizedContext.command === 'string') {
			errorPayload.command = sanitizedContext.command
		}
		if (sanitizedContext && typeof sanitizedContext.status === 'number') {
			errorPayload.httpStatus = sanitizedContext.status
		}
		if (sanitizedContext && typeof sanitizedContext.stateFile === 'string') {
			errorPayload.stateFile = sanitizedContext.stateFile
		}
		if (sanitizedContext && typeof sanitizedContext.checkpointId === 'string') {
			errorPayload.checkpointId = sanitizedContext.checkpointId
		}
		if (
			errorPayload.canResume === undefined &&
			sanitizedContext &&
			(typeof sanitizedContext.stateFile === 'string' ||
				typeof sanitizedContext.checkpointId === 'string')
		) {
			errorPayload.canResume = true
		}
		if (sanitizedContext && Array.isArray(sanitizedContext.scopeRequired)) {
			errorPayload.scopeRequired = sanitizedContext.scopeRequired
		}
		if (sanitizedContext && Array.isArray(sanitizedContext.scopeMissing)) {
			errorPayload.scopeMissing = sanitizedContext.scopeMissing
		}
		errorPayload.agentActions = buildAgentActions(action)
		errorPayload.fingerprint = createErrorFingerprint(
			errorCode,
			action.action,
			action.errorFamily,
			sanitizedContext,
		)
		if (sanitizedContext) errorPayload.context = sanitizedContext
		// JSON mode: error envelope goes to stdout so agents parse a single stream
		process.stdout.write(
			`${JSON.stringify({
				status: 'error',
				message: sanitized,
				error: errorPayload,
			})}\n`,
		)
		return
	}
	const line = ctx.quiet ? sanitized : `[xero-cli] ${sanitized}`
	process.stderr.write(`${line}\n`)
}

/**
 * Project a subset of fields from each record using dot-path notation.
 * Returns the original records unchanged when fields is null.
 */
export function projectFields<T extends Record<string, unknown>>(
	records: T[],
	fields: readonly string[] | null,
): Record<string, unknown>[] {
	if (!fields) return records
	return records.map((record) => {
		const projected: Record<string, unknown> = {}
		for (const field of fields) {
			const parts = field.split('.')
			let value: unknown = record
			for (const part of parts) {
				if (value && typeof value === 'object' && part in value) {
					value = (value as Record<string, unknown>)[part]
				} else {
					value = undefined
					break
				}
			}
			projected[field] = value
		}
		return projected
	})
}

/**
 * Detect projected fields that are undefined in ALL records.
 * When every record has undefined for a given field, it is almost certainly
 * a typo rather than legitimately missing data. Returns warning messages
 * for each such field. Skips detection when there are no records (empty
 * result sets should not produce false positives).
 */
export function detectAllUndefinedFields(
	records: Record<string, unknown>[],
	fields: readonly string[] | null,
): string[] {
	if (!fields || records.length === 0) return []
	const warnings: string[] = []
	for (const field of fields) {
		const allUndefined = records.every((record) => record[field] === undefined)
		if (allUndefined) {
			warnings.push(
				`field '${field}' was undefined in all records -- check spelling.`,
			)
		}
	}
	return warnings
}

/**
 * Sanitize error messages to prevent token/secret leakage in output.
 * Redacts Bearer tokens, OAuth params, and tenant IDs.
 */
export function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
		.replace(
			/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
			'Authorization: Bearer [REDACTED]',
		)
		.replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
		.replace(/refresh_token=[^&\s]+/gi, 'refresh_token=[REDACTED]')
		.replace(/code=[^&\s]+/gi, 'code=[REDACTED]')
		.replace(/code_verifier=[^&\s]+/gi, 'code_verifier=[REDACTED]')
		.replace(/client_id=[^&\s]+/gi, 'client_id=[REDACTED]')
		.replace(/client_secret=[^&\s]+/gi, 'client_secret=[REDACTED]')
		.replace(
			/"(access_token|refresh_token|code_verifier|client_secret|authorization)"\s*:\s*"[^"]*"/gi,
			'"$1":"[REDACTED]"',
		)
		.replace(/xero-tenant-id:\s*[^\s,}]+/gi, 'xero-tenant-id: [REDACTED]')
}

function deriveSeverity(action: AgentHint, errorCode: string): ErrorSeverity {
	if (errorCode === 'E_OK') return 'info'
	if (errorCode === 'E_INTERRUPTED') return 'warning'
	if (action.errorFamily === 'auth' || action.errorFamily === 'conflict') {
		return 'warning'
	}
	if (action.retryable) return 'warning'
	return action.blocking === false ? 'warning' : 'error'
}

function deriveRecoverability(
	action: AgentHint,
	context?: Record<string, unknown>,
): Recoverability {
	if (context && typeof context.recoverable === 'boolean') {
		return context.recoverable ? 'retry' : 'manual'
	}
	if (action.canResume) return 'resume'
	if (action.retryable) return 'retry'
	if (action.errorFamily === 'validation') return 'manual'
	if (action.errorFamily === 'interrupted') return 'resume'
	return 'manual'
}

export function deriveExitCodeHint(errorCode: string): ExitCode {
	if (errorCode === 'E_USAGE' || errorCode === 'E_REQUEST_ERROR')
		return EXIT_USAGE
	if (
		errorCode === 'E_UNAUTHORIZED' ||
		errorCode === 'E_SCOPE_RESTRICTED' ||
		errorCode === 'E_KEYCHAIN_LOCKED' ||
		errorCode === 'E_KEYCHAIN_DENIED' ||
		errorCode === 'E_KEYCHAIN_ERROR'
	) {
		return EXIT_UNAUTHORIZED
	}
	if (
		errorCode === 'E_CONFLICT' ||
		errorCode === 'E_LOCK_CONTENTION' ||
		errorCode === 'E_STALE_DATA'
	) {
		return EXIT_CONFLICT
	}
	if (errorCode === 'E_NOT_FOUND') return EXIT_NOT_FOUND
	if (errorCode === 'E_INTERRUPTED') return EXIT_INTERRUPTED
	return EXIT_RUNTIME
}

function buildAgentActions(action: AgentHint): string[] {
	const actions = new Set<string>()
	actions.add(action.action)
	for (const fallback of action.suggestedFallbacks ?? []) {
		actions.add(fallback)
	}
	return [...actions]
}

function createErrorFingerprint(
	errorCode: string,
	action: string,
	errorFamily: ErrorFamily,
	context?: Record<string, unknown>,
): string {
	const status =
		context && typeof context.status === 'number'
			? String(context.status)
			: 'na'
	return `${errorCode}|${action}|${errorFamily}|${status}`
}

/**
 * Standardized error catch handler for command functions.
 * Maps StructuredError subclasses to appropriate exit codes and
 * writes consistent agent error metadata. Sanitizes all messages.
 */
export function handleCommandError(ctx: OutputContext, err: unknown): ExitCode {
	return handleCommandErrorWithContext(ctx, err)
}

/** Handle command errors with optional additional context merged into error payloads. */
export function handleCommandErrorWithContext(
	ctx: OutputContext,
	err: unknown,
	extraContext?: Record<string, unknown>,
): ExitCode {
	const merged = (
		base?: Record<string, unknown>,
	): Record<string, unknown> | undefined =>
		base || extraContext
			? { ...(base ?? {}), ...(extraContext ?? {}) }
			: undefined

	if (err instanceof XeroAuthError) {
		writeError(ctx, err.message, err.code, err.name, {
			...merged(err.context),
			recoverable: err.recoverable,
		})
		return deriveExitCodeHint(err.code)
	}
	if (err instanceof XeroConflictError) {
		writeError(ctx, err.message, err.code, err.name, {
			...merged(err.context),
			recoverable: err.recoverable,
		})
		return EXIT_CONFLICT
	}
	if (err instanceof XeroApiError) {
		writeError(ctx, err.message, err.code, err.name, {
			...merged(err.context),
			recoverable: err.recoverable,
			status: err.status,
		})
		return deriveExitCodeHint(err.code)
	}
	if (err instanceof StructuredError) {
		writeError(ctx, err.message, err.code, err.name, {
			...merged(err.context),
			recoverable: err.recoverable,
		})
		return EXIT_RUNTIME
	}
	writeError(
		ctx,
		err instanceof Error ? err.message : String(err),
		'E_RUNTIME',
		'RuntimeError',
		merged(undefined),
	)
	return EXIT_RUNTIME
}
