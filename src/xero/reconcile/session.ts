import path from 'node:path'
import type { OutputContext } from '../../cli/output'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { loadState, StateBatcher } from '../../state/state'
import { StructuredError, XeroApiError, XeroConflictError } from '../errors'
import type { BankTransactionRecord } from '../types'
import {
	createPaymentsBatch,
	fetchActiveAccountCodes,
	fetchBankTransactionsBatch,
	fetchInvoicesById,
	fetchUnreconciledSnapshot,
	updateBankTransaction,
} from './api'
import { AuditWriter, createAuditFile, ensureAuditDir } from './audit'
import type {
	ReconcileCommand,
	ReconcileInputBase,
	ReconcileResult,
	ReconcileSummary,
	RetryInfo,
	RuntimeCheckpointState,
} from './types'

const reconcileLogger = getXeroLogger(['cli', 'commands', 'reconcile'])

class ProgressDisplay {
	private lastLineLength = 0

	constructor(private readonly mode: 'animated' | 'static' | 'off') {}

	update(current: number, total: number, message?: string): void {
		if (this.mode === 'off') return
		const base = `Progress ${current}/${total}`
		const line = message ? `${base} - ${message}` : base
		this.writeLine(line, this.mode === 'animated')
	}

	pause(message: string): void {
		if (this.mode === 'off') return
		this.writeLine(`Rate limit pause: ${message}`, false)
	}

	finish(): void {
		if (this.mode === 'off') return
		if (this.mode === 'animated') process.stderr.write('\n')
	}

	private writeLine(line: string, overwrite: boolean): void {
		if (!overwrite) {
			process.stderr.write(`${line}\n`)
			this.lastLineLength = 0
			return
		}
		const padding =
			this.lastLineLength > line.length
				? ' '.repeat(this.lastLineLength - line.length)
				: ''
		process.stderr.write(`\r${line}${padding}`)
		this.lastLineLength = line.length
	}
}

interface RunReconcileSessionArgs {
	readonly ctx: OutputContext
	readonly options: ReconcileCommand
	readonly inputs: ReconcileInputBase[]
	readonly accessToken: string
	readonly tenantId: string
	readonly runCwd: string
	readonly checkpointState: RuntimeCheckpointState
	readonly isInterrupted: () => boolean
}

interface RunReconcileSessionResult {
	readonly results: ReconcileResult[]
	readonly summary: ReconcileSummary
	readonly digestLines: string[]
	readonly interrupted: boolean
}

function summarizeResults(results: ReconcileResult[]): ReconcileSummary {
	const summary: ReconcileSummary = {
		total: results.length,
		succeeded: 0,
		failed: 0,
		skipped: 0,
		dryRun: 0,
	}

	for (const result of results) {
		if (result.status === 'reconciled') summary.succeeded += 1
		else if (result.status === 'failed') summary.failed += 1
		else if (result.status === 'skipped') summary.skipped += 1
		else if (result.status === 'dry-run') summary.dryRun += 1
	}

	return summary
}

function buildAuditDigest(
	ctx: OutputContext,
	results: ReconcileResult[],
	unreconciledSnapshot: Map<string, { Type?: string; Total?: number }>,
): string[] {
	if (ctx.json || ctx.quiet || results.length === 0) return []

	const byAccount = new Map<string, { count: number; total: number }>()
	const byType = new Map<string, { count: number; total: number }>()
	for (const result of results) {
		if (result.status !== 'reconciled') continue
		const snapshot = unreconciledSnapshot.get(result.BankTransactionID)
		const amount = snapshot?.Total ?? 0
		const type = snapshot?.Type ?? 'UNKNOWN'

		if (result.AccountCode) {
			const current = byAccount.get(result.AccountCode) ?? {
				count: 0,
				total: 0,
			}
			current.count += 1
			current.total += amount
			byAccount.set(result.AccountCode, current)
		}

		const typeCurrent = byType.get(type) ?? { count: 0, total: 0 }
		typeCurrent.count += 1
		typeCurrent.total += amount
		byType.set(type, typeCurrent)
	}

	const lines = ['Audit digest:']
	for (const [code, info] of byAccount.entries()) {
		lines.push(`  Account ${code}: ${info.count} (${info.total.toFixed(2)})`)
	}
	for (const [type, info] of byType.entries()) {
		lines.push(`  Type ${type}: ${info.count} (${info.total.toFixed(2)})`)
	}
	return lines
}

