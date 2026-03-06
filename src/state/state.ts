import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { assertSecureFile } from '../util/fs'
import { XeroApiError } from '../xero/errors'

export const STATE_FILE = '.xero-reconcile-state.json'
const STATE_MODE = 0o600
const STATE_DIR_MODE = 0o700
const STATE_SCHEMA_VERSION = 1

const ReconcileStateSchema = z.object({
	schemaVersion: z.number().int().min(1).max(STATE_SCHEMA_VERSION),
	processed: z.record(z.string(), z.literal(true)),
})

export interface ReconcileState {
	readonly schemaVersion: number
	readonly processed: Record<string, true>
}

const EMPTY_STATE: ReconcileState = {
	schemaVersion: STATE_SCHEMA_VERSION,
	processed: {},
}

/** Resolve the absolute path of the reconcile state file. */
export function resolveStatePath(cwd = process.cwd()): string {
	return path.join(cwd, STATE_FILE)
}

async function ensureStateDir(cwd = process.cwd()): Promise<void> {
	await mkdir(cwd, { recursive: true, mode: STATE_DIR_MODE })
}

/** Load reconcile state from disk, or return empty state. */
export async function loadState(cwd = process.cwd()): Promise<ReconcileState> {
	const statePath = resolveStatePath(cwd)
	try {
		assertSecureFile(statePath)
		const raw = await readFile(statePath, 'utf8')
		const parsed = JSON.parse(raw) as unknown
		const validated = ReconcileStateSchema.safeParse(parsed)
		if (!validated.success) {
			throw new XeroApiError('Invalid reconcile state file', {
				code: 'E_STALE_DATA',
				recoverable: true,
				context: {
					stateFile: statePath,
					details: validated.error.issues.map((issue) => issue.message),
				},
			})
		}
		return validated.data
	} catch (err) {
		if (
			err instanceof Error &&
			'code' in err &&
			(err as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return EMPTY_STATE
		}
		throw err
	}
}

/** Save reconcile state atomically with secure permissions and fsync before rename. */
export async function saveState(
	state: ReconcileState,
	cwd = process.cwd(),
): Promise<void> {
	await ensureStateDir(cwd)
	const statePath = resolveStatePath(cwd)
	const tempPath = `${statePath}.tmp-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}`
	const payload = JSON.stringify(state, null, 2)

	const handle = await open(tempPath, 'wx', STATE_MODE)
	try {
		await handle.writeFile(payload, 'utf8')
		await handle.sync()
	} finally {
		await handle.close()
	}

	await rename(tempPath, statePath)
	const statInfo = await stat(statePath)
	const mode = statInfo.mode & 0o777
	if (mode !== STATE_MODE) {
		throw new XeroApiError(
			`State file permissions incorrect: ${mode.toString(8)}`,
			{
				code: 'E_RUNTIME',
				recoverable: false,
				context: { statePath, expectedMode: STATE_MODE, actualMode: mode },
			},
		)
	}
}

/** Mark a BankTransactionID as processed in the state (immutable, creates a copy). */
export function markProcessed(
	state: ReconcileState,
	id: string,
): ReconcileState {
	return {
		...state,
		processed: { ...state.processed, [id]: true },
	}
}

/** Check if a BankTransactionID has been processed. */
export function isProcessed(state: ReconcileState, id: string): boolean {
	return Boolean(state.processed[id])
}

const DEFAULT_CHECKPOINT_INTERVAL = 50

/**
 * Batches state updates in memory and flushes to disk periodically.
 *
 * Avoids quadratic I/O from per-item markProcessed + saveState calls.
 * The processed map is mutated in place to avoid O(n^2) spread copies.
 * State is flushed every `checkpointInterval` dirty items and on explicit flush.
 */
export class StateBatcher {
	private readonly processed: Record<string, true>
	private readonly schemaVersion: number
	private dirtyCount = 0
	private flushCount = 0
	private flushInFlight: Promise<void> | null = null
	private readonly checkpointInterval: number
	private readonly onFlush?: (info: { checkpointNumber: number }) => void
	private readonly cwd: string

	constructor(
		initial: ReconcileState,
		checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL,
		onFlush?: (info: { checkpointNumber: number }) => void,
		cwd = process.cwd(),
	) {
		this.schemaVersion = initial.schemaVersion
		// Copy the initial processed map so we own the mutation
		this.processed = { ...initial.processed }
		this.checkpointInterval = checkpointInterval
		this.onFlush = onFlush
		this.cwd = cwd
	}

	/** Check if a BankTransactionID has been processed. */
	isProcessed(id: string): boolean {
		return Boolean(this.processed[id])
	}

	/**
	 * Mark a BankTransactionID as processed.
	 * Automatically flushes to disk every checkpointInterval items.
	 */
	async markProcessed(id: string): Promise<void> {
		this.processed[id] = true
		this.dirtyCount += 1
		if (this.dirtyCount >= this.checkpointInterval) {
			await this.flush()
		}
	}

	/** Persist current state to disk if there are unflushed changes. */
	async flush(): Promise<void> {
		if (this.flushInFlight) {
			await this.flushInFlight
			if (this.dirtyCount === 0) return
		}
		if (this.dirtyCount === 0) return

		const next = (async () => {
			await saveState(this.snapshot(), this.cwd)
			this.dirtyCount = 0
			this.flushCount += 1
			this.onFlush?.({ checkpointNumber: this.flushCount })
		})()
		this.flushInFlight = next
		try {
			await next
		} finally {
			this.flushInFlight = null
		}
	}

	/** Return a readonly snapshot of the current state. */
	snapshot(): ReconcileState {
		return {
			schemaVersion: this.schemaVersion,
			processed: { ...this.processed },
		}
	}
}
