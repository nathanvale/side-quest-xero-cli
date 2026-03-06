import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { parseDateParts } from '../../xero/date'
import type {
	BankTransactionRecord,
	BankTransactionsResponse,
} from '../../xero/types'
import { BankTransactionsResponseSchema } from '../../xero/types'
import type { ExitCode, OutputContext } from '../output'
import {
	detectAllUndefinedFields,
	EXIT_OK,
	EXIT_UNAUTHORIZED,
	handleCommandError,
	projectFields,
	writeError,
	writeSuccess,
} from '../output'

interface TransactionsCommand {
	readonly command: 'transactions'
	readonly unreconciled: boolean
	readonly since: string | null
	readonly until: string | null
	readonly thisQuarter: boolean
	readonly lastQuarter: boolean
	readonly page: number | null
	readonly limit: number | null
	readonly summary: boolean
	readonly fields: readonly string[] | null
}

export { parseDateParts } from '../../xero/date'

function resolveQuarterRange(
	kind: 'this' | 'last',
	now: Date = new Date(),
): { since: string; until: string } {
	const year = now.getFullYear()
	const quarter = Math.floor(now.getMonth() / 3)
	const targetQuarter = kind === 'this' ? quarter : quarter - 1
	const targetYear = targetQuarter < 0 ? year - 1 : year
	const quarterIndex = (targetQuarter + 4) % 4
	const startMonth = quarterIndex * 3
	const start = new Date(Date.UTC(targetYear, startMonth, 1))
	const end = new Date(Date.UTC(targetYear, startMonth + 3, 0))
	const since = start.toISOString().slice(0, 10)
	const until = end.toISOString().slice(0, 10)
	return { since, until }
}

function summarizeTransactions(
	transactions: BankTransactionRecord[],
): string[] {
	const totalsByType = new Map<string, { count: number; total: number }>()
	const totalsByMonth = new Map<string, number>()
	const totalsByContact = new Map<string, number>()

	for (const txn of transactions) {
		const type = txn.Type ?? 'UNKNOWN'
		const amount = txn.Total ?? 0
		const current = totalsByType.get(type) ?? { count: 0, total: 0 }
		current.count += 1
		current.total += amount
		totalsByType.set(type, current)

		const dateRaw = txn.DateString ?? txn.Date ?? ''
		const month = dateRaw.slice(0, 7)
		if (month) {
			totalsByMonth.set(month, (totalsByMonth.get(month) ?? 0) + 1)
		}

		const contact = txn.Contact?.Name ?? 'Unknown'
		totalsByContact.set(contact, (totalsByContact.get(contact) ?? 0) + 1)
	}

	const typeLine = Array.from(totalsByType.entries())
		.map(
			([type, stats]) => `${type}: ${stats.count} (${stats.total.toFixed(2)})`,
		)
		.join(' | ')

	const monthLine = Array.from(totalsByMonth.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([month, count]) => `${month}: ${count}`)
		.join(' | ')

	const topContacts = Array.from(totalsByContact.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([name, count]) => `${name} (${count}x)`)
		.join(' | ')

	return [
		`By Type: ${typeLine}`,
		`By Month: ${monthLine}`,
		`Top 5: ${topContacts}`,
	]
}

/** Logger for the transactions command handler. */
const txLogger = getXeroLogger(['cli', 'commands', 'transactions'])
const PAGE_SIZE = 100
const MAX_PAGES = 100

/** List bank transactions with filters and summary options. */
export async function runTransactions(
	ctx: OutputContext,
	options: TransactionsCommand,
): Promise<ExitCode> {
	try {
		loadEnvConfig()
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

		let since = options.since
		let until = options.until
		if (options.thisQuarter) {
			const range = resolveQuarterRange('this')
			since = range.since
			until = range.until
		}
		if (options.lastQuarter) {
			const range = resolveQuarterRange('last')
			since = range.since
			until = range.until
		}
		if (!since && !until && options.summary) {
			const range = resolveQuarterRange('this')
			since = range.since
			until = range.until
		}
		txLogger.debug(
			'Fetching transactions: since={since} until={until} unreconciled={unreconciled} page={page} limit={limit}',
			{
				since,
				until,
				unreconciled: options.unreconciled,
				page: options.page,
				limit: options.limit,
			},
		)
		const params = new URLSearchParams()
		const whereClauses: string[] = []

		if (options.unreconciled) {
			const unreconciledFilter =
				process.env.XERO_IS_RECONCILED_STRING === '1'
					? 'IsReconciled=="false"'
					: 'IsReconciled==false'
			whereClauses.push(unreconciledFilter)
		}
		if (since) {
			whereClauses.push(`Date>=${parseDateParts(since)}`)
		}
		if (until) {
			whereClauses.push(`Date<=${parseDateParts(until)}`)
		}

		if (whereClauses.length > 0) {
			params.set('where', whereClauses.join(' && '))
		}
		const basePath = params.toString()
			? `/BankTransactions?${params.toString()}`
			: '/BankTransactions'
		const transactions: BankTransactionRecord[] = []
		let truncated = false
		if (options.page) {
			const pagedPath = `${basePath}${basePath.includes('?') ? '&' : '?'}page=${options.page}`
			const response = await xeroFetch<BankTransactionsResponse>(
				pagedPath,
				{ method: 'GET' },
				{
					accessToken: tokens.accessToken,
					tenantId: config.tenantId,
					eventsConfig: ctx.eventsConfig,
					onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
					schema: BankTransactionsResponseSchema,
				},
			)
			transactions.push(...(response.BankTransactions ?? []))
		} else {
			for (let page = 1; page <= MAX_PAGES; page += 1) {
				const pagedPath = `${basePath}${basePath.includes('?') ? '&' : '?'}page=${page}`
				const response = await xeroFetch<BankTransactionsResponse>(
					pagedPath,
					{ method: 'GET' },
					{
						accessToken: tokens.accessToken,
						tenantId: config.tenantId,
						eventsConfig: ctx.eventsConfig,
						onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
						schema: BankTransactionsResponseSchema,
					},
				)
				const pageItems = response.BankTransactions ?? []
				transactions.push(...pageItems)
				if (pageItems.length < PAGE_SIZE) break
				if (page === MAX_PAGES) {
					truncated = true
					txLogger.warn(
						'Transactions pagination reached max pages ({maxPages}) and was truncated',
						{ maxPages: MAX_PAGES },
					)
					emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
						command: 'transactions',
						maxPages: MAX_PAGES,
					})
				}
			}
		}
		const limited = options.limit
			? transactions.slice(0, options.limit)
			: transactions
		txLogger.debug('Fetched {count} transactions', {
			count: transactions.length,
		})
		const projected = projectFields(
			limited as Record<string, unknown>[],
			options.fields,
		)
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'transactions',
			count: limited.length,
			truncated,
		})

		if (!ctx.json && (options.summary || transactions.length > 50)) {
			const summaryLines = summarizeTransactions(transactions)
			writeSuccess(
				ctx,
				{
					command: 'transactions',
					count: limited.length,
					transactions: projected,
					resolvedSince: since,
					resolvedUntil: until,
				},
				[
					`Found ${limited.length} transactions`,
					...summaryLines,
					'Use --limit 20 to see first 20 rows, or --json for full data.',
				],
				`${limited.length}`,
				warnings,
			)
			return EXIT_OK
		}

		writeSuccess(
			ctx,
			{
				command: 'transactions',
				count: limited.length,
				transactions: projected,
				resolvedSince: since,
				resolvedUntil: until,
			},
			[`Found ${limited.length} transactions`],
			`${limited.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
