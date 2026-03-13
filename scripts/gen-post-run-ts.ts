/**
 * Generate a post-run state file from a post queue using the TS jsonSha256
 * so hashes match the CLI's validation. Usage:
 *   bun scripts/gen-post-run-ts.ts <queue> <output> <confirm-phrase>
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { jsonSha256 } from '../src/cli/commands/reconcile-post'

const queuePath = process.argv[2]
const outputPath = process.argv[3]
const confirm = process.argv[4]

if (!queuePath || !outputPath || !confirm) {
	console.error(
		'Usage: bun scripts/gen-post-run-ts.ts <queue> <output> <confirm-phrase>',
	)
	process.exit(1)
}

const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
const quarter = queue.quarter
const expectedConfirm = `WRITE ${quarter}`

if (confirm !== expectedConfirm) {
	console.error(
		JSON.stringify({
			ok: false,
			error: `confirmation phrase must be exactly "${expectedConfirm}"`,
		}),
	)
	process.exit(2)
}

const startedAt = new Date().toISOString()
const logFile = outputPath.replace(/\.json$/, '.log.ndjson')
const items: Record<string, unknown> = {}

for (const item of queue.items) {
	const sid = item.statementLineId
	const body = item.body ?? {}
	const idempotencyKey = createHash('sha256')
		.update(`${queue.queueHash}:${sid}`)
		.digest('hex')

	items[sid] = {
		statementLineId: sid,
		status: 'confirmed',
		confirmedAt: startedAt,
		idempotencyKey,
		requestHash: jsonSha256(body),
		responseCode: null,
		bankTransactionId: null,
		errorReason: null,
		postedAt: null,
		nextRetryAt: null,
		tenantPauseUntil: null,
		sameKeyRetryUntil: null,
	}
}

const state = {
	schemaVersion: 1,
	quarter,
	queueHash: queue.queueHash,
	startedAt,
	writeInterlock: confirm,
	preview: {
		rows: queue.rows ?? queue.items.length,
		approvedRows: queue.approvedRows ?? queue.items.length,
		editedRows: queue.editedRows ?? 0,
		totalAbsAmount: queue.totalAbsAmount ?? 0,
	},
	logFile,
	items,
}

writeFileSync(outputPath, JSON.stringify(state, null, 2), 'utf8')
console.log(
	JSON.stringify({
		ok: true,
		queuePath,
		outputPath,
		items: Object.keys(items).length,
		logFile,
	}),
)
