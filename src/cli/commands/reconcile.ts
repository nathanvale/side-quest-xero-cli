import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { acquireLock, releaseLock } from '../../state/lock'
import { resolveStatePath } from '../../state/state'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import {
	assertValidBankTransactionResponse,
	assertValidPaymentResponse,
} from '../../xero/reconcile/api'
import { pruneAudits } from '../../xero/reconcile/audit'
import {
	loadReconcileInputs,
	parseCsvLine,
	validateCsvPath,
} from '../../xero/reconcile/input'
import { runReconcileSession } from '../../xero/reconcile/session'
import type {
	ReconcileCommand,
	RuntimeCheckpointState,
} from '../../xero/reconcile/types'
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

/** Dependency boundary:
 * reconcile.ts orchestrates input loading, lock lifecycle, and output only.
 * Xero API, validation, audit, and stateful execution live under src/xero/reconcile/.
 */

const reconcileLogger = getXeroLogger(['cli', 'commands', 'reconcile'])

export {
	assertValidBankTransactionResponse,
	assertValidPaymentResponse,
	parseCsvLine,
	validateCsvPath,
}

/** Reconcile bank transactions using AccountCode or InvoiceID. */
export async function runReconcile(
	ctx: OutputContext,
	options: ReconcileCommand,
): Promise<ExitCode> {
	let lockAcquired = false
	let interrupted = false
	const runCwd = process.cwd()
	const stateFile = resolveStatePath(runCwd)
	const checkpointState: RuntimeCheckpointState = { checkpointId: 'start' }
	const handleSigint = () => {
		interrupted = true
	}
	const handleSigterm = () => {
		interrupted = true
	}

	process.once('SIGINT', handleSigint)
	process.once('SIGTERM', handleSigterm)

	try {
		reconcileLogger.info('Reconcile run started in {mode} mode', {
			mode: options.execute ? 'execute' : 'dry-run',
			fromCsv: options.fromCsv ?? 'stdin',
		})

		loadEnvConfig()
		if (options.execute) {
			await acquireLock(runCwd)
			lockAcquired = true
			await pruneAudits(runCwd)
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

		const inputs = await loadReconcileInputs(ctx.eventsConfig, options)
		const session = await runReconcileSession({
			ctx,
			options,
			inputs,
			accessToken: tokens.accessToken,
			tenantId: config.tenantId,
			runCwd,
			checkpointState,
			isInterrupted: () => interrupted,
		})

		writeSuccess(
			ctx,
			{
				command: 'reconcile',
				summary: session.summary,
				results: session.results,
				interrupted: session.interrupted,
			},
			[
				`Reconcile ${options.execute ? 'execute' : 'dry-run'} complete`,
				`Succeeded: ${session.summary.succeeded}`,
				`Failed: ${session.summary.failed}`,
				...session.digestLines,
			],
			`${session.summary.succeeded}`,
		)
		emitEvent(ctx.eventsConfig, 'xero-reconcile-completed', {
			executed: options.execute,
			summary: session.summary,
			interrupted: session.interrupted,
		})

		reconcileLogger.info('Reconcile run completed in {mode} mode', {
			mode: options.execute ? 'execute' : 'dry-run',
			interrupted: session.interrupted,
			succeeded: session.summary.succeeded,
			failed: session.summary.failed,
		})

		if (session.interrupted) return EXIT_INTERRUPTED
		if (session.summary.failed > 0) return EXIT_RUNTIME
		return EXIT_OK
	} catch (err) {
		return handleCommandErrorWithContext(ctx, err, {
			stateFile,
			checkpointId: checkpointState.checkpointId,
		})
	} finally {
		process.off('SIGINT', handleSigint)
		process.off('SIGTERM', handleSigterm)
		if (lockAcquired) {
			try {
				await releaseLock(runCwd)
			} catch (err) {
				reconcileLogger.warn('Failed to release lock on finalize: {error}', {
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
	}
}
