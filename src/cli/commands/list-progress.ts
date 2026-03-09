import type { EventsConfig } from '../../events'
import { emitEvent } from '../../events'

/**
 * Emit lightweight pagination progress so agents can observe long-running list
 * commands without waiting for the final completion event.
 */
export function emitListPageFetched(
	eventsConfig: EventsConfig,
	command: string,
	page: number,
	pageSize: number,
	totalSoFar: number,
): void {
	emitEvent(eventsConfig, 'xero-list-page-fetched', {
		command,
		page,
		pageSize,
		totalSoFar,
	})
}
