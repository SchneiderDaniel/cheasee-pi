/**
 * Unit tests for cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js — the
 * deterministic false-positive policy applied to CodeFlow's structured `data`
 * before any report artifact is built.
 *
 * The module is CJS (the headless runner requires it) and is loaded here the
 * same way, so the tests pin the exact file the container ships. `readFile` is
 * injected, so no test touches the filesystem.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codeflow-fp-filter.test.mts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
// The shared argv-policy module, read off disk so a fixture's import provenance
// can be verified exactly as the production readFile verifies it.
const POLICY_SRC = readFileSync(resolve(HERE, "..", ".pi/extensions/lib/safe-argv.ts"), "utf8");
const SHARED_POLICY_PATHS = new Set([".pi/extensions/lib/safe-argv.ts"]);
const requireCjs = createRequire(import.meta.url);
const FILTER = resolve(HERE, "..", "cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js");

type Suppressed = {
	security: any[];
	layerViolations: any[];
	hygiene: any[];
	deadCode: any[];
	duplicates: any[];
};

const {
	sanitizeAnalysisData,
	isFalsePositiveHygiene,
	isFalsePositiveLayerViolation,
	readFileFrom,
	REPO_LAYERS,
	resolveLayer,
} = requireCjs(FILTER) as {
	sanitizeAnalysisData: (
		data: unknown,
		readFile?: (path: unknown) => string | null,
	) => { data: any; suppressed: Suppressed };
	isFalsePositiveHygiene: (issue: unknown, readFile?: (path: unknown) => string | null) => boolean;
	isFalsePositiveLayerViolation: (
		violation: unknown,
		index: {
			connections: Record<string, boolean>;
			layers?: Array<{ prefix: string; layer: string; rank: number }>;
		},
	) => boolean;
	readFileFrom: (data: unknown) => (path: unknown) => string | null;
	REPO_LAYERS: Array<{ prefix: string; layer: string; rank: number }>;
	resolveLayer: (path: unknown) => { layer: string; rank: number } | null;
};

// The real upstream health score (see the fixture header), so the acceptance
// arithmetic below is upstream's, not a re-implementation.
const { calcHealth } = (await import("./fixtures/codeflow-calc-health.mjs")) as {
	calcHealth: (data: any) => { score: number; grade: string };
};

// The cited files of the report the issue was filed against (issue #1994).
const SOURCES: Record<string, string> = {
	".pi/extensions/context-info/types.ts":
		'export type UsageColorToken = "success" | "warning" | "error";\n',
	".pi/extensions/supervisor/github/gh-client.ts":
		"function resolveGitHubToken() {\n" +
		"  const env = process.env.GH_TOKEN;\n" +
		"  const hosts = readFileSync(homedir() + '/.config/gh/hosts.yml');\n" +
		"  return env || hosts;\n" +
		"}\n" +
		"const ghToken = resolveGitHubToken();\n",
	".pi/extensions/web-search/test/index.test.ts":
		"// First execute: verify 1 (quick check) + verify 2 (double-check) fail\n" +
		"it('passes', () => {});\n",
	"cmd/cheasee-pi/embedded/docker/entrypoint.sh": "#!/bin/sh\nexit 0\n",
	"ui/src/lib.rs": "pub fn shell() -> impl IntoView { view! { <html></html> } }\n",
	"ui/src/main.rs": "fn main() { mount_to_body(App); }\n",
	"ui/src/retry.rs": "pub fn retry() {}\n",
	"ui/src/tool_card.rs": "pub fn card() {}\n",
	"src/spawn.ts": "export function run() { spawn(); }\n",
	"src/config.ts": "export const config = load();\n",
	// The safe shape the fix produces: the executable comes from `argvCommand`
	// and the options are forced by `assertNoShell` — suppressed.
	"src/safe-wrapper.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function run(args: string[]) {\n" +
		'  const { program, args: safeArgs } = argvCommand("/usr/bin/pi", args);\n' +
		'  return spawn(program, safeArgs as string[], assertNoShell({ stdio: "ignore" }));\n' +
		"}\n",
	"src/safe-promisified.ts":
		'import { execFile } from "node:child_process";\n' +
		'import { promisify } from "node:util";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"const execFileAsync = promisify(execFile);\n" +
		"export async function run() {\n" +
		'  const { program, args } = argvCommand("git", ["status"]);\n' +
		"  return execFileAsync(program, args, assertNoShell({ timeout: 5000 }));\n" +
		"}\n",
	// A file that only imports the `ChildProcess` type never calls the module.
	"src/type-only.ts":
		'import type { ChildProcess } from "node:child_process";\nexport type C = ChildProcess;\n',
	// Counterexamples that must keep the finding: a dynamic program, an aliased
	// shell `exec`, an explicit `execSync`, a truthy `shell` option, and a shell
	// program with a `-c` command string.
	"src/dynamic-command.ts":
		'import { spawn } from "node:child_process";\n' +
		"export function run(request: { command: string; args: string[] }) {\n" +
		"  return spawn(request.command, request.args, { shell: false });\n" +
		"}\n",
	// Regression (audit): `argvCommand` on a *dynamic* program proves nothing.
	// The destructured name must stay unbound so the finding survives.
	"src/wrapped-dynamic.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function run(request: { command: string; args: string[] }) {\n" +
		"  const { program, args } = argvCommand(request.command, request.args);\n" +
		'  return spawn(program, args, assertNoShell({ stdio: "ignore" }));\n' +
		"}\n",
	// Regression (audit): a program that is a parameter passed straight through
	// a wrapper is not a literal — the finding must survive.
	"src/wrapper-passthrough.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function run(program: string, args: string[]) {\n" +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): a literal program is not enough — an argv array that
	// never passed through `argvCommand` must keep the finding.
	"src/unvalidated-args.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function run(args: string[]) {\n" +
		'  return spawn("/usr/bin/pi", args, assertNoShell({}));\n' +
		"}\n",
	"src/aliased-exec.ts":
		'import * as cp from "node:child_process";\n' +
		"const run = cp.exec;\n" +
		'export function go(cmd: string) { spawn("/usr/bin/pi", ["--version"], { shell: false }); run(cmd); }\n',
	// Regression (audit): a computed member access (`cp["ex" + "ec"]`) names a
	// child-process function the name-based scan cannot see. A safe dotted spawn
	// beside it must not buy the file a suppression.
	"src/computed-namespace.ts":
		'import * as cp from "node:child_process";\n' +
		'export function go(cmd: string) { cp.spawn("/usr/bin/pi", ["--version"], { shell: false }); cp["ex" + "ec"](cmd); }\n',
	// Regression (audit): a computed access through a namespace alias is still a
	// child-process member access the scan never resolves.
	"src/computed-alias.ts":
		'import * as cp from "node:child_process";\n' +
		"const c = cp;\n" +
		'export function go(cmd: string) { cp.spawn("/usr/bin/pi", ["--version"], { shell: false }); c["ex" + "ec"](cmd); }\n',
	// Regression (audit): a require result indexed directly, with no bound name.
	"src/computed-inline-require.ts":
		'export function go(cmd: string) { require("node:child_process")["ex" + "ec"](cmd); }\n',
	// Regression (audit): the same inline result reached through `.` — the member
	// call has no bound receiver, so the name-based scan never resolves it.
	"src/dotted-inline-require.ts":
		"export function go(request: { command: string; args: string[] }) {\n" +
		'  require("node:child_process").spawn(request.command, request.args, { shell: false });\n' +
		"}\n",
	// Regression (audit): a dynamic-import namespace bound to a name is still a
	// child-process source, so `cp.spawn(dynamic, ...)` must keep the finding.
	"src/dynamic-import-bound.ts":
		"export async function go(request: { command: string; args: string[] }) {\n" +
		'  const cp = await import("node:child_process");\n' +
		"  return cp.spawn(request.command, request.args, { shell: false });\n" +
		"}\n",
	// Regression (audit): a dynamic import reached inline through a paren group.
	"src/dynamic-import-paren.ts":
		"export async function go(cmd: string) {\n" +
		'  return (await import("node:child_process")).spawn(cmd, [], { shell: false });\n' +
		"}\n",
	// Positive control: the dynamic-import namespace resolves to a literal program
	// and a literal argv, with the options routed through the policy's
	// `assertNoShell`, so registering it must still allow the suppression.
	"src/dynamic-import-safe.ts":
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export async function go() {\n" +
		'  const cp = await import("node:child_process");\n' +
		'  return cp.spawn("/usr/bin/pi", ["--version"], assertNoShell({}));\n' +
		"}\n",
	// Regression (audit): the module result is bound through a parenthesised
	// `await import(...)` group; a safe static spawn beside it must not buy the
	// file a suppression when `cp["spawn"]` hides a dynamic call.
	"src/dynamic-import-paren-bound.ts":
		'import { spawn } from "node:child_process";\n' +
		"export async function go(request: { command: string; args: string[] }) {\n" +
		'  spawn("/usr/bin/pi", ["--version"], { shell: false });\n' +
		'  const cp = (await import("node:child_process"));\n' +
		'  return cp["spawn"](request.command, request.args, { shell: false });\n' +
		"}\n",
	// Positive control: the same parenthesised binding, spawn called with a
	// literal program and argv through the policy, so it must still be suppressed.
	"src/dynamic-import-nested-paren-safe.ts":
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export async function go() {\n" +
		'  const cp = ((await import("node:child_process")));\n' +
		'  return cp.spawn("/usr/bin/pi", ["--version"], assertNoShell({}));\n' +
		"}\n",
	// Regression (audit): an unenumerated one-line binding (ternary, helper
	// call) is still a child-process source; fail closed rather than hide it.
	"src/ternary-namespace.ts":
		'import { spawn } from "node:child_process";\n' +
		"export function go(flag: boolean, request: { command: string }) {\n" +
		'  spawn("/usr/bin/pi", ["--version"], { shell: false });\n' +
		'  const cp = flag ? require("node:child_process") : null;\n' +
		'  return cp["ex" + "ec"](request.command);\n' +
		"}\n",
	// Regression (audit): the module result assigned to a name declared earlier
	// (`let cp; cp = require(...)`) is the same source shape.
	"src/assigned-namespace.ts":
		"let cp: any;\n" +
		"export function go(request: { command: string; args: string[] }) {\n" +
		'  cp = require("node:child_process");\n' +
		"  return cp.spawn(request.command, request.args, { shell: false });\n" +
		"}\n",
	// Regression (audit): the require-destructuring rename form (`exec: run`) must
	// register the shell member, so its call site is not invisible.
	"src/renamed-exec.ts":
		'const { exec: run } = require("node:child_process");\n' +
		"export function go(cmd: string) { run(cmd); }\n",
	// Regression (audit): optional chaining must not skip the scans — neither a
	// computed member nor a dynamic program reached through `?.`.
	"src/optional-computed.ts":
		'import * as cp from "node:child_process";\n' +
		'export function go(cmd: string) { cp.spawn("/usr/bin/pi", ["--version"], { shell: false }); cp?.["ex" + "ec"](cmd); }\n',
	"src/optional-dynamic.ts":
		'import * as cp from "node:child_process";\n' +
		"export function go(request: { command: string; args: string[] }) { return cp?.spawn(request.command, request.args, { shell: false }); }\n",
	// Regression (audit): a member reached through `.call` is not the scanned call.
	"src/dotted-call.ts":
		'import * as cp from "node:child_process";\n' +
		'export function go(cmd: string) { cp.spawn.call(null, cmd, ["--version"], { shell: false }); }\n',
	"src/shell-out.ts":
		'import { execSync } from "node:child_process";\n' +
		'export function run(cmd: string) { execSync("rm -rf " + cmd); }\n',
	"src/shell-true.ts":
		'import { spawn } from "node:child_process";\n' +
		'export function run(args: string[]) { return spawn("git", args, { shell: true }); }\n',
	"src/shell-program.ts":
		'import { execFile } from "node:child_process";\n' +
		'export function run(cmd: string) { return execFile("/bin/bash", ["-c", cmd]); }\n',
	// Regression (audit): an escaped program literal hides a shell —
	// `"/bin/\\u0073h"` is `/bin/sh` — and must not be taken as a literal.
	"src/escaped-program.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("/bin/\\u0073h", ["--version"], assertNoShell({})); }\n',
	// Regression (audit): a constructed argv element assembles a shell flag —
	// `"-" + "c"` is `-c` — beside an otherwise clean literal program.
	"src/constructed-flag.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(cmd: string) { return spawn("/usr/bin/pi", ["-" + "c", cmd], assertNoShell({})); }\n',
	// Regression (audit): the exact bypass probe — escaped executable and
	// constructed flag together.
	"src/escaped-constructed.ts":
		'import { spawn } from "node:child_process";\n' +
		'export function go(cmd: string) { return spawn("/bin/\\u0073h", ["-" + "c", cmd], { shell: false }); }\n',
	// Positive control: a plain literal argv holding dashes is still a validated
	// source — the constructed/escaped guards must not over-reject it.
	"src/literal-dashed-args.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("git", ["status", "--short"], assertNoShell({})); }\n',
	// Regression (audit): an interpolated template hole in an argv element can
	// assemble a shell flag at runtime (`--x=${y}`); it is not a literal element,
	// so the finding must survive even though the options are policy-forced.
	"src/interpolated-argv.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(x: string) { return spawn("/usr/bin/pi", [`--flag${x}`], assertNoShell({})); }\n',
	// Regression (audit): `{ shell: false, ...opts }` reads as shell-disabled only
	// until `opts` spreads a truthy `shell` over it; only the policy's runtime
	// `assertNoShell` proves the shell is off, so this probe must keep the finding.
	"src/spread-options.ts":
		'import { spawn } from "node:child_process";\n' +
		'export function go(opts: object) { return spawn("/usr/bin/pi", ["--version"], { shell: false, ...opts }); }\n',
	// Regression (audit): a bare `shell: false` object literal is not proof — a
	// shadowing local or a duplicate key can defeat it, so the finding survives.
	"src/bare-shell-false.ts":
		'import { spawn } from "node:child_process";\n' +
		'export function go() { return spawn("git", ["status"], { shell: false }); }\n',
	// Regression (audit): `assertNoShell` behind an ignored extra argument is not
	// the effective options — argv position 3 is — so the finding survives.
	"src/shadowed-options.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(opts: object) { return spawn("/usr/bin/pi", ["--version"], opts, assertNoShell({})); }\n',
	// Regression (audit): a parameter named `assertNoShell` shadows the import, so
	// the call resolves to the parameter — which can return shell-enabled options
	// — not the policy. The name match is not proof, so the finding survives.
	"src/shadowed-helper.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(opts: object, assertNoShell: (o: object) => object) { return spawn("/usr/bin/pi", ["--version"], assertNoShell(opts)); }\n',
	// Regression (audit): the shadowing parameter may also sit first, untyped —
	// the name is bound, not the import.
	"src/shadowed-param-first.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(assertNoShell, opts) { return spawn("/usr/bin/pi", ["--version"], assertNoShell(opts)); }\n',
	// Regression (audit): a function declaration of the same name shadows the
	// import just as a parameter does.
	"src/shadowed-function.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"function assertNoShell(opts: object) { return opts; }\n" +
		'export function go() { return spawn("/usr/bin/pi", ["--version"], assertNoShell({})); }\n',
	// Regression (audit): a shadowed `argvCommand` proves nothing either — its
	// output never passed through the policy, so the finding survives.
	"src/shadowed-command.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"function argvCommand(program: string, args: string[]) { return { program, args }; }\n" +
		'export function go(args: string[]) { const { program, args: safe } = argvCommand("/usr/bin/pi", args); return spawn(program, safe, assertNoShell({})); }\n',
	// Positive control: the policy import lists `assertNoShell` between two other
	// names, so blanking the import clause must not read the list separator as a
	// shadowing declaration.
	"src/mid-import.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell, assertSafeEnv } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(args: string[]) { const { program, args: safe } = argvCommand("/usr/bin/pi", args); return spawn(program, safe, assertNoShell({})); }\n',
	// Regression (audit): executable-aware validation — an interpreter turns a
	// policy-validated argv back into code. `argvCommand("node", ["-e", code])`
	// hands the interpreter attacker-controlled code, so the finding must stay.
	"src/interpreter-eval-binding.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go(code: string) {\n" +
		'  const { program, args } = argvCommand("node", ["-e", code]);\n' +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): the same code flag on a direct literal argv array.
	"src/interpreter-eval-direct.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["-e", "console.log(1)"], assertNoShell({})); }\n',
	// Regression (audit): a dynamic argv for an interpreter cannot be proven free
	// of the code flag, so the finding must survive.
	"src/interpreter-dynamic-argv.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go(args: string[]) {\n" +
		'  const { program, args: safe } = argvCommand("node", args);\n' +
		"  return spawn(program, safe, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): the `--eval=` long form is caught too.
	"src/interpreter-eval-long.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go() {\n" +
		'  const { program, args } = argvCommand("node", ["--eval=1+1"]);\n' +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Positive control: an interpreter invocation without a code flag is not
	// blanket-denied, so the interpreter guard cannot over-reject.
	"src/interpreter-safe-flags.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["--version"], assertNoShell({})); }\n',
	// Regression (audit): a command runner delegates to an interpreter named in
	// argv, so the code flag sits one level down (`env node -e code`).
	"src/runner-delegates-eval.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go(code: string) {\n" +
		'  const { program, args } = argvCommand("env", ["node", "-e", code]);\n' +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): the runner's argv is a literal array that names an
	// interpreter and its code flag.
	"src/runner-literal-eval.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("npx", ["node", "-e", "1"], assertNoShell({})); }\n',
	// Positive control: a runner with a plain literal argv is not blanket-denied.
	"src/runner-safe.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("npx", ["--version"], assertNoShell({})); }\n',
	// Regression (audit): the interpreter's module-loading flags run code the
	// flag points at, so a policy-validated argv is still arbitrary execution.
	"src/interpreter-require.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["--require", "./hook.cjs"], assertNoShell({})); }\n',
	"src/interpreter-import.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["--import", "./hook.mjs"], assertNoShell({})); }\n',
	"src/interpreter-loader.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["--loader", "./hook.mjs"], assertNoShell({})); }\n',
	// Regression (audit): Perl's *attached* module-loading flag (`-MAttacker`) runs
	// the module's init code, so a policy-validated argv is still execution.
	"src/interpreter-perl-m.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("perl", ["-I/tmp/attacker", "-MAttacker"], assertNoShell({})); }\n',
	// Regression (audit): Python attaches the program to `-c` (`python3 -cprint(1)`)
	// and a shell combines `-l`/`-c` (`bash -lc id`); both run argv code, so the
	// policy-validated argv is still execution and the finding must stay.
	"src/interpreter-python-attached-c.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("python3", ["-cprint(1)"], assertNoShell({})); }\n',
	"src/interpreter-shell-attached-c.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("bash", ["-lc", "id"], assertNoShell({})); }\n',
	// Positive control: an interpreter call naming a script file (no code flag)
	// stays suppressible, so the module-loading guard cannot over-reject.
	"src/interpreter-script.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("node", ["server.js", "--port", "8080"], assertNoShell({})); }\n',
	// Regression (audit): the imported helper must resolve to the *shared* policy
	// module. A same-named module of another path (`./attacker-safe-argv.ts`) is
	// not provenance, so the finding survives.
	"src/fake-policy-module.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "./attacker-safe-argv.ts";\n' +
		"export function go() {\n" +
		'  const { program, args } = argvCommand("/usr/bin/pi", ["--version"]);\n' +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): a path that only *ends* in `lib/safe-argv.ts` but does
	// not resolve to the shared module (`src/lib/safe-argv.ts`) must keep the
	// finding — the module is unreadable, and absence is not proof.
	"src/local-lib-fake.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "./lib/safe-argv.ts";\n' +
		"export function go() {\n" +
		'  const { program, args } = argvCommand("/usr/bin/pi", ["--version"]);\n' +
		"  return spawn(program, args, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): a *readable* counterfeit that merely ends in
	// `lib/safe-argv.ts` must not forge provenance. The resolved path is not the
	// canonical shared module, so the finding survives even though the module
	// declares the exported names and a `shell: false`.
	"src/attacker/lib/safe-argv.ts":
		"export function argvCommand(program, args) { return { program, args }; }\n" +
		"export function assertNoShell(options) { return { ...options, shell: false }; }\n",
	"src/counterfeit-policy.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "./attacker/lib/safe-argv.ts";\n' +
		"export function go(args) {\n" +
		'  const { program, args: safe } = argvCommand("git", args);\n' +
		"  return spawn(program, safe, assertNoShell({}));\n" +
		"}\n",
	// Regression (audit): an env in the options names a command the argv proof
	// never sees — git runs `core.sshCommand` from `GIT_CONFIG_*` during a fetch —
	// so a literal env binding keeps the finding despite `shell: false`.
	"src/env-options.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("git", ["fetch"], assertNoShell({ env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "sh -c id" } })); }\n',
	// The shorthand property binds the same env.
	"src/env-shorthand.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go(env: Record<string, string>) {\n" +
		'  const { program, args } = argvCommand("/usr/bin/pi", ["--version"]);\n' +
		'  return spawn(program, args, assertNoShell({ cwd: "/tmp", env, stdio: "ignore" }));\n' +
		"}\n",
	// A spread of `process.env` hides every variable, so it is unproven too.
	"src/env-spread.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go() {\n" +
		'  const { program, args } = argvCommand("/usr/bin/pi", ["--version"]);\n' +
		"  return spawn(program, args, assertNoShell({ env: { ...process.env } }));\n" +
		"}\n",
	// Regression (audit): the env hides behind an options *binding* — the
	// `assertNoShell(opts)` text shows no `env:`, so only resolving (or refusing)
	// the binding keeps the finding.
	"src/env-aliased-options.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		"export function go() {\n" +
		'  const opts = { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "sh -c id" } };\n' +
		'  return spawn("git", ["fetch"], assertNoShell(opts));\n' +
		"}\n",
	// A spread in the options literal re-introduces every key it does not show.
	"src/env-spread-binding.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go(opts: object) { return spawn("git", ["fetch"], assertNoShell({ ...opts })); }\n',
	// Positive control: the same shape without an env stays suppressible, so the
	// env guard cannot over-reject.
	"src/env-free-options.ts":
		'import { spawn } from "node:child_process";\n' +
		'import { assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
		'export function go() { return spawn("git", ["fetch"], assertNoShell({ timeout: 5000 })); }\n',
};

const readFile = (path: unknown): string | null => {
	if (typeof path !== "string") return null;
	if (path in SOURCES) return SOURCES[path];
	if (SHARED_POLICY_PATHS.has(path)) return POLICY_SRC;
	return null;
};

function sec(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "high",
		title: "Hardcoded Secret",
		description: "Possible hardcoded API key.",
		path: "src/config.ts",
		line: 1,
		code: 'const KEY = "sk-live-abc";',
		...over,
	};
}

/** A LOW hygiene finding as the analyzer emits it: no snippet of its own. */
function hyg(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "low",
		title: "Code Comments",
		description: "Unresolved work marker found.",
		path: ".pi/extensions/agent-harness/test/index.test.ts",
		line: 1,
		code: "",
		...over,
	};
}

