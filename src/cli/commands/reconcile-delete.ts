import {
	appendFile,
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	stat,
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { acquireLock, releaseLock } from '../../state/lock'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { XeroApiError } from '../../xero/errors'
import { deleteBankTransaction } from '../../xero/reconcile/api'
import { UUID_SHAPE } from '../../xero/reconcile/types'
import type { ExitCode, OutputContext } from '../output'
import {
	EXIT_INTERRUPTED,
	EXIT_OK,
	EXIT_RUNTIME,
	EXIT_UNAUTHORIZED,
	handleCommandErrorWithContext,
	writeError,
	writeSuccess,
} from '../output'

const reconcileDeleteLogger = getXeroLogger([
	'cli',
	'commands',
	'reconcile-delete',
])
const DELETE_RUN_MODE = 0o600

const DeleteRunItemSchema = z.object({
	statementLineId: z.string().regex(UUID_SHAPE, 'Invalid statementLineId'),
	status: z.enum(['confirmed', 'deleted', 'errored']),
	bankTransactionId: z.string().min(1),
	responseCode: z.number().int().nullable().optional(),
	errorReason: z.string().nullable().optional(),
	deletedAt: z.string().nullable().optional(),
	nextRetryAt: z.string().nullable().optional(),
	tenantPauseUntil: z.string().nullable().optional(),
})

const DeleteRunStateSchema = z
	.object({
		schemaVersion: z.number().int().min(1),
		quarter: z.string().min(1),
		sourcePostRun: z.string().min(1),
		writeInterlock: z.string().min(1),
		logFile: z.string().min(1),
		items: z.record(z.string(), DeleteRunItemSchema),
	})
	.passthrough()

type ReconcileDeleteCommand = {
	readonly command: 'reconcile-delete'
	readonly execute: boolean
	readonly postRun: string
}

type DeleteRunState = z.infer<typeof DeleteRunStateSchema>
type DeleteRunItem = z.infer<typeof DeleteRunItemSchema>

interface ReconcileDeleteResult {
	readonly statementLineId: string
	readonly status: 'deleted' | 'skipped' | 'failed' | 'dry-run' | 'retryable'
	readonly bankTransactionId?: string
	readonly error?: string
}

interface ReconcileDeleteSummary {
	total: number
	deleted: number
	skipped: number
	failed: number
	dryRun: number
	retryable: number
}

function nowIso(): string {
	return new Date().toISOString()
}

function plusSeconds(isoValue: string, seconds: number): string {
	return new Date(Date.parse(isoValue) + seconds * 1000).toISOString()
}

function parseIsoOrNull(value: string | null | undefined): number | null {
	if (!value) return null
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : null
}

async function validateJsonPath(
	pathname: string,
	baseDir = process.cwd(),
): Promise<void> {
	const resolved = path.resolve(pathname)
	if (!resolved.startsWith(`${baseDir}${path.sep}`) && resolved !== baseDir) {
		throw new XeroApiError(
			`JSON path must be within ${baseDir} -- got ${resolved}`,
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}
	if (path.extname(resolved).toLowerCase() !== '.json') {
		throw new XeroApiError('JSON path must have a .json extension', {
			code: 'E_USAGE',
			recoverable: false,
		})
	}
	try {
		const info = await lstat(resolved)
		if (info.isSymbolicLink()) {
			throw new XeroApiError(
				`JSON path must not be a symlink -- got ${resolved}`,
				{
					code: 'E_USAGE',
					recoverable: false,
				},
			)
		}
	} catch (err) {
		if (err instanceof XeroApiError) throw err
	}
}

async function loadJsonFile<T>(
	pathname: string,
	schema: z.ZodType<T>,
	label: string,
): Promise<T> {
	await validateJsonPath(pathname)
	const raw = await readFile(pathname, 'utf8')
	const parsed = JSON.parse(raw) as unknown
	const validated = schema.safeParse(parsed)
	if (!validated.success) {
		throw new XeroApiError(`Invalid ${label}`, {
			code: 'E_STALE_DATA',
			recoverable: true,
			context: {
				path: pathname,
				details: validated.error.issues.map((issue) => issue.message),
			},
		})
	}
	return validated.data
}

async function saveDeleteRunState(
	state: DeleteRunState,
	pathname: string,
): Promise<void> {
	const statePath = path.resolve(pathname)
	const directory = path.dirname(statePath)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const tempPath = `${statePath}.tmp-${Date.now()}`
	const payload = JSON.stringify(state, null, 2)
	const handle = await open(tempPath, 'wx', DELETE_RUN_MODE)
	try {
		await handle.writeFile(payload, 'utf8')
		await handle.sync()
	} finally {
		await handle.close()
	}
	await rename(tempPath, statePath)
	const info = await stat(statePath)
	if ((info.mode & 0o777) !== DELETE_RUN_MODE) {
		throw new XeroApiError('Delete-run state permissions incorrect', {
			code: 'E_RUNTIME',
			recoverable: false,
			context: {
				statePath,
				expectedMode: DELETE_RUN_MODE,
				actualMode: info.mode & 0o777,
			},
		})
	}
}

async function appendDeleteRunLog(
	pathname: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await appendFile(pathname, `${JSON.stringify(payload)}\n`, 'utf8')
}

function summarizeResults(
	results: readonly ReconcileDeleteResult[],
): ReconcileDeleteSummary {
	const summary: ReconcileDeleteSummary = {
		total: results.length,
		deleted: 0,
		skipped: 0,
		failed: 0,
		dryRun: 0,
		retryable: 0,
	}
	for (const result of results) {
		if (result.status === 'deleted') summary.deleted += 1
		else if (result.status === 'skipped') summary.skipped += 1
		else if (result.status === 'failed') summary.failed += 1
		else if (result.status === 'dry-run') summary.dryRun += 1
		else if (result.status === 'retryable') summary.retryable += 1
	}
	return summary
}

function assertRetryWindows(deleteRun: DeleteRunState): void {
	const now = Date.now()
	const activePauses = Object.values(deleteRun.items)
		.flatMap((item) => [item.tenantPauseUntil, item.nextRetryAt])
		.map((value) => parseIsoOrNull(value))
		.filter((value): value is number => value !== null && value > now)
	if (activePauses.length > 0) {
		const earliest = Math.min(...activePauses)
		throw new XeroApiError(
			`Delete run is paused until ${new Date(earliest).toISOString()}`,
			{
				code: 'E_RATE_LIMITED',
				recoverable: true,
				context: { retryAfterMs: earliest - now },
			},
		)
	}
}

function reportResult(ctx: OutputContext, result: ReconcileDeleteResult): void {
	if (ctx.json || ctx.quiet) return
	let prefix = 'SKIP'
	if (result.status === 'deleted') prefix = 'OK'
	if (result.status === 'failed') prefix = 'ERR'
	if (result.status === 'dry-run') prefix = 'DRY'
	if (result.status === 'retryable') prefix = 'RETRY'
	const suffix = result.bankTransactionId
		? ` -> ${result.bankTransactionId}`
		: ''
	const error = result.error ? ` - ${result.error}` : ''
	process.stderr.write(`${prefix} ${result.statementLineId}${suffix}${error}\n`)
}

function markDeleted(
	deleteRun: DeleteRunState,
	item: DeleteRunItem,
	statementLineId: string,
): Record<string, unknown> {
	const attemptedAt = nowIso()
	deleteRun.items[statementLineId] = {
		...item,
		status: 'deleted',
		responseCode: 200,
		errorReason: null,
		deletedAt: attemptedAt,
		nextRetryAt: null,
		tenantPauseUntil: null,
	}
	return {
		statementLineId,
		bankTransactionId: item.bankTransactionId,
		attemptedAt,
		responseCode: 200,
		errorReason: null,
		result: 'deleted',
	}
}

function markFailure(
	deleteRun: DeleteRunState,
	item: DeleteRunItem,
	statementLineId: string,
	err: unknown,
): {
	readonly logEntry: Record<string, unknown>
	readonly result: ReconcileDeleteResult
} {
	const attemptedAt = nowIso()
	const message = err instanceof Error ? err.message : String(err)
	if (err instanceof XeroApiError && err.code === 'E_RATE_LIMITED') {
		const retryAfterMs =
			err.context && typeof err.context.retryAfterMs === 'number'
				? err.context.retryAfterMs
				: 60_000
		const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString()
		deleteRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: err.status ?? 429,
			errorReason: message,
			nextRetryAt,
		}
		return {
			logEntry: {
				statementLineId,
				bankTransactionId: item.bankTransactionId,
				attemptedAt,
				responseCode: err.status ?? 429,
				errorReason: message,
				result: 'retryable',
				nextRetryAt,
			},
			result: {
				statementLineId,
				status: 'retryable',
				bankTransactionId: item.bankTransactionId,
				error: message,
			},
		}
	}
	if (err instanceof XeroApiError && err.status === 503) {
		const tenantPauseUntil = plusSeconds(attemptedAt, 5 * 60)
		deleteRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: 503,
			errorReason: message,
			tenantPauseUntil,
		}
		return {
			logEntry: {
				statementLineId,
				bankTransactionId: item.bankTransactionId,
				attemptedAt,
				responseCode: 503,
				errorReason: message,
				result: 'retryable',
				tenantPauseUntil,
			},
			result: {
				statementLineId,
				status: 'retryable',
				bankTransactionId: item.bankTransactionId,
				error: message,
			},
		}
	}
	if (err instanceof XeroApiError && err.code === 'E_NETWORK') {
		const nextRetryAt = plusSeconds(attemptedAt, 6 * 60)
		deleteRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: null,
			errorReason: message,
			nextRetryAt,
		}
		return {
			logEntry: {
				statementLineId,
				bankTransactionId: item.bankTransactionId,
				attemptedAt,
				responseCode: null,
				errorReason: message,
				result: 'retryable',
				nextRetryAt,
			},
			result: {
				statementLineId,
				status: 'retryable',
				bankTransactionId: item.bankTransactionId,
				error: message,
			},
		}
	}
	deleteRun.items[statementLineId] = {
		...item,
		status: 'errored',
		responseCode: err instanceof XeroApiError ? (err.status ?? null) : null,
		errorReason: message,
	}
	return {
		logEntry: {
			statementLineId,
			bankTransactionId: item.bankTransactionId,
			attemptedAt,
			responseCode: err instanceof XeroApiError ? (err.status ?? null) : null,
			errorReason: message,
			result: 'errored',
		},
		result: {
			statementLineId,
			status: 'failed',
			bankTransactionId: item.bankTransactionId,
			error: message,
		},
	}
}

