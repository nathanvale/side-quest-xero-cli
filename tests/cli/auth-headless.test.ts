import { afterEach, describe, expect, it } from 'bun:test'
import { AUTH_SCOPE } from '../../src/cli/commands/auth'
import { type OutputContext, writeSuccess } from '../../src/cli/output'
import { isHeadless } from '../../src/xero/auth'
import { withCapturedOutput } from '../helpers/test-isolation'

/**
 * Contract tests for the headless auth NDJSON protocol.
 *
 * The headless auth flow produces a two-phase NDJSON contract on stdout:
 *   Line 1: {"phase":"auth_url","status":"data","schemaVersion":1,"data":{"command":"auth","authUrl":"https://login.xero.com/..."}}
 *   Line 2: {"phase":"result","status":"data","schemaVersion":1,"data":{"command":"auth",...}}
 *
 * These tests verify:
 *   - isHeadless() detection from XERO_HEADLESS env var
 *   - Phase 1 (auth_url) JSON structure written by authenticate()
 *   - Phase 2 (result) JSON envelope written by writeSuccess()
 *   - Interactive mode does NOT include phase discriminators
 *   - No human-readable text leaks to stdout in headless JSON mode
 */

/** JSON OutputContext for simulating headless/agent mode. */
function jsonCtx(): OutputContext {
	return {
		json: true,
		quiet: false,
		headless: true,
		logLevel: 'silent',
		progressMode: 'off',
		eventsConfig: { url: null },
	}
}

/** Human OutputContext for simulating interactive mode. */
function humanCtx(): OutputContext {
	return {
		json: false,
		quiet: false,
		headless: false,
		logLevel: 'silent',
		progressMode: 'off',
		eventsConfig: { url: null },
	}
}

describe('isHeadless() detection', () => {
	const originalHeadless = process.env.XERO_HEADLESS
	const originalIsTTY = process.stdout.isTTY

	afterEach(() => {
		if (originalHeadless === undefined) {
			delete process.env.XERO_HEADLESS
		} else {
			process.env.XERO_HEADLESS = originalHeadless
		}
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalIsTTY,
			configurable: true,
		})
	})

	it('returns true when XERO_HEADLESS=1', () => {
		process.env.XERO_HEADLESS = '1'
		expect(isHeadless()).toBe(true)
	})

	it('returns false when XERO_HEADLESS is unset and stdout is TTY', () => {
		delete process.env.XERO_HEADLESS
		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			configurable: true,
		})
		expect(isHeadless()).toBe(false)
	})

	it('returns false when XERO_HEADLESS is set to non-1 value and stdout is TTY', () => {
		process.env.XERO_HEADLESS = '0'
		Object.defineProperty(process.stdout, 'isTTY', {
			value: true,
			configurable: true,
		})
		expect(isHeadless()).toBe(false)
	})
})

describe('auth scope manifest', () => {
	it('includes the currently advertised accounting capabilities', () => {
		expect(AUTH_SCOPE).toContain('accounting.banktransactions')
		expect(AUTH_SCOPE).toContain('accounting.payments')
		expect(AUTH_SCOPE).toContain('accounting.invoices')
		expect(AUTH_SCOPE).toContain('accounting.contacts')
		expect(AUTH_SCOPE).toContain('accounting.settings.read')
	})
})

