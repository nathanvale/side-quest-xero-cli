import type { BankTransactionRecord } from '../types'

/**
 * Summarize transactions for human-readable overview output.
 *
 * The command handler decides when to show the summary; this transformer only
 * derives the grouped facts so it stays reusable and testable.
 */
export function summarizeTransactions(
	transactions: BankTransactionRecord[],
): string[] {
	const totalsByType = new Map<string, { count: number; total: number }>()
	const totalsByMonth = new Map<string, number>()
	const totalsByContact = new Map<string, number>()

	for (const txn of transactions) {
		const type = txn.Type ?? 'UNKNOWN'
		const amount = txn.Total ?? 0
		const current = totalsByType.get(type) ?? { count: 0, total: 0 }
		current.count += 1
		current.total += amount
		totalsByType.set(type, current)

		const dateRaw = txn.DateString ?? txn.Date ?? ''
		const month = dateRaw.slice(0, 7)
		if (month) {
			totalsByMonth.set(month, (totalsByMonth.get(month) ?? 0) + 1)
		}

		const contact = txn.Contact?.Name ?? 'Unknown'
		totalsByContact.set(contact, (totalsByContact.get(contact) ?? 0) + 1)
	}

	const typeLine = Array.from(totalsByType.entries())
		.map(
			([type, stats]) => `${type}: ${stats.count} (${stats.total.toFixed(2)})`,
		)
		.join(' | ')

	const monthLine = Array.from(totalsByMonth.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([month, count]) => `${month}: ${count}`)
		.join(' | ')

	const topContacts = Array.from(totalsByContact.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([name, count]) => `${name} (${count}x)`)
		.join(' | ')

	return [
		`By Type: ${typeLine}`,
		`By Month: ${monthLine}`,
		`Top 5: ${topContacts}`,
	]
}
