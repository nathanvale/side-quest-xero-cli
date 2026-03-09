/**
 * Resolve an Australian-style calendar quarter date range for list commands.
 *
 * Keeping this in the library layer lets commands reuse the same quarter logic
 * without re-embedding date math in each handler.
 */
export function resolveQuarterRange(
	kind: 'this' | 'last',
	now: Date = new Date(),
): { since: string; until: string } {
	const year = now.getFullYear()
	const quarter = Math.floor(now.getMonth() / 3)
	const targetQuarter = kind === 'this' ? quarter : quarter - 1
	const targetYear = targetQuarter < 0 ? year - 1 : year
	const quarterIndex = (targetQuarter + 4) % 4
	const startMonth = quarterIndex * 3
	const start = new Date(Date.UTC(targetYear, startMonth, 1))
	const end = new Date(Date.UTC(targetYear, startMonth + 3, 0))

	return {
		since: start.toISOString().slice(0, 10),
		until: end.toISOString().slice(0, 10),
	}
}
