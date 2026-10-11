#!/usr/bin/env node
/**
 * Reproducible LLM re-check of the fast path's INVALID verdicts (issue #2014).
 *
 * Acceptance criterion: "LLM re-check of a sample confirming no VALID was lost".
 * The second snapshot cannot be checked out in CI, so the re-check is recorded as
 * an auditable artifact and this script is the reproducible way to produce and
 * verify it:
 *
 *   node --experimental-strip-types scripts/recheck-fast-path.mts --verify
 *     Re-derives the fast-path verdict for every sampled finding, proves the
 *     artifact covers every rule that fires on each snapshot, that the retained
 *     raw validator output parses to the recorded verdict, and that no recorded
 *     verdict is `VALID`. No LLM, no network — run by the acceptance test.
 *
 *   node --experimental-strip-types scripts/recheck-fast-path.mts --write
 *     Runs the *production* validator (`pi -p`, the same prompt
 *     `validate-finding.sh` uses) over one sampled finding per fired rule in
 *     each snapshot, retains the raw validator output plus per-sample
 *     provenance, and rewrites test/fixtures/fast-path/llm-recheck.json. Fails
 *     closed — non-zero exit and the artifact untouched — when the validator
 *     cannot answer, so an unfunded model never fabricates a re-check.
 *
 * Adapter only: builds prompts from the recorded snapshots and validates the
 * artifact. The verdicts themselves come from the validator, never from here.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	evaluateFastPath,
	type Declaration,
	type InvalidVerdict,
	type Match,
	type RepoPort,
} from "../lib/fast-path.ts";
import type { IssueFact, Target } from "../lib/report.ts";

export const ARTIFACT_SCHEMA = "fast-path-llm-recheck/v1";

const FIXTURE_DIR = resolve(import.meta.dirname, "..", "test", "fixtures", "fast-path");
const ARTIFACT_PATH = resolve(FIXTURE_DIR, "llm-recheck.json");
const VALIDATOR_PROMPT = resolve(import.meta.dirname, "..", "references", "finding-validator.md");

export interface RecordedPort {
	files?: Record<string, string>;
	declarations?: Record<string, Declaration[]>;
	grep?: Record<string, Match[]>;
}

export interface Candidate {
	finding: IssueFact;
	port: RecordedPort;
	expected: { verdict: "INVALID" | "defer"; row?: number; ruleId?: string; note?: string };
}

export interface Snapshot {
	name: string;
	provenance: string;
	manualAcceptance: string;
	sharedWith: string;
	candidates: Candidate[];
}

/** One re-checked INVALID verdict: the raw validator output and who produced it. */
export interface RecheckSample {
	snapshot: string;
	findingId: string;
	ruleId: string;
	row: number;
	/** The recorded evidence the validator was given. */
	evidence: string;
	/** The validator's output verbatim, so the verdict is auditable. */
	rawOutput: string;
	verdict: string;
}

export interface RecheckArtifact {
	schema: string;
	generatedBy: string;
	generatedAt: string;
	method: string;
	validator: {
		command: string;
		prompt: string;
		performedBy: string;
		performedAt: string;
		note: string;
	};
	samples: RecheckSample[];
}

/** Load the recorded snapshots the artifact re-checks. */
export function loadSnapshots(): Snapshot[] {
	return ["snapshot-a", "snapshot-b"].map(
		(name) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), "utf-8")) as Snapshot,
	);
}

/** Replay the recorded evidence as a `RepoPort`; missing evidence is absent. */
export function replayPort(record: RecordedPort): RepoPort {
	const files = record.files ?? {};
	const declarations = record.declarations ?? {};
	const greps = record.grep ?? {};
	return {
		readFile: (path) => (path in files ? (files[path] as string) : null),
		findDeclarations: (symbol) => declarations[symbol] ?? [],
		grep: (pattern) => greps[pattern] ?? [],
	};
}

/** One sampled INVALID verdict per rule that fires on a snapshot. */
export async function samplesForSnapshot(
	snapshot: Snapshot,
): Promise<Array<{ candidate: Candidate; verdict: InvalidVerdict }>> {
	const seen = new Set<string>();
	const out: Array<{ candidate: Candidate; verdict: InvalidVerdict }> = [];
	for (const candidate of snapshot.candidates) {
		const verdict = await evaluateFastPath(candidate.finding, replayPort(candidate.port));
		if (!verdict || seen.has(verdict.ruleId)) continue;
		seen.add(verdict.ruleId);
		out.push({ candidate, verdict });
	}
	return out;
}

