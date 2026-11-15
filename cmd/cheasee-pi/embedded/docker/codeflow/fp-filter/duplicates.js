// Aggregate code-clone groups whose `name` lists more than a small number of
// distinct member symbols — a genuine pairwise clone names one or two, while the
// dozen-member aggregates are repo-wide shape coincidences — and `type:'name'`
// groups that are really member-name repeats (the same `apply` on unrelated
// receivers, or one test helper per module) where no rename can help.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterDuplicates`, and the index (`fp-filter.js`) calls the factory once.
// What counts as a test or a document is `hygiene.js`'s class, not re-derived here.
//
// Used by: fp-filter.js (index).

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterDuplicates = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/duplicates: the dependency object is required");
	if (typeof deps.isArtifactPath !== "function")
		throw new TypeError("fp-filter/duplicates: missing dependency isArtifactPath");

	var isArtifactPath = deps.isArtifactPath;

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

	/** True when a duplicate group carries no actionable duplication. */
	function isFalsePositiveDuplicate(dup, readFile) {
		if (!dup || typeof dup !== "object") return false;
		if (dup.type === "name") return isMemberNameGroup(dup, readFile);
		if (dup.type !== "code") return false;
		var members = distinctMembers(dup.name);
		if (members !== null && members > DUPLICATE_MEMBER_LIMIT) return true;
		// A clone the analyzer found only among tests or documents is not shipped
		// duplication to extract; its own name grouping already skips those paths
		// (`isNonProductionPath`), the code grouping just omits the guard.
		return everyInstance(dup, function (entry) {
			return typeof entry.file === "string" && isArtifactPath(entry.file);
		});
	}

	/**
	 * True when every reported instance of a group satisfies `test`. A group with
	 * no readable file list satisfies nothing: unknown is never suppression
	 * evidence (the filter fails open, like every other predicate here).
	 */
	function everyInstance(dup, test) {
		var files = dup.files;
		if (!Array.isArray(files) || files.length === 0) return false;
		for (var i = 0; i < files.length; i++) {
			if (!files[i] || typeof files[i] !== "object" || !test(files[i])) return false;
		}
		return true;
	}

	/**
	 * A `type:'name'` group is one identifier reported in 3+ files, with the
	 * ``similarity`` taken from its first two samples — the analyzer already skips
	 * class methods, decorated handlers and common names there. What survives is a
	 * *member* name: the same `apply` on unrelated receivers, or one test helper per
	 * test module. No rename can resolve that, so the group earns no card.
	 * A column-0 declaration is a free function in shipped source and stays.
	 * shortcut: nesting is read off the declaration's leading whitespace, which a
	 * wrapped top-level declaration could fake; upgrade to a brace/scope walk when
	 * a nested group ever proves genuine.
	 */
	function isMemberNameGroup(dup, readFile) {
		return everyInstance(dup, function (entry) {
			if (typeof entry.file !== "string" || entry.file === "") return false;
			if (isArtifactPath(entry.file)) return true;
			return isIndentedDeclaration(entry, readFile);
		});
	}

	function isIndentedDeclaration(entry, readFile) {
		if (!readFile || typeof entry.line !== "number" || entry.line < 1) return false;
		var text = readFile(entry.file);
		if (typeof text !== "string") return false;
		var lines = text.split("\n");
		if (entry.line > lines.length) return false;
		return /^[\t ]/.test(lines[entry.line - 1]);
	}

	return {
		distinctMembers: distinctMembers,
		isFalsePositiveDuplicate: isFalsePositiveDuplicate,
		everyInstance: everyInstance,
		isMemberNameGroup: isMemberNameGroup,
		isIndentedDeclaration: isIndentedDeclaration,
	};
});
