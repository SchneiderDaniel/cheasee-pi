import assert from "node:assert";

import { describe, it } from "node:test";

import { readFileSync } from "node:fs";

import { resolve } from "node:path";

const SKILL_PATH = resolve(
	import.meta.dirname,
	"..",
	".pi/skills/git-issue-create-external/SKILL.md",
);

function parseFrontmatter(filePath: string): {
	frontmatter: Record<string, unknown>;
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

	// Simple YAML frontmatter parser for flat and nested metadata
	const frontmatter: Record<string, unknown> = {};
	let currentKey: string | null = null;
	const nestedLines: string[] = [];

	for (const line of fmLines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		// Check indentation for nested values
		if (line.startsWith("  ") || line.startsWith("\t")) {
			if (currentKey) {
				nestedLines.push(trimmed);
			}
			continue;
		}

		// Flush nested content before starting new key
		if (nestedLines.length > 0 && currentKey) {
			const nestedObj: Record<string, string> = {};
			for (const nl of nestedLines) {
				const ci = nl.indexOf(":");
				if (ci !== -1) {
					nestedObj[nl.slice(0, ci).trim()] = nl.slice(ci + 1).trim();
				}
			}
			frontmatter[currentKey] = nestedObj;
			nestedLines.length = 0;
		}

		const colonIdx = line.indexOf(":");
		if (colonIdx !== -1) {
			currentKey = line.slice(0, colonIdx).trim();
			let value = line.slice(colonIdx + 1).trim();

			// If value is empty, it might be a nested mapping start
			if (value === "") {
				continue;
			}

			// Try to parse as JSON if it looks like an array
			if (value.startsWith("[")) {
				try {
					frontmatter[currentKey] = JSON.parse(value) as unknown;
				} catch {
					frontmatter[currentKey] = value;
				}
			} else {
				// Remove surrounding quotes
				value = value.replace(/^["'](.*)["']$/, "$1");
				frontmatter[currentKey] = value;
			}
		}
	}

	// Handle trailing nested block
	if (nestedLines.length > 0 && currentKey) {
		const nestedObj: Record<string, string> = {};
		for (const nl of nestedLines) {
			const ci = nl.indexOf(":");
			if (ci !== -1) {
				nestedObj[nl.slice(0, ci).trim()] = nl.slice(ci + 1).trim();
			}
		}
		frontmatter[currentKey] = nestedObj;
	}

	return { frontmatter, body };
}

function extractStepSection(body: string, stepNumber: number): string | null {
	const marker = `### Step ${stepNumber}`;
	const startIdx = body.indexOf(marker);
	if (startIdx === -1) return null;

	// Find the next ### heading or end of string
	const nextMarkerIdx = findNextH3Heading(body, startIdx + marker.length);
	return body.slice(startIdx, nextMarkerIdx !== -1 ? nextMarkerIdx : undefined);
}

function findNextH3Heading(body: string, fromIndex: number): number {
	const lines = body.slice(fromIndex).split("\n");
	let accumulated = fromIndex;
	for (const line of lines) {
		if (line.startsWith("### ") && accumulated > fromIndex) {
			return accumulated;
		}
		accumulated += line.length + 1; // +1 for newline
	}
	return -1;
}

function extractSection(body: string, sectionName: string): string | null {
	// Try exact heading first
	const exactMarker = `## ${sectionName}`;
	let startIdx = body.indexOf(exactMarker);

	// Fallback to partial match
	if (startIdx === -1) {
		const lowerBody = body.toLowerCase();
		const lowerName = sectionName.toLowerCase();
		const lines = body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith("## ") && trimmed.slice(3).toLowerCase().includes(lowerName)) {
				startIdx = lines.slice(0, i).join("\n").length;
				if (startIdx > 0) startIdx += 1; // account for last newline
				break;
			}
		}
	}

	if (startIdx === -1) return null;

	// Find the next ## heading (same level), skipping fenced code blocks
	const rest = body.slice(startIdx + exactMarker.length);
	const lines = rest.split("\n");
	let accumulated = startIdx + exactMarker.length;
	let inCodeBlock = false;
	for (const line of lines) {
		// Toggle code block state
		if (line.trim().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
		}

		if (
			!inCodeBlock &&
			line.trim().startsWith("## ") &&
			accumulated > startIdx + exactMarker.length
		) {
			return body.slice(startIdx, accumulated);
		}
		accumulated += line.length + 1;
	}
	return body.slice(startIdx);
}

describe("Phase 5: Error handling rules (R4)", () => {
	const { body } = parseFrontmatter(SKILL_PATH);

	it('Duplicate found → "stop and report to user" / do NOT file language', () => {
		const errorSection = extractSection(body, "Error Handling");
		assert.ok(errorSection, "Error Handling section not found");
		const hasStopLanguage =
			errorSection.includes("stop") ||
			errorSection.includes("Stop") ||
			errorSection.includes("STOP");
		const hasDoNotFile =
			errorSection.includes("Do NOT file") ||
			errorSection.includes("do NOT file") ||
			errorSection.includes("do not file");
		assert.ok(
			hasStopLanguage && hasDoNotFile,
			"Error Handling missing duplicate stop or do NOT file language",
		);
	});

	it("If no CONTRIBUTING.md and no templates → use universal fallback format (do NOT abort)", () => {
		const errorSection = extractSection(body, "Error Handling");
		assert.ok(errorSection, "Error Handling section not found");
		assert.ok(
			errorSection.includes("Universal Fallback Format") ||
				errorSection.includes("universal fallback"),
			"Error Handling missing universal fallback format fallback rule",
		);
	});

	it('If gh auth status fails → stop and tell user to run "gh auth login"', () => {
		const authSection =
			extractSection(body, "Preconditions") ||
			extractSection(body, "Authentication Check") ||
			extractSection(body, "Error Handling");
		assert.ok(authSection, "No section with auth check found");
		assert.ok(
			authSection.includes("gh auth login") || authSection.includes("gh auth status"),
			"Missing gh auth login instruction",
		);
	});

	it("If CONTRIBUTING.md exists but no templates → extract format from CONTRIBUTING.md, don't fall back immediately", () => {
		const step1Section = extractStepSection(body, 1);
		const errorSection = extractSection(body, "Error Handling");
		const combinedText = (step1Section || "") + "\n" + (errorSection || "");

		assert.ok(
			combinedText.includes("CONTRIBUTING.md") &&
				combinedText.includes("format") &&
				(combinedText.includes("do not fall back") ||
					combinedText.includes("do NOT fall back") ||
					combinedText.includes("do NOT immediately")),
			"Missing CONTRIBUTING.md format extraction rule without immediate fallback",
		);
	});

	it("If confidence on duplicate check < threshold → report to user for manual review", () => {
		const step3Section = extractStepSection(body, 3);
		const errorSection = extractSection(body, "Error Handling");
		const combinedText = (step3Section || "") + "\n" + (errorSection || "");

		assert.ok(
			combinedText.includes("confidence") ||
				combinedText.includes("Confidence") ||
				combinedText.includes("threshold") ||
				combinedText.includes("manual review"),
			"Missing low-confidence duplicate check handling",
		);
	});
});
