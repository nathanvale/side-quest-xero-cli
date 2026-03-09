import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { parseDateParts } from '../../xero/date'
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
import { emitListPageFetched } from './list-progress'

interface PaymentsCommand {
	readonly command: 'payments'
	readonly since: string | null
	readonly until: string | null
	readonly page: number | null
	readonly limit: number | null
	readonly fields: readonly string[] | null
}

interface PaymentRecord {
	readonly PaymentID?: string
	readonly Date?: string
	readonly Amount?: number
	readonly CurrencyRate?: number
	readonly Status?: string
	readonly Reference?: string
	readonly Invoice?: {
		readonly InvoiceID?: string
		readonly InvoiceNumber?: string
		readonly Type?: string
		readonly Contact?: { readonly Name?: string }
	}
	readonly Account?: {
		readonly AccountID?: string
		readonly Code?: string
		readonly Name?: string
	}
}

interface PaymentsResponse {
	readonly Payments: PaymentRecord[]
}

const PaymentsResponseSchema = z.object({
	Payments: z.array(
		z.object({
			PaymentID: z.string().optional(),
			Date: z.string().optional(),
			Amount: z.number().optional(),
			CurrencyRate: z.number().optional(),
			Status: z.string().optional(),
			Reference: z.string().optional(),
			Invoice: z
				.object({
					InvoiceID: z.string().optional(),
					InvoiceNumber: z.string().optional(),
					Type: z.string().optional(),
					Contact: z.object({ Name: z.string().optional() }).optional(),
				})
				.optional(),
			Account: z
				.object({
					AccountID: z.string().optional(),
					Code: z.string().optional(),
					Name: z.string().optional(),
				})
				.optional(),
		}),
	),
})

interface PaymentsSuccessData {
	readonly command: 'payments'
	readonly count: number
	readonly payments: Record<string, unknown>[]
	readonly resolvedSince: string | null
	readonly resolvedUntil: string | null
}

const paymentsLogger = getXeroLogger(['cli', 'commands', 'payments'])
const PAGE_SIZE = 100
const MAX_PAGES = 100

/** List payments so agents can verify reconciliation side effects. */
export async function runPayments(
	ctx: OutputContext,
	options: PaymentsCommand,
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

		paymentsLogger.debug(
			'Fetching payments: since={since} until={until} page={page} limit={limit}',
			{
				since: options.since,
				until: options.until,
				page: options.page,
				limit: options.limit,
			},
		)
		const whereClauses: string[] = []
		if (options.since)
			whereClauses.push(`Date>=${parseDateParts(options.since)}`)
		if (options.until)
			whereClauses.push(`Date<=${parseDateParts(options.until)}`)

		const params = new URLSearchParams()
		if (whereClauses.length > 0) params.set('where', whereClauses.join(' && '))
		const basePath = params.toString() ? `/Payments?${params}` : '/Payments'

		const payments: PaymentRecord[] = []
		let truncated = false

		if (options.page) {
			const pagedPath = `${basePath}${basePath.includes('?') ? '&' : '?'}page=${options.page}`
			const response = await xeroFetch<PaymentsResponse>(
				pagedPath,
				{ method: 'GET' },
				{
					accessToken: tokens.accessToken,
					tenantId: config.tenantId,
					eventsConfig: ctx.eventsConfig,
					onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
					schema: PaymentsResponseSchema,
				},
			)
			const pageItems = response.Payments ?? []
			payments.push(...pageItems)
			emitListPageFetched(
				ctx.eventsConfig,
				'payments',
				options.page,
				pageItems.length,
				payments.length,
			)
		} else {
			for (let page = 1; page <= MAX_PAGES; page += 1) {
				const pagedPath = `${basePath}${basePath.includes('?') ? '&' : '?'}page=${page}`
				const response = await xeroFetch<PaymentsResponse>(
					pagedPath,
					{ method: 'GET' },
					{
						accessToken: tokens.accessToken,
						tenantId: config.tenantId,
						eventsConfig: ctx.eventsConfig,
						onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
						schema: PaymentsResponseSchema,
					},
				)
				const pageItems = response.Payments ?? []
				payments.push(...pageItems)
				emitListPageFetched(
					ctx.eventsConfig,
					'payments',
					page,
					pageItems.length,
					payments.length,
				)
				if (pageItems.length < PAGE_SIZE) break
				if (page === MAX_PAGES) {
					truncated = true
					paymentsLogger.warn(
						'Payments pagination reached max pages ({maxPages}) and was truncated',
						{ maxPages: MAX_PAGES },
					)
					emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
						command: 'payments',
						maxPages: MAX_PAGES,
					})
				}
			}
		}

		const limited = options.limit ? payments.slice(0, options.limit) : payments
		const projected = projectFields(
			limited as Record<string, unknown>[],
			options.fields,
		)
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'payments',
			count: limited.length,
			truncated,
		})

		writeSuccess(
			ctx,
			{
				command: 'payments',
				count: limited.length,
				payments: projected,
				resolvedSince: options.since,
				resolvedUntil: options.until,
			} satisfies PaymentsSuccessData,
			[`Found ${limited.length} payments`],
			`${limited.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
