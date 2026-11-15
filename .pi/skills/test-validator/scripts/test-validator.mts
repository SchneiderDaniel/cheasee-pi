// Composition root for the test-validator skill.
//
// Everything expensive and irreversible is gated here, in this order, before the
// first model call: usage, `.pi/settings.json` `supervisor.repo`, the skill
// config and criteria, the provider API key, `gh auth status`, and only then
// discovery. A failure in any of them halts the run — it is never recorded as a
// per-test pending verdict.
//
// Exit codes: 0 complete, 1 halted/precondition failure, 2 usage or inventory
// failure, 3 incomplete (some tests stayed undecided).

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

import { CRITERIA_IDS } from "../lib/decision.ts";
import { configFingerprint, inventoryFingerprint } from "../lib/fingerprint.ts";
import { DiscoveryError, discoverTests, sha256Hex } from "../lib/inventory.ts";
import { JsonlCheckpointStore } from "../lib/checkpoint.ts";
import { serializeReport } from "../lib/report.ts";
import { RunHaltedError, runValidation } from "../lib/run.ts";
import {
	assertProviderApiKey,
	createPiAiDecisionModel,
} from "../lib/adapters/decision-model-pi-ai.ts";
import { checkGhAuth, createGhIssueFiler, defaultBodyDir } from "../lib/adapters/issue-gh.ts";
import { spawnArgv } from "../../../extensions/lib/safe-argv.ts";
import type {
	ExcludedDefinition,
	InventoryResult,
	TestDefinition,
	ValidatorConfig,
} from "../lib/types.ts";

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_INCOMPLETE = 3;

const USAGE = `test-validator — evidence-based test-quality audit (one model call per test)

usage: node --experimental-strip-types .pi/skills/test-validator/scripts/test-validator.mts [options]

options:
  --restart             archive the existing checkpoint and judge every test again
  --limit <n>           judge at most n tests (pilot; the checkpoint records a truncated inventory)
  --config <path>       config file (default: <skill>/config.json)
  --criteria <path>     criteria file (default: <skill>/criteria.md)
  --report <path>       report output (default: ignore/test-validator/report.json)
  --checkpoint <path>   checkpoint file (default: ignore/test-validator/checkpoint.jsonl)
  --help                print this text and exit 0 without writing anything

exit codes:
  0  every discovered test is GOOD or BAD (report written; at most one issue filed)
  1  halted: precondition, model, checkpoint, or filing failure
  2  usage error or the inventory could not be resolved
  3  incomplete: tests stayed undecided, so no report and no issue were produced
`;

/** Operator-facing failure: the message is the whole output. */
class CliError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number = EXIT_FAILED) {
		super(message);
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

interface CliOptions {
	readonly help: boolean;
	readonly restart: boolean;
	readonly limit: number | undefined;
	readonly configPath: string | undefined;
	readonly criteriaPath: string | undefined;
	readonly reportPath: string | undefined;
	readonly checkpointPath: string | undefined;
}

function parseArgs(argv: readonly string[]): CliOptions {
	const options = {
		help: false,
		restart: false,
		limit: undefined as number | undefined,
		configPath: undefined as string | undefined,
		criteriaPath: undefined as string | undefined,
		reportPath: undefined as string | undefined,
		checkpointPath: undefined as string | undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new CliError(`option ${arg} requires a value`, EXIT_USAGE);
			}
			index += 1;
			return value;
		};
		switch (arg) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--restart":
				options.restart = true;
				break;
			case "--limit": {
				const raw = next();
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isInteger(parsed) || parsed < 1) {
					throw new CliError(`--limit expects a positive integer, got "${raw}"`, EXIT_USAGE);
				}
				options.limit = parsed;
				break;
			}
			case "--config":
				options.configPath = next();
				break;
			case "--criteria":
				options.criteriaPath = next();
				break;
			case "--report":
				options.reportPath = next();
				break;
			case "--checkpoint":
				options.checkpointPath = next();
				break;
			default:
				throw new CliError(`unknown option "${arg}"`, EXIT_USAGE);
		}
	}
	return options;
}

