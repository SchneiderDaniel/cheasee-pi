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
//      one the report itself assigns the file.
//
// Only HIGH severity security findings are considered: the LOW/MEDIUM shapes
// (code comments, debug statements, argv-array spawns) are owned by the audit
// skill's own triage (`classifyKnownNoise`) and are never touched here.
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

	// `function name(...)` / `const name = (...) =>` — the definition head.
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
	 * Filter `data.securityIssues` / `data.layerViolations` in place-free fashion.
	 * Returns a new `data` object plus the findings that were dropped, so a
	 * caller can report the suppression instead of silently shrinking the report.
	 */
	function sanitizeAnalysisData(data, readFile) {
		var suppressed = { security: [], layerViolations: [] };
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

		return { data: out, suppressed: suppressed };
	}

	return {
		sanitizeAnalysisData: sanitizeAnalysisData,
		isFalsePositiveSecurity: isFalsePositiveSecurity,
		isFalsePositiveLayerViolation: isFalsePositiveLayerViolation,
		readFileFrom: readFileFrom,
	};
});
