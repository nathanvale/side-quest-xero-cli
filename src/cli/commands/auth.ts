import { existsSync } from 'node:fs'
import path from 'node:path'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { authenticate } from '../../xero/auth'
import { loadXeroConfig } from '../../xero/config'
import type { ExitCode, OutputContext } from '../output'
import {
	EXIT_OK,
	EXIT_USAGE,
	handleCommandError,
	sanitizeErrorMessage,
	writeError,
	writeSuccess,
} from '../output'

/** Logger for the auth command handler. */
const authCmdLogger = getXeroLogger(['cli', 'commands', 'auth'])

interface AuthSuccessData {
	readonly command: 'auth'
	readonly tenantId: string | null
	readonly orgName: string
}

/**
 * Default scopes for fresh auth.
 *
 * Confirmed working for Starter-tier PKCE apps as of 2026-03-10. Xero
 * introduced granular scopes on March 2, 2026 but existing apps haven't been
 * migrated yet -- granular scopes (e.g. accounting.banktransactions) are
 * rejected until Xero assigns them (expected by end of April 2026).
 *
 * Once migrated, replace the broad deprecated scopes with their granular
 * equivalents (see commented section below).
 *
 * Override at runtime: `XERO_AUTH_SCOPE="scope1 scope2" bun run xero-cli auth`
 *
 * @see https://developer.xero.com/documentation/guides/oauth2/scopes/
 */
export const DEFAULT_AUTH_SCOPES = [
	// ── OpenID Connect ──────────────────────────────────────────────────
	'openid', // https://developer.xero.com/documentation/guides/oauth2/scopes/#user-scopes
	'profile', // first name, last name, xero user id
	'email', // email address

	// ── Accounting API (broad scopes, deprecated Sep 2027) ──────────────
	'accounting.transactions', // https://developer.xero.com/documentation/api/accounting/banktransactions
	'accounting.reports.read', // https://developer.xero.com/documentation/api/accounting/reports
	'accounting.contacts', // https://developer.xero.com/documentation/api/accounting/contacts
	'accounting.settings', // https://developer.xero.com/documentation/api/accounting/accounts
	'accounting.attachments', // https://developer.xero.com/documentation/api/accounting/attachments
	'accounting.journals.read', // https://developer.xero.com/documentation/api/accounting/journals
	'accounting.budgets.read', // https://developer.xero.com/documentation/api/budgets

	// ── Token refresh ───────────────────────────────────────────────────
	'offline_access',

	// ── Granular scopes (enable after Xero migrates this app) ───────────
	// 'accounting.invoices',              // replaces accounting.transactions (partial)
	// 'accounting.payments',              // replaces accounting.transactions (partial)
	// 'accounting.banktransactions',      // replaces accounting.transactions (partial)
	// 'accounting.manualjournals',        // replaces accounting.transactions (partial)
	// 'accounting.reports.aged.read',     // replaces accounting.reports.read (partial)
	// 'accounting.reports.balancesheet.read',
	// 'accounting.reports.banksummary.read',
	// 'accounting.reports.budgetsummary.read',
	// 'accounting.reports.executivesummary.read',
	// 'accounting.reports.profitandloss.read',
	// 'accounting.reports.trialbalance.read',
	// 'accounting.reports.taxreports.read',
	// 'accounting.reports.tenninetynine.read',

	// ── Partner-only scopes (require Xero partner application) ──────────
	// 'finance.bankstatementsplus.read',  // use agent-browser workaround instead
	// 'finance.accountingactivity.read',
	// 'finance.cashvalidation.read',
	// 'finance.statements.read',
]

/**
 * Resolved auth scope string. Override with XERO_AUTH_SCOPE env var for
 * testing or to add scopes without code changes.
 */
export const AUTH_SCOPE =
	process.env.XERO_AUTH_SCOPE ?? DEFAULT_AUTH_SCOPES.join(' ')

