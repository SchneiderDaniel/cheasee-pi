// ─── Tool-call plain-text formatting (issue #2098) ───────────────
// The plain-text tool-call line, extracted from render-helpers.ts so the TUI
// primitives there stop dragging pi's seven tool factories into every
// consumer. Consumed by event/adapter (chat log lines) and tests.
//
// Still imports the pi tool factories: delegating to pi's own `renderCall` is
// the whole point (formatting must match pi's native renderer).

import {
	createBashToolDefinition,
	createReadToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	initTheme,
} from "@earendil-works/pi-coding-agent";

/** Theme stub that returns text unchanged (no ANSI codes emitted). */
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	bg: (_color: string, text: string) => text,
};

/** Minimal render context for getting plain-text output from renderCall. */
function makeRenderContext(cwd: string): Record<string, unknown> {
	return {
		args: {},
		toolCallId: "",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

/** The only method `renderToolCallText` needs from a pi tool definition. */
type RenderCall = (...args: unknown[]) => { render: (width: number) => string[] };

// pi's factories each return a differently-typed ToolDefinition (different
// input schema and render state). Only the runtime `renderCall` dispatch is
// needed here, so the table stores untyped factories and the cast happens once
// at the dispatch site instead of once per entry.
const toolDefFactories: Record<string, (cwd: string) => unknown> = {
	bash: createBashToolDefinition,
	read: createReadToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

const EXTENSION_TOOL_NAMES = new Set([
	"ripgrep_search",
	"web_search",
	"web_crawl",
	"structural_search",
	"ask_user",
]);

// Lazy-init guard: pi's formatBashCall uses a global theme singleton that must
// be initialized once before the first render.
let _themeInitialized = false;
function ensureTheme(): void {
	if (!_themeInitialized) {
		initTheme();
		_themeInitialized = true;
	}
}

/** Format args as JSON preview clipped to fit ≤80 total chars. */
function formatJsonPreview(name: string, args: unknown): string {
	let preview: string;
	try {
		preview = JSON.stringify(args);
	} catch {
		preview = String(args);
	}
	const prefix = `${name}: `;
	const maxPreviewLen = Math.max(10, 80 - prefix.length - 3); // leave room for "..."
	if (preview.length > maxPreviewLen) {
		preview = preview.slice(0, maxPreviewLen) + "...";
	}
	return `${prefix}${preview}`;
}

/**
 * Render a tool call as plain text, matching pi's native renderer format.
 *
 * For built-in tools (read, bash, edit, write, grep, find, ls), delegates
 * to pi's `renderCall` via `createXxxToolDefinition`. For extension tools
 * without a native pi definition, returns a JSON-preview fallback.
 *
 * @param name - Tool name (e.g. "bash", "read", "ripgrep_search")
 * @param args - Tool call arguments
 * @param cwd  - Working directory for relative-path display
 * @returns Plain-text tool-call line as pi would render it
 */
export function renderToolCallText(name: string, args: unknown, cwd: string): string {
	ensureTheme();
	// Extension tools: JSON-preview fallback (no native pi renderCall)
	if (EXTENSION_TOOL_NAMES.has(name)) {
		return formatJsonPreview(name, args);
	}

	// Built-in tools: delegate to pi's renderCall
	const factory = toolDefFactories[name];
	if (factory) {
		const toolDef = factory(cwd) as { renderCall?: RenderCall };
		if (toolDef.renderCall) {
			const component = toolDef.renderCall(args ?? {}, identityTheme, makeRenderContext(cwd));
			// Render at large width to avoid wrapping, then strip ANSI.
			// Different tool renderCalls return different component types
			// (Text, Container, Box, etc.), so we use the shared render() API.
			const rendered = component.render(10000);
			const text = rendered
				.map((l: string) =>
					l
						.replace(
							/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
							"",
						)
						.trim(),
				)
				.filter(Boolean)
				.join("\n");
			return text || "";
		}
	}

	// Generic fallback for unknown tools
	return formatJsonPreview(name, args);
}
