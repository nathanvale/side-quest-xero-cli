/**
 * Summarize reconcile proposals grouped by confidence level.
 * Usage: bun run scripts/summarize-proposals.ts
 */

import { readFileSync } from 'node:fs'

interface Proposal {
	statementLineId: string
	date: string
	payee: string
	amount: number
	direction: 'SPEND' | 'RECEIVE'
	matchedContact: string | null
	matchedAccountCode: string | null
	matchConfidence: 'high' | 'medium' | 'low' | 'none'
	matchReason: string
}

const data = JSON.parse(readFileSync('data/reconcile-proposals.json', 'utf-8'))
const proposals: Proposal[] = data.proposals

// Group by confidence
const groups: Record<string, Proposal[]> = {
	high: [],
	medium: [],
	low: [],
	none: [],
}
for (const p of proposals) {
	groups[p.matchConfidence].push(p)
}

// Show high confidence grouped by account code
console.log('=== HIGH CONFIDENCE (auto-reconcile candidates) ===')
const byAccount: Record<string, Proposal[]> = {}
for (const p of groups.high) {
	const key = `${p.matchedAccountCode} (${p.matchedContact})`
	if (!byAccount[key]) byAccount[key] = []
	byAccount[key].push(p)
}
const sortedAccounts = Object.entries(byAccount).sort(
	(a, b) => b[1].length - a[1].length,
)
for (const [key, items] of sortedAccounts) {
	const total = items.reduce((s, p) => s + p.amount, 0)
	console.log(`  ${key}: ${items.length} txns, total $${total.toFixed(2)}`)
}

console.log('\n=== MEDIUM CONFIDENCE (review needed) ===')
for (const p of groups.medium) {
	console.log(
		`  ${p.date} | $${p.amount.toFixed(2).padStart(10)} | ${p.payee.substring(0, 50).padEnd(50)} -> ${p.matchedAccountCode} (${p.matchedContact}) [${p.matchReason}]`,
	)
}

console.log('\n=== LOW CONFIDENCE (manual review) ===')
for (const p of groups.low) {
	console.log(
		`  ${p.date} | $${p.amount.toFixed(2).padStart(10)} | ${p.payee.substring(0, 50).padEnd(50)} -> ${p.matchedAccountCode} (${p.matchedContact}) [${p.matchReason}]`,
	)
}

console.log('\n=== NO MATCH (manual categorization needed) ===')
for (const p of groups.none) {
	console.log(
		`  ${p.date} | $${p.amount.toFixed(2).padStart(10)} | ${p.payee.substring(0, 60)}`,
	)
}
