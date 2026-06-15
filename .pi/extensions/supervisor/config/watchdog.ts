/**
 * Watchdog — placeholder for agent lifecycle monitoring.
 * Exports a factory function. Real implementation added in future issue.
 */

export function createWatchdog(): {
	feed: () => void;
	stop: () => void;
} {
	return {
		feed: () => {},
		stop: () => {},
	};
}
