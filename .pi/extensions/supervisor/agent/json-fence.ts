// ─── Markdown fence scan ────────────────────────────────────────
// Collect the contents of every ```/```json fence, string-boundary aware so
// triple backticks inside JSON string values (markdown in a commentBody) never
// close the outer fence. Split out of last-json-scanner.ts (issue #2033).

import { stepStringState } from "./json-string-state.ts";

/** Contents of each code fence, in document order. */
export function extractFenceContents(text: string): string[] {
	const fenceContents: string[] = [];
	let pos = 0;
	while (pos < text.length) {
		// Find opening ``` (optionally followed by "json")
		const fenceStart = text.indexOf("```", pos);
		if (fenceStart === -1) break;

		// Skip past optional language tag and newline
		let afterOpen = fenceStart + 3;
		if (text.startsWith("json", afterOpen)) {
			afterOpen += 4;
		}
		// Skip whitespace/newline after opening fence
		while (
			afterOpen < text.length &&
			(text[afterOpen] === " " ||
				text[afterOpen] === "\t" ||
				text[afterOpen] === "\n" ||
				text[afterOpen] === "\r")
		) {
			afterOpen++;
		}

		// Scan for closing ``` — string-boundary aware
		// We look for ``` that is NOT inside a JSON string value.
		let stringState = { inString: false, escaped: false };
		let fenceEnd = -1;
		for (let i = afterOpen; i < text.length; i++) {
			const ch = text[i];
			const step = stepStringState(ch, stringState);
			stringState = step.state;
			if (step.role !== "plain" || stringState.inString) continue;
			if (ch === "`" && text.startsWith("```", i)) {
				fenceEnd = i;
				break;
			}
		}

		if (fenceEnd !== -1) {
			fenceContents.push(text.slice(afterOpen, fenceEnd).trim());
			pos = fenceEnd + 3;
		} else {
			// Unclosed fence — skip past the opening
			pos = afterOpen;
		}
	}
	return fenceContents;
}
