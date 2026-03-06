import { existsSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
	lstat,
	mkdir,
	open,
	readdir,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { emitEvent } from '../../events'
import { getXeroLogger } from '../../logging'
import { acquireLock, releaseLock } from '../../state/lock'
import { loadState, resolveStatePath, StateBatcher } from '../../state/state'
import { xeroFetch } from '../../xero/api'
import { loadValidTokens } from '../../xero/auth'
import { loadEnvConfig, loadXeroConfig } from '../../xero/config'
import {
	StructuredError,
	XeroApiError,
	XeroConflictError,
} from '../../xero/errors'
import type {
	BankTransactionRecord,
	BankTransactionsResponse,
	LineItemRecord,
} from '../../xero/types'
import { BankTransactionsResponseSchema } from '../../xero/types'
import type { ExitCode, OutputContext } from '../output'
import {
	EXIT_INTERRUPTED,
	EXIT_OK,
	EXIT_RUNTIME,
	EXIT_UNAUTHORIZED,
	EXIT_USAGE,
	handleCommandErrorWithContext,
	writeError,
	writeSuccess,
} from '../output'

const MAX_STDIN_BYTES = 5 * 1024 * 1024
const AUDIT_DIR = '.xero-reconcile-runs'
const AUDIT_MODE = 0o600
const AUDIT_DIR_MODE = 0o700
const UUID_SHAPE =
	/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
const ACCOUNT_CODE_SHAPE = /^[A-Za-z0-9]{1,10}$/

/** Logger for the reconciliation pipeline. */
const reconcileLogger = getXeroLogger(['cli', 'commands', 'reconcile'])

interface ReconcileCommand {
	readonly command: 'reconcile'
	readonly execute: boolean
	readonly fromCsv: string | null
}

const ReconcileItemSchema = z
	.object({
		BankTransactionID: z
			.string()
			.regex(UUID_SHAPE, 'Invalid BankTransactionID'),
		AccountCode: z
			.string()
			.regex(ACCOUNT_CODE_SHAPE, 'Invalid AccountCode')
			.optional(),
		InvoiceID: z.string().regex(UUID_SHAPE, 'Invalid InvoiceID').optional(),
		Amount: z.number().positive().optional(),
		CurrencyCode: z.string().min(1).optional(),
	})
	.strict()
	.refine((value) => !(value.AccountCode && value.InvoiceID), {
		message: 'AccountCode and InvoiceID are mutually exclusive',
	})
	.refine((value) => value.AccountCode || value.InvoiceID, {
		message: 'Either AccountCode or InvoiceID is required',
	})

const ReconcileArraySchema = z.array(ReconcileItemSchema).min(1).max(1000)

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
		if (this.mode === 'animated') {
			process.stderr.write('\n')
		}
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

interface ReconcileInputBase {
	readonly BankTransactionID: string
	readonly AccountCode?: string
	readonly InvoiceID?: string
	readonly Amount?: number
	readonly CurrencyCode?: string
}

interface ReconcileResult {
	readonly BankTransactionID: string
	readonly status: 'reconciled' | 'skipped' | 'failed' | 'dry-run'
	readonly AccountCode?: string
	readonly InvoiceID?: string
	readonly PaymentID?: string
	readonly error?: string
	readonly errorCode?: string
}

interface AccountsResponse {
	readonly Accounts: { Code?: string; Status?: string }[]
}

const AccountsResponseSchema = z.object({
	Accounts: z.array(
		z.object({
			Code: z.string().optional(),
			Status: z.string().optional(),
		}),
	),
})

interface InvoicesResponse {
	readonly Invoices: {
		InvoiceID: string
		Status: string
		AmountDue: number
		CurrencyCode: string
	}[]
}

const InvoicesResponseSchema = z.object({
	Invoices: z.array(
		z.object({
			InvoiceID: z.string(),
			Status: z.string(),
			AmountDue: z.number(),
			CurrencyCode: z.string(),
		}),
	),
})

interface PaymentsResponse {
	readonly Payments: {
		PaymentID?: string
		StatusAttributeString?: string
		HasErrors?: boolean
		HasValidationErrors?: boolean
		Amount?: number
	}[]
}

const PaymentsResponseSchema = z.object({
	Payments: z.array(
		z.object({
			PaymentID: z.string().optional(),
			StatusAttributeString: z.string().optional(),
			HasErrors: z.boolean().optional(),
			HasValidationErrors: z.boolean().optional(),
			Amount: z.number().optional(),
		}),
	),
})

interface RetryInfo {
	readonly reason: 'rate-limit' | 'server-error' | 'timeout'
	readonly backoffMs: number
	readonly status?: number
}

/** Validate BankTransaction API responses before mutating state. */
export function assertValidBankTransactionResponse(
	response: BankTransactionsResponse,
	options?: { readonly expectedTotal?: number },
): BankTransactionRecord {
	if (!response || typeof response !== 'object') {
		throw new XeroApiError('Invalid BankTransaction response payload', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	const txn = response.BankTransactions?.[0]
	if (!txn || typeof txn !== 'object') {
		throw new XeroApiError('Missing BankTransaction in response', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (!txn.BankTransactionID) {
		throw new XeroApiError('Missing BankTransactionID in response', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (
		txn.HasErrors ||
		txn.HasValidationErrors ||
		txn.StatusAttributeString === 'ERROR'
	) {
		throw new XeroApiError('BankTransaction response has validation errors', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (
		typeof options?.expectedTotal === 'number' &&
		typeof txn.Total === 'number' &&
		Math.abs(options.expectedTotal - txn.Total) > 0.01
	) {
		throw new XeroApiError('BankTransaction total mismatch', {
			code: 'E_CONFLICT',
			recoverable: true,
		})
	}
	return txn
}

/** Validate Payment API responses before mutating state. */
export function assertValidPaymentResponse(
	payment: PaymentsResponse['Payments'][number],
): void {
	if (!payment || typeof payment !== 'object') {
		throw new XeroApiError('Invalid Payment response payload', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (!payment.PaymentID) {
		throw new XeroApiError('Missing PaymentID in response', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (
		payment.HasErrors ||
		payment.HasValidationErrors ||
		payment.StatusAttributeString === 'ERROR'
	) {
		throw new XeroApiError('Payment response has validation errors', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
	if (typeof payment.Amount !== 'number') {
		throw new XeroApiError('Missing Amount in payment response', {
			code: 'E_MALFORMED_RESPONSE',
			recoverable: false,
		})
	}
}

function ensureNoDuplicates(inputs: ReconcileInputBase[]): string[] {
	const seen = new Set<string>()
	const duplicates: string[] = []
	for (const item of inputs) {
		if (seen.has(item.BankTransactionID)) {
			duplicates.push(item.BankTransactionID)
		} else {
			seen.add(item.BankTransactionID)
		}
	}
	return duplicates
}

function validateInputs(inputs: unknown): ReconcileInputBase[] {
	const validated = ReconcileArraySchema.safeParse(inputs)
	if (!validated.success) {
		throw new XeroApiError(
			validated.error.issues.map((issue) => issue.message).join('; '),
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}
	const duplicates = ensureNoDuplicates(validated.data)
	if (duplicates.length > 0) {
		throw new XeroApiError(
			`Duplicate BankTransactionID(s): ${duplicates.join(', ')}`,
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}
	return validated.data
}

function parseJsonInput(raw: string): ReconcileInputBase[] {
	try {
		const parsed = JSON.parse(raw) as unknown
		return validateInputs(parsed)
	} catch (err) {
		if (err instanceof StructuredError) throw err
		throw new XeroApiError(
			`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`,
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}
}

async function readStdinWithLimit(): Promise<string> {
	const chunks: Uint8Array[] = []
	let total = 0
	for await (const chunk of Bun.stdin.stream()) {
		const buffer = new Uint8Array(chunk)
		total += buffer.length
		if (total > MAX_STDIN_BYTES) {
			throw new XeroApiError('Input exceeds 5MB limit', {
				code: 'E_USAGE',
				recoverable: false,
			})
		}
		chunks.push(buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/**
 * Parse a single CSV line per RFC-4180.
 *
 * Handles quoted fields containing commas and escaped double-quotes (`""`).
 * Only splits on commas that appear outside of quoted regions.
 */
export function parseCsvLine(line: string): string[] {
	const fields: string[] = []
	let current = ''
	let inQuotes = false
	let i = 0

	while (i < line.length) {
		const ch = line[i] as string

		if (inQuotes) {
			if (ch === '"') {
				// Peek ahead: escaped quote ("") or end of quoted field
				if (i + 1 < line.length && line[i + 1] === '"') {
					current += '"'
					i += 2
				} else {
					inQuotes = false
					i += 1
				}
			} else {
				current += ch
				i += 1
			}
		} else {
			if (ch === '"') {
				inQuotes = true
				i += 1
			} else if (ch === ',') {
				fields.push(current.trim())
				current = ''
				i += 1
			} else {
				current += ch
				i += 1
			}
		}
	}

	// Push the final field
	fields.push(current.trim())

	return fields
}

/**
 * Validate that a CSV path is safe to read.
 *
 * Prevents path traversal attacks by ensuring the resolved path stays within
 * the allowed base directory (defaults to cwd) and has a .csv extension.
 * In the agent-native context, a compromised agent could otherwise pass
 * arbitrary paths like /etc/passwd via --from-csv.
 */
export async function validateCsvPath(
	pathname: string,
	baseDir?: string,
): Promise<void> {
	const resolved = path.resolve(pathname)
	const allowed = baseDir ?? process.cwd()

	if (!resolved.startsWith(`${allowed}${path.sep}`) && resolved !== allowed) {
		throw new XeroApiError(
			`CSV path must be within ${allowed} -- got ${resolved}`,
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}

	if (path.extname(resolved).toLowerCase() !== '.csv') {
		throw new XeroApiError('CSV path must have a .csv extension', {
			code: 'E_USAGE',
			recoverable: false,
		})
	}

	/** Reject symlinks to prevent file-escape attacks via crafted symlinks. */
	try {
		const statInfo = await lstat(resolved)
		if (statInfo.isSymbolicLink()) {
			throw new XeroApiError(
				`CSV path must not be a symlink -- got ${resolved}`,
				{
					code: 'E_USAGE',
					recoverable: false,
				},
			)
		}
	} catch (err) {
		if (err instanceof XeroApiError) throw err
		// File doesn't exist yet -- let the caller surface the read error.
	}
}

/** Result of CSV loading, including parsed inputs and import metadata. */
interface CsvLoadResult {
	readonly inputs: ReconcileInputBase[]
	/** True if any record used SuggestedAccountCode instead of AccountCode. */
	readonly usedFallbackColumn: boolean
}

async function loadCsv(pathname: string): Promise<CsvLoadResult> {
	await validateCsvPath(pathname)
	const raw = await Bun.file(pathname).text()
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
	if (lines.length === 0) {
		throw new XeroApiError('CSV is empty', {
			code: 'E_USAGE',
			recoverable: false,
		})
	}
	const firstLine = lines[0] as string
	const header = parseCsvLine(firstLine)
	const required = ['BankTransactionID']
	for (const col of required) {
		if (!header.includes(col)) {
			throw new XeroApiError(`CSV missing required column: ${col}`, {
				code: 'E_USAGE',
				recoverable: false,
			})
		}
	}
	const inputs: unknown[] = []
	let usedFallbackColumn = false
	for (const line of lines.slice(1)) {
		const values = parseCsvLine(line)
		const record: Record<string, string> = {}
		header.forEach((key, idx) => {
			record[key] = values[idx] ?? ''
		})
		if (!record.BankTransactionID) continue
		const accountCode =
			record.AccountCode || record.SuggestedAccountCode || undefined
		if (!record.AccountCode && record.SuggestedAccountCode) {
			usedFallbackColumn = true
		}
		let amount: number | undefined
		if (record.Amount) {
			const parsedAmount = Number(record.Amount)
			if (!Number.isFinite(parsedAmount)) {
				throw new XeroApiError(
					`Invalid Amount '${record.Amount}' for ${record.BankTransactionID}`,
					{
						code: 'E_USAGE',
						recoverable: false,
					},
				)
			}
			amount = parsedAmount
		}
		inputs.push({
			BankTransactionID: record.BankTransactionID,
			AccountCode: accountCode,
			InvoiceID: record.InvoiceID || undefined,
			Amount: amount,
			CurrencyCode: record.CurrencyCode || undefined,
		})
	}
	return { inputs: validateInputs(inputs), usedFallbackColumn }
}

async function ensureAuditDir(cwd = process.cwd()): Promise<string> {
	const dir = path.join(cwd, AUDIT_DIR)
	await mkdir(dir, { recursive: true, mode: AUDIT_DIR_MODE })
	return dir
}

async function pruneAudits(cwd = process.cwd()): Promise<void> {
	const dir = path.join(cwd, AUDIT_DIR)
	if (!existsSync(dir)) return
	const entries = await readdir(dir)
	const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
	await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry)
			const info = await stat(fullPath)
			if (info.mtimeMs < cutoff) {
				await unlink(fullPath)
			}
		}),
	)
}

async function createAuditFile(auditPath: string): Promise<void> {
	await writeFile(auditPath, '', {
		encoding: 'utf8',
		mode: AUDIT_MODE,
		flag: 'wx',
	})
}

const AUDIT_FLUSH_THRESHOLD = 50

/**
 * Buffered audit writer that keeps a single file handle open for the
 * duration of a reconciliation run. Entries are buffered in memory and
 * flushed every AUDIT_FLUSH_THRESHOLD items (and on close) to avoid
 * per-item open/seek/write/close cycles.
 */
class AuditWriter {
	private handle: FileHandle | null = null
	private buffer: string[] = []
	private readonly path: string

	constructor(auditPath: string) {
		this.path = auditPath
	}

	/** Open the file handle for appending. Must be called before write(). */
	async open(): Promise<void> {
		this.handle = await open(this.path, 'a')
	}

	/** Buffer an audit entry and flush when the threshold is reached. */
	async write(payload: Record<string, unknown>): Promise<void> {
		this.buffer.push(JSON.stringify(payload))
		if (this.buffer.length >= AUDIT_FLUSH_THRESHOLD) {
			await this.flush()
		}
	}

	/** Flush any buffered entries to disk. */
	async flush(): Promise<void> {
		if (this.buffer.length === 0 || !this.handle) return
		const data = `${this.buffer.join('\n')}\n`
		this.buffer = []
		await this.handle.write(data, null, 'utf8')
	}

	/** Flush remaining entries and close the file handle. */
	async close(): Promise<void> {
		try {
			await this.flush()
		} finally {
			if (this.handle) {
				await this.handle.close()
				this.handle = null
			}
		}
	}
}

/**
 * Fetch all unreconciled bank transactions across all pages.
 *
 * Xero returns at most 100 records per page. We loop with an
 * incrementing `page` parameter until a page returns fewer items
 * than the page size, which signals the end of results.
 */
async function fetchUnreconciledSnapshot(
	accessToken: string,
	tenantId: string,
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<Map<string, { Type?: string; Total?: number }>> {
	const PAGE_SIZE = 100
	const MAX_PAGES = 100
	const snapshot = new Map<string, { Type?: string; Total?: number }>()
	let page = 1

	while (true) {
		if (page > MAX_PAGES) {
			throw new XeroApiError('Unreconciled snapshot exceeded max pages', {
				code: 'E_RUNTIME',
				recoverable: false,
				context: { maxPages: MAX_PAGES },
			})
		}
		const response = await xeroFetch<BankTransactionsResponse>(
			`/BankTransactions?where=IsReconciled==false&page=${page}`,
			{ method: 'GET' },
			{
				accessToken,
				tenantId,
				eventsConfig: options.eventsConfig,
				onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
				onRetry: options.onRetry,
				schema: BankTransactionsResponseSchema,
			},
		)
		const transactions = response.BankTransactions ?? []
		for (const txn of transactions) {
			if (!txn.BankTransactionID) continue
			snapshot.set(txn.BankTransactionID, {
				Type: txn.Type,
				Total: txn.Total,
			})
		}
		if (transactions.length < PAGE_SIZE) break
		page += 1
	}

	return snapshot
}

async function fetchAccounts(
	accessToken: string,
	tenantId: string,
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<Set<string>> {
	const response = await xeroFetch<AccountsResponse>(
		'/Accounts',
		{ method: 'GET' },
		{
			accessToken,
			tenantId,
			eventsConfig: options.eventsConfig,
			onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
			onRetry: options.onRetry,
			schema: AccountsResponseSchema,
		},
	)
	return new Set(
		(response.Accounts ?? [])
			.filter((account) => account.Status === 'ACTIVE')
			.map((account) => account.Code)
			.filter((code): code is string => typeof code === 'string'),
	)
}

/**
 * Batch-fetch full BankTransaction records by IDs to avoid N+1 API calls.
 *
 * Uses the Xero IDs filter parameter, fetching in chunks of 50 (matching
 * the invoice prefetch pattern). Returns a Map keyed by BankTransactionID.
 */
async function fetchBankTransactionsBatch(
	accessToken: string,
	tenantId: string,
	ids: string[],
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<Map<string, BankTransactionRecord>> {
	const byId = new Map<string, BankTransactionRecord>()
	if (ids.length === 0) return byId
	const chunkSize = 50
	for (let i = 0; i < ids.length; i += chunkSize) {
		const batch = ids.slice(i, i + chunkSize)
		const response = await xeroFetch<BankTransactionsResponse>(
			`/BankTransactions?IDs=${batch.join(',')}`,
			{ method: 'GET' },
			{
				accessToken,
				tenantId,
				eventsConfig: options.eventsConfig,
				onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
				onRetry: options.onRetry,
				schema: BankTransactionsResponseSchema,
			},
		)
		for (const txn of response.BankTransactions ?? []) {
			if (txn.BankTransactionID) {
				byId.set(txn.BankTransactionID, txn)
			}
		}
	}
	return byId
}

async function updateBankTransaction(
	accessToken: string,
	tenantId: string,
	transactionId: string,
	lineItems: LineItemRecord[],
	expectedTotal: number | undefined,
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<BankTransactionRecord> {
	const response = await xeroFetch<BankTransactionsResponse>(
		`/BankTransactions/${transactionId}`,
		{
			method: 'POST',
			body: JSON.stringify({
				BankTransactions: [
					{
						BankTransactionID: transactionId,
						IsReconciled: true,
						LineItems: lineItems,
					},
				],
			}),
		},
		{
			accessToken,
			tenantId,
			eventsConfig: options.eventsConfig,
			onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
			onRetry: options.onRetry,
			schema: BankTransactionsResponseSchema,
		},
	)
	return assertValidBankTransactionResponse(response, {
		expectedTotal,
	})
}

async function fetchInvoices(
	accessToken: string,
	tenantId: string,
	ids: string[],
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<Map<string, InvoicesResponse['Invoices'][number]>> {
	const byId = new Map<string, InvoicesResponse['Invoices'][number]>()
	const chunkSize = 50
	for (let i = 0; i < ids.length; i += chunkSize) {
		const batch = ids.slice(i, i + chunkSize)
		const response = await xeroFetch<InvoicesResponse>(
			`/Invoices?IDs=${batch.join(',')}`,
			{ method: 'GET' },
			{
				accessToken,
				tenantId,
				eventsConfig: options.eventsConfig,
				onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
				onRetry: options.onRetry,
				schema: InvoicesResponseSchema,
			},
		)
		for (const invoice of response.Invoices ?? []) {
			byId.set(invoice.InvoiceID, invoice)
		}
	}
	return byId
}

async function createPayments(
	accessToken: string,
	tenantId: string,
	payments: Record<string, unknown>[],
	options: {
		readonly eventsConfig: OutputContext['eventsConfig']
		readonly onRetry?: (info: RetryInfo) => void
	},
): Promise<PaymentsResponse['Payments']> {
	const response = await xeroFetch<PaymentsResponse>(
		'/Payments',
		{
			method: 'PUT',
			body: JSON.stringify({ Payments: payments }),
		},
		{
			accessToken,
			tenantId,
			eventsConfig: options.eventsConfig,
			onUnauthorized: async () => await loadValidTokens(options.eventsConfig),
			onRetry: options.onRetry,
			schema: PaymentsResponseSchema,
		},
	)
	const list = response.Payments ?? []
	for (const payment of list) {
		assertValidPaymentResponse(payment)
	}
	return list
}

/** Reconcile bank transactions using AccountCode or InvoiceID. */
export async function runReconcile(
	ctx: OutputContext,
	options: ReconcileCommand,
): Promise<ExitCode> {
	let lockAcquired = false
	let interrupted = false
	let checkpointId = 'start'
	let auditWriter: AuditWriter | null = null
	let stateBatcher: StateBatcher | null = null
	const runCwd = process.cwd()
	const stateFile = resolveStatePath(runCwd)
	const progress = new ProgressDisplay(ctx.progressMode)
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

		let inputs: ReconcileInputBase[] = []
		if (options.fromCsv) {
			await validateCsvPath(options.fromCsv)
			if (!existsSync(options.fromCsv)) {
				writeError(ctx, 'CSV file not found', 'E_USAGE', 'UsageError')
				return EXIT_USAGE
			}
			try {
				const csvResult = await loadCsv(options.fromCsv)
				inputs = csvResult.inputs
				emitEvent(ctx.eventsConfig, 'xero-csv-imported', {
					rowCount: csvResult.inputs.length,
					source: 'file',
					usedFallbackColumn: csvResult.usedFallbackColumn,
				})
			} catch (err) {
				emitEvent(ctx.eventsConfig, 'xero-csv-import-failed', {
					error: err instanceof Error ? err.message : String(err),
					source: 'file',
				})
				throw new XeroApiError(
					err instanceof Error ? err.message : String(err),
					{
						code: 'E_USAGE',
						recoverable: false,
					},
				)
			}
		} else {
			const raw = await readStdinWithLimit()
			inputs = parseJsonInput(raw)
		}

		if (options.execute) {
			const auditPath = path.join(
				await ensureAuditDir(runCwd),
				`${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`,
			)
			await createAuditFile(auditPath)
			auditWriter = new AuditWriter(auditPath)
			await auditWriter.open()
		}

		const retryHandler = (info: RetryInfo) => {
			if (ctx.json || ctx.quiet) return
			if (info.reason === 'rate-limit') {
				const seconds = Math.max(1, Math.round(info.backoffMs / 1000))
				progress.pause(`${seconds}s`)
			}
		}

		const unreconciledSnapshot = await fetchUnreconciledSnapshot(
			tokens.accessToken,
			config.tenantId,
			{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
		)
		const unreconciledSet = new Set(unreconciledSnapshot.keys())
		reconcileLogger.info(
			'Preflight: fetched {transactionCount} unreconciled transactions',
			{ transactionCount: unreconciledSnapshot.size },
		)
		const accountCodes = await fetchAccounts(
			tokens.accessToken,
			config.tenantId,
			{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
		)
		reconcileLogger.info(
			'Preflight: loaded {accountCodeCount} active account codes',
			{ accountCodeCount: accountCodes.size },
		)

		const invalidIds = inputs
			.filter((input) => !unreconciledSet.has(input.BankTransactionID))
			.map((input) => input.BankTransactionID)
		if (invalidIds.length > 0) {
			// Cross-reference invalid IDs against the full transaction set
			// to distinguish "already reconciled" from "not found"
			const fullLookup = await fetchBankTransactionsBatch(
				tokens.accessToken,
				config.tenantId,
				invalidIds,
				{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
			)
			const alreadyReconciled = invalidIds.filter((id) => fullLookup.has(id))
			const notFound = invalidIds.filter((id) => !fullLookup.has(id))

			const lines: string[] = []
			for (const id of alreadyReconciled) {
				lines.push(`Already reconciled: ${id}`)
			}
			for (const id of notFound) {
				lines.push(`Not found: ${id}`)
			}
			throw new XeroApiError(lines.join('\n'), {
				code: 'E_STALE_DATA',
				recoverable: true,
				context: {
					alreadyReconciled,
					notFound,
				},
			})
		}

		const invalidCodes = inputs
			.filter(
				(input) => input.AccountCode && !accountCodes.has(input.AccountCode),
			)
			.map((input) => input.AccountCode)
			.filter(Boolean)
		if (invalidCodes.length > 0) {
			throw new XeroApiError(
				`Invalid AccountCode(s): ${invalidCodes.join(', ')}`,
				{
					code: 'E_USAGE',
					recoverable: false,
				},
			)
		}

		const invoiceIds = inputs
			.map((input) => input.InvoiceID)
			.filter((id): id is string => typeof id === 'string')
		const invoicesById =
			invoiceIds.length > 0
				? await fetchInvoices(tokens.accessToken, config.tenantId, invoiceIds, {
						eventsConfig: ctx.eventsConfig,
						onRetry: retryHandler,
					})
				: new Map()

		// Batch prefetch all BankTransaction records needed for reconciliation.
		// Both AccountCode and InvoiceID paths require the full record (for
		// LineItems and BankAccount.AccountID respectively). This eliminates
		// the N+1 pattern where each item triggered an individual GET request.
		const idsNeedingFullRecord = inputs
			.filter((input) => input.AccountCode || input.InvoiceID)
			.map((input) => input.BankTransactionID)
		const bankTxnById =
			idsNeedingFullRecord.length > 0
				? await fetchBankTransactionsBatch(
						tokens.accessToken,
						config.tenantId,
						idsNeedingFullRecord,
						{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
					)
				: new Map<string, BankTransactionRecord>()

		const state = await loadState(runCwd)
		const recoveredIds = Object.keys(state.processed)
		const results: ReconcileResult[] = []
		let processedCount = 0
		const totalCount = inputs.length

		if (recoveredIds.length > 0) {
			reconcileLogger.info(
				'Resuming from previous state with {recoveredCount} already processed',
				{ recoveredCount: recoveredIds.length },
			)
			emitEvent(ctx.eventsConfig, 'xero-state-recovered', {
				recoveredCount: recoveredIds.length,
				totalCount,
			})
		}

		stateBatcher = new StateBatcher(
			state,
			undefined,
			({ checkpointNumber }) => {
				checkpointId = `checkpoint-${checkpointNumber}`
				emitEvent(ctx.eventsConfig, 'xero-state-checkpoint', {
					processedCount,
					totalCount,
					checkpointNumber,
					checkpointId,
				})
				reconcileLogger.debug(
					'State checkpoint #{checkpointNumber} flushed at {processedCount}/{totalCount}',
					{ checkpointNumber, processedCount, totalCount },
				)
			},
			runCwd,
		)

		emitEvent(ctx.eventsConfig, 'xero-reconcile-started', {
			mode: options.execute ? 'execute' : 'dry-run',
			total: totalCount,
			fromCsv: options.fromCsv ?? null,
		})

		const reportResult = (result: ReconcileResult): void => {
			if (ctx.json || ctx.quiet) return
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

		for (const input of inputs) {
			if (stateBatcher.isProcessed(input.BankTransactionID)) {
				reconcileLogger.debug('Skipping {txnId} - already processed in state', {
					txnId: input.BankTransactionID,
				})
				emitEvent(ctx.eventsConfig, 'xero-reconcile-item-skipped', {
					bankTransactionId: input.BankTransactionID,
					reason: 'already-processed',
				})
				const result: ReconcileResult = {
					BankTransactionID: input.BankTransactionID,
					status: 'skipped',
					AccountCode: input.AccountCode,
					InvoiceID: input.InvoiceID,
				}
				results.push(result)
				processedCount += 1
				checkpointId = `item-${processedCount}`
				reportResult(result)
				progress.update(processedCount, totalCount)
				if (interrupted) break
				continue
			}

			if (!options.execute) {
				reconcileLogger.debug('Dry-run for {txnId} with {target}', {
					txnId: input.BankTransactionID,
					target: input.AccountCode
						? `AccountCode=${input.AccountCode}`
						: `InvoiceID=${input.InvoiceID}`,
				})
				const result: ReconcileResult = {
					BankTransactionID: input.BankTransactionID,
					status: 'dry-run',
					AccountCode: input.AccountCode,
					InvoiceID: input.InvoiceID,
				}
				results.push(result)
				emitEvent(ctx.eventsConfig, 'xero-reconcile-item-skipped', {
					bankTransactionId: input.BankTransactionID,
					reason: 'dry-run',
					accountCode: input.AccountCode,
					invoiceId: input.InvoiceID,
				})
				processedCount += 1
				reportResult(result)
				progress.update(processedCount, totalCount)
				if (interrupted) break
				continue
			}

			const itemStart = performance.now()
			try {
				if (input.AccountCode) {
					reconcileLogger.debug(
						'Processing {txnId} with AccountCode={accountCode}',
						{ txnId: input.BankTransactionID, accountCode: input.AccountCode },
					)
					const pre = bankTxnById.get(input.BankTransactionID)
					if (!pre) {
						throw new XeroApiError(
							`BankTransaction not found in prefetch: ${input.BankTransactionID}`,
							{
								code: 'E_STALE_DATA',
								recoverable: true,
							},
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

					reconcileLogger.debug(
						'Updating BankTransaction {txnId} with {lineItemCount} line items',
						{
							txnId: input.BankTransactionID,
							lineItemCount: lineItems.length,
						},
					)
					await updateBankTransaction(
						tokens.accessToken,
						config.tenantId,
						input.BankTransactionID,
						lineItems,
						pre.Total,
						{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
					)
					reconcileLogger.debug(
						'Successfully reconciled {txnId} via AccountCode',
						{ txnId: input.BankTransactionID },
					)
					emitEvent(ctx.eventsConfig, 'xero-reconcile-item-succeeded', {
						bankTransactionId: input.BankTransactionID,
						accountCode: input.AccountCode,
						type: 'account-code',
						durationMs: Math.round(performance.now() - itemStart),
					})

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
					processedCount += 1
					checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}

				if (input.InvoiceID) {
					reconcileLogger.debug(
						'Processing {txnId} with InvoiceID={invoiceId}',
						{ txnId: input.BankTransactionID, invoiceId: input.InvoiceID },
					)
					if (!input.Amount || !input.CurrencyCode) {
						throw new XeroApiError(
							'Invoice payments require Amount and CurrencyCode',
							{
								code: 'E_USAGE',
								recoverable: false,
							},
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
							{
								code: 'E_CONFLICT',
								recoverable: true,
							},
						)
					}
					if (invoice.CurrencyCode !== input.CurrencyCode) {
						throw new XeroApiError(
							`Invoice currency mismatch: ${input.InvoiceID}`,
							{
								code: 'E_CONFLICT',
								recoverable: true,
							},
						)
					}
					if (invoice.AmountDue < input.Amount) {
						throw new XeroApiError(
							`Invoice amount due less than input: ${input.InvoiceID}`,
							{
								code: 'E_CONFLICT',
								recoverable: true,
							},
						)
					}
					const bankTxn = bankTxnById.get(input.BankTransactionID)
					if (!bankTxn) {
						throw new XeroApiError(
							`BankTransaction not found in prefetch: ${input.BankTransactionID}`,
							{
								code: 'E_STALE_DATA',
								recoverable: true,
							},
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
					const payments = await createPayments(
						tokens.accessToken,
						config.tenantId,
						[
							{
								Invoice: { InvoiceID: input.InvoiceID },
								Account: { AccountID: bankAccountId },
								Amount: input.Amount,
								Date: bankTxn.DateString,
							},
						],
						{ eventsConfig: ctx.eventsConfig, onRetry: retryHandler },
					)
					const payment = payments[0]
					if (!payment?.PaymentID) {
						throw new XeroApiError('Payment creation failed', {
							code: 'E_RUNTIME',
							recoverable: false,
						})
					}
					reconcileLogger.debug(
						'Successfully reconciled {txnId} via InvoiceID={invoiceId}, PaymentID={paymentId}',
						{
							txnId: input.BankTransactionID,
							invoiceId: input.InvoiceID,
							paymentId: payment.PaymentID,
						},
					)
					emitEvent(ctx.eventsConfig, 'xero-reconcile-item-succeeded', {
						bankTransactionId: input.BankTransactionID,
						invoiceId: input.InvoiceID,
						paymentId: payment.PaymentID,
						type: 'invoice-payment',
						durationMs: Math.round(performance.now() - itemStart),
					})
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
					processedCount += 1
					checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}
			} catch (err) {
				if (
					(err instanceof XeroConflictError && err.code === 'E_CONFLICT') ||
					(err instanceof XeroApiError &&
						(err.code === 'E_CONFLICT' || err.status === 409))
				) {
					reconcileLogger.debug('Conflict skip for {txnId}: {error}', {
						txnId: input.BankTransactionID,
						error: err.message,
					})
					emitEvent(ctx.eventsConfig, 'xero-reconcile-item-conflict', {
						bankTransactionId: input.BankTransactionID,
						accountCode: input.AccountCode,
						invoiceId: input.InvoiceID,
						error: err.message,
						durationMs: Math.round(performance.now() - itemStart),
					})
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
					processedCount += 1
					checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				} else {
					const message = err instanceof Error ? err.message : String(err)
					reconcileLogger.warn('Failed {txnId}: {error}', {
						txnId: input.BankTransactionID,
						error: message,
					})
					emitEvent(ctx.eventsConfig, 'xero-reconcile-item-failed', {
						bankTransactionId: input.BankTransactionID,
						error: message,
						code:
							err instanceof StructuredError
								? err.code
								: err instanceof Error
									? 'E_RUNTIME'
									: 'E_RUNTIME',
						durationMs: Math.round(performance.now() - itemStart),
					})
					const result: ReconcileResult = {
						BankTransactionID: input.BankTransactionID,
						status: 'failed',
						AccountCode: input.AccountCode,
						InvoiceID: input.InvoiceID,
						error: message,
						errorCode:
							err instanceof StructuredError
								? err.code
								: err instanceof Error
									? 'E_RUNTIME'
									: 'E_RUNTIME',
					}
					results.push(result)
					if (auditWriter) {
						await auditWriter.write({
							type: 'failure',
							BankTransactionID: input.BankTransactionID,
							error: message,
						})
					}
					processedCount += 1
					checkpointId = `item-${processedCount}`
					reportResult(result)
					progress.update(processedCount, totalCount)
				}
			}
			if (interrupted) break
		}

		progress.finish()

		const summary = {
			total: results.length,
			succeeded: 0,
			failed: 0,
			skipped: 0,
			dryRun: 0,
		}
		for (const r of results) {
			if (r.status === 'reconciled') summary.succeeded += 1
			else if (r.status === 'failed') summary.failed += 1
			else if (r.status === 'skipped') summary.skipped += 1
			else if (r.status === 'dry-run') summary.dryRun += 1
		}
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

		const digestLines: string[] = []
		if (!ctx.json && !ctx.quiet && results.length > 0) {
			digestLines.push('Audit digest:')
			for (const [code, info] of byAccount.entries()) {
				digestLines.push(
					`  Account ${code}: ${info.count} (${info.total.toFixed(2)})`,
				)
			}
			for (const [type, info] of byType.entries()) {
				digestLines.push(
					`  Type ${type}: ${info.count} (${info.total.toFixed(2)})`,
				)
			}
		}

		writeSuccess(
			ctx,
			{ command: 'reconcile', summary, results, interrupted },
			[
				`Reconcile ${options.execute ? 'execute' : 'dry-run'} complete`,
				`Succeeded: ${summary.succeeded}`,
				`Failed: ${summary.failed}`,
				...digestLines,
			],
			`${summary.succeeded}`,
		)
		emitEvent(ctx.eventsConfig, 'xero-reconcile-completed', {
			executed: options.execute,
			summary,
			interrupted,
		})
		reconcileLogger.info('Reconcile run completed in {mode} mode', {
			mode: options.execute ? 'execute' : 'dry-run',
			interrupted,
			succeeded: summary.succeeded,
			failed: summary.failed,
		})
		if (interrupted) return EXIT_INTERRUPTED
		if (summary.failed > 0) return EXIT_RUNTIME
		return EXIT_OK
	} catch (err) {
		return handleCommandErrorWithContext(ctx, err, {
			stateFile,
			checkpointId,
		})
	} finally {
		process.off('SIGINT', handleSigint)
		process.off('SIGTERM', handleSigterm)
		try {
			await stateBatcher?.flush()
		} catch (err) {
			reconcileLogger.warn('Failed to flush state on finalize: {error}', {
				error: err instanceof Error ? err.message : String(err),
			})
		}
		try {
			if (auditWriter) {
				await auditWriter.close()
				reconcileLogger.debug('Audit file closed')
			}
		} catch (err) {
			reconcileLogger.warn(
				'Failed to close audit writer on finalize: {error}',
				{
					error: err instanceof Error ? err.message : String(err),
				},
			)
		}
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
