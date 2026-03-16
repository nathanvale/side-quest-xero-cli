import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { emitEvent, resolveEventsConfig } from '../events'
import {
	getXeroLogger,
	setupLogging,
	shutdownLogging,
	withContext,
} from '../logging'
import { isHeadless } from '../xero/auth'
import { runAccounts } from './commands/accounts'
import { runAuth } from './commands/auth'
import { runContacts } from './commands/contacts'
import { runHistory } from './commands/history'
import { runInvoices } from './commands/invoices'
import { runPayments } from './commands/payments'
import { runReconcile } from './commands/reconcile'
import { runReconcileDelete } from './commands/reconcile-delete'
import { runReconcilePostQueue } from './commands/reconcile-post'
import { runStatus } from './commands/status'
import { runTransactions } from './commands/transactions'
import type { ExitCode, OutputContext } from './output'
import {
	EXIT_INTERRUPTED,
	EXIT_OK,
	EXIT_USAGE,
	handleCommandErrorWithContext,
	sanitizeErrorMessage,
	waitForStdoutDrain,
	writeError,
	writeSuccess,
} from './output'

/** Logger for CLI arg parsing, command dispatch, and output formatting. */
const cliLogger = getXeroLogger(['cli'])

type LogLevel = 'silent' | 'info' | 'debug'
type ProgressMode = 'animated' | 'static' | 'off'

interface AuthCommand extends OutputContext {
	readonly command: 'auth'
	readonly authTimeoutMs: number | null
}

interface StatusCommand extends OutputContext {
	readonly command: 'status'
}

interface AccountsCommand extends OutputContext {
	readonly command: 'accounts'
	readonly type: AccountType | null
	readonly fields: readonly string[] | null
}

export const ACCOUNT_TYPE_ALLOWLIST = [
	'BANK',
	'CURRENT',
	'CURRLIAB',
	'DEPRECIATN',
	'DIRECTCOSTS',
	'EQUITY',
	'EXPENSE',
	'FIXED',
	'INVENTORY',
	'LIABILITY',
	'NONCURRENT',
	'OTHERINCOME',
	'OVERHEADS',
	'PREPAYMENT',
	'REVENUE',
	'SALES',
	'TERMLIAB',
] as const
export type AccountType = (typeof ACCOUNT_TYPE_ALLOWLIST)[number]

const INVOICE_STATUS_ALLOWLIST = [
	'DRAFT',
	'SUBMITTED',
	'AUTHORISED',
	'PAID',
	'VOIDED',
	'DELETED',
] as const

const INVOICE_TYPE_ALLOWLIST = ['ACCPAY', 'ACCREC'] as const

interface ContactsCommand extends OutputContext {
	readonly command: 'contacts'
	readonly fields: readonly string[] | null
}

