// ─── Comment body noise stripping ───────────────────────────────
// The line filters the extractor applies to a candidate body, and the
// transcript-contamination test. Split out of output.ts (issue #2033).

import { isToolLine } from "../lib/tool-line.ts";

/** Drop metadata, tool-call, reasoning and NDJSON noise lines. */
export function stripNoise(text: string, toolNames?: Set<string>): string {
	const METADATA_LINE_RE = /^[\u{1F527}\u{2713}\u{2717}\u{1F4CB}\u{1F4CA}\u{1F4AD}]/u;
	const REASONING_LINE_RE =
		/^(Now (let me|I|we)|Let me|I need to|I'll|First,? let me|I should|I think|I'm going|Let's|Here's my|My approach|I will)/i;
	const NDJSON_LINE_RE = /^\{\s*"(?:type|role)"\s*:/;
	const MESSAGES_LINE_RE = /^\{\s*"messages"\s*:\s*\[/;
	return text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return true;
			if (METADATA_LINE_RE.test(trimmed)) return false;
			if (isToolLine(trimmed, toolNames)) return false;
			if (REASONING_LINE_RE.test(trimmed)) return false;
			if (NDJSON_LINE_RE.test(trimmed)) return false;
			if (MESSAGES_LINE_RE.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

/** Two or more NDJSON records in one body means the extractor grabbed the transcript. */
export function isContaminated(text: string): boolean {
	const ndjsonPattern = /\{\s*"(?:type|role|messages)"\s*[:\[]/g;
	const matches = text.match(ndjsonPattern);
	if (!matches) return false;
	return matches.length >= 2;
}
