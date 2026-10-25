# Coupling record (#2032 — `199 Highly Coupled`)

The issue is filed from the CodeFlow `Architecture Issues` section and reads the
number as "199 files that import 8+ other files", prescribing a 199-file split.
That reading is wrong. This file records what the metric actually counts, what
the measurement found, the seam that prunes the edges which are not
dependencies, and what was deliberately left alone. The register and layout
follow `coupling-2002.md`, the record for the sibling issue.

## The metric

`index.html` builds the card from the connection list (pinned analyzer ref
below, `Parser.analyze`):

```js
var coupling = Object.create(null);
conns.forEach(function (c) { coupling[c.target] = (coupling[c.target] || 0) + 1; });
var highCoup = Object.entries(coupling).filter(function (x) { return x[1] > 8; });
if (highCoup.length) issues.push({ type: 'warning', title: highCoup.length + ' Highly Coupled', … });
```

So `N Highly Coupled` counts **files whose incoming resolved cross-file
identifier references exceed 8** — it is not an import count and not a fan-out
of imports. Each connection is built as

```js
conns.push({ source: def.file, target: file.path, fn: def.name, count: cnt, functionKey: def.key });
```

`source` is the file that **defines** `fn`, `target` is the file that
**references** it. Three consequences drive this change:

1. **Splitting cannot lower the number.** A split moves edges to a new file; it
   deletes none, and the child lands over the same ceiling. The measured history
   agrees: #2003 moved 101 → 116 and #2004 116 → 120, and this issue's premise
   ("reduce it by splitting") is therefore rejected in favour of the source-side
   method #2002 proved.
2. **A name with one definition repo-wide is resolved without imports.** The
   headless run has no acorn/Babel, so `Parser.findCalls` counts each identifier
   occurrence of a known name: a file that merely says `dir`, `body`, `root` or
   `state` gets an edge to the file that happens to define one.
3. **Prose and quoted examples are counted.** The same regex path reads a
   comment or a string literal as an occurrence, so an edge can exist while the
   file names the declaration nowhere executable.

(1) makes the prescribed refactor useless, (2) is only fixable by renaming in
files a compiler must verify, and (3) is what the seam below removes.

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
git ls-files -z --cached --others --exclude-standard |
  tar --null -T - -cf /tmp/new.tar && tar -x -C /tmp/src -f /tmp/new.tar
node cmd/cheasee-pi/embedded/docker/codeflow/run-analysis.mjs /tmp/src /tmp/codeflow-ui /tmp/out
```

`report.json` → `architectureIssues` holds the card; the envelope's `coupling`
holds the seam's own measurement. Both snapshots are analysed by the same pinned
analyzer, so the file-set rules are identical.

## Before / after (pinned analyzer, same snapshot method)

| Ref                        | commit / ref          | files | functions | connections | coupled | coupling term |
| -------------------------- | --------------------- | ----- | --------- | ----------- | ------- | ------------- |
| `origin/main`              | `31634233`            | 1124  | 3898      | 4368        | 163     | 1.772         |
| this branch                | `issue-2032` worktree | 1126  | 3906      | 4365        | 163     | 1.753         |
| this branch + deriver port | same tree             | 1126  | 3906      | 4365        | **143** | 1.753         |

The issue was filed with **199** at `analyzedAt` 1791804971015; the immutable
base commit measures **163** because main advanced past filing and #2002/#2003/
#2005 already removed phantoms. Acceptance is the drop on the delivered tree, as
in #2002 and #2033.

The delivered tree measures **163 → 143 (−20 files, −12.3 %)** once the seam can
re-title the card, and it drops **336 of 4365 connections** that named their
declaration nowhere outside a comment or a string literal. Without the deriver
port the seam does not run at all (see below) and the card keeps the analyzer's
own `163`: a run that pruned the edges and left the card would export a number
its own report no longer carries.

## The seam

`fp-filter.js::pruneCouplingEdges(data, { readFile })` drops a connection when
its `target` names `fn` nowhere in code — comments and string literals are
stripped first. It reads the target's own text, so it needs no parser, and it
keeps everything it cannot disprove: an edge with no `fn`, one the analyzer
built from a markdown link (`kind: "mdlink"`, whose `fn` is a title), one whose
target is unreadable, and every edge when there is no reader. It is pure,
deterministic and idempotent, and it does **not** apply the ceiling — the
threshold is the card's business, and `coupledTargetCount` measures it for the
envelope only.

`run-analysis.mjs` and the served wrapper (`ui_rewrites.py`) both apply it
against the same text, and both require the analyzer's own deriver —
`Parser.generateArchitectureIssues(data) -> issues[]` — because the card is a
count over the list being pruned. **Both or neither**: with no deriver the
connections are left as counted and the envelope reports `coupling: null`, which
is what happens today (the card is derived inline inside `Parser.analyze`). The
port is therefore an extension point: the day the analyzer exposes it, the same
run lowers the number, and `test/coupling-prune-2032.test.mts` already exercises
that path with a stub deriver. A mirrored coupling formula inside `fp-filter.js`
was rejected — that file's invariant is that analyzer rules arrive as a port.

`stats.connections` stays the analyzer's own number (4365), exactly as the
`#2002` oracle requires: report production is not gated on a re-count.

## What was left alone

- **The 199-file split** the issue prescribes. It cannot move this metric (see
  consequence 1) and would churn 133 files this issue shares with siblings 02–15.
- **The Rust UI methods** — `dir`, `body`, `root`, `state`, `status`, `event`,
  `parse`, `timeout`, `options`, `lines`, `open`, `list`, `spawn`, `keep`. They
  are the largest remaining win (~25 of the ~30 files a rename batch would
  unflag), and the pipeline image has no `cargo`, so a rename there cannot be
  compiled or tested in-gate. Deferred to a lane with the Rust toolchain.
- **Port contracts** — `config.go Path()`, `helpers_run_test.go Run()` /
  `CombinedOutput()`, `rpc/framing.rs fn clone`. The names are the interface, not
  a naming accident.
- **The phantom words the filing cites** — `must`, `only`, `export`, `try`. They
  no longer exist as declarations in the tree (re-measuring the base finds none),
  so nothing was removed and no `reducedBy` entry claims them. `try` was never
  removable: it is Python error handling in `dependency_existence_check/core.py`,
  not prose.

The one source-side change this issue carries is a P2 rename inside
`run-analysis.mjs` (`root` → `snapshotRoot`, `pending` → `pendingExport`): the
producer's two added references took it from 8 to 10 incoming connections, which
would have made it the 164th flagged file. Characterising the file that carries
a coupling fix as newly coupled is not a trade worth making.