const nullReadFile = () => null;

// The analyzer's file table carries inferred `layer` labels — advisory only,
// since the repo declares no ordered layer taxonomy (see fp-filter.js REPO_LAYERS).
// The paths still end under the source roots CodeFlow mislabels as layers.
const EXT = ".pi/extensions/";
const TEST = "test/";
const UI = "cmd/cheasee-pi/embedded/docker/ui/";

const LAYER_FILES = [
	{ path: `${EXT}from.ts`, layer: "extensions" },
	{ path: `${TEST}to.ts`, layer: "test" },
	{ path: `${UI}src/retry.rs`, layer: "ui" },
	{ path: `${UI}src/main.rs`, layer: "ui" },
	{ path: "cmd/cheasee-pi/build.go", layer: "cli" },
];
const CONNECTIONS = [{ source: `${EXT}from.ts`, target: `${TEST}to.ts`, fn: "render", count: 2 }];

function violation(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		from: `${EXT}from.ts`,
		to: `${TEST}to.ts`,
		fromLayer: "extensions",
		toLayer: "test",
		fn: "render",
		suggestion: "invert",
		...over,
	};
}

/** Sanitize one security finding and report whether it survived. */
function keepsSecurity(issue: Record<string, unknown>): boolean {
	const { data, suppressed } = sanitizeAnalysisData({ securityIssues: [issue] }, readFile);
	assert.strictEqual(
		suppressed.security.length + suppressed.hygiene.length + data.securityIssues.length,
		1,
		"no finding may vanish",
	);
	return data.securityIssues.length === 1;
}

