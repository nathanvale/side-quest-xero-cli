import { createHash } from 'node:crypto'
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
import { createBankTransaction } from '../../xero/reconcile/api'
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

const reconcilePostLogger = getXeroLogger(['cli', 'commands', 'reconcile-post'])
const POST_RUN_MODE = 0o600

const QueueItemSchema = z.object({
	statementLineId: z.string().regex(UUID_SHAPE, 'Invalid statementLineId'),
	status: z.enum(['APPROVE', 'EDIT']),
	body: z.record(z.string(), z.unknown()),
})

const PostQueueSchema = z
	.object({
		schemaVersion: z.number().int().min(1),
		quarter: z.string().min(1),
		queueHash: z.string().min(1),
		items: z.array(QueueItemSchema),
	})
	.passthrough()

const PostRunItemSchema = z.object({
	statementLineId: z.string().regex(UUID_SHAPE, 'Invalid statementLineId'),
	status: z.enum(['confirmed', 'posted', 'errored']),
	idempotencyKey: z.string().min(1),
	requestHash: z.string().min(1),
	responseCode: z.number().int().nullable().optional(),
	bankTransactionId: z.string().nullable().optional(),
	errorReason: z.string().nullable().optional(),
	postedAt: z.string().nullable().optional(),
	nextRetryAt: z.string().nullable().optional(),
	tenantPauseUntil: z.string().nullable().optional(),
	sameKeyRetryUntil: z.string().nullable().optional(),
})

const PostRunStateSchema = z
	.object({
		schemaVersion: z.number().int().min(1),
		quarter: z.string().min(1),
		queueHash: z.string().min(1),
		writeInterlock: z.string().min(1),
		logFile: z.string().min(1),
		items: z.record(z.string(), PostRunItemSchema),
	})
	.passthrough()

type ReconcilePostQueueCommand = {
	readonly command: 'reconcile-post'
	readonly execute: boolean
	readonly queue: string
	readonly postRun: string
}

type PostQueue = z.infer<typeof PostQueueSchema>
type PostRunState = z.infer<typeof PostRunStateSchema>
type PostRunItem = z.infer<typeof PostRunItemSchema>

interface ReconcilePostResult {
	readonly statementLineId: string
	readonly status: 'posted' | 'skipped' | 'failed' | 'dry-run' | 'retryable'
	readonly bankTransactionId?: string
	readonly error?: string
}

interface ReconcilePostSummary {
	total: number
	posted: number
	skipped: number
	failed: number
	dryRun: number
	retryable: number
}

function stableJsonStringify(value: unknown): string {
	if (value === null) return 'null'
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
		return `{${entries
			.map(
				([key, entryValue]) =>
					`${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`,
			)
			.join(',')}}`
	}
	return 'null'
}

