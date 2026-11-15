// Layer violations whose two endpoints cannot be a real lower->higher import: a
// different language, an endpoint off the repo's declared layer taxonomy, a
// same-or-reversed rank order, or no recorded import edge.
//
// The analyzer infers layers from loose path substrings and falls back to `utils`,
// so its `files[].layer` labels are advisory; `REPO_LAYERS` below is the single
// source of which path is which layer, and this repository declares none, so the
// whole category collapses.
//
// UMD with an injected dependency set: Node `require`s this file and gets the
// factory, the served page loads it as a `<script>` that publishes
// `piFpFilterLayer`, and the index (`fp-filter.js`) calls the factory once.
//
// Used by: fp-filter.js (index).

(function (root, factory) {
	"use strict";
	var api = factory;
	if (typeof module === "object" && module && module.exports) module.exports = api;
	else if (root) root.piFpFilterLayer = api;
})(typeof globalThis === "object" ? globalThis : this, function (deps) {
	"use strict";

	if (!deps || typeof deps !== "object")
		throw new TypeError("fp-filter/layer: the dependency object is required");
	if (typeof deps.extensionOf !== "function")
		throw new TypeError("fp-filter/layer: missing dependency extensionOf");

	var extensionOf = deps.extensionOf;

	// This repository's declared import-layer taxonomy, lowest rank first. It is
	// empty on purpose: docs/architecture.md declares no ordered lower/higher
	// boundary, and CodeFlow infers layers from loose path substrings (falling
	// back to `utils`), so its `files[].layer` labels are advisory only. A bare
	// source root (`scripts/`, `cmd/`, `.pi/extensions/`, `test/`) is a directory,
	// not a declared layer. With nothing declared no path resolves, so every edge
	// the analyzer emits is suppressed. Add an entry only for a boundary the repo
	// actually documents, with a rank order that means "may be imported by".
	var REPO_LAYERS = [];

	// The declared layer a path belongs to under `layers`, or null. The most
	// specific (longest) matching prefix wins, so a nested root beats its parent.
	// A path with no extension is a directory or a bare name, never a layered
	// source.
	function resolveLayerIn(layers, path) {
		if (typeof path !== "string" || path === "" || extensionOf(path) === "") return null;
		var best = null;
		for (var i = 0; i < layers.length; i++) {
			var entry = layers[i];
			if (path.indexOf(entry.prefix) === 0 && (!best || entry.prefix.length > best.prefix.length))
				best = entry;
		}
		return best ? { layer: best.layer, rank: best.rank } : null;
	}

	// The layer this repository's declared taxonomy assigns a path, or null.
	function resolveLayer(path) {
		return resolveLayerIn(REPO_LAYERS, path);
	}

	// The recorded import edges, keyed by `source\0target`. The analyzer's
	// `files[].layer` is deliberately not read: the declared taxonomy is the
	// single source of the layer a path belongs to.
	function buildIndex(data) {
		var connections = Object.create(null);
		var conns = data && Array.isArray(data.connections) ? data.connections : [];
		for (var j = 0; j < conns.length; j++) {
			if (conns[j] && typeof conns[j].source === "string" && typeof conns[j].target === "string") {
				connections[conns[j].source + "\u0000" + conns[j].target] = true;
			}
		}
		return { connections: connections };
	}

	// A violation is real only when both endpoints are the same language, both
	// resolve to declared layers, the import runs from a lower rank to a strictly
	// higher one (the inversion), and the analyzer recorded that edge. `index`
	// carries the taxonomy to apply; production supplies the repo's declared
	// `REPO_LAYERS` (via `buildIndex`, which leaves `layers` unset). The tests
	// inject one to exercise the order rule, since production declares none.
	function isFalsePositiveLayerViolation(violation, index) {
		if (!violation || typeof violation !== "object") return true;
		var from = violation.from;
		var to = violation.to;
		if (typeof from !== "string" || typeof to !== "string" || !from || !to) return true;
		var fromExt = extensionOf(from);
		if (!fromExt || fromExt !== extensionOf(to)) return true;
		var layers = index && Array.isArray(index.layers) ? index.layers : REPO_LAYERS;
		var fromLayer = resolveLayerIn(layers, from);
		var toLayer = resolveLayerIn(layers, to);
		if (!fromLayer || !toLayer || fromLayer.rank >= toLayer.rank) return true;
		return !index.connections || index.connections[from + "\u0000" + to] !== true;
	}

	return {
		REPO_LAYERS: REPO_LAYERS,
		resolveLayerIn: resolveLayerIn,
		resolveLayer: resolveLayer,
		buildIndex: buildIndex,
		isFalsePositiveLayerViolation: isFalsePositiveLayerViolation,
	};
});
