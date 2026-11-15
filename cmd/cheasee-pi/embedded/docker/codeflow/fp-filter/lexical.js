// Text and literal scanners shared by the false-positive policy modules.
//
// One owner for reading source text: the comment stripper, the string/regex
// skipper, the bracket walkers and the literal-shape tests. Every policy module
// below this one is written in terms of these helpers, so a scanner fix lands
// once instead of drifting between the security rules and the dead-code rules
// (issue #2100 split the former single-file policy into these modules).
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterLexical`, and the index (`fp-filter.js`) calls the factory once with
// the dependencies it needs. The policy core reads no ambient state and holds no
// cross-module variable, so the headless runner and the browser cannot drift.
//
// Used by: fp-filter.js (index) and every policy module.

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterLexical = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	// The family contract: a module is built from the caller's dependency object,
	// never from ambient state. A factory that ran on an undefined dependency set
	// would answer every scan with `undefined` and silently keep findings.
	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/lexical: the dependency object is required");

	function escapeRe(text) {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/**
	 * One entry of an import clause or a destructuring pattern: `name`,
	 * `name as alias`, or `key: local`. Returns the imported name and the local
	 * name it binds, or null when the entry names nothing.
	 */
	function parseName(seg) {
		var text = String(seg).trim();
		var alias = /^(\w+)(?:\s+as\s+|\s*:\s*)(\w+)$/.exec(text);
		if (alias) return { imported: alias[1], local: alias[2] };
		if (/^\w+$/.test(text)) return { imported: text, local: text };
		return null;
	}

	/** Positioned on the opening quote; returns the index just past the close. */
	function skipString(code, i) {
		var quote = code[i++];
		while (i < code.length) {
			if (code[i] === "\\") {
				i += 2;
				continue;
			}
			if (code[i] === quote) return i + 1;
			i++;
		}
		return i;
	}

	/** True when a `/` after `prefix` opens a regex literal, not a division. */
	function startsRegex(prefix) {
		for (var i = prefix.length - 1; i >= 0; i--) {
			var c = prefix[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
			return !/[A-Za-z0-9_$)\]"'`]/.test(c);
		}
		return true;
	}

	/** Positioned on the opening `/`; returns the index just past the flags. */
	function skipRegex(code, i) {
		i++;
		var inClass = false;
		while (i < code.length) {
			var c = code[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) return i + 1;
			else if (c === "\n") return i;
			i++;
		}
		return i;
	}

	// String- and regex-aware comment removal, so a comment can neither hide a
	// call site nor a regex containing `//` fake one. The security rules scan the
	// code a file still executes, so this is the one comment stripper; the
	// dead-code rules need the opposite (`stripNoise` keeps shape), which is why
	// the two scanners stay separate.
	function stripComments(code) {
		var out = "";
		var i = 0;
		while (i < code.length) {
			var ch = code[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				var s = i;
				i = skipString(code, i);
				out += code.slice(s, i);
				continue;
			}
			if (ch === "/" && code[i + 1] === "/") {
				i = code.indexOf("\n", i);
				if (i < 0) break;
				continue;
			}
			if (ch === "/" && code[i + 1] === "*") {
				var end = code.indexOf("*/", i + 2);
				if (end < 0) break;
				i = end + 2;
				continue;
			}
			if (ch === "/" && startsRegex(out)) {
				var r = i;
				i = skipRegex(code, i);
				out += code.slice(r, i);
				continue;
			}
			out += ch;
			i++;
		}
		return out;
	}

	// Top-level comma split, honouring nesting and strings — call arguments.
	function splitTopLevel(text) {
		var parts = [];
		var depth = 0;
		var start = 0;
		var i = 0;
		while (i < text.length) {
			var ch = text[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				i = skipString(text, i);
				continue;
			}
			if (ch === "(" || ch === "[" || ch === "{") depth++;
			else if (ch === ")" || ch === "]" || ch === "}") depth--;
			else if (ch === "," && depth === 0) {
				parts.push(text.slice(start, i));
				start = i + 1;
			}
			i++;
		}
		parts.push(text.slice(start));
		return parts;
	}

	// The argument list of the call whose `(` is at `open`, minus the parens.
	function argumentText(code, open) {
		var depth = 0;
		var i = open;
		while (i < code.length) {
			var ch = code[i];
			if (ch === '"' || ch === "'" || ch === "`") {
				i = skipString(code, i);
				continue;
			}
			if (ch === "(") depth++;
			else if (ch === ")") {
				depth--;
				if (depth === 0) return code.slice(open + 1, i);
			}
			i++;
		}
		return null;
	}

	// Strip a trailing type assertion (`args as string[]`) before the test; it
	// hides no value change. `as` in a nested generic is never trailing.
	function stripAssertion(text) {
		var a = text.trim();
		var m = /\s+as\s+[^,]+$/.exec(a);
		return m ? a.slice(0, m.index).trim() : a;
	}

	// A quoted literal with no escape sequence and no template interpolation. An
	// escape can hide a shell (`"/bin/\u0073h"` is `/bin/sh`), and a template hole
	// assembles its text at runtime, so neither is a proven literal. One owner for
	// the shape, shared by the program test (the executable is named) and the
	// argv-element test (a flag cannot be built on the fly).
	var QUOTED_LITERAL = /^(?:"[^"\\\n]*"|'[^'\\\n]*'|`[^`$\\]*`)$/;

	function isQuotedLiteral(text) {
		return QUOTED_LITERAL.test(text.trim());
	}

	// A plain literal argv element: a quoted string with no escape and no
	// interpolation, a number, or a boolean/null keyword. A constructed element
	// (`"-" + "c"`), a template hole (`` `--x=${y}` ``), a bare identifier or an
	// escaped byte (`"\x2dc"`) can assemble a shell flag at runtime; the static
	// proof cannot follow it, so it is not a proven element — the caller fails
	// closed.
	function isLiteralElement(text) {
		var a = text.trim();
		return (
			isQuotedLiteral(a) ||
			/^-?(?:\d+\.?\d*|\.\d+)$/.test(a) ||
			/^(?:true|false|null|undefined)$/.test(a)
		);
	}

	// A literal argv array — every element a plain literal, so nothing can smuggle
	// a shell string or flag in at runtime (`["-" + "c", cmd]`, `` [`--x=${y}`] ``).
	function isArrayLiteral(text) {
		var a = text.trim();
		if (a.charAt(0) !== "[" || a.charAt(a.length - 1) !== "]") return false;
		var body = a.slice(1, -1).trim();
		if (body === "") return true;
		var parts = splitTopLevel(body);
		for (var i = 0; i < parts.length; i++) {
			if (!isLiteralElement(parts[i])) return false;
		}
		return true;
	}

	/** The quote-stripped text of a literal argv element, or null. */
	function elementText(text) {
		var lit = /^["'`]([^"'`\\]*)["'`]$/.exec(stripAssertion(text).trim());
		return lit ? lit[1].trim() : null;
	}

	function extensionOf(path) {
		var dot = path.lastIndexOf(".");
		var slash = path.lastIndexOf("/");
		return dot <= slash + 1 ? "" : path.slice(dot).toLowerCase();
	}

	/**
	 * Rebuild an ordered issue list: `transform` returns the entries to emit for an
	 * item — `[item]` to pass it through, `[rebuilt]` to replace it, `[]` to drop
	 * it. Both aggregate rewriters share this skeleton.
	 */
	function mapIssues(issues, transform) {
		var out = [];
		for (var i = 0; i < issues.length; i++) {
			var emitted = transform(issues[i]);
			for (var j = 0; j < emitted.length; j++) out.push(emitted[j]);
		}
		return out;
	}

	return {
		escapeRe: escapeRe,
		parseName: parseName,
		skipString: skipString,
		startsRegex: startsRegex,
		skipRegex: skipRegex,
		stripComments: stripComments,
		splitTopLevel: splitTopLevel,
		argumentText: argumentText,
		stripAssertion: stripAssertion,
		isQuotedLiteral: isQuotedLiteral,
		isLiteralElement: isLiteralElement,
		isArrayLiteral: isArrayLiteral,
		elementText: elementText,
		extensionOf: extensionOf,
		mapIssues: mapIssues,
	};
});