/** Sanitize one layer violation and report whether it survived. */
function keepsViolation(v: unknown): boolean {
	const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations: [v] };
	const { data, suppressed } = sanitizeAnalysisData(input, readFile);
	assert.strictEqual(
		suppressed.layerViolations.length + data.layerViolations.length,
		1,
		"no violation may vanish",
	);
	return data.layerViolations.length === 1;
}

describe("fp-filter — security false positives (Phase 1)", () => {
	it("drops a finding that cites no code line (the 5 Shell Command Execution hits)", () => {
		for (const path of ["ui/src/main.rs", "ui/src/retry.rs", "ui/src/tool_card.rs"]) {
			assert.strictEqual(
				keepsSecurity(sec({ title: "Shell Command Execution", code: "", path })),
				false,
				`empty code at ${path} must be suppressed`,
			);
		}
	});

	it("drops whitespace-only, null and missing code (boundary)", () => {
		for (const code of ["   \n\t ", null, undefined]) {
			assert.strictEqual(keepsSecurity(sec({ code })), false, `code=${JSON.stringify(code)}`);
		}
	});

	it("drops a comment-only match (the SQL Injection Risk hit)", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					title: "SQL Injection Risk",
					description: "Query built by concatenation.",
					path: ".pi/extensions/web-search/test/index.test.ts",
					code: "// First execute: verify 1 (quick check) + verify 2 (double-check) fail",
				}),
			),
			false,
		);
		assert.strictEqual(
			keepsSecurity(sec({ code: "/* execute(query) */" })),
			false,
			"block-comment-only code is still comment-only",
		);
	});

	it("keeps a leading comment that precedes a real statement", () => {
		assert.strictEqual(keepsSecurity(sec({ code: '//note\nconst q = "SELECT " + id;' })), true);
	});

	it("drops a string-literal type union (the UsageColorToken hit)", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					path: ".pi/extensions/context-info/types.ts",
					code: 'export type UsageColorToken = "success" | "warning" | "error";',
				}),
			),
			false,
		);
		// A union that carries a real embedded secret is not a type-only match.
		assert.strictEqual(
			keepsSecurity(sec({ code: 'export type Token = "sk-live-abc123";' })),
			true,
			"a single-literal type alias is a literal, not a union",
		);
	});

	it("keeps a literal credential (true positive)", () => {
		assert.strictEqual(keepsSecurity(sec({ code: 'const KEY = "sk-live-abc";' })), true);
	});

	it("drops a value the environment resolves at runtime (the 2 gh-client hits)", () => {
		const gh = {
			title: "Hardcoded Secret",
			description: "Possible hardcoded token.",
			path: ".pi/extensions/supervisor/github/gh-client.ts",
		};
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: "const KEY = process.env.GH_TOKEN;" })),
			false,
			"process.env",
		);
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: 'let k = env::var("GH_TOKEN");' })),
			false,
			"env::var",
		);
		assert.strictEqual(
			keepsSecurity(sec({ ...gh, code: "const ghToken = resolveGitHubToken();" })),
			false,
			"helper whose body reads process.env/hosts.yml",
		);
		assert.strictEqual(
			keepsSecurity(
				sec({
					...gh,
					code: '? ["-c", `GH_TOKEN=\'${ghToken.replace(/\'/g, "")}\' gh "$@"`, "_", ...args]',
				}),
			),
			false,
			"the flagged value is the env-resolved ghToken",
		);
	});

	it("keeps a block that reads the environment elsewhere while the flagged value is a literal", () => {
		assert.strictEqual(
			keepsSecurity(sec({ code: 'const other = process.env.FOO;\nconst KEY = "sk-live-abc";' })),
			true,
			"never suppress on ambiguity",
		);
	});

	it("drops a finding whose message names a symbol absent from the cited file", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					title: "Shell Command Execution",
					description: "Untrusted input reaches Shell().",
					path: "ui/src/lib.rs",
					code: "let doc = shell();",
				}),
			),
			false,
			"lib.rs has shell(), never Shell()",
		);
	});

	it("keeps a finding whose named symbol is present in the cited file", () => {
		assert.strictEqual(
			keepsSecurity(
				sec({
					title: "Command Execution",
					description: "run() invokes spawn().",
					path: "src/spawn.ts",
					code: "spawn();",
				}),
			),
			true,
		);
	});

	it("keeps a finding when the cited file cannot be read (absence is not proof)", () => {
		assert.strictEqual(
			keepsSecurity(sec({ path: "does/not/exist.ts", code: 'const KEY = "sk-live-abc";' })),
			true,
		);
	});

	it("leaves LOW and non-Command-Execution MEDIUM findings alone (audit triage owns them)", () => {
		for (const severity of ["low", "medium", "LOW"]) {
			assert.strictEqual(
				keepsSecurity(
					sec({ severity, title: "Code Comments", description: "TODO", code: "// TODO: fix" }),
				),
				true,
				`${severity} must not be filtered here`,
			);
		}
		assert.strictEqual(
			keepsSecurity(
				sec({
					severity: "low",
					title: "Code Comments",
					code: "// TODO: fix",
					path: "src/config.ts",
				}),
			),
			true,
			"a LOW TODO marker in shipping source is real work",
		);
	});
});

describe("fp-filter — LOW hygiene false positives (Phase 1)", () => {
	it("suppresses LOW Code Comments on a test-directory path", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				hyg({ path: ".pi/extensions/agent-harness/test/index.test.ts" }),
				nullReadFile,
			),
			true,
		);
	});

	it("suppresses test/spec files outside any test directory", () => {
		for (const path of [
			"src/widget.test.ts",
			"src/widget.test.mts",
			"src/widget.spec.ts",
			"src/widget.spec.tsx",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), true, path);
		}
		assert.strictEqual(
			isFalsePositiveHygiene(hyg({ path: "src/latest.ts" }), nullReadFile),
			false,
			"not a .test.* file",
		);
	});

	it("suppresses LOW Debug Statements on a test path (the console fixtures)", () => {
		assert.strictEqual(
			isFalsePositiveHygiene(
				hyg({
					title: "Debug Statements",
					path: ".pi/extensions/structural-analyzer/test/index.test.mts",
				}),
				nullReadFile,
			),
			true,
		);
	});

	it("suppresses LOW hygiene on documentation artifacts", () => {
		for (const path of [
			".pi/extensions/ripgrep-search/README.md",
			"APPEND_SYSTEM.md",
			".pi/skills/audit-clean-code/SKILL.md",
			".pi/skills/audit-codeflow-analysis/references/known-false-positives.md",
			"docs/_config.yml",
			"docs/guide.mdx",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), true, path);
		}
	});

	it("keeps LOW hygiene on shipping source", () => {
		for (const path of [
			".pi/extensions/ask-user/jsonl-logger.ts",
			".pi/extensions/ripgrep-search/index.ts",
			".pi/extensions/structural-analyzer/index.ts",
			".pi/extensions/structural-analyzer/validate.ts",
			"cmd/cheasee-pi/main.go",
		]) {
			assert.strictEqual(isFalsePositiveHygiene(hyg({ path }), nullReadFile), false, path);
		}
	});

	it("is severity- and title-gated", () => {
		for (const severity of ["medium", "high", "MEDIUM"]) {
			assert.strictEqual(
				isFalsePositiveHygiene(hyg({ severity, path: "src/widget.test.ts" }), nullReadFile),
				false,
				severity,
			);
		}
		for (const title of [
			"Shell Command Execution",
			"Code Comment",
			"code comments",
			"code comments ",
		]) {
			assert.strictEqual(
				isFalsePositiveHygiene(hyg({ title, path: "src/widget.test.ts" }), nullReadFile),
				false,
				title,
			);
		}
	});

	it("keeps malformed findings (never suppress on ambiguity)", () => {
		for (const issue of [
			null,
			"low",
			hyg({ severity: undefined }),
			hyg({ title: undefined }),
			hyg({ path: undefined }),
			hyg({ path: "" }),
			hyg({ path: 42 }),
		]) {
			assert.strictEqual(isFalsePositiveHygiene(issue, nullReadFile), false, JSON.stringify(issue));
		}
	});

	it("classifies by path alone: no cited file is read", () => {
		const boom = () => {
			throw new Error("the hygiene rule must not read the cited file");
		};
		assert.strictEqual(isFalsePositiveHygiene(hyg({ path: "src/widget.test.ts" }), boom), true);
	});
});

