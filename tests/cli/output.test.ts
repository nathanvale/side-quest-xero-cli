import { describe, expect, it } from 'bun:test'
import {
	detectAllUndefinedFields,
	ERROR_CODE_ACTIONS,
	EXIT_CONFLICT,
	EXIT_RUNTIME,
	EXIT_UNAUTHORIZED,
	handleCommandError,
	type OutputContext,
	projectFields,
	sanitizeErrorMessage,
	writeError,
	writeSuccess,
} from '../../src/cli/output'
import {
	StructuredError,
	XeroApiError,
	XeroAuthError,
	XeroConflictError,
} from '../../src/xero/errors'
import { withCapturedOutput } from '../helpers/test-isolation'

/** Minimal OutputContext that suppresses all output. */
function quietCtx(): OutputContext {
	return {
		json: false,
		quiet: true,
		headless: false,
		logLevel: 'silent',
		progressMode: 'off',
		eventsConfig: { url: null },
	}
}

describe('handleCommandError', () => {
	it('returns EXIT_CONFLICT for XeroConflictError', () => {
		const err = new XeroConflictError('already reconciled')
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_CONFLICT)
	})

	it('returns EXIT_UNAUTHORIZED for XeroAuthError', () => {
		const err = new XeroAuthError('token expired')
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_UNAUTHORIZED)
	})

	it('returns EXIT_RUNTIME for XeroApiError', () => {
		const err = new XeroApiError('server error', { status: 500 })
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_RUNTIME)
	})

	it('returns EXIT_RUNTIME for generic StructuredError', () => {
		const err = new StructuredError('something broke', {
			code: 'E_RUNTIME',
			category: 'runtime',
		})
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_RUNTIME)
	})

	it('returns EXIT_RUNTIME for plain Error', () => {
		const err = new Error('unexpected')
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_RUNTIME)
	})

	it('returns EXIT_UNAUTHORIZED for E_SCOPE_RESTRICTED', () => {
		const err = new XeroApiError('scope restricted', {
			code: 'E_SCOPE_RESTRICTED',
			recoverable: false,
			status: 403,
		})
		const code = handleCommandError(quietCtx(), err)
		expect(code).toBe(EXIT_UNAUTHORIZED)
	})
})

describe('ERROR_CODE_ACTIONS completeness', () => {
	it('includes key thrown codes used by CLI/auth/api paths', () => {
		const requiredCodes = [
			'E_USAGE',
			'E_UNAUTHORIZED',
			'E_SCOPE_RESTRICTED',
			'E_LOCK_CONTENTION',
			'E_STALE_DATA',
			'E_RATE_LIMITED',
			'E_NETWORK',
			'E_SERVER_ERROR',
			'E_REQUEST_ERROR',
			'E_KEYCHAIN_LOCKED',
			'E_KEYCHAIN_DENIED',
			'E_KEYCHAIN_ERROR',
			'E_MALFORMED_RESPONSE',
		]
		for (const code of requiredCodes) {
			expect(ERROR_CODE_ACTIONS[code]).toBeDefined()
		}
	})
})

describe('detectAllUndefinedFields', () => {
	it('returns warning for field that is undefined in all records', () => {
		const records = [
			{ Name: 'Acme', 'Contcat.Name': undefined },
			{ Name: 'Globex', 'Contcat.Name': undefined },
		]
		const warnings = detectAllUndefinedFields(records, ['Name', 'Contcat.Name'])
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("field 'Contcat.Name'")
		expect(warnings[0]).toContain('check spelling')
	})

	it('does not warn for fields that have values in some records', () => {
		const records = [
			{ Status: 'ACTIVE', Notes: undefined },
			{ Status: 'ARCHIVED', Notes: 'some note' },
		]
		const warnings = detectAllUndefinedFields(records, ['Status', 'Notes'])
		expect(warnings).toHaveLength(0)
	})

	it('does not warn when fields is null', () => {
		const records = [{ Name: 'Acme' }]
		const warnings = detectAllUndefinedFields(records, null)
		expect(warnings).toHaveLength(0)
	})

	it('does not warn when records array is empty', () => {
		const warnings = detectAllUndefinedFields([], ['Name', 'Typo'])
		expect(warnings).toHaveLength(0)
	})

	it('warns for multiple typo fields', () => {
		const records = [{ Name: undefined, Cde: undefined }]
		const warnings = detectAllUndefinedFields(records, ['Name', 'Cde'])
		expect(warnings).toHaveLength(2)
	})
})

describe('projectFields + detectAllUndefinedFields integration', () => {
	it('detects typo after projection through the full pipeline', () => {
		const records = [
			{ Contact: { Name: 'Acme' }, Status: 'ACTIVE' },
			{ Contact: { Name: 'Globex' }, Status: 'ARCHIVED' },
		]
		const fields = ['Contact.Name', 'Contcat.Name'] as const
		const projected = projectFields(records as Record<string, unknown>[], fields)
		const warnings = detectAllUndefinedFields(projected, fields)

		// Contact.Name resolves fine, Contcat.Name is a typo
		expect(projected[0]['Contact.Name']).toBe('Acme')
		expect(projected[0]['Contcat.Name']).toBeUndefined()
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("field 'Contcat.Name'")
	})
})

