import { existsSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { getLogContext } from './logging'

interface EventEnvelope {
	readonly name: string
	readonly schemaVersion: number
	readonly timestamp: string
	readonly payload: Record<string, unknown>
}

export interface EventsConfig {
	readonly url: string | null
}

const EVENTS_TIMEOUT_MS = 1500
const EVENTS_MAX_ATTEMPTS = 2
const EVENTS_RETRY_DELAY_MS = 200
function warnEventDeliveryFailure(message: string): void {
	try {
		writeSync(2, `[xero-events] ${message}\n`)
	} catch {
		// Best-effort warning only.
	}
}

function normalizeEventsUrl(raw: string | null | undefined): string | null {
	if (!raw) return null
	try {
		const parsed = new URL(raw)
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
		return parsed.toString()
	} catch {
		return null
	}
}

function resolvePortFileUrl(): string | null {
	const portFile = path.join(
		homedir(),
		'.cache',
		'side-quest-observability',
		'events.port',
	)
	if (!existsSync(portFile)) return null
	try {
		const raw = readFileSync(portFile, 'utf8').trim()
		if (!raw) return null
		const port = Number(raw)
		if (!Number.isFinite(port) || port <= 0) return null
		return `http://127.0.0.1:${port}`
	} catch {
		return null
	}
}

export function resolveEventsConfig(flags?: {
	readonly eventsUrl?: string | null
}): EventsConfig {
	if (process.env.XERO_EVENTS === '0') return { url: null }
	const fromFlag = normalizeEventsUrl(flags?.eventsUrl)
	if (fromFlag) return { url: fromFlag }
	const fromEnv = normalizeEventsUrl(process.env.XERO_EVENTS_URL)
	if (fromEnv) return { url: fromEnv }
	// Keep tests deterministic by avoiding implicit local port discovery.
	if (process.env.NODE_ENV === 'test') return { url: null }
	const portUrl = resolvePortFileUrl()
	if (portUrl) return { url: normalizeEventsUrl(portUrl) }
	return { url: null }
}

/** Emit an event to the observability server (fire-and-forget). */
export function emitEvent(
	config: EventsConfig,
	name: string,
	payload: Record<string, unknown>,
): void {
	if (!config.url) return

	const context = getLogContext()
	const envelope: EventEnvelope = {
		name,
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		payload: context ? { ...payload, runId: context.runId } : payload,
	}

	const endpoint = new URL(`/events/${name}`, config.url)
	void (async () => {
		for (let attempt = 1; attempt <= EVENTS_MAX_ATTEMPTS; attempt += 1) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(envelope),
					signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
				})
				if (!response.ok) {
					if (attempt >= EVENTS_MAX_ATTEMPTS) {
						warnEventDeliveryFailure(
							`failed to deliver '${name}' after ${EVENTS_MAX_ATTEMPTS} attempts (status ${response.status})`,
						)
						return
					}
					await new Promise((resolve) =>
						setTimeout(resolve, EVENTS_RETRY_DELAY_MS),
					)
					continue
				}
				return
			} catch (err) {
				if (attempt >= EVENTS_MAX_ATTEMPTS) {
					warnEventDeliveryFailure(
						`failed to deliver '${name}' after ${EVENTS_MAX_ATTEMPTS} attempts (${
							err instanceof Error ? err.message : String(err)
						})`,
					)
					return
				}
				await new Promise((resolve) =>
					setTimeout(resolve, EVENTS_RETRY_DELAY_MS),
				)
			}
		}
	})()
}