describe("fp-filter — hygiene integration and invariants (Phase 2)", () => {
	it("always carries the full suppressed key set, even for empty input", () => {
		for (const input of [null, undefined, 42, "x", {}, { securityIssues: [] }]) {
			const { suppressed } = sanitizeAnalysisData(input, readFile);
			assert.deepStrictEqual(
				Object.keys(suppressed).sort(),
				["deadCode", "duplicates", "hygiene", "layerViolations", "security"],
				JSON.stringify(input),
			);
		}
	});

	it("routes a LOW hygiene finding to suppressed.hygiene, never suppressed.security", () => {
		const finding = hyg({ path: "src/widget.test.ts" });
		const { data, suppressed } = sanitizeAnalysisData({ securityIssues: [finding] }, readFile);
		assert.deepStrictEqual(suppressed.hygiene, [finding]);
		assert.deepStrictEqual(suppressed.security, []);
		assert.deepStrictEqual(data.securityIssues, []);
	});

	it("accounts for every input entry across the three buckets", () => {
		const issues = [
			sec(),
			sec({ code: "" }),
			hyg({ path: "src/widget.test.ts" }),
			sec({ severity: "low", title: "Code Comments", code: "// TODO", path: "src/config.ts" }),
		];
		const violations = [violation(), violation({ from: "cmd/build.go", to: "ui/src/retry.rs" })];
		const input = {
			files: LAYER_FILES,
			connections: CONNECTIONS,
			securityIssues: issues,
			layerViolations: violations,
		};
		const before = structuredClone(input);

		const { data, suppressed } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(
			data.securityIssues.length + suppressed.security.length + suppressed.hygiene.length,
			issues.length,
		);
		assert.strictEqual(
			data.layerViolations.length + suppressed.layerViolations.length,
			violations.length,
		);
	});

	it("leaves stats.security alone when only hygiene findings are dropped", () => {
		const input = {
			stats: { files: 2, security: 1 },
			securityIssues: [sec(), hyg({ path: "src/widget.test.ts" })],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(suppressed.hygiene.length, 1);
		assert.strictEqual(data.stats.security, 1, "the score term counts HIGH findings only");
	});

	it("is idempotent when hygiene findings are dropped on the first pass", () => {
		const input = { securityIssues: [sec({ code: "" }), hyg({ path: "src/widget.test.ts" })] };
		const first = sanitizeAnalysisData(input, readFile);
		const second = sanitizeAnalysisData(first.data, readFile);
		assert.deepStrictEqual(second.data, first.data);
		assert.deepStrictEqual(second.suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});
});

describe("fp-filter — MEDIUM Command Execution proves the file argv-safe before dropping it", () => {
	const cmd = (path: string) =>
		sec({ severity: "medium", title: "Command Execution", code: "", path });

	it("drops a MEDIUM Command Execution whose file routes every spawn through the policy", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/safe-wrapper.ts")),
			false,
			"literal+argvCommand+assertNoShell",
		);
	});

	it("drops a MEDIUM Command Execution whose file promisifies `execFile` through the policy", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/safe-promisified.ts")),
			false,
			"aliased execFile is still seen",
		);
	});

	it("drops a MEDIUM Command Execution whose file only imports the `ChildProcess` type", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/type-only.ts")),
			false,
			"a type import is no call site",
		);
	});

	it("keeps a MEDIUM Command Execution with a dynamic program (regression)", () => {
		// `spawn(request.command, args)` — executable provenance is not provable.
		assert.strictEqual(keepsSecurity(cmd("src/dynamic-command.ts")), true);
	});

	it("keeps a MEDIUM Command Execution whose dynamic program flows through `argvCommand` (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/wrapped-dynamic.ts")),
			true,
			"argvCommand on a dynamic argument does not prove a literal program",
		);
	});

	it("keeps a MEDIUM Command Execution whose program is a parameter passed through a wrapper (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/wrapper-passthrough.ts")),
			true,
			"a parameter is not a literal",
		);
	});

	it("keeps a MEDIUM Command Execution whose argv is not a validated source (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/unvalidated-args.ts")),
			true,
			"a literal program alone is not enough without a validated argv",
		);
	});

	it("keeps a MEDIUM Command Execution with an aliased shell exec beside a safe spawn (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/aliased-exec.ts")),
			true,
			"aliased exec() must survive",
		);
	});

	it("keeps a MEDIUM Command Execution with a computed child-process member beside a safe spawn (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/computed-namespace.ts")),
			true,
			'cp["ex" + "ec"](cmd) is a member access the name scan cannot see',
		);
	});

	it("keeps a MEDIUM Command Execution with a computed member through a namespace alias (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/computed-alias.ts")),
			true,
			"an aliased namespace is still a child-process source",
		);
	});

	it("keeps a MEDIUM Command Execution with an inline computed require result (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/computed-inline-require.ts")),
			true,
			'require("node:child_process")["ex" + "ec"] is unproveable',
		);
	});

	it("keeps a MEDIUM Command Execution with an inline dotted require call (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dotted-inline-require.ts")),
			true,
			'require("node:child_process").spawn(dynamic, ...) is unproveable',
		);
	});

	it("keeps a MEDIUM Command Execution with a dynamic-import namespace (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dynamic-import-bound.ts")),
			true,
			'const cp = await import("node:child_process") is still a child-process source',
		);
	});

	it("keeps a MEDIUM Command Execution whose namespace is assigned, not declared (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/assigned-namespace.ts")),
			true,
			'cp = require("node:child_process") is still a child-process source',
		);
	});

	it("keeps a MEDIUM Command Execution with a paren-wrapped inline dynamic import (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dynamic-import-paren.ts")),
			true,
			'(await import("node:child_process")).spawn(dynamic, ...) is unproveable',
		);
	});

	it("drops a MEDIUM Command Execution whose dynamic-import namespace spawns a literal argv (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dynamic-import-safe.ts")),
			false,
			"a resolved namespace call with a literal program and argv is safe",
		);
	});

	it("keeps a MEDIUM Command Execution with a computed member through a parenthesised dynamic import (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dynamic-import-paren-bound.ts")),
			true,
			'const cp = (await import("node:child_process")) then cp["spawn"](dynamic) must survive',
		);
	});

	it("drops a MEDIUM Command Execution whose nested-paren dynamic import spawns a literal argv (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dynamic-import-nested-paren-safe.ts")),
			false,
			"a parenthesised binding with a literal program and argv is safe",
		);
	});

	it("keeps a MEDIUM Command Execution whose namespace binding is an unenumerated expression (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/ternary-namespace.ts")),
			true,
			"a ternary binding of the module result is unproveable — fail closed",
		);
	});

	it("keeps a MEDIUM Command Execution whose shell exec is renamed by require destructuring (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/renamed-exec.ts")),
			true,
			"`const { exec: run } = require(...)` must register the shell member",
		);
	});

	it("keeps a MEDIUM Command Execution with a computed member reached through optional chaining (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/optional-computed.ts")),
			true,
			'cp?.["ex" + "ec"](cmd) is still a computed child-process member',
		);
	});

	it("keeps a MEDIUM Command Execution whose dynamic program is reached through optional chaining (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/optional-dynamic.ts")),
			true,
			"cp?.spawn(dynamic, ...) must still be scanned",
		);
	});

	it("keeps a MEDIUM Command Execution whose member is reached through `.call` (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/dotted-call.ts")),
			true,
			"cp.spawn.call(...) bypasses the argument scan",
		);
	});

	it("keeps a MEDIUM Command Execution that shells out (positive control)", () => {
		assert.strictEqual(keepsSecurity(cmd("src/shell-out.ts")), true, "execSync must survive");
	});

	it("keeps a MEDIUM Command Execution with `shell: true` (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shell-true.ts")),
			true,
			"a truthy shell option must survive",
		);
	});

	it("keeps a MEDIUM Command Execution that runs a shell program with `-c` (positive control)", () => {
		assert.strictEqual(keepsSecurity(cmd("src/shell-program.ts")), true, "bash -c must survive");
	});

	it("keeps a MEDIUM Command Execution whose program literal hides a shell behind an escape (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/escaped-program.ts")),
			true,
			'`"/bin/\\u0073h"` resolves to `/bin/sh` — an escaped literal is not a literal',
		);
	});

	it("keeps a MEDIUM Command Execution whose argv assembles a shell flag (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/constructed-flag.ts")),
			true,
			'`"-" + "c"` builds `-c`; a constructed argv element is not a validated source',
		);
	});

	it("keeps a MEDIUM Command Execution with an escaped program and a constructed flag (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/escaped-constructed.ts")),
			true,
			'the audit bypass probe: spawn("/bin/\\u0073h", ["-" + "c", cmd], { shell: false })',
		);
	});

	it("drops a MEDIUM Command Execution whose argv is a plain literal holding dashes (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/literal-dashed-args.ts")),
			false,
			"the constructed/escaped guards must not over-reject a literal argv",
		);
	});

	it("keeps a MEDIUM Command Execution whose argv element interpolates a template (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpolated-argv.ts")),
			true,
			"`--flag${x}` can assemble a shell flag; a template hole is not a literal element",
		);
	});

	it("keeps a MEDIUM Command Execution whose options spread over `shell: false` (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/spread-options.ts")),
			true,
			"{ shell: false, ...opts } can be overridden at runtime — not a proven shell-off",
		);
	});

	it("keeps a MEDIUM Command Execution whose shell is disabled only by a bare literal (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/bare-shell-false.ts")),
			true,
			"only the policy's runtime-enforced `assertNoShell` proves the shell is off",
		);
	});

	it("keeps a MEDIUM Command Execution whose options bind a literal environment (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-options.ts")),
			true,
			"`env: { GIT_CONFIG_* }` makes git run core.sshCommand — shell:false proves nothing",
		);
	});

	it("keeps a MEDIUM Command Execution whose options carry the env shorthand (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-shorthand.ts")),
			true,
			"`{ cwd, env, stdio }` binds the same environment",
		);
	});

	it("keeps a MEDIUM Command Execution whose options spread `process.env` (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-spread.ts")),
			true,
			"a spread environment hides every command-execution channel variable",
		);
	});

	it("keeps a MEDIUM Command Execution whose options are a binding carrying an env (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-aliased-options.ts")),
			true,
			"`assertNoShell(opts)` hides the env from the text proof — an unresolved binding is not proof",
		);
	});

	it("keeps a MEDIUM Command Execution whose options literal spreads a binding (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-spread-binding.ts")),
			true,
			"`{ ...opts }` re-introduces every key the literal does not show",
		);
	});

	it("drops a MEDIUM Command Execution whose options bind no environment (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/env-free-options.ts")),
			false,
			"the env guard must not over-reject ordinary spawn options",
		);
	});

	it("keeps a MEDIUM Command Execution whose `assertNoShell` sits behind an ignored argument (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shadowed-options.ts")),
			true,
			"argv position 3 is the effective options; a trailing assertNoShell does not prove them",
		);
	});

	it("keeps a MEDIUM Command Execution whose `assertNoShell` is a shadowing parameter (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shadowed-helper.ts")),
			true,
			"a parameter bound to the policy's name can return shell-enabled options",
		);
	});

	it("keeps a MEDIUM Command Execution whose `assertNoShell` is a shadowing function declaration (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shadowed-function.ts")),
			true,
			"a local function of the same name shadows the import",
		);
	});

	it("keeps a MEDIUM Command Execution whose shadowing parameter sits first (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shadowed-param-first.ts")),
			true,
			"the name is a parameter binding, not the imported helper",
		);
	});

	it("keeps a MEDIUM Command Execution whose `argvCommand` is shadowed by a local declaration (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/shadowed-command.ts")),
			true,
			"a shadowed `argvCommand` never validated the argv",
		);
	});

	it("drops a MEDIUM Command Execution whose policy import lists a third name after `assertNoShell` (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/mid-import.ts")),
			false,
			"the import list separator is not a shadowing declaration",
		);
	});

	it("keeps a MEDIUM Command Execution whose argvCommand hands an interpreter its code flag (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpreter-eval-binding.ts")),
			true,
			'argvCommand("node", ["-e", code]) runs attacker-supplied code',
		);
	});

	it("keeps a MEDIUM Command Execution whose interpreter argv array carries the code flag (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpreter-eval-direct.ts")),
			true,
			"node -e is arbitrary code execution, not a shell-free command",
		);
	});

	it("keeps a MEDIUM Command Execution with a dynamic argv for an interpreter (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpreter-dynamic-argv.ts")),
			true,
			"a bound argv cannot be proven free of the interpreter's code flag",
		);
	});

	it("keeps a MEDIUM Command Execution whose interpreter argv uses the `--eval=` form (regression)", () => {
		assert.strictEqual(keepsSecurity(cmd("src/interpreter-eval-long.ts")), true);
	});

	it("drops a MEDIUM Command Execution whose interpreter call carries no code flag (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpreter-safe-flags.ts")),
			false,
			"node --version must not be blanket-denied",
		);
	});

	it("keeps a MEDIUM Command Execution where a runner delegates to an interpreter in argv (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/runner-delegates-eval.ts")),
			true,
			'argvCommand("env", ["node", "-e", code]) runs code through the runner',
		);
	});

	it("keeps a MEDIUM Command Execution whose literal argv names an interpreter plus its code flag (regression)", () => {
		assert.strictEqual(keepsSecurity(cmd("src/runner-literal-eval.ts")), true);
	});

	it("drops a MEDIUM Command Execution whose runner argv carries no interpreter code flag (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/runner-safe.ts")),
			false,
			"npx --version must not be blanket-denied",
		);
	});

	it("keeps a MEDIUM Command Execution whose interpreter argv uses a module-loading flag (regression)", () => {
		for (const [path, flag] of [
			["src/interpreter-require.ts", "--require"],
			["src/interpreter-import.ts", "--import"],
			["src/interpreter-loader.ts", "--loader"],
			["src/interpreter-perl-m.ts", "-MAttacker"],
		] as const) {
			assert.strictEqual(
				keepsSecurity(cmd(path)),
				true,
				`${flag} loads and runs attacker-named code — not a shell-free command`,
			);
		}
	});

	it("keeps a MEDIUM Command Execution whose interpreter argv uses an attached or combined code flag (regression)", () => {
		for (const [path, flag] of [
			["src/interpreter-python-attached-c.ts", "-cprint(1)"],
			["src/interpreter-shell-attached-c.ts", "-lc"],
		] as const) {
			assert.strictEqual(
				keepsSecurity(cmd(path)),
				true,
				`${flag} runs argv code — not a shell-free command`,
			);
		}
	});

	it("drops a MEDIUM Command Execution whose interpreter call names a script file (positive control)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/interpreter-script.ts")),
			false,
			"node server.js must not be blanket-denied",
		);
	});

	it("keeps a MEDIUM Command Execution importing the policy from a same-named module of another path (regression)", () => {
		// `./attacker-safe-argv.ts` contains `safe-argv` but is not the shared module.
		assert.strictEqual(
			keepsSecurity(cmd("src/fake-policy-module.ts")),
			true,
			"a same-named helper is not import provenance",
		);
	});

	it("keeps a MEDIUM Command Execution whose policy import resolves to an unreadable module (regression)", () => {
		assert.strictEqual(
			keepsSecurity(cmd("src/local-lib-fake.ts")),
			true,
			"the resolved module must be the shared policy, and absent is not proven",
		);
	});

	it("keeps a MEDIUM Command Execution whose policy import is a readable counterfeit ending in lib/safe-argv.ts (regression)", () => {
		// `src/attacker/lib/safe-argv.ts` is readable and exports the names, but it
		// is not the canonical shared module — a suffix match would forge provenance.
		assert.strictEqual(
			keepsSecurity(cmd("src/counterfeit-policy.ts")),
			true,
			"only the exact canonical policy path is trusted",
		);
	});

	it("keeps a MEDIUM Command Execution whose policy import is a counterfeit at the exact canonical path (regression)", () => {
		// The audit probe: a module at `.pi/extensions/lib/safe-argv.ts` that exports
		// the helpers but returns `shell: true`. Names are not proof — only the
		// reviewed module's content is, so the counterfeit must not forge provenance.
		const counterfeit =
			"export function argvCommand(program, args) { return { program, args }; }\n" +
			"export function assertNoShell(options) { return { ...options, shell: true }; }\n";
		const cite =
			'import { spawn } from "node:child_process";\n' +
			'import { argvCommand, assertNoShell } from "../.pi/extensions/lib/safe-argv.ts";\n' +
			"export function go(args) {\n" +
			'  const { program, args: safe } = argvCommand("git", args);\n' +
			"  return spawn(program, safe, assertNoShell({}));\n" +
			"}\n";
		const readCounterfeit = (path: unknown): string | null =>
			path === ".pi/extensions/lib/safe-argv.ts"
				? counterfeit
				: path === "src/canonical-counterfeit.ts"
					? cite
					: null;
		const { data } = sanitizeAnalysisData(
			{ securityIssues: [cmd("src/canonical-counterfeit.ts")] },
			readCounterfeit,
		);
		assert.strictEqual(
			data.securityIssues.length,
			1,
			"a counterfeit at the canonical path is not provenance",
		);
	});

	it("keeps the finding when the canonical module differs by one byte (content-identity provenance)", () => {
		// Editing the policy (even a trailing comment) invalidates the pinned digest,
		// so provenance fails closed until the digest is re-reviewed.
		const tampered = `${POLICY_SRC}\n// tampered\n`;
		const readTampered = (path: unknown): string | null =>
			path === ".pi/extensions/lib/safe-argv.ts" ? tampered : readFile(path);
		const { data } = sanitizeAnalysisData(
			{ securityIssues: [cmd("src/safe-wrapper.ts")] },
			readTampered,
		);
		assert.strictEqual(
			data.securityIssues.length,
			1,
			"a changed policy module is not the reviewed one",
		);
	});

	it("keeps the finding when the cited file cannot be read (absence is not proof)", () => {
		assert.strictEqual(keepsSecurity(cmd("does/not/exist.ts")), true);
	});

	it("keeps a MEDIUM Command Execution in a file with no recognised safe shape", () => {
		// `spawn()` with no import and no argv still runs an executable.
		assert.strictEqual(keepsSecurity(cmd("src/spawn.ts")), true);
	});
});

