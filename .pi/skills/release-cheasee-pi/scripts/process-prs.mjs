#!/usr/bin/env node
/**
 * process-prs.mjs — Categorize PRs, calculate version, build release body.
 *
 * Reads PR JSON (from fetch-prs.sh) on stdin.
 * Outputs JSON to stdout with:
 *   { baseVersion, featureCount, increment, newVersion, tagExists, categories, body }
 *
 * Usage: cat prs.json | node process-prs.mjs
 */
import fs from "fs";
import { execSync } from "child_process";

// ---- Category rules ----
// First match wins. Last rule is catch-all.
const CATEGORY_RULES = [
	{
		name: "🐛 Bug Fixes",
		key: "bugs",
		match: (t) => /^fix\(|\[bug\]/i.test(t) && !/dependabot|golang\.org|npm/.test(t),
	},
	{
		name: "🔗 Dependencies",
		key: "deps",
		match: (t) => /dependabot|bump golang|golang\.org|upgrade undici|npm (audit|vuln)/i.test(t),
	},
	{
		name: "🔧 Code Quality & Architecture",
		key: "quality",
		match: (t) =>
			/ica:|dead.?code|duplicate.?code|reinvent|reimplement|shallow pass|dead.island|bespoke|fragmentation|seam|dead export|unused|near.miss|dead.?island/i.test(
				t,
			),
	},
	{
		name: "📚 Documentation",
		key: "docs",
		match: (t) =>
			/^(doc|readme|installation|quick.start|daily usage)/i.test(t) ||
			/convenience script|dockerfile awareness/i.test(t),
	},
	{
		name: "✨ Features & Enhancements",
		key: "features",
		match: () => true, // catch-all
	},
];

// Keys that count as "features" for version bump increment
const FEATURE_KEYS = new Set(["features"]);

// ---- Main ----
const input = fs.readFileSync(process.stdin.fd, "utf8").trim();
const data = JSON.parse(input);

const { lastTag, baseVersion, prs } = data;

// Categorize each PR
const categories = {};
for (const rule of CATEGORY_RULES) {
	categories[rule.name] = [];
}

for (const pr of prs) {
	const title = pr.title || "";
	for (const rule of CATEGORY_RULES) {
		if (rule.match(title)) {
			categories[rule.name].push(pr);
			break;
		}
	}
}

// Count features for version calculation
const featureCount = prs.filter((pr) => {
	const title = pr.title || "";
	for (const rule of CATEGORY_RULES) {
		if (rule.match(title)) {
			return FEATURE_KEYS.has(rule.key);
		}
	}
	return false;
}).length;

// Calculate version
const increment = featureCount >= 10 ? 0.1 : 0.01;
const newVersionRaw = parseFloat(baseVersion || "0.1") + increment;
const newVersion = newVersionRaw.toFixed(2);
const newTag = "v" + newVersion;

// Guard: check if tag already exists
let tagExists = false;
try {
	execSync(`git rev-parse --verify "${newTag}" 2>/dev/null`, { stdio: "ignore" });
	tagExists = true;
} catch {
	tagExists = false;
}

// ---- Build release body ----
const repo = "SchneiderDaniel/cheasee-pi";
let body = `## Release v${newVersion}\n\n`;
body += `Release v${newVersion} — incremental update from v${baseVersion} with ${prs.length} merged PRs.\n\n`;
body += `### What's Changed\n\n`;

for (const rule of CATEGORY_RULES) {
	const items = categories[rule.name];
	if (items.length === 0) continue;
	body += `## ${rule.name}\n\n`;
	for (const pr of items) {
		body += `- [#${pr.number}](${pr.url}): ${pr.title}\n`;
	}
	body += "\n";
}

body += `**Full Changelog**: https://github.com/${repo}/compare/v${baseVersion}...v${newVersion}\n`;

// ---- Output ----
const output = {
	lastTag,
	baseVersion,
	featureCount,
	increment,
	newVersion,
	newTag,
	tagExists,
	prCount: prs.length,
	categories: Object.fromEntries(CATEGORY_RULES.map((r) => [r.key, categories[r.name].length])),
	body,
};
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