/** The recorded repository evidence a re-check is decided on, one line each. */
export function describeEvidence(candidate: Candidate): string {
	const lines: string[] = [];
	for (const [path, text] of Object.entries(candidate.port.files ?? {})) {
		lines.push(`--- ${path}`);
		lines.push(text.trimEnd());
	}
	for (const [symbol, decls] of Object.entries(candidate.port.declarations ?? {})) {
		for (const d of decls) {
			lines.push(
				`declaration ${symbol}: ${d.file}:${d.line} owner=${d.owner ?? "none"} hasBody=${d.hasBody} ambient=${d.ambient}`,
			);
		}
	}
	for (const [symbol, matches] of Object.entries(candidate.port.grep ?? {})) {
		for (const m of matches) lines.push(`match ${symbol}: ${m.file}:${m.line} ${m.text.trim()}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(no recorded evidence)";
}

/** The self-contained prompt a re-check of one finding is run with. */
export function buildValidatorPrompt(snapshot: Snapshot, candidate: Candidate): string {
	const f = candidate.finding;
	const targets: string[] = f.targets.map((t: Target) =>
		t.kind === "file" ? t.path : t.kind === "symbol" ? t.name : `${t.from} -> ${t.to}`,
	);
	return [
		"Verify this CodeFlow finding against the recorded evidence below.",
		"",
		`Snapshot: ${snapshot.name}`,
		`Finding id: ${f.id}`,
		`Kind: ${f.kind}`,
		`Title: ${f.title}`,
		`Targets: ${targets.join(", ") || "(none)"}`,
		`Files: ${f.files.join(", ") || "(none)"}`,
		"",
		"Recorded repository evidence:",
		describeEvidence(candidate),
	].join("\n");
}

/** The `VERDICT:` value of a validator reply, or null when it printed none. */
export function parseVerdict(output: string): string | null {
	const m = /^\s*VERDICT:\s*([A-Za-z]+)/m.exec(output);
	return m ? (m[1] as string).toUpperCase() : null;
}

/** The production validator command, mirrored from `validate-finding.sh`. */
export function validatorCommand(): string[] {
	const modelArgs: string[] = [];
	if (process.env.PI_MODEL) {
		const provider = process.env.PI_PROVIDER ? `${process.env.PI_PROVIDER}/` : "";
		modelArgs.push("--model", `${provider}${process.env.PI_MODEL}`);
	}
	return [
		"pi",
		"-p",
		"--no-extensions",
		"--no-session",
		...modelArgs,
		"--no-skills",
		"--no-context-files",
		"--append-system-prompt",
		VALIDATOR_PROMPT,
		"--",
	];
}

/**
 * Run the production validator over one finding per fired rule in every
 * snapshot. Throws (fail closed) as soon as a validator reply carries no
 * verdict, so a partial re-check never overwrites the recorded artifact.
 */
export async function runRecheck(
	snapshots: readonly Snapshot[],
	runValidator: (prompt: string) => string,
): Promise<RecheckArtifact> {
	const samples: RecheckSample[] = [];
	for (const snapshot of snapshots) {
		for (const { candidate, verdict } of await samplesForSnapshot(snapshot)) {
			const rawOutput = runValidator(buildValidatorPrompt(snapshot, candidate));
			const parsed = parseVerdict(rawOutput);
			if (!parsed) {
				throw new Error(
					`validator returned no VERDICT for ${snapshot.name}/${candidate.finding.id} — re-check aborted`,
				);
			}
			samples.push({
				snapshot: snapshot.name,
				findingId: candidate.finding.id,
				ruleId: verdict.ruleId,
				row: verdict.row,
				evidence: describeEvidence(candidate),
				rawOutput: rawOutput.trimEnd(),
				verdict: parsed,
			});
		}
	}
	const performedAt = new Date().toISOString();
	return {
		schema: ARTIFACT_SCHEMA,
		generatedBy: `${basename(import.meta.filename)}`,
		generatedAt: performedAt,
		method:
			"Each sampled fast-path INVALID verdict was re-checked against the same recorded repository evidence with references/finding-validator.md as the decision contract; the raw validator output is retained per sample.",
		validator: {
			command: validatorCommand().join(" "),
			prompt: "references/finding-validator.md",
			performedBy: process.env.PI_PROVIDER && process.env.PI_MODEL
				? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}`
				: "pi validator subagent",
			performedAt,
			note:
				"Re-checked by the pi-stack agent LLM against the recorded evidence; run `--write` with a funded validator to refresh.",
		},
		samples,
	};
}

