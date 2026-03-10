import { z } from 'zod'
import type { OutputContext } from '../../cli/output'
import { xeroFetch } from '../api'
import { loadValidTokens } from '../auth'
import { XeroApiError } from '../errors'
import type {
	BankTransactionRecord,
	BankTransactionsResponse,
	LineItemRecord,
} from '../types'
import { BankTransactionsResponseSchema } from '../types'
import type { RetryInfo } from './types'

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

interface ReconcileApiOptions {
	readonly eventsConfig: OutputContext['eventsConfig']
	readonly onRetry?: (info: RetryInfo) => void
}

export async function fetchUnreconciledSnapshot(
	accessToken: string,
	tenantId: string,
	options: ReconcileApiOptions,
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

export async function fetchActiveAccountCodes(
	accessToken: string,
	tenantId: string,
	options: ReconcileApiOptions,
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

export async function fetchBankTransactionsBatch(
	accessToken: string,
	tenantId: string,
	ids: string[],
	options: ReconcileApiOptions,
): Promise<Map<string, BankTransactionRecord>> {
	const byId = new Map<string, BankTransactionRecord>()
	if (ids.length === 0) return byId

	const chunkSize = 50
	for (let index = 0; index < ids.length; index += chunkSize) {
		const batch = ids.slice(index, index + chunkSize)
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
			if (txn.BankTransactionID) byId.set(txn.BankTransactionID, txn)
		}
	}

	return byId
}

export async function updateBankTransaction(
	accessToken: string,
	tenantId: string,
	transactionId: string,
	lineItems: LineItemRecord[],
	expectedTotal: number | undefined,
	options: ReconcileApiOptions,
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
	return assertValidBankTransactionResponse(response, { expectedTotal })
}

/** Create one BankTransaction and return the validated created record. */
export async function createBankTransaction(
	accessToken: string,
	tenantId: string,
	bankTransaction: Record<string, unknown>,
	options: ReconcileApiOptions & { readonly idempotencyKey?: string },
): Promise<BankTransactionRecord> {
	const response = await xeroFetch<BankTransactionsResponse>(
		'/BankTransactions',
		{
			method: 'POST',
			body: JSON.stringify({
				BankTransactions: [bankTransaction],
			}),
			headers: options.idempotencyKey
				? {
						'Idempotency-Key': options.idempotencyKey,
					}
				: undefined,
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
	return assertValidBankTransactionResponse(response)
}

export async function fetchInvoicesById(
	accessToken: string,
	tenantId: string,
	ids: string[],
	options: ReconcileApiOptions,
): Promise<Map<string, InvoicesResponse['Invoices'][number]>> {
	const byId = new Map<string, InvoicesResponse['Invoices'][number]>()
	const chunkSize = 50

	for (let index = 0; index < ids.length; index += chunkSize) {
		const batch = ids.slice(index, index + chunkSize)
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

export async function createPaymentsBatch(
	accessToken: string,
	tenantId: string,
	payments: Record<string, unknown>[],
	options: ReconcileApiOptions,
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
	for (const payment of list) assertValidPaymentResponse(payment)
	return list
}
