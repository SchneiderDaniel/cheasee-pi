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
//      `utils`, so its `files[].layer` labels are advisory; `REPO_LAYERS` is the
//      single source of which path is which layer, and this repository declares
//      none, so the whole category collapses;
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
// This file is the index: it owns the public surface and the orchestration, and
// delegates each policy to one module under `fp-filter/`. The split is what keeps
// every file of the family under the analyzer's declaration ceilings (issue
// #2100); the policy modules are pure, take their dependencies as an argument and
// read no ambient state:
//
//   fp-filter/lexical.js                      text and literal scanners
//   fp-filter/hygiene.js                      category 4 (also path classes)
//   fp-filter/layer.js                        category 3 + `REPO_LAYERS`
//   fp-filter/security/high.js                category 1
//   fp-filter/security/command-exec.js        category 2
//   fp-filter/security/command-exec-policy.js the pinned `safe-argv` provenance
//   fp-filter/dead-code.js                    category 5
//   fp-filter/duplicates.js                   category 6
//
// Dual format on purpose: the headless runner requires this file and the served
// browser page loads it as `<script src="fp-filter.js">` after every module tag
// (server.py's `_BRIDGE_SCRIPT`), so the report the UI shows and the report pi
// reads cannot drift. The UMD branch picks the loader: Node `require`s each
// module, the browser takes the `piFpFilter<Name>` global each module publishes.
// A missing module therefore fails closed at load time instead of producing a
// policy that silently keeps or suppresses findings.
//
// Used by: run-analysis.mjs (headless), server.py (browser parity).

