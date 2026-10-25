# Coupling record (#2032 — `199 Highly Coupled`)

The issue is filed from the CodeFlow `Architecture Issues` section and reads the
number as "199 files that import 8+ other files", prescribing a 199-file split.
That reading is wrong. This file records what the metric actually counts, the
two measurements, the source-side levers that moved the delivered number, and
what was deliberately left alone. The register and layout follow
`coupling-2002.md`, the record for the sibling issue.

## The metric

`index.html` builds the card from the connection list (pinned analyzer ref
below, inside `buildAnalysisData`):

```js
var coupling = Object.create(null);
conns.forEach(function (c) { coupling[c.target] = (coupling[c.target] || 0) + 1; });
var highCoup = Object.entries(coupling).filter(function (x) { return x[1] > 8; });
if (highCoup.length) issues.push({ type: 'warning', title: highCoup.length + ' Highly Coupled', … });
```

So `N Highly Coupled` counts **files whose incoming resolved cross-file
identifier references exceed 8** — it is not an import count and not a fan-out
of imports, whatever the card's own description says. Each connection is built
as

```js
conns.push({ source: def.file, target: file.path, fn: def.name, count: cnt, functionKey: def.key });
```

`source` is the file that **defines** `fn`, `target` is the file that
**references** it. Three consequences drive this change:

1. **Splitting cannot lower the number.** A split moves edges to a new file; it
   deletes none, and the child lands over the same ceiling. The measured history
   agrees: #2003 moved 101 → 116 and #2004 116 → 120, so the issue's premise
   ("reduce it by splitting") is rejected in favour of the source-side method
   #2002 proved.
2. **A name with one definition repo-wide is resolved without imports.** The
   headless run has no acorn/Babel, so `Parser.findCalls` counts identifier
   occurrences of a known name: a file that merely says `dir`, `body`, `root` or
   `state` gets an edge to the file that happens to define one.
3. **Prose and quoted examples are counted.** The same regex path reads a
   comment or a string literal as an occurrence, so an edge can exist while the
   file names the declaration nowhere executable.

(1) makes the prescribed refactor useless. (2) is only fixable by renaming where
a compiler can verify the rename. (3) is the lever this change uses: an edge
whose only mention is a comment disappears when the comment stops spelling the
name, and the name is still free to mean what it meant.

## Reproduction

```bash
git clone --depth 1 https://github.com/braedonsaunders/codeflow /tmp/codeflow-ui
git -C /tmp/codeflow-ui fetch --depth 1 origin b0e82d127fc4990f571ebc6da6c5d9af2591aaa1
git -C /tmp/codeflow-ui checkout --detach FETCH_HEAD

# the base tree is a commit, so git archive snapshots it
rm -rf /tmp/src && mkdir -p /tmp/src
git archive 31634233732a4721ab8db85f6c1a737582f1c5e1 | tar -x -C /tmp/src
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/src /tmp/codeflow-ui /tmp/out

# the delivered tree is a branch, so it is snapshotted the same way from the
# working tree (a branch has no commit id until the pipeline commits it)
rm -rf /tmp/new && mkdir -p /tmp/new
git ls-files -z --cached --others --exclude-standard |
	tar --null -T - -cf /tmp/new.tar && tar -x -C /tmp/new -f /tmp/new.tar
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/new /tmp/codeflow-ui /tmp/out
```

`report.json` → `architectureIssues` holds the card, the envelope holds `stats`
and the derived `terms`. Both snapshots are analysed by the same pinned
analyzer, so the file-set rules are identical. Run the base first and the branch
second; the counts below are reproducible from those two commands alone.

## Before / after (pinned analyzer, same snapshot method)

| Ref           | commit / stamp                             | files | functions | connections | coupled | coupling term |
| ------------- | ------------------------------------------ | ----- | --------- | ----------- | ------- | ------------- |
| `origin/main` | `31634233732a4721ab8db85f6c1a737582f1c5e1` | 1124  | 3898      | 4368        | 163     | 1.772         |
| this branch   | `91cbfd55c4f8038c8266c84128eeb9eaaf5d3a42` | 1126  | 3898      | 4340        | **155** | 1.709         |

The issue was filed with **199** at `analyzedAt` 1791804971015; the immutable
base commit measures **163** because main advanced past filing and
#2002/#2003/#2005 already removed phantoms. Acceptance is the drop on the
delivered tree, as in #2002 and #2033.

