// Deterministic suppression of CodeFlow analyzer false positives.
//
// Applied to the structured `data` the analyzer produced, *before* any report
// artifact is built, so the health score, the markdown export, the JSON export
// and the stats all agree. Five categories:
//
//   1. security findings that cite no real code — an empty or comment-only
//      snippet, a string-literal type union, a value the environment resolves
//      at runtime, or a symbol that does not exist in the cited file;
//   2. layer violations whose two endpoints cannot be a real lower->higher
//      import: a different language, an endpoint off the repo's declared layer
//      taxonomy, a same-or-reversed rank order, or no recorded import edge. The
//      analyzer infers layers from loose path substrings and falls back to
//      `utils`, so its `files[].layer` labels are advisory; REPO_LAYERS below is
//      the single source of which path is which layer, and this repository
//      declares none, so the whole category collapses;
//   3. LOW hygiene findings (`Code Comments` / `Debug Statements`) whose cited
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
// Security suppression considers HIGH severity only: the LOW/MEDIUM shapes
// (argv-array spawns) are left in the report for the audit skill to triage.
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

	/**
	 * True when a HIGH security finding must not be emitted.
	 * `readFile(path) -> string|null` supplies the cited file's content; an
	 * unavailable file is never evidence, so it keeps the finding.
	 */
	function isFalsePositiveSecurity(issue, readFile) {
		if (!issue || typeof issue !== "object" || !isHigh(issue)) return false;
		var code = codeOf(issue);
		if (code.trim() === "") return true;
		if (isCommentOnly(code)) return true;
		if (isStringLiteralUnion(code)) return true;
		var content = readFile ? readFile(issue.path) : null;
		if (namesMissingSymbol(issue, content)) return true;
		if (!ENV_READ.test(code) && !resolvesViaHelper(code, content)) return false;
		return !hasLiteralAssignment(code);
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
		moduleChildPaths: moduleChildPaths,
		REPO_LAYERS: REPO_LAYERS,
		resolveLayer: resolveLayer,
	};
});
