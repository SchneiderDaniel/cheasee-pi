/**
 * LSP client module — manages one LSP server lifecycle per audit group.
 *
 * Houses all LSP protocol interaction: spawn, connection setup, didOpen,
 * publishDiagnostics collection, shutdown. This is the only module with
 * Node I/O + external dependency (vscode-jsonrpc).
 *
 * Injection seam: setLspRuntime/resetLspRuntime for tests.
 * Tests inject a mock LspRuntime to replace Node I/O and vscode-jsonrpc,
 * eliminating the need for --experimental-test-module-mocks and mock.module().
 *
 * Fixes:
 * - C4 P1: jsonRpcModule cached inside loadJsonRpc() function scope (not module-level)
 * - P4 P2: catch (err) has instanceof Error check
 */

import {
	spawn as realSpawn,
	execFile as realExecFile,
	type ChildProcess,
} from "node:child_process";
import { existsSync as realExistsSync } from "node:fs";
import { readFile as realReadFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { MessageConnection } from "vscode-jsonrpc";
import type { LspPublishDiagnosticsParams, LspDiagnosticData } from "./lib/lsp-types.ts";
import { isLspPublishDiagnosticsParams, isLspDiagnosticData } from "./lib/lsp-types.ts";
import type { LspDiagnostic, ServerMapping, AuditResult, LspRuntime, JsonRpcModule } from "./types.ts";
import { filterBySeverity } from "./formatting.ts";

// ─── Constants ───────────────────────────────────────────────────────

/** Per-file timeout in milliseconds */
const FILE_TIMEOUT_MS = 30_000;
/** Maximum wait for publishDiagnostics notifications (30s) */
const DIAG_WAIT_TIMEOUT_MS = 30_000;

// ─── Runtime Injection Seam ──────────────────────────────────────────

/** Current injected runtime, or undefined for default (production) behavior */
let currentRuntime: LspRuntime | undefined;

/**
 * Override the default runtime with a custom LspRuntime.
 * Used by tests to inject canned implementations without module mocking.
 *
 * @param runtime - LspRuntime to use
 * @throws TypeError if runtime is undefined
 */
export function setLspRuntime(runtime: LspRuntime): void {
	if (runtime === undefined) {
		throw new TypeError("setLspRuntime requires an LspRuntime argument");
	}
	currentRuntime = runtime;
}

/**
 * Reset the injected runtime to use the default production implementation.
 * Must be called in afterEach to prevent cross-test bleed.
 */
export function resetLspRuntime(): void {
	currentRuntime = undefined;
}

/**
 * Get the current runtime — injected or default.
 */
function getRuntime(): LspRuntime {
	return currentRuntime ?? createDefaultRuntime();
}

/**
 * Create the default production LspRuntime backed by real Node modules.
 * Closure-based: each call creates an independent instance with its own
 * jsonRpcModule cache.
 */
function createDefaultRuntime(): LspRuntime {
	let jsonRpcModule: JsonRpcModule | null = null;

	return {
		spawn: (command, args, options) => realSpawn(command, args, options) as any,
		execFile: (
			file: string,
			args: string[],
			options: Record<string, unknown>,
			callback: (err: Error | null, stdout: string, stderr: string) => void,
		) => {
			realExecFile(file, args, options as Record<string, unknown>, callback);
		},
		existsSync: (path) => realExistsSync(path),
		readFile: (path, encoding) => (realReadFile as any)(path, encoding),
		loadJsonRpc: async () => {
			if (jsonRpcModule) return jsonRpcModule;
			try {
				jsonRpcModule = (await import("vscode-jsonrpc")) as unknown as JsonRpcModule;
				return jsonRpcModule;
			} catch {
				return null;
			}
		},
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Map file extension to LSP language ID */
function languageIdForExtension(ext: string): string {
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
		default:
			return ext.slice(1);
	}
}

/** Map LSP diagnostic severity number to label string */
function lspSeverityToLabel(severity: number): "Error" | "Warning" | "Information" | "Hint" {
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

/** Promise with timeout — guarded against unhandled rejections from losing promise */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	// Use a settled flag so the losing settlement is silently absorbed.
	// This prevents unhandled rejections when connection.dispose() rejects
	// a timed-out sendRequest promise (issue #247), while still propagating
	// rejections that occur before the timeout fires.
	let settled = false;
	return new Promise<T | null>((resolve, reject) => {
		promise.then(
			(val) => {
				if (!settled) {
					settled = true;
					resolve(val);
				}
			},
			(err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			},
		);
		setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(null);
			}
		}, ms);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Audit Function ──────────────────────────────────────────────────

/**
 * Audit a group of files using a single LSP server instance.
 * Spawns the server, sends didOpen for each file, collects publishDiagnostics,
 * then shuts down. Exported for integration testing.
 */
export async function auditFileGroup(
	mapping: ServerMapping,
	files: string[],
	worktreePath: string,
): Promise<AuditResult> {
	const errors: string[] = [];
	const allDiagnostics: LspDiagnostic[] = [];

	const rt = getRuntime();

	const jsonRpc = await rt.loadJsonRpc();
	if (!jsonRpc) {
		return {
			diagnostics: [],
			errors: [`vscode-jsonrpc not installed — cannot audit ${mapping.command}`],
			note: "",
		};
	}

	let child: ChildProcess | null = null;
	let connection: MessageConnection | null = null;

	try {
		// Quick pre-check: is the LSP binary available?
		// This avoids vscode-jsonrpc internals emitting ERR_STREAM_DESTROYED
		// when spawn fails with ENOENT.
		try {
			await new Promise<void>((resolve, reject) => {
				rt.execFile("which", [mapping.command], { timeout: 5_000 }, (err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		} catch {
			errors.push(`LSP server ${mapping.command} not found on PATH`);
			return { diagnostics: [], errors, note: "" };
		}

		// Spawn LSP server
		child = rt.spawn(mapping.command, mapping.args, {
			cwd: worktreePath,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		}) as unknown as ChildProcess;

		child.on("error", (err: Error) => {
			errors.push(
				`LSP server ${mapping.command} crashed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});

		// If spawn immediately failed (e.g. binary not found), handle early
		if (child.exitCode !== null && child.exitCode !== 0) {
			errors.push(`LSP server ${mapping.command} failed to start (exit ${child.exitCode})`);
			return { diagnostics: [], errors, note: "" };
		}

		// Handle destroyed streams from spawn failure
		if (child.stdin?.destroyed || child.stdout?.destroyed) {
			errors.push(`LSP server ${mapping.command} failed to start (streams destroyed)`);
			return { diagnostics: [], errors, note: "" };
		}

		const reader = new jsonRpc.StreamMessageReader(child.stdout!);
		const writer = new jsonRpc.StreamMessageWriter(child.stdin!);
		connection = jsonRpc.createMessageConnection(reader, writer) as MessageConnection;

		// Capture connection-level errors (e.g. write to destroyed stream)
		// onError emits [Error, Message | undefined, number | undefined] tuple
		connection.onError(([err]: [Error, unknown, number | undefined]) => {
			errors.push(`LSP connection error (${mapping.command}): ${err?.message || String(err)}`);
		});

		// Collect diagnostics
		const diagnosticsMap = new Map<string, LspDiagnostic[]>();
		const openedUris = new Set<string>();
		const diagnosedUris = new Set<string>();

		connection.onNotification((method: string, params: unknown) => {
			if (method === "textDocument/publishDiagnostics") {
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
			}
		});

		connection.listen();

		// Initialize
		const initResult = await withTimeout(
			connection.sendRequest("initialize", {
				processId: process.pid,
				rootUri: `file://${worktreePath}`,
				capabilities: {},
			}),
			FILE_TIMEOUT_MS,
		);

		if (!initResult) {
			errors.push(`LSP server ${mapping.command} timed out during initialize`);
			return { diagnostics: [], errors, note: "" };
		}

		// Send initialized notification — awaited to prevent unhandled promise rejection
		try {
			await connection!.sendNotification("initialized", {});
		} catch (err: unknown) {
			errors.push(
				`Failed to send initialized notification: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { diagnostics: [], errors, note: "" };
		}

		// Open each file with didOpen
		for (const file of files) {
			const fullPath = resolvePath(worktreePath, file);
			if (!rt.existsSync(fullPath)) {
				errors.push(`File not found in worktree: ${file}`);
				continue;
			}

			const content = await rt.readFile(fullPath, "utf-8");
			const langId = languageIdForExtension(file.slice(file.lastIndexOf(".")).toLowerCase());
			const uri = `file://${fullPath}`;

			// Send didOpen — awaited to prevent unhandled promise rejection.
			// openedUris.add happens only after successful send so the polling loop
			// only waits for files confirmed opened.
			try {
				await connection!.sendNotification("textDocument/didOpen", {
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
				continue;
			}
		}

		// Wait for publishDiagnostics notifications for all opened files
		const diagStartTime = Date.now();
		while (Date.now() - diagStartTime < DIAG_WAIT_TIMEOUT_MS) {
			if (openedUris.size === 0) break;
			const allDiagnosed = [...openedUris].every((uri) => diagnosedUris.has(uri));
			if (allDiagnosed) break;
			await sleep(200);
		}

		// Collect all diagnostics and filter by severity threshold
		for (const [, diags] of diagnosticsMap) {
			allDiagnostics.push(...diags);
		}

		// Apply per-server severity threshold (R3 AC3)
		const filtered = filterBySeverity(allDiagnostics, mapping.severityThreshold);

		// Shutdown
		await withTimeout(connection.sendRequest("shutdown", null), 10_000);
		// exit notification is fire-and-forget per LSP spec.
		// Catch rejection silently — the server may already have disconnected.
		connection!.sendNotification("exit", null).catch(() => {
			/* exit is fire-and-forget per LSP spec */
		});
		connection!.dispose();

		return { diagnostics: filtered, errors, note: "" };
	} catch (err: unknown) {
		// Server crash or protocol error — with instanceof Error guard (fixes P4 P2)
		errors.push(
			`LSP server ${mapping.command} error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { diagnostics: allDiagnostics, errors, note: "" };
	} finally {
		try {
			if (connection) connection.dispose();
		} catch {
			/* ignore */
		}
		try {
			if (child) {
				// Remove all error listeners to prevent async errors after cleanup
				child.removeAllListeners("error");
				if (child.stdin) child.stdin.removeAllListeners("error");
				if (child.stdout) child.stdout.removeAllListeners("error");
				if (child.stderr) child.stderr.removeAllListeners("error");
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					const childRef = child;
					const killTimer = setTimeout(() => {
						try {
							childRef.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}, 5000);
					(killTimer as any)?.unref?.();
				}
			}
		} catch {
			/* ignore */
		}
	}
}