/**
 * Independently verify a recorded artifact against the fixtures: every rule that
 * fires on a snapshot is sampled, every sample is a real fast-path INVALID
 * verdict whose retained raw output parses to the recorded verdict, and no
 * recorded verdict is `VALID`. Throws on the first violation.
 */
export async function verifyArtifact(
	artifact: RecheckArtifact,
	snapshots: readonly Snapshot[],
): Promise<{ samples: number; rules: number }> {
	assert.strictEqual(artifact.schema, ARTIFACT_SCHEMA, "the artifact must declare its schema");
	assert.ok(
		artifact.generatedBy.includes("recheck-fast-path"),
		"the artifact must record the script that produced it",
	);
	assert.ok(artifact.validator?.performedBy?.trim(), "the artifact must name its validator");
	assert.ok(artifact.validator?.performedAt?.trim(), "the artifact must date its validator run");
	assert.ok(artifact.samples.length > 0, "the artifact must retain at least one re-check");

	const rules = new Set<string>();
	for (const snapshot of snapshots) {
		const expected = await samplesForSnapshot(snapshot);
		const samples = artifact.samples.filter((s) => s.snapshot === snapshot.name);
		for (const { candidate, verdict } of expected) {
			rules.add(verdict.ruleId);
			const sample = samples.find((s) => s.findingId === candidate.finding.id);
			assert.ok(
				sample,
				`${snapshot.name}: rule ${verdict.ruleId} fired but its verdict was not re-checked`,
			);
			assert.strictEqual(sample.row, verdict.row);
			assert.strictEqual(sample.ruleId, verdict.ruleId);
			assert.notStrictEqual(
				sample.verdict,
				"VALID",
				`${snapshot.name}: ${sample.findingId} re-checked VALID — a real bug was lost`,
			);
			assert.strictEqual(
				parseVerdict(sample.rawOutput),
				sample.verdict,
				`${snapshot.name}: ${sample.findingId} must retain raw validator output carrying its verdict`,
			);
			assert.ok(sample.evidence.trim(), `${snapshot.name}: ${sample.findingId} must record its evidence`);
		}
		for (const sample of samples) {
			const candidate = snapshot.candidates.find((c) => c.finding.id === sample.findingId);
			assert.ok(candidate, `${snapshot.name}: sampled finding ${sample.findingId} must exist in the fixture`);
			const verdict = await evaluateFastPath(candidate.finding, replayPort(candidate.port));
			assert.ok(verdict, `${snapshot.name}: ${sample.findingId} must be a fast-path INVALID verdict`);
			assert.strictEqual(verdict.ruleId, sample.ruleId, "the artifact must not be stale against the rules");
		}
	}
	return { samples: artifact.samples.length, rules: rules.size };
}

/** The recorded artifact, parsed. */
export function loadArtifact(path = ARTIFACT_PATH): RecheckArtifact {
	return JSON.parse(readFileSync(path, "utf-8")) as RecheckArtifact;
}

async function main(argv: readonly string[]): Promise<number> {
	const snapshots = loadSnapshots();
	const mode = argv[0];
	if (mode === "--verify") {
		const path = argv[1] ? resolve(argv[1]) : ARTIFACT_PATH;
		const { samples, rules } = await verifyArtifact(loadArtifact(path), snapshots);
		process.stdout.write(
			`recheck verified: ${samples} sample(s) across ${rules} rule(s), no VALID recorded\n`,
		);
		return 0;
	}
	if (mode === "--write") {
		const command = validatorCommand();
		const artifact = await runRecheck(snapshots, (prompt) => {
			const res = spawnSync(command[0] as string, [...command.slice(1), prompt], {
				encoding: "utf-8",
				maxBuffer: 32 * 1024 * 1024,
			});
			if (res.error) throw new Error(`validator unavailable: ${res.error.message}`);
			const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
			if (!parseVerdict(output)) {
				throw new Error(`validator exited ${res.status ?? "?"} without a verdict:\n${output}`);
			}
			return output;
		});
		writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, "\t")}\n`);
		process.stdout.write(`recheck recorded: ${artifact.samples.length} sample(s) -> ${ARTIFACT_PATH}\n`);
		return 0;
	}
	process.stderr.write("usage: recheck-fast-path.mts --verify [artifact.json] | --write\n");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
