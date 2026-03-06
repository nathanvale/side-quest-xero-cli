import { afterEach, describe, expect, it } from 'bun:test'
import { getLogContext, setupLogging, shutdownLogging, withContext } from '../src/logging'

describe('shutdownLogging', () => {
	afterEach(async () => {
		// Ensure logging state is reset after each test.
		// Use try/catch because LogTape may throw if streams are already closed.
		try {
			await shutdownLogging()
		} catch {
			// Swallow stream-already-closed errors from LogTape dispose.
		}
	})

	it('is a no-op before setupLogging has been called', async () => {
		// Should complete without throwing when logging was never configured.
		await expect(shutdownLogging()).resolves.toBeUndefined()
	})

	it('second call is a no-op after first shutdown', async () => {
		setupLogging({ json: false, quiet: false, logLevel: 'silent' })
		await shutdownLogging()
		// Second call should complete without throwing.
		await expect(shutdownLogging()).resolves.toBeUndefined()
	})

	it('completes within reasonable time with timeout guard', async () => {
		// setupLogging configures LogTape. shutdownLogging races dispose()
		// against a 500ms timeout, so it should always return within ~600ms
		// even if the underlying dispose takes longer.
		setupLogging({ json: false, quiet: false, logLevel: 'silent' })

		const start = performance.now()
		await shutdownLogging()
		const elapsed = performance.now() - start

		// The timeout guard is 500ms, so shutdown should complete well
		// within 1000ms regardless of dispose behavior.
		expect(elapsed).toBeLessThan(1000)
	})

	it('propagates runId through withContext/getLogContext', async () => {
		const before = getLogContext()
		expect(before).toBeNull()

		const observed = await withContext({ runId: 'run-123' }, async () => {
			return getLogContext()
		})
		expect(observed?.runId).toBe('run-123')
		expect(getLogContext()).toBeNull()
	})

	it('accepts XERO_LOG_LEVEL env override values', async () => {
		for (const level of ['silent', 'info', 'debug'] as const) {
			process.env.XERO_LOG_LEVEL = level
			await setupLogging({ json: false, quiet: false, logLevel: 'silent' })
			await shutdownLogging()
		}
		delete process.env.XERO_LOG_LEVEL
	})
})
