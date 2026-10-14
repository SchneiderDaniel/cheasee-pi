// Deterministic suppression of CodeFlow analyzer false positives.
//
// Applied to the structured `data` the analyzer produced, *before* any report
// artifact is built, so the health score, the markdown export, the JSON export
// and the stats all agree. Five categories:
//
//   1. HIGH security findings that cite no real code — an empty or comment-only
//      snippet, a string-literal type union, a value the environment resolves
//      at runtime, or a symbol that does not exist in the cited file;
//   2. MEDIUM `Command Execution` findings, which the analyzer raises from a
//      whole-file `node:child_process` import/require rather than a call. Such a
//      finding is dropped only when the cited file's own text proves *every*
//      child-process call is an argv-array invocation whose program resolves to
//      a literal and whose argv is a literal array or a `argvCommand`-validated
//      binding, with the shell forced off. An unreadable file, a dynamic
//      program, unvalidated argv, or any shell call keeps it (fail closed).
//   3. layer violations whose two endpoints cannot reference each other at all
//      (different languages, no import edge) or whose claimed layer is not the
//      one the report itself assigns the file;
//   4. LOW hygiene findings (`Code Comments` / `Debug Statements`) whose cited
//      path is a non-shipping artifact — a test or a document, where the
//      flagged token is fixture data or a worked example, not deferred work;
//   4. unused functions that the snapshot does reference. The analyzer's call
//      graph misses function-as-value references (`opts.fetchFn ?? defaultFetch`)
//      and cross-file trait dispatch (`Socket::on_message` called in retry.rs),
//      so a symbol that still appears call- or value-shaped outside its own
//      definition is not dead;
//   5. aggregate code-clone groups whose `name` lists more than a small number
//      of distinct member symbols — a genuine pairwise clone names one or two,
//      while the dozen-member aggregates are repo-wide shape coincidences.
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
	// `assertNoShell` for the options) and no shell-executing construct appears
	// anywhere. An unreadable file, an unrecognised call shape, a dynamic
	// program, or any shell call keeps the finding (fail closed).

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
	var SHELL_PROGRAM = /["'`](?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash|cmd(?:\.exe)?|powershell(?:\.exe)?)["'`]/;

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
	// call site nor a regex containing `//` fake one.
	function stripComments(code) {
		var out = "";
		var i = 0;
		while (i < code.length) {
			var ch = code[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				var s = i;
				i = skipString(code, i);
				out += code.slice(s, i);
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
	// ...)` binds nothing, so a dynamic program keeps its finding. Destructured
	// `args` names are recorded as validated argv sources.
	function argvCommandBindings(code) {
		var programs = Object.create(null);
		var argsNames = Object.create(null);
		var re = /(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*argvCommand\s*(?:<[^<>]*>)?\s*\(/g;
		var m;
		while ((m = re.exec(code)) !== null) {
			var open = code.indexOf("(", m.index + m[0].length - 1);
			var callArgs = argumentText(code, open);
			var parts = callArgs === null ? [] : splitTopLevel(callArgs);
			var programLiteral = parts.length >= 1 && isLiteralProgram(parts[0]) ? parts[0].trim() : null;
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
					argsNames[id[0]] = true;
				}
			}
		}
		return { programs: programs, args: argsNames };
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

		re = /(?:const|let|var)\s+([^;=\n]+?)\s*=\s*\(*\s*(?:await\s+)?\(*\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\.\s*(\w+))?/g;
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
		re = /(?:const|let|var)\s+([^;=\n]+?)\s*=\s*\(*\s*(?:await\s+)?\(*\s*import\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\.\s*(\w+))?/g;
		while ((m = re.exec(code)) !== null) {
			var dlhs = m[1].trim();
			if (m[2]) {
				if (CP_MEMBERS[m[2]]) members[dlhs] = m[2];
			} else if (/^\{/.test(dlhs)) addNamed(dlhs.replace(/^\{/, "").replace(/\}$/, ""));
			else if (/^\w+$/.test(dlhs)) namespaces[dlhs] = true;
		}

		// Assignment to a name declared elsewhere (`let cp; cp = require(...)`):
		// the declaration scans above miss it, so register the receiver too.
		re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*\(*\s*(?:await\s+)?\(*\s*(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
		while ((m = re.exec(code)) !== null) namespaces[m[1]] = true;

		// Fail closed on any other one-line binding of a module result the
		// structured scans above do not enumerate — a nested paren group, a
		// ternary, a helper call (`const cp = ((await import(...)))`, `const cp =
		// cond ? require(...) : null`). Registering the receiver as a namespace
		// only ever makes more call sites visible, so an unrecognised shape
		// denies a suppression rather than hiding a genuine shell-out.
		re = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*[^;=\n]*?(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
		while ((m = re.exec(code)) !== null) namespaces[m[1]] = true;

		// Assignment and destructuring aliases, iterated to a fixpoint.
		for (var pass = 0; pass < 3; pass++) {
			re = /(?:const|let|var)\s+(\w+)\s*=\s*(?:promisify\s*\(\s*(\w+)\s*\)|(\w+)\s*\.\s*(\w+)|(\w+))/g;
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

	/** The call pattern for a bare (non-namespaced) member name. */
	function callRegex(name) {
		return new RegExp(
			"(?:^|[^\\w$.])" + escapeRe(name) + "\\s*(?:<[^<>]*>)?\\s*(?:\\?\\.\\s*)?\\(",
			"g"
		);
	}

	// Strip a trailing type assertion (`args as string[]`) before the test; it
	// hides no value change. `as` in a nested generic is never trailing.
	function stripAssertion(text) {
		var a = text.trim();
		var m = /\s+as\s+[^,]+$/.exec(a);
		return m ? a.slice(0, m.index).trim() : a;
	}

	// A literal argv array, e.g. `["--version"]` — no element can smuggle a
	// program in, so this is a validated argv source alongside `argvCommand`.
	// An element that is constructed (`"-" + "c"`) or escaped (`"\x2dc"`) can
	// assemble a shell flag at runtime; the static proof cannot follow it, so
	// such an array is not a proven source — the caller fails closed.
	function isArrayLiteral(text) {
		var a = text.trim();
		if (a.charAt(0) !== "[" || a.charAt(a.length - 1) !== "]") return false;
		var parts = splitTopLevel(a.slice(1, -1));
		for (var i = 0; i < parts.length; i++) {
			if (/["'`]\s*\+|\+\s*["'`]/.test(parts[i])) return false;
			if (parts[i].indexOf("\\") >= 0) return false;
		}
		return true;
	}

	// One call is safe when its executable resolves to a literal (directly or
	// through `argvCommand(<literal>, ...)`), its argv is a literal array or an
	// `argvCommand`-validated binding, and its options force the shell off.
	// Anything else — a dynamic program or an unvalidated argv array — fails
	// closed so a genuine command-execution finding is never hidden.
	function isSafeArgvCall(member, args, bindings) {
		if (CP_MEMBERS[member] !== "argv") return false;
		var parts = splitTopLevel(args);
		if (parts.length < 2) return false;
		var program = stripAssertion(parts[0]);
		if (!isLiteralProgram(program) && typeof bindings.programs[program] !== "string") return false;
		var argvExpr = stripAssertion(parts[1]);
		if (!isArrayLiteral(argvExpr) && bindings.args[argvExpr] !== true) return false;
		var options = parts.slice(1).join(",");
		return (
			/assertNoShell\s*(?:<[^<>]*>)?\s*\(/.test(options) ||
			/(?:^|[^\w$])shell\s*:\s*false\b/.test(options)
		);
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
				new RegExp("(?:^|[^\\w$.])" + escapeRe(namespaces[i]) + "\\s*(?:\\?\\.)?\\s*\\[").test(
					code,
				)
			)
				return true;
		}
		// `\\)*` follows the module call through a wrapping paren group, so the
		// `(await import(...)).member` form is denied as well as the bare one.
		if (/(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)\s*\)*\s*(?:\?\.)?\s*[.\[]/.test(code))
			return true;
		var members = Object.keys(cp.members);
		for (i = 0; i < CP_NAMES.length; i++) members.push(CP_NAMES[i]);
		for (i = 0; i < members.length; i++) {
			if (
				new RegExp(
					"(?:^|[^\\w$])" + escapeRe(members[i]) + "\\s*(?:\\?\\.)?\\s*\\.\\s*(?:call|apply)\\s*\\(",
				).test(code)
			)
				return true;
		}
		return false;
	}

	// Every child-process call in the file must prove argv-safe; a bare name, a
	// registered alias, or a known namespace member all count as a call site.
	function everyChildProcessCallIsSafe(code, bindings) {
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
				if (args === null || !isSafeArgvCall(member, args, bindings)) {
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
				"g"
			);
			var mm;
			while ((mm = nsRe.exec(code)) !== null) {
				var openNs = code.indexOf("(", mm.index + mm[0].length - 1);
				var argsNs = argumentText(code, openNs);
				if (argsNs === null || !isSafeArgvCall(mm[1], argsNs, bindings)) {
					safe = false;
					break;
				}
			}
		}
		return safe;
	}

	function isFalsePositiveCommandExecution(issue, readFile) {
		if (typeof issue.severity !== "string" || issue.severity.toLowerCase() !== "medium") return false;
		if (String(issue.title).trim() !== "Command Execution") return false;
		var content = readFile ? readFile(issue.path) : null;
		if (typeof content !== "string") return false;
		var code = stripComments(content);
		if (hasShellExecution(code)) return false;
		return everyChildProcessCallIsSafe(code, argvCommandBindings(code));
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

	// CodeFlow assigns a layer by loose substring match and falls back to `utils`
	// for every path it does not recognise, so a label is only a layer this
	// repository actually has when the endpoint path carries it as a directory
	// (e.g. `src/ui/panel.ts`). This repo defines no layer taxonomy, so a label
	// the path does not name — `utils` fallback, `/handler` -> `services` — is
	// the analyzer's invention, not a violation.
	function layerGroundsPath(layer, filePath) {
		if (typeof layer !== "string" || layer === "" || typeof filePath !== "string") return false;
		var wanted = layer.toLowerCase();
		var segments = filePath.toLowerCase().split("/");
		for (var i = 0; i < segments.length - 1; i++) {
			if (segments[i] === wanted) return true;
		}
		return false;
	}

	// A violation is real only when the report's own file table agrees on both
	// endpoints' layers, each endpoint's path actually carries that layer, and
	// the analyzer recorded an import edge between them.
	function buildIndex(data) {
		var byPath = Object.create(null);
		var files = Array.isArray(data.files) ? data.files : [];
		for (var i = 0; i < files.length; i++) {
			if (files[i] && typeof files[i].path === "string") byPath[files[i].path] = files[i];
		}
		var connections = Object.create(null);
		var conns = Array.isArray(data.connections) ? data.connections : [];
		for (var j = 0; j < conns.length; j++) {
			if (conns[j] && typeof conns[j].source === "string" && typeof conns[j].target === "string") {
				connections[conns[j].source + "\u0000" + conns[j].target] = true;
			}
		}
		return { byPath: byPath, connections: connections };
	}

	function isFalsePositiveLayerViolation(violation, index) {
		if (!violation || typeof violation !== "object") return true;
		var from = violation.from;
		var to = violation.to;
		if (typeof from !== "string" || typeof to !== "string" || !from || !to) return true;
		var fromExt = extensionOf(from);
		if (!fromExt || fromExt !== extensionOf(to)) return true;
		var fromFile = index.byPath[from];
		var toFile = index.byPath[to];
		if (!fromFile || !toFile) return true;
		if (violation.fromLayer !== fromFile.layer || violation.toLayer !== toFile.layer) return true;
		if (!layerGroundsPath(violation.fromLayer, from) || !layerGroundsPath(violation.toLayer, to))
			return true;
		return index.connections[from + "\u0000" + to] !== true;
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
	function filterUnusedIssues(issues, index, deadCount) {
		var out = [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			var isDeadList =
				!!issue && typeof issue === "object" && /^\d+ Unused Functions$/.test(String(issue.title));
			if (!isDeadList) {
				out.push(issue);
				continue;
			}
			if (Array.isArray(issue.items)) {
				var kept = partitionDead(issue.items, index).kept;
				if (kept.length)
					out.push(
						Object.assign({}, issue, { title: kept.length + " Unused Functions", items: kept }),
					);
				continue;
			}
			// A count-only summary: the filtered list is the only honest source for
			// it, so it restates the surviving count or goes with the list. With no
			// reportable list the count is unknown, so it stands (fail open).
			if (deadCount === null) out.push(issue);
			else if (deadCount > 0)
				out.push(Object.assign({}, issue, { title: deadCount + " Unused Functions" }));
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

	/** True when an aggregate code-clone group must not be emitted. */
	function isFalsePositiveDuplicate(dup) {
		if (!dup || typeof dup !== "object" || dup.type !== "code") return false;
		var members = distinctMembers(dup.name);
		return members !== null && members > DUPLICATE_MEMBER_LIMIT;
	}

	// --- entry point ---------------------------------------------------------

	/**
	 * `readFile(path) -> content|null` over the analyzer's retained file text, for
	 * the browser. The analyzer frees each file's source (`f.content=null`) before
	 * `generateReport` runs, so the served index.html is rewritten to stash the same
	 * text on `files[].piFpSource` (see _UI_REWRITES in server.py); without it the
	 * in-page filter has nothing to resolve references against and keeps every
	 * finding. A path with neither field is absent, so the index stays incomplete
	 * and the filter keeps the finding rather than guessing.
	 */
	function readFileFrom(data) {
		var byPath = Object.create(null);
		var files = data && Array.isArray(data.files) ? data.files : [];
		for (var i = 0; i < files.length; i++) {
			var file = files[i];
			if (!file || typeof file.path !== "string") continue;
			if (typeof file.content === "string") byPath[file.path] = file.content;
			else if (typeof file.piFpSource === "string") byPath[file.path] = file.piFpSource;
		}
		return function (path) {
			return typeof path === "string" && path in byPath ? byPath[path] : null;
		};
	}

	/**
	 * Filter `data.securityIssues` / `data.layerViolations` / the dead-function
	 * lists / `data.duplicates` in place-free fashion. Returns a new `data` object
	 * plus the findings that were dropped, so a caller can report the suppression
	 * instead of silently shrinking the report.
	 */
	function sanitizeAnalysisData(data, readFile) {
		var suppressed = {
			security: [],
			layerViolations: [],
			hygiene: [],
			deadCode: [],
			duplicates: [],
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
			if (Array.isArray(data.issues))
				out.issues = filterUnusedIssues(data.issues, referenceIndex, deadCount);
		}

		if (Array.isArray(data.duplicates)) {
			out.duplicates = [];
			for (var d = 0; d < data.duplicates.length; d++) {
				var dup = data.duplicates[d];
				if (isFalsePositiveDuplicate(dup)) suppressed.duplicates.push(dup);
				else out.duplicates.push(dup);
			}
			// The aggregate "N Similar Code Blocks" item must name the surviving
			// count, and disappear once no group survives; otherwise the report
			// advertises groups the filter just dropped. The dead-function rewrite
			// above may already have replaced `out.issues`.
			var items = Array.isArray(out.issues) ? out.issues : data.issues;
			if (Array.isArray(items)) {
				out.issues = items
					.map(function (item) {
						if (!item || typeof item !== "object" || typeof item.title !== "string") return item;
						if (!/^\d+ Similar Code Blocks$/.test(item.title)) return item;
						if (out.duplicates.length === 0) return null;
						return Object.assign({}, item, {
							title: out.duplicates.length + " Similar Code Blocks",
						});
					})
					.filter(function (item) {
						return item !== null;
					});
			}
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

		return { data: out, suppressed: suppressed };
	}

	return {
		sanitizeAnalysisData: sanitizeAnalysisData,
		isFalsePositiveSecurity: isFalsePositiveSecurity,
		isFalsePositiveLayerViolation: isFalsePositiveLayerViolation,
		isFalsePositiveHygiene: isFalsePositiveHygiene,
		isFalsePositiveDuplicate: isFalsePositiveDuplicate,
		readFileFrom: readFileFrom,
	};
});
