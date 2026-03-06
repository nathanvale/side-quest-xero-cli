import { AsyncLocalStorage } from 'node:async_hooks'
import {
	configure,
	dispose,
	fingersCrossed,
	getConsoleSink,
	getLogger,
	getStreamSink,
	jsonLinesFormatter,
} from '@logtape/logtape'

type LogLevel = 'silent' | 'info' | 'debug'

interface LogContext {
	readonly runId: string
}

interface LoggingOptions {
	readonly json: boolean
	readonly quiet: boolean
	readonly logLevel: LogLevel
}

let loggingConfigured = false
let configuringPromise: Promise<void> | null = null
const logContext = new AsyncLocalStorage<LogContext>()
const textDecoder = new TextDecoder()

function createStderrWebStream(): WritableStream<string | Uint8Array> {
	return new WritableStream<string | Uint8Array>({
		write(chunk) {
			process.stderr.write(
				typeof chunk === 'string' ? chunk : textDecoder.decode(chunk),
			)
		},
		// Intentionally no-op: never close process.stderr from logger disposal.
		close() {},
		abort() {},
	})
}

function createNoopWebStream(): WritableStream<string | Uint8Array> {
	return new WritableStream<string | Uint8Array>({
		write() {},
		close() {},
		abort() {},
	})
}

function resolveLogLevel(level: LogLevel): 'warning' | 'info' | 'debug' {
	if (level === 'debug') return 'debug'
	if (level === 'info') return 'info'
	return 'warning'
}

function resolveEffectiveLogLevel(level: LogLevel): LogLevel {
	const raw = (process.env.XERO_LOG_LEVEL ?? '').trim().toLowerCase()
	if (raw === 'debug' || raw === 'info' || raw === 'silent') {
		return raw
	}
	return level
}

function resolveLayerLogLevel(
	layer: 'api' | 'auth' | 'cli',
	fallback: LogLevel,
): LogLevel {
	const raw = (
		layer === 'api'
			? process.env.XERO_LOG_LEVEL_API
			: layer === 'auth'
				? process.env.XERO_LOG_LEVEL_AUTH
				: process.env.XERO_LOG_LEVEL_CLI
	)
		?.trim()
		.toLowerCase()
	if (raw === 'debug' || raw === 'info' || raw === 'silent') {
		return raw
	}
	return fallback
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback
	const value = Number.parseInt(raw, 10)
	if (!Number.isFinite(value) || value <= 0) return fallback
	return value
}

function shouldUseJsonLogs(options: LoggingOptions): boolean {
	if (process.env.XERO_LOG_FORMAT === 'text') return false
	if (process.env.XERO_LOG_FORMAT === 'json') return true
	if (options.json) return true
	return !process.stderr.isTTY
}

function shouldUseFingersCrossed(
	options: LoggingOptions,
	effectiveLevel: LogLevel,
): boolean {
	return (
		process.env.XERO_LOG_FORMAT !== 'json' &&
		!options.json &&
		!options.quiet &&
		effectiveLevel === 'silent'
	)
}

/** Configure LogTape logging for the CLI. */
export async function setupLogging(options: LoggingOptions): Promise<void> {
	if (loggingConfigured) return
	if (configuringPromise) {
		await configuringPromise
		return
	}
	const effectiveLevel = resolveEffectiveLogLevel(options.logLevel)
	const apiLevel = resolveLayerLogLevel('api', effectiveLevel)
	const authLevel = resolveLayerLogLevel('auth', effectiveLevel)
	const cliLevel = resolveLayerLogLevel('cli', effectiveLevel)
	const jsonLogs = shouldUseJsonLogs(options)
	const stderrStream = createStderrWebStream()
	const baseSink = jsonLogs
		? getStreamSink(stderrStream, { formatter: jsonLinesFormatter })
		: getConsoleSink()
	const maxBufferSize = parsePositiveInt(
		process.env.XERO_LOG_FC_BUFFER_SIZE,
		500,
	)
	const sink = shouldUseFingersCrossed(options, effectiveLevel)
		? fingersCrossed(baseSink, {
				triggerLevel: 'error',
				maxBufferSize,
			})
		: baseSink

	configuringPromise = configure({
		reset: true,
		contextLocalStorage: logContext as unknown as AsyncLocalStorage<
			Record<string, unknown>
		>,
		sinks: {
			stderr: sink,
		},
		loggers: [
			{
				category: ['logtape', 'meta'],
				sinks: ['stderr'],
				lowestLevel: 'warning',
			},
			{
				category: ['xero', 'cli'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(cliLevel),
			},
			{
				category: ['xero', 'api'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(apiLevel),
			},
			{
				category: ['xero', 'auth'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(authLevel),
			},
			{
				category: ['xero', 'state'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(effectiveLevel),
			},
			{
				category: ['xero', 'events'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(effectiveLevel),
			},
			{
				category: ['xero'],
				sinks: ['stderr'],
				lowestLevel: resolveLogLevel(effectiveLevel),
			},
		],
	})
	try {
		await configuringPromise
		loggingConfigured = true
	} catch (err: unknown) {
		loggingConfigured = false
		if (!options.json && !options.quiet) {
			const detail = err instanceof Error ? err.message : String(err)
			process.stderr.write(`[xero] Failed to configure logging: ${detail}\n`)
		}
	} finally {
		configuringPromise = null
	}
}

/** Shut down logging safely (idempotent). Flushes sinks with a timeout. */
export async function shutdownLogging(): Promise<void> {
	if (configuringPromise) {
		try {
			await configuringPromise
		} catch {
			// Best-effort shutdown; continue even if configure failed.
		}
	}
	if (!loggingConfigured) return
	loggingConfigured = false
	// In tests, command handlers are often called directly without setupLogging().
	// Avoid disposing sinks to prevent logger instances from targeting closed writers.
	if (process.env.NODE_ENV === 'test') {
		try {
			await configure({
				reset: true,
				contextLocalStorage: logContext as unknown as AsyncLocalStorage<
					Record<string, unknown>
				>,
				sinks: {
					stderr: getStreamSink(createNoopWebStream()),
				},
				loggers: [
					{
						category: ['logtape', 'meta'],
						sinks: ['stderr'],
						lowestLevel: 'error',
					},
					{
						category: ['xero'],
						sinks: ['stderr'],
						lowestLevel: 'debug',
					},
				],
			})
		} catch {
			// Best-effort reset for tests.
		}
		return
	}
	const timeoutMs = parsePositiveInt(
		process.env.XERO_LOG_SHUTDOWN_TIMEOUT_MS,
		500,
	)
	try {
		await Promise.race([
			dispose(),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		])
	} catch {
		// Best-effort shutdown; LogTape can throw if sink streams were already closed.
	}
}

/** Get a namespaced logger under the xero root category. */
export function getXeroLogger(
	category: string[],
): ReturnType<typeof getLogger> {
	return getLogger(['xero', ...category])
}

/** Run a function with a scoped logging context. */
export async function withContext<T>(
	context: LogContext,
	fn: () => Promise<T> | T,
): Promise<T> {
	return await logContext.run(context, async () => await fn())
}

/** Read the current logging context (if any). */
export function getLogContext(): LogContext | null {
	return logContext.getStore() ?? null
}