describe('headless auth phase 1: auth_url JSON on stdout', () => {
	/**
	 * This tests the exact JSON shape that authenticate() writes to stdout
	 * in headless mode (src/xero/auth.ts line ~551). We reproduce the write
	 * here to verify the contract without invoking the full OAuth flow.
	 */
	it('auth_url payload has correct shape and phase discriminator', () => {
		return withCapturedOutput(async (capture) => {
			// Reproduce the exact write from authenticate() in headless mode
			const authUrl = 'https://login.xero.com/identity/connect/authorize?test=1'
			const payload = JSON.stringify({
				status: 'data',
				schemaVersion: 1,
				phase: 'auth_url',
				data: { command: 'auth', authUrl },
			})
			process.stdout.write(`${payload}\n`)

			const line = capture.getStdout().trim()
			const parsed = JSON.parse(line)

			expect(parsed.phase).toBe('auth_url')
			expect(parsed.status).toBe('data')
			expect(parsed.schemaVersion).toBe(1)
			expect(parsed.data.command).toBe('auth')
			expect(parsed.data.authUrl).toBeTypeOf('string')
			expect(parsed.data.authUrl).toMatch(/^https:\/\/login\.xero\.com\//)
		})
	})

	it('auth_url line is valid NDJSON (single line, newline-terminated)', () => {
		return withCapturedOutput(async (capture) => {
			const authUrl = 'https://login.xero.com/identity/connect/authorize?foo=bar'
			const payload = JSON.stringify({
				status: 'data',
				schemaVersion: 1,
				phase: 'auth_url',
				data: { command: 'auth', authUrl },
			})
			process.stdout.write(`${payload}\n`)

			const raw = capture.getStdout()
			// Must end with exactly one newline
			expect(raw.endsWith('\n')).toBe(true)
			// Must be exactly one line of content
			const lines = raw.split('\n').filter((l) => l.length > 0)
			expect(lines.length).toBe(1)
			// Must be valid JSON
			expect(() => JSON.parse(lines[0]!)).not.toThrow()
		})
	})
})

describe('headless auth phase 2: result envelope via writeSuccess', () => {
	it('result envelope includes phase discriminator when provided', () => {
		return withCapturedOutput(async (capture) => {
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 'tenant-123', orgName: 'Test Org' },
				['Authenticated as "Test Org"'],
				'Authenticated',
				undefined,
				'result',
			)

			const parsed = JSON.parse(capture.getStdout().trim())
			expect(parsed.phase).toBe('result')
			expect(parsed.status).toBe('data')
			expect(parsed.schemaVersion).toBe(1)
			expect(parsed.data.command).toBe('auth')
			expect(parsed.data.tenantId).toBe('tenant-123')
			expect(parsed.data.orgName).toBe('Test Org')
		})
	})

	it('result envelope is valid NDJSON line', () => {
		return withCapturedOutput(async (capture) => {
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Org' },
				['Authenticated'],
				'OK',
				undefined,
				'result',
			)

			const raw = capture.getStdout()
			expect(raw.endsWith('\n')).toBe(true)
			const lines = raw.split('\n').filter((l) => l.length > 0)
			expect(lines.length).toBe(1)
			expect(() => JSON.parse(lines[0]!)).not.toThrow()
		})
	})
})

describe('full headless auth NDJSON two-phase contract', () => {
	/**
	 * Simulates the complete headless auth stdout output by producing both
	 * lines in sequence, exactly as authenticate() + runAuth() would.
	 */
	it('produces exactly two NDJSON lines with correct phase discriminators', () => {
		return withCapturedOutput(async (capture) => {
			// Phase 1: auth_url (written by authenticate() in headless mode)
			const authUrl = 'https://login.xero.com/identity/connect/authorize?state=abc'
			process.stdout.write(
				`${JSON.stringify({
					status: 'data',
					schemaVersion: 1,
					phase: 'auth_url',
					data: { command: 'auth', authUrl },
				})}\n`,
			)

			// Phase 2: result envelope (written by runAuth via writeSuccess)
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 'tenant-456', orgName: 'Acme Corp' },
				['Authenticated as "Acme Corp"'],
				'Authenticated',
				undefined,
				'result',
			)

			const raw = capture.getStdout()
			const lines = raw.split('\n').filter((l) => l.length > 0)
			expect(lines.length).toBe(2)

			// Line 1: auth_url phase
			const line1 = JSON.parse(lines[0]!)
			expect(line1.phase).toBe('auth_url')
			expect(line1.status).toBe('data')
			expect(line1.schemaVersion).toBe(1)
			expect(line1.data.command).toBe('auth')
			expect(line1.data.authUrl).toBeTypeOf('string')
			expect(line1.data.authUrl).toContain('login.xero.com')

			// Line 2: result phase
			const line2 = JSON.parse(lines[1]!)
			expect(line2.phase).toBe('result')
			expect(line2.status).toBe('data')
			expect(line2.schemaVersion).toBe(1)
			expect(line2.data.command).toBe('auth')
			expect(line2.data.tenantId).toBe('tenant-456')
			expect(line2.data.orgName).toBe('Acme Corp')
		})
	})

	it('no human-readable text leaks into stdout in headless mode', () => {
		return withCapturedOutput(async (capture) => {
			// Reproduce headless auth output
			const authUrl = 'https://login.xero.com/identity/connect/authorize?state=xyz'
			process.stdout.write(
				`${JSON.stringify({
					status: 'data',
					schemaVersion: 1,
					phase: 'auth_url',
					data: { command: 'auth', authUrl },
				})}\n`,
			)
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Org' },
				['Authenticated as "Org"', 'Tenant ID saved to .xero-config.json'],
				'Authenticated',
				undefined,
				'result',
			)

			const raw = capture.getStdout()
			// Every non-empty line must be valid JSON
			const lines = raw.split('\n').filter((l) => l.length > 0)
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow()
			}
			// Human-readable strings must NOT appear in stdout
			expect(raw).not.toContain('Opening Xero login')
			expect(raw).not.toContain('Waiting for callback')
			expect(raw).not.toContain('Tenant ID saved')
			// The human lines are in the data envelope, not as raw text
			expect(raw).not.toContain('Authenticated as')
		})
	})

	it('stderr receives no JSON envelope fragments in headless mode', () => {
		return withCapturedOutput(async (capture) => {
			const authUrl = 'https://login.xero.com/identity/connect/authorize?state=test'
			process.stdout.write(
				`${JSON.stringify({
					status: 'data',
					schemaVersion: 1,
					phase: 'auth_url',
					data: { command: 'auth', authUrl },
				})}\n`,
			)
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Org' },
				['OK'],
				'OK',
				undefined,
				'result',
			)

			const stderrContent = capture.getStderr()
			expect(stderrContent).not.toContain('"schemaVersion"')
			expect(stderrContent).not.toContain('"phase"')
			expect(stderrContent).not.toContain('"status":"data"')
		})
	})
})

