import { existsSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AUDIT_DIR, AUDIT_DIR_MODE, AUDIT_MODE } from './types'

export async function ensureAuditDir(cwd = process.cwd()): Promise<string> {
	const dir = path.join(cwd, AUDIT_DIR)
	await mkdir(dir, { recursive: true, mode: AUDIT_DIR_MODE })
	return dir
}

export async function pruneAudits(cwd = process.cwd()): Promise<void> {
	const dir = path.join(cwd, AUDIT_DIR)
	if (!existsSync(dir)) return
	const entries = await readdir(dir)
	const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000

	await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry)
			const info = await stat(fullPath)
			if (info.mtimeMs < cutoff) await unlink(fullPath)
		}),
	)
}

export async function createAuditFile(auditPath: string): Promise<void> {
	await writeFile(auditPath, '', {
		encoding: 'utf8',
		mode: AUDIT_MODE,
		flag: 'wx',
	})
}

const AUDIT_FLUSH_THRESHOLD = 50

/**
 * Buffered audit writer that keeps a single file handle open for the
 * duration of a reconciliation run.
 */
export class AuditWriter {
	private handle: FileHandle | null = null
	private buffer: string[] = []

	constructor(private readonly auditPath: string) {}

	async open(): Promise<void> {
		this.handle = await open(this.auditPath, 'a')
	}

	async write(payload: Record<string, unknown>): Promise<void> {
		this.buffer.push(JSON.stringify(payload))
		if (this.buffer.length >= AUDIT_FLUSH_THRESHOLD) {
			await this.flush()
		}
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0 || !this.handle) return
		const data = `${this.buffer.join('\n')}\n`
		this.buffer = []
		await this.handle.write(data, null, 'utf8')
	}

	async close(): Promise<void> {
		try {
			await this.flush()
		} finally {
			if (this.handle) {
				await this.handle.close()
				this.handle = null
			}
		}
	}
}
