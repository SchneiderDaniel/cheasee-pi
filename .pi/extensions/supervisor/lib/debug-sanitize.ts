// ─── Debug log data sanitization (VBA god module split #2036) ───
// Split out of lib/debug.ts: strip circular references and truncate large
// strings before a record is serialized.

// Strip circular references and truncate large strings
export function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
	const seen = new WeakSet<object>();
	function sanitize(value: unknown, depth: number): unknown {
		if (depth > 5) return "[MAX_DEPTH]";
		if (value === null || value === undefined) return value;
		if (typeof value === "string") {
			return value.length > 10_000 ? value.slice(0, 10_000) + "..." : value;
		}
		if (typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "object") {
			if (seen.has(value as object)) return "[CIRCULAR]";
			seen.add(value as object);
			if (Array.isArray(value)) {
				return value.length > 100
					? value.slice(0, 100).map((v) => sanitize(v, depth + 1)) + ` [${value.length - 100} more]`
					: value.map((v) => sanitize(v, depth + 1));
			}
			const obj: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				obj[k] = sanitize(v, depth + 1);
			}
			return obj;
		}
		return String(value);
	}
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) {
		result[k] = sanitize(v, 1);
	}
	return result;
}