**163 → 155 (−8 files, −4.9 %) and 4368 → 4340 connections (−28).** The eight
files the drop accounts for are listed in `after.unflagged` of
`test/fixtures/coupling-baseline-2032.json`; nothing became newly flagged. Two
of them are Rust test modules (`controls.rs`, `stream/tests_rows.rs`) that fell
because the TS declaration they kept mentioning is gone — no Rust was edited.

## What moved the number

Each `reducedBy` entry in the fixture names the file, the tokens it stopped
spelling, and why. Two shapes:

- **A prose mention of a single-definition name** — `repoRoot`/`gitCommand`
  (`build_test.go`), `guard`/`list` (`ensureVenv-errors.test.ts`), `stage`
  (`status-resolution.ts`), `parse`/`none` (`report.ts`), `runInit`
  (`init_auth.go`), `open` (`merge-gate.ts`). The declarations stay; only the
  comment or log wording changes, so no behaviour changes.
- **A declaration whose name is a plain English word** —
  `ErrorCollector.all` → `allRecords`. The two getters were the only `all`
  declaration in the tree, so every file that used the word casually carried an
  edge.

`test/coupling-2032.test.mts` replays the record: it recomputes the digest over
the reduced files, asserts no `reducedBy` token survives in its file (the
analyzer cannot resolve a name the file no longer contains), asserts no file
became newly flagged, and asserts the producer carries no second
implementation of the metric.

## The prune seam that was tried and removed

The first attempt at this issue pruned non-dependency edges out of
`data.connections` before the report was captured (`fp-filter.js::
pruneCouplingEdges`, wired into `run-analysis.mjs` and the served wrapper). It
was removed, for two reasons that both survive inspection:

1. **It could never run in production.** The card is derived inline inside
   `buildAnalysisData` (`index.html:5382`), and the pinned analyzer exposes no
   deriver to re-title it. Pruning the list without re-deriving the card would
   export a count its own report no longer carries, so the seam had to fail
   closed — which made the delivered number unchanged (163 → 163).
2. **Its edge predicate under-counted real dependencies.** It asked whether the
   target file names `fn` outside comments and string literals, using a
   language-agnostic stripper. That stripper reads a JS template interpolation
   (`${render()}`) as literal text, a Rust `'a` lifetime or `char` literal as a
   string, and a Go raw string or a Python triple-quoted docstring as one blob —
   each of which silently drops edges that are genuine dependencies. Under-
   counting coupling is worse than the noise it was filtering: two real callers
   (`fp-filter.js` property reads, `codeflow_shim_fp_filter_test.go`'s embedded
   scripts) were already misread as prose in the measurement runs.

A correct version needs a language-aware predicate upstream of the report (the
analyzer's tree-sitter path) or an architecture deriver it can re-title with;
both are analyzer-side changes, recorded under `deferred`.

## What was left alone

- **The 199-file split** the issue prescribes. It cannot move this metric (see
  consequence 1) and would churn 133 files this issue shares with siblings
  02–15.
- **The Rust UI methods** — `dir`, `list`, `open`, `keep`, `failed`, `timeout`,
  `root`, `state`, `status`, `event`, `parse`, `spawn`, `body`, `next_record`.
  They are 177 of the 322 non-code edges the same predicate still finds across
  the delivered snapshot, and the
  pipeline image has no `cargo`, so a rename there cannot be compiled or tested
  in-gate. Deferred to a lane with the Rust toolchain.
- **Port contracts** — `config.go Path()`, `helpers_run_test.go Run()` /
  `CombinedOutput()`, `rpc/framing.rs fn clone`, `proper-lockfile-ambient.ts`
  `lock` / `check`. The names are the interface, not a naming accident.
- **Exported `.ts` domain words** — `timeout`, `check`, `cleanup`, `install`,
  `supervisor`, `runAgentLoop`: 80 remaining edges, and each removal means
  renaming exported surface and every caller for one unflagged file.
- **The phantom words the filing cites** — `must`, `only`, `export`, `try`. They
  no longer exist as declarations in the tree (re-measuring the base finds
  none), so nothing was removed and no `reducedBy` entry claims them. `try` was
  never removable: it is Python error handling, not prose.
- **Test-only `.mts` files.** `Parser.codeExts` has no `.mts`, so nothing there
  is ever scored and no reduction is claimed from it.
