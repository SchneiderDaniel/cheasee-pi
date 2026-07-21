#!/usr/bin/env node
/**
 * sync-version.mjs — Update version string in all 4 files.
 *
 * Usage: node sync-version.mjs <new-version>
 *
 * Updates:
 *   - package.json (version field)
 *   - cmd/cheasee-pi/root.go   (Version: "X.X.X")
 *   - cmd/cheasee-pi/root_test.go (version string in test expectation)
 *   - docs/installation.md     (VERSION="X.X.X")
 *
 * Prints JSON: { files: [{path, oldVersion, newVersion, changed}] }
 */
import fs from "fs";

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+(\.\d+)?$/.test(newVersion)) {
	console.error(`Usage: node sync-version.mjs <version> (e.g. "0.32" or "0.32.0")`);
	process.exit(1);
}

const files = [];

// 1. package.json
{
	const path = "package.json";
	const content = fs.readFileSync(path, "utf8");
	const match = content.match(/"version":\s*"(\d+\.\d+(?:\.\d+)?)"/);
	if (match) {
		const old = match[1];
		const updated = content.replace(
			/"version":\s*"\d+\.\d+(?:\.\d+)?"/,
			`"version": "${newVersion}"`,
		);
		fs.writeFileSync(path, updated);
		files.push({ path, oldVersion: old, newVersion, changed: old !== newVersion });
	}
}

// 2. cmd/cheasee-pi/root.go
{
	const path = "cmd/cheasee-pi/root.go";
	const content = fs.readFileSync(path, "utf8");
	const match = content.match(/Version:\s+"(\d+\.\d+(?:\.\d+)?)"/);
	if (match) {
		const old = match[1];
		const updated = content.replace(
			/Version:\s+"\d+\.\d+(?:\.\d+)?"/,
			`Version:            "${newVersion}"`,
		);
		fs.writeFileSync(path, updated);
		files.push({ path, oldVersion: old, newVersion, changed: old !== newVersion });
	}
}

// 3. cmd/cheasee-pi/root_test.go
// Tries two patterns: hardcoded `expected := "X.X.X"` and `cheasee-pi version X.X.X`
{
	const path = "cmd/cheasee-pi/root_test.go";
	const content = fs.readFileSync(path, "utf8");

	// Prefer `expected := "X.X.X"` pattern (the actual version assertion)
	let match = content.match(/expected\s*:=\s*"(\d+\.\d+(?:\.\d+)?)"/);
	let regex = /expected\s*:=\s*"\d+\.\d+(?:\.\d+)?"/;
	let replacement = `expected := "${newVersion}"`;

	// Fallback: `cheasee-pi version X.X.X` (legacy comment pattern)
	if (!match) {
		match = content.match(/cheasee-pi version (\d+\.\d+(?:\.\d+)?)/);
		regex = /cheasee-pi version \d+\.\d+(?:\.\d+)?/;
		replacement = `cheasee-pi version ${newVersion}`;
	}

	if (match) {
		const old = match[1];
		const updated = content.replace(regex, replacement);
		fs.writeFileSync(path, updated);
		files.push({ path, oldVersion: old, newVersion, changed: old !== newVersion });
	}
}

// 4. docs/installation.md
{
	const path = "docs/installation.md";
	const content = fs.readFileSync(path, "utf8");
	// Update VERSION="X.X.X" lines
	const match = content.match(/VERSION="(\d+\.\d+(?:\.\d+)?)"/);
	if (match) {
		const old = match[1];
		const updated = content.replace(/VERSION="\d+\.\d+(?:\.\d+)?"/g, `VERSION="${newVersion}"`);
		fs.writeFileSync(path, updated);
		files.push({ path, oldVersion: old, newVersion, changed: old !== newVersion });
	}
}

process.stdout.write(JSON.stringify(files, null, 2) + "\n");

const allChanged = files.every((f) => f.changed);
if (!allChanged) {
	const unchanged = files.filter((f) => !f.changed).map((f) => f.path);
	console.error(`Sync failed: ${unchanged.join(", ")} did not change`);
	process.exit(1);
}
