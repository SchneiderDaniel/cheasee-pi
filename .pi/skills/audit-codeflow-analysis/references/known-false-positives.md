# Known CodeFlow false-positive shapes

Every row here is a mechanism observed in a real run (report `workspace-bae0a78d`,
analyzed `2026-10-08T19:34:31Z`, 72 candidates, 3 real). Each shape was re-derived
from scratch by a read-only validator that then spent a full subagent run proving
the finding false. Check the finding against this table **before** reading code:
only the rows marked *text-provable* can be disproved from the finding text alone;
every other row still requires reading the cited code, but the disproof step below
is the one to run first.

| # | Finding shape | Mechanism | Disproof step |
|---|---------------|-----------|---------------|
| 1 | `HIGH: Hardcoded Secret` | The token is read from the environment (`resolveGitHubToken`). | Grep the cited line for `process.env` / `env::var`; a value sourced from the environment is not a hardcoded secret. |
| 2 | `HIGH: Hardcoded Secret` | The match is a TypeScript type union (`UsageColorToken`), not a literal value. | Read the cited type: a union of string-literal types declares allowed values, it does not embed a credential. |
| 3 | `HIGH: SQL Injection Risk` | The match is inside a comment; the cited tree contains no SQL. | Grep the cited file for an actual query/`execute(` builder — none exists, so there is nothing to inject into. |
| 4 | `HIGH: Shell Command Execution` | The flagged symbol (`Shell()`) does not exist in the cited files at all. | `structural_search` for the named symbol in the cited files; a phantom symbol is a textual coincidence. |
| 5 | `MEDIUM: Command Execution` | `spawn`/`execFile` called with an argument array and no `shell: true`. | Read the call: an argv array without `shell: true` does not invoke a shell, so no shell metacharacter is interpreted. |
| 6 | `LOW: Code Comments` | `TODO` occurs inside `grep`/`xargs` string literals in test fixtures, not in a comment. | Read the cited line: the token sits inside a quoted string (test data), not after a comment marker. |
| 7 | `LOW: Debug Statements` | `console.log(...)` text inside ast-grep pattern strings or a JSON fixture. | Read the cited line: the call text is a pattern/fixture payload, not executable debug code. |
| 8 | dead code | The function is reached indirectly — via a callback seam (`fetchFn`/`writeFileFn`) or a Rust trait method invoked from `wire()`. | Structural-search for the function name as a value passed by reference or through a trait object before calling it dead. |
| 9 | `layer-violation` | The edge pairs files in different language families (e.g. a `.ts` endpoint with a Rust `ui/src/*.rs` one); a language cannot import across that boundary, so the match is a bare identifier (`dir`, `root`, `state`). | Compare the endpoint extensions: an import-based violation only exists within one language family (`.ts`/`.mts`/`.tsx`/`.js`/`.mjs`/`.jsx` are one family). |
| 10 | coupling / dead code: phantom function | The heuristic scanner reads a bare word after `def`/`class`/`function` as a definition — a comment `class/def searches` invents a `searches` function, and a Go named result `(def string, models []string)` invents a `string` function. The phantom then collects one `connection` from every mention of that word (removing it dropped #1995's pinned tree by 322 connections, 3500 → 3178, and one declared function, 3523 → 3522). It does **not** enter the dead-code list: because it has those many resolved callers, #1995 measured `dead` unchanged at 45 with and without it. | `structural_search` for the symbol's declaration: a "function" whose name is a builtin type (`string`, `int`) or whose only occurrence is inside a comment/string has no body — it is a scanner artifact, not code. Convert Go named results to unnamed ones to drop it. |
| 11 | dead code: ambient/type declaration | The scanner extracts ambient module members (`declare module "x" { function f(): void }`) as "functions" with no runtime body, so an unused-but-declared third-party API surface looks like dead code. #1995 measured four such declarations in `.pi/extensions/lib/proper-lockfile-ambient.ts` counted as `dead`; they are kept, not deleted. | Read the declaration: a member inside `declare module`/`declare global`/a `.d.ts` with no body is type-only. It is not executable code, so removing it moves the count without deleting a function. |

Text-provable (auto-suppressed before validation, per `classifyKnownNoise`):
rows 6, 7 and 9, plus any fact whose every cited file is unresolved. Everything else
is a code-read shape: the validator gets it and proves it here, never a text filter.

Rows 1-4 are also suppressed deterministically at the producer: the headless
runner and the served page both pass the analyzer's `data` through
`fp-filter.js`, which drops HIGH findings citing an empty or comment-only
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

Per-issue verdict lists that applied these rows, with the pinned-analyzer
measurement behind them, live in `references/coupling-deadcode-1995.md`
(coupling unit and before/after, plus the row-8/row-10 verdict for every dead
candidate). Row 11 records the ambient-declaration shape #1995 reverted.