function readSupervisorRepo(cwd: string): string {
	const settingsPath = join(cwd, ".pi", "settings.json");
	if (!existsSync(settingsPath)) {
		throw new CliError(`missing ${settingsPath}; it must set supervisor.repo to "owner/repo"`);
	}
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (err) {
		throw new CliError(
			`${settingsPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const repo = (settings as { supervisor?: { repo?: unknown } } | null)?.supervisor?.repo;
	if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
		throw new CliError(
			`${settingsPath} must set supervisor.repo to "owner/repo" (never read from the git remote)`,
		);
	}
	return repo;
}

function positiveInt(raw: unknown, field: string): number {
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
		throw new CliError(`config.json: ${field} must be a positive integer`);
	}
	return raw;
}

function readConfig(path: string): ValidatorConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const record = (raw ?? {}) as Record<string, unknown>;
	const provider = record.provider;
	const model = record.model;
	const threshold = record.badConfidenceThreshold;
	if (typeof provider !== "string" || provider.trim() === "") {
		throw new CliError("config.json: provider must be a non-empty string");
	}
	if (typeof model !== "string" || model.trim() === "") {
		throw new CliError("config.json: model must be a non-empty string");
	}
	if (typeof threshold !== "number" || !(threshold >= 0) || !(threshold <= 1)) {
		throw new CliError("config.json: badConfidenceThreshold must be a number in [0, 1]");
	}
	return {
		provider,
		model,
		badConfidenceThreshold: threshold,
		concurrency: positiveInt(record.concurrency, "concurrency"),
		maxAttempts: positiveInt(record.maxAttempts, "maxAttempts"),
		haltAfterConsecutiveFailures: positiveInt(
			record.haltAfterConsecutiveFailures,
			"haltAfterConsecutiveFailures",
		),
	};
}

/** The criteria file is the source of criterion ids; the code only mirrors them. */
function criteriaIdsFrom(criteriaText: string, path: string): string[] {
	const ids = [...criteriaText.matchAll(/^## (C\d+) —/gm)].map((match) => match[1]);
	if (ids.length === 0) throw new CliError(`${path} defines no "## C<n> —" criteria`);
	const known = new Set(CRITERIA_IDS);
	const unknown = ids.filter((id) => !known.has(id));
	if (unknown.length > 0) {
		throw new CliError(`${path} defines criteria unknown to the validator: ${unknown.join(", ")}`);
	}
	const missing = CRITERIA_IDS.filter((id) => !ids.includes(id));
	if (missing.length > 0) {
		throw new CliError(`${path} is missing criteria the validator requires: ${missing.join(", ")}`);
	}
	return ids;
}

function testGlobs(cwd: string): string[] {
	const packagePath = join(cwd, "package.json");
	if (!existsSync(packagePath)) {
		throw new CliError(
			`missing ${packagePath}; the audit discovers tests through its npm test script`,
		);
	}
	let scripts: unknown;
	try {
		scripts = (JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: { test?: unknown } })
			.scripts;
	} catch (err) {
		throw new CliError(
			`cannot parse ${packagePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const test = (scripts as { test?: unknown } | undefined)?.test;
	if (typeof test !== "string") {
		throw new CliError(
			`${packagePath}: scripts.test is missing, so the runnable test set is unknown`,
		);
	}
	const globs = [...test.matchAll(/'([^']+)'/g)]
		.map((match) => match[1])
		.filter((pattern) => /[*?]/.test(pattern) || /\.[cm]?[jt]s$/.test(pattern));
	if (globs.length === 0) {
		throw new CliError(`${packagePath}: scripts.test lists no test patterns`);
	}
	return globs;
}

interface DiscoveredInventory {
	readonly inventory: InventoryResult;
	readonly sources: ReadonlyMap<string, string>;
	readonly files: number;
	readonly truncated: number;
}

/**
 * Discover every runnable `node:test` call site under the npm test globs.
 * A single unresolvable file halts the run: a partial inventory must never reach
 * the completion gate or the cleanup issue.
 */
function discoverAll(cwd: string, limit: number | undefined): DiscoveredInventory {
	const files = new Set<string>();
	for (const pattern of testGlobs(cwd)) {
		for (const match of globSync(pattern, { cwd })) {
			const relativePath = match.replace(/^\.\//, "");
			if (relativePath.split("/").includes("node_modules")) continue;
			files.add(relativePath);
		}
	}
	const sorted = [...files].sort();
	if (sorted.length === 0) {
		throw new CliError("the npm test globs matched no files", EXIT_USAGE);
	}

	const sources = new Map<string, string>();
	const tests: TestDefinition[] = [];
	const excluded: ExcludedDefinition[] = [];
	for (const file of sorted) {
		const source = readFileSync(join(cwd, file), "utf8");
		sources.set(file, source);
		const result = discoverTests(source, file);
		tests.push(...result.tests);
		excluded.push(...result.excluded);
	}

	const truncated = limit === undefined ? 0 : Math.max(0, tests.length - limit);
	const selected = limit === undefined ? tests : tests.slice(0, limit);
	return {
		inventory: { tests: selected, excluded },
		sources,
		files: sorted.length,
		truncated,
	};
}

/** Local HEAD, recorded as report metadata. Never fatal: it is a label. */
function readHeadSha(cwd: string): string | null {
	try {
		const result = spawnArgv(
			(command: string, args: string[], options: object) =>
				spawnSync(command, args, options as Parameters<typeof spawnSync>[2]),
			"git",
			["rev-parse", "HEAD"],
			{ cwd, encoding: "utf8" },
		) as ReturnType<typeof spawnSync>;
		if (result.status !== 0) return null;
		const sha = String(result.stdout ?? "").trim();
		return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
}

function out(line: string): void {
	process.stdout.write(`${line}\n`);
}

function err(line: string): void {
	process.stderr.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
	const cwd = process.cwd();
	const skillDir = dirname(import.meta.dirname);

	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		err(`test-validator: ${error instanceof Error ? error.message : String(error)}`);
		err(USAGE);
		return EXIT_USAGE;
	}
	if (options.help) {
		out(USAGE);
		return EXIT_OK;
	}

	const configPath = options.configPath ?? join(skillDir, "config.json");
	const criteriaPath = options.criteriaPath ?? join(skillDir, "criteria.md");
	const reportPath = options.reportPath ?? join(cwd, "ignore", "test-validator", "report.json");
	const checkpointPath =
		options.checkpointPath ?? join(cwd, "ignore", "test-validator", "checkpoint.jsonl");

	let checkpoint: JsonlCheckpointStore | null = null;
	try {
		const repo = readSupervisorRepo(cwd);
		const config = readConfig(configPath);
		const criteriaText = readFileSync(criteriaPath, "utf8");
		const criteriaSha256 = sha256Hex(criteriaText);
		const criteriaIds = criteriaIdsFrom(criteriaText, criteriaPath);

		const keyState = assertProviderApiKey(config.provider);
		if (!keyState.ok) throw new CliError(keyState.message);

		const auth = await checkGhAuth();
		if (!auth.ok) throw new CliError(auth.message);

		const discovered = discoverAll(cwd, options.limit);
		if (discovered.truncated > 0) {
			err(
				`test-validator: pilot mode — judging ${discovered.inventory.tests.length} of ` +
					`${discovered.inventory.tests.length + discovered.truncated} tests; ` +
					"the checkpoint records this truncated inventory, so a later full run needs --restart",
			);
		}

		const inventoryFp = inventoryFingerprint(discovered.inventory.tests);
		const configFp = configFingerprint(config, criteriaSha256);
		const runFingerprint = sha256Hex(`${inventoryFp}\n${configFp}`);
		err(
			`test-validator: ${discovered.inventory.tests.length} runnable test(s) in ` +
				`${discovered.files} file(s), ${discovered.inventory.excluded.length} excluded; ` +
				`model ${config.provider}/${config.model}, concurrency ${config.concurrency}`,
		);

		checkpoint = new JsonlCheckpointStore(checkpointPath);
		const result = await runValidation(
			{
				model: createPiAiDecisionModel({
					provider: config.provider,
					model: config.model,
					criteriaText,
					criteriaIds,
				}),
				checkpoint,
				filer: createGhIssueFiler({ repo, bodyDir: defaultBodyDir(cwd) }),
				config,
				criteriaIds,
				criteriaSha256,
				writeReport: (report) => {
					mkdirSync(dirname(reportPath), { recursive: true });
					writeFileSync(reportPath, serializeReport(report), "utf8");
				},
				log: (line) => err(`test-validator: ${line}`),
			},
			{
				inventory: discovered.inventory,
				sources: discovered.sources,
				runFingerprint,
				headSha: readHeadSha(cwd),
				restart: options.restart,
			},
		);

		const { counts } = result;
		out(
			`counts: ${counts.discovered} judged (${counts.good} GOOD, ${counts.bad} BAD, ` +
				`${counts.pending} pending), ${counts.excluded} excluded, ${counts.reused} reused`,
		);
		if (result.report === null) {
			out("report: none (incomplete run)");
			out("issue: none (incomplete run)");
			return EXIT_INCOMPLETE;
		}
		out(`report: ${relative(cwd, reportPath) || reportPath}`);
		if (result.issue !== null) out(`issue: ${result.issue.url}`);
		else out("issue: none (no BAD tests)");
		return EXIT_OK;
	} catch (error) {
		if (error instanceof CliError) {
			err(`test-validator: ${error.message}`);
			return error.exitCode;
		}
		if (error instanceof DiscoveryError) {
			err(`test-validator: ${error.message}`);
			err("test-validator: inventory discovery failed, so nothing was judged or filed");
			return EXIT_USAGE;
		}
		if (error instanceof RunHaltedError) {
			err(`test-validator: ${error.message}`);
			err("test-validator: halted; the checkpoint keeps every completed decision, rerun to resume");
			return EXIT_FAILED;
		}
		err(`test-validator: ${error instanceof Error ? error.message : String(error)}`);
		return EXIT_FAILED;
	} finally {
		if (checkpoint !== null) await checkpoint.close();
	}
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
