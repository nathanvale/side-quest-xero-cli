import { XeroApiError } from './errors'

/**
 * Parse a YYYY-MM-DD string into a Xero OData DateTime literal.
 *
 * Validates that the parts form a real calendar date (e.g. rejects
 * month 13, Feb 30, etc.) by round-tripping through a Date object.
 */
export function parseDateParts(date: string): string {
	const [year, month, day] = date.split('-').map((part) => Number(part))
	if (!year || !month || !day) {
		throw new XeroApiError(`Invalid date: ${date}`, {
			code: 'E_USAGE',
			recoverable: false,
		})
	}
	if (month < 1 || month > 12) {
		throw new XeroApiError(`Invalid date: ${date} (month must be 1-12)`, {
			code: 'E_USAGE',
			recoverable: false,
		})
	}
	const parsed = new Date(Date.UTC(year, month - 1, day))
	if (
		parsed.getUTCFullYear() !== year ||
		parsed.getUTCMonth() !== month - 1 ||
		parsed.getUTCDate() !== day
	) {
		throw new XeroApiError(
			`Invalid date: ${date} (day ${day} does not exist in month ${month})`,
			{
				code: 'E_USAGE',
				recoverable: false,
			},
		)
	}
	return `DateTime(${year},${month},${day})`
}
