/**
 * Instrumentation — placeholder for OpenTelemetry / metrics.
 * Exports a factory function. Real implementation added in future issue.
 */

export function createInstrumenter(): {
	recordMetric: (name: string, value: number) => void;
	shutdown: () => void;
} {
	return {
		recordMetric: (_name: string, _value: number) => {},
		shutdown: () => {},
	};
}
