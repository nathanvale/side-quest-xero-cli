import { describe, expect, it } from 'bun:test'
import { parseDateParts } from '../../src/cli/commands/transactions'

describe('parseDateParts', () => {
	it('returns OData DateTime for a valid date', () => {
		expect(parseDateParts('2026-01-15')).toBe('DateTime(2026,1,15)')
	})

	it('returns OData DateTime for last day of month', () => {
		expect(parseDateParts('2026-01-31')).toBe('DateTime(2026,1,31)')
	})

	it('handles leap year Feb 29', () => {
		expect(parseDateParts('2024-02-29')).toBe('DateTime(2024,2,29)')
	})

	it('rejects month 0', () => {
		expect(() => parseDateParts('2026-00-15')).toThrow('Invalid date')
	})

	it('rejects month 13', () => {
		expect(() => parseDateParts('2026-13-01')).toThrow('month must be 1-12')
	})

	it('rejects day 0', () => {
		expect(() => parseDateParts('2026-01-00')).toThrow('Invalid date')
	})

	it('rejects Feb 30', () => {
		expect(() => parseDateParts('2026-02-30')).toThrow('day 30 does not exist in month 2')
	})

	it('rejects Feb 29 on non-leap year', () => {
		expect(() => parseDateParts('2026-02-29')).toThrow('day 29 does not exist in month 2')
	})

	it('rejects day 32', () => {
		expect(() => parseDateParts('2026-01-32')).toThrow('day 32 does not exist in month 1')
	})

	it('rejects completely invalid format', () => {
		expect(() => parseDateParts('not-a-date')).toThrow('Invalid date')
	})
})
