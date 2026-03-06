import { lstatSync } from 'node:fs'
import { XeroApiError } from '../xero/errors'

/**
 * Assert that a file is safe to read: not a symlink, and not world/group-readable.
 *
 * Guards against symlink-based path traversal and overly permissive file modes
 * on sensitive files (config, state, etc.).
 */
export function assertSecureFile(targetPath: string): void {
	const statInfo = lstatSync(targetPath)
	if (statInfo.isSymbolicLink()) {
		throw new XeroApiError(`Refusing to read symlinked file: ${targetPath}`, {
			code: 'E_RUNTIME',
			recoverable: false,
			context: { targetPath },
		})
	}
	const mode = statInfo.mode & 0o777
	if ((mode & 0o077) !== 0) {
		throw new XeroApiError(
			`File permissions too open: ${targetPath} (${mode.toString(8)})`,
			{
				code: 'E_RUNTIME',
				recoverable: false,
				context: { targetPath, mode },
			},
		)
	}
}