/** Delete posted BankTransactions via the Xero Accounting API. */
export async function runReconcileDelete(
	ctx: OutputContext,
	options: ReconcileDeleteCommand,
): Promise<ExitCode> {
	let lockAcquired = false
	let interrupted = false
	const handleSigint = () => {
		interrupted = true
	}
	const handleSigterm = () => {
		interrupted = true
	}
	process.once('SIGINT', handleSigint)
	process.once('SIGTERM', handleSigterm)

	try {
		reconcileDeleteLogger.info('Reconcile delete run started in {mode} mode', {
			mode: options.execute ? 'execute' : 'dry-run',
			postRun: options.postRun,
		})

		loadEnvConfig()
		if (options.execute) {
			await acquireLock(process.cwd())
			lockAcquired = true
		}

		const deleteRun = await loadJsonFile(
			options.postRun,
			DeleteRunStateSchema,
			'delete-run state',
		)
		assertRetryWindows(deleteRun)

		const orderedIds = Object.keys(deleteRun.items)
		const results: ReconcileDeleteResult[] = []

		if (!options.execute) {
			for (const statementLineId of orderedIds) {
				const stateItem = deleteRun.items[statementLineId]
				if (!stateItem) continue
				if (stateItem.status === 'deleted') {
					const result = {
						statementLineId,
						status: 'skipped' as const,
						bankTransactionId: stateItem.bankTransactionId,
						error: 'already deleted',
					}
					results.push(result)
					reportResult(ctx, result)
					continue
				}
				if (stateItem.status === 'errored') {
					const result = {
						statementLineId,
						status: 'skipped' as const,
						bankTransactionId: stateItem.bankTransactionId,
						error: stateItem.errorReason ?? 'already errored',
					}
					results.push(result)
					reportResult(ctx, result)
					continue
				}
				const result = {
					statementLineId,
					status: 'dry-run' as const,
					bankTransactionId: stateItem.bankTransactionId,
				}
				results.push(result)
				reportResult(ctx, result)
			}
			const summary = summarizeResults(results)
			writeSuccess(
				ctx,
				{
					command: 'reconcile-delete',
					postRunPath: options.postRun,
					quarter: deleteRun.quarter,
					summary,
					results,
				},
				[
					'Reconcile delete dry-run complete',
					`Dry-run: ${summary.dryRun}`,
					`Skipped: ${summary.skipped}`,
				],
				`${summary.dryRun}`,
			)
			return EXIT_OK
		}

		const tokens = await loadValidTokens(ctx.eventsConfig)
		const config = await loadXeroConfig()
		if (!config) {
			writeError(
				ctx,
				'Missing tenant config. Run: bun run xero-cli auth',
				'E_UNAUTHORIZED',
				'XeroAuthError',
			)
			return EXIT_UNAUTHORIZED
		}

		emitEvent(ctx.eventsConfig, 'xero-reconcile-delete-started', {
			mode: 'execute',
			total: orderedIds.length,
			postRunPath: options.postRun,
			quarter: deleteRun.quarter,
		})

		for (const statementLineId of orderedIds) {
			if (interrupted) break
			const stateItem = deleteRun.items[statementLineId]
			if (!stateItem) continue

			if (stateItem.status === 'deleted') {
				const result = {
					statementLineId,
					status: 'skipped' as const,
					bankTransactionId: stateItem.bankTransactionId,
					error: 'already deleted',
				}
				results.push(result)
				reportResult(ctx, result)
				continue
			}
			if (stateItem.status === 'errored') {
				const result = {
					statementLineId,
					status: 'skipped' as const,
					bankTransactionId: stateItem.bankTransactionId,
					error: stateItem.errorReason ?? 'already errored',
				}
				results.push(result)
				reportResult(ctx, result)
				continue
			}

			try {
				await deleteBankTransaction(
					tokens.accessToken,
					config.tenantId,
					stateItem.bankTransactionId,
					{ eventsConfig: ctx.eventsConfig },
				)
				const logEntry = markDeleted(deleteRun, stateItem, statementLineId)
				await saveDeleteRunState(deleteRun, options.postRun)
				await appendDeleteRunLog(deleteRun.logFile, logEntry)
				const result = {
					statementLineId,
					status: 'deleted' as const,
					bankTransactionId: stateItem.bankTransactionId,
				}
				results.push(result)
				reportResult(ctx, result)
				emitEvent(ctx.eventsConfig, 'xero-reconcile-delete-item-succeeded', {
					statementLineId,
					bankTransactionId: stateItem.bankTransactionId,
				})
			} catch (err) {
				const failure = markFailure(deleteRun, stateItem, statementLineId, err)
				await saveDeleteRunState(deleteRun, options.postRun)
				await appendDeleteRunLog(deleteRun.logFile, failure.logEntry)
				results.push(failure.result)
				reportResult(ctx, failure.result)
				emitEvent(ctx.eventsConfig, 'xero-reconcile-delete-item-failed', {
					statementLineId,
					bankTransactionId: stateItem.bankTransactionId,
					error: failure.result.error ?? null,
					status: failure.result.status,
				})
				if (failure.result.status === 'retryable') break
			}
		}

		const summary = summarizeResults(results)
		writeSuccess(
			ctx,
			{
				command: 'reconcile-delete',
				postRunPath: options.postRun,
				quarter: deleteRun.quarter,
				summary,
				results,
				interrupted,
			},
			[
				`Reconcile delete ${options.execute ? 'execute' : 'dry-run'} complete`,
				`Deleted: ${summary.deleted}`,
				`Retryable: ${summary.retryable}`,
				`Failed: ${summary.failed}`,
				`Skipped: ${summary.skipped}`,
			],
			`${summary.deleted}`,
		)
		emitEvent(ctx.eventsConfig, 'xero-reconcile-delete-completed', {
			executed: options.execute,
			summary,
			interrupted,
		})
		if (interrupted) return EXIT_INTERRUPTED
		if (summary.failed > 0 || summary.retryable > 0) return EXIT_RUNTIME
		return EXIT_OK
	} catch (err) {
		return handleCommandErrorWithContext(ctx, err, {
			postRunPath: options.postRun,
		})
	} finally {
		process.off('SIGINT', handleSigint)
		process.off('SIGTERM', handleSigterm)
		if (lockAcquired) {
			try {
				await releaseLock(process.cwd())
			} catch (err) {
				reconcileDeleteLogger.warn(
					'Failed to release lock on finalize: {error}',
					{
						error: err instanceof Error ? err.message : String(err),
					},
				)
			}
		}
	}
}
