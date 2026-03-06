import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configure } from '@logtape/logtape'
import { runCli } from '../../src/cli/command'
import { withCapturedOutput } from '../helpers/test-isolation'

/** No-op sink that discards all log records. */
function noopSink() {
	return () => {}
}

describe('stdout/stderr separation invariants', () => {
	beforeEach(async () => {
		// Reset LogTape between tests. The reset may throw if a previous stream
		// sink was already closed (LogTape limitation), so we catch and retry.
		try {
			await configure({
				reset: true,
				sinks: { noop: noopSink() },
				loggers: [{ category: [], sinks: ['noop'], lowestLevel: 'fatal' }],
			})
		} catch {
			// Reset threw during sink disposal but config may still be active.
			// Retry with reset: true and no sinks to dispose.
			try {
				await configure({
					reset: true,
					sinks: { noop: noopSink() },
					loggers: [{ category: [], sinks: ['noop'], lowestLevel: 'fatal' }],
				})
			} catch {
				// Config was already cleared by the first reset; configure fresh.
				await configure({
					sinks: { noop: noopSink() },
					loggers: [{ category: [], sinks: ['noop'], lowestLevel: 'fatal' }],
				})
			}
		}
		// Force text log format for deterministic non-TTY output.
		process.env.XERO_LOG_FORMAT = 'text'
	})

	afterEach(() => {
		delete process.env.XERO_LOG_FORMAT
		delete process.env.XERO_EVENTS_URL
		delete process.env.XERO_EVENTS
	})

	it('stdout contains only JSON envelope in --json mode (no log messages)', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', 'help', '--json'])
			expect(exitCode).toBe(0)
			const stdoutText = capture.getStdout()
			// stdout must be valid JSON (the envelope) and nothing else
			const parsed = JSON.parse(stdoutText.trim())
			expect(parsed.status).toBe('data')
			expect(parsed.schemaVersion).toBe(1)
			// Ensure no stray log lines leaked into stdout
			const lines = stdoutText.trim().split('\n')
			expect(lines.length).toBe(1)
		})
	})

	it('stderr contains no JSON envelope fragments', async () => {
		await withCapturedOutput(async (capture) => {
			await runCli(['node', 'xero-cli', 'help', '--json'])
			const stderrText = capture.getStderr()
			// stderr must not contain any JSON envelope keys
			expect(stderrText).not.toContain('"schemaVersion"')
			expect(stderrText).not.toContain('"status":"data"')
		})
	})

	it('--quiet stderr is empty on success', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', 'help', '--quiet'])
			expect(exitCode).toBe(0)
			expect(capture.getStderr()).toBe('')
		})
	})

	it('--json error envelope is written to stdout (single-stream for agents)', async () => {
		await withCapturedOutput(async (capture) => {
			const exitCode = await runCli(['node', 'xero-cli', '--unknown', '--json'])
			expect(exitCode).toBe(2)
			// JSON mode: both data and error envelopes go to stdout
			expect(capture.getStderr()).toBe('')
			const stdoutParsed = JSON.parse(capture.getStdout().trim())
			expect(stdoutParsed.status).toBe('error')
		})
	})
})
