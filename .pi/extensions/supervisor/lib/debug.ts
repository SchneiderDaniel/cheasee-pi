// ─── Debug Logger ──────────────────────────────────────────────────
// Structured JSONL logging to /tmp/supervisor-{datetime}-{sessionId}.jsonl.
// Zero overhead when debug is disabled (no-op interface).
// Log path resolved ONCE at creation against main worktree (ctx.cwd).

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
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

// ─── Real Logger ───────────────────────────────────────────────────

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

function formatTimestamp(date: Date): string {
	const Y = date.getFullYear();
	const M = pad2(date.getMonth() + 1);
	const D = pad2(date.getDate());
	const h = pad2(date.getHours());
	const m = pad2(date.getMinutes());
	const s = pad2(date.getSeconds());
	return `${Y}-${M}-${D}T${h}:${m}:${s}.${String(date.getMilliseconds()).padStart(3, "0")}Z`;
}

export function createDebugLogger(basePath?: string, sessionId?: string): DebugLogger {
	const sid = sessionId || `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const now = new Date();
	const dateStr = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
	const timeStr = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	const logDir = basePath || "/tmp";
	const logPath = resolvePath(logDir, `supervisor-${dateStr}-${timeStr}-${sid}.jsonl`);

	// Ensure /tmp exists
	if (!existsSync(logDir)) {
		try {
			mkdirSync(logDir, { recursive: true });
		} catch {
			// fall through — let appendFileSync fail later
		}
	}

	function write(
		level: LogLevel,
		component: string,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const entry: LogEntry = {
			timestamp: formatTimestamp(new Date()),
			level,
			component,
			sessionId: sid,
			message,
		};
		if (data !== undefined) {
			entry.data = sanitizeData(data);
		}
		try {
			appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
		} catch {
			// silent fail — logging should never crash the pipeline
		}
	}

	// Strip circular references and truncate large strings
	function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
		const seen = new WeakSet<object>();
		function sanitize(value: unknown, depth: number): unknown {
			if (depth > 5) return "[MAX_DEPTH]";
			if (value === null || value === undefined) return value;
			if (typeof value === "string") {
				return value.length > 10_000 ? value.slice(0, 10_000) + "..." : value;
			}
			if (typeof value === "number" || typeof value === "boolean") return value;
			if (typeof value === "object") {
				if (seen.has(value as object)) return "[CIRCULAR]";
				seen.add(value as object);
				if (Array.isArray(value)) {
					return value.length > 100
						? value.slice(0, 100).map((v) => sanitize(v, depth + 1)) +
								` [${value.length - 100} more]`
						: value.map((v) => sanitize(v, depth + 1));
				}
				const obj: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
					obj[k] = sanitize(v, depth + 1);
				}
				return obj;
			}
			return String(value);
		}
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) {
			result[k] = sanitize(v, 1);
		}
		return result;
	}

	function child(name: string): DebugLogger {
		const prefix = name;
		return {
			debug: (cmp, msg, data) => write("DEBUG", `${prefix}.${cmp}`, msg, data),
			info: (cmp, msg, data) => write("INFO", `${prefix}.${cmp}`, msg, data),
			warn: (cmp, msg, data) => write("WARN", `${prefix}.${cmp}`, msg, data),
			error: (cmp, msg, data) => write("ERROR", `${prefix}.${cmp}`, msg, data),
			child: (n: string) => child(`${prefix}.${n}`),
			getSessionId: () => sid,
			getLogPath: () => logPath,
		};
	}

	return {
		debug: (cmp, msg, data) => write("DEBUG", cmp, msg, data),
		info: (cmp, msg, data) => write("INFO", cmp, msg, data),
		warn: (cmp, msg, data) => write("WARN", cmp, msg, data),
		error: (cmp, msg, data) => write("ERROR", cmp, msg, data),
		child,
		getSessionId: () => sid,
		getLogPath: () => logPath,
	};
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
