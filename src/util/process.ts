/**
 * Check whether a process with the given PID is still running.
 *
 * Uses the POSIX `kill(pid, 0)` trick: signal 0 performs error checking
 * without actually sending a signal, so it returns successfully only if
 * the process exists and we have permission to signal it.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		if (
			err instanceof Error &&
			'code' in err &&
			(err as NodeJS.ErrnoException).code === 'EPERM'
		) {
			// EPERM means the process exists but we lack permission.
			return true
		}
		return false
	}
}
