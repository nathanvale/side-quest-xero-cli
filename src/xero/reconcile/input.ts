import { existsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { type EventsConfig, emitEvent } from '../../events'
import { StructuredError, XeroApiError } from '../errors'
import {
	MAX_STDIN_BYTES,
	ReconcileArraySchema,
	type ReconcileCommand,
	type ReconcileInputBase,
} from './types'

function ensureNoDuplicates(inputs: ReconcileInputBase[]): string[] {
	const seen = new Set<string>()
	const duplicates: string[] = []
	for (const item of inputs) {
		if (seen.has(item.BankTransactionID))
			duplicates.push(item.BankTransactionID)
		else seen.add(item.BankTransactionID)
	}
	return duplicates
}

export function validateInputs(inputs: unknown): ReconcileInputBase[] {
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
		} else if (ch === '"') {
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

	fields.push(current.trim())
	return fields
}

/**
 * Validate that a CSV path stays within the working directory and is not a
 * symlink escape.
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
	}
}

interface CsvLoadResult {
	readonly inputs: ReconcileInputBase[]
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

	const header = parseCsvLine(lines[0] as string)
	if (!header.includes('BankTransactionID')) {
		throw new XeroApiError('CSV missing required column: BankTransactionID', {
			code: 'E_USAGE',
			recoverable: false,
		})
	}

	const inputs: unknown[] = []
	let usedFallbackColumn = false
	for (const line of lines.slice(1)) {
		const values = parseCsvLine(line)
		const record: Record<string, string> = {}
		header.forEach((key, index) => {
			record[key] = values[index] ?? ''
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

/**
 * Load reconcile input from either stdin JSON or a machine-generated CSV file.
 * Emits import events so both humans and agents can trace the source.
 */
export async function loadReconcileInputs(
	eventsConfig: EventsConfig,
	options: ReconcileCommand,
): Promise<ReconcileInputBase[]> {
	if (!options.fromCsv) {
		return parseJsonInput(await readStdinWithLimit())
	}

	await validateCsvPath(options.fromCsv)
	if (!existsSync(options.fromCsv)) {
		throw new XeroApiError('CSV file not found', {
			code: 'E_USAGE',
			recoverable: false,
		})
	}

	try {
		const csvResult = await loadCsv(options.fromCsv)
		emitEvent(eventsConfig, 'xero-csv-imported', {
			rowCount: csvResult.inputs.length,
			source: 'file',
			usedFallbackColumn: csvResult.usedFallbackColumn,
		})
		return csvResult.inputs
	} catch (err) {
		emitEvent(eventsConfig, 'xero-csv-import-failed', {
			error: err instanceof Error ? err.message : String(err),
			source: 'file',
		})
		throw err
	}
}
