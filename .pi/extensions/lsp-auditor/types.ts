/**
 * LSP Auditor Type Definitions
 *
 * Pure data types and port interfaces. No imports from Node, Pi, or vscode-jsonrpc.
 * Dependency Rule inward — this module is imported by all other lsp-auditor modules.
 */

// ─── LSP Diagnostic Types ────────────────────────────────────────────

export interface LspDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning" | "Information" | "Hint";
	message: string;
}

export interface ServerMapping {
	extensions: string[];
	command: string;
	args: string[];
	severityThreshold: "error" | "warning" | "info";
}

export interface AuditResult {
	diagnostics: LspDiagnostic[];
	errors: string[];
	note: string;
}

// ─── Pre-Audit Types ─────────────────────────────────────────────────

export interface PreAuditOptions {
	issueNum: number;
	worktreePath: string;
	defaultBranch: string;
	repo: string;
}

export interface PreAuditResult {
	proceed: boolean;
	note: string;
}

// ─── Port Interfaces ─────────────────────────────────────────────────

/**
 * LspRuntime port interface — abstracts Node I/O and vscode-jsonrpc.
 *
 * Production: created by createDefaultRuntime() in lsp-client/runtime.ts
 * Test: created by createMockRuntime() in lsp-client.test.mts
 *
 * This is the injection seam that eliminates the need for
 * --experimental-test-module-mocks and mock.module().
 */
export interface LspRuntime {
	/** Spawn a child process (replaces node:child_process.spawn) */
	spawn: (
		command: string,
		args: readonly string[],
		options: Record<string, unknown>,
	) => {
		stdin: unknown;
		stdout: unknown;
		stderr: unknown;
		exitCode: number | null;
		pid?: number;
		on: (event: string, handler: (...args: unknown[]) => void) => void;
		removeAllListeners: (event?: string) => void;
		kill: (signal?: string | number) => boolean;
	};
	/** Execute a file with callback (replaces node:child_process.execFile) */
	execFile: (
		file: string,
		args: string[],
		options: Record<string, unknown>,
		callback: (err: Error | null, stdout: string, stderr: string) => void,
	) => void;
	/** Check if a file exists synchronously (replaces node:fs.existsSync) */
	existsSync: (path: string) => boolean;
	/** Read a file asynchronously (replaces node:fs/promises.readFile) */
	readFile: (path: string, encoding: string) => Promise<string>;
	/**
	 * Load vscode-jsonrpc module. Returns the module interface on success,
	 * or null if the module is unavailable.
	 */
	loadJsonRpc: () => Promise<JsonRpcModule | null>;
}

/**
 * vscode-jsonrpc module shape.
 * Returned by LspRuntime.loadJsonRpc() on success.
 */
export interface JsonRpcModule {
	StreamMessageReader: new (stream: unknown) => unknown;
	StreamMessageWriter: new (stream: unknown) => unknown;
	createMessageConnection: (reader: unknown, writer: unknown) => unknown;
}

// ─── Output Adaptation Types ──────────────────────────────────────────

/**
 * Structured diagnostic data for RPC/JSON mode output.
 * Provides a machine-parseable shape with files grouped by path.
 */
export interface StructuredDiagnostics {
	files: Array<{
		path: string;
		issues: Array<{
			line: number;
			col: number;
			severity: string;
			message: string;
		}>;
	}>;
}
