// ─── Line/byte mechanics for subprocess stdout/stderr ─────────────
// Synchronous split("\n") loop inside the 'data' handler — readline /
// for-await were rejected because line processing must stay in the
// data-event tick (the test harness emits data → exit → close with no
// stream-end signal). flush() runs at child 'close' to emit a trailing
// unterminated JSON line.

export const MAX_RAW_OUTPUT = 500_000;

export interface StreamProcessor {
	handleStdout(chunk: Buffer): void;
	handleStderr(chunk: Buffer): void;
	/** Emit any unterminated trailing line; safe to call once at close. */
	flush(): void;
	readonly rawStdout: string;
	readonly stderr: string;
}

export interface LineStreamOptions {
	onLine(line: string): void;
	maxRawOutput?: number;
}

export function createLineStream(opts: LineStreamOptions): StreamProcessor {
	const maxRawOutput = opts.maxRawOutput ?? MAX_RAW_OUTPUT;
	let rawStdout = "";
	let stderr = "";
	let jsonBuffer = "";

	return {
		handleStdout(chunk: Buffer) {
			const text = chunk.toString();
			// Keep the last 500K of raw stdout (implicit cap preserved).
			if (rawStdout.length + text.length > maxRawOutput) {
				const keep = maxRawOutput - text.length;
				rawStdout = rawStdout.slice(-Math.max(keep, 0)) + text;
			} else {
				rawStdout += text;
			}
			jsonBuffer += text;
			const lines = jsonBuffer.split("\n");
			jsonBuffer = lines.pop() || "";
			for (const line of lines) opts.onLine(line);
		},
		handleStderr(chunk: Buffer) {
			const text = chunk.toString();
			// Symmetric keep-last cap (was keep-first for stderr pre-split;
			// accepted trade-off — only observable past 500K of stderr).
			if (stderr.length + text.length > maxRawOutput) {
				const keep = maxRawOutput - text.length;
				stderr = stderr.slice(-Math.max(keep, 0)) + text;
			} else {
				stderr += text;
			}
		},
		flush() {
			if (jsonBuffer.trim()) opts.onLine(jsonBuffer);
			jsonBuffer = "";
		},
		get rawStdout() {
			return rawStdout;
		},
		get stderr() {
			return stderr;
		},
	};
}