/** Execute reconcile items against Xero while preserving resumability state. */
export async function runReconcileSession(
	args: RunReconcileSessionArgs,
): Promise<RunReconcileSessionResult> {
	const progress = new ProgressDisplay(args.ctx.progressMode)
	let auditWriter: AuditWriter | null = null
	let stateBatcher: StateBatcher | null = null
	let processedCount = 0
	const totalCount = args.inputs.length

	try {
		if (args.options.execute) {
			const auditPath = path.join(
				await ensureAuditDir(args.runCwd),
				`${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`,
			)
			await createAuditFile(auditPath)
			auditWriter = new AuditWriter(auditPath)
			await auditWriter.open()
		}

		const retryHandler = (info: RetryInfo) => {
			if (args.ctx.json || args.ctx.quiet) return
			if (info.reason === 'rate-limit') {
				const seconds = Math.max(1, Math.round(info.backoffMs / 1000))
				progress.pause(`${seconds}s`)
			}
		}

		const unreconciledSnapshot = await fetchUnreconciledSnapshot(
			args.accessToken,
			args.tenantId,
			{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
		)
		const unreconciledSet = new Set(unreconciledSnapshot.keys())
		reconcileLogger.info(
			'Preflight: fetched {transactionCount} unreconciled transactions',
			{ transactionCount: unreconciledSnapshot.size },
		)

		const accountCodes = await fetchActiveAccountCodes(
			args.accessToken,
			args.tenantId,
			{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
		)
		reconcileLogger.info(
			'Preflight: loaded {accountCodeCount} active account codes',
			{ accountCodeCount: accountCodes.size },
		)

		const invalidIds = args.inputs
			.filter((input) => !unreconciledSet.has(input.BankTransactionID))
			.map((input) => input.BankTransactionID)
		if (invalidIds.length > 0) {
			const fullLookup = await fetchBankTransactionsBatch(
				args.accessToken,
				args.tenantId,
				invalidIds,
				{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
			)
			const alreadyReconciled = invalidIds.filter((id) => fullLookup.has(id))
			const notFound = invalidIds.filter((id) => !fullLookup.has(id))
			const lines = [
				...alreadyReconciled.map((id) => `Already reconciled: ${id}`),
				...notFound.map((id) => `Not found: ${id}`),
			]
			throw new XeroApiError(lines.join('\n'), {
				code: 'E_STALE_DATA',
				recoverable: true,
				context: { alreadyReconciled, notFound },
			})
		}

		const invalidCodes = args.inputs
			.filter(
				(input) => input.AccountCode && !accountCodes.has(input.AccountCode),
			)
			.map((input) => input.AccountCode)
			.filter(Boolean)
		if (invalidCodes.length > 0) {
			throw new XeroApiError(
				`Invalid AccountCode(s): ${invalidCodes.join(', ')}`,
				{ code: 'E_USAGE', recoverable: false },
			)
		}

		const invoiceIds = args.inputs
			.map((input) => input.InvoiceID)
			.filter((id): id is string => typeof id === 'string')
		const invoicesById =
			invoiceIds.length > 0
				? await fetchInvoicesById(args.accessToken, args.tenantId, invoiceIds, {
						eventsConfig: args.ctx.eventsConfig,
						onRetry: retryHandler,
					})
				: new Map()

		const idsNeedingFullRecord = args.inputs
			.filter((input) => input.AccountCode || input.InvoiceID)
			.map((input) => input.BankTransactionID)
		const bankTxnById =
			idsNeedingFullRecord.length > 0
				? await fetchBankTransactionsBatch(
						args.accessToken,
						args.tenantId,
						idsNeedingFullRecord,
						{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
					)
				: new Map<string, BankTransactionRecord>()

		const state = await loadState(args.runCwd)
		const recoveredIds = Object.keys(state.processed)
		const results: ReconcileResult[] = []

		if (recoveredIds.length > 0) {
			reconcileLogger.info(
				'Resuming from previous state with {recoveredCount} already processed',
				{ recoveredCount: recoveredIds.length },
			)
			emitEvent(args.ctx.eventsConfig, 'xero-state-recovered', {
				recoveredCount: recoveredIds.length,
				totalCount,
			})
		}

		stateBatcher = new StateBatcher(
			state,
			undefined,
			({ checkpointNumber }) => {
				args.checkpointState.checkpointId = `checkpoint-${checkpointNumber}`
				emitEvent(args.ctx.eventsConfig, 'xero-state-checkpoint', {
					processedCount,
					totalCount,
					checkpointNumber,
					checkpointId: args.checkpointState.checkpointId,
				})
			},
			args.runCwd,
		)

		emitEvent(args.ctx.eventsConfig, 'xero-reconcile-started', {
			mode: args.options.execute ? 'execute' : 'dry-run',
			total: totalCount,
			fromCsv: args.options.fromCsv ?? null,
		})

		const reportResult = (result: ReconcileResult): void => {
			if (args.ctx.json || args.ctx.quiet) return
			let prefix = 'SKIP'
			if (result.status === 'reconciled') prefix = 'OK'
			if (result.status === 'failed') prefix = 'ERR'
			if (result.status === 'dry-run') prefix = 'DRY'
			const detail = result.AccountCode
				? `AccountCode ${result.AccountCode}`
				: result.InvoiceID
					? `Invoice ${result.InvoiceID}`
					: 'No detail'
			const message = result.error ? ` - ${result.error}` : ''
			process.stderr.write(
				`${prefix} ${result.BankTransactionID} (${detail}) ${result.status}${message}\n`,
			)
		}

		for (const input of args.inputs) {
			if (stateBatcher.isProcessed(input.BankTransactionID)) {
				const result: ReconcileResult = {
					BankTransactionID: input.BankTransactionID,
					status: 'skipped',
					AccountCode: input.AccountCode,
					InvoiceID: input.InvoiceID,
				}
				results.push(result)
				processedCount += 1
				args.checkpointState.checkpointId = `item-${processedCount}`
				reportResult(result)
				progress.update(processedCount, totalCount)
				emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-skipped', {
					bankTransactionId: input.BankTransactionID,
					reason: 'already-processed',
				})
				if (args.isInterrupted()) break
				continue
			}

			if (!args.options.execute) {
				const result: ReconcileResult = {
					BankTransactionID: input.BankTransactionID,
					status: 'dry-run',
					AccountCode: input.AccountCode,
					InvoiceID: input.InvoiceID,
				}
				results.push(result)
				processedCount += 1
				args.checkpointState.checkpointId = `item-${processedCount}`
				reportResult(result)
				progress.update(processedCount, totalCount)
				emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-skipped', {
					bankTransactionId: input.BankTransactionID,
					reason: 'dry-run',
					accountCode: input.AccountCode,
					invoiceId: input.InvoiceID,
				})
				if (args.isInterrupted()) break
				continue
			}

			const itemStart = performance.now()
			try {
				if (input.AccountCode) {
					const pre = bankTxnById.get(input.BankTransactionID)
					if (!pre) {
						throw new XeroApiError(
							`BankTransaction not found in prefetch: ${input.BankTransactionID}`,
							{ code: 'E_STALE_DATA', recoverable: true },
						)
					}
					const existing = pre.LineItems ?? []
					const hasSplit =
						existing.length > 1 &&
						new Set(existing.map((item) => item.AccountCode)).size > 1
					if (hasSplit) {
						throw new XeroApiError('BankTransaction has split line items', {
							code: 'E_CONFLICT',
							recoverable: true,
						})
					}
					const lineItems =
						existing.length === 0
							? [
									{
										Description: 'Auto-reconciled via xero-cli',
										Quantity: 1,
										UnitAmount: pre.Total ?? 0,
										LineAmount: pre.Total ?? 0,
										TaxType: 'INPUT',
										AccountCode: input.AccountCode,
									},
								]
							: existing.map((item) => ({
									...item,
									AccountCode: input.AccountCode,
								}))

					await updateBankTransaction(
						args.accessToken,
						args.tenantId,
						input.BankTransactionID,
						lineItems,
						pre.Total,
						{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
					)

					const result: ReconcileResult = {
						BankTransactionID: input.BankTransactionID,
						status: 'reconciled',
						AccountCode: input.AccountCode,
					}
					results.push(result)
					await stateBatcher.markProcessed(input.BankTransactionID)
					if (auditWriter) {
						await auditWriter.write({
							type: 'account-code',
							BankTransactionID: input.BankTransactionID,
							AccountCode: input.AccountCode,
							status: 'reconciled',
							originalLineItems: pre.LineItems,
						})
					}
					emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-succeeded', {
						bankTransactionId: input.BankTransactionID,
						accountCode: input.AccountCode,
						type: 'account-code',
						durationMs: Math.round(performance.now() - itemStart),
					})
					processedCount += 1
					args.checkpointState.checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}

				if (input.InvoiceID) {
					if (!input.Amount || !input.CurrencyCode) {
						throw new XeroApiError(
							'Invoice payments require Amount and CurrencyCode',
							{ code: 'E_USAGE', recoverable: false },
						)
					}
					const invoice = invoicesById.get(input.InvoiceID)
					if (!invoice) {
						throw new XeroApiError(`Invoice not found: ${input.InvoiceID}`, {
							code: 'E_NOT_FOUND',
							recoverable: false,
						})
					}
					if (invoice.Status !== 'AUTHORISED') {
						throw new XeroApiError(
							`Invoice not AUTHORISED: ${input.InvoiceID}`,
							{ code: 'E_CONFLICT', recoverable: true },
						)
					}
					if (invoice.CurrencyCode !== input.CurrencyCode) {
						throw new XeroApiError(
							`Invoice currency mismatch: ${input.InvoiceID}`,
							{ code: 'E_CONFLICT', recoverable: true },
						)
					}
					if (invoice.AmountDue < input.Amount) {
						throw new XeroApiError(
							`Invoice amount due less than input: ${input.InvoiceID}`,
							{ code: 'E_CONFLICT', recoverable: true },
						)
					}
					const bankTxn = bankTxnById.get(input.BankTransactionID)
					if (!bankTxn) {
						throw new XeroApiError(
							`BankTransaction not found in prefetch: ${input.BankTransactionID}`,
							{ code: 'E_STALE_DATA', recoverable: true },
						)
					}
					const bankAccountId = bankTxn.BankAccount?.AccountID
					if (!bankAccountId) {
						throw new XeroApiError(
							'Missing BankAccount.AccountID for payment',
							{
								code: 'E_MALFORMED_RESPONSE',
								recoverable: false,
							},
						)
					}
					const payments = await createPaymentsBatch(
						args.accessToken,
						args.tenantId,
						[
							{
								Invoice: { InvoiceID: input.InvoiceID },
								Account: { AccountID: bankAccountId },
								Amount: input.Amount,
								Date: bankTxn.DateString,
							},
						],
						{ eventsConfig: args.ctx.eventsConfig, onRetry: retryHandler },
					)
					const payment = payments[0]
					if (!payment?.PaymentID) {
						throw new XeroApiError('Payment creation failed', {
							code: 'E_RUNTIME',
							recoverable: false,
						})
					}

					const result: ReconcileResult = {
						BankTransactionID: input.BankTransactionID,
						status: 'reconciled',
						InvoiceID: input.InvoiceID,
						PaymentID: payment.PaymentID,
					}
					results.push(result)
					await stateBatcher.markProcessed(input.BankTransactionID)
					if (auditWriter) {
						await auditWriter.write({
							type: 'invoice-payment',
							BankTransactionID: input.BankTransactionID,
							InvoiceID: input.InvoiceID,
							PaymentID: payment.PaymentID,
							status: 'reconciled',
						})
					}
					emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-succeeded', {
						bankTransactionId: input.BankTransactionID,
						invoiceId: input.InvoiceID,
						paymentId: payment.PaymentID,
						type: 'invoice-payment',
						durationMs: Math.round(performance.now() - itemStart),
					})
					processedCount += 1
					args.checkpointState.checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}
			} catch (err) {
				if (
					(err instanceof XeroConflictError && err.code === 'E_CONFLICT') ||
					(err instanceof XeroApiError &&
						(err.code === 'E_CONFLICT' || err.status === 409))
				) {
					const result: ReconcileResult = {
						BankTransactionID: input.BankTransactionID,
						status: 'skipped',
						AccountCode: input.AccountCode,
						InvoiceID: input.InvoiceID,
						error: err.message,
					}
					results.push(result)
					if (auditWriter) {
						await auditWriter.write({
							type: 'skipped',
							BankTransactionID: input.BankTransactionID,
							error: err.message,
						})
					}
					emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-conflict', {
						bankTransactionId: input.BankTransactionID,
						accountCode: input.AccountCode,
						invoiceId: input.InvoiceID,
						error: err.message,
						durationMs: Math.round(performance.now() - itemStart),
					})
					processedCount += 1
					args.checkpointState.checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				} else {
					const message = err instanceof Error ? err.message : String(err)
					const errorCode =
						err instanceof StructuredError ? err.code : 'E_RUNTIME'
					const result: ReconcileResult = {
						BankTransactionID: input.BankTransactionID,
						status: 'failed',
						AccountCode: input.AccountCode,
						InvoiceID: input.InvoiceID,
						error: message,
						errorCode,
					}
					results.push(result)
					if (auditWriter) {
						await auditWriter.write({
							type: 'failure',
							BankTransactionID: input.BankTransactionID,
							error: message,
						})
					}
					emitEvent(args.ctx.eventsConfig, 'xero-reconcile-item-failed', {
						bankTransactionId: input.BankTransactionID,
						error: message,
						code: errorCode,
						durationMs: Math.round(performance.now() - itemStart),
					})
					processedCount += 1
					args.checkpointState.checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}
			}

			if (args.isInterrupted()) break
		}

		const summary = summarizeResults(results)
		reconcileLogger.info(
			'Batch summary: {succeeded} succeeded, {failed} failed, {skipped} skipped, {dryRun} dry-run (total {total})',
			{
				succeeded: summary.succeeded,
				failed: summary.failed,
				skipped: summary.skipped,
				dryRun: summary.dryRun,
				total: summary.total,
			},
		)

		return {
			results,
			summary,
			digestLines: buildAuditDigest(args.ctx, results, unreconciledSnapshot),
			interrupted: args.isInterrupted(),
		}
	} finally {
		progress.finish()
		try {
			await stateBatcher?.flush()
		} catch (err) {
			reconcileLogger.warn('Failed to flush state on finalize: {error}', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
		try {
			await auditWriter?.close()
		} catch (err) {
			reconcileLogger.warn(
				'Failed to close audit writer on finalize: {error}',
				{ error: err instanceof Error ? err.message : String(err) },
			)
		}
	}
}