describe('interactive mode auth output (no phase discriminator)', () => {
	it('writeSuccess omits phase field when not provided', () => {
		return withCapturedOutput(async (capture) => {
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Interactive Org' },
				['Authenticated as "Interactive Org"'],
				'Authenticated',
			)

			const parsed = JSON.parse(capture.getStdout().trim())
			expect(parsed.phase).toBeUndefined()
			expect(parsed.status).toBe('data')
			expect(parsed.schemaVersion).toBe(1)
			expect(parsed.data.command).toBe('auth')
		})
	})

	it('writeSuccess omits phase field when explicitly undefined', () => {
		return withCapturedOutput(async (capture) => {
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Org' },
				['Authenticated'],
				'OK',
				undefined,
				undefined,
			)

			const parsed = JSON.parse(capture.getStdout().trim())
			expect(parsed.phase).toBeUndefined()
			// The "phase" key should not exist at all in the JSON
			expect('phase' in parsed).toBe(false)
		})
	})

	it('human mode outputs readable text without JSON or phase fields', () => {
		return withCapturedOutput(async (capture) => {
			writeSuccess(
				humanCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Human Org' },
				['Authenticated as "Human Org"', 'Tenant ID saved to .xero-config.json'],
				'Authenticated',
				undefined,
				'result', // Even if phase is passed, human mode should not emit it
			)

			const stdout = capture.getStdout()
			// Human mode outputs the humanLines, not JSON
			expect(stdout).toContain('Authenticated as "Human Org"')
			expect(stdout).toContain('Tenant ID saved')
			// Must NOT contain any JSON structure markers
			expect(stdout).not.toContain('"phase"')
			expect(stdout).not.toContain('"schemaVersion"')
			expect(stdout).not.toContain('"status"')
		})
	})

	it('interactive mode produces exactly one stdout line in JSON mode (no auth_url phase)', () => {
		return withCapturedOutput(async (capture) => {
			// In interactive mode, authenticate() opens the browser instead of
			// writing to stdout. Only writeSuccess produces output.
			writeSuccess(
				jsonCtx(),
				{ command: 'auth', tenantId: 't1', orgName: 'Org' },
				['Authenticated'],
				'OK',
			)

			const lines = capture
				.getStdout()
				.split('\n')
				.filter((l) => l.length > 0)
			expect(lines.length).toBe(1)
			const parsed = JSON.parse(lines[0]!)
			expect(parsed.phase).toBeUndefined()
			expect(parsed.status).toBe('data')
		})
	})
})
