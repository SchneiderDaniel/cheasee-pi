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

	/** First truthy entry, else undefined. */
	function first(list) {
		return list.filter(function (entry) {
			return entry;
		})[0];
	}

	/** `opts[key]`, tolerating a missing/non-object `opts`. */
	function pluck(opts, key) {
		return (opts ?? {})[key];
	}

	function isObject(value) {
		return Boolean(value) && typeof value === "object";
	}

	function isFunction(value) {
		return typeof value === "function";
	}

	/** The object the bridge's visible error surface lives on. */
	function scopeOf(opts) {
		return first([pluck(opts, "global"), root]) ?? null;
	}

	/** The headless runner's policy, once loaded by `require`. */
	function nodePolicy() {
		try {
			return require("../fp-filter.js");
		} catch (error) {
			return null;
		}
	}

	function isPolicy(value) {
		if (!isObject(value)) return false;
		if (!isFunction(value.sanitizeAnalysisData)) return false;
		return isFunction(value.readFileFrom);
	}

	/** An explicit override, the require path, else the page's `piFpFilter` global. */
	function policyOf(opts) {
		var scope = scopeOf(opts);
		var policy = first([pluck(opts, "piFpFilter"), nodePolicy(), scope?.piFpFilter]);
		if (!isPolicy(policy)) {
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
		var explicit = pluck(opts, "deriveSuggestions");
		if (isFunction(explicit)) return explicit;
		var parser = first([pluck(opts, "Parser"), pageParser()]);
		if (!parser) return null;
		if (!isFunction(parser.generateSuggestions)) return null;
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
			(first([pluck(opts, "console"), pageConsole()]) ?? QUIET).info(text);
		} catch (error) {
			// A page without a working console surface must still get its report.
		}
	}

	/** The visible, catchable failure: banner plus state first, rethrow by caller. */
	function fail(e, opts) {
		var message = String(pluck(e, "message") ?? e);
		var scope = scopeOf(opts);
		banner(scope, "false-positive filter failed; report not exported: " + message);
		remember(scope, message);
	}

	function banner(scope, text) {
		try {
			scope.__codeflowBridgeReportError(text);
		} catch (error) {
			// The banner is best-effort: the rethrow in `applyFalsePositiveFilter`
			// is the contract.
		}
	}

	function remember(scope, message) {
		try {
			scope.__codeflowFpFilterError = message;
		} catch (error) {
			// A sealed global object must not swallow the failure itself.
		}
	}

	function countOf(list) {
		return Array.isArray(list) ? list.length : 0;
	}

	function sumOf(counts) {
		return counts.reduce(function (total, count) {
			return total + count;
		}, 0);
	}

	/** Byte-identical to the headless runner's stderr line. */
	function suppressionLine(counts) {
		return (
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
			" duplicate group(s)"
		);
	}

	function reportSuppressed(opts, suppressed) {
		var counts = BUCKETS.map(function (bucket) {
			return countOf(suppressed[bucket]);
		});
		if (sumOf(counts) > 0) logLine(opts, suppressionLine(counts));
		// Same wording as the headless runner: a missing deriver is never silent.
		var dropped = countOf(suppressed.suggestions);
		if (dropped > 0) {
			logLine(opts, "fp-filter: dropped " + dropped + " derived suggestion(s): derivation unavailable");
		}
	}

	/** Overwrite the fields the page rendered, never rebinding `data`. */
	function copyFields(data, filtered) {
		FIELDS.filter(function (field) {
			return field in filtered;
		}).forEach(function (field) {
			data[field] = filtered[field];
		});
	}

	/** Upstream frees this text on purpose: a large scan must not pin it. */
	function releaseSources(data) {
		var files = Array.isArray(data.files) ? data.files : [];
		files.filter(Boolean).forEach(function (file) {
			file.piFpSource = null;
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
		if (!isObject(data)) return data;
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
