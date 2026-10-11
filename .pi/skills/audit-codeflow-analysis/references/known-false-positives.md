# Known CodeFlow false-positive shapes

Every row here is a *mechanism* observed in a real run: the analyzer mis-fires the
same way in every repository, only the instances differ. So each row states the
mis-fire shape and the one disproof step that settles it, and the rule instances
are written as shapes (`spawn(\w+, [`, `shell:\s*true`, `declare module`), never
as a path, symbol, owner or snapshot of one analyzed repository. Concrete
instances of the runs behind these rows live only under
[Verified instances](#verified-instances).

Check the finding against this table **before** reading code: only the rows marked
*text-provable* can be disproved from the finding text alone; every other row still
requires reading the cited code, but the disproof step below is the one to run
first.

A row that carries a **rule id** is also applied by the deterministic pre-filter
(`lib/fast-path.ts`, run by `scripts/validate-finding.sh` before the subagent). That
filter can only ever emit `VERDICT: INVALID`; its rules require the *complete*
disproof context below, and anything unmatched, ambiguous or unreadable falls
through to the LLM validator — so a `VALID` verdict is always the subagent's.

| # | Rule id | Finding shape | Mechanism | Disproof step |
|---|---------|---------------|-----------|---------------|
| 1 | – | `HIGH: Hardcoded Secret` | The token is read from the environment at runtime. | Grep the cited line for the environment read (`process.env`, `env::var`); a value sourced from the environment is not a hardcoded secret. |
| 2 | – | `HIGH: Hardcoded Secret` | The match is a string-literal type union, not a value. | Read the cited type: a union of string-literal types declares allowed values; it does not embed a credential. |
| 3 | – | `HIGH: SQL Injection Risk` | The match sits inside a comment and the cited tree contains no SQL. | Grep the cited file for an actual query builder — none exists, so there is nothing to inject into. |
| 4 | – | `HIGH: Shell Command Execution` | The flagged symbol does not exist in the cited files at all. | Search the cited files for the named symbol: a phantom symbol is a textual coincidence. |
| 5 | `argv-array-no-shell` | `MEDIUM: Command Execution` | `spawn`/`execFile` called with an argument array and no `shell: true`. | Read the call: an argv array without `shell: true` does not invoke a shell, so no shell metacharacter is interpreted. An argv call in a file that also contains a `shell: true` option or a shell-string `exec` is *not* disproved this way. |
| 6 | – | `LOW: Code Comments` | `TODO` occurs inside a quoted string (test data), not in a comment. | Read the cited line: the token sits inside a quoted string, not after a comment marker. |
| 7 | – | `LOW: Debug Statements` | A `console.log(...)` text inside an `ast-grep` pattern string or a JSON fixture. | Read the cited line: the call text is a pattern/fixture payload, not executable debug code. |
| 8 | `indirect-dispatch` | dead code | The function is reached indirectly — passed by reference through a callback seam, or dispatched through a trait/dispatch seam such as `wire()`. | Structural-search the function name and look for the *non-declaration* reference: a name that appears in value/argument position, or on a dispatch/registration line, is reached indirectly and is not dead. A name that only appears in its own declaration is not disproved this way. |
| 9 | – | `layer-violation` | The edge pairs files in different language families — one language cannot import across that boundary, so the match is a bare identifier. | Compare the endpoint extensions: an import-based violation only exists within one language family (`.ts`, `.mts`, `.tsx`, `.js`, `.mjs`, `.jsx` are one family). |
| 10 | `phantom-symbol` | coupling / dead code: phantom function | The heuristic scanner reads a bare word after `def`/`class`/`function` as a declaration, so a phrase inside a comment or a string literal invents a function; a named-result type annotation (`func f() (name string)`) invents one named after a builtin type. | Search for the symbol's declaration: a "function" whose name is a builtin type, or whose only occurrences sit inside comments/strings, has no body — it is a scanner artifact, not code. Convert named results to unnamed ones to drop it. |
| 11 | `ambient-type-only-member` | dead code: ambient/type declaration | The scanner extracts ambient module members (a `declare module`/`declare global` member, or anything in a `.d.ts`) as "functions" with no runtime body, so an unused-but-declared third-party API surface looks like dead code. | Read the declaration: a member inside `declare module`/`declare global`/a declaration file with no body is type-only. It is not executable code, so removing it moves the count without deleting a function. |
| 12 | `suggestion-derived-fact` | `suggestion` | The item is a derived observation with no defect behind it. | Read the title: nothing in the code has to change for it, so there is nothing to remediate (the same reason the validator's own rule gives for a descriptive finding). |
| 13 | `zero-file-derived-fact` | any derived metric with no file and no symbol target | The item is a computed count (size, coupling, complexity), not a located defect. | Check the targets: no path and no locatable symbol means no code can confirm or refute it, so there is nothing to remediate. A target that is a path, a symbol or a layer edge is *not* this shape. |
| 14 | `duplicate-same-name` | `Same Name` duplicate | The same member name is declared by two distinct enclosing types; per-type methods of the same name are intentional, not duplicated code. | Attribute each declaration to its enclosing type: two or more distinct owners means separate implementations. One owner, or an owner that cannot be attributed, is not disproved this way. |
| 15 | `similar-code-cross-family` | `Similar Code` duplicate | The "duplicate" cluster is a textual similarity across unrelated code: members in different language families, or members that are test-fixture material only. | Compare the members: a cluster spanning two language families cannot be one copied implementation, and a cluster matching only inside test fixtures is fixture data. A single-family cluster of production files is not disproved this way — semantic unrelatedness needs the model, so it defers. |

Text-provable (auto-suppressed before validation, per `classifyKnownNoise`):
rows 6, 7 and 9, plus any fact whose every cited file is unresolved. Everything else
is a code-read shape: the validator gets it and proves it here, never a text filter.

Rows 1-4 are also suppressed deterministically at the producer: the headless
runner and the served page both pass the analyzer's `data` through the producer's
filter, which drops HIGH findings citing an empty or comment-only
snippet, a string-literal type union, an env-resolved value, or a symbol absent
from the cited file, and layer violations whose endpoints cannot import each
other (different extensions, no recorded connection) or whose layer label the
endpoint path does not carry as a directory — CodeFlow's `utils` fallback and
loose substrings (`/handler` -> `services`) name layers this repository does not
define. Those shapes therefore no longer reach this validator — a row 1-4 fact
that does appear here means the filter missed it, which is the bug to fix.

Scope (is this a bug or a chore/refactor?) is decided before validation by
`classifyFinding` in `lib/report.ts`, never here — so no row in this table uses
"it is only a size/count metric" as a disproof.

## Verified instances

Concrete instances of the rows above, from the runs that produced them. They are
kept out of the table on purpose: a rule keyed on a path or a symbol would stop
matching the next repository.

- Source run: report `workspace-bae0a78d`, analyzed `2026-10-08T19:34:31Z`,
  72 candidates, 3 real.
- The producer filter that suppresses rows 1-4 is `fp-filter.js`, applied both by
  the headless runner and by the served page.
- Row 1 (`resolveGitHubToken`): a token read from the environment at runtime.
- Row 2 (`UsageColorToken`): a `"success" | "warning" | "error"` union in
  `.pi/extensions/context-info/types.ts`.
- Row 4 (`Shell()`): a flagged symbol absent from the cited files.
- Row 8 (`fetchFn`, `writeFileFn`): functions reached only as callback values.
- Row 10 (`class/def searches`, `string`, `connection`): a phantom invented from a
  comment phrase, and one from the Go named result `(def string, models
  []string)`. Removing the phantom dropped #1995's pinned tree by 322
  connections (3500 → 3178) and one declared function (3523 → 3522); it did not
  enter the dead-code list, so #1995 measured `dead` unchanged at 45 with and
  without it.
- Row 11 (`proper-lockfile-ambient.ts`): four bodyless declarations in
  `.pi/extensions/lib/proper-lockfile-ambient.ts` counted as `dead`; #1995
  reverted their deletion.
- Row 14/15 (`execFn`): same-named members on distinct types, and look-alike
  blocks that share no implementation.

Per-issue verdict lists that applied these rows, with the pinned-analyzer
measurement behind them, live in `references/coupling-deadcode-1995.md`
(coupling unit and before/after, plus the row-8/row-10 verdict for every dead
candidate). Row 11 records the ambient-declaration shape #1995 reverted.
