/**
 * protocol.ts — stdout framing contract shared by the Python producer and the
 * TypeScript consumer.
 *
 * The search payload is framed with ASCII RS (0x1E, U+001E), a control
 * character that JSON string escaping never emits raw. Search content
 * (titles/snippets copied verbatim from DuckDuckGo) therefore cannot forge the
 * delimiter — unlike the former `SEARCH_OK` / `SEARCH_DONE` ASCII sentinels,
 * which any result containing the literal token could fake (issue #1729).
 *
 * Wire contract: `<FRAME><json><FRAME>\n`. Bytes before the opening frame
 * (logger noise) and after the closing frame are ignored.
 */

/** ASCII Record Separator — the sole framing code point, unforgeable in-band. */
export const FRAME = "\x1e";

/**
 * Extract the JSON payload from framed stdout.
 * Returns the trimmed text between the first and the next FRAME, or null when
 * the frame is absent or unterminated.
 */
export function parseFramedOutput(stdout: string): string | null {
	const start = stdout.indexOf(FRAME);
	if (start === -1) return null;
	const end = stdout.indexOf(FRAME, start + FRAME.length);
	if (end === -1) return null;
	const inner = stdout.slice(start + FRAME.length, end).trim();
	return inner || null;
}
