/**
 * ask-user — QuestionHandler class
 *
 * Encapsulates the ask_user tool execute logic (freetext and choice modes).
 * Extracted from index.ts to reduce duplication across mode branches and to
 * enable unit testing without full pi dispatch.
 *
 * Dependencies:
 *   - ctx.ui.input() / ctx.ui.custom() / ctx.ui.notify() for UI
 *   - appendQnaEntry() from jsonl-logger.ts for persistence
 *
 * No fs coupling. No migration logic — that's the caller's responsibility.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendQnaEntry } from "./jsonl-logger.ts";
import { renderScrollableDialog } from "./question-ui.ts";
import type { LabelValuePair, OptionItem } from "./types.ts";

// ---------------------------------------------------------------------------
// Local parameter interface (avoids coupling to TypeBox schema from types.ts)
// ---------------------------------------------------------------------------

/** Shape of parameters accepted by the QuestionHandler. */
interface QuestionHandlerParams {
	mode?: "choice" | "freetext";
	question: string;
	options?: OptionItem[];
	disableOther?: boolean;
}

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type ExecuteResponse = Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}>;

// ---------------------------------------------------------------------------
// QuestionHandler
// ---------------------------------------------------------------------------

export class QuestionHandler {
	private projectDir: string;
	private ctx: ExtensionContext;
	private mode: string;

	constructor(projectDir: string, ctx: ExtensionContext) {
		this.projectDir = projectDir;
		this.ctx = ctx;
		this.mode = (ctx as unknown as { mode?: string }).mode ?? "tui";
	}

	/**
	 * Handle a question based on its mode.
	 *
	 * "freetext" → open-ended text input via ctx.ui.input()
	 * "choice" (default) → multiple-choice selection via ctx.ui.custom()
	 */
	async handle(params: QuestionHandlerParams): ExecuteResponse {
		const { question } = params;

		switch (params.mode) {
			case "freetext":
				return this.handleFreetext(question);
			default:
				return this.handleChoice(params);
		}
	}

	// -----------------------------------------------------------------------
	// Freetext mode
	// -----------------------------------------------------------------------

	private async handleFreetext(question: string): ExecuteResponse {
		// In JSON/print mode, return cancel immediately — no interactive UI
		if (this.mode === "json" || this.mode === "print") {
			return this.cancelResponse();
		}

		// TUI and RPC modes both support ctx.ui.input()
		const answer = await this.ctx.ui.input(question, "");
		if (answer === undefined || answer.trim() === "") {
			return this.cancelResponse();
		}

		const trimmedAnswer = answer.trim();
		await this.logAnswer(question, trimmedAnswer);

		return {
			content: [
				{
					type: "text" as const,
					text: `User answered: "${trimmedAnswer}"`,
				},
			],
			details: { format: "qna-result-v1", answer: trimmedAnswer },
		};
	}

	// -----------------------------------------------------------------------
	// Choice mode
	// -----------------------------------------------------------------------

	private async handleChoice(params: QuestionHandlerParams): ExecuteResponse {
		const { question, disableOther } = params;
		const options = params.options ?? [];

		// Build SelectItems. Map labels back to values after selection.
		const labelToValue: LabelValuePair[] = [];
		const items: Array<{ value: string; label: string }> = [];

		for (let i = 0; i < options.length; i++) {
			const opt = options[i]!;
			const suffix = opt.recommended ? " (Recommended)" : "";
			const label = `${i + 1}. ${opt.label}${suffix}`;
			labelToValue.push({ label, value: opt.value });
			items.push({ value: label, label });
		}

		let otherLabel = "";
		if (!disableOther) {
			otherLabel = `${items.length + 1}. Other (type your answer)`;
			items.push({ value: otherLabel, label: otherLabel });
		}

		// Mode-aware UI dispatch
		let selectedLabel: string | undefined;

		if (this.mode === "tui") {
			// Use custom scrollable dialog for TUI mode so long questions
			// (with code blocks) can be scrolled independently from the option list.
			selectedLabel = await this.presentChoiceTui(question, items);
		} else if (this.mode === "rpc") {
			// Use flat select list for RPC mode — ctx.ui.custom() returns undefined in RPC
			selectedLabel = await this.presentChoiceRpc(question, items);
		} else {
			// JSON or print mode — no interactive UI available
			return this.cancelResponse();
		}

		// User cancelled (Esc)
		if (selectedLabel === undefined) {
			return this.cancelResponse();
		}

		// User picked "Other" — ask for custom text (only when not disabled)
		if (!disableOther && selectedLabel === otherLabel) {
			return this.handleOtherChoice(question);
		}

		// User picked a predefined option
		const selectedValue =
			labelToValue.find((e) => e.label === selectedLabel)?.value ?? selectedLabel;

		await this.logAnswer(question, selectedValue);

		return {
			content: [
				{
					type: "text" as const,
					text: `User selected: "${selectedLabel}"`,
				},
			],
			details: { format: "qna-result-v1", selected: selectedValue, label: selectedLabel },
		};
	}

