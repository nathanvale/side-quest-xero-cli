import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import { escapeODataValue } from '../../xero/odata'
import type { AccountType } from '../command'
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

interface AccountsCommand {
	readonly command: 'accounts'
	readonly type: AccountType | null
	readonly fields: readonly string[] | null
}

interface AccountRecord {
	readonly AccountID?: string
	readonly Code?: string
	readonly Name?: string
	readonly Type?: string
	readonly Status?: string
	readonly Description?: string
}

interface AccountsResponse {
	readonly Accounts: AccountRecord[]
}

const AccountsResponseSchema = z.object({
	Accounts: z.array(
		z.object({
			AccountID: z.string().optional(),
			Code: z.string().optional(),
			Name: z.string().optional(),
			Type: z.string().optional(),
			Status: z.string().optional(),
			Description: z.string().optional(),
		}),
	),
})

interface AccountsSuccessData {
	readonly command: 'accounts'
	readonly count: number
	readonly accounts: Record<string, unknown>[]
}

/** Logger for the accounts command handler. */
const acctLogger = getXeroLogger(['cli', 'commands', 'accounts'])
const PAGE_SIZE = 100
const MAX_PAGES = 100

/** List chart of accounts with optional type filter. */
export async function runAccounts(
	ctx: OutputContext,
	options: AccountsCommand,
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

		acctLogger.debug('Fetching accounts: type={type}', {
			type: options.type,
		})
		const params = new URLSearchParams()
		if (options.type) {
			params.set('where', `Type=="${escapeODataValue(options.type)}"`)
		}
		const path = params.toString()
			? `/Accounts?${params.toString()}`
			: '/Accounts'

		const accounts: AccountRecord[] = []
		let truncated = false
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const pagedPath = `${path}${path.includes('?') ? '&' : '?'}page=${page}`
			const response = await xeroFetch<AccountsResponse>(
				pagedPath,
				{ method: 'GET' },
				{
					accessToken: tokens.accessToken,
					tenantId: config.tenantId,
					eventsConfig: ctx.eventsConfig,
					onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
					schema: AccountsResponseSchema,
				},
			)
			const pageItems = response.Accounts ?? []
			accounts.push(...pageItems)
			if (pageItems.length < PAGE_SIZE) break
			if (page === MAX_PAGES) {
				truncated = true
				acctLogger.warn(
					'Accounts pagination reached max pages ({maxPages}) and was truncated',
					{ maxPages: MAX_PAGES },
				)
				emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
					command: 'accounts',
					maxPages: MAX_PAGES,
				})
			}
		}
		acctLogger.debug('Fetched {count} accounts', { count: accounts.length })
		const projected = projectFields(
			accounts as Record<string, unknown>[],
			options.fields,
		)
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'accounts',
			count: accounts.length,
			truncated,
		})

		writeSuccess(
			ctx,
			{
				command: 'accounts',
				count: accounts.length,
				accounts: projected,
			} satisfies AccountsSuccessData,
			[`Found ${accounts.length} accounts`],
			`${accounts.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
