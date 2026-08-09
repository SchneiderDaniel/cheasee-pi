// ─── Render Helpers ──────────────────────────────────────────────
// TUI rendering primitives used across multiple renderers.
// Separated from lib/formatting.ts to avoid coupling pure string
// formatting with TUI component dependencies (Container, Text, etc.).

import { Text, Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Container } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
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
import { getBuiltinToolLabels } from "./tool-line.ts";

/**
 * Render a thinking block (markdown content with thinkingText color + italic styling)
 * to match Pi's native assistant message thinking rendering.
 *
 * Creates a `Markdown` child with a `DefaultTextStyle` that applies `thinkingText`
 * color and italic styling, identical to how Pi's `assistant-message.js` renders
 * thinking traces.
 *
 * @param container - The TUI container to add children to (mutated in place)
 * @param text      - The thinking content (markdown-formatted text)
 * @param theme     - Theme object with a `fg` method matching TUI conventions
 */
export function renderThinkingBlock(
	container: Container,
	text: string,
	theme: { fg: (color: string, text: string) => string },
): void {
	const mdTheme = getMarkdownTheme();
	container.addChild(
		new Markdown(text, 1, 1, mdTheme, {
			color: (t: string) => theme.fg("thinkingText", t),
			italic: true,
		}),
	);
}

/**
 * Render a list of text lines into a container, skipping empty/whitespace-only lines.
 *
 * Each non-empty line is styled with `theme.fg("dim", line)` and wrapped to `width`
 * columns via `wrapTextWithAnsi`. Every wrapped segment is added as a `Text` child.
 *
 * @param container - The TUI container to add children to (mutated in place)
 * @param lines     - Pre-split lines of text (caller owns split/truncation decisions)
 * @param theme     - Theme object with a `fg` method matching TUI conventions
 * @param width     - Maximum column width for text wrapping
 */
export function renderTextLines(
	container: Container,
	lines: string[],
	theme: { fg: (color: string, text: string) => string },
	width: number,
): void {
	for (const line of lines) {
		if (!line.trim()) continue;
		const styled = theme.fg("dim", line);
		for (const wrapped of wrapTextWithAnsi(styled, width)) {
			container.addChild(new Text(wrapped, 1, 0));
		}
	}
}

// ─── Tool Call Rendering ────────────────────────────────────────
// Delegates to pi's native renderCall for built-in tools, with a
// JSON-preview fallback for extension tools (ripgrep_search, etc.).
// Single source of truth for tool-call line formatting.

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

// ponytail: permissive type — each factory returns a full ToolDefinition with
// typed renderCall. We only need the runtime dispatch, so cast at the boundary.
const toolDefFactories: Record<string, (cwd: string) => { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } }> = {
	bash: (cwd: string) => createBashToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	read: (cwd: string) => createReadToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	edit: (cwd: string) => createEditToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	write: (cwd: string) => createWriteToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	grep: (cwd: string) => createGrepToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	find: (cwd: string) => createFindToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
	ls: (cwd: string) => createLsToolDefinition(cwd) as unknown as { renderCall?: (...args: unknown[]) => { render: (width: number) => string[] } },
};

const EXTENSION_TOOL_NAMES = new Set([
	"ripgrep_search",
	"web_search",
	"web_crawl",
	"structural_search",
	"ask_user",
]);

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
// Lazy-init guard: pi's formatBashCall uses a global theme singleton that must be initialized.
let _themeInitialized = false;
function ensureTheme(): void {
	if (!_themeInitialized) {
		initTheme();
		_themeInitialized = true;
	}
}

export function renderToolCallText(name: string, args: unknown, cwd: string): string {
	ensureTheme();
	// Extension tools: JSON-preview fallback (no native pi renderCall)
	if (EXTENSION_TOOL_NAMES.has(name)) {
		return formatJsonPreview(name, args);
	}

	// Built-in tools: delegate to pi's renderCall
	const factory = toolDefFactories[name];
	if (factory) {
		const def = factory(cwd);
		if (def.renderCall) {
			const component = def.renderCall(
				args ?? {},
				identityTheme,
				makeRenderContext(cwd),
			);
			// Render at large width to avoid wrapping, then strip ANSI.
			// Different tool renderCalls return different component types
			// (Text, Container, Box, etc.), so we use the shared render() API.
			const rendered = component.render(10000);
			const text = rendered
				.map((l: string) => l.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "").trim())
				.filter(Boolean)
				.join("\n");
			return text || "";
		}
	}

	// Generic fallback for unknown tools
	return formatJsonPreview(name, args);
}

// Re-export for consumers that import from render-helpers.ts (backward compat)
export { getBuiltinToolLabels } from "./tool-line.ts";

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


