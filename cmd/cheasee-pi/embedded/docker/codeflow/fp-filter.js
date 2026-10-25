// Deterministic suppression of CodeFlow analyzer false positives.
//
// Applied to the structured `data` the analyzer produced, *before* any report
// artifact is built, so the health score, the markdown export, the JSON export
// and the stats all agree. Six categories:
//
//   1. HIGH security findings that cite no real code — an empty or comment-only
//      snippet, a string-literal type union, a value the environment resolves
//      at runtime, or a symbol that does not exist in the cited file;
//   2. MEDIUM `Command Execution` findings, which the analyzer raises from a
//      whole-file `node:child_process` import/require rather than a call. Such a
//      finding is dropped only when the cited file's own text proves *every*
//      child-process call is an argv-array invocation whose program resolves to
//      a literal and whose argv is a literal array or a `argvCommand`-validated
//      binding free of an interpreter's code flag (`node -e`, `python -c`),
//      with the shell forced off and the environment either absent or routed
//      through the policy's `sanitizeSpawnEnv` (which drops `NODE_OPTIONS`,
//      `LD_PRELOAD`, `GIT_CONFIG_*` and the like). An unreadable file, a dynamic
//      program, unvalidated argv, an unconstrained env, or any shell call keeps
//      it (fail closed).
//   3. layer violations whose two endpoints cannot be a real lower->higher
//      import: a different language, an endpoint off the repo's declared layer
//      taxonomy, a same-or-reversed rank order, or no recorded import edge. The
//      analyzer infers layers from loose path substrings and falls back to
//      `utils`, so its `files[].layer` labels are advisory; REPO_LAYERS below is
//      the single source of which path is which layer, and this repository
//      declares none, so the whole category collapses;
//   4. LOW hygiene findings (`Code Comments` / `Debug Statements`) whose cited
//      path is a non-shipping artifact — a test or a document, where the
//      flagged token is fixture data or a worked example, not deferred work;
//   5. unused functions that the snapshot does reference. The analyzer's call
//      graph misses function-as-value references (`opts.fetchFn ?? defaultFetch`)
//      and cross-file trait dispatch (`Socket::on_message` called in retry.rs),
//      so a symbol that still appears call- or value-shaped outside its own
//      definition is not dead;
//   6. aggregate code-clone groups whose `name` lists more than a small number
//      of distinct member symbols — a genuine pairwise clone names one or two,
//      while the dozen-member aggregates are repo-wide shape coincidences.
//
// One seam sits outside that list: `pruneCouplingEdges` drops the coupling edges
// in `data.connections` that are not dependencies (see its own comment). It reads
// each edge's own declaration record and the caller's text reader, so neither the
// resolution rule nor the filesystem is re-implemented here.
//
// Dual format on purpose: the headless runner requires this file and the served
// browser page loads it as `<script src="fp-filter.js">`, so the report the UI
// shows and the report pi reads cannot drift.
//
// Used by: run-analysis.mjs (headless), server.py (browser parity).

