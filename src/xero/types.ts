import { z } from 'zod'

/**
 * Canonical Xero BankTransaction types.
 *
 * These are the single source of truth for bank transaction shapes returned
 * by the Xero API. Commands that need a narrower view should use Pick<> or
 * Omit<> rather than redefining the type locally.
 *
 * All fields are optional except where the Xero API guarantees presence
 * (e.g. BankTransactionID is always present in single-record responses
 * but may be absent in list responses).
 */

/** A single line item within a bank transaction. */
export interface LineItemRecord {
	readonly Description?: string
	readonly Quantity?: number
	readonly UnitAmount?: number
	readonly TaxType?: string
	readonly TaxAmount?: number
	readonly LineAmount?: number
	readonly AccountCode?: string
}

/**
 * A bank transaction record as returned by the Xero BankTransactions API.
 *
 * This is the canonical superset of all fields used across the codebase.
 * Individual commands should use Pick<BankTransactionRecord, ...> when they
 * only need a subset.
 */
export interface BankTransactionRecord {
	readonly BankTransactionID?: string
	readonly Type?: string
	readonly Date?: string
	readonly DateString?: string
	readonly Total?: number
	readonly Contact?: { Name?: string }
	readonly Reference?: string
	readonly CurrencyCode?: string
	readonly LineItems?: LineItemRecord[]
	readonly BankAccount?: { AccountID?: string }
	readonly HasValidationErrors?: boolean
	readonly StatusAttributeString?: string
	readonly HasErrors?: boolean
}

/** Response wrapper for the Xero BankTransactions endpoint. */
export interface BankTransactionsResponse {
	readonly BankTransactions: BankTransactionRecord[]
}

/** Runtime schema for a single bank transaction record. */
export const BankTransactionRecordSchema = z.object({
	BankTransactionID: z.string().optional(),
	Type: z.string().optional(),
	Date: z.string().optional(),
	DateString: z.string().optional(),
	Total: z.number().optional(),
	Contact: z.object({ Name: z.string().optional() }).optional(),
	Reference: z.string().optional(),
	CurrencyCode: z.string().optional(),
	LineItems: z
		.array(
			z.object({
				Description: z.string().optional(),
				Quantity: z.number().optional(),
				UnitAmount: z.number().optional(),
				TaxType: z.string().optional(),
				TaxAmount: z.number().optional(),
				LineAmount: z.number().optional(),
				AccountCode: z.string().optional(),
			}),
		)
		.optional(),
	BankAccount: z.object({ AccountID: z.string().optional() }).optional(),
	HasValidationErrors: z.boolean().optional(),
	StatusAttributeString: z.string().optional(),
	HasErrors: z.boolean().optional(),
})

/** Runtime schema for Xero bank transactions endpoint wrapper. */
export const BankTransactionsResponseSchema = z.object({
	BankTransactions: z.array(BankTransactionRecordSchema),
})
