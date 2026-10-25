// ─── duplicate-code shared test builder (issue #2035 Long File split) ───
import type { JscpdClone } from "../checks/duplicate-code.ts";

function makeClone(
	override: Partial<JscpdClone> & {
		files?: Array<{ name: string; startLine: number; endLine: number }>;
	},
): JscpdClone {
	const files = override.files || [{ name: "src/a.ts", startLine: 1, endLine: 10 }];
	return {
		id: override.id || "clone-1",
		format: "typescript",
		lines: override.lines ?? 10,
		tokens: override.tokens ?? 50,
		type: override.type ?? 1,
		fragments: files.map((f) => ({
			fragment: "code fragment",
			file: f.name,
			start: f.startLine,
			end: f.endLine,
		})),
	};
}

export { makeClone };
