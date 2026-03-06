import { describe, expect, it } from 'vitest'
import { escapeODataValue, ODataInjectionError } from '../../src/xero/odata'

describe('escapeODataValue', () => {
	it('passes through simple alphanumeric values', () => {
		expect(escapeODataValue('REVENUE')).toBe('REVENUE')
		expect(escapeODataValue('Acme Corp')).toBe('Acme Corp')
		expect(escapeODataValue('200')).toBe('200')
	})

	it('passes through values with common punctuation', () => {
		expect(escapeODataValue('OBrien + Sons')).toBe('OBrien + Sons')
		expect(escapeODataValue('Smith-Jones Ltd.')).toBe('Smith-Jones Ltd.')
	})

	it('rejects values containing double quotes', () => {
		expect(() => escapeODataValue('foo"')).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('foo" || Status!="DELETED')).toThrow(ODataInjectionError)
	})

	it('rejects values containing logical operators', () => {
		expect(() => escapeODataValue('foo && bar')).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('foo || bar')).toThrow(ODataInjectionError)
	})

	it('rejects values containing comparison operators', () => {
		expect(() => escapeODataValue('foo==bar')).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('foo!=bar')).toThrow(ODataInjectionError)
	})

	it('rejects values containing OData logical keywords', () => {
		expect(() => escapeODataValue('foo or bar')).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('foo AND bar')).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('not foo')).toThrow(ODataInjectionError)
	})

	it('rejects values containing single quotes and parentheses', () => {
		expect(() => escapeODataValue("O'Brien")).toThrow(ODataInjectionError)
		expect(() => escapeODataValue('(foo)')).toThrow(ODataInjectionError)
	})

	it('includes the unsafe value in error context', () => {
		try {
			escapeODataValue('injected"value')
			expect.fail('should have thrown')
		} catch (err) {
			expect(err).toBeInstanceOf(ODataInjectionError)
			const odataErr = err as ODataInjectionError
			expect(odataErr.code).toBe('E_USAGE')
			expect(odataErr.context.unsafeValue).toBe('injected"value')
		}
	})

	it('rejects classic OData injection payloads', () => {
		// Attempt to break out of string and add always-true condition
		expect(() => escapeODataValue('foo" || 1==1 || Name=="bar')).toThrow(ODataInjectionError)

		// Attempt to inject additional filter clause
		expect(() => escapeODataValue('REVENUE" && Status!="DELETED')).toThrow(ODataInjectionError)
	})
})