describe("fp-filter — non-mutating and idempotent (Phases 1-2)", () => {
	it("returns a new object, preserves every non-security field and mutates nothing", () => {
		const input = {
			marker: "FIXTURE",
			stats: { files: 3, functions: 9, loc: 40 },
			unusedFunctions: [{ name: "dead" }],
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
			files: LAYER_FILES,
			connections: CONNECTIONS,
		};
		const before = structuredClone(input);

		const { data, suppressed } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.notStrictEqual(data, input, "output must be a new object");
		assert.strictEqual(data.marker, "FIXTURE");
		assert.deepStrictEqual(data.stats, { files: 3, functions: 9, loc: 40 });
		assert.deepStrictEqual(data.unusedFunctions, [{ name: "dead" }]);
		assert.strictEqual(suppressed.security.length, 1);
		assert.strictEqual(suppressed.layerViolations.length, 2);
		assert.strictEqual(suppressed.hygiene.length, 0);
		assert.strictEqual(data.securityIssues.length, 1);
		assert.strictEqual(data.layerViolations.length, 0);
	});

	it("is idempotent: a second pass changes nothing and suppresses nothing", () => {
		const input = {
			files: LAYER_FILES,
			connections: CONNECTIONS,
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
		};
		const first = sanitizeAnalysisData(input, readFile);
		const second = sanitizeAnalysisData(first.data, readFile);

		assert.deepStrictEqual(second.data, first.data);
		assert.deepStrictEqual(second.suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});

	it("passes data without securityIssues/layerViolations through unchanged", () => {
		const input = { marker: "FIXTURE", stats: { files: 1 } };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data, input);
		assert.deepStrictEqual(Object.keys(data), Object.keys(input));
		assert.deepStrictEqual(suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});

	it("moves stats.security/violations with the filtered arrays, without mutating the input stats", () => {
		// The report summary and the UI tab badge read these counts; a stale pair
		// would leave an A report advertising the findings the filter just dropped.
		const input = {
			stats: { files: 3, security: 2, violations: 2 },
			securityIssues: [sec({ code: "" }), sec()],
			layerViolations: [violation(), violation({ to: "ui/src/retry.rs" })],
			files: LAYER_FILES,
			connections: CONNECTIONS,
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, readFile);

		assert.deepStrictEqual(input.stats, before.stats, "input stats must not be touched");
		assert.notStrictEqual(data.stats, input.stats, "output stats must be a new object");
		// No layer is declared, so both layer violations are suppressed and the
		// summary count moves to zero with the list.
		assert.deepStrictEqual(data.stats, { files: 3, security: 1, violations: 0 });

		const second = sanitizeAnalysisData(data, readFile);
		assert.deepStrictEqual(second.data.stats, data.stats, "the corrected counts are stable");
	});
});

describe("fp-filter — layer violations (Phase 2)", () => {
	// The order-aware rule is the policy engine. Production supplies the repo's
	// declared taxonomy — empty, because docs/architecture.md declares no ordered
	// layer boundary — so the rule is exercised here with an injected taxonomy.
	// This is the positive control: a genuine lower-ranked -> higher-ranked import
	// is kept, not blanket-suppressed.
	const SYNTHETIC_LAYERS = [
		{ prefix: "app/deep/", layer: "deep", rank: 0 },
		{ prefix: "app/", layer: "app", rank: 1 },
		{ prefix: "app/top/", layer: "top", rank: 2 },
	];
	const SYNTH_CONNECTIONS = [
		{ source: "app/from.ts", target: "app/top/to.ts" },
		{ source: "app/deep/from.ts", target: "app/from.ts" },
		{ source: "app/deep/from.ts", target: "app/deep/to.ts" },
	];

	/** The order rule with an injected taxonomy; production declares none. */
	function keepsWithTaxonomy(
		v: unknown,
		connections: Array<{ source: string; target: string }> = SYNTH_CONNECTIONS,
	): boolean {
		const idx: Record<string, boolean> = Object.create(null);
		for (const c of connections) idx[`${c.source}\u0000${c.target}`] = true;
		return !isFalsePositiveLayerViolation(v, { connections: idx, layers: SYNTHETIC_LAYERS });
	}

	const synth = (over: Record<string, unknown> = {}) => ({
		from: "app/from.ts",
		to: "app/top/to.ts",
		fromLayer: "app",
		toLayer: "top",
		...over,
	});

	it("declares no ordered layer taxonomy: this repo has none", () => {
		// docs/architecture.md declares no lower/higher boundary, so a source root
		// (`scripts/`, `cmd/`, `.pi/extensions/`, `test/`) is not a layer.
		assert.deepStrictEqual(REPO_LAYERS, [], "a source root is not a declared layer");
	});

	it("resolves nothing — no path maps to a layer", () => {
		for (const path of [
			`${EXT}from.ts`,
			`${TEST}to.ts`,
			"cmd/cheasee-pi/build.go",
			"scripts/install.sh",
			`${UI}src/retry.rs`,
			"README.md",
			".pi/skills/audit/SKILL.md",
		]) {
			assert.strictEqual(resolveLayer(path), null, path);
		}
	});

	it("resolves nothing for empty, non-string and extensionless paths", () => {
		for (const path of ["", "Makefile", 42, null, undefined]) {
			assert.strictEqual(resolveLayer(path), null, JSON.stringify(path));
		}
	});

	it("suppresses every analyzer layer edge while the taxonomy is empty", () => {
		for (const v of [
			violation(),
			violation({ from: `${TEST}from.ts`, to: `${EXT}to.ts` }),
			violation({ to: `${UI}src/retry.rs` }),
			violation({ from: "cmd/cheasee-pi/build.go", to: `${UI}src/retry.rs` }),
		]) {
			assert.strictEqual(keepsViolation(v), false, JSON.stringify(v));
		}
	});

	it("keeps a genuine inverting same-language edge (positive control)", () => {
		assert.strictEqual(keepsWithTaxonomy(synth()), true);
	});

	it("resolves the most specific declared prefix (nested root beats its parent)", () => {
		// app/deep/from.ts is `deep` (rank 0), app/from.ts is `app` (rank 1): the
		// inversion holds. If the nested prefix were ignored both would resolve to
		// `app` (same rank) and the edge would be suppressed.
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/deep/from.ts", to: "app/from.ts" })),
			true,
		);
	});

	it("drops a same-rank edge", () => {
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/deep/from.ts", to: "app/deep/to.ts" })),
			false,
			"two files in the same layer cannot invert it",
		);
	});

	it("drops a reverse-direction edge", () => {
		assert.strictEqual(
			keepsWithTaxonomy(synth({ from: "app/top/from.ts", to: "app/from.ts" })),
			false,
			"higher rank -> lower rank is the intended direction",
		);
	});

	it("drops an endpoint under an undeclared root", () => {
		assert.strictEqual(keepsWithTaxonomy(synth({ from: "other/from.ts" })), false);
	});

	it("drops cross-language pairs", () => {
		assert.strictEqual(keepsWithTaxonomy(synth({ to: "app/top/to.rs" })), false);
	});

	it("drops a pair with no recorded connection (or only the reverse one)", () => {
		assert.strictEqual(keepsWithTaxonomy(synth(), []), false);
		assert.strictEqual(
			keepsWithTaxonomy(synth(), [{ source: "app/top/to.ts", target: "app/from.ts" }]),
			false,
		);
	});

	it("decides by the declared taxonomy, never the analyzer's files[].layer", () => {
		// The report's own labels are inverted and wrong; the taxonomy still keeps
		// the genuine edge.
		assert.strictEqual(keepsWithTaxonomy(synth({ fromLayer: "utils", toLayer: "services" })), true);
		// An inversion-looking label pair cannot rescue a genuinely reversed edge.
		assert.strictEqual(
			keepsWithTaxonomy(
				synth({
					from: "app/top/from.ts",
					to: "app/from.ts",
					fromLayer: "utils",
					toLayer: "services",
				}),
			),
			false,
		);
	});

	it("drops malformed and extensionless endpoints (positive control intact)", () => {
		for (const bad of [null, "x", {}, synth({ from: "" }), synth({ to: undefined })]) {
			assert.strictEqual(keepsWithTaxonomy(bad), false, JSON.stringify(bad));
		}
		assert.strictEqual(keepsWithTaxonomy(synth({ from: "Makefile", to: "Makefile" })), false);
	});

	it("accounts for every input entry as kept or suppressed", () => {
		const layerViolations = [
			violation(),
			violation({ from: "cmd/cheasee-pi/build.go", to: `${UI}src/retry.rs` }),
			violation({ from: `${TEST}from.ts`, to: `${EXT}to.ts` }),
		];
		const input = { files: LAYER_FILES, connections: CONNECTIONS, layerViolations };
		const { data, suppressed } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(
			data.layerViolations.length + suppressed.layerViolations.length,
			layerViolations.length,
		);
		assert.deepStrictEqual(suppressed.layerViolations, layerViolations);
	});
});

