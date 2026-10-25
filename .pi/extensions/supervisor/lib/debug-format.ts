// ─── Debug logger timestamp formatting (VBA god module split #2036) ───
// Split out of lib/debug.ts so the logger factory stays under the ceiling.

export function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

export function formatTimestamp(date: Date): string {
	const Y = date.getFullYear();
	const M = pad2(date.getMonth() + 1);
	const D = pad2(date.getDate());
	const h = pad2(date.getHours());
	const m = pad2(date.getMinutes());
	const s = pad2(date.getSeconds());
	return `${Y}-${M}-${D}T${h}:${m}:${s}.${String(date.getMilliseconds()).padStart(3, "0")}Z`;
}
