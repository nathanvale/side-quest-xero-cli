/**
 * Escape a user-supplied string for safe interpolation into a Xero OData
 * `where` clause. Xero uses double-quoted string literals in its OData
 * dialect, so the primary risk is unescaped double quotes allowing an
 * attacker to break out of the string context and inject additional filter
 * operators.
 *
 * This function:
 * - Rejects values containing double quotes (`"`), which would allow
 *   breaking out of the OData string literal boundary.
 * - Rejects values containing logical operators (`&&`, `||`) that could
 *   append additional filter clauses.
 * - Rejects values containing comparison operators (`==`, `!=`) that
 *   could introduce new field comparisons.
 *
 * Rather than silently escaping (which could mask bugs or attacks), we
 * throw so the caller can surface a clear validation error to the user.
 */
export function escapeODataValue(value: string): string {
	// Double quotes would break out of the OData string literal
	if (value.includes('"')) {
		throw new ODataInjectionError(
			`Invalid filter value: contains double quote character`,
			value,
		)
	}
	// Logical operators could append extra filter clauses
	if (value.includes('&&') || value.includes('||')) {
		throw new ODataInjectionError(
			`Invalid filter value: contains logical operator`,
			value,
		)
	}
	// Comparison operators could introduce new field comparisons
	if (value.includes('==') || value.includes('!=')) {
		throw new ODataInjectionError(
			`Invalid filter value: contains comparison operator`,
			value,
		)
	}
	// Single quotes and parentheses can alter OData expression semantics
	if (value.includes("'") || value.includes('(') || value.includes(')')) {
		throw new ODataInjectionError(
			`Invalid filter value: contains unsafe punctuation`,
			value,
		)
	}
	// OData keywords are blocked to prevent expression injection attempts.
	if (/\b(or|and|not)\b/i.test(value)) {
		throw new ODataInjectionError(
			`Invalid filter value: contains OData keyword`,
			value,
		)
	}
	return value
}

/** Thrown when a user-supplied value contains OData-unsafe characters. */
export class ODataInjectionError extends Error {
	readonly code = 'E_USAGE'
	override readonly name = 'ODataInjectionError'
	readonly context: { unsafeValue: string }

	constructor(message: string, unsafeValue: string) {
		super(message)
		this.context = { unsafeValue }
	}
}
