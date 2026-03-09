import { z } from 'zod'

export const MAX_STDIN_BYTES = 5 * 1024 * 1024
export const AUDIT_DIR = '.xero-reconcile-runs'
export const AUDIT_MODE = 0o600
export const AUDIT_DIR_MODE = 0o700
export const UUID_SHAPE =
	/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/
export const ACCOUNT_CODE_SHAPE = /^[A-Za-z0-9]{1,10}$/

export interface ReconcileCommand {
	readonly command: 'reconcile'
	readonly execute: boolean
	readonly fromCsv: string | null
}

export interface ReconcileInputBase {
	readonly BankTransactionID: string
	readonly AccountCode?: string
	readonly InvoiceID?: string
	readonly Amount?: number
	readonly CurrencyCode?: string
}

export interface ReconcileResult {
	readonly BankTransactionID: string
	readonly status: 'reconciled' | 'skipped' | 'failed' | 'dry-run'
	readonly AccountCode?: string
	readonly InvoiceID?: string
	readonly PaymentID?: string
	readonly error?: string
	readonly errorCode?: string
}

export interface ReconcileSummary {
	total: number
	succeeded: number
	failed: number
	skipped: number
	dryRun: number
}

export interface RetryInfo {
	readonly reason: 'rate-limit' | 'server-error' | 'timeout'
	readonly backoffMs: number
	readonly status?: number
}

export interface RuntimeCheckpointState {
	checkpointId: string
}

/**
 * Canonical reconcile input schema shared by the CLI, tests, and skill docs.
 * Keeping the schema in a dedicated module makes the contract easier to reuse.
 */
export const ReconcileItemSchema = z
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

export const ReconcileArraySchema = z
	.array(ReconcileItemSchema)
	.min(1)
	.max(1000)
