// The one page-side application of the false-positive filter.
//
// `fp-filter.js` owns the *policy* (which finding is a false positive); this file
// owns the *application*: read the analyzer's result, call the policy once, write
// the filtered fields back into the very object the page rendered, plus release
// the source text that was retained only for the filter. The analysis seam in
// `ui_rewrites.py` calls this once at analysis completion, so the dashboard score,
// the tabs, the markdown export plus the JSON export all read one snapshot.
// Filtering at export time instead scored the raw analyzer output on the
// dashboard, whereas the report showed the filtered number (issue #2147).
//
// Two loaders, one surface: the served page loads this as
// `<script src="fp-filter/browser-glue.js">` after the policy modules (the index
// `fp-filter.js` loads last) plus reads `piFpFilterBrowserGlue`; Node, tests
// `require` it. The policy is resolved at call time — a module tag runs before the
// index publishes `piFpFilter` — but a missing policy throws, so a broken tag
// order fails closed rather than silently scoring raw data.
//
// Failure policy: a sanitizer throw, plus a write the page's object rejects (a
// frozen `data`), reaches the bridge's visible error banner
// (`window.__codeflowBridgeReportError`) then rethrows. The file is strict, so a
// silently-ignored write throws instead; the field writes sit inside the same
// `try` as the filter call, so a failure never leaves a half-filtered object.

(function (root) {
	"use strict";

	var QUIET = { info: function () {} };
	// Every field the policy can shrink, plus the two summary counts derived from
	// them. `unusedFunctions` is the report's name for the list `deadFunctions`
	// carries, so both move together, else the export contradicts itself.
	var FIELDS = [
		"securityIssues",
		"layerViolations",
		"deadFunctions",
		"unusedFunctions",
		"duplicates",
		"issues",
		"suggestions",
		"stats",
	];
	// The suppression buckets, in the sequence the headless runner logs them.
	var BUCKETS = ["security", "layerViolations", "hygiene", "deadCode", "duplicates"];

	var api = { applyFalsePositiveFilter: applyFalsePositiveFilter };
	if (root) root.piFpFilterBrowserGlue = api;
	if (typeof module === "object") module.exports = api;

	function isFunction(value) {
		return typeof value === "function";
	}

	/** The object the bridge's visible error surface lives on. */
	function scopeOf(opts) {
		return opts?.global ?? root ?? null;
	}

	/** The headless runner's policy, once loaded by `require`. */
	function nodePolicy() {
		try {
			return require("../fp-filter.js");
		} catch (error) {
			return null;
		}
	}

	/** An explicit override, the require path, else the page's `piFpFilter` global. */
	function policyOf(opts) {
		var scope = scopeOf(opts);
		var policy = opts?.piFpFilter ?? nodePolicy() ?? scope?.piFpFilter;
		if (!policy || !isFunction(policy.sanitizeAnalysisData) || !isFunction(policy.readFileFrom)) {
			throw new TypeError(
				"fp-filter browser glue: piFpFilter is not loaded (missing module / script order)",
			);
		}
		return policy;
	}

	/** The page's own parser (a global lexical binding of another script). */
	function pageParser() {
		try {
			return Parser;
		} catch (error) {
			return null;
		}
	}

	/**
	 * `data.suggestions` is derived from the arrays this filter shrinks, so the
	 * page's own `Parser.generateSuggestions` is the deriver port — the seven rules
	 * are never mirrored here. No usable deriver yields `null`, which the policy
	 * turns into "no cards" rather than stale ones.
	 */
	function deriverOf(opts) {
		if (isFunction(opts?.deriveSuggestions)) return opts.deriveSuggestions;
		var parser = opts?.Parser ?? pageParser();
		if (!parser || !isFunction(parser.generateSuggestions)) return null;
		return function (filtered) {
			return parser.generateSuggestions(filtered);
		};
	}

	function pageConsole() {
		try {
			return console;
		} catch (error) {
			return null;
		}
	}

	function logLine(opts, text) {
		try {
			(opts?.console ?? pageConsole() ?? QUIET).info(text);
		} catch (error) {
			// A page without a working console surface must still get its report.
		}
	}

	/** The visible, catchable failure: banner plus state first, rethrow by caller. */
	function fail(e, opts) {
		var message = String(e?.message ?? e);
		var scope = scopeOf(opts);
		try {
			scope.__codeflowBridgeReportError(
				"false-positive filter failed; report not exported: " + message,
			);
		} catch (error) {
			// The banner is best-effort: the rethrow in `applyFalsePositiveFilter`
			// is the contract.
		}
		try {
			scope.__codeflowFpFilterError = message;
		} catch (error) {
			// A sealed global object must not swallow the failure itself.
		}
	}

	function countOf(list) {
		return Array.isArray(list) ? list.length : 0;
	}

	/** Byte-identical to the headless runner's stderr lines. */
	function reportSuppressed(opts, suppressed) {
		var counts = BUCKETS.map(function (bucket) {
			return countOf(suppressed[bucket]);
		});
		var total = counts.reduce(function (sum, count) {
			return sum + count;
		}, 0);
		if (total > 0) {
			logLine(
				opts,
				"fp-filter: suppressed " +
					counts[0] +
					" security issue(s), " +
					counts[1] +
					" layer violation(s), " +
					counts[2] +
					" hygiene finding(s), " +
					counts[3] +
					" unused function(s), " +
					counts[4] +
					" duplicate group(s)",
			);
		}
		// Same wording as the headless runner: a missing deriver is never silent.
		var dropped = countOf(suppressed.suggestions);
		if (dropped > 0) {
			logLine(
				opts,
				"fp-filter: dropped " + dropped + " derived suggestion(s): derivation unavailable",
			);
		}
	}

	/** Overwrite the fields the page rendered, never rebinding `data`. */
	function copyFields(data, filtered) {
		FIELDS.forEach(function (field) {
			if (field in filtered) data[field] = filtered[field];
		});
	}

	/** Upstream frees this text on purpose: a large scan must not pin it. */
	function releaseSources(data) {
		var files = Array.isArray(data.files) ? data.files : [];
		files.forEach(function (file) {
			if (file) file.piFpSource = null;
		});
	}

	/**
	 * Filter `data` in place, returning it.
	 *
	 * A key the analyzer never produced never materialises, plus a failure leaves
	 * the object untouched: the writes ride the same `try` as the policy call.
	 */
	function applyFalsePositiveFilter(data, opts) {
		var policy = policyOf(opts);
		if (!data || typeof data !== "object") return data;
		var result = null;
		try {
			result = policy.sanitizeAnalysisData(data, policy.readFileFrom(data), {
				deriveSuggestions: deriverOf(opts),
			});
			copyFields(data, result?.data ?? {});
			releaseSources(data);
		} catch (e) {
			fail(e, opts);
			throw e;
		}
		reportSuppressed(opts, result?.suppressed ?? {});
		return data;
	}
})(typeof globalThis === "object" ? globalThis : this);
