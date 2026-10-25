/**
 * Authoritative acceptance check for the CodeFlow false-positive filter.
 *
 * Check 1 replays `sanitizeAnalysisData` on a *recording* of the pinned
 * analyzer's own output for this repository (see
 * fixtures/generate-real-analysis-fp-fixture.mjs and the fixture header). It is
 * a fast offline regression that pins the real field shapes and the layer
 * guard without a checkout.
 *
 * Check 2 is the authoritative acceptance check and runs by default: it drives
 * the *live* pinned analyzer through the headless producer against a
 * `git archive HEAD` snapshot, then asserts the generated report.json scores an
 * A and carries none of the false positives. When no checkout is present it
 * fetches the pinned revision itself. Point it at a local checkout instead with
 * `CODEFLOW_UI_DIR=/path/to/codeflow`; opt out of the network fetch with
 * `CODEFLOW_FP_E2E=0` (the test then skips if no checkout is present).
 */

import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const RUNNER = join(REPO_ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs");
const FILTER = join(REPO_ROOT, "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");
const FIXTURE = join(HERE, "fixtures", "codeflow-real-analysis-fp.json");
const PINNED_REF = "b0e82d127fc4990f571ebc6da6c5d9af2591aaa1";
const CHECKOUT_URL = "https://github.com/braedonsaunders/codeflow";

// The revision this issue reports on. Pinning the live acceptance run to it
// (not HEAD) means the assertions reproduce the affected report rather than
// whatever the branch happens to be.
const ISSUE_SNAPSHOT = "17c991c033073dccdd549c335abe6c594643b009";
const EXPECTED_LAYER_VIOLATIONS_SUPPRESSED = 357;
// The dead-code report on that snapshot: 45 entries, of which the 20 the issue
// lists in the Rust/TS sources are referenced by the snapshot (trait-impl
// methods dispatched cross-file, function-as-value bindings). The rest name
// symbols no analyzed file references.
const EXPECTED_DEAD_SUPPRESSED = 20;
// Symbols the issue cites as dead that the snapshot does carry.
const CITED_DEAD = [
	"defaultIsWritable",
	"opened",
	"is_open",
	"reconnect_delay",
	"read_cursor",
	"write_cursor",
];
// The filtered report these expectations imply.
const EXPECTED_HEALTH_SCORE = 93;

// Issue #2023: the four sites whose MEDIUM `Command Execution` finding must be
// resolved on the fixed tree. Each spawn forwards an argv array through the
// shared policy, and the one site that also forwards an environment routes it
// through the policy's `sanitizeSpawnEnv` — so no cited file carries an
// execution channel the static proof cannot see, and none may keep the finding.
const CITED_COMMAND_EXECUTION_PATHS = [
	".pi/extensions/context-info/codeflow.ts",
	".pi/extensions/lsp-auditor/lsp-client/audit-group.ts",
	".pi/extensions/lsp-auditor/lsp-client/runtime.ts",
	".pi/extensions/supervisor/agent/runner/spawn.ts",
];
// The fixed tree suppresses 9 HIGH + 4 MEDIUM (the four cited paths). A live run
// over the moving tree must never drop below it.
const MIN_SECURITY_SUPPRESSED = 16;

const requireCjs = createRequire(import.meta.url);
const { sanitizeAnalysisData, isFalsePositiveHygiene, readFileFrom } = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
		opts?: { deriveSuggestions?: (filtered: any) => unknown },
	) => {
		data: any;
		suppressed: {
			security: any[];
			layerViolations: any[];
			hygiene: any[];
			deadCode: any[];
			suggestions: any[];
		};
	};
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
};
const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

