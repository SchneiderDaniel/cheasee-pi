# Derived suggestion cards (#2030 — the seven top-level suggestions)

The issue is filed from the `(derived)` section of a CodeFlow export:
`suggestions[]` carries seven cards — `Fix Security Issues`, `Remove Dead Code`,
`Split Large Files`, `Extract Duplicated Code`, `Fix Architecture Violations`,
`Reduce Coupling`, `Resolve Naming Conflicts` — with no file list of their own.
They are not seven code smells. They are one defect in the reporting pipeline:
the analyzer derives them from the finding arrays **before** the false-positive
filter drops the false positives, and the filter never re-derives them. This
file records the derivation, the reproduction, the measured before/after, the
residual set and the re-pin contract.

## The derivation

`index.html` builds the cards inside `Parser.analyze` (`:5473`), from
`Parser.generateSuggestions` (`:1687-1729`, pinned ref below). Each card names
one underlying signal:

| Card                          | Source                                  | Fires when                         |
| ----------------------------- | --------------------------------------- | ---------------------------------- |
| `Remove Dead Code`            | `stats.dead`                            | `> 10`                             |
| `Break Circular Dependencies` | `issues[]` titles containing `Circular` | at least one matching issue        |
| `Split Large Files`           | `issues[]` titles containing `Large`    | at least one matching issue        |
| `Reduce Coupling`             | `issues[]` titles containing `Coupled`  | at least one matching issue        |
| `Resolve Naming Conflicts`    | `duplicates[]` with `type === 'name'`   | at least one name-duplicate        |
| `Extract Duplicated Code`     | `duplicates[]` with `type === 'code'`   | at least one code-duplicate        |
| `Fix Architecture Violations` | `layerViolations[]`                     | non-empty                          |
| `Fix Security Issues`         | `securityIssues[]` with `severity` high | at least one HIGH                  |
| `Add Test Coverage`           | `files[]` test-file ratio               | under 10 % in a repo over 10 files |

Every row reads an array or stat that `fp-filter.sanitizeAnalysisData` also
rewrites, which is why a card can end up naming findings the same export no
longer carries.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
git -C /tmp/codeflow-ui fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C /tmp/codeflow-ui checkout --detach FETCH_HEAD