(function (root, factory) {
	"use strict";
	var api = factory();
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilter = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
	"use strict";

	// --- security findings ---------------------------------------------------

	// A value read from the environment (or from the `gh` CLI's own hosts file)
	// is not a hardcoded secret.
	var ENV_READ =
		/\bprocess\.env\b|\benv::var\s*\(|\bstd::env::var\b|\bDeno\.env\b|\bimport\.meta\.env\b|\bos\.environ\b|\bgetenv\s*\(/;
	// The env-var *name* passed to a lookup is not the flagged value.
	var ENV_LOOKUP_ARG =
		/(?:env::var|std::env::var|getenv|environ(?:\.get)?)\s*\(\s*["'][^"']*["']\s*\)/g;
	var ENV_HELPER_HINT = /hosts\.yml|\.config\/gh\b/;
	// How far past a helper's definition head its body is scanned for an env
	// read. shortcut: fixed window, not brace balancing — a helper whose env
	// read sits beyond it is not recognised, and a neighbour's env read inside
	// it is attributed to the helper (both only matter for HIGH findings whose
	// snippet has no literal of its own).
	var HELPER_WINDOW = 2000;

	function isHigh(issue) {
		return typeof issue.severity === "string" && issue.severity.toLowerCase() === "high";
	}

	function countHigh(issues) {
		var n = 0;
		for (var i = 0; i < issues.length; i++) if (isHigh(issues[i])) n++;
		return n;
	}

	function codeOf(issue) {
		return typeof issue.code === "string" ? issue.code : "";
	}

	function escapeRe(text) {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	// A snippet that carries nothing but comments cannot contain executable code.
	function isCommentOnly(code) {
		return (
			code
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/\/\/[^\n]*/g, " ")
				.trim() === ""
		);
	}

	// `export type UsageColorToken = "success" | "warning" | "error";` declares
	// the allowed values of a type; it embeds no credential.
	function isStringLiteralUnion(code) {
		var literal = "(\"[^\"]*\"|'[^']*')";
		return new RegExp(
			"^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+[\\w$]+\\s*=\\s*" +
				literal +
				"(\\s*\\|\\s*" +
				literal +
				")+\\s*;?\\s*$",
		).test(code);
	}

	// Does the snippet bind a plain (non-template) string literal of its own?
	// Such a literal is the value that was flagged, so the finding stands even
	// if the surrounding block reads the environment for something else.
	function hasLiteralAssignment(code) {
		var stripped = code.replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(ENV_LOOKUP_ARG, "envRef()");
		return /[=:(,]\s*["'][^"'\n]{4,}["']/.test(stripped);
	}

	// The definition head of a helper binding: a declaration or a const arrow.
	function helperReadsEnv(name, content) {
		var head = new RegExp(
			"(?:function\\s+" +
				escapeRe(name) +
				"\\b|\\b" +
				escapeRe(name) +
				"\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|\\b[A-Za-z_$][\\w$]*\\s*=>))",
		);
		var m = head.exec(content);
		if (!m) return false;
		var body = content.slice(m.index, m.index + HELPER_WINDOW);
		return ENV_READ.test(body) || ENV_HELPER_HINT.test(body);
	}

	// `const ghToken = resolveGitHubToken();` — the value comes from a helper.
	function bindingReadsEnv(name, content) {
		var m = new RegExp("\\b(?:const|let|var)\\s+" + escapeRe(name) + "\\s*=\\s*([^;\\n]*)").exec(
			content,
		);
		if (!m) return false;
		var rhs = m[1];
		if (ENV_READ.test(rhs)) return true;
		var call = /\b([A-Za-z_$][\w$]*)\s*\(/.exec(rhs);
		return call ? helperReadsEnv(call[1], content) : false;
	}

	function resolvesViaHelper(code, content) {
		if (typeof content !== "string") return false;
		var names = code.match(/\b[A-Za-z_$][\w$]*\b/g);
		if (!names) return false;
		for (var i = 0; i < names.length; i++) {
			if (helperReadsEnv(names[i], content)) return true;
			if (bindingReadsEnv(names[i], content)) return true;
		}
		return false;
	}

	// `Shell()` in the message but nowhere in the cited file: a textual
	// coincidence, not a finding about that file. Unknown content is not proof,
	// so the caller only reaches this with a real read.
	function namesMissingSymbol(issue, content) {
		if (typeof content !== "string") return false;
		var message = [issue.title, issue.description]
			.filter(function (part) {
				return typeof part === "string";
			})
			.join(" ");
		var re = /\b([A-Za-z_$][\w$]{2,})\s*\(\s*\)/g;
		var m;
		while ((m = re.exec(message)) !== null) {
			if (content.indexOf(m[1]) === -1) return true;
		}
		return false;
	}

	// --- MEDIUM `Command Execution`: file-scoped, so file-scoped proof -------
	//
	// The analyzer's `Command Execution` rule fires on a whole file — an import
	// or `require` of `node:child_process`, or a `child_process.exec` call — and
	// records it with no snippet (`code: ""`), so the finding names a file, not an
	// invocation. Its predicate is upstream and cannot be narrowed here; proving
	// the hit a false positive needs the cited file's own text. A file is
	// suppressed only when *every* child-process call it makes is an argv-array
	// invocation through the shared policy (`argvCommand` for the program,
	// `assertNoShell` for the options), no shell-executing construct appears
	// anywhere, and the options either bind no environment or bind one the
	// policy's `sanitizeSpawnEnv` constrains — an unconstrained env can name a
	// command the argv never shows (`GIT_CONFIG_*`, `NODE_OPTIONS`, `LD_PRELOAD`).
	// An unreadable file, an unrecognised call shape, a dynamic program, an
	// unconstrained env, or any shell call keeps the finding (fail closed).

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

	/** Positioned on the opening quote; returns the index just past the close. */
	function skipString(code, i) {
		var quote = code[i++];
		while (i < code.length) {
			if (code[i] === "\\") {
				i += 2;
				continue;
			}
			if (code[i] === quote) return i + 1;
			i++;
		}
		return i;
	}

	/** True when a `/` after `prefix` opens a regex literal, not a division. */
	function startsRegex(prefix) {
		for (var i = prefix.length - 1; i >= 0; i--) {
			var c = prefix[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
			return !/[A-Za-z0-9_$)\]"'`]/.test(c);
		}
		return true;
	}

	/** Positioned on the opening `/`; returns the index just past the flags. */
	function skipRegex(code, i) {
		i++;
		var inClass = false;
		while (i < code.length) {
			var c = code[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) return i + 1;
			else if (c === "\n") return i;
			i++;
		}
		return i;
	}

	// String- and regex-aware comment removal, so a comment can neither hide a
	// call site nor a regex containing `//` fake one. `dropStrings` blanks string
	// literals too, for the caller that asks whether code *executes* a name
	// rather than whether the text contains it.
	// shortcut: skipString takes a template literal as one string, so an
	// interpolation that really calls the name counts as text, not as code.
	function stripComments(code, dropStrings) {
		var out = "";
		var i = 0;
		while (i < code.length) {
			var ch = code[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				var s = i;
				i = skipString(code, i);
				out += dropStrings === true ? " " : code.slice(s, i);
				continue;
			}
			if (ch === "/" && code[i + 1] === "/") {
				i = code.indexOf("\n", i);
				if (i < 0) break;
				continue;
			}
			if (ch === "/" && code[i + 1] === "*") {
				var end = code.indexOf("*/", i + 2);
				if (end < 0) break;
				i = end + 2;
				continue;
			}
			if (ch === "/" && startsRegex(out)) {
				var r = i;
				i = skipRegex(code, i);
				out += code.slice(r, i);
				continue;
			}
			out += ch;
			i++;
		}
		return out;
	}

	// Top-level comma split, honouring nesting and strings — call arguments.
	function splitTopLevel(text) {
		var parts = [];
		var depth = 0;
		var start = 0;
		var i = 0;
		while (i < text.length) {
			var ch = text[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				i = skipString(text, i);
				continue;
			}
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === "," && depth === 0) {
				parts.push(text.slice(start, i));
				start = i + 1;
			}
			i++;
		}
		parts.push(text.slice(start));
		return parts;
	}

	// The argument list of the call whose `(` is at `open`, minus the parens.
	function argumentText(code, open) {
		var depth = 0;
		var i = open;
		while (i < code.length) {
			var ch = code[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				i = skipString(code, i);
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) return code.slice(open + 1, i);
			}
			i++;
		}
		return null;
	}

	// A literal program: a quoted string with no escape sequence and no template
	// interpolation. An escape can hide a shell (`"/bin/\u0073h"` is `/bin/sh`),
	// so a program carrying one is not a proven literal — the caller fails closed.
	function isLiteralProgram(text) {
		var a = text.trim();
		return /^"[^"\\\n]*"$/.test(a) || /^'[^'\\\n]*'$/.test(a) || /^`[^`$\\]*`$/.test(a);
	}

	// Names bound by `const { program, args } = argvCommand(...)`. Only a
	// destructured `program` whose argvCommand first argument is *itself a
	// literal* proves a later call's executable; `argvCommand(request.command,
	// ...)` binds nothing, so a dynamic program keeps its finding. A destructured
	// `args` name records the argv expression the policy was handed, so the call
	// site can still inspect it for an interpreter's code flag. `envs` records
	// `const env = sanitizeSpawnEnv(...)` names: only a `const` binding is proof,
	// since a `let`/`var` can be replaced with a hostile env on the next line.
	function policyBindings(code, policy) {
		var programs = Object.create(null);
		var argsNames = Object.create(null);
		var envs = Object.create(null);
		var m;
		var envRe =
			/(?:const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:await\s+)?sanitizeSpawnEnv\s*(?:<[^<>]*>)?\s*\(/g;
		if (policy.sanitizeSpawnEnv === true) {
			while ((m = envRe.exec(code)) !== null) envs[m[1]] = true;
		}
		if (policy.argvCommand !== true) return { programs: programs, args: argsNames, envs: envs };
		var re = /(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*argvCommand\s*(?:<[^<>]*>)?\s*\(/g;
		while ((m = re.exec(code)) !== null) {
			var open = code.indexOf("(", m.index + m[0].length - 1);
			var callArgs = argumentText(code, open);
			var parts = callArgs === null ? [] : splitTopLevel(callArgs);
			var programLiteral = parts.length >= 1 && isLiteralProgram(parts[0]) ? parts[0].trim() : null;
			var argvExpr = parts.length >= 2 ? stripAssertion(parts[1]) : null;
			var fields = m[1].split(",");
			for (var i = 0; i < fields.length; i++) {
				var seg = fields[i].trim();
				if (!seg) continue;
				var colon = seg.indexOf(":");
				var field = (colon < 0 ? seg : seg.slice(0, colon)).trim();
				var local = (colon < 0 ? seg : seg.slice(colon + 1)).trim();
				var id = /^[A-Za-z_$][\w$]*/.exec(local);
				if (!id) continue;
				if (field === "program") {
					if (programLiteral !== null) programs[id[0]] = programLiteral;
				} else if (field === "args") {
					argsNames[id[0]] = argvExpr;
				}
			}
		}
		return { programs: programs, args: argsNames, envs: envs };
	}

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
				var seg = parts[i].trim();
				if (!seg) continue;
				var asMatch = /^(\w+)(?:\s+as\s+|\s*:\s*)(\w+)$/.exec(seg);
				if (asMatch) {
					if (CP_MEMBERS[asMatch[1]]) members[asMatch[2]] = asMatch[1];
				} else if (/^\w+$/.test(seg) && CP_MEMBERS[seg]) {
					members[seg] = seg;
				}
			}
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
			/(?:const|let|var)\s+([^;=\n]+?)\s*=\s*\(*\s*(?:await\s+)?\(*\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\.\s*(\w+))?/g;
		while ((m = re.exec(code)) !== null) {
			var lhs = m[1].trim();
			if (m[2]) {
				if (CP_MEMBERS[m[2]]) members[lhs] = m[2];
			} else if (/^\{/.test(lhs)) addNamed(lhs.replace(/^\{/, "").replace(/\}$/, ""));
			else if (/^\w+$/.test(lhs)) namespaces[lhs] = true;
		}

		// The dynamic-import form of the same binding: `const cp = await
		// import("node:child_process")` (and its destructured/`.member` variants)
		// resolves to the same namespace, so `cp.spawn(...)` must be scanned.
		re =
			/(?:const|let|var)\s+([^;=\n]+?)\s*=\s*\(*\s*(?:await\s+)?\(*\s*import\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\.\s*(\w+))?/g;
		while ((m = re.exec(code)) !== null) {
			var dlhs = m[1].trim();
			if (m[2]) {
				if (CP_MEMBERS[m[2]]) members[dlhs] = m[2];
			} else if (/^\{/.test(dlhs)) addNamed(dlhs.replace(/^\{/, "").replace(/\}$/, ""));
			else if (/^\w+$/.test(dlhs)) namespaces[dlhs] = true;
		}

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
	function hasShellExecution(code) {
		if (/(?:^|[^\w$])(?:exec|execSync|fork)(?![\w$])/.test(code)) return true;
		if (/(?:^|[^\w$])shell\s*:\s*(?!\s*false\b)/.test(code)) return true;
		if (/["'`]-c["'`]/.test(code)) return true;
		if (SHELL_PROGRAM.test(code)) return true;
		if (/(?:^|[^\w$])eval\s*\(/.test(code)) return true;
		if (/\bnew\s+Function\s*\(/.test(code)) return true;
		return false;
	}

	/** The single argument text of the `assertNoShell(...)` call, or null. */
	function assertNoShellArgument(optionsText) {
		var m = /(?:^|[^\w$.])assertNoShell\s*(?:<[^<>]*>)?\s*\(/.exec(optionsText);
		if (!m) return null;
		var open = optionsText.indexOf("(", m.index + m[0].length - 1);
		var args = open < 0 ? null : argumentText(optionsText, open);
		if (args === null) return null;
		var parts = splitTopLevel(args);
		return parts.length === 1 ? stripAssertion(parts[0]).trim() : null;
	}

	/** The bare name of a constrained-env expression, or null when it is no call. */
	function constrainedEnvCallName(text) {
		var m = /^([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/.exec(text.trim());
		return m ? m[1] : null;
	}

	/**
	 * True when `expr` is the pinned policy's own env constraint: a direct call to
	 * its `sanitizeSpawnEnv` export, or a `const` bound from one. The name must
	 * carry provenance (imported from the pinned module, unshadowed), so a
	 * same-named local helper cannot forge it; a bare identifier that is not such
	 * a binding, or any other expression, is unproven.
	 */
	function envExpressionIsConstrained(expr, bindings, policy) {
		var text = stripAssertion(expr).trim();
		var call = constrainedEnvCallName(text);
		if (call !== null) return call === "sanitizeSpawnEnv" && policy[call] === true;
		return /^[A-Za-z_$][\w$]*$/.test(text) && bindings.envs[text] === true;
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
	function optionsCarryEnvironment(optionsText, bindings, policy) {
		var text = assertNoShellArgument(optionsText);
		if (text === null) return true;
		if (text.charAt(0) !== "{" || text.charAt(text.length - 1) !== "}") return true;
		var parts = splitTopLevel(text.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (/^\s*\.\.\./.test(part)) return true;
			var envKey = /^\s*env\s*:\s*([\s\S]*)$/.exec(part);
			if (envKey) {
				if (!envExpressionIsConstrained(envKey[1], bindings, policy)) return true;
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

	/** The call pattern for a bare (non-namespaced) member name. */
	function callRegex(name) {
		return new RegExp(
			"(?:^|[^\\w$.])" + escapeRe(name) + "\\s*(?:<[^<>]*>)?\\s*(?:\\?\\.\\s*)?\\(",
			"g",
		);
	}

	// Strip a trailing type assertion (`args as string[]`) before the test; it
	// hides no value change. `as` in a nested generic is never trailing.
	function stripAssertion(text) {
		var a = text.trim();
		var m = /\s+as\s+[^,]+$/.exec(a);
		return m ? a.slice(0, m.index).trim() : a;
	}

	// A plain literal argv element: a quoted string with no escape and no
	// interpolation, a number, or a boolean/null keyword. A constructed element
	// (`"-" + "c"`), a template hole (`` `--x=${y}` ``), a bare identifier or an
	// escaped byte (`"\x2dc"`) can assemble a shell flag at runtime; the static
	// proof cannot follow it, so it is not a proven element — the caller fails
	// closed.
	function isLiteralElement(text) {
		var a = text.trim();
		return (
			/^"[^"\\\n]*"$/.test(a) ||
			/^'[^'\\\n]*'$/.test(a) ||
			/^-?(?:\d+\.?\d*|\.\d+)$/.test(a) ||
			/^(?:true|false|null|undefined)$/.test(a)
		);
	}

	// A literal argv array — every element a plain literal, so nothing can smuggle
	// a shell string or flag in at runtime (`["-" + "c", cmd]`, `` [`--x=${y}`] ``).
	function isArrayLiteral(text) {
		var a = text.trim();
		if (a.charAt(0) !== "[" || a.charAt(a.length - 1) !== "]") return false;
		var body = a.slice(1, -1).trim();
		if (body === "") return true;
		var parts = splitTopLevel(body);
		for (var i = 0; i < parts.length; i++) {
			if (!isLiteralElement(parts[i])) return false;
		}
		return true;
	}

	// The imported policy helper must resolve to the module's own export. A local
	// re-declaration of the same name — a function, class, variable, enum,
	// namespace, destructuring, parameter or catch binding — shadows the import,
	// so a call spelled `assertNoShell(...)` / `argvCommand(...)` may run code
	// other than the policy. The name-based proof cannot follow the binding, so a
	// shadowed name is not proof (fail closed).
	function policyNameIsShadowed(code, name) {
		var n = escapeRe(name);
		// Any occurrence that is not a direct call — optionally through a type
		// argument list — is not the imported helper: a parameter, a variable
		// binding, a destructuring, a value reference, a property or a member
		// call. (The import clause is blanked out before this runs.)
		var re = new RegExp("\\b" + n + "\\b", "g");
		var m;
		while ((m = re.exec(code)) !== null) {
			if (!/^\s*(?:<[^<>]*>\s*)?\(/.test(code.slice(m.index + m[0].length))) return true;
		}
		// A function declaration also reads as a call at its name; reject it by the
		// keyword that precedes it. Class, enum and namespace declarations bind the
		// name too.
		return new RegExp(
			"(?:^|[^\\w$.])(?:(?:async\\s+)?function\\s*\\*?\\s*|class\\s+|enum\\s+|namespace\\s+)" +
				n +
				"\\b",
		).test(code);
	}

	// Resolve a relative import specifier against the cited file's own directory,
	// purely (no node:path — the served page loads this file too). A bare or
	// absolute specifier, or one that climbs past the root, resolves to null.
	function resolveRelative(fromPath, specifier) {
		if (typeof fromPath !== "string" || typeof specifier !== "string") return null;
		if (!/^\.\.?\//.test(specifier)) return null;
		var segments = fromPath.split("/");
		segments.pop();
		var parts = specifier.split("/");
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (segments.length === 0) return null;
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return segments.join("/");
	}

	// The one shared argv-policy module lives at the *canonical* repo path
	// `.pi/extensions/lib/safe-argv.ts`. Matching any path that merely ends in
	// `/lib/safe-argv.ts` would let a counterfeit at `src/attacker/lib/safe-argv.ts`
	// (or any other nested path) forge the provenance this whole rule rests on, so
	// the resolved path must equal the canonical module exactly.
	var POLICY_MODULE_PATH = ".pi/extensions/lib/safe-argv.ts";
	function isPolicyModulePath(path) {
		return path === POLICY_MODULE_PATH;
	}

	// SHA-256 over a string's UTF-8 bytes, hex-encoded. Pure, so the served page
	// and the headless runner compute the same digest; the browser has no sync
	// crypto and `crypto.subtle` is async. Used only to pin the policy module.
	function sha256Hex(text) {
		var K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
			0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
			0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
			0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
			0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
			0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
			0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
			0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
			0xc67178f2,
		];
		var H = [
			0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
			0x5be0cd19,
		];
		var bytes = [];
		for (var i = 0; i < text.length; i++) {
			var c = text.charCodeAt(i);
			if (c < 0x80) bytes.push(c);
			else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
			else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				var cp = 0x10000 + ((c & 0x3ff) << 10) + (text.charCodeAt(++i) & 0x3ff);
				bytes.push(
					0xf0 | (cp >> 18),
					0x80 | ((cp >> 12) & 63),
					0x80 | ((cp >> 6) & 63),
					0x80 | (cp & 63),
				);
			} else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		}
		var bitLen = bytes.length * 8;
		bytes.push(0x80);
		while (bytes.length % 64 !== 56) bytes.push(0);
		var hi = Math.floor(bitLen / 0x100000000);
		var lo = bitLen >>> 0;
		bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
		bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
		function rotr(x, n) {
			return (x >>> n) | (x << (32 - n));
		}
		for (var off = 0; off < bytes.length; off += 64) {
			var w = [];
			for (var t = 0; t < 16; t++)
				w[t] =
					(bytes[off + t * 4] << 24) |
					(bytes[off + t * 4 + 1] << 16) |
					(bytes[off + t * 4 + 2] << 8) |
					bytes[off + t * 4 + 3];
			for (t = 16; t < 64; t++) {
				var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
				var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
			}
			var a = H[0],
				b = H[1],
				cc = H[2],
				d = H[3],
				e = H[4],
				f = H[5],
				g = H[6],
				h = H[7];
			for (t = 0; t < 64; t++) {
				var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				var ch = (e & f) ^ (~e & g);
				var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
				var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				var maj = (a & b) ^ (a & cc) ^ (b & cc);
				var t2 = (S0 + maj) | 0;
				h = g;
				g = f;
				f = e;
				e = (d + t1) | 0;
				d = cc;
				cc = b;
				b = a;
				a = (t1 + t2) | 0;
			}
			H[0] = (H[0] + a) | 0;
			H[1] = (H[1] + b) | 0;
			H[2] = (H[2] + cc) | 0;
			H[3] = (H[3] + d) | 0;
			H[4] = (H[4] + e) | 0;
			H[5] = (H[5] + f) | 0;
			H[6] = (H[6] + g) | 0;
			H[7] = (H[7] + h) | 0;
		}
		var out = "";
		for (var k = 0; k < 8; k++) out += ("00000000" + (H[k] >>> 0).toString(16)).slice(-8);
		return out;
	}

	// Provenance by content identity, not by path or exported names. A counterfeit
	// at the canonical path can declare the two exports, a `shell: false` and a
	// NUL regex and still return `shell: true`, so no shape match can prove the
	// policy. The filter instead pins the digest of the one reviewed module: only
	// bytes that hash to `POLICY_MODULE_SHA256` count as provenance. Any edit to
	// the policy — a reformat included — fails the check and keeps the finding
	// until the digest here is re-reviewed. An unreadable module is not evidence.
	var POLICY_MODULE_SHA256 = "ddaa8f04841ea411652f323a61453d05a1783160f8360da0cc1bcb90d73fc3e4";
	function moduleDeclaresPolicy(readFile, path) {
		if (path !== POLICY_MODULE_PATH) return false;
		var text = readFile && typeof path === "string" ? readFile(path) : null;
		if (typeof text !== "string") return false;
		return sha256Hex(text) === POLICY_MODULE_SHA256;
	}

	// Names imported from the shared argv-policy module (`safe-argv`). A bare name
	// match is not proof — the import must resolve to the policy module *and* that
	// module must export the helpers, and no local re-declaration may shadow them,
	// so the forced `shell:false` is enforced at runtime and cannot be forged by a
	// reshaped options literal (a spread, a duplicate key, a shadowing local) or by
	// a same-named helper from a module of another name.
	function safeArgvPolicyNames(code, citedPath, readFile) {
		var names = Object.create(null);
		var spans = [];
		var re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
		var m;
		while ((m = re.exec(code)) !== null) {
			var resolved = resolveRelative(citedPath, m[2]);
			if (resolved === null || !isPolicyModulePath(resolved)) continue;
			if (!moduleDeclaresPolicy(readFile, resolved)) continue;
			spans.push([m.index, m.index + m[0].length]);
			var parts = m[1].split(",");
			for (var i = 0; i < parts.length; i++) {
				var seg = parts[i].trim();
				if (!seg) continue;
				var asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(seg);
				if (asMatch) names[asMatch[2]] = true;
				else if (/^\w+$/.test(seg)) names[seg] = true;
			}
		}
		if (spans.length) {
			// The import clause itself declares each name; blank it out so a name in
			// the list is never read as a shadowing re-declaration.
			var remainder = "";
			var at = 0;
			for (var s = 0; s < spans.length; s++) {
				remainder += code.slice(at, spans[s][0]) + " ";
				at = spans[s][1];
			}
			remainder += code.slice(at);
			for (var name in names) {
				if (policyNameIsShadowed(remainder, name)) delete names[name];
			}
		}
		return names;
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

	/** The quote-stripped text of a literal argv element, or null. */
	function elementText(text) {
		var lit = /^["'`]([^"'`\\]*)["'`]$/.exec(stripAssertion(text).trim());
		return lit ? lit[1].trim() : null;
	}

	/** True when a program literal names an interpreter. */
	function isInterpreterProgram(program) {
		var name = programNameText(program);
		return name !== null && INTERPRETER_PROGRAM.test(name);
	}

	/** True when a literal argv array carries an interpreter's code flag. */
	function argvCarriesCodeToken(argvText) {
		if (!isArrayLiteral(argvText)) return false;
		var parts = splitTopLevel(argvText.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			var val = elementText(parts[i]);
			if (val !== null && CODE_EVAL_TOKEN.test(val)) return true;
		}
		return false;
	}

	/** True when a literal argv array names an interpreter itself. */
	function argvNamesInterpreter(argvText) {
		if (!isArrayLiteral(argvText)) return false;
		var parts = splitTopLevel(argvText.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			var val = elementText(parts[i]);
			if (val !== null && INTERPRETER_PROGRAM.test(val)) return true;
		}
		return false;
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
	function isSafeArgvCall(member, args, bindings, policy) {
		if (CP_MEMBERS[member] !== "argv") return false;
		if (policy.assertNoShell !== true) return false;
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
		if (isInterpreterProgram(programLiteral) && argvCarriesCodeToken(argvSource)) return false;
		if (argvCarriesCodeToken(argvSource) && argvNamesInterpreter(argvSource)) return false;
		if (needsLiteralArgv(programLiteral) && !isArrayLiteral(argvSource)) return false;
		// The options are argv position 3. Requiring the *actual* options argument
		// to be the `assertNoShell` call rejects a call that shadows it behind an
		// ignored extra argument (`spawn(p, a, opts, assertNoShell({}))`).
		if (parts.length < 3) return false;
		var optionsText = stripAssertion(parts[2]);
		if (!/(?:^|[^\w$.])assertNoShell\s*(?:<[^<>]*>)?\s*\(/.test(optionsText)) return false;
		// An env binding is an execution channel the argv proof cannot see — unless
		// it is the policy's own constrained env.
		return !optionsCarryEnvironment(optionsText, bindings, policy);
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
	// registered alias, or a known namespace member all count as a call site.
	function everyChildProcessCallIsSafe(code, bindings, policy) {
		var cp = childProcessBindings(code);
		if (hasComputedChildProcessAccess(code, cp)) return false;
		var names = Object.create(null);
		var i;
		for (i = 0; i < CP_NAMES.length; i++) names[CP_NAMES[i]] = true;
		for (var local in cp.members) names[local] = true;

		var safe = true;
		Object.keys(names).forEach(function (name) {
			if (!safe) return;
			var member = cp.members[name] || name;
			var re = callRegex(name);
			var m;
			while ((m = re.exec(code)) !== null) {
				var open = code.indexOf("(", m.index + m[0].length - 1);
				var args = argumentText(code, open);
				if (args === null || !isSafeArgvCall(member, args, bindings, policy)) {
					safe = false;
					return;
				}
			}
		});
		if (!safe) return false;

		var namespaceNames = Object.keys(cp.namespaces);
		for (i = 0; i < namespaceNames.length && safe; i++) {
			var nsRe = new RegExp(
				escapeRe(namespaceNames[i]) + "\\s*(?:\\?\\.|\\.)\\s*(\\w+)\\s*(?:<[^<>]*>)?\\s*\\(",
				"g",
			);
			var mm;
			while ((mm = nsRe.exec(code)) !== null) {
				var openNs = code.indexOf("(", mm.index + mm[0].length - 1);
				var argsNs = argumentText(code, openNs);
				if (argsNs === null || !isSafeArgvCall(mm[1], argsNs, bindings, policy)) {
					safe = false;
					break;
				}
			}
		}
		return safe;
	}

	function isFalsePositiveCommandExecution(issue, readFile) {
		if (typeof issue.severity !== "string" || issue.severity.toLowerCase() !== "medium")
			return false;
		if (String(issue.title).trim() !== "Command Execution") return false;
		var content = readFile ? readFile(issue.path) : null;
		if (typeof content !== "string") return false;
		var code = stripComments(content);
		if (hasShellExecution(code)) return false;
		var policy = safeArgvPolicyNames(code, issue.path, readFile);
		return everyChildProcessCallIsSafe(code, policyBindings(code, policy), policy);
	}

	function isFalsePositiveHighSecurity(issue, readFile) {
		var code = codeOf(issue);
		if (code.trim() === "") return true;
		if (isCommentOnly(code)) return true;
		if (isStringLiteralUnion(code)) return true;
		var content = readFile ? readFile(issue.path) : null;
		if (namesMissingSymbol(issue, content)) return true;
		if (!ENV_READ.test(code) && !resolvesViaHelper(code, content)) return false;
		return !hasLiteralAssignment(code);
	}

	/**
	 * True when a security finding must not be emitted.
	 * `readFile(path) -> string|null` supplies the cited file's content; an
	 * unavailable file is never evidence, so it keeps the finding.
	 */
	function isFalsePositiveSecurity(issue, readFile) {
		if (!issue || typeof issue !== "object") return false;
		if (isHigh(issue)) return isFalsePositiveHighSecurity(issue, readFile);
		return isFalsePositiveCommandExecution(issue, readFile);
	}

	// --- LOW hygiene findings -------------------------------------------------

	// The two titles CodeFlow raises for its raw marker-comment and debug-output
	// substring matches. Matched verbatim: its matcher is looser than any
	// anchored rule we could mirror, so a title it does not emit exactly is not a
	// finding this rule claims to understand.
	var HYGIENE_TITLES = { "Code Comments": true, "Debug Statements": true };

	function isLow(issue) {
		return typeof issue.severity === "string" && issue.severity.toLowerCase() === "low";
	}

	var TEST_FILE = /\.(?:test|spec)\.[^./]+$/;

	// A test artifact is a `test`/`tests`/`__tests__` directory or a `*.test.*` /
	// `*.spec.*` file name. The class is deliberately narrow: a genuine marker
	// inside one of them never reaches the report.
	function isTestArtifact(path) {
		var segments = path.split("/");
		var last = segments.length - 1;
		for (var i = 0; i < last; i++) {
			if (segments[i] === "test" || segments[i] === "tests" || segments[i] === "__tests__")
				return true;
		}
		return TEST_FILE.test(segments[last]);
	}

	// A documentation artifact is a `.md`/`.mdx` file or a path under `docs/`.
	function isDocArtifact(path) {
		var segments = path.split("/");
		var last = segments.length - 1;
		if (/\.(?:md|mdx)$/.test(segments[last])) return true;
		for (var i = 0; i < last; i++) if (segments[i] === "docs") return true;
		return false;
	}

	/**
	 * True when the analyzer's LOW hygiene heuristic flagged a non-shipping
	 * artifact: a test or a document, where the cited token is domain data. The
	 * rule is path-class only — CodeFlow emits no snippet for these findings, and
	 * a token rule over shipping source would hide real deferred work.
	 * `readFile` is accepted for signature parity with the other predicates; the
	 * class rule needs no content.
	 */
	function isFalsePositiveHygiene(issue, readFile) {
		if (!issue || typeof issue !== "object" || !isLow(issue)) return false;
		if (typeof issue.title !== "string" || HYGIENE_TITLES[issue.title] !== true) return false;
		if (typeof issue.path !== "string" || issue.path === "") return false;
		var path = issue.path.toLowerCase();
		return isTestArtifact(path) || isDocArtifact(path);
	}

	// --- layer violations ----------------------------------------------------

	function extensionOf(path) {
		var dot = path.lastIndexOf(".");
		var slash = path.lastIndexOf("/");
		return dot <= slash + 1 ? "" : path.slice(dot).toLowerCase();
	}

	// This repository's declared import-layer taxonomy, lowest rank first. It is
	// empty on purpose: docs/architecture.md declares no ordered lower/higher
	// boundary, and CodeFlow infers layers from loose path substrings (falling
	// back to `utils`), so its `files[].layer` labels are advisory only. A bare
	// source root (`scripts/`, `cmd/`, `.pi/extensions/`, `test/`) is a directory,
	// not a declared layer. With nothing declared no path resolves, so every edge
	// the analyzer emits is suppressed. Add an entry only for a boundary the repo
	// actually documents, with a rank order that means "may be imported by".
	var REPO_LAYERS = [];

	// The declared layer a path belongs to under `layers`, or null. The most
	// specific (longest) matching prefix wins, so a nested root beats its parent.
	// A path with no extension is a directory or a bare name, never a layered
	// source.
	function resolveLayerIn(layers, path) {
		if (typeof path !== "string" || path === "" || extensionOf(path) === "") return null;
		var best = null;
		for (var i = 0; i < layers.length; i++) {
			var entry = layers[i];
			if (path.indexOf(entry.prefix) === 0 && (!best || entry.prefix.length > best.prefix.length))
				best = entry;
		}
		return best ? { layer: best.layer, rank: best.rank } : null;
	}

	// The layer this repository's declared taxonomy assigns a path, or null.
	function resolveLayer(path) {
		return resolveLayerIn(REPO_LAYERS, path);
	}

	// The recorded import edges, keyed by `source\0target`. The analyzer's
	// `files[].layer` is deliberately not read: the declared taxonomy is the
	// single source of the layer a path belongs to.
	function buildIndex(data) {
		var connections = Object.create(null);
		var conns = data && Array.isArray(data.connections) ? data.connections : [];
		for (var j = 0; j < conns.length; j++) {
			if (conns[j] && typeof conns[j].source === "string" && typeof conns[j].target === "string") {
				connections[conns[j].source + "\u0000" + conns[j].target] = true;
			}
		}
		return { connections: connections };
	}

	// A violation is real only when both endpoints are the same language, both
	// resolve to declared layers, the import runs from a lower rank to a strictly
	// higher one (the inversion), and the analyzer recorded that edge. `index`
	// carries the taxonomy to apply; production supplies the repo's declared
	// `REPO_LAYERS` (via `buildIndex`, which leaves `layers` unset). The tests
	// inject one to exercise the order rule, since production declares none.
	function isFalsePositiveLayerViolation(violation, index) {
		if (!violation || typeof violation !== "object") return true;
		var from = violation.from;
		var to = violation.to;
		if (typeof from !== "string" || typeof to !== "string" || !from || !to) return true;
		var fromExt = extensionOf(from);
		if (!fromExt || fromExt !== extensionOf(to)) return true;
		var layers = index && Array.isArray(index.layers) ? index.layers : REPO_LAYERS;
		var fromLayer = resolveLayerIn(layers, from);
		var toLayer = resolveLayerIn(layers, to);
		if (!fromLayer || !toLayer || fromLayer.rank >= toLayer.rank) return true;
		return !index.connections || index.connections[from + "\u0000" + to] !== true;
	}

	// --- unused functions ----------------------------------------------------

	// Rust `'` opens a lifetime (`&'a str`), not a string: reading it as one
	// would swallow everything up to the next apostrophe.
	var APOSTROPHE_IS_CODE = { ".rs": true };

	function skipQuoted(content, i, quote) {
		i++;
		while (i < content.length) {
			if (content[i] === "\\") i += 2;
			else if (content[i] === quote) return i + 1;
			else i++;
		}
		return i;
	}

	// Blank comments and string bodies so a name mentioned there cannot read as a
	// reference while the code keeps its shape. shortcut: template interpolations
	// are treated as literal text, which only ever keeps a finding.
	function stripNoise(content, path) {
		var apostropheIsCode = APOSTROPHE_IS_CODE[extensionOf(path)] === true;
		var out = "";
		var i = 0;
		while (i < content.length) {
			var ch = content[i];
			if (ch === "/" && content[i + 1] === "/") {
				var line = content.indexOf("\n", i);
				out += " ";
				i = line < 0 ? content.length : line;
			} else if (ch === "/" && content[i + 1] === "*") {
				var end = content.indexOf("*/", i + 2);
				out += " ";
				i = end < 0 ? content.length : end + 2;
			} else if (ch === '"' || ch === "`" || (ch === "'" && !apostropheIsCode)) {
				i = skipQuoted(content, i, ch);
				out += ch + ch;
			} else {
				out += ch;
				i++;
			}
		}
		return out;
	}

	// Definition heads: a declaration (`function`, `fn`, Go's `func`, `def`), an
	// assignment of a function or arrow, or a keyword-less member (`ghost() {}`):
	// a bare `name(...)` counts only when a body/return type follows it.
	function definitionHead(name, flags) {
		var n = escapeRe(name);
		return new RegExp(
			"(?:function\\s+" +
				n +
				"\\b|\\bfn\\s+" +
				n +
				"\\b|\\bfunc\\s+(?:\\([^)\\n]*\\)\\s*)?" +
				n +
				"\\b|\\bdef\\s+" +
				n +
				"\\b|\\b" +
				n +
				"\\s*(?::[^=;\\n]*)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)" +
				"|(?:^|[;{}\\n])\\s*(?:[A-Za-z_$][\\w$]*\\s+)*\\*?\\b" +
				n +
				"\\b\\s*(?:<[^>\\n]*>)?\\([^)\\n]*\\)(?=\\s*[:{]))",
			flags,
		);
	}

	// Skip a balanced `{...}` block from its opening brace (or the file end).
	function braceEnd(content, open) {
		for (var depth = 0, i = open; i < content.length; i++) {
			if (content[i] === "{") depth++;
			else if (content[i] === "}" && --depth === 0) return i + 1;
		}
		return content.length;
	}

	// A definition ends at its closing brace, or at the `;` of a bodyless
	// declaration (a Rust trait method). The parameter list and a `:`-introduced
	// return type (`: {...}`, `extends {...}`) are signature, not body, so a
	// recursive body is not mistaken for an external use. An unbalanced body runs
	// to the end of the file, which only hides references: the finding is then kept.
	function bodyEnd(content, from) {
		var parens = 0;
		for (var i = from; i < content.length; i++) {
			var ch = content[i];
			if (ch === "(") parens++;
			else if (ch === ")" && parens > 0) parens--;
			else if (parens === 0 && ch === ";") return i + 1;
			else if (parens === 0 && ch === "{") {
				if (!/[:|&<,]\s*$|\b(?:extends|implements)\s+$/.test(content.slice(0, i)))
					return braceEnd(content, i);
				i = braceEnd(content, i) - 1; // signature/type brace: keep scanning for the body
			}
		}
		return content.length;
	}

	function inSpans(spans, at) {
		for (var i = 0; i < spans.length; i++) {
			if (at >= spans[i][0] && at < spans[i][1]) return true;
		}
		return false;
	}

	// How a file mentions a name outside its own definitions: a receiver call
	// (`.name(`), a plain call (`name(`) or a value mention (`?? name`, `= name`,
	// `, name`). Null when it does not mention it. A recursive body is not a use.
	function referenceShape(content, name) {
		var spans = [];
		var head = definitionHead(name, "g");
		var m;
		while ((m = head.exec(content)) !== null) {
			spans.push([m.index, bodyEnd(content, m.index + m[0].length)]);
		}
		var scan = new RegExp("\\b" + escapeRe(name) + "\\b", "g");
		var shape = null;
		while ((m = scan.exec(content)) !== null) {
			if (inSpans(spans, m.index)) continue;
			var before = content.slice(Math.max(0, m.index - 64), m.index);
			if (/^\s*\(/.test(content.slice(m.index + name.length, m.index + name.length + 32))) {
				if (/\.[\w$]*\s*$/.test(before)) return "dispatch";
				shape = "call";
			} else if (shape === null && /(?:\?\?|=|,)\s*$/.test(before)) {
				shape = "value";
			}
		}
		return shape;
	}

	// Every symbol the analyzed files still reference: any unreadable file (the
	// definition's own included, else a same-named call elsewhere cannot be
	// attributed to it) leaves the index incomplete, so nothing resolves and every
	// finding stands — fail open. shortcut: only the analyzer's own file set is
	// scanned (it skips e.g. `.mts` tests), so a test-only use reads as unreferenced.
	//
	// A bare mention in another file only refutes the listed definition when that
	// file is the name's sole scanned owner (nothing else it could resolve to);
	// with a second same-named definition the target is ambiguous, so the finding
	// stands. A receiver call dispatches through the receiver's type, so it is
	// attributed regardless of a same-named local definition.
	// shortcut: a dot-call in a file that defines the same name is still
	// attributed to the listed definition (the receiver's type is not known from
	// text); upgrade this when the analyzer records call targets.
	function buildReferenceIndex(data, readFile) {
		var files = data && Array.isArray(data.files) ? data.files : [];
		var cleaned = Object.create(null),
			complete = true;
		for (var i = 0; i < files.length; i++) {
			var path = files[i] && typeof files[i].path === "string" ? files[i].path : null;
			var raw = path !== null && readFile ? readFile(path) : null;
			if (typeof raw === "string") cleaned[path] = stripNoise(raw, path);
			else complete = false;
		}
		var known = Object.create(null),
			defines = Object.create(null);
		// shortcut: definition sites are matched textually, so a declaration form
		// `definitionHead` misses reads as an extra owner and keeps the finding.
		function definesLocally(name, file) {
			if (!(name in defines)) {
				var paths = Object.create(null);
				for (var key in cleaned) paths[key] = definitionHead(name).test(cleaned[key]);
				defines[name] = paths;
			}
			return defines[name][file] === true;
		}
		// The listed file is the only scanned owner of the name. A bare mention
		// elsewhere then has nothing else to resolve to; with a second same-named
		// definition the target is ambiguous from text, so the finding stands.
		function soleOwner(name, file) {
			for (var key in cleaned) if (key !== file && definesLocally(name, key)) return false;
			return definesLocally(name, file);
		}
		function referencedElsewhere(name, file) {
			var sole = soleOwner(name, file);
			for (var key in cleaned) {
				if (key === file) continue;
				var shape = referenceShape(cleaned[key], name);
				if (shape === "dispatch") return true;
				if (shape !== null && sole) return true;
			}
			return false;
		}
		return {
			isReferenced: function (name, file) {
				if (!complete || !(file in cleaned)) return false;
				var key = file + "\u0000" + name;
				if (key in known) return known[key];
				var found = referenceShape(cleaned[file], name) !== null || referencedElsewhere(name, file);
				return (known[key] = found);
			},
		};
	}

	// An entry that names no symbol or no file cannot be disproved, so it stays.
	function isFalsePositiveUnusedFunction(finding, index) {
		if (
			!finding ||
			typeof finding !== "object" ||
			typeof finding.name !== "string" ||
			!finding.name
		) {
			return false;
		}
		if (typeof finding.file !== "string" || !finding.file) return false;
		return index.isReferenced(finding.name, finding.file);
	}

	/** Partition a dead-function list into surviving and refuted entries. */
	function partitionDead(list, index) {
		var kept = [];
		var dropped = [];
		for (var i = 0; i < list.length; i++) {
			if (isFalsePositiveUnusedFunction(list[i], index)) dropped.push(list[i]);
			else kept.push(list[i]);
		}
		return { kept: kept, dropped: dropped };
	}

	// The architecture summary repeats the dead functions under an `N Unused
	// Functions` heading — either carrying the entries, or (as the exported report
	// records it) as a bare count — so both must move with the filtered list.
	// The list-bearing dead-function entry carries its own `items`, so its title
	// and list are filtered together here; the count-only summary is left to
	// `reconcileAggregateIssues`, which owns every aggregate title.
	function filterUnusedIssues(issues, index) {
		var out = [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			var isDeadList =
				!!issue &&
				typeof issue === "object" &&
				Array.isArray(issue.items) &&
				/^\d+ Unused Functions$/.test(String(issue.title));
			if (!isDeadList) {
				out.push(issue);
				continue;
			}
			var kept = partitionDead(issue.items, index).kept;
			if (kept.length)
				out.push(
					Object.assign({}, issue, { title: kept.length + " Unused Functions", items: kept }),
				);
		}
		return out;
	}

	// The analyzer also emits one count-only architecture item per derived metric
	// (`375 Architecture Violations`, `9 Similar Code Blocks`, `44 Unused
	// Functions`). Each names a count the filter just moved, so an un-reconciled
	// item advertises findings the export no longer carries.
	var AGGREGATE_TITLE =
		/^\d+ (Architecture Violations|Unused Functions|Similar Code Blocks|Duplicate Function Names)$/;

	/**
	 * Rewrite or drop every aggregate item so it names the surviving array.
	 * `counts` maps a metric label to that array's kept length, or to `null` when
	 * the array was not reportable — an unknown count leaves the item standing
	 * (fail open), mirroring the `Unused Functions` rule. Entries that do not
	 * match, and non-object entries, pass through untouched and in order.
	 */
	function reconcileAggregateIssues(issues, counts) {
		var out = [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			var match =
				!!issue && typeof issue === "object" && typeof issue.title === "string"
					? AGGREGATE_TITLE.exec(issue.title)
					: null;
			var kept = match ? counts[match[1]] : null;
			if (!match || typeof kept !== "number") {
				out.push(issue);
				continue;
			}
			if (kept > 0) out.push(Object.assign({}, issue, { title: kept + " " + match[1] }));
		}
		return out;
	}

	// --- duplicate code groups ------------------------------------------------

	// A clone GROUP CodeFlow reports with `type:'code'`. A genuine pairwise clone
	// names one or two symbols; the aggregates CodeFlow emits (dozens of members)
	// are repo-wide shape coincidences that hide no actionable duplication.
	var DUPLICATE_MEMBER_LIMIT = 2;

	// Distinct comma-separated member names, or null when the name is unusable
	// (unknown is never suppression evidence).
	function distinctMembers(name) {
		if (typeof name !== "string") return null;
		var parts = name.split(",");
		var seen = Object.create(null);
		var count = 0;
		for (var i = 0; i < parts.length; i++) {
			var member = parts[i].trim();
			if (member === "" || seen[member]) continue;
			seen[member] = true;
			count++;
		}
		return count;
	}

	/** True when a duplicate group carries no actionable duplication. */
	function isFalsePositiveDuplicate(dup, readFile) {
		if (!dup || typeof dup !== "object") return false;
		if (dup.type === "name") return isMemberNameGroup(dup, readFile);
		if (dup.type !== "code") return false;
		var members = distinctMembers(dup.name);
		if (members !== null && members > DUPLICATE_MEMBER_LIMIT) return true;
		// A clone the analyzer found only among tests or documents is not shipped
		// duplication to extract; its own name grouping already skips those paths
		// (`isNonProductionPath`), the code grouping just omits the guard.
		return everyInstance(dup, function (entry) {
			return typeof entry.file === "string" && isArtifactPath(entry.file);
		});
	}

	function isArtifactPath(path) {
		var lower = path.toLowerCase();
		return isTestArtifact(lower) || isDocArtifact(lower);
	}

	/**
	 * True when every reported instance of a group satisfies `test`. A group with
	 * no readable file list satisfies nothing: unknown is never suppression
	 * evidence (the filter fails open, like every other predicate here).
	 */
	function everyInstance(dup, test) {
		var files = dup.files;
		if (!Array.isArray(files) || files.length === 0) return false;
		for (var i = 0; i < files.length; i++) {
			if (!files[i] || typeof files[i] !== "object" || !test(files[i])) return false;
		}
		return true;
	}

	/**
	 * A `type:'name'` group is one identifier reported in 3+ files, with the
	 * ``similarity`` taken from its first two samples — the analyzer already skips
	 * class methods, decorated handlers and common names there. What survives is a
	 * *member* name: the same `apply` on unrelated receivers, or one test helper per
	 * test module. No rename can resolve that, so the group earns no card.
	 * A column-0 declaration is a free function in shipped source and stays.
	 * shortcut: nesting is read off the declaration's leading whitespace, which a
	 * wrapped top-level declaration could fake; upgrade to a brace/scope walk when
	 * a nested group ever proves genuine.
	 */
	function isMemberNameGroup(dup, readFile) {
		return everyInstance(dup, function (entry) {
			if (typeof entry.file !== "string" || entry.file === "") return false;
			if (isArtifactPath(entry.file)) return true;
			return isIndentedDeclaration(entry, readFile);
		});
	}

	function isIndentedDeclaration(entry, readFile) {
		if (!readFile || typeof entry.line !== "number" || entry.line < 1) return false;
		var text = readFile(entry.file);
		if (typeof text !== "string") return false;
		var lines = text.split("\n");
		if (entry.line > lines.length) return false;
		return /^[\t ]/.test(lines[entry.line - 1]);
	}

	// --- entry point ---------------------------------------------------------

	// A Rust facade (`x.rs`) plus everything under `x/` is ONE logical module to
	// the compiler (`mod x;` splices the children in), and a file-level split moves
	// code the analyzer used to attribute to the facade into those children. A
	// reader keyed on the exact path therefore sees a hollow module: the reference
	// that disproves a finding vanished into a sibling the caller never asked for.
	// This is the single home for that naming rule. Callers keep owning the I/O and
	// hand in the candidate paths (the analyzed set in the browser, the directory
	// tree on disk); non-`.rs` paths have no such children.
	function moduleChildPaths(logicalPath, candidates) {
		var out = [];
		if (typeof logicalPath !== "string" || !/\.rs$/.test(logicalPath)) return out;
		var prefix = logicalPath.slice(0, -3) + "/";
		var list = Array.isArray(candidates) ? candidates : [];
		for (var i = 0; i < list.length; i++) {
			var candidate = list[i];
			if (
				typeof candidate === "string" &&
				/\.rs$/.test(candidate) &&
				candidate.indexOf(prefix) === 0
			)
				out.push(candidate);
		}
		return out.sort();
	}

	/**
	 * `readFile(path) -> content|null` over the analyzer's retained file text, for
	 * the browser. The analyzer frees each file's source (`f.content=null`) before
	 * `generateReport` runs, so the served index.html is rewritten to stash the same
	 * text on `files[].piFpSource` (see _UI_REWRITES in server.py); without it the
	 * in-page filter has nothing to resolve references against and keeps every
	 * finding. A path with neither field is absent, so the index stays incomplete
	 * and the filter keeps the finding rather than guessing.
	 *
	 * A logical Rust module reads as its facade plus its child modules, so a
	 * finding recorded against the facade still sees code the split moved away.
	 */
	function readFileFrom(data) {
		var byPath = Object.create(null);
		var paths = [];
		var files = data && Array.isArray(data.files) ? data.files : [];
		for (var i = 0; i < files.length; i++) {
			var file = files[i];
			if (!file || typeof file.path !== "string") continue;
			paths.push(file.path);
			if (typeof file.content === "string") byPath[file.path] = file.content;
			else if (typeof file.piFpSource === "string") byPath[file.path] = file.piFpSource;
		}
		return function (path) {
			if (typeof path !== "string" || !(path in byPath)) return null;
			var text = byPath[path];
			var children = moduleChildPaths(path, paths);
			for (var j = 0; j < children.length; j++) {
				if (children[j] in byPath) text += "\n" + byPath[children[j]];
			}
			return text;
		};
	}

	// --- coupling edges ------------------------------------------------------

	// The analyzer's own fan-in ceiling for its coupling card: a file referenced by
	// more than this many others is flagged. The title that carries the number is
	// the analyzer's to produce, so it is never spelled here.
	var COUPLING_THRESHOLD = 8;

	// How many files that card would flag for this connection list, i.e. how many
	// targets carry more than COUPLING_THRESHOLD incoming edges. Measurement only:
	// the exported title is the analyzer's, never this file's.
	function coupledTargetCount(connections) {
		var counts = Object.create(null);
		var list = Array.isArray(connections) ? connections : [];
		var coupled = 0;
		for (var i = 0; i < list.length; i++) {
			var edge = list[i];
			if (!edge || typeof edge.target !== "string") continue;
			if ((counts[edge.target] = (counts[edge.target] || 0) + 1) === COUPLING_THRESHOLD + 1)
				coupled++;
		}
		return coupled;
	}

	// `data.connections` is the analyzer's resolved cross-file identifier
	// reference list, and the only input to its coupling card. A connection is
	// `{source, target, fn}`: `fn` is the declaration the analyzer resolved,
	// `source` defines it and `target` references it. An edge is not always a
	// dependency — the headless parser resolves a name that has a single definition
	// repo-wide without consulting imports, so a file that mentions that identifier
	// only in prose or in a quoted example still gets an edge.
	//
	// `fn` is the analyzer's own record of which declaration the edge names, so no
	// parser is re-implemented here. Edges the analyzer built from something other
	// than a call (`kind: "mdlink"`) carry a title, not a declaration, and are
	// never pruned.
	function isNonDependencyEdge(edge, readFile) {
		if (!edge || typeof edge !== "object" || Array.isArray(edge)) return false;
		if (typeof edge.kind === "string" && edge.kind !== "") return false;
		if (typeof edge.fn !== "string" || edge.fn === "") return false;
		if (typeof edge.target !== "string" || edge.target === "") return false;
		var source = readFile(edge.target);
		if (typeof source !== "string") return false;
		// Comments and string literals name nothing that executes.
		return !mentionsIdentifier(stripComments(source, true), edge.fn);
	}

	// Does `text` name `name` as an identifier, not as a substring of a longer one?
	function mentionsIdentifier(text, name) {
		return new RegExp("(^|[^\\w$])" + escapeRe(name) + "([^\\w$]|$)").test(text);
	}

	/**
	 * Drop the coupling edges that are not dependencies: an edge goes when its
	 * `target` names the declaration `fn` nowhere outside comments and string
	 * literals. Every other edge is kept — one the analyzer built from a link, one
	 * that names no declaration, and one whose `target` cannot be read. The filter
	 * drops only what it can disprove, and without a reader it prunes nothing.
	 *
	 * Pure: returns a new array plus the dropped edges, in input order.
	 */
	function pruneCouplingEdges(data, opts) {
		var connections = data && Array.isArray(data.connections) ? data.connections : [];
		var readFile = opts && typeof opts.readFile === "function" ? opts.readFile : null;
		var dropped = [];
		if (!readFile) return { connections: connections.slice(), dropped: dropped };
		var kept = [];
		for (var i = 0; i < connections.length; i++) {
			var edge = connections[i];
			if (!isNonDependencyEdge(edge, readFile)) {
				kept.push(edge);
				continue;
			}
			dropped.push({
				source: edge.source,
				target: edge.target,
				reason: "declaration named only in comments or string literals",
			});
		}
		return { connections: kept, dropped: dropped };
	}

	/**
	 * Filter `data.securityIssues` / `data.layerViolations` / the dead-function
	 * lists / `data.duplicates` in place-free fashion. Returns a new `data` object
	 * plus the findings that were dropped, so a caller can report the suppression
	 * instead of silently shrinking the report.
	 *
	 * `opts.deriveSuggestions(filtered)` re-derives `data.suggestions` from the
	 * sanitized object. The seven rules live in the pinned analyzer, so they arrive
	 * as a port; without it the cards are dropped rather than shipped stale.
	 */
	function sanitizeAnalysisData(data, readFile, opts) {
		var suppressed = {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
			suggestions: [],
		};
		if (!data || typeof data !== "object") return { data: data, suppressed: suppressed };

		var out = {};
		for (var key in data) {
			if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
		}

		if (Array.isArray(data.securityIssues)) {
			out.securityIssues = [];
			for (var i = 0; i < data.securityIssues.length; i++) {
				var issue = data.securityIssues[i];
				if (isFalsePositiveHygiene(issue, readFile)) suppressed.hygiene.push(issue);
				else if (isFalsePositiveSecurity(issue, readFile)) suppressed.security.push(issue);
				else out.securityIssues.push(issue);
			}
		}

		if (Array.isArray(data.layerViolations)) {
			var index = buildIndex(data);
			out.layerViolations = [];
			for (var j = 0; j < data.layerViolations.length; j++) {
				var violation = data.layerViolations[j];
				if (isFalsePositiveLayerViolation(violation, index))
					suppressed.layerViolations.push(violation);
				else out.layerViolations.push(violation);
			}
		}

		// The reported dead-function lists are `deadFunctions` in the analyzer's own
		// data and `unusedFunctions` in the exported report; both are re-checked
		// against the snapshot, and `stats.dead` moves with them because the health
		// dead-code term and the summary count read it.
		var deadCount = null;
		var codeDuplicates = null;
		var nameDuplicates = null;
		var deadKeys = ["deadFunctions", "unusedFunctions"].filter(function (key) {
			return Array.isArray(data[key]);
		});
		if (deadKeys.length || Array.isArray(data.issues)) {
			var referenceIndex = buildReferenceIndex(data, readFile);
			for (var k = 0; k < deadKeys.length; k++) {
				var partition = partitionDead(data[deadKeys[k]], referenceIndex);
				out[deadKeys[k]] = partition.kept;
				suppressed.deadCode = suppressed.deadCode.concat(partition.dropped);
				if (deadKeys[k] === "deadFunctions" || deadCount === null)
					deadCount = partition.kept.length;
			}
			if (Array.isArray(data.issues)) out.issues = filterUnusedIssues(data.issues, referenceIndex);
		}

		if (Array.isArray(data.duplicates)) {
			out.duplicates = [];
			for (var d = 0; d < data.duplicates.length; d++) {
				var dup = data.duplicates[d];
				if (isFalsePositiveDuplicate(dup, readFile)) suppressed.duplicates.push(dup);
				else out.duplicates.push(dup);
			}
			// The analyzer keeps its two duplicate items apart (`N Duplicate Function
			// Names` counts `type:'name'` groups, `N Similar Code Blocks` the `code`
			// ones), so the reconciled counts must be bucketed the same way.
			codeDuplicates = out.duplicates.filter(function (group) {
				return group && typeof group === "object" && group.type === "code";
			}).length;
			nameDuplicates = out.duplicates.length - codeDuplicates;
		}

		// One place reconciles every aggregate item against the array it summarizes,
		// so no exported count can outlive the findings it names. A metric whose
		// array the filter never touched keeps its item (`null` = unknown count).
		if (Array.isArray(data.issues)) {
			out.issues = reconcileAggregateIssues(Array.isArray(out.issues) ? out.issues : data.issues, {
				"Architecture Violations": Array.isArray(out.layerViolations)
					? out.layerViolations.length
					: null,
				"Unused Functions": deadCount,
				"Similar Code Blocks": codeDuplicates,
				"Duplicate Function Names": nameDuplicates,
			});
		}

		// `data.stats.security` / `data.stats.violations` are the same counts the
		// report summary and the UI tab badge read, so they must move with the
		// arrays or the report contradicts its own score ("9 high" under an A).
		// `data.stats.duplicates` is the count the architecture item names.
		if (data.stats && typeof data.stats === "object") {
			var stats = (out.stats = Object.assign({}, data.stats));
			if (typeof stats.security === "number" && Array.isArray(out.securityIssues)) {
				stats.security = countHigh(out.securityIssues);
			}
			if (typeof stats.violations === "number" && Array.isArray(out.layerViolations)) {
				stats.violations = out.layerViolations.length;
			}
			if (typeof stats.dead === "number" && deadCount !== null) stats.dead = deadCount;
			if (typeof stats.duplicates === "number" && Array.isArray(out.duplicates)) {
				stats.duplicates = out.duplicates.length;
			}
		}

		// The analyzer derives these cards from the arrays above *before* the filter
		// runs, so an exported card can name counts this report no longer carries.
		// Re-derive through the pinned analyzer's own function (never a copy); with
		// no usable deriver the cards go, because a stale card is worse than none.
		if (Array.isArray(data.suggestions)) {
			var derive =
				opts && typeof opts.deriveSuggestions === "function" ? opts.deriveSuggestions : null;
			var derived = derive ? derive(out) : null;
			if (Array.isArray(derived)) out.suggestions = derived;
			else {
				out.suggestions = [];
				suppressed.suggestions = data.suggestions.slice();
			}
		} else if ("suggestions" in out) delete out.suggestions; // an unreadable card list is dropped

		return { data: out, suppressed: suppressed };
	}

	return {
		sanitizeAnalysisData: sanitizeAnalysisData,
		reconcileAggregateIssues: reconcileAggregateIssues,
		isFalsePositiveSecurity: isFalsePositiveSecurity,
		isFalsePositiveLayerViolation: isFalsePositiveLayerViolation,
		isFalsePositiveHygiene: isFalsePositiveHygiene,
		isFalsePositiveDuplicate: isFalsePositiveDuplicate,
		readFileFrom: readFileFrom,
		moduleChildPaths: moduleChildPaths,
		coupledTargetCount: coupledTargetCount,
		pruneCouplingEdges: pruneCouplingEdges,
		REPO_LAYERS: REPO_LAYERS,
		resolveLayer: resolveLayer,
	};
});