interface TransactionsCommand extends OutputContext {
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

interface HistoryCommand extends OutputContext {
	readonly command: 'history'
	readonly since: string | null
	readonly contact: string | null
	readonly accountCode: string | null
	readonly fields: readonly string[] | null
}

interface InvoicesCommand extends OutputContext {
	readonly command: 'invoices'
	readonly status: string | null
	readonly type: string | null
	readonly fields: readonly string[] | null
}

interface HelpCommand extends OutputContext {
	readonly command: 'help'
	readonly topic: string | null
}

interface PaymentsCommand extends OutputContext {
	readonly command: 'payments'
	readonly since: string | null
	readonly until: string | null
	readonly page: number | null
	readonly limit: number | null
	readonly fields: readonly string[] | null
}

interface ReconcileCommand extends OutputContext {
	readonly command: 'reconcile'
	readonly execute: boolean
	readonly fromCsv: string | null
}

interface ReconcilePostCommand extends OutputContext {
	readonly command: 'reconcile-post'
	readonly execute: boolean
	readonly queue: string
	readonly postRun: string
}

interface ReconcileDeleteCommand extends OutputContext {
	readonly command: 'reconcile-delete'
	readonly execute: boolean
	readonly postRun: string
}

type CliOptions =
	| AuthCommand
	| StatusCommand
	| AccountsCommand
	| ContactsCommand
	| TransactionsCommand
	| HistoryCommand
	| InvoicesCommand
	| PaymentsCommand
	| ReconcileCommand
	| ReconcilePostCommand
	| ReconcileDeleteCommand
	| HelpCommand

interface ParseCliError {
	readonly ok: false
	readonly exitCode: ExitCode
	readonly message: string
	readonly output: string
	readonly errorCode: string
	readonly context?: Record<string, unknown>
	readonly json: boolean
	readonly quiet: boolean
}

interface ParseCliOk {
	readonly ok: true
	readonly options: CliOptions
}

type ParseCliResult = ParseCliError | ParseCliOk

const GLOBAL_FLAGS = new Set([
	'--json',
	'--quiet',
	'--verbose',
	'--debug',
	'--events-url',
	'--help',
	'-h',
	'--version',
])

const COMMAND_FLAG_ALLOWLIST: Record<string, Set<string>> = {
	auth: new Set(['--auth-timeout']),
	status: new Set([]),
	accounts: new Set(['--fields', '--type']),
	contacts: new Set(['--fields']),
	transactions: new Set([
		'--fields',
		'--unreconciled',
		'--since',
		'--until',
		'--this-quarter',
		'--last-quarter',
		'--page',
		'--limit',
		'--summary',
	]),
	history: new Set(['--fields', '--since', '--contact', '--account-code']),
	invoices: new Set(['--fields', '--status', '--type']),
	payments: new Set(['--fields', '--since', '--until', '--page', '--limit']),
	reconcile: new Set(['--execute', '--dry-run', '--from-csv']),
	'reconcile-post': new Set([
		'--execute',
		'--dry-run',
		'--queue',
		'--post-run',
	]),
	'reconcile-delete': new Set(['--execute', '--dry-run', '--post-run']),
	help: new Set([]),
	version: new Set([]),
}

function normalizeFlagName(token: string): string {
	const eqIndex = token.indexOf('=')
	return eqIndex === -1 ? token : token.slice(0, eqIndex)
}

function validateCommandFlags(
	commandToken: string,
	seenFlags: ReadonlySet<string>,
	json: boolean,
	quiet: boolean,
): ParseCliError | null {
	const commandFlags = COMMAND_FLAG_ALLOWLIST[commandToken] ?? new Set<string>()
	const invalidFlags = [...seenFlags].filter(
		(flag) => !GLOBAL_FLAGS.has(flag) && !commandFlags.has(flag),
	)
	if (invalidFlags.length === 0) return null
	return parseUsageError(
		`Unsupported option(s) for ${commandToken}: ${invalidFlags.join(', ')}`,
		json,
		quiet,
		{
			command: commandToken,
			invalidFlags,
		},
	)
}

/**
 * Result of attempting to parse a value-taking flag (e.g. --flag value or --flag=value).
 * Returns null when the token does not match the flag name at all.
 */
type ValueFlagResult =
	| null
	| { readonly value: string; readonly nextIndex: number }
	| ParseCliError

/**
 * Parse a value-taking flag that supports both `--flag value` and `--flag=value` forms.
 * Returns null if the token does not match the flag, a ParseCliError if the value is
 * missing, or the parsed value and next loop index on success.
 */
function parseValueFlag(
	token: string,
	args: readonly string[],
	index: number,
	flag: string,
	json: boolean,
	quiet: boolean,
): ValueFlagResult {
	if (token === flag) {
		const value = args[index + 1]
		if (!value || value.startsWith('--')) {
			return parseUsageError(`Missing value for ${flag}`, json, quiet)
		}
		return { value, nextIndex: index + 1 }
	}
	const prefix = `${flag}=`
	if (token.startsWith(prefix)) {
		const value = token.slice(prefix.length)
		if (!value) {
			return parseUsageError(`Missing value for ${flag}`, json, quiet)
		}
		return { value, nextIndex: index }
	}
	return null
}

/** Parse argv into structured command options.
 *  Returns a discriminated union instead of throwing to preserve output mode. */
export function parseCli(argv: readonly string[]): ParseCliResult {
	const args = argv.slice(2)
	const preFlags = new Set(args)
	const seenFlags = new Set<string>()
	let commandToken: string | null = null
	let json = preFlags.has('--json')
	let quiet = preFlags.has('--quiet')
	let verbose = preFlags.has('--verbose')
	let debug = preFlags.has('--debug')
	let help = false
	let topic: string | null = null
	let eventsUrl: string | null = null
	let authTimeoutRaw: string | null = null
	let fieldsRaw: string | null = null
	let typeRaw: string | null = null
	let sinceRaw: string | null = null
	let untilRaw: string | null = null
	let pageRaw: string | null = null
	let limitRaw: string | null = null
	let unreconciled = false
	let summary = false
	let thisQuarter = false
	let lastQuarter = false
	let execute = false
	let fromCsv: string | null = null
	let queuePath: string | null = null
	let postRunPath: string | null = null
	let contactRaw: string | null = null
	let accountCodeRaw: string | null = null
	let statusRaw: string | null = null

	for (let i = 0; i < args.length; i += 1) {
		const token = args[i]
		if (!token) continue
		if (token === '--json') {
			json = true
			seenFlags.add('--json')
			continue
		}
		if (token === '--quiet') {
			quiet = true
			seenFlags.add('--quiet')
			continue
		}
		if (token === '--verbose') {
			verbose = true
			seenFlags.add('--verbose')
			continue
		}
		if (token === '--debug') {
			debug = true
			seenFlags.add('--debug')
			continue
		}
		if (token === '--unreconciled') {
			unreconciled = true
			seenFlags.add('--unreconciled')
			continue
		}
		if (token === '--summary') {
			summary = true
			seenFlags.add('--summary')
			continue
		}
		if (token === '--this-quarter') {
			thisQuarter = true
			seenFlags.add('--this-quarter')
			continue
		}
		if (token === '--last-quarter') {
			lastQuarter = true
			seenFlags.add('--last-quarter')
			continue
		}
		if (token === '--execute') {
			execute = true
			seenFlags.add('--execute')
			continue
		}
		if (token === '--dry-run') {
			execute = false
			seenFlags.add('--dry-run')
			continue
		}
		// -- Value-taking flags (--flag value / --flag=value) --
		// Each flag is parsed via parseValueFlag to avoid ~14 lines of boilerplate per flag.
		const valueFlagDefs: Array<{
			flag: string
			assign: (v: string) => void
		}> = [
			{
				flag: '--queue',
				assign: (v) => {
					queuePath = v
				},
			},
			{
				flag: '--post-run',
				assign: (v) => {
					postRunPath = v
				},
			},
			{
				flag: '--from-csv',
				assign: (v) => {
					fromCsv = v
				},
			},
			{
				flag: '--contact',
				assign: (v) => {
					contactRaw = v
				},
			},
			{
				flag: '--account-code',
				assign: (v) => {
					accountCodeRaw = v
				},
			},
			{
				flag: '--status',
				assign: (v) => {
					statusRaw = v
				},
			},
			{
				flag: '--events-url',
				assign: (v) => {
					eventsUrl = v
				},
			},
			{
				flag: '--auth-timeout',
				assign: (v) => {
					authTimeoutRaw = v
				},
			},
			{
				flag: '--fields',
				assign: (v) => {
					fieldsRaw = v
				},
			},
			{
				flag: '--type',
				assign: (v) => {
					typeRaw = v
				},
			},
			{
				flag: '--since',
				assign: (v) => {
					sinceRaw = v
				},
			},
			{
				flag: '--until',
				assign: (v) => {
					untilRaw = v
				},
			},
			{
				flag: '--page',
				assign: (v) => {
					pageRaw = v
				},
			},
			{
				flag: '--limit',
				assign: (v) => {
					limitRaw = v
				},
			},
		]
		let valueFlagMatched = false
		for (const { flag, assign } of valueFlagDefs) {
			const result = parseValueFlag(token, args, i, flag, json, quiet)
			if (result === null) continue
			if ('ok' in result) return result // ParseCliError
			assign(result.value)
			seenFlags.add(normalizeFlagName(token))
			i = result.nextIndex
			valueFlagMatched = true
			break
		}
		if (valueFlagMatched) continue

		if (token === '--help' || token === '-h') {
			help = true
			seenFlags.add(token)
			continue
		}
		if (token === '--version') {
			seenFlags.add('--version')
			continue
		}
		if (token.startsWith('-')) {
			return parseUsageError(`Unknown option: ${token}`, json, quiet)
		}
		if (!commandToken) {
			commandToken = token
			continue
		}
		if (!topic) {
			topic = token
			continue
		}
		return parseUsageError(`Unexpected extra argument: ${token}`, json, quiet)
	}

	if (!commandToken) {
		commandToken = 'help'
	}

	if (help) {
		if (commandToken && commandToken !== 'help' && !topic) {
			topic = commandToken
		}
		commandToken = 'help'
	}
	if (commandToken === '--version' || seenFlags.has('--version')) {
		commandToken = 'version'
	}
	if (commandToken === 'tx') commandToken = 'transactions'
	if (commandToken === 'acct') commandToken = 'accounts'
	if (commandToken === 'ctc') commandToken = 'contacts'
	if (commandToken === 'inv') commandToken = 'invoices'
	if (commandToken === 'pay') commandToken = 'payments'
	if (commandToken === 'rec') commandToken = 'reconcile'
	if (commandToken === 'hist') commandToken = 'history'

	const invalidFlags = validateCommandFlags(
		commandToken,
		seenFlags,
		json,
		quiet,
	)
	if (invalidFlags) return invalidFlags

	const outputMode = resolveOutputMode({
		json,
		quiet,
		verbose,
		debug,
		eventsUrl,
	})

	if (commandToken === 'auth') {
		const authTimeoutMs = authTimeoutRaw ? Number(authTimeoutRaw) * 1000 : null
		if (
			authTimeoutRaw &&
			(!Number.isFinite(authTimeoutMs) ||
				!authTimeoutMs ||
				authTimeoutMs <= 0 ||
				authTimeoutMs > 3_600_000)
		) {
			return parseUsageError('Invalid --auth-timeout value', json, quiet)
		}
		return {
			ok: true,
			options: {
				command: 'auth',
				...outputMode,
				authTimeoutMs,
			},
		}
	}
	if (commandToken === 'status') {
		return { ok: true, options: { command: 'status', ...outputMode } }
	}
	if (commandToken === 'accounts') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		const normalizedType = typeRaw ? String(typeRaw).toUpperCase() : null
		if (
			normalizedType &&
			!ACCOUNT_TYPE_ALLOWLIST.includes(
				normalizedType as (typeof ACCOUNT_TYPE_ALLOWLIST)[number],
			)
		) {
			return parseUsageError(
				`Invalid --type value '${normalizedType}'. Valid values: ${ACCOUNT_TYPE_ALLOWLIST.join(', ')}`,
				json,
				quiet,
				{ validValues: ACCOUNT_TYPE_ALLOWLIST },
			)
		}
		return {
			ok: true,
			options: {
				command: 'accounts',
				...outputMode,
				type: normalizedType as AccountType | null,
				fields,
			},
		}
	}
	if (commandToken === 'contacts') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		return {
			ok: true,
			options: {
				command: 'contacts',
				...outputMode,
				fields,
			},
		}
	}
	if (commandToken === 'transactions') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		if (thisQuarter && lastQuarter) {
			return parseUsageError(
				'Use only one of --this-quarter or --last-quarter',
				json,
				quiet,
			)
		}
		if ((thisQuarter || lastQuarter) && (sinceRaw || untilRaw)) {
			return parseUsageError(
				'--this-quarter/--last-quarter cannot be combined with --since/--until',
				json,
				quiet,
			)
		}
		const page = pageRaw ? Number(pageRaw) : null
		const limit = limitRaw ? Number(limitRaw) : null
		if (pageRaw && (page === null || !Number.isInteger(page) || page <= 0)) {
			return parseUsageError('Invalid --page value', json, quiet)
		}
		if (
			limitRaw &&
			(limit === null || !Number.isInteger(limit) || limit <= 0)
		) {
			return parseUsageError('Invalid --limit value', json, quiet)
		}
		if (sinceRaw && !isIsoDate(sinceRaw)) {
			return parseUsageError(
				'Invalid --since value (expected YYYY-MM-DD)',
				json,
				quiet,
			)
		}
		if (untilRaw && !isIsoDate(untilRaw)) {
			return parseUsageError(
				'Invalid --until value (expected YYYY-MM-DD)',
				json,
				quiet,
			)
		}
		return {
			ok: true,
			options: {
				command: 'transactions',
				...outputMode,
				unreconciled,
				since: sinceRaw,
				until: untilRaw,
				thisQuarter,
				lastQuarter,
				page,
				limit,
				summary,
				fields,
			},
		}
	}
	if (commandToken === 'history') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		if (!sinceRaw) {
			return parseUsageError(
				'Missing required --since for history',
				json,
				quiet,
			)
		}
		if (!isIsoDate(sinceRaw)) {
			return parseUsageError(
				'Invalid --since value (expected YYYY-MM-DD)',
				json,
				quiet,
			)
		}
		return {
			ok: true,
			options: {
				command: 'history',
				...outputMode,
				since: sinceRaw,
				contact: contactRaw,
				accountCode: accountCodeRaw,
				fields,
			},
		}
	}
	if (commandToken === 'invoices') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		const normalizedStatus = statusRaw ? String(statusRaw).toUpperCase() : null
		const normalizedInvType = typeRaw ? String(typeRaw).toUpperCase() : null
		if (
			normalizedStatus &&
			!INVOICE_STATUS_ALLOWLIST.includes(
				normalizedStatus as (typeof INVOICE_STATUS_ALLOWLIST)[number],
			)
		) {
			return parseUsageError(
				`Invalid --status value '${normalizedStatus}'. Valid values: ${INVOICE_STATUS_ALLOWLIST.join(', ')}`,
				json,
				quiet,
				{ validValues: INVOICE_STATUS_ALLOWLIST },
			)
		}
		if (
			normalizedInvType &&
			!INVOICE_TYPE_ALLOWLIST.includes(
				normalizedInvType as (typeof INVOICE_TYPE_ALLOWLIST)[number],
			)
		) {
			return parseUsageError(
				`Invalid --type value '${normalizedInvType}'. Valid values: ${INVOICE_TYPE_ALLOWLIST.join(', ')}`,
				json,
				quiet,
				{ validValues: INVOICE_TYPE_ALLOWLIST },
			)
		}
		return {
			ok: true,
			options: {
				command: 'invoices',
				...outputMode,
				status: normalizedStatus,
				type: normalizedInvType,
				fields,
			},
		}
	}
	if (commandToken === 'payments') {
		const { fields, error } = parseFields(fieldsRaw, json, quiet)
		if (error) return error
		const page = pageRaw ? Number(pageRaw) : null
		const limit = limitRaw ? Number(limitRaw) : null
		if (pageRaw && (page === null || !Number.isInteger(page) || page <= 0)) {
			return parseUsageError('Invalid --page value', json, quiet)
		}
		if (
			limitRaw &&
			(limit === null || !Number.isInteger(limit) || limit <= 0)
		) {
			return parseUsageError('Invalid --limit value', json, quiet)
		}
		if (sinceRaw && !isIsoDate(sinceRaw)) {
			return parseUsageError(
				'Invalid --since value (expected YYYY-MM-DD)',
				json,
				quiet,
			)
		}
		if (untilRaw && !isIsoDate(untilRaw)) {
			return parseUsageError(
				'Invalid --until value (expected YYYY-MM-DD)',
				json,
				quiet,
			)
		}
		return {
			ok: true,
			options: {
				command: 'payments',
				...outputMode,
				since: sinceRaw,
				until: untilRaw,
				page,
				limit,
				fields,
			},
		}
	}
	if (fieldsRaw) {
		return parseUsageError(
			'--fields is only valid for list commands (accounts, contacts, transactions, history, invoices, payments)',
			json,
			quiet,
		)
	}
	if (commandToken === 'reconcile') {
		return {
			ok: true,
			options: {
				command: 'reconcile',
				...outputMode,
				execute,
				fromCsv,
			},
		}
	}
	if (commandToken === 'reconcile-post') {
		if (!queuePath) {
			return parseUsageError(
				'Missing required --queue for reconcile-post',
				json,
				quiet,
			)
		}
		if (!postRunPath) {
			return parseUsageError(
				'Missing required --post-run for reconcile-post',
				json,
				quiet,
			)
		}
		return {
			ok: true,
			options: {
				command: 'reconcile-post',
				...outputMode,
				execute,
				queue: queuePath,
				postRun: postRunPath,
			},
		}
	}
	if (commandToken === 'reconcile-delete') {
		if (!postRunPath) {
			return parseUsageError(
				'Missing required --post-run for reconcile-delete',
				json,
				quiet,
			)
		}
		return {
			ok: true,
			options: {
				command: 'reconcile-delete',
				...outputMode,
				execute,
				postRun: postRunPath,
			},
		}
	}
	if (commandToken === 'help') {
		return {
			ok: true,
			options: { command: 'help', ...outputMode, topic },
		}
	}
	if (commandToken === 'version') {
		return {
			ok: true,
			options: { command: 'help', ...outputMode, topic: 'version' },
		}
	}

	return parseUsageError(`Unknown command: ${commandToken}`, json, quiet)
}

