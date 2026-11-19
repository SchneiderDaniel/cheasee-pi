// ─── Goal record rendering: Markdown with JSON front matter ───────
// Pure string transform. Every front-matter value is a JSON scalar or a
// single-line JSON flow collection: JSON is a strict subset of YAML 1.2 flow
// syntax, so the file stays valid YAML while `goal-record-parse.ts` needs no
// YAML dependency and can fail closed on the first malformed line.
//
// Structured values (criteria, verification, config, pr) are never multi-line,
// which removes the "the model reflowed the file" corruption class. The loop
// owns the front matter AND the managed body; agent prose stays inside the
// marker-delimited agent section.

import type { GoalRecord } from "./goal-record.ts";

/** Marker delimiting the loop-owned body section (regenerated on every write). */
export const MANAGED_SECTION_MARKER = "<!-- loop:managed -->";
export const AGENT_SECTION_BEGIN = "<!-- agent:begin -->";
export const AGENT_SECTION_END = "<!-- agent:end -->";

/** Front-matter keys in write order — also the parser's required-key list. */
export const FRONT_MATTER_KEYS = [
	"id",
	"status",
	"request",
	"clarifiedGoal",
	"criteria",
	"verification",
	"iterations",
	"windowIterations",
	"resets",
	"generation",
	"lastCheckpoint",
	"nextAction",
	"config",
	"worktree",
	"branch",
	"pr",
	"blocker",
	"steering",
	"compactionSeen",
	"inFlight",
] as const;

/**
 * Render the record as Markdown.
 *
 * The managed section is regenerated from the record on every call (hand edits
 * to it are overwritten by design); `agentSection` is the only text the agent
 * owns and is carried through verbatim.
 */
export function serializeGoalRecord(record: GoalRecord, agentSection = ""): string {
	const lines: string[] = ["---"];
	for (const key of FRONT_MATTER_KEYS) {
		lines.push(`${key}: ${JSON.stringify(record[key])}`);
	}
	lines.push("---", "");
	lines.push(`# Goal ${record.id}`, "");
	lines.push(MANAGED_SECTION_MARKER);
	lines.push(...renderManagedBody(record));
	lines.push("");
	lines.push(AGENT_SECTION_BEGIN);
	const trimmed = agentSection.trim();
	lines.push(trimmed === "" ? "<!-- no agent notes -->" : trimmed);
	lines.push(AGENT_SECTION_END, "");
	return lines.join("\n");
}

/** The loop-owned body: one line per machine-read field, plus tables. */
function renderManagedBody(record: GoalRecord): string[] {
	const out: string[] = [
		`- status: ${record.status}`,
		`- iterations: ${record.iterations}`,
		`- windowIterations: ${record.windowIterations}`,
		`- resets: ${record.resets}`,
		`- generation: ${record.generation}`,
		`- lastCheckpoint: ${record.lastCheckpoint}`,
		`- nextAction: ${record.nextAction || "(none)"}`,
		`- worktree: ${record.worktree ?? "(none)"}`,
		`- branch: ${record.branch ?? "(none)"}`,
		`- pr: ${record.pr ? `#${record.pr.number} (${record.pr.state})` : "(none)"}`,
		`- blocker: ${record.blocker ?? "(none)"}`,
		`- model: ${record.config.model}`,
		`- rolloverTokens: ${record.config.rolloverTokens}`,
		`- maxIterations: ${record.config.maxIterations}`,
		"",
		"## Acceptance criteria",
		"",
	];
	if (record.criteria.length === 0) {
		out.push("(none yet)");
	} else {
		out.push("| id | criterion | verifier |", "| --- | --- | --- |");
		for (const c of record.criteria) {
			const verifier =
				c.verifier.kind === "command"
					? `command \`${c.verifier.argv.join(" ")}\` (exit ${c.verifier.expectExit})`
					: "inspect";
			out.push(`| ${c.id} | ${c.text} | ${verifier} |`);
		}
	}
	out.push("", "## Verification evidence", "");
	if (record.verification.length === 0) {
		out.push("(none yet)");
	} else {
		out.push("| criterion | result | evidence | checkedAt |", "| --- | --- | --- | --- |");
		for (const v of record.verification) {
			out.push(`| ${v.criterionId} | ${v.result} | ${v.evidenceRef} | ${v.checkedAt} |`);
		}
	}
	out.push("", "## Steering", "");
	if (record.steering.length === 0) {
		out.push("(none)");
	} else {
		for (const s of record.steering) out.push(`- ${s}`);
	}
	return out;
}

/** The agent-owned body text, or `""` when the markers are absent. */
export function extractAgentSection(text: string): string {
	const start = text.indexOf(AGENT_SECTION_BEGIN);
	const end = text.indexOf(AGENT_SECTION_END);
	if (start < 0 || end < 0 || end < start) return "";
	return text
		.slice(start + AGENT_SECTION_BEGIN.length, end)
		.replace(/^<!-- no agent notes -->\s*$/, "")
		.trim();
}
