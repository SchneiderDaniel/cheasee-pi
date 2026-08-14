// ─── Tests: agent-loop split structural guardrails (issue #1533) ─
// Phase 4 of the split test plan: S138 ceilings on every extracted
// helper, acyclic stages→handler imports, control-flow signals instead
// of break/continue in stages modules, skeleton call-shape, pinned
// strings, barrel re-exports and the fetchResolvedByInfo shim.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_PKG = resolve(__dirname, "../../pipeline/handler");
const STAGES_DIR = resolve(__dirname, "../../pipeline/stages");

function src(path: string): string {
	return readFileSync(path, "utf-8");
}

// Strip comments/strings/template literals so only real code braces count.
function stripLiterals(s: string): string {
	return s
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/`[^`]*`/g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/"[^"\n]*"/g, (m) => " ".repeat(m.length))
		.replace(/'[^'\n]*'/g, (m) => " ".repeat(m.length));
}

/** Raw line span of a top-level function in a source string. */
function functionSpan(source: string, name: string): number {
	const stripped = stripLiterals(source);
	const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`, "gm");
	const m = re.exec(stripped);
	assert.ok(m, `function ${name} not found`);
	const isTerminator = (line: string) => {
		const t = line.trim();
		return t === "" || /^(export|import|interface|type|function|async|class)\b/.test(t);
	};
	let depth = 0;
	let endOffset = -1;
	for (let i = m.index; i < stripped.length; i++) {
		const c = stripped[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				const firstNonBlank =
					stripped
						.slice(i + 1)
						.split("\n")
						.find((l) => l.trim().length > 0) || "";
				if (isTerminator(firstNonBlank)) {
					endOffset = i;
					break;
				}
			}
		}
	}
	assert.ok(endOffset >= 0, `could not find body close for ${name}`);
	const start = stripped.slice(0, m.index).split("\n").length;
	const end = stripped.slice(0, endOffset + 1).split("\n").length;
	return end - start + 1;
}

// ---------------------------------------------------------------------------
// S138: every extracted helper ≤ 100 lines
// ---------------------------------------------------------------------------

describe("agent-loop split — S138 ceilings on extracted helpers (issue #1533)", () => {
	const AGENT_LOOP = src(join(HANDLER_PKG, "agent-loop.ts"));
	const STAGES = readdirSync(STAGES_DIR)
		.filter((f) => f.endsWith(".ts"))
		.sort()
		.map((f) => src(join(STAGES_DIR, f)))
		.join("\n");

	const CEILING = 100;
	const sameFileHelpers: Array<[string, string]> = [
		["agent-loop.ts", "dispatchAgentWithRetry"],
		["agent-loop.ts", "handleBudgetExceeded"],
		["agent-loop.ts", "runPreTransitionHooks"],
		["agent-loop.ts", "refreshWorktreeBeforeImplementation"],
	];
	for (const [file, name] of sameFileHelpers) {
		it(`${name} ≤ ${CEILING} lines`, () => {
			const span = functionSpan(AGENT_LOOP, name);
			assert.ok(span <= CEILING, `${name} spans ${span} lines (> ${CEILING})`);
		});
	}

	const stagesHelpers: Array<[string, string]> = [
		["auditor-output.ts", "computeAuditGateRejection"],
		["empty-worktree.ts", "handleEmptyWorktree"],
		["empty-worktree.ts", "gatherChangeOnMain"],
		["empty-worktree.ts", "gatherOpenPrs"],
		["empty-worktree.ts", "dispatchEmptyWorktreeAction"],
		["git-ops.ts", "fetchResolvedByInfo"],
	];
	for (const [, name] of stagesHelpers) {
		it(`stages helper ${name} ≤ ${CEILING} lines`, () => {
			const span = functionSpan(STAGES, name);
			assert.ok(span <= CEILING, `${name} spans ${span} lines (> ${CEILING})`);
		});
	}

	it("runAgentLoop still within the ≤800 S138 exemption", () => {
		const span = functionSpan(AGENT_LOOP, "runAgentLoop");
		assert.ok(span <= 800, `runAgentLoop spans ${span} lines (> 800 exemption)`);
	});

	it("agent-loop.ts stays under the 1000-line S104 ceiling", () => {
		assert.ok(AGENT_LOOP.split("\n").length <= 1000, "agent-loop.ts under 1000 raw lines");
	});
});

// ---------------------------------------------------------------------------
// Package graph + control flow
// ---------------------------------------------------------------------------

