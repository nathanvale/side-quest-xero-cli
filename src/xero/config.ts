import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { assertSecureFile } from '../util/fs'
import { XeroApiError, XeroAuthError } from './errors'

const CONFIG_FILENAME = '.xero-config.json'
const CONFIG_MODE = 0o600
const CONFIG_DIR_MODE = 0o700

const EnvSchema = z.object({
	XERO_CLIENT_ID: z.string().min(1, 'XERO_CLIENT_ID is required'),
})

const XeroConfigSchema = z.object({
	tenantId: z.string().min(1, 'tenantId is required'),
	orgName: z.string().min(1).optional(),
})

export type XeroConfig = z.infer<typeof XeroConfigSchema>

interface EnvConfig {
	readonly clientId: string
}

function resolveConfigPath(): string {
	return path.join(process.cwd(), CONFIG_FILENAME)
}

let cachedEnvConfig: EnvConfig | null = null

/**
 * Load Xero environment config from process.env.
 * Result is cached after the first successful call since env vars
 * do not change during a CLI invocation.
 */
export function loadEnvConfig(): EnvConfig {
	if (cachedEnvConfig) return cachedEnvConfig
	const result = EnvSchema.safeParse({
		XERO_CLIENT_ID: process.env.XERO_CLIENT_ID,
	})
	if (!result.success) {
		const message = result.error.issues.map((issue) => issue.message).join('; ')
		throw new XeroApiError(`Invalid env config: ${message}`, {
			code: 'E_USAGE',
			recoverable: false,
		})
	}
	cachedEnvConfig = { clientId: result.data.XERO_CLIENT_ID }
	return cachedEnvConfig
}

/** Reset the cached env config (for testing). */
export function resetEnvConfigCache(): void {
	cachedEnvConfig = null
}

/** Load the xero-cli config file, or return null if it doesn't exist. */
export async function loadXeroConfig(): Promise<XeroConfig | null> {
	const configPath = resolveConfigPath()
	if (!existsSync(configPath)) return null
	assertSecureFile(configPath)

	const raw = await readFile(configPath, 'utf8')
	let decoded: unknown
	try {
		decoded = JSON.parse(raw) as unknown
	} catch {
		throw new XeroAuthError('Invalid config file: malformed JSON', {
			code: 'E_UNAUTHORIZED',
			recoverable: false,
			context: { configPath, nextCommand: 'auth' },
		})
	}
	const parsed = XeroConfigSchema.safeParse(decoded)
	if (!parsed.success) {
		const message = parsed.error.issues.map((issue) => issue.message).join('; ')
		throw new XeroAuthError(`Invalid config file: ${message}`, {
			code: 'E_UNAUTHORIZED',
			recoverable: false,
			context: { configPath, nextCommand: 'auth' },
		})
	}
	return parsed.data
}

/** Write the xero-cli config file atomically with secure permissions. */
export async function saveXeroConfig(config: XeroConfig): Promise<void> {
	const configPath = resolveConfigPath()
	await mkdir(path.dirname(configPath), {
		recursive: true,
		mode: CONFIG_DIR_MODE,
	})

	const tempPath = `${configPath}.tmp-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2)}`
	const handle = await open(tempPath, 'wx', CONFIG_MODE)
	try {
		const payload = JSON.stringify(config, null, 2)
		await handle.writeFile(payload, { encoding: 'utf8' })
		await handle.sync()
	} finally {
		await handle.close()
	}

	await rename(tempPath, configPath)
	const statInfo = await stat(configPath)
	const mode = statInfo.mode & 0o777
	if (mode !== CONFIG_MODE) {
		await unlink(configPath)
		throw new XeroApiError(
			`Config file permissions incorrect after write: ${mode.toString(8)}`,
			{
				code: 'E_RUNTIME',
				recoverable: false,
				context: { configPath, mode, expectedMode: CONFIG_MODE },
			},
		)
	}
}
