// ─── Debug Logger ──────────────────────────────────────────────────
// Structured JSONL logging to /tmp/supervisor-{datetime}-{sessionId}.jsonl.
// Zero overhead when debug is disabled (no-op interface).
// Log path resolved ONCE at creation against main worktree (ctx.cwd).
// Backed by pino (https://github.com/pinojs/pino) — safe-stable-stringify
// handles circular references, depthLimit/edgeLimit, and custom serializers.

import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import pino from "pino";

// ─── Types ──────────────────────────────────────────────────────────

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	component: string;
	sessionId: string;
	message: string;
	data?: Record<string, unknown>;
}

export interface DebugLogger {
	debug(component: string, message: string, data?: Record<string, unknown>): void;
	info(component: string, message: string, data?: Record<string, unknown>): void;
	warn(component: string, message: string, data?: Record<string, unknown>): void;
	error(component: string, message: string, data?: Record<string, unknown>): void;
	child(name: string): DebugLogger;
	getSessionId(): string;
	getLogPath(): string;
}

// ─── No-Op Logger ──────────────────────────────────────────────────

const NOOP: DebugLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => NOOP,
	getSessionId: () => "",
	getLogPath: () => "",
};

// ─── Pino-backed Real Logger ───────────────────────────────────────

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

export function createDebugLogger(basePath?: string, sessionId?: string): DebugLogger {
	const sid = sessionId || `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const now = new Date();
	const dateStr = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
	const timeStr = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	const logDir = basePath || "/tmp";
	const logPath = resolvePath(logDir, `supervisor-${dateStr}-${timeStr}-${sid}.jsonl`);

	// pino destination — sync writes (preserves appendFileSync tail-call semantics),
	// mkdir creates parent directories automatically
	const transport = pino.destination({ dest: logPath, sync: true, mkdir: true });
	transport.on("error", () => {}); // silent fail — logging should never crash the pipeline

	const pinoLogger = pino(
		{
			level: "debug",
			// Replace default { pid, hostname } with just sessionId
			base: { sessionId: sid },
			// Rename pino's default "msg" key to "message" to match LogEntry
			messageKey: "message",
			// Use ISO 8601 timestamp with "timestamp" key (matching LogEntry)
			timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
			formatters: {
				// Map pino's lowercase level labels to uppercase LogLevel strings
				level(label: string) {
					return { level: label.toUpperCase() as LogLevel };
				},
			},
		},
		transport,
	);

	/** Write a log entry through the pino instance. */
	function write(
		pinoLevel: "debug" | "info" | "warn" | "error",
		component: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const context: Record<string, unknown> = { component };
		if (data !== undefined) {
			// Nest data under "data" key to match LogEntry.shape and avoid key collision
			context.data = data;
		}
		pinoLogger[pinoLevel](context, message);
	}

	/** Create a facade (root or child) sharing the same pino instance. */
	function makeFacade(prefix: string): DebugLogger {
		return {
			debug: (cmp, msg, data) =>
				write("debug", prefix ? `${prefix}.${cmp}` : cmp, msg, data),
			info: (cmp, msg, data) =>
				write("info", prefix ? `${prefix}.${cmp}` : cmp, msg, data),
			warn: (cmp, msg, data) =>
				write("warn", prefix ? `${prefix}.${cmp}` : cmp, msg, data),
			error: (cmp, msg, data) =>
				write("error", prefix ? `${prefix}.${cmp}` : cmp, msg, data),
			child: (name: string) => makeFacade(prefix ? `${prefix}.${name}` : name),
			getSessionId: () => sid,
			getLogPath: () => logPath,
		};
	}

	return makeFacade("");
}

// ─── Factory ───────────────────────────────────────────────────────

let _globalLogger: DebugLogger = NOOP;

export function getDebugLogger(): DebugLogger {
	return _globalLogger;
}

export function setDebugLogger(logger: DebugLogger): void {
	_globalLogger = logger;
}

export function resetDebugLogger(): void {
	_globalLogger = NOOP;
}

/**
 * Enable debug logging with a new logger instance.
 * Resolves log path against main worktree cwd.
 */
export function enableDebugLogger(cwd: string, sessionId?: string): DebugLogger {
	const logger = createDebugLogger("/tmp", sessionId);
	setDebugLogger(logger);
	return logger;
}

// ─── Args type (mirrors parseArgs export from pi-coding-agent v0.78.0+) ──

/** Mirrors the Args type from @earendil-works/pi-coding-agent (v0.78.0+) */
export interface SupervisorArgs {
	/** Unknown flags (potentially extension flags) — map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	/** Bare positional arguments (non-flag strings) */
	messages: string[];
}

/**
 * Parse args string into SupervisorArgs, mirroring the parseArgs API.
 * Handles --flag boolean, --flag value, and bare positional arguments.
 * When pi-coding-agent is upgraded to v0.78.0+, replace this with:
 *   import { parseArgs } from "@earendil-works/pi-coding-agent";
 */
export function parseSupervisorArgs(raw: string | undefined): {
	issueNum: number | null;
	isDebug: boolean;
} & SupervisorArgs {
	const result: {
		issueNum: number | null;
		isDebug: boolean;
		unknownFlags: Map<string, boolean | string>;
		messages: string[];
	} = {
		issueNum: null,
		isDebug: false,
		unknownFlags: new Map(),
		messages: [],
	};

	if (!raw || !raw.trim()) {
		return result;
	}

	const parts = raw.trim().split(/\s+/);

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;

		if (p === "--debug") {
			result.isDebug = true;
			result.unknownFlags.set("debug", true);
		} else if (p.startsWith("--") && p.length > 2) {
			// Strip -- prefix and check for --flag=value form
			const eqIdx = p.indexOf("=");
			if (eqIdx !== -1) {
				const flagName = p.slice(2, eqIdx);
				const flagValue = p.slice(eqIdx + 1);
				result.unknownFlags.set(flagName, flagValue);
			} else {
				// Boolean flag form: --flag
				const flagName = p.slice(2);
				// Check if next arg is a value (not starting with --)
				if (i + 1 < parts.length && !parts[i + 1]!.startsWith("--")) {
					const nextArg = parts[++i]!;
					result.unknownFlags.set(flagName, nextArg);
					// Also handle --debug specially
					if (flagName === "debug") {
						result.isDebug = true;
					}
				} else {
					result.unknownFlags.set(flagName, true);
					if (flagName === "debug") {
						result.isDebug = true;
					}
				}
			}
		} else if (/^\d+$/.test(p)) {
			result.messages.push(p);
			const num = parseInt(p, 10);
			if (!isNaN(num) && num >= 1) {
				result.issueNum = num;
			}
		} else {
			// Non-numeric, non-flag — treat as positional message
			result.messages.push(p);
		}
	}

	return result;
}
