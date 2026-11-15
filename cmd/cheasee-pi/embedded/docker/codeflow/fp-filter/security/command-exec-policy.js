// Provenance of the shared argv policy: which names in a cited file really come
// from `.pi/extensions/lib/safe-argv.ts`, and what a policy-constrained spawn
// options expression is allowed to look like.
//
// The whole command-execution rule rests on one fact — the cited file's spawn
// options really go through the reviewed policy (forced `shell:false`, sanitized
// env) — so provenance here is by content identity, not by path or by exported
// names. sha256 lives inline because the served page has no synchronous
// `node:crypto`; the browser and the headless runner must compute the same digest.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterSecurityCommandExecPolicy`, and the index (`fp-filter.js`) calls the
// factory once.
//
// Used by: fp-filter.js (index), fp-filter/security/command-exec.js.

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterSecurityCommandExecPolicy = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError(
			"fp-filter/security/command-exec-policy: the dependency object is required",
		);
	var required =
		"escapeRe parseName argumentText splitTopLevel stripAssertion isQuotedLiteral".split(" ");
	for (var r = 0; r < required.length; r++) {
		if (typeof deps[required[r]] !== "function")
			throw new TypeError(
				"fp-filter/security/command-exec-policy: missing dependency " + required[r],
			);
	}

	var escapeRe = deps.escapeRe;
	var parseName = deps.parseName;
	var argumentText = deps.argumentText;
	var splitTopLevel = deps.splitTopLevel;
	var stripAssertion = deps.stripAssertion;
	var isQuotedLiteral = deps.isQuotedLiteral;

	function isLiteralProgram(text) {
		return isQuotedLiteral(text);
	}

	// Names bound by `const { program, args } = argvCommand(...)`. Only a
	// destructured `program` whose argvCommand first argument is *itself a
	// literal* proves a later call's executable; `argvCommand(request.command,
	// ...)` binds nothing, so a dynamic program keeps its finding. A destructured
	// `args` name records the argv expression the policy was handed, so the call
	// site can still inspect it for an interpreter's code flag. `envs` records
	// `const env = sanitizeSpawnEnv(...)` names: only a `const` binding is proof,
	// since a `let`/`var` can be replaced with a hostile env on the next line.
	function policyBindings(code, policy) {
		var programs = Object.create(null);
		var argsNames = Object.create(null);
		var envs = Object.create(null);
		var m;
		var envRe =
			/(?:const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:await\s+)?sanitizeSpawnEnv\s*(?:<[^<>]*>)?\s*\(/g;
		if (policy.sanitizeSpawnEnv === true) {
			while ((m = envRe.exec(code)) !== null) envs[m[1]] = true;
		}
		if (policy.argvCommand !== true) return { programs: programs, args: argsNames, envs: envs };
		var re = /(?:const|let|var)\s*\{([^}]*)\}\s*(?::[^=]*)?=\s*argvCommand\s*(?:<[^<>]*>)?\s*\(/g;
		while ((m = re.exec(code)) !== null) {
			var open = code.indexOf("(", m.index + m[0].length - 1);
			var callArgs = argumentText(code, open);
			var parts = callArgs === null ? [] : splitTopLevel(callArgs);
			var programLiteral = parts.length >= 1 && isLiteralProgram(parts[0]) ? parts[0].trim() : null;
			var argvExpr = parts.length >= 2 ? stripAssertion(parts[1]) : null;
			var fields = m[1].split(",");
			for (var i = 0; i < fields.length; i++) {
				var seg = fields[i].trim();
				if (!seg) continue;
				var colon = seg.indexOf(":");
				var field = (colon < 0 ? seg : seg.slice(0, colon)).trim();
				var local = (colon < 0 ? seg : seg.slice(colon + 1)).trim();
				var id = /^[A-Za-z_$][\w$]*/.exec(local);
				if (!id) continue;
				if (field === "program") {
					if (programLiteral !== null) programs[id[0]] = programLiteral;
				} else if (field === "args") {
					argsNames[id[0]] = argvExpr;
				}
			}
		}
		return { programs: programs, args: argsNames, envs: envs };
	}

	// The imported policy helper must resolve to the module's own export. A local
	// re-declaration of the same name — a function, class, variable, enum,
	// namespace, destructuring, parameter or catch binding — shadows the import,
	// so a call spelled `assertNoShell(...)` / `argvCommand(...)` may run code
	// other than the policy. The name-based proof cannot follow the binding, so a
	// shadowed name is not proof (fail closed).
	function policyNameIsShadowed(code, name) {
		var n = escapeRe(name);
		// Any occurrence that is not a direct call — optionally through a type
		// argument list — is not the imported helper: a parameter, a variable
		// binding, a destructuring, a value reference, a property or a member
		// call. (The import clause is blanked out before this runs.)
		var re = new RegExp("\\b" + n + "\\b", "g");
		var m;
		while ((m = re.exec(code)) !== null) {
			if (!/^\s*(?:<[^<>]*>\s*)?\(/.test(code.slice(m.index + m[0].length))) return true;
		}
		// A function declaration also reads as a call at its name; reject it by the
		// keyword that precedes it. Class, enum and namespace declarations bind the
		// name too.
		return new RegExp(
			"(?:^|[^\\w$.])(?:(?:async\\s+)?function\\s*\\*?\\s*|class\\s+|enum\\s+|namespace\\s+)" +
				n +
				"\\b",
		).test(code);
	}

	// Resolve a relative import specifier against the cited file's own directory,
	// purely (no node:path — the served page loads this file too). A bare or
	// absolute specifier, or one that climbs past the root, resolves to null.
	function resolveRelative(fromPath, specifier) {
		if (typeof fromPath !== "string" || typeof specifier !== "string") return null;
		if (!/^\.\.?\//.test(specifier)) return null;
		var segments = fromPath.split("/");
		segments.pop();
		var parts = specifier.split("/");
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (segments.length === 0) return null;
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return segments.join("/");
	}

	// The one shared argv-policy module lives at the *canonical* repo path
	// `.pi/extensions/lib/safe-argv.ts`. Matching any path that merely ends in
	// `/lib/safe-argv.ts` would let a counterfeit at `src/attacker/lib/safe-argv.ts`
	// (or any other nested path) forge the provenance this whole rule rests on, so
	// the resolved path must equal the canonical module exactly.
	var POLICY_MODULE_PATH = ".pi/extensions/lib/safe-argv.ts";
	function isPolicyModulePath(path) {
		return path === POLICY_MODULE_PATH;
	}

	// SHA-256 over a string's UTF-8 bytes, hex-encoded. Pure, so the served page
	// and the headless runner compute the same digest; the browser has no sync
	// crypto and `crypto.subtle` is async. Used only to pin the policy module.
	function sha256Hex(text) {
		var K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
			0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
			0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
			0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
			0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
			0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
			0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
			0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
			0xc67178f2,
		];
		var H = [
			0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
			0x5be0cd19,
		];
		var bytes = [];
		for (var i = 0; i < text.length; i++) {
			var c = text.charCodeAt(i);
			if (c < 0x80) bytes.push(c);
			else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
			else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
				var cp = 0x10000 + ((c & 0x3ff) << 10) + (text.charCodeAt(++i) & 0x3ff);
				bytes.push(
					0xf0 | (cp >> 18),
					0x80 | ((cp >> 12) & 63),
					0x80 | ((cp >> 6) & 63),
					0x80 | (cp & 63),
				);
			} else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		}
		var bitLen = bytes.length * 8;
		bytes.push(0x80);
		while (bytes.length % 64 !== 56) bytes.push(0);
		var hi = Math.floor(bitLen / 0x100000000);
		var lo = bitLen >>> 0;
		bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
		bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
		function rotr(x, n) {
			return (x >>> n) | (x << (32 - n));
		}
		for (var off = 0; off < bytes.length; off += 64) {
			var w = [];
			for (var t = 0; t < 16; t++)
				w[t] =
					(bytes[off + t * 4] << 24) |
					(bytes[off + t * 4 + 1] << 16) |
					(bytes[off + t * 4 + 2] << 8) |
					bytes[off + t * 4 + 3];
			for (t = 16; t < 64; t++) {
				var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
				var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
			}
			var a = H[0],
				b = H[1],
				cc = H[2],
				d = H[3],
				e = H[4],
				f = H[5],
				g = H[6],
				h = H[7];
			for (t = 0; t < 64; t++) {
				var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				var ch = (e & f) ^ (~e & g);
				var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
				var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				var maj = (a & b) ^ (a & cc) ^ (b & cc);
				var t2 = (S0 + maj) | 0;
				h = g;
				g = f;
				f = e;
				e = (d + t1) | 0;
				d = cc;
				cc = b;
				b = a;
				a = (t1 + t2) | 0;
			}
			H[0] = (H[0] + a) | 0;
			H[1] = (H[1] + b) | 0;
			H[2] = (H[2] + cc) | 0;
			H[3] = (H[3] + d) | 0;
			H[4] = (H[4] + e) | 0;
			H[5] = (H[5] + f) | 0;
			H[6] = (H[6] + g) | 0;
			H[7] = (H[7] + h) | 0;
		}
		var out = "";
		for (var k = 0; k < 8; k++) out += ("00000000" + (H[k] >>> 0).toString(16)).slice(-8);
		return out;
	}

	// Provenance by content identity, not by path or exported names. A counterfeit
	// at the canonical path can declare the two exports, a `shell: false` and a
	// NUL regex and still return `shell: true`, so no shape match can prove the
	// policy. The filter instead pins the digest of the one reviewed module: only
	// bytes that hash to `POLICY_MODULE_SHA256` count as provenance. Any edit to
	// the policy — a reformat included — fails the check and keeps the finding
	// until the digest here is re-reviewed. An unreadable module is not evidence.
	var POLICY_MODULE_SHA256 = "22136e3c275d524c1b3335b0e58c4d5b2908425ca4a31ed614f5134aa91948e5";
	function moduleDeclaresPolicy(readFile, path) {
		if (path !== POLICY_MODULE_PATH) return false;
		var text = readFile && typeof path === "string" ? readFile(path) : null;
		if (typeof text !== "string") return false;
		return sha256Hex(text) === POLICY_MODULE_SHA256;
	}

	// Names imported from the shared argv-policy module (`safe-argv`). A bare name
	// match is not proof — the import must resolve to the policy module *and* that
	// module must export the helpers, and no local re-declaration may shadow them,
	// so the forced `shell:false` is enforced at runtime and cannot be forged by a
	// reshaped options literal (a spread, a duplicate key, a shadowing local) or by
	// a same-named helper from a module of another name.
	function safeArgvPolicyNames(code, citedPath, readFile) {
		var names = Object.create(null);
		var spans = [];
		var re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
		var m;
		while ((m = re.exec(code)) !== null) {
			var resolved = resolveRelative(citedPath, m[2]);
			if (resolved === null || !isPolicyModulePath(resolved)) continue;
			if (!moduleDeclaresPolicy(readFile, resolved)) continue;
			spans.push([m.index, m.index + m[0].length]);
			var parts = m[1].split(",");
			for (var i = 0; i < parts.length; i++) {
				var name = parseName(parts[i]);
				if (name) names[name.local] = true;
			}
		}
		if (spans.length) {
			// The import clause itself declares each name; blank it out so a name in
			// the list is never read as a shadowing re-declaration.
			var remainder = "";
			var at = 0;
			for (var s = 0; s < spans.length; s++) {
				remainder += code.slice(at, spans[s][0]) + " ";
				at = spans[s][1];
			}
			remainder += code.slice(at);
			for (var name in names) {
				if (policyNameIsShadowed(remainder, name)) delete names[name];
			}
		}
		return names;
	}

	/** The single argument text of the `assertNoShell(...)` call, or null. */
	function assertNoShellArgument(optionsText) {
		var m = /(?:^|[^\w$.])assertNoShell\s*(?:<[^<>]*>)?\s*\(/.exec(optionsText);
		if (!m) return null;
		var open = optionsText.indexOf("(", m.index + m[0].length - 1);
		var args = open < 0 ? null : argumentText(optionsText, open);
		if (args === null) return null;
		var parts = splitTopLevel(args);
		return parts.length === 1 ? stripAssertion(parts[0]).trim() : null;
	}

	/** The bare name of a constrained-env expression, or null when it is no call. */
	function constrainedEnvCallName(text) {
		var m = /^([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\(/.exec(text.trim());
		return m ? m[1] : null;
	}

	/**
	 * True when `expr` is the pinned policy's own env constraint: a direct call to
	 * its `sanitizeSpawnEnv` export, or a `const` bound from one. The name must
	 * carry provenance (imported from the pinned module, unshadowed), so a
	 * same-named local helper cannot forge it; a bare identifier that is not such
	 * a binding, or any other expression, is unproven.
	 */
	function envExpressionIsConstrained(expr, bindings, policy) {
		var text = stripAssertion(expr).trim();
		var call = constrainedEnvCallName(text);
		if (call !== null) return call === "sanitizeSpawnEnv" && policy[call] === true;
		return /^[A-Za-z_$][\w$]*$/.test(text) && bindings.envs[text] === true;
	}

	return {
		isLiteralProgram: isLiteralProgram,
		policyBindings: policyBindings,
		policyNameIsShadowed: policyNameIsShadowed,
		resolveRelative: resolveRelative,
		isPolicyModulePath: isPolicyModulePath,
		sha256Hex: sha256Hex,
		moduleDeclaresPolicy: moduleDeclaresPolicy,
		safeArgvPolicyNames: safeArgvPolicyNames,
		assertNoShellArgument: assertNoShellArgument,
		constrainedEnvCallName: constrainedEnvCallName,
		envExpressionIsConstrained: envExpressionIsConstrained,
	};
});