describe("fp-filter — unused-function reference rule (Phase 1)", () => {
	/** Sanitize one dead-code entry against `sources`; every entry must survive or be suppressed. */
	function keepsDead(name: unknown, file: unknown, sources: Record<string, string> = {}): boolean {
		const input = {
			files: Object.keys(sources).map((path) => ({ path })),
			deadFunctions: [{ name, file, line: 1, ext: "ts" }],
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.strictEqual(
			suppressed.deadCode.length + data.deadFunctions.length,
			1,
			"no entry may vanish",
		);
		return data.deadFunctions.length === 1;
	}

	it("drops an entry a different file calls (the trait-impl methods)", () => {
		assert.strictEqual(
			keepsDead("on_message", "ui/src/ws.rs", {
				"ui/src/ws.rs":
					"pub trait Socket {\n    fn on_message<F: FnMut(String)>(&self, handler: F);\n}\n",
				"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
			}),
			false,
		);
	});

	it("attributes a cross-file mention to the listed definition only when it can be", () => {
		// Two modules define `helper`; a.ts calls its own, so the bare call there
		// cannot excuse b.ts's unreferenced copy.
		const shared = {
			"src/a.ts": "export function helper() { return 1; }\nexport function run() { helper(); }\n",
			"src/b.ts": "export function helper() { return 2; }\n",
		};
		assert.strictEqual(
			keepsDead("helper", "src/a.ts", shared),
			false,
			"a same-file use refutes it",
		);
		assert.strictEqual(
			keepsDead("helper", "src/b.ts", shared),
			true,
			"the bare call in a.ts resolves to a.ts's own `helper`, so it cannot refute b.ts's",
		);
		// A receiver call dispatches through the receiver's type, so a file that
		// defines the same name does not make it ambiguous. This is the shape the
		// real report carries: `socket.on_close(...)` in retry.rs, whose own policy
		// type also has an `on_close`, against `on_close` implemented in ws.rs.
		assert.strictEqual(
			keepsDead("on_close", "ui/src/ws.rs", {
				"ui/src/ws.rs": "impl Socket for Ws {\n    fn on_close(&self) {}\n}\n",
				"ui/src/retry.rs":
					"impl Policy {\n    pub fn on_close(&mut self) -> u64 { 1 }\n}\n" +
					"fn wire(socket: &Ws) {\n    socket.on_close();\n}\n",
			}),
			false,
			"a dot-call is not resolved by the caller's own same-named definition",
		);
		// A name no file defines keeps resolving cross-file, whatever the shape.
		assert.strictEqual(
			keepsDead("solo", "src/d.ts", {
				"src/d.ts": "pub fn solo() -> u64 { 1 }\n",
				"src/e.rs": "fn wire() {\n    let handler = solo;\n}\n",
			}),
			false,
		);
		// Two modules define `helper`, and a third only calls one of them: the
		// target is ambiguous from text, so neither copy may be called live by it.
		const thirdCaller = {
			"src/a.ts": "export function helper() { return 1; }\n",
			"src/b.ts": "export function helper() { return 2; }\n",
			"src/c.ts": "import { helper } from './a';\nexport function run() { helper(); }\n",
		};
		assert.strictEqual(
			keepsDead("helper", "src/a.ts", thirdCaller),
			true,
			"a bare call from a third module cannot be attributed to one of two same-named owners",
		);
		assert.strictEqual(keepsDead("helper", "src/b.ts", thirdCaller), true);
	});

	it("drops an entry its own file references outside the definition", () => {
		assert.strictEqual(
			keepsDead("reconnect_delay", "ui/src/retry.rs", {
				"ui/src/retry.rs":
					"pub fn reconnect_delay(effect: u64) -> u64 { effect }\n" +
					"fn dial() {\n    let d = reconnect_delay(500);\n}\n",
			}),
			false,
		);
	});

	it("drops an entry referenced as a value (?? name, = name, , name)", () => {
		assert.strictEqual(
			keepsDead("defaultIsWritable", ".pi/extensions/scrapling/browser-setup.ts", {
				".pi/extensions/scrapling/browser-setup.ts":
					"function defaultIsWritable(path: string): boolean { return true; }\n" +
					"const isWritable = opts.isWritable ?? defaultIsWritable;\n",
			}),
			false,
		);
		assert.strictEqual(
			keepsDead("defaultFetch", ".pi/lib/fetch-report.ts", {
				".pi/lib/fetch-report.ts":
					"const defaultFetch: FetchFn = (url, init) => fetch(url, init);\n" +
					"let fetchFn: FetchFn = defaultFetch;\n" +
					"pick(url, defaultFetch);\n",
			}),
			false,
		);
	});

	it("drops an entry only referenced through a dot-call", () => {
		assert.strictEqual(
			keepsDead("is_open", "ui/src/retry.rs", {
				"ui/src/retry.rs":
					"pub fn is_open(&self) -> bool { true }\n" +
					"fn send(transport: &Transport) {\n    if !transport.is_open() { return; }\n}\n",
			}),
			false,
		);
	});

	it("keeps an entry whose only occurrence is its own definition head", () => {
		for (const [path, src] of [
			["src/a.ts", "function foo(x: number) { return x; }\n"],
			["src/b.rs", "fn foo(x: u64) -> u64 { x }\n"],
			["src/c.ts", "const foo = (x: number) => x;\n"],
		] as Array<[string, string]>) {
			assert.strictEqual(keepsDead("foo", path, { [path]: src }), true, path);
		}
	});

	it("keeps a recursion-only entry (a self-reference is not a use)", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d.ts", { "src/d.ts": "function foo() { return foo(); }\n" }),
			true,
		);
	});

	it("keeps a recursion-only entry whose signature carries a type brace", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d2.ts", {
				"src/d2.ts": "function foo(opts: { x: number }) { return foo(opts); }\n",
			}),
			true,
			"a parameter type brace is part of the signature, not the body",
		);
		assert.strictEqual(
			keepsDead("foo", "src/d3.ts", {
				"src/d3.ts": "function foo(opts: { x: number }): { y: number } { return foo(opts); }\n",
			}),
			true,
			"a return type brace is part of the signature, not the body",
		);
	});

	it("keeps a declaration-only Go function or method (func name)", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/go1.go", { "src/go1.go": "package main\nfunc ghost() {}\n" }),
			true,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/go2.go", {
				"src/go2.go": "package main\ntype R struct{}\nfunc (r *R) ghost() {}\n",
			}),
			true,
			"a Go method with a receiver is still a declaration",
		);
	});

	it("keeps a declaration-only TypeScript class method (name() {})", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/cls1.ts", { "src/cls1.ts": "class A {\n\tghost() {}\n}\n" }),
			true,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/cls2.ts", {
				"src/cls2.ts": "class A {\n\tstatic async ghost(x: number): void {}\n}\n",
			}),
			true,
			"a return-type annotation and modifiers are still a declaration head",
		);
	});

	it("still suppresses a declared function that a real call reaches", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/go3.go", {
				"src/go3.go": "package main\nfunc ghost() {}\nfunc use() { ghost() }\n",
			}),
			false,
		);
		assert.strictEqual(
			keepsDead("ghost", "src/cls3.ts", {
				"src/cls3.ts": "class A {\n\tghost() {}\n}\nnew A().ghost();\n",
			}),
			false,
		);
	});

	it("still detects an external use after a typed signature", () => {
		assert.strictEqual(
			keepsDead("foo", "src/d4.ts", {
				"src/d4.ts": "function foo(opts: { x: number }) { return 1; }\nconst v = foo({ x: 1 });\n",
			}),
			false,
		);
	});

	it("keeps an entry no file mentions", () => {
		assert.strictEqual(
			keepsDead("ghost", "src/e.ts", { "src/e.ts": "export const a = 1;\n" }),
			true,
		);
	});

	it("keeps an entry that only a comment mentions", () => {
		assert.strictEqual(
			keepsDead("foo", "src/f.ts", {
				"src/f.ts": "// foo() runs on the retry path\n/* foo(bar) */\n",
			}),
			true,
		);
	});

	it("keeps an entry that only a string or template literal mentions", () => {
		assert.strictEqual(
			keepsDead("foo", "src/g.ts", {
				"src/g.ts": 'const label = "foo()";\nconst t = `foo(bar)`;\n',
			}),
			true,
		);
	});

	it("does not match a name inside a longer identifier", () => {
		assert.strictEqual(
			keepsDead("read", "src/h.ts", {
				"src/h.ts": "function alreadyRead(p) { return p; }\nfunction read() { return 1; }\n",
			}),
			true,
			"alreadyRead( must not read as a use of read",
		);
		assert.strictEqual(
			keepsDead("on_message", "src/i.rs", {
				"src/i.rs": "fn main() { socket.on_message_handler(1); }\n",
			}),
			true,
		);
	});

	it("keeps entries with a missing or non-string name/file (unreprovable)", () => {
		const input = {
			files: [{ path: "src/a.ts" }],
			deadFunctions: [{ name: "foo" }, { file: "src/a.ts" }, { name: 42, file: "src/a.ts" }, null],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, () => "function foo(){}\n");
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, input.deadFunctions);
	});

	it("keeps every entry when no content can be read (fail open)", () => {
		assert.strictEqual(keepsDead("foo", "src/a.ts", {}), true);
	});

	it("keeps a finding when its own definition file cannot be read (mixed readable/unreadable)", () => {
		// The listed definition is unreadable, so the same-named call in the other
		// readable file cannot be attributed to it: the finding must stand.
		const sources: Record<string, string | null> = {
			"ui/src/ws.rs": null,
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = {
			files: [{ path: "ui/src/ws.rs" }, { path: "ui/src/retry.rs" }],
			deadFunctions: [entry],
		};
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
	});

	it("keeps every finding when only an unrelated scanned file cannot be read", () => {
		// One unavailable file leaves the index incomplete, so nothing is
		// suppressed rather than risk a wrong attribution.
		const sources: Record<string, string | null> = {
			"ui/src/ws.rs":
				"pub trait Socket {\n    fn on_message<F: FnMut(String)>(&self, handler: F);\n}\n",
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
			"ui/src/missing.ts": null,
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = {
			files: [{ path: "ui/src/ws.rs" }, { path: "ui/src/retry.rs" }, { path: "ui/src/missing.ts" }],
			deadFunctions: [entry],
			stats: { dead: 1 },
		};
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
		assert.strictEqual(data.stats.dead, 1, "the summary count must not move without a drop");
	});

	it("keeps a finding whose definition file is not among the analyzed files", () => {
		const sources: Record<string, string> = {
			"ui/src/retry.rs": "fn pump() {\n    socket.on_message(|text| echo(text));\n}\n",
		};
		const read = (p: unknown): string | null =>
			typeof p === "string" && p in sources ? sources[p] : null;
		const entry = { name: "on_message", file: "ui/src/ws.rs" };
		const input = { files: [{ path: "ui/src/retry.rs" }], deadFunctions: [entry] };
		const { data, suppressed } = sanitizeAnalysisData(input, read);
		assert.deepStrictEqual(suppressed.deadCode, []);
		assert.deepStrictEqual(data.deadFunctions, [entry]);
	});

	it("survives malformed input without throwing", () => {
		for (const input of [
			{},
			{ files: null },
			{ files: "nope" },
			{ files: [null, 1], deadFunctions: [] },
		]) {
			assert.doesNotThrow(() =>
				sanitizeAnalysisData(
					{ ...input, deadFunctions: [{ name: "foo", file: "a.ts" }] },
					readFile,
				),
			);
		}
	});
});

