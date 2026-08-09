/**
 * Tests for test-designer.md — User-Journey & Persona-Based Testing (Section 8)
 *
 * Phase 1: Section 8 — User-Journey & Persona-Based Testing heading + body
 * Phase 2: Phase Format updated, Section 7 updated, Phase Gating updated
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/test-designer-user-journey.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DESIGNER_MD = resolve(__dirname, "../agents/test-designer.md");

function readTestDesignerMd(): string {
	return readFileSync(TEST_DESIGNER_MD, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 1: User-Journey Tests section
// ---------------------------------------------------------------------------

describe("test-designer.md — User-Journey Tests section (Phase 1)", () => {
	it("contains '## User-Journey Tests' heading", () => {
		const content = readTestDesignerMd();
		assert.ok(content.includes("## User-Journey Tests"), "Should have User-Journey Tests heading");
	});

	it("User-Journey Tests appears after Completeness by Tier and before Template", () => {
		const content = readTestDesignerMd();
		const completenessIdx = content.indexOf("## Completeness by Tier");
		const ujIdx = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		assert.ok(completenessIdx >= 0, "Completeness by Tier heading must exist");
		assert.ok(ujIdx >= 0, "User-Journey Tests heading must exist");
		assert.ok(templateIdx >= 0, "Template heading must exist");
		assert.ok(
			completenessIdx < ujIdx,
			"User-Journey Tests should appear after Completeness by Tier",
		);
		assert.ok(ujIdx < templateIdx, "User-Journey Tests should appear before Template");
	});

	it("User-Journey Tests section mentions 'mandatory only for user-facing features'", () => {
		const content = readTestDesignerMd();
		const ujStart = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		const ujBody = content.substring(ujStart, templateIdx);
		assert.ok(
			ujBody.includes("mandatory only for user-facing features") ||
				ujBody.includes("mandatory only for user-facing"),
			"User-Journey Tests should state it's mandatory only for user-facing features",
		);
	});

	it("User-Journey Tests contains 'Identify the persona' instruction", () => {
		const content = readTestDesignerMd();
		const ujStart = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		const ujBody = content.substring(ujStart, templateIdx);
		assert.ok(
			ujBody.includes("Identify the persona"),
			"User-Journey Tests should contain 'Identify the persona' instruction",
		);
	});

	it("User-Journey Tests contains 'Trace full journey' instruction", () => {
		const content = readTestDesignerMd();
		const ujStart = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		const ujBody = content.substring(ujStart, templateIdx);
		assert.ok(
			ujBody.includes("Trace full journey"),
			"User-Journey Tests should contain 'Trace full journey' instruction",
		);
	});

	it("User-Journey Tests contains 'Test user-visible feedback' instruction", () => {
		const content = readTestDesignerMd();
		const ujStart = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		const ujBody = content.substring(ujStart, templateIdx);
		assert.ok(
			ujBody.includes("Test user-visible feedback"),
			"User-Journey Tests should contain 'Test user-visible feedback' instruction",
		);
	});

	it("User-Journey Tests prefers fastest verification layer", () => {
		const content = readTestDesignerMd();
		const ujStart = content.indexOf("## User-Journey Tests");
		const templateIdx = content.indexOf("## Template");
		const ujBody = content.substring(ujStart, templateIdx);
		assert.ok(
			ujBody.includes("fastest verification layer") || ujBody.includes("fastest layer"),
			"User-Journey Tests should prefer fastest verification layer",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2a: Phase Format includes user-journey as valid layer
// ---------------------------------------------------------------------------

describe("test-designer.md — Layer values include user-journey (Phase 2a)", () => {
	it("Layer-appropriate testing lists 'user-journey' as a valid layer value alongside entity, use-case, adapter, e2e", () => {
		const content = readTestDesignerMd();
		const layerSection = content.substring(
			content.indexOf("### 2. Layer-appropriate testing"),
			content.indexOf("### ", content.indexOf("### 2. Layer-appropriate testing") + 5),
		);
		assert.ok(
			layerSection.includes("user-journey"),
			"Layer-appropriate testing should list user-journey as a valid layer",
		);
	});

	it("Layer-appropriate testing includes all five layer values", () => {
		const content = readTestDesignerMd();
		const layerSection = content.substring(
			content.indexOf("### 2. Layer-appropriate testing"),
			content.indexOf("### ", content.indexOf("### 2. Layer-appropriate testing") + 5),
		);
		assert.ok(layerSection.includes("entity"), "Layer list should include entity");
		assert.ok(layerSection.includes("use-case"), "Layer list should include use-case");
		assert.ok(layerSection.includes("adapter"), "Layer list should include adapter");
		assert.ok(layerSection.includes("e2e"), "Layer list should include e2e");
		assert.ok(layerSection.includes("user-journey"), "Layer list should include user-journey");
	});

	it("Layer-appropriate testing has user-journey with description about persona-based testing", () => {
		const content = readTestDesignerMd();
		const layerSection = content.substring(
			content.indexOf("### 2. Layer-appropriate testing"),
			content.indexOf("### ", content.indexOf("### 2. Layer-appropriate testing") + 5),
		);
		const ujLine = layerSection.split("\n").find((l) => l.includes("user-journey"));
		assert.ok(
			ujLine && (ujLine.includes("persona") || ujLine.includes("persona-based")),
			"user-journey layer should reference persona-based testing",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2b: Section 7 completeness rules include user-journeys bullet
// ---------------------------------------------------------------------------

describe("test-designer.md — Completeness by Tier includes user-journeys (Phase 2b)", () => {
	it("Completeness by Tier mentions 'user-journey' in Medium tier", () => {
		const content = readTestDesignerMd();
		const tierStart = content.indexOf("## Completeness by Tier");
		const ujStart = content.indexOf("## User-Journey Tests");
		const tierBody = content.substring(tierStart, ujStart);
		assert.ok(
			tierBody.includes("user-journey"),
			"Completeness by Tier should reference user-journey",
		);
	});

	it("Large tier mentions 'User-journey mandatory'", () => {
		const content = readTestDesignerMd();
		const tierBody = content.substring(
			content.indexOf("## Completeness by Tier"),
			content.indexOf("## User-Journey Tests"),
		);
		assert.ok(
			tierBody.includes("User-journey mandatory"),
			"Large tier should state user-journey is mandatory",
		);
	});

	it("Medium tier references user-journey test for user-facing features", () => {
		const content = readTestDesignerMd();
		const tierBody = content.substring(
			content.indexOf("## Completeness by Tier"),
			content.indexOf("## User-Journey Tests"),
		);
		assert.ok(
			tierBody.includes("User-journey test"),
			"Medium tier should reference user-journey test for user-facing features",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2c: User-Journey Tests section references mandatory nature
// ---------------------------------------------------------------------------

describe("test-designer.md — User-Journey Tests mandatory nature (Phase 2c)", () => {
	it("User-Journey Tests section states 'mandatory only for user-facing features'", () => {
		const content = readTestDesignerMd();
		const ujBody = content.substring(
			content.indexOf("## User-Journey Tests"),
			content.indexOf("## Template"),
		);
		assert.ok(
			ujBody.includes("mandatory only for user-facing"),
			"Should state user-journey is mandatory only for user-facing features",
		);
	});

	it("User-Journey Tests says 'No user-facing changes — user-journey skipped'", () => {
		const content = readTestDesignerMd();
		const ujBody = content.substring(
			content.indexOf("## User-Journey Tests"),
			content.indexOf("## Template"),
		);
		assert.ok(
			ujBody.includes("No user-facing changes"),
			"User-Journey Tests should include skip note for internal changes",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2d: Template section preserved
// ---------------------------------------------------------------------------

describe("test-designer.md — Template section preserved (Phase 2d)", () => {
	it("Template section still contains '## Template' heading", () => {
		const content = readTestDesignerMd();
		assert.ok(content.includes("## Template"), "Template section should still exist");
	});

	it("Template section still contains runnable test command requirement", () => {
		const content = readTestDesignerMd();
		const templateSection = content.substring(
			content.indexOf("## Template"),
			content.indexOf("## Comment Style"),
		);
		assert.ok(
			templateSection.includes("Runnable Test Command") ||
				templateSection.includes("runnable test command"),
			"Template section should reference runnable test command",
		);
	});
});
