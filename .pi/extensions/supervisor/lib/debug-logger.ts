// ─── Debug logger factory (VBA god module split #2036) ───
// Split out of lib/debug.ts. Structured JSONL logging to
// /tmp/supervisor-{datetime}-{sessionId}.jsonl. The `DebugLogger` interface
// stays canonical in debug.ts; this module only owns construction.

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import type { DebugLogger } from "./debug.ts";
import { pad2, formatTimestamp } from "./debug-format.ts";
import { sanitizeData } from "./debug-sanitize.ts";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogEntry {
	timestamp: string;
	level: LogLevel;
	component: string;
	sessionId: string;
	message: string;
	data?: Record<string, unknown>;
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

	function writeLogRecord(
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

	function makeLogger(prefix: string): DebugLogger {
		const tagged = (component: string): string => (prefix ? `${prefix}.${component}` : component);
		return {
			debug: (cmp, msg, data) => writeLogRecord("DEBUG", tagged(cmp), msg, data),
			info: (cmp, msg, data) => writeLogRecord("INFO", tagged(cmp), msg, data),
			warn: (cmp, msg, data) => writeLogRecord("WARN", tagged(cmp), msg, data),
			error: (cmp, msg, data) => writeLogRecord("ERROR", tagged(cmp), msg, data),
			child: (name: string) => makeLogger(prefix ? `${prefix}.${name}` : name),
			getSessionId: () => sid,
			getLogPath: () => logPath,
		};
	}

	return makeLogger("");
}
