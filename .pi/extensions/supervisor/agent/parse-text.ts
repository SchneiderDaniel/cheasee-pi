// ─── Text normalization ─────────────────────────────────────────
// Raw text helpers the parser needs before any JSON work: ANSI stripping and
// the literal `\n` / `\r` sequences that survive JSON.parse.

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// Normalize literal \\n / \\r sequences that survived JSON.parse into real newlines.
// Agents often produce \\n (double-escaped) in JSON string values.
export function normalizeEscapes(s: string): string {
	return s.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}
