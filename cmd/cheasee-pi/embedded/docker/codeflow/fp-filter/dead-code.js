// Unused functions that the analyzed snapshot does reference.
//
// The analyzer's call graph misses function-as-value references
// (`opts.fetchFn ?? defaultFetch`) and cross-file trait dispatch
// (`Socket::on_message` called in retry.rs), so a symbol that still appears call-
// or value-shaped outside its own definition is not dead.
//
// This module owns its own text scanner (`stripNoise`): it blanks comments and
// string bodies while keeping the code's shape, which is a different output from
// the security rules' `stripComments` (they need the code, this needs the shape).
// The two stay separate on purpose — merging them would change how a source with
// `// fp-filter inside a string` and a regex literal is classified.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterDeadCode`, and the index (`fp-filter.js`) calls the factory once.
//
// Used by: fp-filter.js (index).

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterDeadCode = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/dead-code: the dependency object is required");
	var required = "skipString escapeRe extensionOf mapIssues".split(" ");
	for (var r = 0; r < required.length; r++) {
		if (typeof deps[required[r]] !== "function")
			throw new TypeError("fp-filter/dead-code: missing dependency " + required[r]);
	}

	var skipString = deps.skipString;
	var escapeRe = deps.escapeRe;
	var extensionOf = deps.extensionOf;
	var mapIssues = deps.mapIssues;

	// Rust `'` opens a lifetime (`&'a str`), not a string: reading it as one
	// would swallow everything up to the next apostrophe.
	var APOSTROPHE_IS_CODE = { ".rs": true };

	// Blank comments and string bodies so a name mentioned there cannot read as a
	// reference while the code keeps its shape. `skipString` is the same scanner
	// the security rules use; keeping one copy meant one place to audit.
	// shortcut: template interpolations are treated as literal text, which only
	// ever keeps a finding.
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
				i = skipString(content, i);
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
		return mapIssues(issues, function (issue) {
			var isDeadList =
				!!issue &&
				typeof issue === "object" &&
				Array.isArray(issue.items) &&
				/^\d+ Unused Functions$/.test(String(issue.title));
			if (!isDeadList) return [issue];
			var kept = partitionDead(issue.items, index).kept;
			if (!kept.length) return [];
			return [Object.assign({}, issue, { title: kept.length + " Unused Functions", items: kept })];
		});
	}

	return {
		stripNoise: stripNoise,
		definitionHead: definitionHead,
		braceEnd: braceEnd,
		bodyEnd: bodyEnd,
		inSpans: inSpans,
		referenceShape: referenceShape,
		buildReferenceIndex: buildReferenceIndex,
		isFalsePositiveUnusedFunction: isFalsePositiveUnusedFunction,
		partitionDead: partitionDead,
		filterUnusedIssues: filterUnusedIssues,
	};
});
