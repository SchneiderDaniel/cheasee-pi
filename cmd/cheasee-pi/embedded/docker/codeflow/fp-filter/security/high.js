// HIGH security findings that cite no real code — an empty or comment-only
// snippet, a string-literal type union, a value the environment resolves at
// runtime, or a symbol that does not exist in the cited file.
//
// Every answer here is fail-closed: `readFile` returning null is not evidence, so
// a finding whose file cannot be read keeps its place in the report.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterSecurityHigh`, and the index (`fp-filter.js`) calls the factory once.
//
// Used by: fp-filter.js (index).

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterSecurityHigh = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/security/high: the dependency object is required");
	if (typeof deps.escapeRe !== "function")
		throw new TypeError("fp-filter/security/high: missing dependency escapeRe");

	var escapeRe = deps.escapeRe;

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

	function codeOf(issue) {
		return typeof issue.code === "string" ? issue.code : "";
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

	return {
		isHigh: isHigh,
		codeOf: codeOf,
		isCommentOnly: isCommentOnly,
		isStringLiteralUnion: isStringLiteralUnion,
		hasLiteralAssignment: hasLiteralAssignment,
		helperReadsEnv: helperReadsEnv,
		bindingReadsEnv: bindingReadsEnv,
		resolvesViaHelper: resolvesViaHelper,
		namesMissingSymbol: namesMissingSymbol,
		isFalsePositiveHighSecurity: isFalsePositiveHighSecurity,
	};
});
