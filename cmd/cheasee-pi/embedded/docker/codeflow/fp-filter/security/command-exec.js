// MEDIUM `Command Execution` findings, which the analyzer raises from a whole-file
// `node:child_process` import/require rather than from a call. Such a finding is
// dropped only when the cited file's own text proves *every* child-process call is
// an argv-array invocation whose program resolves to a literal and whose argv is a
// literal array or a `argvCommand`-validated binding free of an interpreter's code
// flag (`node -e`, `python -c`), with the shell forced off and the environment
// either absent or routed through the policy's `sanitizeSpawnEnv` (which drops
// `NODE_OPTIONS`, `LD_PRELOAD`, `GIT_CONFIG_*` and the like). An unreadable file, a
// dynamic program, unvalidated argv, an unconstrained env, or any shell call keeps
// it (fail closed).
//
// Every proof this module needs from the shared argv policy comes through the
// injected `command-exec-policy` dependency, so no provenance rule is duplicated
// here and the policy module stays the one home for what counts as proof.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterCommandExec`, and the index (`fp-filter.js`) calls the factory once.
//
// Used by: fp-filter.js (index).

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterCommandExec = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/security/command-exec: the dependency object is required");
	if (!deps.lexical || typeof deps.lexical !== "object")
		throw new TypeError("fp-filter/security/command-exec: missing dependency lexical");
	if (!deps.policy || typeof deps.policy !== "object")
		throw new TypeError("fp-filter/security/command-exec: missing dependency policy");

	var lexical = deps.lexical;
	var policy = deps.policy;
	var stripComments = lexical.stripComments;
	var escapeRe = lexical.escapeRe;
	var parseName = lexical.parseName;
	var argumentText = lexical.argumentText;
	var splitTopLevel = lexical.splitTopLevel;
	var stripAssertion = lexical.stripAssertion;
	var isArrayLiteral = lexical.isArrayLiteral;
	var elementText = lexical.elementText;
	var isLiteralProgram = policy.isLiteralProgram;
	var policyBindings = policy.policyBindings;
	var safeArgvPolicyNames = policy.safeArgvPolicyNames;
	var assertNoShellArgument = policy.assertNoShellArgument;
	var envExpressionIsConstrained = policy.envExpressionIsConstrained;

	// `node:child_process` members, by whether they run an argv array or a shell
	// string. `execFile("sh", ["-c", x])` is still argv-shaped but names a shell,
	// so a shell-program literal is denied separately below.
	var CP_MEMBERS = {
		spawn: "argv",
		spawnSync: "argv",
		execFile: "argv",
		execFileSync: "argv",
		exec: "shell",
		execSync: "shell",
		fork: "shell",
	};
	var CP_NAMES = Object.keys(CP_MEMBERS);
	// A bare shell program passed as the executable argument.
	var SHELL_PROGRAM =
		/["'`](?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash|cmd(?:\.exe)?|powershell(?:\.exe)?)["'`]/;

	// Local names that stand for a `node:child_process` member: named/namespace
	// imports, `require` destructuring, member assignment, `promisify(member)`,
	// and destructuring off a namespace — so an aliased spawn/exec is still seen
	// as a call site. Over-registering only ever denies a finding (fail closed).
	function childProcessBindings(code) {
		var members = Object.create(null);
		var namespaces = Object.create(null);
		var m;

		function addNamed(list) {
			var parts = list.split(",");
			for (var i = 0; i < parts.length; i++) {
				var name = parseName(parts[i]);
				if (name && CP_MEMBERS[name.imported]) members[name.local] = name.imported;
			}
		}

		// A declaration binding of the module result, in either form:
		// `require(...)` or the dynamic `await import(...)`, bare, destructured,
		// or with a `.member` suffix.
		function addReceiver(receiver, member) {
			var lhs = (receiver === undefined ? "" : receiver).trim();
			if (member) {
				if (CP_MEMBERS[member]) members[lhs] = member;
				return;
			}
			if (/^\{/.test(lhs)) addNamed(lhs.replace(/^\{/, "").replace(/\}$/, ""));
			else if (/^\w+$/.test(lhs)) namespaces[lhs] = true;
		}

		var re = /import\s*(?:type\s*)?([\s\S]*?)\s*from\s*["'](?:node:)?child_process["']/g;
		while ((m = re.exec(code)) !== null) {
			var clause = m[1];
			var star = /\*\s+as\s+(\w+)/.exec(clause);
			if (star) namespaces[star[1]] = true;
			var brace = /\{([^}]*)\}/.exec(clause);
			if (brace) addNamed(brace[1]);
			else if (!star && /^\s*\w+\s*$/.test(clause)) namespaces[clause.trim()] = true;
		}

		re =
			/(?:const|let|var)\s+([^;=\n]+?)\s*=\s*\(*\s*(?:await\s+)?\(*\s*(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\.\s*(\w+))?/g;
		while ((m = re.exec(code)) !== null) addReceiver(m[1], m[2]);

		// Assignment to a name declared elsewhere (`let cp; cp = require(...)`):
		// the declaration scans above miss it, so register the receiver too.
		re =
			/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*\(*\s*(?:await\s+)?\(*\s*(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
		while ((m = re.exec(code)) !== null) namespaces[m[1]] = true;

		// Fail closed on any other one-line binding of a module result the
		// structured scans above do not enumerate — a nested paren group, a
		// ternary, a helper call (`const cp = ((await import(...)))`, `const cp =
		// cond ? require(...) : null`). Registering the receiver as a namespace
		// only ever makes more call sites visible, so an unrecognised shape
		// denies a suppression rather than hiding a genuine shell-out.
		re =
			/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*[^;=\n]*?(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
		while ((m = re.exec(code)) !== null) namespaces[m[1]] = true;

		// Assignment and destructuring aliases, iterated to a fixpoint.
		for (var pass = 0; pass < 3; pass++) {
			re =
				/(?:const|let|var)\s+(\w+)\s*=\s*(?:promisify\s*\(\s*(\w+)\s*\)|(\w+)\s*\.\s*(\w+)|(\w+))/g;
			while ((m = re.exec(code)) !== null) {
				if (m[2] && members[m[2]]) members[m[1]] = members[m[2]];
				else if (m[3] && m[4] && CP_MEMBERS[m[4]]) members[m[1]] = m[4];
				else if (m[5] && members[m[5]]) members[m[1]] = members[m[5]];
				else if (m[5] && namespaces[m[5]]) namespaces[m[1]] = true;
			}
			re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(\w+)\s*[;,\n]/g;
			while ((m = re.exec(code)) !== null) {
				if (namespaces[m[2]]) addNamed(m[1]);
			}
		}

		return { members: members, namespaces: namespaces };
	}

	// Any shell-executing construct in the file: a shell member name (`exec`,
	// `execSync`, `fork` — standalone, aliased or namespaced), a `shell` option
	// that is not explicitly `false`, a `-c` command string, a shell-program
	// literal, `eval`, or `new Function`.
	var SHELL_CONSTRUCTS = [
		/(?:^|[^\w$])(?:exec|execSync|fork)(?![\w$])/,
		/(?:^|[^\w$])shell\s*:\s*(?!\s*false\b)/,
		/["'`]-c["'`]/,
		SHELL_PROGRAM,
		/(?:^|[^\w$])eval\s*\(/,
		/\bnew\s+Function\s*\(/,
	];

	function hasShellExecution(code) {
		for (var i = 0; i < SHELL_CONSTRUCTS.length; i++) {
			if (SHELL_CONSTRUCTS[i].test(code)) return true;
		}
		return false;
	}

	/** The call pattern for a bare (non-namespaced) member name. */
	function callRegex(name) {
		return new RegExp(
			"(?:^|[^\\w$.])" + escapeRe(name) + "\\s*(?:<[^<>]*>)?\\s*(?:\\?\\.\\s*)?\\(",
			"g",
		);
	}

	/**
	 * True when the spawn options cannot be proven free of an unconstrained
	 * environment. `shell:false` says nothing about indirect execution: git runs
	 * `core.sshCommand` from `GIT_CONFIG_*`, node runs a module from `NODE_OPTIONS`,
	 * and `LD_PRELOAD` / `BASH_ENV` do the same for other programs — so an env the
	 * argv proof cannot see is not proof. A literal object showing no `env`, or an
	 * `env` that is the pinned policy's `sanitizeSpawnEnv(...)` (which drops exactly
	 * those variables), is provable; an options *binding* (`const opts = { env: … };
	 * assertNoShell(opts)`), a spread, a nested env, or any other env expression
	 * hides keys the text does not show, so all of them fail closed.
	 * (Residual limits, all needing a hostile edit of an already-reviewed file:
	 * the env object could be mutated after the policy accepts it, a same-named
	 * parameter could shadow the `const` binding, and a program that delegates on
	 * its own terms — `git fetch` runs the remote's ssh — stays unproven but
	 * suppressed.)
	 */
	function optionsCarryEnvironment(optionsText, bindings, policyNames) {
		var text = assertNoShellArgument(optionsText);
		if (text === null) return true;
		if (text.charAt(0) !== "{" || text.charAt(text.length - 1) !== "}") return true;
		var parts = splitTopLevel(text.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (/^\s*\.\.\./.test(part)) return true;
			var envKey = /^\s*env\s*:\s*([\s\S]*)$/.exec(part);
			if (envKey) {
				if (!envExpressionIsConstrained(envKey[1], bindings, policyNames)) return true;
				continue;
			}
			// The shorthand `{ cwd, env, stdio }` — the local name must be a
			// constrained `const` binding, never a parameter or a mutable variable.
			if (/^\s*env\s*$/.test(part)) {
				if (bindings.envs.env !== true) return true;
				continue;
			}
			// An `env` nested inside a sub-object is not a key this proof resolves.
			if (/\benv\b\s*:|(?:^|[{,])\s*env\s*(?:[,}]|$)/.test(part)) return true;
		}
		return false;
	}

	// Executables that run a program handed to them through argv (`node -e`,
	// `python -c`, `sh -c`, `perl -e`, `php -r`, …). An argv-array spawn of one
	// of these with the interpreter's code flag is arbitrary code execution, not
	// a shell-free command, so the argv-array proof of safety does not hold.
	var INTERPRETER_PROGRAM =
		/(?:^|[\\/])(?:node|nodejs|deno|bun|python\d*(?:\.\d+)?|perl|ruby|php\d*|lua|luajit|osascript|rscript|pwsh|powershell|cmd|sh|bash|zsh|dash)(?:\.exe)?$/i;
	// Programs that run another program named in their argv, so the interpreter
	// and its code flag can sit one level down (`env node -e code`,
	// `npm exec -- node -e code`). Treated like an interpreter: their argv must be
	// a literal array to be proven safe.
	var COMMAND_RUNNER =
		/(?:^|[\\/])(?:env|nohup|nice|timeout|stdbuf|sudo|doas|xargs|npx|pnpm|yarn|npm|bunx)(?:\.exe)?$/i;
	// The interpreter flags that make it run code from argv — the eval forms
	// (`-e`/`--eval`, `-c`/`--command`, `-p`/`--print`), the module-loading forms
	// that run a file the flag points at (`--require`/`-r`, `--import`, `--loader`,
	// `--preload`, `-m`), and the *attached* or *combined* short forms the
	// interpreters accept (`-Mmodule`, `-mmodule`, `-ecode`, Python/shell
	// `-cprint(1)`, and `bash -lc cmd`, where the code letter is not first), plus
	// the `eval` subcommand of `deno`/`bun` and a lone `-` (script from stdin).
	// Matched against a quote-stripped element. The letter class covers every
	// code flag (`c`/`C` plus `e`/`E`/`m`/`M`/`r`/`R`/`p`/`P`).
	var CODE_EVAL_TOKEN =
		/^(?:-|eval|\/(?:c|k)|--?(?:eval|exec(?:ute)?|command|c|print|p|e|r|require|import|loader|preload|module|m|experimental-loader)(?:=.*)?|-[a-zA-Z]*[cCeEmMrRpP][\s\S]*)$/i;

	/** The bare name of a quoted program literal, or null when it is not one. */
	function programNameText(program) {
		var a = program.trim();
		if (a.length < 2) return null;
		var q = a.charAt(0);
		if ((q !== '"' && q !== "'" && q !== "`") || a.charAt(a.length - 1) !== q) return null;
		return a.slice(1, -1).trim();
	}

	/** True when a program literal names an interpreter. */
	function isInterpreterProgram(program) {
		var name = programNameText(program);
		return name !== null && INTERPRETER_PROGRAM.test(name);
	}

	/**
	 * What a literal argv array says about execution: whether it is a literal at
	 * all, whether it names an interpreter itself, and whether it carries an
	 * interpreter's code flag. One pass answers all three, so the interpreter and
	 * code-flag rules cannot drift apart. A non-literal argv proves none of them
	 * (the caller fails closed).
	 */
	function argvFacts(argvText) {
		var facts = { literal: false, code: false, interpreter: false };
		if (!isArrayLiteral(argvText)) return facts;
		facts.literal = true;
		var parts = splitTopLevel(argvText.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			var val = elementText(parts[i]);
			if (val === null) continue;
			if (CODE_EVAL_TOKEN.test(val)) facts.code = true;
			if (INTERPRETER_PROGRAM.test(val)) facts.interpreter = true;
		}
		return facts;
	}

	/**
	 * Programs whose argv can hold the code to run: an interpreter, or a runner
	 * that delegates to one. They cannot be proven safe with a dynamic argv.
	 */
	function needsLiteralArgv(program) {
		if (isInterpreterProgram(program)) return true;
		var name = programNameText(program);
		return name !== null && COMMAND_RUNNER.test(name);
	}

	// One call is safe when its executable resolves to a literal (directly or
	// through `argvCommand(<literal>, ...)`), its argv is a literal array or an
	// `argvCommand`-validated binding, and its options route through the policy's
	// `assertNoShell` — which throws on a truthy `shell`, so the `shell:false` is
	// effective at runtime rather than text-proven. Anything else fails closed so
	// a genuine command-execution finding is never hidden.
	function isSafeArgvCall(member, args, bindings, policyNames) {
		if (CP_MEMBERS[member] !== "argv") return false;
		if (policyNames.assertNoShell !== true) return false;
		var parts = splitTopLevel(args);
		if (parts.length < 2) return false;
		var program = stripAssertion(parts[0]);
		var programLiteral = isLiteralProgram(program) ? program : bindings.programs[program];
		if (typeof programLiteral !== "string") return false;
		var argvExpr = stripAssertion(parts[1]);
		var argvSource = isArrayLiteral(argvExpr) ? argvExpr : bindings.args[argvExpr];
		if (typeof argvSource !== "string") return false;
		// Executable-aware: an interpreter (or a runner that delegates to one in
		// argv) turns a validated argv back into code. An interpreter program needs
		// a literal argv free of its code flag; a runner needs an argv that does not
		// name an interpreter plus a code flag; and either cannot be proven safe
		// with a dynamic argv.
		var argv = argvFacts(argvSource);
		if (isInterpreterProgram(programLiteral) && argv.code) return false;
		if (argv.code && argv.interpreter) return false;
		if (needsLiteralArgv(programLiteral) && !argv.literal) return false;
		// The options are argv position 3. Requiring the *actual* options argument
		// to be the `assertNoShell` call rejects a call that shadows it behind an
		// ignored extra argument (`spawn(p, a, opts, assertNoShell({}))`).
		if (parts.length < 3) return false;
		var optionsText = stripAssertion(parts[2]);
		if (!/(?:^|[^\w$.])assertNoShell\s*(?:<[^<>]*>)?\s*\(/.test(optionsText)) return false;
		// An env binding is an execution channel the argv proof cannot see — unless
		// it is the policy's own constrained env.
		return !optionsCarryEnvironment(optionsText, bindings, policyNames);
	}

	// A computed member access names a child-process function the name-based scan
	// can never see: `cp["ex" + "ec"](cmd)`, `cp[method]`, or
	// `require("node:child_process")["exec"](cmd)`. So does an inline module
	// result called directly — `require("node:child_process").spawn(cmd)`,
	// `(await import("node:child_process")).spawn(cmd)` — where there is no bound
	// name to follow. Reaching a member through `.call`/`.apply`
	// (`cp.spawn.call(...)`) likewise escapes the argument scan. All are
	// unproveable, so the file keeps its finding (fail closed).
	// Over-detection only ever denies a suppression.
	function hasComputedChildProcessAccess(code, cp) {
		var i;
		var namespaces = Object.keys(cp.namespaces);
		for (i = 0; i < namespaces.length; i++) {
			if (
				new RegExp("(?:^|[^\\w$.])" + escapeRe(namespaces[i]) + "\\s*(?:\\?\\.)?\\s*\\[").test(code)
			)
				return true;
		}
		// `\\)*` follows the module call through a wrapping paren group, so the
		// `(await import(...)).member` form is denied as well as the bare one.
		if (
			/(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\?\.)?\s*[.\[]/.test(
				code,
			)
		)
			return true;
		var members = Object.keys(cp.members);
		for (i = 0; i < CP_NAMES.length; i++) members.push(CP_NAMES[i]);
		for (i = 0; i < members.length; i++) {
			if (
				new RegExp(
					"(?:^|[^\\w$])" +
						escapeRe(members[i]) +
						"\\s*(?:\\?\\.)?\\s*\\.\\s*(?:call|apply)\\s*\\(",
				).test(code)
			)
				return true;
		}
		return false;
	}

	// Every child-process call in the file must prove argv-safe; a bare name, a
	// registered alias, or a known namespace member all count as a call site. One
	// pattern list, one scan — a members-only scan would miss `cp.spawn(...)` and
	// a namespace-only one would miss `spawn(...)`.
	function everyChildProcessCallIsSafe(code, bindings, policyNames) {
		var cp = childProcessBindings(code);
		if (hasComputedChildProcessAccess(code, cp)) return false;
		var patterns = [];
		var i;
		for (i = 0; i < CP_NAMES.length; i++) {
			patterns.push({ member: CP_NAMES[i], re: callRegex(CP_NAMES[i]) });
		}
		for (var local in cp.members) {
			patterns.push({ member: cp.members[local], re: callRegex(local) });
		}
		var namespaces = Object.keys(cp.namespaces);
		for (i = 0; i < namespaces.length; i++) {
			patterns.push({
				member: null,
				re: new RegExp(
					escapeRe(namespaces[i]) + "\\s*(?:\\?\\.|\\.)\\s*(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(",
					"g",
				),
			});
		}
		for (i = 0; i < patterns.length; i++) {
			var re = patterns[i].re;
			var m;
			while ((m = re.exec(code)) !== null) {
				var member = patterns[i].member === null ? m[1] : patterns[i].member;
				var open = code.indexOf("(", m.index + m[0].length - 1);
				var args = argumentText(code, open);
				if (args === null || !isSafeArgvCall(member, args, bindings, policyNames)) return false;
			}
		}
		return true;
	}

	/**
	 * True when a MEDIUM `Command Execution` finding may be dropped. `readFile`
	 * supplies the cited file; an unreadable file is never evidence, so it keeps
	 * the finding.
	 */
	function isFalsePositiveCommandExecution(issue, readFile) {
		if (typeof issue.severity !== "string" || issue.severity.toLowerCase() !== "medium")
			return false;
		if (String(issue.title).trim() !== "Command Execution") return false;
		var content = readFile ? readFile(issue.path) : null;
		if (typeof content !== "string") return false;
		var code = stripComments(content);
		if (hasShellExecution(code)) return false;
		var policyNames = safeArgvPolicyNames(code, issue.path, readFile);
		return everyChildProcessCallIsSafe(code, policyBindings(code, policyNames), policyNames);
	}

	return {
		isFalsePositiveCommandExecution: isFalsePositiveCommandExecution,
		childProcessBindings: childProcessBindings,
		everyChildProcessCallIsSafe: everyChildProcessCallIsSafe,
		isSafeArgvCall: isSafeArgvCall,
		optionsCarryEnvironment: optionsCarryEnvironment,
	};
});
