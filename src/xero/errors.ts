type ErrorCategory = 'auth' | 'api' | 'conflict' | 'runtime'

interface StructuredErrorOptions {
	readonly code: string
	readonly category: ErrorCategory
	readonly recoverable: boolean
	readonly context?: Record<string, unknown>
}

/** Base structured error for xero-cli (machine-readable fields). */
export class StructuredError extends Error {
	readonly code: string
	readonly category: ErrorCategory
	readonly recoverable: boolean
	readonly context?: Record<string, unknown>

	constructor(message: string, options: StructuredErrorOptions) {
		super(message)
		this.name = 'StructuredError'
		this.code = options.code
		this.category = options.category
		this.recoverable = options.recoverable
		this.context = options.context
	}
}

/** Auth-specific errors (missing/expired/invalid tokens). */
export class XeroAuthError extends StructuredError {
	constructor(
		message: string,
		options?: Omit<StructuredErrorOptions, 'category'>,
	) {
		super(message, {
			code: options?.code ?? 'E_UNAUTHORIZED',
			category: 'auth',
			recoverable: options?.recoverable ?? false,
			context: options?.context,
		})
		this.name = 'XeroAuthError'
	}
}

/** API errors for HTTP responses and transport failures. */
export class XeroApiError extends StructuredError {
	readonly status?: number

	constructor(
		message: string,
		options: Omit<StructuredErrorOptions, 'category'> & { status?: number },
	) {
		super(message, {
			code: options.code,
			category: 'api',
			recoverable: options.recoverable,
			context: options.context,
		})
		this.name = 'XeroApiError'
		this.status = options.status
	}
}

/** Conflict errors (lock contention, stale data, API conflicts). */
export class XeroConflictError extends StructuredError {
	constructor(
		message: string,
		options?: Omit<StructuredErrorOptions, 'category'>,
	) {
		super(message, {
			code: options?.code ?? 'E_CONFLICT',
			category: 'conflict',
			recoverable: options?.recoverable ?? true,
			context: options?.context,
		})
		this.name = 'XeroConflictError'
	}
}