describe('writeSuccess with phase discriminator', () => {
	it('includes phase field in JSON envelope when provided', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(
				ctx,
				{ command: 'auth', tenantId: 't1', orgName: 'Acme' },
				['Authenticated'],
				'OK',
				undefined,
				'result',
			)
			const parsed = JSON.parse(capture.getStdout())
			expect(parsed.phase).toBe('result')
			expect(parsed.status).toBe('data')
			expect(parsed.data.command).toBe('auth')
		})
	})

	it('omits phase field from JSON envelope when not provided', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { items: [] }, ['Items'], 'OK')
			const parsed = JSON.parse(capture.getStdout())
			expect(parsed.phase).toBeUndefined()
			expect(parsed.status).toBe('data')
		})
	})

	it('does not include phase in human mode output', async () => {
		const ctx: OutputContext = {
			json: false,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { command: 'auth' }, ['Authenticated'], 'OK', undefined, 'result')
			// Human mode just prints the human lines, no JSON
			expect(capture.getStdout()).toBe('Authenticated\n')
			expect(capture.getStdout()).not.toContain('phase')
		})
	})
})

describe('writeSuccess with warnings', () => {
	it('includes warnings array in JSON envelope', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { items: [] }, ['No items'], '0', [
				"field 'Typo' was undefined in all records -- check spelling.",
			])
			const parsed = JSON.parse(capture.getStdout())
			expect(parsed.warnings).toEqual([
				"field 'Typo' was undefined in all records -- check spelling.",
			])
			expect(parsed.status).toBe('data')
		})
	})

	it('omits warnings array from JSON when no warnings', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { items: [] }, ['No items'], '0', [])
			const parsed = JSON.parse(capture.getStdout())
			expect(parsed.warnings).toBeUndefined()
		})
	})

	it('emits warnings to stderr in human mode', async () => {
		const ctx: OutputContext = {
			json: false,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { items: [] }, ['No items'], '0', [
				"field 'Typo' was undefined in all records -- check spelling.",
			])
			expect(capture.getStderr()).toContain("Warning: field 'Typo'")
			expect(capture.getStdout()).toContain('No items')
		})
	})

	it('emits warnings to stderr in quiet mode', async () => {
		const ctx: OutputContext = {
			json: false,
			quiet: true,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeSuccess(ctx, { items: [] }, ['No items'], '0', [
				"field 'Typo' was undefined in all records -- check spelling.",
			])
			expect(capture.getStderr()).toContain("Warning: field 'Typo'")
			expect(capture.getStdout()).toBe('0\n')
		})
	})
})

describe('writeError action mapping', () => {
	it('maps E_SCOPE_RESTRICTED to USE_BROWSER_FALLBACK', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeError(
				ctx,
				'Token exchange failed: {"error":"unauthorized_client","error_description":"Invalid scope for client"}',
				'E_SCOPE_RESTRICTED',
				'XeroAuthError',
			)
			// JSON mode: error envelopes go to stdout so agents parse a single stream
			const payload = JSON.parse(capture.getStdout())
			expect(payload.status).toBe('error')
			expect(payload.error.code).toBe('E_SCOPE_RESTRICTED')
			expect(payload.error.action).toBe('USE_BROWSER_FALLBACK')
			expect(payload.error.retryable).toBe(false)
			expect(payload.error.errorFamily).toBe('scope')
			expect(payload.error.fallbackMode).toBe('browser_finance_api')
			expect(payload.error.nextCommand).toBe('/xero-explorer extract')
			expect(payload.error.hintVersion).toBe(2)
		})
	})

	it('auto-sets canResume when state checkpoint context is present', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: false,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeError(ctx, 'Checkpointed failure', 'E_RUNTIME', 'RuntimeError', {
				stateFile: '.xero-reconcile-state.json',
				checkpointId: 'checkpoint-3',
			})
			const payload = JSON.parse(capture.getStdout())
			expect(payload.error.code).toBe('E_RUNTIME')
			expect(payload.error.stateFile).toBe('.xero-reconcile-state.json')
			expect(payload.error.checkpointId).toBe('checkpoint-3')
			expect(payload.error.canResume).toBe(true)
		})
	})

	it('redacts sensitive context fields and clamps delay hints', async () => {
		const ctx: OutputContext = {
			json: true,
			quiet: false,
			headless: true,
			logLevel: 'silent',
			progressMode: 'off',
			eventsConfig: { url: null },
		}
		await withCapturedOutput(async (capture) => {
			writeError(ctx, 'Request failed', 'E_RATE_LIMITED', 'XeroApiError', {
				retryAfterMs: 999_999,
				accessToken: 'secret-token',
				headers: {
					Authorization: 'Bearer abc.def',
					'xero-tenant-id': 'tenant-1234',
				},
			})
			const payload = JSON.parse(capture.getStdout())
			expect(payload.error.retryAfterMs).toBe(300000)
			expect(payload.error.recommendedDelayMs).toBe(300000)
			expect(payload.error.context.accessToken).toBe('[REDACTED]')
			expect(payload.error.context.headers.Authorization).toBe('[REDACTED]')
			expect(payload.error.context.headers['xero-tenant-id']).toBe('[REDACTED]')
		})
	})
})

describe('sanitizeErrorMessage', () => {
	it('redacts JSON token fields and authorization headers', () => {
		const input =
			'Authorization: Bearer abc.def {"access_token":"abc","refresh_token":"xyz","client_secret":"top"}'
		const output = sanitizeErrorMessage(input)
		expect(output).not.toContain('abc.def')
		expect(output).not.toContain('"access_token":"abc"')
		expect(output).not.toContain('"refresh_token":"xyz"')
		expect(output).not.toContain('"client_secret":"top"')
		expect(output).toContain('Authorization: Bearer [REDACTED]')
		expect(output).toContain('"access_token":"[REDACTED]"')
	})
})
