# False-positive filter module record (#2100 — `VBA God Module`)

The issue is filed from the CodeFlow anti-pattern set: the pinned analyzer counts
the declarations of every scored file and labels a file above the ceiling. This
record documents what the metric measures, why the finding applies to the served
false-positive filter, the delivered module layout, the two load paths that have
to keep agreeing, the measured exit, the guards that keep it from regressing, and
the approaches that were rejected. The register follows `vba-god-module-2036.md`,
the record of the sibling metric.

## The metric

`index.html` `detectPatterns` (pinned analyzer ref below) emits `God Object` as
every scored file whose declaration count exceeds 15, and `VBA God Module` as the
same count over 20:

```js
var godFiles = files.filter(function (f) {
	return f.isCode !== false && f.functions.length > 15;
});
```

For `.js`/`.ts` family files the count comes from the acorn-babel branch, so
object-literal methods and arrow-valued properties are declarations. The in-gate
mirror for that branch is `test/fixtures/acorn-babel-mirror.mts`; the two
scored-extension gates are mirrored in `test/fixtures/long-file-mirror.mts`.

## The finding

`cmd/cheasee-pi/embedded/docker/codeflow/fp-filter.js` measured **91
declarations** in one UMD closure, and 1779 lines, on the pinned base. The file
holds six independent policies — HIGH security, MEDIUM command execution, layer
violations, hygiene, dead code and duplicate groups — plus the shared text
scanners and the provenance rules of the shared `safe-argv` policy. The finding
therefore applies: the file was both a `VBA God Module` and a `God Object`, and it
was the one flag the #2036 register still deferred because its module boundary is
the served-asset contract.

## Delivered layout

The served name is preserved, because the route, the `piFpFilter` global and the
Node `require` path all reference it. The file becomes an index over eight policy
modules, each a UMD factory that takes its dependencies as an argument:

| File                                                 | Declarations | Lines | Owns                                                    |
| ---------------------------------------------------- | ------------ | ----- | ------------------------------------------------------- |
| `codeflow/fp-filter.js`                              | 12           | 462   | public surface, orchestration, aggregate reconciliation |
| `codeflow/fp-filter/lexical.js`                      | 15           | 265   | text and literal scanners, including `stripComments`    |
| `codeflow/fp-filter/hygiene.js`                      | 6            | 91    | LOW hygiene class rule, test/doc path classes           |
| `codeflow/fp-filter/layer.js`                        | 4            | 102   | layer taxonomy, `REPO_LAYERS`, violation rule           |
| `codeflow/fp-filter/security/high.js`                | 10           | 162   | HIGH security rule                                      |
| `codeflow/fp-filter/security/command-exec-policy.js` | 12           | 348   | pinned `safe-argv` provenance, `sha256Hex`              |
| `codeflow/fp-filter/security/command-exec.js`        | 14           | 428   | MEDIUM command-execution proof                          |
| `codeflow/fp-filter/dead-code.js`                    | 14           | 282   | `stripNoise`, reference index, dead-function rule       |
| `codeflow/fp-filter/duplicates.js`                   | 5            | 114   | duplicate-group rules                                   |

Every module lands at or below 15 declarations and below 500 segments, so both
ceilings exit for the whole family. The pre-refactor declaration set is conserved
exactly: 91 declarations are distributed over the family and one declaration is
new, the `wire` loader that builds the same dependency graph for both paths.

## The two load paths

`fp-filter.js` selects its loader in the UMD branch. In Node it requires each
module and calls its factory; in the browser it reads the global each `<script>`
tag published and calls the same factories through the same `wire` table. A
missing module therefore fails the load closed in both paths instead of producing
a policy that silently keeps or suppresses findings.

The served page loads one tag per module in dependency order and the index last.
`ui_rewrites.py` emits those tags from `_FP_FILTER_MODULES`, and `server.py`
serves them from that same tuple as a fixed allowlist, so request text never
becomes a filesystem path. The resolved module path is then `realpath`-confined to
`fp-filter/` exactly like the UI route confines its paths, so even an allowlist
entry that pointed outside the directory could only fail closed. The Dockerfile
copies the module tree next to the index, and the Go harness stages it by walking
the embedded directory.

The policy core is pure: no module requires a builtin, reads the filesystem or
holds cross-module state. `readFile` stays injected at the index seam, and the
sha256 digest of the shared policy module is computed inline because the browser
has no synchronous `node:crypto`.

## Measured exit

- `codeflow/fp-filter.js` no longer appears in any `deferred` list of the Long
  File, God Object and VBA God Module registers.
- The #2036 register records the split as `uncitedReduced` (one path) with eight
  `splitFamilies` siblings, `after.vbaGodModuleCount` is 0, and `deferred` is
  empty; the recorded `after.codeFiles` accounts for the eight added files.
- `test/fixtures/long-file-baseline.json` cites the nine family files in
  `reducedBy` and re-anchors `after.longFileCount` to the delivered tree, which
  flags only `ui/src/session/relay.rs`.
- The #2034 God Object envelope is an immutable record of that issue's
  measurement, so it records the later reduction under `laterReduced` with
  #2100 named, exactly as it already recorded #2035.

## Guards

`test/fp-filter-module-split-2100.test.mts` pins the metric exit, the conserved
declaration set, the Node surface, the purity rules, the browser globals and their
order, the served adapters (module-path containment, `_BRIDGE_SCRIPT` tag order,
Dockerfile COPY set), the parity of the served page against the headless runner on
the recorded pinned-analyzer output, and the register arithmetic.
`cmd/cheasee-pi/codeflow_shim_fp_filter_test.go` pins the served routes, the
verbatim module bytes, the allowlist misses and the harness copy set; the
fail-closed 500 for a module missing from the staged tree is pinned beside the
staging helpers in `codeflow_shim_harness_test.go`.
`.pi/skills/audit-codeflow-analysis/test/bridge.test.mts` pins the browser
contract. `test/codeflow-fp-filter.test.mts` stays byte-identical: the existing
suite is the behaviour-preservation oracle for the move.

Two ledgers record the additions instead of absorbing them silently: `#2004`'s
per-family declaration ledger moves 33 -> 35 for the fail-closed serve test and the
boot-from-staged-tree helper it needs (`startShimAt`), and the served module path
is `realpath`-confined to `fp-filter/` so the allowlist is never the only barrier.

## Rejected approaches

- **A single concatenated bundle.** The metric scores every tracked `.js` file, so
  a bundle keeps the declaration count and stays flagged; moving the code into a
  non-scored extension is guarded against in `long-file-2005.md`.
- **Separate Node modules plus a browser bundle.** Two code paths would drift, and
  the file header forbids a headless/UI divergence; the UMD factory with an
  injected dependency set serves both paths from one source.
- **Merging `stripComments` and `stripNoise`.** The two scanners have different
  output semantics: the security rules need the code a file still executes, the
  dead-code rules need the shape with string bodies blanked. The merge stays
  deferred, and the split test pins that the two remain separate.

## Risk

The per-module declaration counts are measured, not estimated, and the family is
re-measured by the mirrors on every run. The residual risk is browser load order,
which no in-gate browser test executes: it is mitigated by the Go route test, the
tag-order assertion in the bridge suite, and the index failing closed when a
module global is absent.

The metric and its acorn-babel branch derive from the external pinned analyzer
`b0e82d1`; if the CodeFlow checkout is re-pinned, this record, the mirrors and the
fixtures must be re-derived, as in `god-object-2004.md`.
