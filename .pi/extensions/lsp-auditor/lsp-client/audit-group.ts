/**
 * LSP client orchestrator — one LSP server lifecycle per audit group.
 *
 * audit-group.ts runs the use-case narrative at a single level of
 * abstraction: preflight → spawn → connect → initialize → open all files →
 * wait for diagnostics → shutdown. Each step is a private function; the
 * per-file protocol work and diagnostics translation live in audit-one.ts,
 * the runtime port + timing primitives in runtime.ts.
 *
 * This module owns the two timeout constants (single source — both usages
 * live here) and the pre-flight checks that run once per group, not per file.
 *
 * Fixes:
 * - P4 P2: catch (err) has instanceof Error check
 */

import type { ChildProcess } from "node:child_process";
import type { MessageConnection } from "vscode-jsonrpc";
import type {
	LspDiagnostic,
	ServerMapping,
	AuditResult,
	JsonRpcModule,
	LspRuntime,
} from "../types.ts";
import { filterBySeverity } from "../formatting.ts";
import { getRuntime, withTimeout, sleep } from "./runtime.ts";
import { openFileForAudit, createDiagnosticsCollector } from "./audit-one.ts";

// ─── Constants ───────────────────────────────────────────────────────

/** Per-file timeout in milliseconds */
export const FILE_TIMEOUT_MS = 30_000;
/** Maximum wait for publishDiagnostics notifications (30s) */
export const DIAG_WAIT_TIMEOUT_MS = 30_000;

// ─── Orchestrator ────────────────────────────────────────────────────

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

	// Quick pre-check: is the LSP binary available?
	// This avoids vscode-jsonrpc internals emitting ERR_STREAM_DESTROYED
	// when spawn fails with ENOENT. Runs once per group, not per file.
	const preflightError = await preflightCheck(rt, mapping.command);
	if (preflightError) {
		errors.push(preflightError);
		return { diagnostics: [], errors, note: "" };
	}

	let child: ChildProcess | null = null;
	let connection: MessageConnection | null = null;

	try {
		// Spawn LSP server
		const spawned = spawnServer(rt, mapping, worktreePath, errors);
		child = spawned.child;
		if (spawned.error) {
			errors.push(spawned.error);
			return { diagnostics: [], errors, note: "" };
		}

		connection = createConnection(jsonRpc, child, mapping, errors);

		// Collect diagnostics: register the handler and listen before
		// initialize so no publishDiagnostics is missed.
		const collector = createDiagnosticsCollector(connection);
		connection.listen();

		if (!(await initializeServer(connection, mapping, worktreePath, errors))) {
			return { diagnostics: [], errors, note: "" };
		}

		// Open each file with didOpen (phase 1: open ALL files first)
		const openedUris = new Set<string>();
		for (const file of files) {
			await openFileForAudit(rt, connection, file, worktreePath, openedUris, errors);
		}

		// Wait for publishDiagnostics notifications for all opened files
		// (phase 2: then wait — project-wide analysis means per-file
		// open→wait→next would change what the server reports).
		await waitForDiagnostics(openedUris, collector.diagnosedUris);

		// Collect all diagnostics and filter by severity threshold
		for (const [, diags] of collector.diagnosticsMap) {
			allDiagnostics.push(...diags);
		}

		// Apply per-server severity threshold (R3 AC3)
		const filtered = filterBySeverity(allDiagnostics, mapping.severityThreshold);

		// Shutdown
		await shutdownServer(connection);

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
			terminateChild(child);
		} catch {
			/* ignore */
		}
	}
}

// ─── Private Steps ───────────────────────────────────────────────────

/**
 * Pre-flight check: verify the LSP binary is on PATH via `which`.
 * Returns an error string on failure, null on success.
 */
async function preflightCheck(rt: LspRuntime, command: string): Promise<string | null> {
	try {
		await new Promise<void>((resolve, reject) => {
			rt.execFile("which", [command], { timeout: 5_000 }, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return null;
	} catch {
		return `LSP server ${command} not found on PATH`;
	}
}

/**
 * Spawn the LSP server process and attach the crash error listener.
 * Returns the child (always, for cleanup) plus an error string when the
 * spawn visibly failed (non-zero exitCode or destroyed stdio streams).
 */
function spawnServer(
	rt: LspRuntime,
	mapping: ServerMapping,
	worktreePath: string,
	errors: string[],
): { child: ChildProcess; error: string | null } {
	const child = rt.spawn(mapping.command, mapping.args, {
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
		return {
			child,
			error: `LSP server ${mapping.command} failed to start (exit ${child.exitCode})`,
		};
	}

	// Handle destroyed streams from spawn failure
	if (child.stdin?.destroyed || child.stdout?.destroyed) {
		return { child, error: `LSP server ${mapping.command} failed to start (streams destroyed)` };
	}

	return { child, error: null };
}

/**
 * Create the JSON-RPC connection over the child's stdio and register the
 * connection-level error handler (onError emits an
 * [Error, Message | undefined, number | undefined] tuple).
 */
function createConnection(
	jsonRpc: JsonRpcModule,
	child: ChildProcess,
	mapping: ServerMapping,
	errors: string[],
): MessageConnection {
	const reader = new jsonRpc.StreamMessageReader(child.stdout!);
	const writer = new jsonRpc.StreamMessageWriter(child.stdin!);
	const connection = jsonRpc.createMessageConnection(reader, writer) as MessageConnection;

	connection.onError(([err]: [Error, unknown, number | undefined]) => {
		errors.push(`LSP connection error (${mapping.command}): ${err?.message || String(err)}`);
	});

	return connection;
}

/**
 * Initialize the server: send `initialize` with a per-file timeout, then the
 * `initialized` notification (awaited to prevent unhandled rejection).
 * Returns false on timeout or notification failure (caller early-returns).
 */
async function initializeServer(
	connection: MessageConnection,
	mapping: ServerMapping,
	worktreePath: string,
	errors: string[],
): Promise<boolean> {
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
		return false;
	}

	try {
		await connection.sendNotification("initialized", {});
	} catch (err: unknown) {
		errors.push(
			`Failed to send initialized notification: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Poll for publishDiagnostics: 200ms sleep × DIAG_WAIT_TIMEOUT_MS, exiting
 * early once every opened URI has been diagnosed (or nothing was opened).
 */
async function waitForDiagnostics(
	openedUris: Set<string>,
	diagnosedUris: Set<string>,
): Promise<void> {
	const diagStartTime = Date.now();
	while (Date.now() - diagStartTime < DIAG_WAIT_TIMEOUT_MS) {
		if (openedUris.size === 0) break;
		const allDiagnosed = [...openedUris].every((uri) => diagnosedUris.has(uri));
		if (allDiagnosed) break;
		await sleep(200);
	}
}

/**
 * Shutdown per LSP spec: await `shutdown`, then fire-and-forget `exit`
 * (rejection caught silently — the server may already have disconnected),
 * then dispose the connection.
 */
async function shutdownServer(connection: MessageConnection): Promise<void> {
	await withTimeout(connection.sendRequest("shutdown", null), 10_000);
	// exit notification is fire-and-forget per LSP spec.
	connection.sendNotification("exit", null).catch(() => {
		/* exit is fire-and-forget per LSP spec */
	});
	connection.dispose();
}

/**
 * Clean up the child process: detach error listeners (prevents async errors
 * after cleanup), then SIGTERM with a 5s escalation to SIGKILL if still
 * running.
 */
function terminateChild(child: ChildProcess | null): void {
	if (!child) return;
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
