import { lstat, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getXeroLogger } from '../logging'
import { isProcessAlive } from '../util/process'
import { XeroApiError, XeroConflictError } from '../xero/errors'

const LOCK_FILE = '.xero-reconcile-lock.json'
const LOCK_MODE = 0o600
const lockLogger = getXeroLogger(['xero', 'state'])

const LockPayloadSchema = z.object({
	pid: z.number().int().positive(),
	createdAt: z.number().int().nonnegative(),
})

interface LockPayload {
	readonly pid: number
	readonly createdAt: number
}

/** Resolve the absolute path of the reconcile lock file. */
export function resolveLockPath(cwd = process.cwd()): string {
	return path.join(cwd, LOCK_FILE)
}

async function readLock(cwd = process.cwd()): Promise<LockPayload | null> {
	const lockPath = resolveLockPath(cwd)
	try {
		const statInfo = await lstat(lockPath)
		if (statInfo.isSymbolicLink()) {
			throw new XeroApiError(
				`Refusing to read symlinked lock file: ${lockPath}`,
				{
					code: 'E_RUNTIME',
					recoverable: false,
					context: { lockPath },
				},
			)
		}
		const raw = await readFile(lockPath, 'utf8')
		let parsed: unknown
		try {
			parsed = JSON.parse(raw) as unknown
		} catch {
			lockLogger.warn(
				'Corrupt lock file (malformed JSON), removing stale lock',
				{ lockPath },
			)
			await unlink(lockPath).catch(() => {})
			return null
		}
		const validated = LockPayloadSchema.safeParse(parsed)
		if (!validated.success) {
			lockLogger.warn('Corrupt lock file payload, removing stale lock', {
				lockPath,
				details: validated.error.issues.map((issue) => issue.message),
			})
			await unlink(lockPath).catch(() => {})
			return null
		}
		return validated.data
	} catch (err) {
		if (
			err instanceof Error &&
			'code' in err &&
			(err as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return null
		}
		throw err
	}
}

/** Acquire a process lock for --execute runs. */
export async function acquireLock(cwd = process.cwd()): Promise<void> {
	const lockPath = resolveLockPath(cwd)
	const existing = await readLock(cwd)
	if (existing) {
		if (isProcessAlive(existing.pid)) {
			throw new XeroConflictError('Another reconcile run is in progress', {
				code: 'E_LOCK_CONTENTION',
				recoverable: true,
			})
		}
		await unlink(lockPath)
	}

	const payload: LockPayload = { pid: process.pid, createdAt: Date.now() }
	try {
		const handle = await open(lockPath, 'wx', LOCK_MODE)
		try {
			await handle.writeFile(JSON.stringify(payload), 'utf8')
			await handle.sync()
		} finally {
			await handle.close()
		}
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error as NodeJS.ErrnoException).code === 'EEXIST'
		) {
			throw new XeroConflictError('Another reconcile run is in progress', {
				code: 'E_LOCK_CONTENTION',
				recoverable: true,
			})
		}
		throw error
	}
}

/** Release the reconcile lock. */
export async function releaseLock(cwd = process.cwd()): Promise<void> {
	const lockPath = resolveLockPath(cwd)
	try {
		await unlink(lockPath)
	} catch (err) {
		if (
			err instanceof Error &&
			'code' in err &&
			(err as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return
		}
		throw err
	}
}