rm -rf /tmp/src /tmp/out && mkdir -p /tmp/src /tmp/out
git archive HEAD | tar -x -C /tmp/src
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/src /tmp/codeflow-ui /tmp/out
```

`report.json` → `suggestions` is the derived set; the same file's
`securityIssues` / `layerViolations` / `duplicates` are the sources the filter
already reconciled.

## Before / after (pinned analyzer, same snapshot method)

Measured on the delivered `HEAD` at filing (analyzedAt `1791804971015`):

| Stage                        | cards | titles                                                                                                                                                                                             |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| before the filter            | 7     | `Break Circular Dependencies`, `Fix Security Issues` (9 high), `Remove Dead Code` (44), `Split Large Files`, `Extract Duplicated Code` (3), `Fix Architecture Violations` (375), `Reduce Coupling` |
| after the filter, re-derived | 4     | `Break Circular Dependencies` (2), `Remove Dead Code` (24), `Split Large Files`, `Reduce Coupling`                                                                                                 |

The filter suppressed 9 HIGH security findings (the 5 MEDIUM hits survive), all
375 layer edges and all 3 duplicate groups, so `Fix Security Issues`,
`Fix Architecture Violations`, `Extract Duplicated Code` and
`Resolve Naming Conflicts` had no source left: the 3 duplicate groups of that
snapshot are aggregate shapes, and no `type === 'name'` group was reported at
all. `architectureIssues` also lost its `375 Architecture Violations` item,
because the array it summarizes is empty.

Those counts are what the filing recorded, and only they are asserted. Later
runs drift with the delivered tree (the `17c991c0` issue-snapshot replay
measures 9 HIGH / 357 layer edges / 7 duplicate groups / 45 unused functions
before the filter); `test/fixtures/suggestions-2030-baseline.json` keeps such a
re-measurement in its own `remeasured` block, deliberately outside `before`.

The counters, the contradiction each removed card named, and the checkable
invariants are pinned in `test/fixtures/suggestions-2030-baseline.json` and
replayed by `test/codeflow-run-analysis-part6.test.mts` (`suggestions-2030
baseline` block) — shape and invariants only, never the drifting counts.

### The duplicate groups on the pinned snapshot

Three groups the filter used to keep were worth a rule of their own, because
they are what kept `Extract Duplicated Code` / `Resolve Naming Conflicts`
alive:

- `acquire, acquire, editor` (100 % similar) is three instances inside
  `.pi/extensions/*/test/` files — clones among test artifacts. The analyzer's
  own name grouping skips non-production paths (`isNonProductionPath`); its code
  grouping simply omits the guard, so the filter applies it.
- `apply` and `ingest_frame` are `impl` members on four different state structs,
  and `unique_dir` is one `#[cfg(test)]` helper per module. A `type:'name'`
  group is a name coincidence — the analyzer already skips class methods,
  decorated handlers and common names — so the filter drops a name group whose
  every instance is a nested (indented) declaration or an artifact path, and
  keeps any group that reaches a column-0 declaration in shipped source.

With every group gone, `<N> Similar Code Blocks` and
`<N> Duplicate Function Names` are reconciled to zero and dropped, so the
architecture list cannot outlive `duplicates[]` either.

## The fix

- `fp-filter.sanitizeAnalysisData(data, readFile, opts?)` takes a deriver port
  (`opts.deriveSuggestions(filtered)`) and re-derives `out.suggestions` from the
  sanitized object. The seven rules stay in the pinned analyzer and are never
  mirrored in this repo, so a re-pin cannot let them drift.
- With no deriver — or a deriver returning a non-array — the filter exports
  `suggestions: []` and records the raw cards in `suppressed.suggestions`.
  Headless (`run-analysis.mjs`) and served (`ui_rewrites.py`) paths both log
  `fp-filter: dropped N derived suggestion(s): derivation unavailable`, so a
  silent re-pin never turns into silently stale cards.
- `reconcileAggregateIssues` is the single owner of the count-only architecture
  items (`<N> Architecture Violations`, `<N> Unused Functions`,
  `<N> Similar Code Blocks`, `<N> Duplicate Function Names`): retitle to the
  surviving length, drop at zero, leave standing when the array was not
  reportable. The two duplicate items are bucketed like the analyzer buckets
  them (`name` groups / `code` groups), so a name count never stands on a code
  list.
- `isFalsePositiveDuplicate` also drops the two residual group shapes that are
  not shippable duplication: a code group whose every instance is a test or doc
  artifact, and a `type:'name'` group whose every instance is a nested (indented)
  declaration or an artifact. Both fail open — no readable file list or source
  keeps the group.
- `report.classifyFinding` sends a `suggestion` fact to
  `issueType: "derived"` / `disposition: "link-derived"`. Derived facts are
  listed by `dry-run` (the operator sees the whole signal) and never drafted: a
  file-less issue whose count contradicted the export is what produced #2030 in
  the first place.

## Residual set (deliberately not driven to zero)

| Card                          | Source                               | Owned by                                                                |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `Break Circular Dependencies` | `issues[]` `2 Circular Dependencies` | the circular-dependency architecture fact                               |
| `Remove Dead Code`            | `unusedFunctions[]` / `stats.dead`   | #2026 (dead-code reference rule)                                        |
| `Split Large Files`           | `issues[]` `21 Large Files`          | `references/long-file-2005.md`, `test/fixtures/long-file-baseline.json` |
| `Reduce Coupling`             | `issues[]` `142 Highly Coupled`      | `references/coupling-2002.md`, `test/fixtures/coupling-baseline.json`   |

These four name metrics that are genuinely non-empty after the filter. Driving
them to zero would mean editing the analyzed tree for a reporting signal, which
is the work their own registers already own.

The pinned deriver also carries a wording wart — `1 files have too many
functions` counts the `issues[]` item, not the files it lists. Fixing it would
mean copying the rule into this repo, which is the drift class this record
exists to prevent; the wart is accepted and recorded here instead.

## Re-pin contract

- The only derivation source is `Parser.generateSuggestions` in the pinned
  `index.html`. `run-analysis.mjs` reads it from `helpers.Parser`, `ui_rewrites.py`
  passes `Parser.generateSuggestions` from the page; both must stay a _call_,
  never a copy.
- A re-pin that renames or removes that function must fail closed, not stale:
  the run still exits 0 with `suggestions: []` and one narration line, and
  `run-analysis.mjs` / the Go spliced-wrapper suite
  (`TestCodeFlowServer_FpFilterSuggestions`) fail before shipping cards.
- Re-measure with the reproduction above; update `before`/`after` in
  `test/fixtures/suggestions-2030-baseline.json` only when the delivered tree
  moves, and never weaken `invariants` to match a regression.
