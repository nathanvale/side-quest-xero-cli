import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configure, getConsoleSink } from '@logtape/logtape'
import { parseCli, runCli } from '../../src/cli/command'
import { withCapturedOutput } from '../helpers/test-isolation'

describe('cli output invariants', () => {
	beforeEach(async () => {
		try {
			await configure({
				reset: true,
				sinks: { stderr: getConsoleSink() },
				loggers: [],
			})
		} catch {
			// LogTape can throw if previous stream sink is already closed.
			await configure({
				sinks: { stderr: getConsoleSink() },
				loggers: [],
			})
		}
	})

	afterEach(() => {
		delete process.env.XERO_EVENTS_URL
		delete process.env.XERO_EVENTS
	})

	it('emits JSON envelope with schemaVersion', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', 'help', '--json'])
			expect(exitCode).toBe(0)
			expect(capture.getStderr()).toBe('')
			const payload = JSON.parse(capture.getStdout())
			expect(payload.status).toBe('data')
			expect(payload.schemaVersion).toBe(1)
			expect(payload.data.command).toBe('help')
		})
	})

	it('emits structured error on invalid args', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', '--unknown', '--json'])
			expect(exitCode).toBe(2)
			// JSON mode: error envelopes go to stdout so agents parse a single stream
			expect(capture.getStderr()).toBe('')
			const payload = JSON.parse(capture.getStdout())
			expect(payload.status).toBe('error')
			expect(payload.error.action).toBeDefined()
			expect(payload.error.retryable).toBeDefined()
		})
	})

	it('keeps stderr clean in --quiet mode', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', 'help', '--quiet'])
			expect(exitCode).toBe(0)
			expect(capture.getStderr()).toBe('')
		})
	})
})

describe('--fields validation', () => {
	it('rejects invalid field chars with LLM self-correction hint', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'accounts',
			'--fields',
			'Name,Bad Field!',
			'--json',
		])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain('Invalid field names')
			expect(result.message).toContain('Bad Field!')
			expect(result.context?.invalidFields).toEqual(['Bad Field!'])
			expect(result.context?.validFieldsHint).toContain('PascalCase')
			expect(result.context?.validFieldsHint).toContain('Contact.Name')
			expect(result.context?.validFieldsHint).toContain('--help')
		}
	})
})

describe('--fields flag routing', () => {
	it('rejects --fields for reconcile command', () => {
		const result = parseCli(['node', 'xero-cli', 'reconcile', '--fields', 'Total', '--json'])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain('Unsupported option(s) for reconcile')
			expect(result.message).toContain('--fields')
		}
	})

	it('rejects --fields for help command', () => {
		const result = parseCli(['node', 'xero-cli', 'help', '--fields', 'Total'])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain('Unsupported option(s) for help')
			expect(result.message).toContain('--fields')
		}
	})

	it('accepts --fields for accounts command', () => {
		const result = parseCli(['node', 'xero-cli', 'accounts', '--fields', 'Code,Name', '--json'])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('accounts')
			expect(result.options).toHaveProperty('fields', ['Code', 'Name'])
		}
	})

	it('accepts --fields for transactions command', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'transactions',
			'--fields',
			'Total,Contact',
			'--json',
		])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('transactions')
			expect(result.options).toHaveProperty('fields', ['Total', 'Contact'])
		}
	})

	it('accepts --fields for history command', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'history',
			'--since',
			'2025-01-01',
			'--fields',
			'Contact,Count',
			'--json',
		])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('history')
			expect(result.options).toHaveProperty('fields', ['Contact', 'Count'])
		}
	})

	it('accepts --fields for invoices command', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'invoices',
			'--fields',
			'InvoiceID,Total',
			'--json',
		])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('invoices')
			expect(result.options).toHaveProperty('fields', ['InvoiceID', 'Total'])
		}
	})

	it('accepts payments command with filters and fields', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'payments',
			'--since',
			'2026-01-01',
			'--until',
			'2026-03-31',
			'--fields',
			'PaymentID,Amount',
			'--limit',
			'10',
			'--json',
		])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('payments')
			expect(result.options).toHaveProperty('fields', ['PaymentID', 'Amount'])
		}
	})

	it('maps pay alias to payments', () => {
		const result = parseCli(['node', 'xero-cli', 'pay', '--json'])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('payments')
		}
	})
})

describe('date range flag conflicts', () => {
	it('rejects --this-quarter combined with --since', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'transactions',
			'--this-quarter',
			'--since',
			'2025-01-01',
			'--json',
		])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain(
				'--this-quarter/--last-quarter cannot be combined with --since/--until',
			)
		}
	})

	it('rejects --last-quarter combined with --until', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'transactions',
			'--last-quarter',
			'--until',
			'2025-12-31',
			'--json',
		])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain(
				'--this-quarter/--last-quarter cannot be combined with --since/--until',
			)
		}
	})

	it('rejects triple combination --this-quarter --since --until', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'transactions',
			'--this-quarter',
			'--since',
			'2025-01-01',
			'--until',
			'2025-12-31',
			'--json',
		])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain(
				'--this-quarter/--last-quarter cannot be combined with --since/--until',
			)
		}
	})

	it('still allows --this-quarter alone', () => {
		const result = parseCli(['node', 'xero-cli', 'transactions', '--this-quarter', '--json'])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('transactions')
		}
	})

	it('still allows --since and --until without quarter flags', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'transactions',
			'--since',
			'2025-01-01',
			'--until',
			'2025-12-31',
			'--json',
		])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('transactions')
		}
	})
})

describe('command-specific flag validation', () => {
	it('rejects transactions-only flags on accounts command', () => {
		const result = parseCli(['node', 'xero-cli', 'accounts', '--unreconciled', '--json'])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain('Unsupported option(s) for accounts')
			expect(result.message).toContain('--unreconciled')
		}
	})

	it('rejects auth-only flags on status command', () => {
		const result = parseCli(['node', 'xero-cli', 'status', '--auth-timeout', '30', '--json'])
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain('Unsupported option(s) for status')
			expect(result.message).toContain('--auth-timeout')
		}
	})

	it('allows global flags for all commands', () => {
		const result = parseCli([
			'node',
			'xero-cli',
			'status',
			'--json',
			'--debug',
			'--events-url',
			'https://example.test',
		])
		expect(result.ok).toBe(true)
	})
})

describe('help topics', () => {
	it('maps --help on command to help topic', () => {
		const result = parseCli(['node', 'xero-cli', 'transactions', '--help', '--json'])
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.options.command).toBe('help')
			expect(result.options.topic).toBe('transactions')
		}
	})

	it('renders global flags topic', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', 'help', 'flags'])
			expect(exitCode).toBe(0)
			const payload = JSON.parse(capture.getStdout())
			expect(payload.status).toBe('data')
			expect(payload.data.command).toBe('help')
			expect(payload.data.topic).toBe('flags')
		})
	})
})
