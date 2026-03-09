import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { parseDateParts } from '../../xero/date'
import { escapeODataValue } from '../../xero/odata'
import { groupHistory } from '../../xero/transform/history'
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
	EXIT_USAGE,
	handleCommandError,
	projectFields,
	writeError,
	writeSuccess,
} from '../output'
import { emitListPageFetched } from './list-progress'

interface HistoryCommand {
	readonly command: 'history'
	readonly since: string | null
	readonly contact: string | null
	readonly accountCode: string | null
	readonly fields: readonly string[] | null
}

interface HistorySuccessData {
	readonly command: 'history'
	readonly count: number
	readonly transactions: Record<string, unknown>[]
}

/** Logger for the history command handler. */
const histLogger = getXeroLogger(['cli', 'commands', 'history'])

/** Group past reconciled transactions by contact + account code. */
export async function runHistory(
	ctx: OutputContext,
	options: HistoryCommand,
): Promise<ExitCode> {
	try {
		loadEnvConfig()
		if (!options.since) {
			writeError(ctx, 'history requires --since', 'E_USAGE', 'UsageError')
			return EXIT_USAGE
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

		histLogger.debug(
			'Fetching history: since={since} contact={contact} accountCode={accountCode}',
			{
				since: options.since,
				contact: options.contact,
				accountCode: options.accountCode,
			},
		)
		const whereClauses = [
			'IsReconciled==true',
			`Date>=${parseDateParts(options.since)}`,
		]
		if (options.contact) {
			whereClauses.push(`Contact.Name=="${escapeODataValue(options.contact)}"`)
		}
		if (options.accountCode) {
			whereClauses.push(
				`LineItems.AccountCode=="${escapeODataValue(options.accountCode)}"`,
			)
		}
		const PAGE_SIZE = 100
		const MAX_PAGES = 100
		const params = new URLSearchParams()
		params.set('where', whereClauses.join(' && '))

		const basePath = `/BankTransactions?${params.toString()}`
		const rawTransactions: BankTransactionRecord[] = []
		let truncated = false

		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const pagedPath = `${basePath}&page=${page}`
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
			rawTransactions.push(...pageItems)
			emitListPageFetched(
				ctx.eventsConfig,
				'history',
				page,
				pageItems.length,
				rawTransactions.length,
			)
			if (pageItems.length < PAGE_SIZE) break
			if (page === MAX_PAGES) {
				truncated = true
				histLogger.warn(
					'History pagination reached max pages ({maxPages}) and was truncated',
					{ maxPages: MAX_PAGES },
				)
				emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
					command: 'history',
					maxPages: MAX_PAGES,
				})
			}
		}
		histLogger.debug('Fetched {count} raw transactions for grouping', {
			count: rawTransactions.length,
		})
		const grouped = groupHistory(rawTransactions)
		const groupedRecords: Record<string, unknown>[] = grouped.map(
			(row): Record<string, unknown> => ({
				Contact: row.Contact,
				AccountCode: row.AccountCode,
				Count: row.Count,
				AmountMin: row.AmountMin,
				AmountMax: row.AmountMax,
				Type: row.Type,
				CurrencyCode: row.CurrencyCode,
				MostRecentDate: row.MostRecentDate,
				ExampleTransactionIDs: row.ExampleTransactionIDs,
			}),
		)
		const projected = options.fields
			? projectFields(groupedRecords, options.fields)
			: groupedRecords
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'history',
			count: grouped.length,
			truncated,
		})

		writeSuccess(
			ctx,
			{
				command: 'history',
				count: grouped.length,
				transactions: projected,
			} satisfies HistorySuccessData,
			[`Found ${grouped.length} grouped transactions`],
			`${grouped.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
