// Deterministic suppression of CodeFlow analyzer false positives.
//
// Applied to the structured `data` the analyzer produced, *before* any report
// artifact is built, so the health score, the markdown export, the JSON export
// and the stats all agree. Two categories:
//
//   1. security findings that cite no real code — an empty or comment-only
//      snippet, a string-literal type union, a value the environment resolves
//      at runtime, or a symbol that does not exist in the cited file;
//   2. layer violations whose two endpoints cannot reference each other at all
//      (different languages, no import edge) or whose claimed layer is not the
//      one the report itself assigns the file;
//   3. unused functions that the snapshot does reference. The analyzer's call
//      graph misses function-as-value references (`opts.fetchFn ?? defaultFetch`)
//      and cross-file trait dispatch (`Socket::on_message` called in retry.rs),
//      so a symbol that still appears call- or value-shaped outside its own
//      definition is not dead.
//
// Only HIGH severity security findings are considered: the LOW/MEDIUM shapes
// (code comments, debug statements, argv-array spawns) are left in the report
// for the audit skill to triage.
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
	var ENV_READ = /\bprocess\.env\b|\benv::var\s*\(|\bstd::env::var\b|\bDeno\.env\b|\bimport\.meta\.env\b|\bos\.environ\b|\bgetenv\s*\(/;
	// The env-var *name* passed to a lookup is not the flagged value.
	var ENV_LOOKUP_ARG = /(?:env::var|std::env::var|getenv|environ(?:\.get)?)\s*\(\s*["'][^"']*["']\s*\)/g;
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
		return code
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/\/\/[^\n]*/g, " ")
			.trim() === "";
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
				")+\\s*;?\\s*$"
		).test(code);
	}

	// Does the snippet bind a plain (non-template) string literal of its own?
	// Such a literal is the value that was flagged, so the finding stands even
	// if the surrounding block reads the environment for something else.
	function hasLiteralAssignment(code) {
		var stripped = code
			.replace(/`(?:[^`\\]|\\.)*`/g, "``")
			.replace(ENV_LOOKUP_ARG, "envRef()");
		return /[=:(,]\s*["'][^"'\n]{4,}["']/.test(stripped);
	}

	// The definition head of a helper binding: a declaration or a const arrow.
	function helperReadsEnv(name, content) {
		var head = new RegExp(
			"(?:function\\s+" + escapeRe(name) + "\\b|\\b" + escapeRe(name) +
				"\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|\\b[A-Za-z_$][\\w$]*\\s*=>))"
		);
		var m = head.exec(content);
		if (!m) return false;
		var body = content.slice(m.index, m.index + HELPER_WINDOW);
		return ENV_READ.test(body) || ENV_HELPER_HINT.test(body);
	}

	// `const ghToken = resolveGitHubToken();` — the value comes from a helper.
	function bindingReadsEnv(name, content) {
		var m = new RegExp(
			"\\b(?:const|let|var)\\s+" + escapeRe(name) + "\\s*=\\s*([^;\\n]*)"
		).exec(content);
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
		if (!layerGroundsPath(violation.fromLayer, from) || !layerGroundsPath(violation.toLayer, to)) return true;
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
			"(?:function\\s+" + n + "\\b|\\bfn\\s+" + n + "\\b|\\bfunc\\s+(?:\\([^)\\n]*\\)\\s*)?" + n +
				"\\b|\\bdef\\s+" + n +
				"\\b|\\b" + n + "\\s*(?::[^=;\\n]*)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)" +
				"|(?:^|[;{}\\n])\\s*(?:[A-Za-z_$][\\w$]*\\s+)*\\*?\\b" + n + "\\b\\s*(?:<[^>\\n]*>)?\\([^)\\n]*\\)(?=\\s*[:{]))",
			flags
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
				if (!/[:|&<,]\s*$|\b(?:extends|implements)\s+$/.test(content.slice(0, i))) return braceEnd(content, i);
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

	// A use is a call (`name(`, `.name(`) or a value mention (`?? name`, `= name`,
	// `, name`) outside every definition of that name in the file. A recursive
	// body is not a use.
	function referencesSymbol(content, name) {
		var spans = [];
		var head = definitionHead(name, "g");
		var m;
		while ((m = head.exec(content)) !== null) {
			spans.push([m.index, bodyEnd(content, m.index + m[0].length)]);
		}
		var scan = new RegExp("\\b" + escapeRe(name) + "\\b", "g");
		while ((m = scan.exec(content)) !== null) {
			if (inSpans(spans, m.index)) continue;
			if (/^\s*\(/.test(content.slice(m.index + name.length, m.index + name.length + 32))) return true;
			if (/(?:\?\?|=|,)\s*$/.test(content.slice(Math.max(0, m.index - 64), m.index))) return true;
		}
		return false;
	}

	// Every symbol the analyzed files still reference: any unreadable file (the
	// definition's own included, else a same-named call elsewhere cannot be
	// attributed to it) leaves the index incomplete, so nothing resolves and every
	// finding stands — fail open. shortcut: only the analyzer's own file set is
	// scanned (it skips e.g. `.mts` tests), so a test-only use reads as unreferenced.
	function buildReferenceIndex(data, readFile) {
		var files = data && Array.isArray(data.files) ? data.files : [];
		var cleaned = Object.create(null), complete = true, known = Object.create(null);
		for (var i = 0; i < files.length; i++) {
			var path = files[i] && typeof files[i].path === "string" ? files[i].path : null;
			var raw = path !== null && readFile ? readFile(path) : null;
			if (typeof raw === "string") cleaned[path] = stripNoise(raw, path);
			else complete = false;
		}
		return {
			isReferenced: function (name, file) {
				if (!complete || !(file in cleaned)) return false;
				if (name in known) return known[name];
				var found = false;
				for (var key in cleaned) {
					if (referencesSymbol(cleaned[key], name)) { found = true; break; }
				}
				return (known[name] = found);
			},
		};
	}

	// An entry that names no symbol or no file cannot be disproved, so it stays.
	function isFalsePositiveUnusedFunction(finding, index) {
		if (!finding || typeof finding !== "object" || typeof finding.name !== "string" || !finding.name) {
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

	// The architecture list repeats the dead functions under an `N Unused
	// Functions` heading, so it must move with them.
	function filterUnusedIssues(issues, index) {
		var out = [];
		for (var i = 0; i < issues.length; i++) {
			var issue = issues[i];
			var isDeadList = !!issue && typeof issue === "object" && Array.isArray(issue.items) &&
				/^\d+ Unused Functions$/.test(String(issue.title));
			var kept = isDeadList ? partitionDead(issue.items, index).kept : null;
			if (!kept) out.push(issue);
			else if (kept.length) {
				out.push(Object.assign({}, issue, { title: kept.length + " Unused Functions", items: kept }));
			}
		}
		return out;
	}

	// --- entry point ---------------------------------------------------------

	/** `readFile(path) -> content|null` over `files[].content`, for the browser. */
	function readFileFrom(data) {
		var byPath = Object.create(null);
		var files = data && Array.isArray(data.files) ? data.files : [];
		for (var i = 0; i < files.length; i++) {
			if (files[i] && typeof files[i].path === "string" && typeof files[i].content === "string") {
				byPath[files[i].path] = files[i].content;
			}
		}
		return function (path) {
			return typeof path === "string" && path in byPath ? byPath[path] : null;
		};
	}

	/**
	 * Filter `data.securityIssues` / `data.layerViolations` / the dead-function
	 * lists in place-free fashion. Returns a new `data` object plus the findings
	 * that were dropped, so a caller can report the suppression instead of
	 * silently shrinking the report.
	 */
	function sanitizeAnalysisData(data, readFile) {
		var suppressed = { security: [], layerViolations: [], deadCode: [] };
		if (!data || typeof data !== "object") return { data: data, suppressed: suppressed };

		var out = {};
		for (var key in data) {
			if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
		}

		if (Array.isArray(data.securityIssues)) {
			out.securityIssues = [];
			for (var i = 0; i < data.securityIssues.length; i++) {
				var issue = data.securityIssues[i];
				if (isFalsePositiveSecurity(issue, readFile)) suppressed.security.push(issue);
				else out.securityIssues.push(issue);
			}
		}

		if (Array.isArray(data.layerViolations)) {
			var index = buildIndex(data);
			out.layerViolations = [];
			for (var j = 0; j < data.layerViolations.length; j++) {
				var violation = data.layerViolations[j];
				if (isFalsePositiveLayerViolation(violation, index)) suppressed.layerViolations.push(violation);
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
				if (deadKeys[k] === "deadFunctions" || deadCount === null) deadCount = partition.kept.length;
			}
			if (Array.isArray(data.issues)) out.issues = filterUnusedIssues(data.issues, referenceIndex);
		}

		// `data.stats.security` / `data.stats.violations` are the same counts the
		// report summary and the UI tab badge read, so they must move with the
		// arrays or the report contradicts its own score ("9 high" under an A).
		if (data.stats && typeof data.stats === "object") {
			var stats = (out.stats = Object.assign({}, data.stats));
			if (typeof stats.security === "number" && Array.isArray(out.securityIssues)) {
				stats.security = countHigh(out.securityIssues);
			}
			if (typeof stats.violations === "number" && Array.isArray(out.layerViolations)) {
				stats.violations = out.layerViolations.length;
			}
			if (typeof stats.dead === "number" && deadCount !== null) stats.dead = deadCount;
		}

		return { data: out, suppressed: suppressed };
	}

	return {
		sanitizeAnalysisData: sanitizeAnalysisData,
		isFalsePositiveSecurity: isFalsePositiveSecurity,
		isFalsePositiveLayerViolation: isFalsePositiveLayerViolation,
		readFileFrom: readFileFrom,
	};
});