function printSetupGuide(): void {
	const lines = [
		'xero-cli setup checklist:',
		'',
		'1. Create a Xero app at https://developer.xero.com/app/manage',
		'   - App type: "Auth Code with PKCE"',
		'   - Redirect URI: http://localhost:5555/callback',
		'   - Company or application URL: http://localhost',
		'',
		'2. Copy .env.example to .env:',
		'   cp .env.example .env',
		'',
		'3. Add your Client ID from the Xero app dashboard:',
		'   XERO_CLIENT_ID=YOUR_CLIENT_ID_HERE',
		'',
		'4. Run auth:',
		'   bun run xero-cli auth',
		'',
		'Common issues:',
		'- "redirect_uri mismatch" -- Xero requires EXACT match. Use http://localhost:5555/callback',
		'- "Keychain access denied" -- System Settings > Privacy & Security > allow Terminal',
		'- Multiple orgs -- after auth, check .xero-config.json for the selected org',
	]
	process.stderr.write(`${lines.join('\n')}\n`)
}

/** Run the OAuth2 PKCE auth flow. */
export async function runAuth(
	_ctx: OutputContext,
	options: { readonly authTimeoutMs: number | null },
): Promise<ExitCode> {
	const ctx = _ctx
	authCmdLogger.debug('Checking for .env file')
	const envPath = path.join(process.cwd(), '.env')
	if (!existsSync(envPath)) {
		if (!ctx.json && !ctx.quiet) {
			printSetupGuide()
		}
		writeError(ctx, 'Missing .env file', 'E_USAGE', 'UsageError')
		return EXIT_USAGE
	}

	try {
		const scope = AUTH_SCOPE

		authCmdLogger.info('Starting OAuth2 PKCE flow with scope={scope}', {
			scope,
		})
		emitEvent(ctx.eventsConfig, 'xero-auth-started', { scope })

		if (!ctx.json) {
			authCmdLogger.info('Opening Xero login in browser.')
			authCmdLogger.info('Waiting for callback on localhost:5555.')
		}

		const countdown = setInterval(() => {
			if (!ctx.json && !ctx.quiet) {
				authCmdLogger.info('Waiting for Xero login...')
			}
		}, 30_000)

		try {
			await authenticate(scope, {
				headless: ctx.headless,
				timeoutMs: options.authTimeoutMs ?? undefined,
				onTick: (remainingMs) => {
					if (ctx.json || ctx.quiet) return
					if (remainingMs % 60_000 < 1000) {
						const remaining = Math.max(1, Math.round(remainingMs / 1000))
						authCmdLogger.info(
							'Waiting for Xero login... ({remaining}s remaining)',
							{ remaining },
						)
					}
				},
				onAuthUrl: (authUrl) => {
					writeSuccess(
						ctx,
						{
							command: 'auth',
							authUrl,
						},
						['Auth URL generated for headless flow'],
						'Auth URL generated',
						undefined,
						'auth_url',
					)
				},
			})
		} finally {
			clearInterval(countdown)
		}

		const config = await loadXeroConfig()
		const orgName = config?.orgName ?? 'Unknown org'
		authCmdLogger.info('Auth completed for org={orgName}', { orgName })

		writeSuccess(
			ctx,
			{
				command: 'auth',
				tenantId: config?.tenantId ?? null,
				orgName,
			} satisfies AuthSuccessData,
			[`Authenticated as "${orgName}"`, 'Tenant ID saved to .xero-config.json'],
			'Authenticated',
			undefined,
			ctx.headless ? 'result' : undefined,
		)
		emitEvent(ctx.eventsConfig, 'xero-auth-completed', {
			tenantId: config?.tenantId ?? null,
			orgName,
			scope,
		})
		return EXIT_OK
	} catch (err) {
		const errorForEvent: { message: string; code: string } = {
			message: sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
			),
			code: 'E_RUNTIME',
		}
		if (
			err &&
			typeof err === 'object' &&
			'code' in err &&
			typeof err.code === 'string'
		) {
			errorForEvent.code = err.code
		}
		emitEvent(ctx.eventsConfig, 'xero-auth-failed', errorForEvent)
		return handleCommandError(ctx, err)
	}
}