const cleanups: string[] = [];
after(() => {
	for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
// A layer label is real only when the endpoint path carries it as a directory.
const groundsLayer = (layer: string, p: string): boolean =>
	p.toLowerCase().split("/").slice(0, -1).includes(String(layer).toLowerCase());

const highsOf = (data: { securityIssues: Array<{ severity: string }> }) =>
	data.securityIssues.filter((s) => String(s.severity).toLowerCase() === "high");
const deadNames = (data: { deadFunctions?: Array<{ name: string }> }): string[] =>
	(Array.isArray(data.deadFunctions) ? data.deadFunctions : []).map((f) => f.name);
// The analyzer's architecture summary names the dead list as a bare count.
const deadTitle = (data: { issues?: Array<{ title?: string }> }): string | undefined =>
	(Array.isArray(data.issues) ? data.issues : [])
		.map((i) => String(i.title))
		.find((t) => /^\d+ Unused Functions$/.test(t));

// The LOW hygiene heuristics (`Code Comments` / `Debug Statements`).
const HYGIENE_TITLES = new Set(["Code Comments", "Debug Statements"]);
const isLowHygiene = (s: { severity?: string; title?: string }) =>
	String(s.severity).toLowerCase() === "low" && HYGIENE_TITLES.has(String(s.title));
const lowsOf = (data: { securityIssues: Array<{ severity?: string; title?: string }> }) =>
	data.securityIssues.filter(isLowHygiene);

// The shipping sources the issue cites, plus the two shipping doc/config files
// whose placeholder and planned-work markers were reworded by hand.
const HYGIENE_REWORDS = [
	".pi/extensions/ask-user/jsonl-logger.ts",
	".pi/extensions/structural-analyzer/validate.ts",
	".pi/extensions/structural-analyzer/index.ts",
	".pi/extensions/ripgrep-search/index.ts",
	".pi/extensions/scrapling/README.md",
	"docs/_config.yml",
];
const MARKERS = /\b(TODO|FIXME|HACK|XXX{2,})\b/;
const repoFile = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");
const crossLanguageOf = (data: { layerViolations: Array<{ from: string; to: string }> }) =>
	data.layerViolations.filter((v) => ext(v.from) !== ext(v.to));
const sameExtensionOf = (data: { layerViolations: Array<{ from: string; to: string }> }) =>
	data.layerViolations.filter((v) => ext(v.from) === ext(v.to));
const inventedLayerOf = (data: {
	layerViolations: Array<{ from: string; to: string; fromLayer: string; toLayer: string }>;
}) =>
	data.layerViolations.filter(
		(v) => !groundsLayer(v.fromLayer, v.from) || !groundsLayer(v.toLayer, v.to),
	);

/** The cited MEDIUM `Command Execution` hits that must not survive the filter. */
const commandExecutionOf = (data: { securityIssues: Array<{ title: string; path: string }> }) =>
	data.securityIssues.filter(
		(s) =>
			String(s.title).trim() === "Command Execution" &&
			CITED_COMMAND_EXECUTION_PATHS.includes(s.path),
	);

// The producer's own reader, so the replay below exercises the real path-keyed
// resolution instead of a test-only source expansion: a gap the split opened has
// to fail here exactly as it would in a produced report.
const { makeReadFile } = (await import(RUNNER)) as {
	makeReadFile: (dir: string) => (path: unknown) => string | null;
};
const makeRepoReadFile = (): ((path: unknown) => string | null) => makeReadFile(REPO_ROOT);

const UI_DIR = "cmd/cheasee-pi/embedded/docker/ui";

/** Every `.rs` file under the UI crate: the module children the split minted. */
function rustFiles(): string[] {
	const out: string[] = [];
	const walk = (abs: string, rel: string): void => {
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			const next = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(resolve(abs, entry.name), next);
			else if (entry.name.endsWith(".rs")) out.push(next);
		}
	};
	walk(resolve(REPO_ROOT, UI_DIR), UI_DIR);
	return out;
}

/**
 * The served page's `files[]`: raw text only (`content` freed, text on
 * `piFpSource`), plus the split's Rust children as their own entries. Resolving a
 * facade to its module is `readFileFrom`'s job, not this fixture's.
 */
function servedShape(recorded: { files: Array<{ path: string }> }) {
	const raw = (rel: string): string | null => {
		try {
			return readFileSync(resolve(REPO_ROOT, rel), "utf8");
		} catch {
			return null;
		}
	};
	const files = recorded.files.map((f) => ({
		path: f.path,
		content: null,
		piFpSource: raw(f.path),
	}));
	const seen = new Set(files.map((f) => f.path));
	for (const rel of rustFiles()) {
		if (!seen.has(rel)) files.push({ path: rel, content: null, piFpSource: raw(rel) });
	}
	return { ...recorded, files };
}

describe("fp-filter — acceptance against pinned-analyzer output", () => {
	// Always runs: the recording is real analyzer output, so this is the
	// non-skipped score/no-invented-layer assertion the audit asked for.
	it("recorded pinned-analyzer output scores an A with no false positives", () => {
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
		assert.strictEqual(
			recorded.provenance.ref,
			PINNED_REF,
			"the recording must come from the pinned CodeFlow revision",
		);

		// Guard: the recording is only meaningful if it actually holds the false
		// positives the issue and the previous audit found (else the assertions
		// below would pass vacuously).
		assert.ok(highsOf(recorded).length >= 9, "recording must carry the HIGH security hits");
		assert.deepStrictEqual(
			commandExecutionOf(recorded)
				.map((s) => s.path)
				.sort(),
			[...CITED_COMMAND_EXECUTION_PATHS].sort(),
			"recording must carry the four cited MEDIUM Command Execution hits",
		);
		assert.ok(crossLanguageOf(recorded).length > 0, "recording must carry cross-language edges");
		assert.ok(
			sameExtensionOf(recorded).length > 0,
			"recording must carry same-extension edges so suppression is not only cross-language",
		);
		assert.ok(inventedLayerOf(recorded).length > 0, "recording must carry invented-layer edges");
		for (const name of CITED_DEAD) {
			assert.ok(
				deadNames(recorded).includes(name),
				`recording must carry the cited dead function ${name}`,
			);
		}
		assert.strictEqual(
			deadTitle(recorded),
			"44 Unused Functions",
			"recording must carry the analyzer's count-only architecture summary",
		);

		const before = calcHealth(recorded);
		assert.ok(before.score < 90, `before-filter score should not already pass: ${before.score}`);

		const { data, suppressed } = sanitizeAnalysisData(recorded, makeRepoReadFile());
		assert.ok(suppressed.security.length >= 9, "every HIGH security hit must be suppressed");
		assert.strictEqual(
			suppressed.layerViolations.length,
			recorded.layerViolations.length,
			"the whole real layer category is noise",
		);

		assert.deepStrictEqual(highsOf(data), [], "no HIGH security finding may survive");
		// The recording is the pre-fix analyzer output, but the filter reads the
		// files on disk — the fixed ones. Every cited spawn routes its argv through
		// the shared policy and its environment (where it has one) through
		// `sanitizeSpawnEnv`, so the whole-file finding is a proven false positive.
		assert.deepStrictEqual(
			commandExecutionOf(data).map((s: { path: string }) => s.path),
			[],
			"every cited Command Execution hit is a proven false positive",
		);
		assert.deepStrictEqual(
			crossLanguageOf(data),
			[],
			"cross-language layer edges must not survive",
		);
		assert.deepStrictEqual(inventedLayerOf(data), [], "invented layer labels must not survive");
		assert.strictEqual(
			data.stats.violations,
			0,
			"the summary violation count must move with the list",
		);

		// The recorded dead list carries the issue's cited symbols; every one the
		// snapshot references must be dropped and counted out of the summary.
		assert.ok(suppressed.deadCode.length > 0, "the recording must exercise the dead-code rule");
		for (const name of CITED_DEAD) {
			assert.ok(
				suppressed.deadCode.some((f: { name: string }) => f.name === name),
				`${name} is referenced by the snapshot and must be suppressed`,
			);
			assert.ok(!deadNames(data).includes(name), `${name} must not survive as dead`);
		}
		assert.strictEqual(
			data.stats.dead,
			data.deadFunctions.length,
			"the summary count must agree with the surviving list",
		);
		assert.strictEqual(
			deadTitle(data),
			`${data.stats.dead} Unused Functions`,
			"the count-only architecture summary must restate the surviving list",
		);

		const after = calcHealth(data);
		assert.ok(after.score >= 90, `expected an A (>= 90), got ${after.score} (${after.grade})`);
		assert.strictEqual(after.grade, "A");
	});

	// Issue #2030: the recording carries the analyzer's derived cards, which name
	// findings the filter is about to drop. `Parser.generateSuggestions` is the only
	// derivation policy and it lives in the pinned checkout, so the replay injects a
	// stub (never a copy of the rules) and proves the pipeline contract: stale cards
	// are dropped, and a deriver's verdict replaces them whole.
	it("re-derives the recorded suggestion cards instead of shipping stale ones", () => {
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
		assert.ok(
			Array.isArray(recorded.suggestions) && recorded.suggestions.length > 0,
			"the recording must carry the derived cards the issue reports",
		);
		const stale = recorded.suggestions.map((s: { title: string }) => s.title);
		assert.ok(stale.includes("Fix Security Issues"), stale.join(", "));
		assert.ok(stale.includes("Fix Architecture Violations"), stale.join(", "));

		// No deriver: fail closed, and record what was dropped.
		const failClosed = sanitizeAnalysisData(recorded, makeRepoReadFile());
		assert.deepStrictEqual(failClosed.data.suggestions, [], "stale cards are never shipped");
		assert.deepStrictEqual(
			failClosed.suppressed.suggestions,
			recorded.suggestions,
			"the dropped cards must be recorded, never silently lost",
		);

		// With a deriver: its verdict replaces the recorded cards whole.
		const kept = [{ title: "Remove Dead Code", desc: "unused functions detected." }];
		const { data } = sanitizeAnalysisData(recorded, makeRepoReadFile(), {
			deriveSuggestions: () => kept,
		});
		assert.deepStrictEqual(data.suggestions, kept);
		// The contradiction the stale cards named is real on this very replay: the
		// filter has already emptied the arrays those cards counted.
		assert.deepStrictEqual(highsOf(data), [], "the card claimed highs the export cannot show");
		assert.deepStrictEqual(
			data.layerViolations,
			[],
			"the card claimed edges the export cannot show",
		);
	});

	it("keeps the four cited files free of any shell-executing construct", () => {
		// Positive controls: the patterns must catch a real shell-out, so the file
		// assertions below cannot pass vacuously.
		assert.match("spawn(x, y, { shell: true });", /\bshell\s*:\s*(?!false\b)/);
		assert.match("execSync(cmd);", /\bexecSync\b/);
		// A future edit that reintroduces a shell would make the whole-file finding
		// true again; pin the seam shut at the source level.
		for (const rel of CITED_COMMAND_EXECUTION_PATHS) {
			const source = repoFile(rel);
			assert.doesNotMatch(source, /\bshell\s*:\s*(?!false\b)/, `${rel} must not ask for a shell`);
			assert.doesNotMatch(source, /\bexecSync\b/, `${rel} must not call execSync`);
		}
	});

	// The served page does not read the filesystem, and its analyzer frees every
	// file's source before `generateReport` runs. server.py rewrites that line to
	// keep the text on `files[].piFpSource`, so the in-page filter resolves the
	// same list the headless runner does. Replay that exact shape here: the filter
	// gets no disk read, only the recorded paths and their retained source.
	it("resolves the recorded dead list from the served browser shape", () => {
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const served = servedShape(recorded);

		const { data, suppressed } = sanitizeAnalysisData(served, readFileFrom(served));
		for (const name of CITED_DEAD) {
			assert.ok(
				suppressed.deadCode.some((f: { name: string }) => f.name === name),
				`${name} must be suppressed from the served browser shape`,
			);
			assert.ok(!deadNames(data).includes(name), `${name} must not survive as dead`);
		}
		assert.strictEqual(
			data.stats.dead,
			data.deadFunctions.length,
			"the count must agree with the list",
		);
	});

	it("suppresses every LOW hygiene finding the recording carries", () => {
		const recorded = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const lows = lowsOf(recorded);
		assert.ok(
			lows.length > 0,
			"the recording must carry the LOW hygiene findings the issue reports",
		);
		// Regenerated after the source rewords, the recording cites only test and
		// doc artifacts, so the hygiene rule accounts for all of them.
		const { data, suppressed } = sanitizeAnalysisData(recorded, makeRepoReadFile());
		assert.strictEqual(
			suppressed.hygiene.length,
			lows.length,
			"every LOW hygiene finding on an artifact path must be suppressed",
		);
		assert.deepStrictEqual(lowsOf(data), [], "no LOW hygiene finding may survive into the report");
		// And none of them may cite a reworded shipping source any more.
		const reworded = new Set(HYGIENE_REWORDS);
		for (const finding of lowsOf(recorded)) {
			assert.ok(!reworded.has(finding.path), `rewritten source still flagged: ${finding.path}`);
		}
	});

	it("the cited shipping sources carry no raw marker token (the rewords landed)", () => {
		for (const rel of HYGIENE_REWORDS) {
			assert.doesNotMatch(repoFile(rel), MARKERS, `${rel} must not carry a deferred-work token`);
		}
	});

	it("keeps the fixtures and teaching content the tokens belong to", () => {
		// Blind token stripping would break these: they are fixture data, worked
		// examples and the `mktemp` template, not deferred work.
		assert.match(
			repoFile(".pi/extensions/structural-analyzer/test/index.test.mts"),
			/console\.log\(/,
		);
		assert.match(repoFile(".pi/extensions/ripgrep-search/test/ripgrep-search.test.mts"), MARKERS);
		assert.match(
			repoFile(".pi/extensions/supervisor/test/pipeline-worktree-integration.test.mts"),
			/XXXXXX/,
		);
		for (const skill of [
			".pi/skills/audit-clean-code/SKILL.md",
			".pi/skills/audit-code-simplification/SKILL.md",
		]) {
			assert.match(repoFile(skill), MARKERS, `${skill} must keep its teaching content`);
		}
	});
});

describe("fp-filter — live acceptance against the pinned analyzer", () => {
	/** The issue revision, fetched when this checkout does not already carry it. */
	function ensureIssueSnapshot(): string {
		try {
			execFileSync("git", ["cat-file", "-e", `${ISSUE_SNAPSHOT}^{commit}`], {
				cwd: REPO_ROOT,
				stdio: "ignore",
			});
		} catch {
			execFileSync("git", ["fetch", "--depth", "1", "origin", ISSUE_SNAPSHOT], {
				cwd: REPO_ROOT,
				stdio: "ignore",
				timeout: 180_000,
			});
		}
		return ISSUE_SNAPSHOT;
	}

	/** A usable pinned checkout, or null when none is present and none was fetched. */
	function resolveCheckout(): string | null {
		const explicit = process.env.CODEFLOW_UI_DIR || "/opt/codeflow-ui";
		if (
			existsSync(join(explicit, "index.html")) &&
			existsSync(join(explicit, "card", "lib", "analysis.js"))
		) {
			return explicit;
		}
		// Fetch the pin by default so the authoritative check actually runs; an
		// offline environment skips below, and CODEFLOW_FP_E2E=0 opts out.
		if (process.env.CODEFLOW_FP_E2E === "0") return null;
		const dir = mkdtempSync(join(tmpdir(), "fp-accept-ui-"));
		cleanups.push(dir);
		try {
			execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", CHECKOUT_URL, dir], {
				stdio: "ignore",
				timeout: 180_000,
			});
			execFileSync("git", ["-C", dir, "fetch", "--depth", "1", "origin", PINNED_REF], {
				stdio: "ignore",
				timeout: 180_000,
			});
			execFileSync("git", ["-C", dir, "checkout", "--detach", "FETCH_HEAD"], { stdio: "ignore" });
		} catch {
			return null;
		}
		return existsSync(join(dir, "card", "lib", "analysis.js")) ? dir : null;
	}

	const UI_DIR = resolveCheckout();
	const SKIP =
		"pinned CodeFlow checkout unavailable (set CODEFLOW_UI_DIR, or CODEFLOW_FP_E2E=0 to skip)";

	it(
		"headless report on the issue snapshot scores an A and drops every false positive",
		{ skip: UI_DIR ? false : SKIP },
		() => {
			const snapshotDir = mkdtempSync(join(tmpdir(), "fp-accept-snap-"));
			const outDir = mkdtempSync(join(tmpdir(), "fp-accept-out-"));
			cleanups.push(snapshotDir, outDir);

			// Deterministic snapshot: the exact revision the issue reports on, fed to
			// the producer the way the shim feeds it.
			const archive = execFileSync("git", ["archive", ensureIssueSnapshot()], {
				cwd: REPO_ROOT,
				maxBuffer: 1 << 30,
			});
			execFileSync("tar", ["-x", "-C", snapshotDir], { input: archive });

			const run = spawnSync(process.execPath, [RUNNER, snapshotDir, UI_DIR!, outDir], {
				encoding: "utf-8",
				timeout: 300_000,
			});
			assert.strictEqual(run.status, 0, `producer failed:\n${run.stderr}`);

			// The producer reports suppression instead of dropping silently, and the
			// counts must reproduce the affected report's false positives exactly.
			const suppressed =
				/fp-filter: suppressed (\d+) security issue\(s\), (\d+) layer violation\(s\), (\d+) hygiene finding\(s\), (\d+) unused function\(s\)/.exec(
					run.stderr,
				);
			assert.ok(suppressed, `the producer must report what it dropped:\n${run.stderr}`);
			// The live run reads the *snapshot's* files — the pre-fix ones — so the
			// argv-safety rule has nothing to prove there and keeps those MEDIUM hits.
			// Only the HIGH findings are tree-independent.
			assert.ok(
				Number(suppressed![1]) >= 9,
				"every HIGH security hit must be suppressed on the issue snapshot",
			);
			assert.strictEqual(
				Number(suppressed![2]),
				EXPECTED_LAYER_VIOLATIONS_SUPPRESSED,
				"the whole layer-violation category must be suppressed on the issue snapshot",
			);
			assert.ok(
				Number(suppressed![3]) > 0,
				"the issue snapshot's LOW hygiene findings on artifact paths must be reported",
			);
			assert.strictEqual(
				Number(suppressed![4]),
				EXPECTED_DEAD_SUPPRESSED,
				"every cited dead function the snapshot references must be suppressed",
			);

			const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
			assert.strictEqual(
				report.summary.healthScore,
				EXPECTED_HEALTH_SCORE,
				`expected the corrected score, got ${report.summary.healthScore} (${report.summary.healthGrade})`,
			);
			assert.ok(report.summary.healthScore >= 90, "the corrected score must be an A");
			assert.strictEqual(report.summary.healthGrade, "A");
			assert.deepStrictEqual(highsOf(report), [], "no HIGH security finding may remain");
			assert.deepStrictEqual(
				crossLanguageOf(report),
				[],
				"cross-language layer edges must not be emitted",
			);
			assert.deepStrictEqual(
				inventedLayerOf(report),
				[],
				"unsupported layer labels must not survive",
			);
			// The snapshot predates the source rewords, so a LOW marker in shipping
			// source legitimately stays; nothing the hygiene rule classifies as a test
			// or doc artifact may survive it.
			for (const finding of report.securityIssues) {
				assert.strictEqual(
					isFalsePositiveHygiene(finding),
					false,
					`a LOW hygiene artifact survived the filter: ${finding.path}`,
				);
			}

			// The report must not contradict its own score: the summary counts move
			// with the filtered arrays, or an A still advertises nine HIGH findings.
			assert.strictEqual(
				report.summary.highSecurityIssues,
				0,
				"summary must not still count the dropped highs",
			);
			assert.strictEqual(
				report.summary.layerViolations,
				0,
				"summary must not still count the dropped edges",
			);

			// Same for the dead-code list: none of the cited live symbols may be
			// reported as unused, and the summary count must match the list.
			const reportedDead = (report.unusedFunctions ?? []).map((f: { name: string }) => f.name);
			for (const name of CITED_DEAD) {
				assert.ok(
					!reportedDead.includes(name),
					`${name} is referenced and must not be reported as unused`,
				);
			}
			assert.strictEqual(
				report.summary.unusedFunctions,
				report.unusedFunctions.length,
				"the summary dead count must agree with the reported list",
			);

			// Issue #2030: a derived card may not outlive the array it summarizes.
			// Each card's own source is read off this export, so a card whose source is
			// empty fails here instead of shipping a count the report cannot back. Cards
			// whose source survives (`Extract Duplicated Code`, `Resolve Naming
			// Conflicts` — one code group and three name groups survive on this
			// snapshot) are honest and stay.
			const cardSources: Record<string, number> = {
				"Fix Security Issues": highsOf(report).length,
				"Fix Architecture Violations": (report.layerViolations ?? []).length,
				"Extract Duplicated Code": (report.duplicates ?? []).filter(
					(d: { type?: string }) => d.type === "code",
				).length,
				"Resolve Naming Conflicts": (report.duplicates ?? []).filter(
					(d: { type?: string }) => d.type === "name",
				).length,
			};
			const cards = (report.suggestions ?? []).map((s: { title: string }) => s.title);
			for (const title of cards) {
				const source = cardSources[title];
				if (source === undefined) continue;
				assert.ok(source > 0, `card "${title}" survived over an empty source array`);
			}
			// Both emptied arrays must therefore have lost their card.
			assert.strictEqual(cardSources["Fix Security Issues"], 0);
			assert.strictEqual(cardSources["Fix Architecture Violations"], 0);
			assert.ok(!cards.includes("Fix Security Issues"), cards.join(", "));
			assert.ok(!cards.includes("Fix Architecture Violations"), cards.join(", "));
		},
	);

	// Issue #2023: the authoritative fixed-tree re-run. The snapshot test above
	// reproduces the pre-fix report; this one drives the pinned analyzer over
	// `git archive HEAD` (the fixed tree) and requires every cited MEDIUM
	// `Command Execution` finding to be gone. Counts are contract assertions, not
	// literals — the raw layer count moves with every commit on the branch.
	it(
		"headless report on the fixed tree resolves the four cited Command Execution hits",
		{ skip: UI_DIR ? false : SKIP },
		() => {
			const snapshotDir = mkdtempSync(join(tmpdir(), "fp-accept-snap-"));
			const outDir = mkdtempSync(join(tmpdir(), "fp-accept-out-"));
			cleanups.push(snapshotDir, outDir);

			const archive = execFileSync("git", ["archive", "HEAD"], {
				cwd: REPO_ROOT,
				maxBuffer: 1 << 30,
			});
			execFileSync("tar", ["-x", "-C", snapshotDir], { input: archive });

			const run = spawnSync(process.execPath, [RUNNER, snapshotDir, UI_DIR!, outDir], {
				encoding: "utf-8",
				timeout: 300_000,
			});
			assert.strictEqual(run.status, 0, `producer failed:\n${run.stderr}`);

			const suppressed =
				/fp-filter: suppressed (\d+) security issue\(s\), (\d+) layer violation\(s\), (\d+) hygiene finding\(s\), (\d+) unused function\(s\)/.exec(
					run.stderr,
				);
			assert.ok(suppressed, `the producer must report what it dropped:\n${run.stderr}`);
			assert.ok(
				Number(suppressed![1]) >= MIN_SECURITY_SUPPRESSED,
				"HIGH + cited-MEDIUM security false positives must be suppressed on the fixed tree",
			);
			assert.ok(Number(suppressed![2]) > 0, "the layer-violation category must be suppressed");

			const report = JSON.parse(readFileSync(join(outDir, "report.json"), "utf-8"));
			assert.deepStrictEqual(
				commandExecutionOf(report).map((s: { path: string }) => s.path),
				[],
				"no cited Command Execution finding may survive on the fixed tree",
			);
			assert.deepStrictEqual(highsOf(report), [], "no HIGH security finding may remain");
			assert.deepStrictEqual(
				report.layerViolations,
				[],
				"no layer violation may survive the filter",
			);
			// 89 (B) is the measured ceiling: MEDIUM findings outside this issue stay
			// (the filter's own file, `lib/exec-env.ts`), and the health term counts
			// them.
			assert.ok(
				report.summary.healthScore >= 89,
				`the corrected score must stay at or above the measured 89 (B): ${report.summary.healthScore} (${report.summary.healthGrade})`,
			);
		},
	);
});
