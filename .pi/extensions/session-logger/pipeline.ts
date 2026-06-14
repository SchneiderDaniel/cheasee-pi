/**
 * pipeline.ts — LoggerPipeline class for session-logger
 *
 * Encapsulates session lifecycle, model/thinking/turn/tool event handling
 * and report generation. Extracted from index.ts for testability.
 *
 * index.ts remains the wiring layer: command registration + gate management.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { createSessionStats } from "./stats.ts";
import { createFileOps } from "./files.ts";
import type { FileOps } from "./files.ts";
import { generateMissingReports } from "./report.ts";
import type { SessionLoggerGate } from "./types.ts";

/**
 * LoggerPipeline — handles session lifecycle and tool execution tracking.
 *
 * Instantiated once per extension load. All event handlers delegate to
 * pipeline methods, keeping index.ts focused on wiring.
 */
export class LoggerPipeline {
	private gate: SessionLoggerGate;
	private stats: ReturnType<typeof createSessionStats>;
	private files: FileOps;
	private sessionFile: string | undefined;
	private sessionsDir: string | undefined;
	private sessionName: string | undefined;
	private mode: string | undefined;

	constructor(gate: SessionLoggerGate) {
		this.gate = gate;
		this.stats = createSessionStats();
		this.files = createFileOps();
	}

	/** Expose stats for testing / snapshot access. */
	getStats(): ReturnType<typeof createSessionStats> {
		return this.stats;
	}

	/** Expose files for testing. */
	getFiles(): FileOps {
		return this.files;
	}

	/** Expose current session file path for testing. */
	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/** Expose sessions directory for testing. */
	getSessionsDir(): string | undefined {
		return this.sessionsDir;
	}

	/** Expose session name for testing / override passing. */
	getSessionName(): string | undefined {
		return this.sessionName;
	}

	/** Expose session mode for testing / override passing. */
	getMode(): string | undefined {
		return this.mode;
	}

	// ── Session lifecycle ──

	async onSessionStart(
		event: unknown,
		ctx: {
			sessionManager: {
				getSessionFile(): string | undefined;
				getCwd(): string;
				getEntries(): any[];
			};
		},
		overrides?: { sessionName?: string; mode?: string },
	): Promise<void> {
		if (!beginSession(this.gate)) return;

		if (overrides) {
			this.sessionName = overrides.sessionName;
			this.mode = overrides.mode;
		}

		const sm = ctx.sessionManager;
		this.sessionFile = sm.getSessionFile();
		if (!this.sessionFile) return;

		this.stats.reset();
		this.stats.seedStats(sm);

		this.sessionsDir = path.resolve(sm.getCwd(), ".pi", "sessions");
		await this.files.ensureSymlink(this.sessionFile!, this.sessionsDir);

		// Recovery: scan all .jsonl files in sessions dir for missing .md/.metadata.json.
		// If session_shutdown didn't fire (crash, kill, race), we catch up now.
		if (this.sessionsDir && fs.existsSync(this.sessionsDir)) {
			this.recoverPastSessions();
		}
	}

	async onSessionShutdown(
		_event: unknown,
		ctx: { sessionManager: { getSessionFile(): string | undefined } },
	): Promise<void> {
		if (!this.gate.sessionEnabled) return;

		const sm = ctx.sessionManager;
		const sf = sm.getSessionFile();
		if (!sf) return;

		// Capture in-memory tool execution timing before shutdown.
		const snapshot = this.stats.getSnapshot();

		const overrides: { sessionName?: string; mode?: string } = {};
		if (this.sessionName) overrides.sessionName = this.sessionName;
		if (this.mode !== undefined) overrides.mode = this.mode;

		try {
			await generateMissingReports(
				sf,
				this.files,
				snapshot,
				Object.keys(overrides).length > 0 ? overrides : undefined,
			);
		} catch (err) {
			console.error(`[session-logger] Shutdown handler failed: ${(err as Error).message}`);
		}
	}

	onSessionCompact(): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.incrementCompaction();
	}

	// ── Model / thinking changes ──

	onModelSelect(event: { model: { provider: string; id: string } }): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.modelChange(event.model.provider, event.model.id);
	}

	onThinkingLevelSelect(event: { level: string }): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.thinkingChange(event.level);
	}

	// ── Turn lifecycle ──

	onTurnStart(event: { turnIndex: number }): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.recordTurnStart(event.turnIndex);
	}

	onTurnEnd(): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.recordTurnEnd();
	}

	// ── Message tracking ──

	onMessageEnd(event: { message: { role: string; usage?: any } }): void {
		if (!this.gate.sessionEnabled) return;
		if (event.message.role === "assistant") this.stats.addUsage(event.message.usage);
	}

	// ── Tool execution lifecycle ──

	onToolExecutionStart(event: { toolCallId: string; toolName: string }): void {
		if (!this.gate.sessionEnabled) return;
		this.stats.recordToolStart(event.toolCallId, event.toolName);
	}

	onToolExecutionEnd(event: {
		toolCallId: string;
		result?: { content?: Array<{ type: string; text?: string }> };
		isError?: boolean;
	}): void {
		if (!this.gate.sessionEnabled) return;
		// Calculate result size from content
		const content = event.result?.content ?? [];
		let size = 0;
		for (const c of content) {
			if (c.type === "text") size += c.text?.length ?? 0;
		}
		this.stats.recordToolEnd(event.toolCallId, event.isError ?? false, size);
	}

	// ── File modification tracking via tool_call interception ──

	onToolCall(event: { toolName: string; input: Record<string, unknown> }): void {
		if (!this.gate.sessionEnabled) return;

		const input = event.input as { path?: string; content?: { length?: number } };
		const filePath = input.path ?? "";
		if (event.toolName === "read") {
			this.stats.recordFileModification("read", filePath);
		} else if (event.toolName === "write") {
			this.stats.recordFileModification("write", filePath, input.content?.length ?? 0);
		} else if (event.toolName === "edit") {
			this.stats.recordFileModification("edit", filePath);
		}
	}

	// ── Recovery ──

	private recoverPastSessions(): void {
		if (!this.sessionsDir || !this.sessionFile) return;

		let jsonlFiles: string[] = [];
		try {
			jsonlFiles = fs
				.readdirSync(this.sessionsDir)
				.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));
		} catch {
			return;
		}

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(this.sessionsDir!, file);

			// Skip current in-progress session — file may be incomplete
			if (this.sessionFile && jsonlPath === this.sessionFile) continue;

			// Defer to next tick — don't block session start
			Promise.resolve().then(() =>
				generateMissingReports(jsonlPath, this.files).catch((err) => {
					console.error(`[session-logger] Recovery failed for ${file}: ${(err as Error).message}`);
				}),
			);
		}
	}
}

/**
 * Begin session logging: copy enabledForNextSession → sessionEnabled.
 * Returns the new sessionEnabled value.
 */
export function beginSession(gate: SessionLoggerGate): boolean {
	gate.sessionEnabled = gate.enabledForNextSession;
	return gate.sessionEnabled;
}