	// -----------------------------------------------------------------------
	// "Other" handling (choice mode fallback)
	// -----------------------------------------------------------------------

	private async handleOtherChoice(question: string): ExecuteResponse {
		const customAnswer = await this.ctx.ui.input("Type your answer:", "");
		if (customAnswer === undefined || customAnswer.trim() === "") {
			return {
				content: [
					{
						type: "text" as const,
						text: "User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
					},
				],
				details: { format: "qna-result-v1" },
			};
		}

		const trimmedCustom = customAnswer.trim();
		await this.logAnswer(question, trimmedCustom);

		return {
			content: [
				{
					type: "text" as const,
					text: `User chose "Other" and answered: "${trimmedCustom}"`,
				},
			],
			details: { format: "qna-result-v1", selected: "__other__", customAnswer: trimmedCustom },
		};
	}

	// -----------------------------------------------------------------------
	// Shared helpers
	// -----------------------------------------------------------------------

	/**
	 * Log the Q&A entry. Notifies on failure rather than throwing.
	 */
	/**
	 * Log the Q&A entry. Skips persistence when project trust not granted.
	 * Notifies on failure rather than throwing.
	 */
	private async logAnswer(question: string, answer: string): Promise<void> {
		// Skip persistence if project trust not granted
		if (!(await (this.ctx as any).isProjectTrusted())) {
			return;
		}

		const timestamp = new Date().toISOString();
		try {
			await appendQnaEntry(this.projectDir, timestamp, question, answer);
		} catch (err) {
			this.ctx.ui.notify(`Failed to save Q&A entry: ${(err as Error).message}`, "error");
		}
	}

	// -----------------------------------------------------------------------
	// Mode-specific choice dispatch
	// -----------------------------------------------------------------------

	/**
	 * Present a choice dialog in TUI mode using the scrollable dialog.
	 */
	private async presentChoiceTui(
		question: string,
		items: Array<{ value: string; label: string }>,
	): Promise<string | undefined> {
		return this.ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
			renderChoiceDialog(tui, theme as any, done, question, items),
		);
	}

	/**
	 * Present a choice in RPC mode using ctx.ui.select() with flat string options.
	 * Options are encoded as display strings with index prefix and recommended suffix;
	 * the selected label is returned directly (reverse-mapped in handleChoice).
	 */
	private async presentChoiceRpc(
		question: string,
		items: Array<{ value: string; label: string }>,
	): Promise<string | undefined> {
		const labels = items.map((i) => i.label);
		return this.ctx.ui.select(question, labels);
	}

	/**
	 * Standard cancellation response shared by all modes.
	 */
	private cancelResponse(): {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	} {
		return {
			content: [
				{
					type: "text" as const,
					text: "User cancelled the question. Ask if they want to skip this topic and move on.",
				},
			],
			details: { format: "qna-result-v1" },
		};
	}
}

// ---------------------------------------------------------------------------
// Choice dialog renderer (extracted from inline lambda in index.ts)
// ---------------------------------------------------------------------------

/**
 * Render a choice dialog using the scrollable dialog component.
 *
 * This is a standalone function rather than a QuestionHandler method so
 * the handler doesn't depend on pi-tui imports directly.
 */
function renderChoiceDialog(
	tui: { requestRender: () => void },
	theme: { fg: (color: string, text: string) => string },
	done: (value: string | undefined) => void,
	question: string,
	items: Array<{ value: string; label: string }>,
): ReturnType<typeof renderScrollableDialog> {
	return renderScrollableDialog(tui, theme, done, question, items);
}