describe("fp-filter — unused-function wiring and stats (Phase 2)", () => {
	const DEAD_SOURCES: Record<string, string> = {
		"src/use.ts": "function keep() { return 1; }\nfunction hit() { return 2; }\nconst run = hit;\n",
		"src/other.ts": "function ghost() { return 3; }\nghost();\n",
	};
	const deadRead = (p: unknown): string | null =>
		typeof p === "string" && p in DEAD_SOURCES ? DEAD_SOURCES[p] : null;
	const deadFiles = [{ path: "src/use.ts" }, { path: "src/other.ts" }];

	it("keeps the survivors in input order and reports every drop", () => {
		const deadFunctions = [
			{ name: "hit", file: "src/use.ts" },
			{ name: "keep", file: "src/use.ts" },
			{ name: "ghost", file: "src/other.ts" },
		];
		const { data, suppressed } = sanitizeAnalysisData(
			{ files: deadFiles, deadFunctions },
			deadRead,
		);

		assert.deepStrictEqual(suppressed.deadCode, [deadFunctions[0], deadFunctions[2]]);
		assert.deepStrictEqual(data.deadFunctions, [deadFunctions[1]]);
		assert.strictEqual(
			data.deadFunctions.length + suppressed.deadCode.length,
			deadFunctions.length,
			"every input entry is kept or suppressed",
		);
	});

	it("filters the reported unusedFunctions alias too", () => {
		const unusedFunctions = [
			{ name: "hit", file: "src/use.ts" },
			{ name: "keep", file: "src/use.ts" },
		];
		const { data, suppressed } = sanitizeAnalysisData(
			{ files: deadFiles, unusedFunctions },
			deadRead,
		);
		assert.deepStrictEqual(data.unusedFunctions, [unusedFunctions[1]]);
		assert.deepStrictEqual(suppressed.deadCode, [unusedFunctions[0]]);
	});

	it("keeps the architecture entry that lists the dead functions consistent", () => {
		const entry = {
			type: "warning",
			title: "3 Unused Functions",
			desc: "Functions not called from other files",
			items: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
		};
		const input = {
			files: deadFiles,
			issues: [entry, { type: "warning", title: "1 Large Files", items: [] }],
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(
			data.issues[0].title,
			"1 Unused Functions",
			"the header must match the list",
		);
		assert.deepStrictEqual(
			data.issues[0].items.map((i: { name: string }) => i.name),
			["keep"],
		);
		assert.deepStrictEqual(data.issues[1], input.issues[1], "unrelated issues must pass through");
	});

	it("drops the architecture entry when no dead function survives", () => {
		const input = {
			files: deadFiles,
			issues: [
				{
					type: "warning",
					title: "1 Unused Functions",
					items: [{ name: "hit", file: "src/use.ts" }],
				},
			],
		};
		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(data.issues, []);
	});

	// The exported report cites the analyzer's count-only architecture summary
	// (`{title: "44 Unused Functions"}`, no `items`), so it must restate the
	// filtered count or the report contradicts its own list and `stats.dead`.
	it("restates the title-only Unused Functions summary to the surviving count", () => {
		const input = {
			files: deadFiles,
			issues: [{ title: "3 Unused Functions" }, { title: "1 Large Files" }],
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
				{ name: "ghost", file: "src/other.ts" },
			],
			stats: { dead: 3 },
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);

		assert.deepStrictEqual(input, before, "input must not be touched");
		assert.strictEqual(data.issues[0].title, "1 Unused Functions");
		assert.strictEqual(
			data.issues[0].title,
			`${data.stats.dead} Unused Functions`,
			"summary must agree with stats.dead",
		);
		assert.deepStrictEqual(data.issues[1], input.issues[1], "unrelated issues must pass through");
	});

	it("drops the title-only Unused Functions summary when nothing survives", () => {
		const input = {
			files: deadFiles,
			issues: [{ title: "1 Unused Functions" }],
			deadFunctions: [{ name: "hit", file: "src/use.ts" }],
		};
		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(data.issues, []);
	});

	it("keeps a title-only Unused Functions summary when no dead list is reportable", () => {
		const entry = { title: "3 Unused Functions" };
		const { data } = sanitizeAnalysisData({ files: deadFiles, issues: [entry] }, deadRead);
		assert.deepStrictEqual(data.issues, [entry]);
	});

	it("recounts stats.dead to the surviving list", () => {
		const input = {
			files: deadFiles,
			stats: { files: 1, functions: 10, dead: 3 },
			deadFunctions: [
				{ name: "hit", file: "src/use.ts" },
				{ name: "keep", file: "src/use.ts" },
			],
		};
		const before = structuredClone(input);

		const { data } = sanitizeAnalysisData(input, deadRead);
		assert.deepStrictEqual(input.stats, before.stats, "input stats must not be touched");
		assert.strictEqual(data.stats.dead, data.deadFunctions.length);
		assert.strictEqual(data.stats.dead, 1);
		assert.strictEqual(data.stats.functions, 10, "unrelated stats must survive");

		const second = sanitizeAnalysisData(data, deadRead);
		assert.deepStrictEqual(second.data, data, "idempotent");
		assert.deepStrictEqual(second.suppressed.deadCode, []);
	});

	it("leaves stats.dead alone when there is no dead-function list", () => {
		const { data } = sanitizeAnalysisData({ stats: { files: 1, dead: 3 } }, deadRead);
		assert.strictEqual(data.stats.dead, 3);
	});

	it("always reports a deadCode key, alongside the untouched ones", () => {
		const { suppressed } = sanitizeAnalysisData({ marker: "FIXTURE" }, deadRead);
		assert.deepStrictEqual(suppressed, {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
		});
	});
});

