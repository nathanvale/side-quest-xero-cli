/**
 * Build reconciliation proposals by matching statement lines against history patterns.
 *
 * Usage: bun run scripts/build-reconcile-proposals.ts
 *
 * Reads:
 *   - data/statement-lines-fy25-q4.ndjson (unreconciled statement lines)
 *   - History from xero-cli (past reconciliations with contact + account code)
 *
 * Outputs:
 *   - data/reconcile-proposals.json (categorized proposals for review)
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface StatementLine {
	statementLineId: string
	postedDate: string
	payee: string
	amount: number
	transactionDate: string
	type: string
	isReconciled: boolean
}

interface HistoryRecord {
	Contact: string
	AccountCode: string
	Count: number
	AmountMin: number
	AmountMax: number
	Type: string
}

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

// Normalize payee for fuzzy matching
function normalizePayee(payee: string): string {
	return payee
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.replace(/PTY\s*LTD/g, '')
		.replace(/\bINC\b/g, '')
		.replace(/\bLLC\b/g, '')
		.replace(/\bCORP\b/g, '')
		.replace(/\bLIMITED\b/g, '')
		.replace(/\bP\/L\b/g, '')
		.replace(/\bAU\b/g, '')
		.replace(/Card xx\d+/gi, '')
		.replace(/Value Date:\s*\d{2}\/\d{2}\/\d{4}/gi, '')
		.replace(/xx\d+/g, '')
		.replace(/NetBank/gi, '')
		.replace(/\s+/g, ' ')
		.trim()
}

// Check if normalized payee contains the contact name (or vice versa)
function fuzzyMatch(
	normalizedPayee: string,
	contact: string,
): { matches: boolean; score: number } {
	const normalizedContact = normalizePayee(contact)

	// Exact match
	if (normalizedPayee === normalizedContact) {
		return { matches: true, score: 1.0 }
	}

	// Contains match (payee contains contact or contact contains payee)
	if (normalizedPayee.includes(normalizedContact)) {
		return { matches: true, score: 0.9 }
	}
	if (normalizedContact.includes(normalizedPayee)) {
		return { matches: true, score: 0.8 }
	}

	// Word overlap
	const payeeWords = normalizedPayee.split(' ').filter((w) => w.length > 2)
	const contactWords = normalizedContact.split(' ').filter((w) => w.length > 2)
	if (payeeWords.length === 0 || contactWords.length === 0) {
		return { matches: false, score: 0 }
	}

	const matchingWords = contactWords.filter((cw) =>
		payeeWords.some((pw) => pw.includes(cw) || cw.includes(pw)),
	)
	const overlapRatio = matchingWords.length / contactWords.length

	if (overlapRatio >= 0.5 && matchingWords.length >= 1) {
		return { matches: true, score: overlapRatio * 0.7 }
	}

	return { matches: false, score: 0 }
}

// Load statement lines
const stmtLines: StatementLine[] = readFileSync(
	'data/statement-lines-fy25-q4.ndjson',
	'utf-8',
)
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line))

// Load history
const historyRaw = execSync(
	'bun run xero-cli history --since 2024-01-01 --json 2>/dev/null',
	{ encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
)
const historyData = JSON.parse(historyRaw)
const history: HistoryRecord[] = historyData.data.transactions

console.error(`Loaded ${stmtLines.length} statement lines`)
console.error(`Loaded ${history.length} history records`)

// Build proposals
const proposals: Proposal[] = []

for (const line of stmtLines) {
	const normalizedPayee = normalizePayee(line.payee)
	const direction = line.amount < 0 ? 'SPEND' : 'RECEIVE'
	const absAmount = Math.abs(line.amount)

	let bestMatch: {
		contact: string
		accountCode: string
		score: number
		reason: string
	} | null = null

	for (const h of history) {
		// Direction must match
		if (
			(direction === 'SPEND' && h.Type !== 'SPEND') ||
			(direction === 'RECEIVE' && h.Type !== 'RECEIVE')
		) {
			continue
		}

		const { matches, score } = fuzzyMatch(normalizedPayee, h.Contact)
		if (!matches) continue

		// Boost score if amount is in historical range
		let amountBoost = 0
		if (absAmount >= h.AmountMin && absAmount <= h.AmountMax) {
			amountBoost = 0.1
		}

		// Boost for higher historical count (more reliable pattern)
		const countBoost = Math.min(h.Count / 50, 0.1)

		const totalScore = score + amountBoost + countBoost

		if (!bestMatch || totalScore > bestMatch.score) {
			const reasons: string[] = []
			if (score >= 0.9) reasons.push('strong name match')
			else if (score >= 0.5) reasons.push('partial name match')
			else reasons.push('weak name match')
			if (amountBoost > 0) reasons.push('amount in range')
			if (h.Count >= 5) reasons.push(`${h.Count}x historical`)

			bestMatch = {
				contact: h.Contact,
				accountCode: h.AccountCode,
				score: totalScore,
				reason: reasons.join(', '),
			}
		}
	}

	let confidence: Proposal['matchConfidence'] = 'none'
	if (bestMatch) {
		if (bestMatch.score >= 0.8) confidence = 'high'
		else if (bestMatch.score >= 0.5) confidence = 'medium'
		else confidence = 'low'
	}

	proposals.push({
		statementLineId: line.statementLineId,
		date: line.postedDate,
		payee: line.payee,
		amount: line.amount,
		direction,
		matchedContact: bestMatch?.contact ?? null,
		matchedAccountCode: bestMatch?.accountCode ?? null,
		matchConfidence: confidence,
		matchReason: bestMatch?.reason ?? 'no match found',
	})
}

// Summary stats
const highCount = proposals.filter((p) => p.matchConfidence === 'high').length
const medCount = proposals.filter((p) => p.matchConfidence === 'medium').length
const lowCount = proposals.filter((p) => p.matchConfidence === 'low').length
const noneCount = proposals.filter((p) => p.matchConfidence === 'none').length

console.error(`\nProposal Summary:`)
console.error(`  High confidence:   ${highCount}`)
console.error(`  Medium confidence: ${medCount}`)
console.error(`  Low confidence:    ${lowCount}`)
console.error(`  No match:          ${noneCount}`)
console.error(`  Total:             ${proposals.length}`)

// Write output
const output = JSON.stringify(
	{
		generated: new Date().toISOString(),
		summary: {
			total: proposals.length,
			highCount,
			medCount,
			lowCount,
			noneCount,
		},
		proposals,
	},
	null,
	2,
)
require('node:fs').writeFileSync('data/reconcile-proposals.json', output)
console.error(`\nWritten to data/reconcile-proposals.json`)
