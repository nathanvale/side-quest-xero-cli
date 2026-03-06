import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { escapeODataValue } from '../../xero/odata'
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

interface InvoicesCommand {
	readonly command: 'invoices'
	readonly status: string | null
	readonly type: string | null
	readonly fields: readonly string[] | null
}

interface InvoiceRecord {
	readonly InvoiceID?: string
	readonly Contact?: { Name?: string }
	readonly Total?: number
	readonly AmountDue?: number
	readonly Status?: string
	readonly Type?: string
	readonly CurrencyCode?: string
}

interface InvoicesResponse {
	readonly Invoices: InvoiceRecord[]
}

const InvoicesResponseSchema = z.object({
	Invoices: z.array(
		z.object({
			InvoiceID: z.string().optional(),
			Contact: z.object({ Name: z.string().optional() }).optional(),
			Total: z.number().optional(),
			AmountDue: z.number().optional(),
			Status: z.string().optional(),
			Type: z.string().optional(),
			CurrencyCode: z.string().optional(),
		}),
	),
})

interface InvoicesSuccessData {
	readonly command: 'invoices'
	readonly count: number
	readonly invoices: Record<string, unknown>[]
	readonly appliedFilters?: {
		readonly status?: string
		readonly type?: string
	}
}

/** Logger for the invoices command handler. */
const invLogger = getXeroLogger(['cli', 'commands', 'invoices'])
const PAGE_SIZE = 100
const MAX_PAGES = 100

/** List outstanding invoices. */
export async function runInvoices(
	ctx: OutputContext,
	options: InvoicesCommand,
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

		invLogger.debug('Fetching invoices: status={status} type={type}', {
			status: options.status,
			type: options.type,
		})
		const whereClauses = []
		let appliedDefaultStatus = false
		if (options.status) {
			whereClauses.push(`Status=="${escapeODataValue(options.status)}"`)
		}
		if (options.type) {
			whereClauses.push(`Type=="${escapeODataValue(options.type)}"`)
		}

		const params = new URLSearchParams()
		if (whereClauses.length > 0) {
			params.set('where', whereClauses.join(' && '))
		}
		const path = params.toString()
			? `/Invoices?${params.toString()}`
			: (() => {
					appliedDefaultStatus = true
					return '/Invoices?where=Status=="AUTHORISED"'
				})()

		const invoices: InvoiceRecord[] = []
		let truncated = false
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const pagedPath = `${path}${path.includes('?') ? '&' : '?'}page=${page}`
			const response = await xeroFetch<InvoicesResponse>(
				pagedPath,
				{ method: 'GET' },
				{
					accessToken: tokens.accessToken,
					tenantId: config.tenantId,
					eventsConfig: ctx.eventsConfig,
					onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
					schema: InvoicesResponseSchema,
				},
			)
			const pageItems = response.Invoices ?? []
			invoices.push(...pageItems)
			if (pageItems.length < PAGE_SIZE) break
			if (page === MAX_PAGES) {
				truncated = true
				invLogger.warn(
					'Invoices pagination reached max pages ({maxPages}) and was truncated',
					{ maxPages: MAX_PAGES },
				)
				emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
					command: 'invoices',
					maxPages: MAX_PAGES,
				})
			}
		}
		invLogger.debug('Fetched {count} invoices', { count: invoices.length })
		const projected = projectFields(
			invoices as Record<string, unknown>[],
			options.fields,
		)
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'invoices',
			count: invoices.length,
			truncated,
		})

		const appliedFilters =
			options.status || options.type || appliedDefaultStatus
				? {
						status:
							options.status ??
							(appliedDefaultStatus ? 'AUTHORISED' : undefined),
						type: options.type ?? undefined,
					}
				: undefined

		writeSuccess(
			ctx,
			{
				command: 'invoices',
				count: invoices.length,
				invoices: projected,
				appliedFilters,
			} satisfies InvoicesSuccessData,
			[`Found ${invoices.length} invoices`],
			`${invoices.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
