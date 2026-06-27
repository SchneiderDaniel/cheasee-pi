/**
 * constants — Domain configuration for check-extensions pipeline
 *
 * Extracted from index.ts to isolate configuration from wiring.
 * All constants used by the pipeline phases live here.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolve path to pi CHANGELOG.md */
const _piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const _piRoot = dirname(dirname(fileURLToPath(new URL(_piEntry))));
export const PI_CHANGELOG_PATH = join(_piRoot, "CHANGELOG.md");

/** The set of API names we look for in changelog entries */
export const API_PATTERNS = [
	"pi.on",
	"pi.registerCommand",
	"pi.registerTool",
	"pi.exec",
	"pi.sendUserMessage",
	"ctx.ui",
	"ctx.sessionManager",
	"ctx.abort",
	"pi.registerFlag",
	"pi.registerShortcut",
	"pi.getFlag",
	"pi.setActiveTools",
	"pi.sendMessage",
	"pi.appendEntry",
	"pi.setSessionName",
];

/** Known API term aliases for mapping changelog entries to scan patterns */
const _CHANGELOG_API_TO_PATTERN: Readonly<Record<string, readonly string[]>> = Object.freeze({
	on: ["pi.on"],
	registerCommand: ["pi.registerCommand"],
	registerTool: ["pi.registerTool"],
	exec: ["pi.exec"],
	sendUserMessage: ["pi.sendUserMessage"],
	"ctx.ui": ["ctx.ui"],
	sessionManager: ["ctx.sessionManager"],
	abort: ["ctx.abort"],
	registerFlag: ["pi.registerFlag"],
	registerShortcut: ["pi.registerShortcut"],
	getFlag: ["pi.getFlag"],
	setActiveTools: ["pi.setActiveTools"],
	sendMessage: ["pi.sendMessage"],
	appendEntry: ["pi.appendEntry"],
	setSessionName: ["pi.setSessionName"],
	tool: ["pi.registerTool", "pi.on"],
	command: ["pi.registerCommand"],
	event: ["pi.on"],
	extension: ["pi.on", "pi.registerCommand"],
	SDK: ["pi.exec", "pi.sendUserMessage"],
	config: ["pi.registerFlag", "pi.getFlag"],
	"config option": ["pi.registerFlag", "pi.getFlag"],
	export: ["pi.sendUserMessage", "pi.sendMessage"],
});

/** Lowercase-key map for case-insensitive lookup (fixes #600) */
const _LOWER_CHANGELOG_API_TO_PATTERN: Record<string, readonly string[]> = {};
for (const [key, val] of Object.entries(_CHANGELOG_API_TO_PATTERN)) {
	_LOWER_CHANGELOG_API_TO_PATTERN[key.toLowerCase()] = val;
}
export const CHANGELOG_API_TO_PATTERN_LOWER: Readonly<Record<string, readonly string[]>> =
	Object.freeze(_LOWER_CHANGELOG_API_TO_PATTERN);