describe("agent-loop split — acyclic stages→handler, signals not break/continue (issue #1533)", () => {
	it("no stages/*.ts module imports from handler/*", () => {
		for (const f of readdirSync(STAGES_DIR).filter((x) => x.endsWith(".ts"))) {
			const s = src(join(STAGES_DIR, f));
			assert.ok(
				!s.includes('from "../handler/'),
				`${f} must not import from handler/ (acyclic graph)`,
			);
		}
	});

	it("touched stages modules (empty-worktree/auditor-output/git-ops) contain no break/continue", () => {
		for (const f of ["empty-worktree.ts", "auditor-output.ts", "git-ops.ts"]) {
			const s = src(join(STAGES_DIR, f));
			const stripped = stripLiterals(s);
			assert.ok(
				!/\bbreak\b/.test(stripped) && !/\bcontinue\b/.test(stripped),
				`${f} must signal control flow via return values only`,
			);
		}
	});

	it("handler/agent-loop.ts keeps importing from ./shared.ts (RunContext)", () => {
		assert.ok(src(join(HANDLER_PKG, "agent-loop.ts")).includes('from "./shared.ts"'));
	});

	it("handler/pr-gates.ts does not import agent-loop.ts (acyclic within handler)", () => {
		assert.ok(!src(join(HANDLER_PKG, "pr-gates.ts")).includes('from "./agent-loop.ts"'));
	});
});

// ---------------------------------------------------------------------------
// Skeleton shape: one call per extracted helper + break/continue translation
// ---------------------------------------------------------------------------

describe("agent-loop split — dispatch-skeleton shape (issue #1533)", () => {
	const AGENT_LOOP = src(join(HANDLER_PKG, "agent-loop.ts"));

	it("each extracted helper is called exactly once from runAgentLoop", () => {
		for (const call of [
			"await dispatchAgentWithRetry(",
			"await handleBudgetExceeded(",
			"await runPreTransitionHooks(",
			"await handleEmptyWorktree(",
			"computeAuditGateRejection(",
			"await handlePrApprovalFlow(",
		]) {
			const count = AGENT_LOOP.split(call).length - 1;
			assert.equal(count, 1, `${call} invoked exactly once`);
		}
	});

	it("break/continue translation present in the skeleton", () => {
		assert.ok(/if \(budgetOutcome\.continue\)/.test(AGENT_LOOP), "budget continue translation");
		assert.ok(/if \(outcome\.stop\)/.test(AGENT_LOOP), "empty-worktree break translation");
		assert.ok(/if \(prFlow\.stop\)/.test(AGENT_LOOP), "PR-flow break translation");
	});

	it("gateRejected passed to handlePostAgentSuccess", () => {
		const idx = AGENT_LOOP.indexOf("await handlePostAgentSuccess(");
		const section = AGENT_LOOP.slice(idx, idx + 900);
		assert.ok(
			section.includes("gateRejected"),
			"pre-computed gateRejected threaded to post-success",
		);
	});

	it("pinned strings still resolve in agent-loop.ts", () => {
		const pins = [
			"validateAgentResult(result)",
			"if (result.budgetExceeded)",
			"const { result: initialResult } = await executeAgent(",
			"const auditResult = await runTscAndLspAudit(",
			"applyGateFailureContext(stageState, effectiveNextStatus, auditResult.note",
			'["ci", "tsc", "lsp", "dup", "trace"]',
			"// Pre-transition hooks",
			"// Graceful degradation",
			"const task = buildAgentTask(",
			"refreshWorktreeBeforeImplementation(runCtx, worktreePath)",
		];
		for (const pin of pins) {
			assert.ok(AGENT_LOOP.includes(pin), `pinned string missing: ${pin}`);
		}
		assert.equal(
			(AGENT_LOOP.match(/if \(result\.budgetExceeded\)/g) || []).length,
			2,
			"budgetExceeded guard appears twice (retry gate + pipeline control)",
		);
	});
});

// ---------------------------------------------------------------------------
// Barrel + shim + erasable syntax
// ---------------------------------------------------------------------------

describe("agent-loop split — barrel, shim, erasable syntax (issue #1533)", () => {
	it("stages/index.ts re-exports computeAuditGateRejection + handleEmptyWorktree + EmptyWorktreeOutcome, no export *", () => {
		const barrel = src(join(STAGES_DIR, "index.ts"));
		assert.ok(
			barrel.includes("computeAuditGateRejection"),
			"computeAuditGateRejection re-exported",
		);
		assert.ok(barrel.includes("handleEmptyWorktree"), "handleEmptyWorktree re-exported");
		assert.ok(barrel.includes("EmptyWorktreeOutcome"), "EmptyWorktreeOutcome type re-exported");
		assert.ok(!barrel.includes("export *"), "explicit re-exports only");
	});

	it("handler/shared.ts re-exports fetchResolvedByInfo from stages/git-ops.ts", () => {
		const shared = src(join(HANDLER_PKG, "shared.ts"));
		assert.ok(
			shared.includes('export { fetchResolvedByInfo } from "../stages/git-ops.ts"'),
			"shim re-export present",
		);
		assert.ok(!shared.includes("async function fetchResolvedByInfo"), "implementation moved out");
	});

	it("new stages/empty-worktree.ts: .ts-suffixed relative imports, no enums/namespaces/parameter properties", () => {
		const s = src(join(STAGES_DIR, "empty-worktree.ts"));
		for (const m of s.matchAll(/from\s+"(\.[^"]+)"/g)) {
			assert.ok(m[1]!.endsWith(".ts"), `relative import "${m[1]}" must end with .ts`);
		}
		assert.ok(!s.includes("enum "), "no enums");
		assert.ok(!s.includes("namespace "), "no namespaces");
		assert.ok(!s.includes("constructor("), "no constructor parameter properties");
	});
});
