#!/usr/bin/env node
// Strip pi's "Warning: No project session found with id '<id>'; creating a
// new session with that id." stderr line from the installed pi bundle.
//
// Why: cheasee-pi start pins pi's `--session-id` to a fresh random
// CHEASEE_SESSION_ID marker on every launch (start = new session by design;
// the id is the join key for the claim file and the marker reaper). pi's
// warning exists for interactive users who pass a stale id by mistake; here
// a fresh id is deliberate, so the warning fires on every single start and
// reads like an error. This patch silences exactly that one statement.
//
// Implementation: indexOf-based statement splice instead of a regex — the
// bundle is minified and the wrapper module (chalk vs source_default) and
// trailing `;` differ between dist/main.js and dist/bundle/chunks/*.js.
// Idempotent: a second run finds no marker and changes nothing.
// Fail-closed: if no replacement happened anywhere, exit 1 — a pi bump that
// re-wires the message surfaces at docker build time instead of being
// silently skipped.
const fs = require("fs");

const PI_DIST = "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const marker =
	"Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.";
const replaceWith =
	"/* cheasee-pi: fresh CHEASEE_SESSION_ID is deliberate (start = new session); suppress pi warning */";

function patchFile(file) {
	let src = fs.readFileSync(file, "utf8");
	let changed = false;
	let cursor = 0;
	while (true) {
		const idx = src.indexOf(marker, cursor);
		if (idx === -1) break;
		const start = src.lastIndexOf("console.error(", idx);
		if (start === -1) {
			throw new Error(file + ": no console.error( before marker");
		}
		const prefix = src.slice(start + "console.error(".length, idx);
		if (prefix !== "chalk.yellow(`" && prefix !== "source_default.yellow(`") {
			throw new Error(file + ": unexpected wrapper: " + JSON.stringify(prefix));
		}
		const afterMarker = idx + marker.length;
		const tail = src.slice(afterMarker, afterMarker + 4);
		if (!tail.startsWith("`))")) {
			throw new Error(file + ": unexpected statement tail: " + JSON.stringify(tail));
		}
		const end = afterMarker + 3 + (src[afterMarker + 3] === ";" ? 1 : 0);
		src = src.slice(0, start) + replaceWith + src.slice(end);
		cursor = start + replaceWith.length;
		changed = true;
	}
	if (changed) fs.writeFileSync(file, src);
	return changed;
}

function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = dir + "/" + e.name;
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".js") && patchFile(p)) console.log("patched: " + p);
	}
}

walk(PI_DIST);

let remaining = 0;
(function recount(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = dir + "/" + e.name;
		if (e.isDirectory()) recount(p);
		else if (e.name.endsWith(".js") && fs.readFileSync(p, "utf8").includes(marker)) remaining++;
	}
})(PI_DIST);
if (remaining > 0) {
	console.error(
		"pi session-id warning patch: " +
			remaining +
			" file(s) still contain the marker — pi version changed?",
	);
	process.exit(1);
}
console.log("pi session-id warning patched");