function parseUsageError(
	message: string,
	json: boolean,
	quiet: boolean,
	context?: Record<string, unknown>,
): ParseCliError {
	return {
		ok: false,
		exitCode: EXIT_USAGE,
		message,
		output: usageText(),
		errorCode: 'E_USAGE',
		context,
		json,
		quiet,
	}
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function parseFields(
	fieldsRaw: string | null,
	json: boolean,
	quiet: boolean,
): {
	fields: readonly string[] | null
	error?: ParseCliError
} {
	if (!fieldsRaw) return { fields: null }
	const rawFields = fieldsRaw
		.split(',')
		.map((field) => field.trim())
		.filter(Boolean)
	const invalidFields = rawFields.filter(
		(field) => !/^[A-Za-z0-9_.]+$/.test(field),
	)
	if (invalidFields.length > 0) {
		return {
			fields: null,
			error: parseUsageError(
				`Invalid field names: ${invalidFields.join(', ')}. Allowed chars: A-Z, a-z, 0-9, dots, underscores.`,
				json,
				quiet,
				{
					invalidFields,
					validFieldsHint:
						'Fields are PascalCase dot paths (e.g., Contact.Name, BankTransactionID, LineItems.AccountCode). Use --help <command> to see available fields.',
				},
			),
		}
	}
	return { fields: rawFields }
}

function resolveOutputMode(flags: {
	readonly json: boolean
	readonly quiet: boolean
	readonly verbose: boolean
	readonly debug: boolean
	readonly eventsUrl: string | null
}): OutputContext {
	let json = flags.json
	if (!json && !process.stdout.isTTY) {
		json = true
	}

	const logLevel: LogLevel = flags.debug
		? 'debug'
		: flags.json || flags.quiet
			? 'silent'
			: 'info'

	const progressMode: ProgressMode =
		json || flags.quiet
			? 'off'
			: process.stderr.isTTY
				? flags.verbose || flags.debug
					? 'static'
					: 'animated'
				: 'static'

	return {
		json,
		quiet: flags.quiet,
		headless: json || isHeadless(),
		logLevel,
		progressMode,
		eventsConfig: resolveEventsConfig({ eventsUrl: flags.eventsUrl }),
	}
}

function usageText(): string {
	return usageForTopic(null)
}

function isFirstRun(): boolean {
	return !existsSync('.xero-config.json')
}

function usageForTopic(topic: string | null): string {
	const normalizedTopic = topic?.toLowerCase() ?? null
	if (!normalizedTopic) {
		const lines = [
			'xero-cli',
			'',
			'Usage:',
			'  bun run xero-cli <command> [flags]',
			'',
			'Commands:',
			'  auth           OAuth2 PKCE flow',
			'  status         Check auth + API connectivity',
			'  accounts       List chart of accounts (alias: acct)',
			'  contacts       List contacts (alias: ctc)',
			'  transactions   List bank transactions (alias: tx)',
			'  history        Grouped reconciliation history (alias: hist)',
			'  invoices       List outstanding invoices (alias: inv)',
			'  payments       List payments created in Xero (alias: pay)',
			'  reconcile      Reconcile transactions from stdin or CSV (alias: rec)',
			'  reconcile-post   Execute a confirmed CSV post queue',
			'  reconcile-delete Delete posted BankTransactions',
			'  help [topic]     Show help (command, flags, aliases, version)',
			'',
			'Global Flags:',
			'  --json         JSON output (auto-enabled when stdout is not a TTY)',
			'  --quiet        Minimal output',
			'  --verbose      Keep logs on stderr and force static progress',
			'  --debug        Debug logs on stderr (implies verbose behavior)',
			'  --events-url   Observability server URL',
			'  --help         Show help',
			'  --version      Show version',
			'',
			'Try:',
			'  bun run xero-cli help transactions',
			'  bun run xero-cli help flags',
			'  bun run xero-cli help aliases',
		]
		if (isFirstRun()) {
			lines.push(
				'',
				'First run?',
				'  Start with: bun run xero-cli status',
				'  Setup guide: GETTING_STARTED.md',
			)
		}
		return lines.join('\n')
	}

	if (normalizedTopic === 'flags' || normalizedTopic === 'global') {
		return [
			'Global Flags:',
			'  --json         JSON output (auto-enabled when stdout is not a TTY)',
			'  --quiet        Minimal output',
			'  --verbose      Keep logs on stderr and force static progress',
			'  --debug        Debug logs on stderr (implies verbose behavior)',
			'  --events-url   Observability server URL',
			'  --help         Show help',
			'  --version      Show version',
		].join('\n')
	}

	if (normalizedTopic === 'aliases') {
		return [
			'Aliases:',
			'  tx   -> transactions',
			'  acct -> accounts',
			'  ctc  -> contacts',
			'  inv  -> invoices',
			'  pay  -> payments',
			'  rec  -> reconcile',
			'  hist -> history',
		].join('\n')
	}

	if (normalizedTopic === 'version') {
		return 'Use: bun run xero-cli --version'
	}

	const commandHelp: Record<string, string> = {
		auth: ['Usage: bun run xero-cli auth [--auth-timeout <seconds>]'].join(
			'\n',
		),
		status: ['Usage: bun run xero-cli status'].join('\n'),
		accounts: [
			'Usage: bun run xero-cli accounts [--type <ACCOUNT_TYPE>] [--fields <f1,f2,...>]',
			'Flags:',
			`  --type    ${ACCOUNT_TYPE_ALLOWLIST.join('|')}`,
			'  --fields  Comma-separated field list',
		].join('\n'),
		contacts: [
			'Usage: bun run xero-cli contacts [--fields <f1,f2,...>]',
			'Flags:',
			'  --fields  Comma-separated field list',
		].join('\n'),
		transactions: [
			'Usage: bun run xero-cli transactions [flags]',
			'Flags:',
			'  --unreconciled',
			'  --summary',
			'  --this-quarter | --last-quarter',
			'  --since <YYYY-MM-DD> --until <YYYY-MM-DD>',
			'  --page <n> --limit <n>',
			'  --fields <f1,f2,...>',
		].join('\n'),
		history: [
			'Usage: bun run xero-cli history --since <YYYY-MM-DD> [--contact <name>] [--account-code <code>] [--fields <f1,f2,...>]',
		].join('\n'),
		invoices: [
			'Usage: bun run xero-cli invoices [--status <status>] [--type <ACCPAY|ACCREC>] [--fields <f1,f2,...>]',
			'Flags:',
			`  --status  ${INVOICE_STATUS_ALLOWLIST.join('|')}`,
			`  --type    ${INVOICE_TYPE_ALLOWLIST.join('|')}`,
			'  --fields  Comma-separated field list',
			'Defaults:',
			'  Status=="AUTHORISED" when no explicit filter is provided',
		].join('\n'),
		payments: [
			'Usage: bun run xero-cli payments [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--page <n>] [--limit <n>] [--fields <f1,f2,...>]',
			'Flags:',
			'  --since   Inclusive payment date lower bound',
			'  --until   Inclusive payment date upper bound',
			'  --page    Server-side page number',
			'  --limit   Client-side result limit',
			'  --fields  Comma-separated field list',
		].join('\n'),
		reconcile: [
			'Usage: bun run xero-cli reconcile [--from-csv <file>] [--execute|--dry-run]',
			'Flags:',
			'  --from-csv   Input CSV path',
			'  --execute    Apply reconciliation (default is dry-run)',
			'  --dry-run    Explicit dry-run mode',
		].join('\n'),
		'reconcile-post': [
			'Usage: bun run xero-cli reconcile-post --queue <file> --post-run <file> [--execute|--dry-run]',
			'Flags:',
			'  --queue      Exported post queue JSON from scripts/read-reconcile-csv.py',
			'  --post-run   Confirmed post-run JSON from begin-post-run',
			'  --execute    Apply the queued BankTransactions (default is dry-run)',
			'  --dry-run    Validate inputs and preview what would post',
		].join('\n'),
		'reconcile-delete': [
			'Usage: bun run xero-cli reconcile-delete --post-run <file> [--execute|--dry-run]',
			'Flags:',
			'  --post-run   Delete-run state JSON from begin-delete-run',
			'  --execute    Delete the posted BankTransactions (default is dry-run)',
			'  --dry-run    Validate inputs and preview what would be deleted',
		].join('\n'),
		help: ['Usage: bun run xero-cli help [topic]'].join('\n'),
	}
	if (commandHelp[normalizedTopic]) return commandHelp[normalizedTopic]

	const lines = [
		'xero-cli',
		'',
		'Usage:',
		'  bun run xero-cli <command> [flags]',
		'',
		'Commands:',
		'  auth           OAuth2 PKCE flow',
		'  status         Check auth + API connectivity',
		'  accounts       List chart of accounts',
		'  contacts       List contacts',
		'  transactions   List bank transactions',
		'  history        Grouped reconciliation history',
		'  invoices       List outstanding invoices',
		'  payments       List payments created in Xero',
		'  reconcile      Reconcile transactions from stdin or CSV',
		'  reconcile-post   Execute a confirmed CSV post queue',
		'  reconcile-delete Delete posted BankTransactions',
		'  help [topic]     Show help',
		'',
		'Global Flags:',
		'  --json         JSON output (auto-enabled when stdout is not a TTY)',
		'  --quiet        Minimal output',
		'  --verbose      Keep logs on stderr and force static progress',
		'  --debug        Debug logs on stderr (implies verbose behavior)',
		'  --events-url   Observability server URL',
		'  --help         Show help',
		'  --version      Show version',
		'',
		'Log Env Vars:',
		'  XERO_LOG_LEVEL       silent|info|debug (global default)',
		'  XERO_LOG_LEVEL_API   silent|info|debug (api logger override)',
		'  XERO_LOG_LEVEL_AUTH  silent|info|debug (auth logger override)',
		'  XERO_LOG_LEVEL_CLI   silent|info|debug (cli logger override)',
		'',
		'Auth Flags:',
		'  --auth-timeout  Auth timeout in seconds (default 300)',
		'',
		'Aliases:',
		'  tx   -> transactions',
		'  acct -> accounts',
		'  ctc  -> contacts',
		'  inv  -> invoices',
		'  pay  -> payments',
		'  rec  -> reconcile',
		'  hist -> history',
	]
	if (isFirstRun()) {
		lines.push(
			'',
			'First run?',
			'  Start with: bun run xero-cli status',
			'  Setup guide: GETTING_STARTED.md',
		)
	}
	return lines.join('\n')
}

/**
 * Strip sensitive fields (tokens, secrets) from CLI options before logging.
 * Returns a plain object safe for structured log properties.
 */
function sanitizeCliOptions(options: CliOptions): Record<string, unknown> {
	const {
		command,
		json,
		quiet,
		logLevel,
		progressMode,
		eventsConfig,
		...rest
	} = options
	return {
		command,
		json,
		quiet,
		logLevel,
		progressMode,
		...rest,
	}
}

/** Derive the output mode label for events: json > quiet > human. */
function resolveMode(ctx: OutputContext): 'json' | 'quiet' | 'human' {
	if (ctx.json) return 'json'
	if (ctx.quiet) return 'quiet'
	return 'human'
}

/** Run the CLI and return an exit code for process exit. */
export async function runCli(argv: readonly string[]): Promise<ExitCode> {
	const parsed = parseCli(argv)
	if (!parsed.ok) {
		const ctx: OutputContext = {
			json: parsed.json,
			quiet: parsed.quiet,
			headless: parsed.json || isHeadless(),
			logLevel: 'silent',
			progressMode: parsed.json || parsed.quiet ? 'off' : 'static',
			eventsConfig: resolveEventsConfig(),
		}
		emitEvent(ctx.eventsConfig, 'xero-cli-usage-error', {
			message: parsed.message,
			errorCode: parsed.errorCode,
		})
		writeError(
			ctx,
			parsed.message,
			parsed.errorCode,
			'UsageError',
			parsed.context,
		)
		if (!ctx.json && !ctx.quiet) {
			process.stderr.write(`${parsed.output}\n`)
		}
		return parsed.exitCode
	}

	const options = parsed.options
	const ctx: OutputContext = {
		json: options.json,
		quiet: options.quiet,
		headless: options.headless,
		logLevel: options.logLevel,
		progressMode: options.progressMode,
		eventsConfig: options.eventsConfig,
	}

	return await withContext({ runId: randomUUID() }, async () => {
		const startTime = Date.now()
		const mode = resolveMode(ctx)
		try {
			await setupLogging(ctx)
			cliLogger.info('CLI started: {command}', {
				command: options.command,
			})
			emitEvent(ctx.eventsConfig, 'xero-cli-started', {
				command: options.command,
				mode,
			})
			emitEvent(ctx.eventsConfig, 'xero-command-started', {
				command: options.command,
				mode,
			})
			cliLogger.debug('Parsed options: {options}', {
				options: sanitizeCliOptions(options),
			})
			let exitCode: ExitCode
			switch (options.command) {
				case 'auth':
					exitCode = await runAuth(ctx, options)
					break
				case 'status':
					exitCode = await runStatus(ctx)
					break
				case 'accounts':
					exitCode = await runAccounts(ctx, options)
					break
				case 'contacts':
					exitCode = await runContacts(ctx, options)
					break
				case 'transactions':
					exitCode = await runTransactions(ctx, options)
					break
				case 'history':
					exitCode = await runHistory(ctx, options)
					break
				case 'invoices':
					exitCode = await runInvoices(ctx, options)
					break
				case 'payments':
					exitCode = await runPayments(ctx, options)
					break
				case 'reconcile':
					exitCode = await runReconcile(ctx, options)
					break
				case 'reconcile-post':
					exitCode = await runReconcilePostQueue(ctx, options)
					break
				case 'reconcile-delete':
					exitCode = await runReconcileDelete(ctx, options)
					break
				case 'help': {
					if (options.topic === 'version') {
						writeSuccess(
							ctx,
							{ command: 'version', version: '0.0.0' },
							['xero-cli v0.0.0'],
							'0.0.0',
						)
						exitCode = EXIT_OK
						break
					}
					writeSuccess(
						ctx,
						{ command: 'help', topic: options.topic },
						[usageForTopic(options.topic)],
						'xero-cli help',
					)
					exitCode = EXIT_OK
					break
				}
				default: {
					const _exhaustive: never = options
					return _exhaustive
				}
			}
			const durationMs = Date.now() - startTime
			cliLogger.info(
				'CLI completed: {command} exitCode={exitCode} duration={durationMs}ms',
				{
					command: options.command,
					exitCode,
					durationMs,
				},
			)
			emitEvent(ctx.eventsConfig, 'xero-cli-completed', {
				command: options.command,
				exitCode,
				durationMs,
				mode,
				status: 'success',
			})
			// Keep both events for backward compatibility:
			// xero-cli-completed (legacy lifecycle) and xero-command-completed (command scoped).
			emitEvent(ctx.eventsConfig, 'xero-command-completed', {
				command: options.command,
				exitCode,
				durationMs,
				mode,
				status: 'success',
			})
			return exitCode
		} catch (err) {
			const durationMs = Date.now() - startTime
			if (err instanceof Error && err.name === 'AbortError') {
				cliLogger.info('CLI interrupted: {command} duration={durationMs}ms', {
					command: options.command,
					durationMs,
				})
				emitEvent(ctx.eventsConfig, 'xero-cli-completed', {
					command: options.command,
					exitCode: EXIT_INTERRUPTED,
					durationMs,
					mode,
					status: 'interrupted',
				})
				emitEvent(ctx.eventsConfig, 'xero-command-completed', {
					command: options.command,
					exitCode: EXIT_INTERRUPTED,
					durationMs,
					mode,
					status: 'interrupted',
				})
				return EXIT_INTERRUPTED
			}
			const rawMessage = err instanceof Error ? err.message : String(err)
			const message = sanitizeErrorMessage(rawMessage)
			const exitCode = handleCommandErrorWithContext(ctx, err, {
				command: options.command,
			})
			cliLogger.error(
				'CLI failed: {command} error={error} exitCode={exitCode} duration={durationMs}ms',
				{
					command: options.command,
					error: message,
					exitCode,
					durationMs,
				},
			)
			emitEvent(ctx.eventsConfig, 'xero-command-error', {
				command: options.command,
				errorCode:
					err instanceof Error && 'code' in err && typeof err.code === 'string'
						? err.code
						: 'E_RUNTIME',
				errorFamily:
					err instanceof Error && 'name' in err
						? String(err.name)
						: 'RuntimeError',
				exitCode,
				durationMs,
				message,
				mode,
			})
			emitEvent(ctx.eventsConfig, 'xero-cli-completed', {
				command: options.command,
				exitCode,
				durationMs,
				mode,
				status: 'failed',
			})
			emitEvent(ctx.eventsConfig, 'xero-command-completed', {
				command: options.command,
				exitCode,
				durationMs,
				mode,
				status: 'failed',
			})
			return exitCode
		} finally {
			await shutdownLogging()
		}
	})
}

/** Execute the CLI when run directly. */
export async function main(): Promise<void> {
	process.once('SIGINT', () => {
		void shutdownLogging()
	})
	const code = await runCli(process.argv)
	await waitForStdoutDrain()
	process.exit(code)
}

if (import.meta.main) {
	void main()
}