(function (root, factory) {
	"use strict";

	// One entry per policy module: the Node specifier and the browser global the
	// `<script>` tag publishes. Both loaders read this one table, so a module
	// cannot be wired into the headless path and forgotten in the served page.
	var MODULES = {
		lexical: ["./fp-filter/lexical.js", "piFpFilterLexical"],
		hygiene: ["./fp-filter/hygiene.js", "piFpFilterHygiene"],
		layer: ["./fp-filter/layer.js", "piFpFilterLayer"],
		securityHigh: ["./fp-filter/security/high.js", "piFpFilterSecurityHigh"],
		commandExecPolicy: [
			"./fp-filter/security/command-exec-policy.js",
			"piFpFilterSecurityCommandExecPolicy",
		],
		commandExec: ["./fp-filter/security/command-exec.js", "piFpFilterCommandExec"],
		deadCode: ["./fp-filter/dead-code.js", "piFpFilterDeadCode"],
		duplicates: ["./fp-filter/duplicates.js", "piFpFilterDuplicates"],
	};

	// Instantiate every module factory with the dependencies it declares. The
	// wiring exists once, here: a factory is a plain function in both loaders, so
	// the headless runner and the served page build the identical policy graph.
	// A module that is missing throws inside its own factory, which fails the load
	// closed instead of yielding a policy that silently keeps or suppresses.
	function wire(load) {
		var lexical = load("lexical")({});
		var hygiene = load("hygiene")({});
		var layer = load("layer")({ extensionOf: lexical.extensionOf });
		var securityHigh = load("securityHigh")({ escapeRe: lexical.escapeRe });
		var policy = load("commandExecPolicy")({
			escapeRe: lexical.escapeRe,
			parseName: lexical.parseName,
			argumentText: lexical.argumentText,
			splitTopLevel: lexical.splitTopLevel,
			stripAssertion: lexical.stripAssertion,
			isQuotedLiteral: lexical.isQuotedLiteral,
		});
		var commandExec = load("commandExec")({ lexical: lexical, policy: policy });
		var deadCode = load("deadCode")({
			skipString: lexical.skipString,
			escapeRe: lexical.escapeRe,
			extensionOf: lexical.extensionOf,
			mapIssues: lexical.mapIssues,
		});
		var duplicates = load("duplicates")({ isArtifactPath: hygiene.isArtifactPath });
		return {
			lexical: lexical,
			hygiene: hygiene,
			layer: layer,
			high: securityHigh,
			commandExecPolicy: policy,
			commandExec: commandExec,
			deadCode: deadCode,
			duplicates: duplicates,
		};
	}

	if (typeof module === "object" && module && module.exports) {
		module.exports = factory(
			wire(function (name) {
				return require(MODULES[name][0]);
			}),
		);
		return;
	}
	if (!root) return;
	// Browser: the module tags ran first and published these globals. A tag that
	// did not run (or ran out of order) fails the whole load closed here, so the
	// page never publishes a filter with policy modules missing.
	root.piFpFilter = factory(
		wire(function (name) {
			var published = root[MODULES[name][1]];
			if (typeof published !== "function")
				throw new TypeError("fp-filter: missing module " + name + " (script order)");
			return published;
		}),
	);
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	var MODULES = [
		"lexical",
		"hygiene",
		"layer",
		"high",
		"commandExecPolicy",
		"commandExec",
		"deadCode",
		"duplicates",
	];
	if (!deps || typeof deps !== "object") throw new TypeError("fp-filter: dependencies required");
	for (var m = 0; m < MODULES.length; m++) {
		var mod = deps[MODULES[m]];
		if (!mod || typeof mod !== "object")
			throw new TypeError("fp-filter: missing module " + MODULES[m]);
	}

	var mapIssues = deps.lexical.mapIssues;
	var isFalsePositiveHygiene = deps.hygiene.isFalsePositiveHygiene;
	var REPO_LAYERS = deps.layer.REPO_LAYERS;
	var resolveLayer = deps.layer.resolveLayer;
	var buildIndex = deps.layer.buildIndex;
	var isFalsePositiveLayerViolation = deps.layer.isFalsePositiveLayerViolation;
	var isHigh = deps.high.isHigh;
	var isFalsePositiveHighSecurity = deps.high.isFalsePositiveHighSecurity;
	var isFalsePositiveCommandExecution = deps.commandExec.isFalsePositiveCommandExecution;
	var buildReferenceIndex = deps.deadCode.buildReferenceIndex;
	var partitionDead = deps.deadCode.partitionDead;
	var filterUnusedIssues = deps.deadCode.filterUnusedIssues;
	var isFalsePositiveDuplicate = deps.duplicates.isFalsePositiveDuplicate;

	// --- security findings ---------------------------------------------------

	function countHigh(issues) {
		var n = 0;
		for (var i = 0; i < issues.length; i++) if (isHigh(issues[i])) n++;
		return n;
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

	// --- aggregate issue reconciliation ---------------------------------------

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
		return mapIssues(issues, function (issue) {
			var match =
				!!issue && typeof issue === "object" && typeof issue.title === "string"
					? AGGREGATE_TITLE.exec(issue.title)
					: null;
			var kept = match ? counts[match[1]] : null;
			if (!match || typeof kept !== "number") return [issue];
			if (kept < 1) return [];
			return [Object.assign({}, issue, { title: kept + " " + match[1] })];
		});
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
	 * Split `list` by its entries' first matching rule: a claimed entry is appended
	 * to that rule's bucket, an unclaimed one is kept. Returns the kept list. Every
	 * suppression bucket in `sanitizeAnalysisData` uses this one pass.
	 */
	function partitionList(list, rules) {
		var kept = [];
		for (var i = 0; i < list.length; i++) {
			var entry = list[i];
			var matched = null;
			for (var r = 0; r < rules.length; r++) {
				if (rules[r].test(entry)) {
					matched = rules[r].bucket;
					break;
				}
			}
			if (matched) matched.push(entry);
			else kept.push(entry);
		}
		return kept;
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
			out.securityIssues = partitionList(data.securityIssues, [
				{
					bucket: suppressed.hygiene,
					test: function (issue) {
						return isFalsePositiveHygiene(issue, readFile);
					},
				},
				{
					bucket: suppressed.security,
					test: function (issue) {
						return isFalsePositiveSecurity(issue, readFile);
					},
				},
			]);
		}

		if (Array.isArray(data.layerViolations)) {
			var index = buildIndex(data);
			out.layerViolations = partitionList(data.layerViolations, [
				{
					bucket: suppressed.layerViolations,
					test: function (violation) {
						return isFalsePositiveLayerViolation(violation, index);
					},
				},
			]);
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
			out.duplicates = partitionList(data.duplicates, [
				{
					bucket: suppressed.duplicates,
					test: function (dup) {
						return isFalsePositiveDuplicate(dup, readFile);
					},
				},
			]);
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
		// `data.stats.duplicates` is the count the architecture item names. A count
		// the filter could not recompute (`null`) leaves the field untouched.
		if (data.stats && typeof data.stats === "object") {
			var stats = (out.stats = Object.assign({}, data.stats));
			var keptCounts = {
				security: Array.isArray(out.securityIssues) ? countHigh(out.securityIssues) : null,
				violations: Array.isArray(out.layerViolations) ? out.layerViolations.length : null,
				dead: deadCount,
				duplicates: Array.isArray(out.duplicates) ? out.duplicates.length : null,
			};
			for (var statKey in keptCounts) {
				if (typeof stats[statKey] !== "number") continue;
				if (typeof keptCounts[statKey] === "number") stats[statKey] = keptCounts[statKey];
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
		REPO_LAYERS: REPO_LAYERS,
		resolveLayer: resolveLayer,
	};
});