describe("fp-filter — duplicate group suppression (Phase 5)", () => {
	const dup = (over: Record<string, unknown> = {}) => ({
		type: "code",
		name: "makePi",
		files: [{ file: "a.ts" }],
		...over,
	});

	/** Sanitize one duplicate group and report whether it survived. */
	function keepsDuplicate(entry: Record<string, unknown>): boolean {
		const { data, suppressed } = sanitizeAnalysisData({ duplicates: [entry] }, readFile);
		assert.strictEqual(
			suppressed.duplicates.length + data.duplicates.length,
			1,
			"no duplicate group may vanish",
		);
		return data.duplicates.length === 1;
	}

	it("suppresses a code aggregate naming 3+ distinct members", () => {
		const aggregate = dup({ name: "withEnv, exec, cacheGet" });
		const pair = dup({ name: "readSettingsCodeflowPort, readSettingsUIPort" });
		const { data, suppressed } = sanitizeAnalysisData({ duplicates: [aggregate, pair] }, readFile);
		assert.deepStrictEqual(suppressed.duplicates, [aggregate]);
		assert.deepStrictEqual(data.duplicates, [pair]);
	});

	it("keeps pairwise, singleton and empty-name groups", () => {
		assert.strictEqual(
			keepsDuplicate(dup({ name: "readSettingsCodeflowPort, readSettingsUIPort" })),
			true,
		);
		assert.strictEqual(keepsDuplicate(dup({ name: "solo" })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: "" })), true, "an empty name is no evidence");
	});

	it("counts a repeated member once ('makePi, makePi' survives)", () => {
		assert.strictEqual(keepsDuplicate(dup({ name: "makePi, makePi" })), true);
	});

	it("suppresses only when the distinct member count exceeds 2 (boundary)", () => {
		assert.strictEqual(keepsDuplicate(dup({ name: "a, b" })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: "a, a, b" })), true, "2 distinct");
		assert.strictEqual(keepsDuplicate(dup({ name: "a, b, c" })), false);
		assert.strictEqual(
			keepsDuplicate(dup({ name: "a, a, b, b, c, c" })),
			false,
			"3 distinct after dedup",
		);
	});

	it("leaves non-code duplicate types alone", () => {
		assert.strictEqual(keepsDuplicate(dup({ type: "name", name: "a, b, c, d" })), true);
	});

	it("keeps a missing or non-string name (unknown is not suppression evidence)", () => {
		assert.strictEqual(keepsDuplicate({ type: "code", files: [] }), true);
		assert.strictEqual(keepsDuplicate(dup({ name: 42 })), true);
		assert.strictEqual(keepsDuplicate(dup({ name: null })), true);
	});

	it("defines suppressed.duplicates as [] and adds no key when data.duplicates is absent", () => {
		const { data, suppressed } = sanitizeAnalysisData({ marker: "x" }, readFile);
		assert.deepStrictEqual(suppressed.duplicates, []);
		assert.strictEqual("duplicates" in data, false, "no key is added when none existed");
	});

	it("moves stats.duplicates with the surviving array", () => {
		const input = {
			stats: { files: 1, duplicates: 2 },
			duplicates: [dup({ name: "a, b, c" }), dup({ name: "a, b" })],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(data.stats.duplicates, 1);
	});

	it("retitles the N Similar Code Blocks item to the surviving count", () => {
		const input = {
			duplicates: [dup({ name: "a, b, c" }), dup({ name: "x" })],
			issues: [
				{ type: "warning", title: "9 Similar Code Blocks", desc: "", items: [] },
				{ title: "Other" },
			],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.strictEqual(data.issues[0].title, "1 Similar Code Blocks");
		assert.strictEqual(data.issues[1].title, "Other");
	});

	it("removes the Similar Code Blocks item when every group is suppressed", () => {
		const input = {
			duplicates: [dup({ name: "a, b, c" })],
			issues: [{ title: "9 Similar Code Blocks" }, { title: "Keep" }],
		};
		const { data } = sanitizeAnalysisData(input, readFile);
		assert.deepStrictEqual(data.issues, [{ title: "Keep" }]);
	});

	it("is idempotent when a duplicate group is suppressed", () => {
		const input = { duplicates: [dup({ name: "a, b, c" }), dup({ name: "a, b" })] };
		const first = sanitizeAnalysisData(input, readFile);
		const second = sanitizeAnalysisData(first.data, readFile);
		assert.deepStrictEqual(second.data, first.data);
		assert.deepStrictEqual(second.suppressed.duplicates, []);
	});
});

describe("fp-filter — browser readFile source", () => {
	it("reads files[].content, falls back to the served files[].piFpSource, else null", () => {
		const fromData = readFileFrom({
			files: [
				{ path: "a.ts", content: "export const a = 1;\n" },
				{ path: "b.ts" },
				{ path: "c.ts", content: null, piFpSource: "export function c() {}\n" },
				{ path: "d.ts", content: 7, piFpSource: "export function d() {}\n" },
			],
		});
		assert.strictEqual(fromData("a.ts"), "export const a = 1;\n");
		assert.strictEqual(
			fromData("c.ts"),
			"export function c() {}\n",
			"freed content must fall back to the served piFpSource",
		);
		assert.strictEqual(
			fromData("d.ts"),
			"export function d() {}\n",
			"a non-string content must not block the fallback",
		);
		assert.strictEqual(
			fromData("b.ts"),
			null,
			"no retained source => null, so the filter fails open",
		);
		assert.strictEqual(fromData("missing.ts"), null);
		assert.strictEqual(fromData(undefined), null);
		assert.strictEqual(fromData("toString"), null, "prototype keys must not leak");
	});

	it("suppresses a dead function the served browser shape still references", () => {
		// Exactly what the served page hands the filter: the analyzer has nulled
		// every `content`, the index.html rewrite kept the text on `piFpSource`.
		const data = {
			files: [
				{ path: "def.ts", content: null, piFpSource: "export function deadCall() {}\n" },
				{ path: "use.ts", content: null, piFpSource: "function run() { deadCall(); }\n" },
			],
			stats: { functions: 2, dead: 1 },
			deadFunctions: [{ name: "deadCall", file: "def.ts" }],
		};

		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFileFrom(data));
		assert.deepStrictEqual(suppressed.deadCode, [{ name: "deadCall", file: "def.ts" }]);
		assert.deepStrictEqual(clean.deadFunctions, []);
		assert.strictEqual(clean.stats.dead, 0);
	});
});

describe("fp-filter — acceptance score (Phase 5)", () => {
	// The score is computed by the real upstream `calcHealth` (the fixture copies
	// it verbatim from the pinned checkout). The data below reproduces the report
	// the issue was filed against; the authoritative check is the headless re-run
	// in test/codeflow-fp-acceptance.test.mts against the pinned analyzer.
	const nineHighs = [
		sec({
			path: ".pi/extensions/context-info/types.ts",
			code: 'export type UsageColorToken = "success" | "warning" | "error";',
		}),
		sec({
			path: ".pi/extensions/supervisor/github/gh-client.ts",
			code: "const ghToken = resolveGitHubToken();",
		}),
		sec({
			path: ".pi/extensions/supervisor/github/gh-client.ts",
			code: '? ["-c", `GH_TOKEN=\'${ghToken.replace(/\'/g, "")}\' gh "$@"`, "_", ...args]',
		}),
		sec({
			title: "SQL Injection Risk",
			path: ".pi/extensions/web-search/test/index.test.ts",
			code: "// First execute: verify 1 (quick check) + verify 2 (double-check) fail",
		}),
		...["ui/src/lib.rs", "ui/src/main.rs", "ui/src/retry.rs", "ui/src/tool_card.rs"].map((path) =>
			sec({
				title: "Shell Command Execution",
				description: "Shell() call detected.",
				path,
				code: "",
			}),
		),
		sec({
			title: "Shell Command Execution",
			description: "Shell() call detected.",
			path: "cmd/cheasee-pi/embedded/docker/entrypoint.sh",
			code: "",
		}),
	];

	const oneHundredFiftySeven = Array.from({ length: 157 }, (_, i) =>
		violation({ from: "cmd/build.go", to: "ui/src/retry.rs", fromLayer: "dir", toLayer: "dir" }),
	);

	const files = Array.from({ length: 1026 }, (_, i) => ({ path: `src/f${i}.ts`, layer: "ui" }));

	// The analyzer's `data` shape (not the exported report): `calcHealth` reads
	// `stats` and `issues`, and the layer rule reads `files`/`connections`.
	const data = {
		stats: {
			files: 1026,
			functions: 4890,
			connections: 5006,
			dead: 24,
			duplicates: 0,
			violations: 157,
			security: 9,
			loc: 1,
			languages: [],
		},
		issues: [{ type: "warning", title: "Large Function: render", desc: "", items: [] }],
		securityIssues: nineHighs,
		layerViolations: oneHundredFiftySeven,
		files,
		connections: CONNECTIONS,
	};

	it("reproduces the reported 73 (C) before the filter", () => {
		assert.strictEqual(data.securityIssues.length, 9);
		assert.strictEqual(data.layerViolations.length, 157);
		assert.deepStrictEqual(calcHealth(data), { score: 73, grade: "C" });
	});

	it("scores 93 (A) after the filter, with the security term at zero", () => {
		const { data: clean, suppressed } = sanitizeAnalysisData(data, readFile);
		assert.strictEqual(suppressed.security.length, 9, "all nine HIGH hits must be suppressed");
		assert.strictEqual(suppressed.layerViolations.length, 157, "the whole layer category is noise");
		assert.strictEqual(clean.securityIssues.length, 0);
		assert.strictEqual(clean.layerViolations.length, 0);
		assert.ok(calcHealth(clean).score >= 90, `expected an A, got ${calcHealth(clean).score}`);
		assert.deepStrictEqual(calcHealth(clean), { score: 93, grade: "A" });
	});
});