/** Return the canonical SHA-256 digest for queue/state JSON payloads. */
export function jsonSha256(value: unknown): string {
	return createHash('sha256').update(stableJsonStringify(value)).digest('hex')
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

async function savePostRunState(
	state: PostRunState,
	pathname: string,
): Promise<void> {
	const statePath = path.resolve(pathname)
	const directory = path.dirname(statePath)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const tempPath = `${statePath}.tmp-${Date.now()}`
	const payload = JSON.stringify(state, null, 2)
	const handle = await open(tempPath, 'wx', POST_RUN_MODE)
	try {
		await handle.writeFile(payload, 'utf8')
		await handle.sync()
	} finally {
		await handle.close()
	}
	await rename(tempPath, statePath)
	const info = await stat(statePath)
	if ((info.mode & 0o777) !== POST_RUN_MODE) {
		throw new XeroApiError('Post-run state permissions incorrect', {
			code: 'E_RUNTIME',
			recoverable: false,
			context: {
				statePath,
				expectedMode: POST_RUN_MODE,
				actualMode: info.mode & 0o777,
			},
		})
	}
}

async function appendPostRunLog(
	pathname: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await appendFile(pathname, `${JSON.stringify(payload)}\n`, 'utf8')
}

function summarizeResults(
	results: readonly ReconcilePostResult[],
): ReconcilePostSummary {
	const summary: ReconcilePostSummary = {
		total: results.length,
		posted: 0,
		skipped: 0,
		failed: 0,
		dryRun: 0,
		retryable: 0,
	}
	for (const result of results) {
		if (result.status === 'posted') summary.posted += 1
		else if (result.status === 'skipped') summary.skipped += 1
		else if (result.status === 'failed') summary.failed += 1
		else if (result.status === 'dry-run') summary.dryRun += 1
		else if (result.status === 'retryable') summary.retryable += 1
	}
	return summary
}

function validateQueueState(queue: PostQueue, postRun: PostRunState): void {
	if (queue.queueHash !== postRun.queueHash) {
		throw new XeroApiError('Post queue hash does not match post-run state', {
			code: 'E_STALE_DATA',
			recoverable: true,
			context: {
				queueHash: queue.queueHash,
				postRunQueueHash: postRun.queueHash,
			},
		})
	}
	if (queue.quarter !== postRun.quarter) {
		throw new XeroApiError('Post queue quarter does not match post-run state', {
			code: 'E_STALE_DATA',
			recoverable: true,
			context: { queueQuarter: queue.quarter, postRunQuarter: postRun.quarter },
		})
	}
	if (postRun.writeInterlock !== `WRITE ${queue.quarter}`) {
		throw new XeroApiError(
			'Post-run write interlock does not match queue quarter',
			{
				code: 'E_STALE_DATA',
				recoverable: true,
				context: {
					writeInterlock: postRun.writeInterlock,
					expected: `WRITE ${queue.quarter}`,
				},
			},
		)
	}
	const queueIds = new Set(queue.items.map((item) => item.statementLineId))
	const stateIds = new Set(Object.keys(postRun.items))
	for (const id of queueIds) {
		const stateItem = postRun.items[id]
		if (!stateItem) {
			throw new XeroApiError(`Post-run state is missing ${id}`, {
				code: 'E_STALE_DATA',
				recoverable: true,
			})
		}
		const expectedHash = jsonSha256(
			queue.items.find((item) => item.statementLineId === id)?.body ?? null,
		)
		if (stateItem.requestHash !== expectedHash) {
			throw new XeroApiError(`Request hash mismatch for ${id}`, {
				code: 'E_STALE_DATA',
				recoverable: true,
				context: { statementLineId: id },
			})
		}
	}
	for (const id of stateIds) {
		if (!queueIds.has(id)) {
			throw new XeroApiError(`Post-run state contains unknown ${id}`, {
				code: 'E_STALE_DATA',
				recoverable: true,
			})
		}
	}
}

function assertRetryWindows(postRun: PostRunState): void {
	const now = Date.now()
	const activePauses = Object.values(postRun.items)
		.flatMap((item) => [item.tenantPauseUntil, item.nextRetryAt])
		.map((value) => parseIsoOrNull(value))
		.filter((value): value is number => value !== null && value > now)
	if (activePauses.length > 0) {
		const earliest = Math.min(...activePauses)
		throw new XeroApiError(
			`Post run is paused until ${new Date(earliest).toISOString()}`,
			{
				code: 'E_RATE_LIMITED',
				recoverable: true,
				context: { retryAfterMs: earliest - now },
			},
		)
	}
	for (const item of Object.values(postRun.items)) {
		if (item.status !== 'confirmed') continue
		const retryUntil = parseIsoOrNull(item.sameKeyRetryUntil)
		if (retryUntil !== null && retryUntil <= now) {
			throw new XeroApiError(
				`Idempotency retry window expired for ${item.statementLineId}; regenerate the post run after verifying live drift`,
				{
					code: 'E_CONFLICT',
					recoverable: true,
					context: { statementLineId: item.statementLineId },
				},
			)
		}
	}
}

function reportResult(ctx: OutputContext, result: ReconcilePostResult): void {
	if (ctx.json || ctx.quiet) return
	let prefix = 'SKIP'
	if (result.status === 'posted') prefix = 'OK'
	if (result.status === 'failed') prefix = 'ERR'
	if (result.status === 'dry-run') prefix = 'DRY'
	if (result.status === 'retryable') prefix = 'RETRY'
	const suffix = result.bankTransactionId
		? ` -> ${result.bankTransactionId}`
		: ''
	const error = result.error ? ` - ${result.error}` : ''
	process.stderr.write(`${prefix} ${result.statementLineId}${suffix}${error}\n`)
}

function markPosted(
	postRun: PostRunState,
	item: PostRunItem,
	statementLineId: string,
	bankTransactionId: string,
): Record<string, unknown> {
	const attemptedAt = nowIso()
	postRun.items[statementLineId] = {
		...item,
		status: 'posted',
		responseCode: 200,
		bankTransactionId,
		errorReason: null,
		postedAt: attemptedAt,
		nextRetryAt: null,
		tenantPauseUntil: null,
		sameKeyRetryUntil: null,
	}
	return {
		statementLineId,
		idempotencyKey: item.idempotencyKey,
		attemptedAt,
		responseCode: 200,
		bankTransactionId,
		errorReason: null,
		result: 'posted',
	}
}

function markFailure(
	postRun: PostRunState,
	item: PostRunItem,
	statementLineId: string,
	err: unknown,
): {
	readonly logEntry: Record<string, unknown>
	readonly result: ReconcilePostResult
} {
	const attemptedAt = nowIso()
	const message = err instanceof Error ? err.message : String(err)
	if (err instanceof XeroApiError && err.code === 'E_RATE_LIMITED') {
		const retryAfterMs =
			err.context && typeof err.context.retryAfterMs === 'number'
				? err.context.retryAfterMs
				: 60_000
		const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString()
		postRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: err.status ?? 429,
			errorReason: message,
			nextRetryAt,
		}
		return {
			logEntry: {
				statementLineId,
				idempotencyKey: item.idempotencyKey,
				attemptedAt,
				responseCode: err.status ?? 429,
				bankTransactionId: null,
				errorReason: message,
				result: 'retryable',
				nextRetryAt,
			},
			result: { statementLineId, status: 'retryable', error: message },
		}
	}
	if (err instanceof XeroApiError && err.status === 503) {
		const tenantPauseUntil = plusSeconds(attemptedAt, 5 * 60)
		postRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: 503,
			errorReason: message,
			tenantPauseUntil,
		}
		return {
			logEntry: {
				statementLineId,
				idempotencyKey: item.idempotencyKey,
				attemptedAt,
				responseCode: 503,
				bankTransactionId: null,
				errorReason: message,
				result: 'retryable',
				tenantPauseUntil,
			},
			result: { statementLineId, status: 'retryable', error: message },
		}
	}
	if (err instanceof XeroApiError && err.code === 'E_NETWORK') {
		const sameKeyRetryUntil = plusSeconds(attemptedAt, 6 * 60)
		postRun.items[statementLineId] = {
			...item,
			status: 'confirmed',
			responseCode: null,
			errorReason: message,
			sameKeyRetryUntil,
		}
		return {
			logEntry: {
				statementLineId,
				idempotencyKey: item.idempotencyKey,
				attemptedAt,
				responseCode: null,
				bankTransactionId: null,
				errorReason: message,
				result: 'retryable',
				sameKeyRetryUntil,
			},
			result: { statementLineId, status: 'retryable', error: message },
		}
	}
	postRun.items[statementLineId] = {
		...item,
		status: 'errored',
		responseCode: err instanceof XeroApiError ? (err.status ?? null) : null,
		errorReason: message,
	}
	return {
		logEntry: {
			statementLineId,
			idempotencyKey: item.idempotencyKey,
			attemptedAt,
			responseCode: err instanceof XeroApiError ? (err.status ?? null) : null,
			bankTransactionId: null,
			errorReason: message,
			result: 'errored',
		},
		result: { statementLineId, status: 'failed', error: message },
	}
}

