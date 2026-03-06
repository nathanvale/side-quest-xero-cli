import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadState, saveState } from '../../src/state/state'
import { loadXeroConfig, saveXeroConfig } from '../../src/xero/config'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), 'xero-cli-sec-'))
	const original = process.cwd()
	process.chdir(dir)
	try {
		return await fn(dir)
	} finally {
		process.chdir(original)
		await rm(dir, { recursive: true, force: true })
	}
}

describe('filesystem security', () => {
	it('writes state atomically with secure permissions', async () => {
		await withTempDir(async () => {
			await saveState({ schemaVersion: 1, processed: { a: true } })
			const info = await stat('.xero-reconcile-state.json')
			expect(info.mode & 0o777).toBe(0o600)

			const files = await readdir('.')
			const tmpFiles = files.filter((file) => file.includes('.xero-reconcile-state.json.tmp-'))
			expect(tmpFiles.length).toBe(0)
		})
	})

	it('rejects symlinked state file', async () => {
		await withTempDir(async () => {
			await writeFile('real-state.json', JSON.stringify({ schemaVersion: 1, processed: {} }), {
				mode: 0o600,
			})
			await symlink('real-state.json', '.xero-reconcile-state.json')
			await expect(loadState()).rejects.toThrow()
		})
	})

	it('writes config atomically with secure permissions', async () => {
		await withTempDir(async () => {
			await saveXeroConfig({ tenantId: 'tenant', orgName: 'Test' })
			const info = await stat('.xero-config.json')
			expect(info.mode & 0o777).toBe(0o600)
		})
	})

	it('rejects insecure config permissions', async () => {
		await withTempDir(async () => {
			await writeFile(
				'.xero-config.json',
				JSON.stringify({ tenantId: 'tenant', orgName: 'Test' }),
				{ mode: 0o644 },
			)
			await expect(loadXeroConfig()).rejects.toThrow()
		})
	})

	it('rejects symlinked config file', async () => {
		await withTempDir(async () => {
			await writeFile('real-config.json', JSON.stringify({ tenantId: 'tenant' }), {
				mode: 0o600,
			})
			await symlink('real-config.json', '.xero-config.json')
			await expect(loadXeroConfig()).rejects.toThrow()
		})
	})
})
