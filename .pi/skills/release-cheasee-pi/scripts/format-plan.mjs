#!/usr/bin/env node
/**
 * format-plan.mjs — Read release-plan.json, print formatted summary, prompt user.
 *
 * Usage: node format-plan.mjs < ignore/release-plan.json
 *
 * Exits:
 *   0 — user confirmed "create"
 *   1 — user chose "cancel"
 *   2 — user chose "show body" (body printed to stderr)
 */
import fs from "fs";

const input = fs.readFileSync(process.stdin.fd, "utf8").trim();
const plan = JSON.parse(input);

const { baseVersion, prCount, featureCount, increment, newVersion, newTag, body } = plan;

console.log("\n=== Release Plan ===");
console.log(`  Last tag:    v${baseVersion}`);
console.log(`  PRs merged:  ${prCount}`);
console.log(`  Features:    ${featureCount}  (>=10 → +0.1, <10 → +0.01)`);
console.log(`  Increment:   ${increment}`);
console.log(`  New version: v${newVersion}`);
console.log(`  Tag exists:  ${plan.tagExists}`);
console.log("");

// First 5 body lines (skip title)
const bodyLines = body.split("\n").slice(2, 7).filter(Boolean);
console.log("=== First entries ===");
for (const line of bodyLines) {
	console.log(line);
}
console.log("");

// Guard: no PRs
if (prCount === 0) {
	console.log("No new PRs since last tag. Nothing to release.");
	process.exit(1);
}

// Guard: tag collision
if (plan.tagExists) {
	console.log(`Tag ${newTag} already exists. Delete it first or abort.`);
	process.exit(1);
}

// Prompt
console.log("Create this release?");
console.log("  [1] Create");
console.log("  [2] Show full release body");
console.log("  [3] Cancel");

const answer = await new Promise((resolve) => {
	process.stdout.write("Select: ");
	process.stdin.once("data", (buf) => resolve(buf.toString().trim()));
});

if (answer === "1") {
	console.log("Confirmed. Proceeding.");
	process.exit(0);
} else if (answer === "2") {
	console.error(body); // full body to stderr so stdout stays clean
	process.exit(2);
} else {
	console.log("Cancelled.");
	process.exit(1);
}
