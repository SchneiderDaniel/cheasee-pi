// ─── Agent Output Parser — core ─────────────────────────────────
// Single deterministic parser for all agent outputs. Agents output structured
// JSON; this module parses and validates it: no regex fallback, no text-marker
// scanning, no lastIndexOf lookups. Split by step (issue #2033): recovery in
// parse-json.ts, refusal in parse-refusal.ts, typed construction in
// parse-build.ts, text helpers in parse-text.ts. The facade is output.ts.

import type { AgentOutput, ParseResult, RefusedOutput } from "../config/types.ts";
import { getDebugLogger } from "../lib/debug.ts";
import { extractLastJson, sanitizeJsonStrings } from "./last-json-scanner.ts";
import { validateAgentOutput } from "./validation.ts";
import { buildAgentOutput } from "./parse-build.ts";
import { parseWithRecovery } from "./parse-json.ts";
import { buildRefusalOutput } from "./parse-refusal.ts";
import { normalizeEscapes, stripAnsi } from "./parse-text.ts";

export { normalizeEscapes, stripAnsi };

/**
 * Parse agent output into structured AgentOutput.
 *
 * Strategy:
 * 1. Strip ANSI escape sequences
 * 2. Extract JSON from text (code fences, surrounding text)
 * 3. JSON.parse the extracted text
 * 4. Validate against schema
 *
 * Returns either a valid AgentOutput, a RefusedOutput (agent declined the
 * task) or a FailedParse with descriptive error.
 */
export function parseAgentOutput(output: string, toolNames?: Set<string>): ParseResult {
	// Guard against null/undefined/empty
	if (output === null || output === undefined) {
		return { error: "Output is null or undefined", rawOutput: String(output) };
	}

	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return { error: "Output is empty", rawOutput: output };
	}

	// Step 1: Strip ANSI escape sequences
	const clean = stripAnsi(trimmed);

	// Step 2: Extract JSON from text
	// 💭 prefix stripping occurs inside extractLastJson for code fence
	// detection. Brace matching is string-boundary aware, so double-quotes
	// and escapes inside string values don't corrupt it.
	const jsonStr = extractLastJson(clean, toolNames);
	if (!jsonStr) {
		getDebugLogger().warn("agent-output", "No JSON structure found in agent output", {
			outputLen: clean.length,
		});
		return { error: "No JSON structure found in agent output", rawOutput: output };
	}

	// Step 2.5: Sanitize JSON — escape literal newlines inside string values
	// Agents often produce commentBody with actual newlines instead of \\n escapes
	const sanitized = sanitizeJsonStrings(jsonStr);

	// Step 3: Parse JSON (sanitized to handle literal newlines in strings)
	const outcome = parseWithRecovery(jsonStr, sanitized);
	if (!outcome.ok) {
		getDebugLogger().warn("agent-output", `JSON parse failed: ${outcome.error}`, {
			jsonLen: jsonStr.length,
			sanitizedLen: sanitized.length,
		});
		return {
			error: `Failed to parse JSON from agent output: ${outcome.error}`,
			rawOutput: output,
		};
	}
	const parsed = outcome.value;

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		getDebugLogger().warn("agent-output", "Parsed JSON not an object");
		return {
			error: "Parsed JSON must be an object (not array or primitive)",
			rawOutput: output,
		};
	}

	const data = parsed as Record<string, unknown>;

	// Step 3.5: Refusal detection — evaluated BEFORE schema validation.
	const refusal = buildRefusalOutput(data);
	if (refusal) return refusal;

	// Step 4: Validate
	const validation = validateAgentOutput(data);
	if (!validation.valid) {
		getDebugLogger().warn(
			"agent-output",
			`Schema validation failed: ${validation.errors.join("; ")}`,
			{
				action: data.action,
				agentName: data.agentName,
			},
		);
		return {
			error: `Agent output schema validation failed: ${validation.errors.join("; ")}`,
			rawOutput: output,
		};
	}

	// Step 5: Build typed AgentOutput
	return buildAgentOutput(data);
}

/**
 * Check if a ParseResult is a successful AgentOutput.
 * RefusedOutput lacks the `action` key, so it is correctly excluded.
 */
export function isSuccess(result: ParseResult): result is AgentOutput {
	return "action" in result && "agentName" in result;
}

/**
 * Check if a ParseResult is a RefusedOutput (agent declined the task).
 */
export function isRefused(result: ParseResult): result is RefusedOutput {
	return "refused" in result && result.refused === true;
}

/**
 * Extract the refusal from agent output text, if the agent declined the task.
 * Shared facade over parseAgentOutput: refusal detection runs before schema
 * validation, so refusal prose (which is not schema-conforming by design) is
 * never validated. Returns the RefusedOutput variant or null when the output
 * is not a refusal. Callers pass the same toolNames they use for
 * parseAgentOutput.
 */
export function getRefusalInfo(output: string, toolNames?: Set<string>): RefusedOutput | null {
	const parsed = parseAgentOutput(output, toolNames);
	return isRefused(parsed) ? parsed : null;
}
