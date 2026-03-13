import { readFileSync } from 'node:fs'
import { jsonSha256 } from '../src/cli/commands/reconcile-post'

const queuePath = process.argv[2]
const postRunPath = process.argv[3]

const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
const postRun = JSON.parse(readFileSync(postRunPath, 'utf8'))

for (const item of queue.items) {
	const sid = item.statementLineId
	const body = item.body ?? null
	const computedHash = jsonSha256(body)
	const storedHash = postRun.items[sid]?.requestHash ?? 'MISSING'
	const match = computedHash === storedHash ? 'OK' : 'MISMATCH'
	console.log(
		JSON.stringify(
			{
				statementLineId: sid,
				match,
				computedHash: computedHash.slice(0, 16),
				storedHash: storedHash.slice(0, 16),
			},
			null,
			2,
		),
	)
}
