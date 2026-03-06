export interface OutputCapture {
	readonly getStdout: () => string
	readonly getStderr: () => string
}

/**
 * Capture process stdout/stderr for the duration of fn and always restore
 * original write handlers, even if fn throws.
 */
export async function withCapturedOutput<T>(
	fn: (capture: OutputCapture) => Promise<T>,
): Promise<T> {
	let stdout = ''
	let stderr = ''
	const originalStdout = process.stdout.write.bind(process.stdout)
	const originalStderr = process.stderr.write.bind(process.stderr)

	// biome-ignore lint/suspicious/noExplicitAny: patching Node stream write signature
	process.stdout.write = ((chunk: any) => {
		stdout += chunk.toString()
		return true
	}) as typeof process.stdout.write

	// biome-ignore lint/suspicious/noExplicitAny: patching Node stream write signature
	process.stderr.write = ((chunk: any) => {
		stderr += chunk.toString()
		return true
	}) as typeof process.stderr.write

	try {
		return await fn({
			getStdout: () => stdout,
			getStderr: () => stderr,
		})
	} finally {
		process.stdout.write = originalStdout
		process.stderr.write = originalStderr
	}
}

/**
 * Temporarily patch global fetch for fn and always restore original fetch.
 */
export async function withPatchedFetch<T>(
	patch: (originalFetch: typeof fetch) => typeof fetch,
	fn: () => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch
	globalThis.fetch = patch(originalFetch)
	try {
		return await fn()
	} finally {
		globalThis.fetch = originalFetch
	}
}

/**
 * Temporarily patch Bun.stdin.stream to return a deterministic in-memory stream.
 * Always restores the original stream function.
 */
export async function withPatchedBunStdin<T>(
	input: string,
	fn: () => Promise<T>,
): Promise<T> {
	const original = Bun.stdin.stream
	// biome-ignore lint/suspicious/noExplicitAny: patching Bun.stdin internal
	;(Bun.stdin as any).stream = () =>
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(input))
				controller.close()
			},
		})
	try {
		return await fn()
	} finally {
		// biome-ignore lint/suspicious/noExplicitAny: restoring Bun.stdin internal
		;(Bun.stdin as any).stream = original
	}
}
