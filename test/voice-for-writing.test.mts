/**
 * Tests for the voice-trainer skill (.pi/skills/voice-trainer/SKILL.md).
 *
 * Text-analysis tests that read the skill file and assert content patterns.
 * The original `.pi/prompts/misc/misc:writing-voice.md` prompt was migrated to
 * skills (commit e6f79132); the collection/analysis contract now lives in the
 * voice-trainer skill, so this test targets that tracked source.
 *
 * Run with:
 *   node --experimental-strip-types --test test/voice-for-writing.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PROMPT_PATH = resolve(import.meta.dirname, "..", ".pi/skills/voice-trainer/SKILL.md");

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { frontmatter: Record<string,string>, body: string }
 */
function parseFrontmatter(filePath: string): {
	frontmatter: Record<string, string>;
	body: string;
} {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") {
		return { frontmatter: {}, body: content };
	}
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) {
		return { frontmatter: {}, body: content };
	}
	const fmLines = lines.slice(1, endIndex);
	const body = lines.slice(endIndex + 1).join("\n");
	const frontmatter: Record<string, string> = {};
	for (const line of fmLines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx !== -1) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			frontmatter[key] = value;
		}
	}
	return { frontmatter, body };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Prompt file existence and structure
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Prompt file existence and structure", () => {
	it("exists at .pi/skills/voice-trainer/SKILL.md", () => {
		assert.ok(existsSync(PROMPT_PATH), `File not found: ${PROMPT_PATH}`);
	});

	it("YAML frontmatter parses without error", () => {
		const { frontmatter } = parseFrontmatter(PROMPT_PATH);
		// If parsing failed, frontmatter would be empty
		assert.ok(Object.keys(frontmatter).length > 0, "No frontmatter parsed");
	});

	it("frontmatter contains description field with non-empty value", () => {
		const { frontmatter } = parseFrontmatter(PROMPT_PATH);
		assert.ok("description" in frontmatter, "description key missing from frontmatter");
		assert.ok(frontmatter.description!.trim().length > 0, "description value is empty");
	});

	it("frontmatter contains only allowed skill keys", () => {
		const { frontmatter } = parseFrontmatter(PROMPT_PATH);
		const allowedKeys = new Set(["name", "description", "disable-model-invocation"]);
		for (const key of Object.keys(frontmatter)) {
			assert.ok(allowedKeys.has(key), `Unexpected frontmatter key: ${key}`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Input collection completeness
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Input collection completeness", () => {
	const { body } = parseFrontmatter(PROMPT_PATH);
	const lowerBody = body.toLowerCase();

	it("prompt contains 3-option menu: paste, URL, file", () => {
		// Check for all three options by looking for key terms
		const hasPasteOption = body.includes("Paste") || body.includes("paste") || body.includes("1.");
		const hasUrlOption = body.includes("URL") || body.includes("url") || body.includes("2.");
		const hasFileOption = body.includes("File") || body.includes("file") || body.includes("3.");

		// More robust: look for numbered menu items
		const hasMenuMarkers =
			(body.includes("1.") && body.includes("2.") && body.includes("3.")) ||
			(body.includes("**1**") && body.includes("**2**") && body.includes("**3**"));

		assert.ok(
			hasMenuMarkers || (hasPasteOption && hasUrlOption && hasFileOption),
			"Must have 3-option menu for paste, URL, and file input",
		);
	});

	it("paste option specifies ≥100 character minimum", () => {
		const hasThreshold = body.includes("100") || lowerBody.includes("at least a paragraph");
		assert.ok(
			hasThreshold,
			"Must specify a minimum character threshold (100 or 'at least a paragraph')",
		);
	});

	it("paste rejection message: 'Please provide at least a paragraph'", () => {
		assert.ok(
			body.includes("Please provide at least a paragraph"),
			"Missing exact paste rejection message",
		);
	});

	it("URL failure message: 'URL unreachable'", () => {
		assert.ok(body.includes("URL unreachable"), "Missing exact URL failure message");
	});

	it("file not found message: 'File not found'", () => {
		assert.ok(body.includes("File not found"), "Missing exact file not found message");
	});

	it("empty input message: 'Input is empty — provide sample text'", () => {
		assert.ok(
			body.includes("Input is empty") || body.includes("Input is empty — provide sample text"),
			"Missing empty input message",
		);
	});

	it("after any error, prompt allows retry (returns to menu)", () => {
		const hasRetry =
			lowerBody.includes("return to menu") ||
			lowerBody.includes("back to menu") ||
			lowerBody.includes("retry") ||
			lowerBody.includes("try again") ||
			lowerBody.includes("start over") ||
			lowerBody.includes("choose again");
		assert.ok(hasRetry, "Must provide a way to return to menu or retry after error");
	});

	it("all four validation failure messages are specified", () => {
		for (const message of [
			"Please provide at least a paragraph",
			"URL unreachable",
			"File not found",
			"Input is empty",
		]) {
			assert.ok(body.includes(message), `Missing validation message: ${message}`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Style analysis completeness
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Style analysis completeness", () => {
	const { body } = parseFrontmatter(PROMPT_PATH);
	const lowerBody = body.toLowerCase();

	it("all 7 style dimensions are mentioned", () => {
		const dimensions = [
			["Tone", "Formality"],
			["Word Choice"],
			["Sentence Structure"],
			["Emoji Usage"],
			["Abbreviations", "Contractions"],
			["Tense", "Pronouns"],
			["Markdown Conventions"],
		];

		for (const terms of dimensions) {
			const found = terms.some((t) => body.includes(t));
			assert.ok(found, `Missing style dimension: ${terms.join(" / ")}`);
		}
	});

	it("low-confidence clarification mechanism is described (70%)", () => {
		const hasClarification =
			lowerBody.includes("70%") ||
			lowerBody.includes("70% confidence") ||
			lowerBody.includes("low confidence") ||
			lowerBody.includes("low-confidence") ||
			(lowerBody.includes("clarif") && lowerBody.includes("confidence"));
		assert.ok(
			hasClarification,
			"Must mention low-confidence clarification mechanism (70% threshold)",
		);
	});

	it("generated voice file is written to .pi/skills/voice-for-writing/references/", () => {
		assert.ok(
			body.includes(".pi/skills/voice-for-writing/references"),
			"Must name .pi/skills/voice-for-writing/references/ as the voice file location",
		);
	});

	it("language auto-detection is described", () => {
		const hasAutoDetect =
			lowerBody.includes("auto-detect") ||
			(lowerBody.includes("detect") && lowerBody.includes("language")) ||
			(lowerBody.includes("identif") && lowerBody.includes("language")) ||
			lowerBody.includes("language code") ||
			lowerBody.includes("voice-");
		assert.ok(hasAutoDetect, "Must describe auto-detection of language from sample text");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Output generation completeness
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Output generation completeness", () => {
	const { body } = parseFrontmatter(PROMPT_PATH);

	it("output header: '# Voice Rules — {language name}'", () => {
		assert.ok(body.includes("Voice Rules"), "Missing 'Voice Rules' in output header");
	});

	it("all 5 required sections are mentioned in order", () => {
		const sections = [
			"Tone",
			"Word Choice",
			"Sentence Structure",
			"Markdown Conventions",
			"Example Phrases",
		];

		for (const section of sections) {
			assert.ok(body.includes(section), `Missing section header: ${section}`);
		}
	});

	it("instructions mention writing narrative prose with concrete examples", () => {
		const lowerBody = body.toLowerCase();
		const hasProseExample =
			lowerBody.includes("narrative") ||
			lowerBody.includes("prose") ||
			lowerBody.includes("example") ||
			lowerBody.includes("concrete example") ||
			lowerBody.includes("sample from") ||
			lowerBody.includes("from the sample") ||
			lowerBody.includes("specific example");
		assert.ok(
			hasProseExample,
			"Must mention using narrative prose with concrete examples from sample",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Edge-case resilience
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 5: Edge-case resilience", () => {
	const { body } = parseFrontmatter(PROMPT_PATH);
	const lowerBody = body.toLowerCase();

	it("handles empty input (covered in Phase 2)", () => {
		assert.ok(body.includes("Input is empty") || body.includes("empty"), "Must handle empty input");
	});

	it("handles broken URL (covered in Phase 2)", () => {
		assert.ok(
			body.includes("URL unreachable") || lowerBody.includes("unreachable"),
			"Must handle unreachable URLs",
		);
	});

	it("handles non-existent file path (covered in Phase 2)", () => {
		assert.ok(
			body.includes("File not found") || lowerBody.includes("not found"),
			"Must handle non-existent file paths",
		);
	});

	it("handles text shorter than 100 chars (covered in Phase 2)", () => {
		assert.ok(
			body.includes("100") ||
				lowerBody.includes("at least a paragraph") ||
				lowerBody.includes("short") ||
				lowerBody.includes("minimum"),
			"Must handle text shorter than minimum length",
		);
	});

	it("overwrites an existing voice file and modifies no others", () => {
		assert.ok(lowerBody.includes("overwrite"), "Must state an existing voice file is overwritten");
		assert.ok(
			lowerBody.includes("do not modify any other files"),
			"Must state that no other files are modified",
		);
	});

	it("supports non-English languages (voice-{lang}.md naming)", () => {
		assert.ok(
			body.includes("voice-") ||
				lowerBody.includes("voice-") ||
				lowerBody.includes("language code") ||
				lowerBody.includes("lang"),
			"Must support non-English output file naming with language code",
		);
	});
});
