import { describe, expect, it } from 'bun:test'
import {
	assertValidBankTransactionResponse,
	assertValidPaymentResponse,
} from '../../src/cli/commands/reconcile'

describe('assertValidBankTransactionResponse', () => {
	it('throws on missing BankTransactionID', () => {
		expect(() => assertValidBankTransactionResponse({ BankTransactions: [{} as never] })).toThrow()
	})

	it('throws on HasErrors true', () => {
		expect(() =>
			assertValidBankTransactionResponse({
				BankTransactions: [{ BankTransactionID: 'tx-1', HasErrors: true }],
			}),
		).toThrow()
	})

	it('throws on HasValidationErrors true', () => {
		expect(() =>
			assertValidBankTransactionResponse({
				BankTransactions: [{ BankTransactionID: 'tx-1', HasValidationErrors: true }],
			}),
		).toThrow()
	})

	it('throws on StatusAttributeString ERROR', () => {
		expect(() =>
			assertValidBankTransactionResponse({
				BankTransactions: [{ BankTransactionID: 'tx-1', StatusAttributeString: 'ERROR' }],
			}),
		).toThrow()
	})

	it('throws on total mismatch', () => {
		expect(() =>
			assertValidBankTransactionResponse(
				{ BankTransactions: [{ BankTransactionID: 'tx-1', Total: 10 }] },
				{ expectedTotal: 12 },
			),
		).toThrow()
	})

	it('throws on non-object input', () => {
		expect(() => assertValidBankTransactionResponse(null as unknown as never)).toThrow()
	})
})

describe('assertValidPaymentResponse', () => {
	it('throws on missing PaymentID', () => {
		expect(() => assertValidPaymentResponse({ Amount: 10 })).toThrow()
	})

	it('throws on missing Amount', () => {
		expect(() => assertValidPaymentResponse({ PaymentID: 'pay-1' })).toThrow()
	})

	it('throws on StatusAttributeString ERROR', () => {
		expect(() =>
			assertValidPaymentResponse({
				PaymentID: 'pay-1',
				Amount: 10,
				StatusAttributeString: 'ERROR',
			}),
		).toThrow()
	})

	it('throws on HasValidationErrors true', () => {
		expect(() =>
			assertValidPaymentResponse({
				PaymentID: 'pay-1',
				Amount: 10,
				HasValidationErrors: true,
			}),
		).toThrow()
	})

	it('throws on non-object input', () => {
		expect(() => assertValidPaymentResponse(null as unknown as never)).toThrow()
	})
})
