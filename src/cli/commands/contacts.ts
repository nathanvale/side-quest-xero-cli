import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
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

interface ContactsCommand {
	readonly command: 'contacts'
	readonly fields: readonly string[] | null
}

interface ContactRecord {
	readonly ContactID?: string
	readonly Name?: string
	readonly EmailAddress?: string
	readonly IsSupplier?: boolean
	readonly IsCustomer?: boolean
	readonly ContactStatus?: string
}

interface ContactsResponse {
	readonly Contacts: ContactRecord[]
}

const ContactsResponseSchema = z.object({
	Contacts: z.array(
		z.object({
			ContactID: z.string().optional(),
			Name: z.string().optional(),
			EmailAddress: z.string().optional(),
			IsSupplier: z.boolean().optional(),
			IsCustomer: z.boolean().optional(),
			ContactStatus: z.string().optional(),
		}),
	),
})

interface ContactsSuccessData {
	readonly command: 'contacts'
	readonly count: number
	readonly contacts: Record<string, unknown>[]
}

/** Logger for the contacts command handler. */
const contactsLogger = getXeroLogger(['cli', 'commands', 'contacts'])
const PAGE_SIZE = 100
const MAX_PAGES = 100

/** List contacts. */
export async function runContacts(
	ctx: OutputContext,
	options: ContactsCommand,
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

		contactsLogger.debug('Fetching contacts with pagination')
		const contacts: ContactRecord[] = []
		let truncated = false
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const response = await xeroFetch<ContactsResponse>(
				`/Contacts?page=${page}`,
				{ method: 'GET' },
				{
					accessToken: tokens.accessToken,
					tenantId: config.tenantId,
					eventsConfig: ctx.eventsConfig,
					onUnauthorized: async () => await loadValidTokens(ctx.eventsConfig),
					schema: ContactsResponseSchema,
				},
			)
			const pageItems = response.Contacts ?? []
			contacts.push(...pageItems)
			if (pageItems.length < PAGE_SIZE) break
			if (page === MAX_PAGES) {
				truncated = true
				contactsLogger.warn(
					'Contacts pagination reached max pages ({maxPages}) and was truncated',
					{ maxPages: MAX_PAGES },
				)
				emitEvent(ctx.eventsConfig, 'xero-list-truncated', {
					command: 'contacts',
					maxPages: MAX_PAGES,
				})
			}
		}
		contactsLogger.debug('Fetched {count} contacts', { count: contacts.length })
		const projected = projectFields(
			contacts as Record<string, unknown>[],
			options.fields,
		)
		const warnings = detectAllUndefinedFields(projected, options.fields)
		emitEvent(ctx.eventsConfig, 'xero-list-completed', {
			command: 'contacts',
			count: contacts.length,
			truncated,
		})

		writeSuccess(
			ctx,
			{
				command: 'contacts',
				count: contacts.length,
				contacts: projected,
			} satisfies ContactsSuccessData,
			[`Found ${contacts.length} contacts`],
			`${contacts.length}`,
			warnings,
		)
		return EXIT_OK
	} catch (err) {
		return handleCommandError(ctx, err)
	}
}
