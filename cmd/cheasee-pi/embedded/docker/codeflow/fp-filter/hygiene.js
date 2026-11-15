// LOW hygiene findings (`Code Comments` / `Debug Statements`) whose cited path is
// a non-shipping artifact — a test or a document, where the flagged token is
// fixture data or a worked example, not deferred work.
//
// The path classes this module owns are also the analyzer's "not shipped" set, so
// the duplicate-group rule (`duplicates.js`) asks this module rather than
// re-deriving what a test or a document is.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterHygiene`, and the index (`fp-filter.js`) calls the factory once.
//
// Used by: fp-filter.js (index), fp-filter/duplicates.js.

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterHygiene = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/hygiene: the dependency object is required");

	// The two titles CodeFlow raises for its raw marker-comment and debug-output
	// substring matches. Matched verbatim: its matcher is looser than any
	// anchored rule we could mirror, so a title it does not emit exactly is not a
	// finding this rule claims to understand.
	var HYGIENE_TITLES = { "Code Comments": true, "Debug Statements": true };

	function isLow(issue) {
		return typeof issue.severity === "string" && issue.severity.toLowerCase() === "low";
	}

	var TEST_FILE = /\.(?:test|spec)\.[^./]+$/;
	var TEST_DIRS = { test: true, tests: true, __tests__: true };
	var DOC_DIRS = { docs: true };
	var DOC_FILE = /\.(?:md|mdx)$/;

	/** Does any directory segment (every segment but the file name) satisfy `mark`? */
	function hasDirSegment(segments, mark) {
		for (var i = 0; i < segments.length - 1; i++) if (mark[segments[i]] === true) return true;
		return false;
	}

	// A test artifact is a `test`/`tests`/`__tests__` directory or a `*.test.*` /
	// `*.spec.*` file name. The class is deliberately narrow: a genuine marker
	// inside one of them never reaches the report.
	function isTestArtifact(path) {
		var segments = path.split("/");
		return hasDirSegment(segments, TEST_DIRS) || TEST_FILE.test(segments[segments.length - 1]);
	}

	// A documentation artifact is a `.md`/`.mdx` file or a path under `docs/`.
	function isDocArtifact(path) {
		var segments = path.split("/");
		return DOC_FILE.test(segments[segments.length - 1]) || hasDirSegment(segments, DOC_DIRS);
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

	/** True when a path is a test or a document rather than shipped source. */
	function isArtifactPath(path) {
		var lower = path.toLowerCase();
		return isTestArtifact(lower) || isDocArtifact(lower);
	}

	return {
		isLow: isLow,
		hasDirSegment: hasDirSegment,
		isTestArtifact: isTestArtifact,
		isDocArtifact: isDocArtifact,
		isFalsePositiveHygiene: isFalsePositiveHygiene,
		isArtifactPath: isArtifactPath,
	};
});
