import type { BankTransactionRecord } from '../types'

export interface HistoryRow {
	readonly Contact: string
	readonly AccountCode: string
	readonly Count: number
	readonly AmountMin: number
	readonly AmountMax: number
	readonly Type: string
	readonly CurrencyCode: string
	readonly MostRecentDate: string
	readonly ExampleTransactionIDs: string[]
}

/**
 * Collapse reconciled transactions into contact/account patterns.
 *
 * History grouping is domain logic, not command wiring, so it lives in the
 * reusable transform layer.
 */
export function groupHistory(
	transactions: BankTransactionRecord[],
): HistoryRow[] {
	const groups = new Map<string, HistoryRow>()

	for (const txn of transactions) {
		const contact = txn.Contact?.Name ?? 'Unknown'
		const accountCode = txn.LineItems?.[0]?.AccountCode ?? 'UNKNOWN'
		const key = `${contact}::${accountCode}`
		const amount = txn.Total ?? 0
		const date = txn.DateString ?? ''
		const type = txn.Type ?? 'UNKNOWN'
		const currency = txn.CurrencyCode ?? 'UNKNOWN'
		const existing = groups.get(key)

		if (!existing) {
			groups.set(key, {
				Contact: contact,
				AccountCode: accountCode,
				Count: 1,
				AmountMin: amount,
				AmountMax: amount,
				Type: type,
				CurrencyCode: currency,
				MostRecentDate: date,
				ExampleTransactionIDs: txn.BankTransactionID
					? [txn.BankTransactionID]
					: [],
			})
			continue
		}

		groups.set(key, {
			...existing,
			Count: existing.Count + 1,
			AmountMin: Math.min(existing.AmountMin, amount),
			AmountMax: Math.max(existing.AmountMax, amount),
			MostRecentDate:
				date && date > existing.MostRecentDate ? date : existing.MostRecentDate,
			ExampleTransactionIDs:
				existing.ExampleTransactionIDs.length < 3 && txn.BankTransactionID
					? [...existing.ExampleTransactionIDs, txn.BankTransactionID]
					: existing.ExampleTransactionIDs,
		})
	}

	return Array.from(groups.values())
}