/** Execute a confirmed CSV round-trip post queue through the Xero Accounting API. */
export async function runReconcilePostQueue(
	ctx: OutputContext,
	options: ReconcilePostQueueCommand,
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
		reconcilePostLogger.info('Reconcile post run started in {mode} mode', {
			mode: options.execute ? 'execute' : 'dry-run',
			queue: options.queue,
			postRun: options.postRun,
		})

		loadEnvConfig()
		if (options.execute) {
			await acquireLock(process.cwd())
			lockAcquired = true
		}

		const queue = await loadJsonFile(
			options.queue,
			PostQueueSchema,
			'post queue',
		)
		const postRun = await loadJsonFile(
			options.postRun,
			PostRunStateSchema,
			'post-run state',
		)
		validateQueueState(queue, postRun)
		assertRetryWindows(postRun)

		const itemsById = new Map(
			queue.items.map((item) => [item.statementLineId, item] as const),
		)
		const orderedIds = queue.items.map((item) => item.statementLineId)
		const results: ReconcilePostResult[] = []

		if (!options.execute) {
			for (const statementLineId of orderedIds) {
				const stateItem = postRun.items[statementLineId]
				if (!stateItem) continue
				if (stateItem.status === 'posted') {
					const result = {
						statementLineId,
						status: 'skipped' as const,
						bankTransactionId: stateItem.bankTransactionId ?? undefined,
						error: 'already posted',
					}
					results.push(result)
					reportResult(ctx, result)
					continue
				}
				if (stateItem.status === 'errored') {
					const result = {
						statementLineId,
						status: 'skipped' as const,
						error: stateItem.errorReason ?? 'already errored',
					}
					results.push(result)
					reportResult(ctx, result)
					continue
				}
				const result = { statementLineId, status: 'dry-run' as const }
				results.push(result)
				reportResult(ctx, result)
			}
			const summary = summarizeResults(results)
			writeSuccess(
				ctx,
				{
					command: 'reconcile-post',
					queuePath: options.queue,
					postRunPath: options.postRun,
					quarter: queue.quarter,
					queueHash: queue.queueHash,
					summary,
					results,
				},
				[
					'Reconcile post dry-run complete',
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

		emitEvent(ctx.eventsConfig, 'xero-reconcile-post-started', {
			mode: 'execute',
			total: orderedIds.length,
			queuePath: options.queue,
			postRunPath: options.postRun,
			quarter: queue.quarter,
		})

		for (const statementLineId of orderedIds) {
			if (interrupted) break
			const queueItem = itemsById.get(statementLineId)
			const stateItem = postRun.items[statementLineId]
			if (!queueItem || !stateItem) continue
			const currentStateItem = stateItem

			if (currentStateItem.status === 'posted') {
				const result = {
					statementLineId,
					status: 'skipped' as const,
					bankTransactionId: currentStateItem.bankTransactionId ?? undefined,
					error: 'already posted',
				}
				results.push(result)
				reportResult(ctx, result)
				continue
			}
			if (currentStateItem.status === 'errored') {
				const result = {
					statementLineId,
					status: 'skipped' as const,
					error: currentStateItem.errorReason ?? 'already errored',
				}
				results.push(result)
				reportResult(ctx, result)
				continue
			}

			try {
				const created = await createBankTransaction(
					tokens.accessToken,
					config.tenantId,
					queueItem.body,
					{
						eventsConfig: ctx.eventsConfig,
						idempotencyKey: currentStateItem.idempotencyKey,
					},
				)
				const bankTransactionId = created.BankTransactionID
				if (!bankTransactionId) {
					throw new XeroApiError('Missing BankTransactionID in POST response', {
						code: 'E_MALFORMED_RESPONSE',
						recoverable: false,
					})
				}
				const logEntry = markPosted(
					postRun,
					currentStateItem,
					statementLineId,
					bankTransactionId,
				)
				await savePostRunState(postRun, options.postRun)
				await appendPostRunLog(postRun.logFile, logEntry)
				const result = {
					statementLineId,
					status: 'posted' as const,
					bankTransactionId,
				}
				results.push(result)
				reportResult(ctx, result)
				emitEvent(ctx.eventsConfig, 'xero-reconcile-post-item-succeeded', {
					statementLineId,
					bankTransactionId,
				})
			} catch (err) {
				const failure = markFailure(
					postRun,
					currentStateItem,
					statementLineId,
					err,
				)
				await savePostRunState(postRun, options.postRun)
				await appendPostRunLog(postRun.logFile, failure.logEntry)
				results.push(failure.result)
				reportResult(ctx, failure.result)
				emitEvent(ctx.eventsConfig, 'xero-reconcile-post-item-failed', {
					statementLineId,
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
				command: 'reconcile-post',
				queuePath: options.queue,
				postRunPath: options.postRun,
				quarter: queue.quarter,
				queueHash: queue.queueHash,
				summary,
				results,
				interrupted,
			},
			[
				`Reconcile post ${options.execute ? 'execute' : 'dry-run'} complete`,
				`Posted: ${summary.posted}`,
				`Retryable: ${summary.retryable}`,
				`Failed: ${summary.failed}`,
				`Skipped: ${summary.skipped}`,
			],
			`${summary.posted}`,
		)
		emitEvent(ctx.eventsConfig, 'xero-reconcile-post-completed', {
			executed: options.execute,
			summary,
			interrupted,
		})
		if (interrupted) return EXIT_INTERRUPTED
		if (summary.failed > 0 || summary.retryable > 0) return EXIT_RUNTIME
		return EXIT_OK
	} catch (err) {
		return handleCommandErrorWithContext(ctx, err, {
			queuePath: options.queue,
			postRunPath: options.postRun,
		})
	} finally {
		process.off('SIGINT', handleSigint)
		process.off('SIGTERM', handleSigterm)
		if (lockAcquired) {
			try {
				await releaseLock(process.cwd())
			} catch (err) {
				reconcilePostLogger.warn(
					'Failed to release lock on finalize: {error}',
					{
						error: err instanceof Error ? err.message : String(err),
					},
				)
			}
		}
	}
}
