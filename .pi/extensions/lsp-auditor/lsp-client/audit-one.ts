/**
 * LSP client per-file worker + diagnostics translation.
 *
 * audit-one.ts holds the single-file protocol step (openFileForAudit) and
 * the publishDiagnostics collector (createDiagnosticsCollector), plus the
 * pure helpers languageIdForExtension / lspSeverityToLabel.
 *
 * No module state, no direct I/O — the runtime port (rt) and the connection
 * are passed as parameters. The orchestrator (audit-group.ts) keeps the
 * two-phase open-all-then-wait-all loop: typescript-language-server does
 * project-wide analysis, so a per-file open→collect→close sequence would
 * change what the server reports for other open files.
 */

import { resolve as resolvePath } from "node:path";
import type { MessageConnection } from "vscode-jsonrpc";
import type { LspRuntime, LspDiagnostic } from "../types.ts";
import type { LspDiagnosticData } from "../lib/lsp-types.ts";
import { fileExtension } from "../lib/file-ext.ts";
import { isLspPublishDiagnosticsParams, isLspDiagnosticData } from "../lib/lsp-types.ts";

// ─── Pure Helpers ────────────────────────────────────────────────────

/** Map file extension to LSP language ID */
export function languageIdForExtension(ext: string): string {
	switch (ext) {
		case ".ts":
			return "typescript";
		case ".tsx":
			return "typescriptreact";
		case ".js":
			return "javascript";
		case ".jsx":
			return "javascriptreact";
		case ".py":
			return "python";
		case ".rs":
			return "rust";
		case ".go":
			return "go";
		case "":
			return "";
		default:
			return ext.slice(1);
	}
}

/** Map LSP diagnostic severity number to label string */
export function lspSeverityToLabel(severity: number): "Error" | "Warning" | "Information" | "Hint" {
	switch (severity) {
		case 1:
			return "Error";
		case 2:
			return "Warning";
		case 3:
			return "Information";
		case 4:
			return "Hint";
		default:
			return "Information";
	}
}

// ─── Per-File Open ───────────────────────────────────────────────────

/**
 * Open one file in the LSP server via didOpen.
 *
 * On success the URI is added to openedUris (only after a confirmed send, so
 * the orchestrator's polling loop only waits for files actually opened).
 * Failures push a per-file error and leave the file unopened — other files
 * are still processed (per-file isolation).
 */
export async function openFileForAudit(
	rt: LspRuntime,
	connection: MessageConnection,
	file: string,
	worktreePath: string,
	openedUris: Set<string>,
	errors: string[],
): Promise<void> {
	const fullPath = resolvePath(worktreePath, file);
	if (!rt.existsSync(fullPath)) {
		errors.push(`File not found in worktree: ${file}`);
		return;
	}

	const content = await rt.readFile(fullPath, "utf-8");
	const langId = languageIdForExtension(fileExtension(file));
	if (langId === "") {
		errors.push(`Cannot determine language for file: ${file}`);
		return;
	}
	const uri = `file://${fullPath}`;

	// Send didOpen — awaited to prevent unhandled promise rejection.
	try {
		await connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: langId,
				version: 1,
				text: content,
			},
		});
		openedUris.add(uri);
	} catch (err: unknown) {
		errors.push(
			`Failed to open ${file} via didOpen: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Diagnostics Collection ──────────────────────────────────────────

/** State produced by createDiagnosticsCollector, read by the orchestrator */
export interface DiagnosticsCollector {
	/** filePath → diagnostics, last write wins per URI (server may re-publish) */
	diagnosticsMap: Map<string, LspDiagnostic[]>;
	/** URIs that have received at least one publishDiagnostics */
	diagnosedUris: Set<string>;
}

/**
 * Register the publishDiagnostics star-handler on the connection.
 *
 * Decodes the URI to a file path, filters to well-formed LSP diagnostic
 * shapes, maps to the auditor's LspDiagnostic (0-based → 1-based line/column,
 * severity number → label, empty message preserved), and stores with
 * last-write-wins semantics so repeat publishes for the same URI replace,
 * not duplicate, entries.
 */
export function createDiagnosticsCollector(connection: MessageConnection): DiagnosticsCollector {
	const diagnosticsMap = new Map<string, LspDiagnostic[]>();
	const diagnosedUris = new Set<string>();

	connection.onNotification((method: string, params: unknown) => {
		if (method !== "textDocument/publishDiagnostics") return;
		if (!isLspPublishDiagnosticsParams(params)) return;
		const uri: string = params.uri;
		let filePath: string;
		try {
			filePath = decodeURIComponent(uri.replace(/^file:\/\//, ""));
		} catch {
			filePath = uri.replace(/^file:\/\//, "");
		}
		diagnosedUris.add(uri);
		const diags: LspDiagnosticData[] = params.diagnostics.filter(isLspDiagnosticData);
		const mapped: LspDiagnostic[] = diags.map((d) => ({
			file: filePath,
			line: (d.range?.start?.line ?? 0) + 1, // LSP lines are 0-based
			column: (d.range?.start?.character ?? 0) + 1,
			severity: lspSeverityToLabel(d.severity ?? 1),
			message: d.message || "",
		}));
		diagnosticsMap.set(filePath, mapped);
	});

	return { diagnosticsMap, diagnosedUris };
}
