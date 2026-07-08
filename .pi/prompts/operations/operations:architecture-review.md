---
description: Analyze codebase architectural friction — shallow modules, leaky seams, low locality. File umbrella GitHub issue with Mermaid diagrams plus sub-issues per candidate with dependency categories and testing strategy.
---

# Architecture Review — Surface & Deepen Shallow Modules

Find shallow modules in a target codebase and propose deepening refactors. Creates an **umbrella GitHub issue** listing all candidates with Mermaid diagrams, plus one **sub-issue per candidate** with full card (dependency category, testing strategy).

Requires: `gh` CLI authenticated.

## Usage

```
/architecture-review <target>
```

| Target              | What it analyzes                                |
| ------------------- | ----------------------------------------------- |
| `root` (or omitted) | Main repo                                       |
| `<submodule-name>`  | Submodule by name (resolved from `.gitmodules`) |
| `<any-path>`        | Arbitrary directory                             |

## Workflow

### 1 — Resolve target

Extract target from message:

- `/architecture-review <target>` → use directly
- Natural language: parse "of X", "in X", "for X", or single word matching submodule name or valid path
- If nothing matches, treat as `root`

Read `.gitmodules` from project root. Parse submodules. If target matches submodule name, resolve to its `path`. Otherwise treat as relative directory. For `root`, use `.`.

### 2 — Explore codebase

Walk target with Pi tools **in this order**. Skipping `structural_search` and going straight to `read` produces a one-module audit, not an architecture review.

1. **`structural_search` — MANDATORY first pass.** Run these AST patterns before `read`ing any file:
   - Single-implementation interfaces — `interface $NAME { $$$MEMBERS }`, then `ripgrep_search` each name for implementors. One implementor + one real caller = speculative seam.
   - Factory-of-one — `function create$NAME` / `function make$NAME`. One product, no polymorphism = speculative abstraction.
   - Re-export barrels — `export { $$$NAMES } from "$SRC"`. Then check whether callers import from the barrel or reach past it to `$SRC`.
   - Classes with one call site — `class $NAME { $$$MEMBERS }`; `ripgrep_search` the class name to count constructors/users. One user = inline candidate.
   - Pass-through wrappers — `function $NAME($ARG) { return $INNER($ARG) }` (or the async variant) where the body only delegates.
2. **`ripgrep_search` — import graphs and dead-island detection.** For every suspicious symbol surfaced above, grep the bare name across the whole target. Count importers by file. The decisive test for a shallow module is its importer set: **symbol referenced only by its own file + test files = dead island.** This is hard evidence, not opinion.
3. **`read` — inspect interfaces last.** Only after steps 1-2 have named concrete suspects. Read the interface, not the whole file.
4. **`bash` — verify scale.** `wc -l`, `ls`, and `node -e "console.log(require('./package.json').dependencies)"` to confirm a "reinvented wheel" dep is actually declared (undeclared transitive deps are a finding, not a pass).

Note friction points:

- Where understanding requires bouncing between many small modules
- Where modules are **shallow** — interface nearly as complex as implementation
- Where pure functions extracted just for testability but real bugs hide in call patterns (no **locality**)
- Where tightly-coupled modules leak across **seams**
- Untested or hard-to-test interfaces
- **Reinvented wheel:** modules that reimplement what a mature (>1yr, >5k stars) OSS lib already provides. For each: flag the custom code, name the OSS alternative, estimate lines saved.

Apply **deletion test**: would deleting the module concentrate complexity or just move it? "Yes, concentrates" = signal.

### 2.5 — Evidence rule

Every claim in an issue body must cite tool output, not assertion. "`GitHubPort` has zero prod importers" is a claim; back it with the `ripgrep_search` result ("0 importers under `supervisor/pipeline/`; 2 importers, both under `test/`"). "`@octokit/*` is an undeclared dep" is a claim; back it with `node -e` on `package.json` + `package-lock.json`. A candidate filed without evidence is a guess — mark it `[Worth exploring]` at most, or drop it.

### 2.6 — Stop rule

Stop exploring once you hold 2-5 candidates with tool evidence. Over-exploring past that turns the review into a deep-dive of one codebase; the umbrella is a triage surface, not an exhaust. Suspects that fail the evidence rule do not count toward the 2-5.

### 3 — Create umbrella issue

Create one GitHub issue listing 2-5 candidates.

**Strength rule (evidence-gated):**

- **[Strong]** — deletion test passes AND evidence rule satisfied (importer counts, dep declarations, dup-LOC counts from tools). File a sub-issue.
- **[Worth exploring]** — real signal but not yet proven (deletion test ambiguous, or evidence partial). File a sub-issue only if ≤2 [Strong]
- Drop silently — no evidence and no deletion-test signal. Do not file.

File at most 5 candidates total across both strengths; 1-2 strong is a healthy review.

**Title:** `Architecture Review: <target-name> — <YYYY-MM-DD>`

**Labels:** Always `architecture`. If target is a submodule, also add submodule name as label (create with `gh label create <name>` if absent).

**Body structure:**

````markdown
## Candidates

### 1. <short title> [Strong]

**Files:** `path/to/file1.ts`

**Problem:** One sentence.
**Solution:** One sentence.
**Wins:** Bullets (≤6 words each) in glossary terms.

```mermaid
flowchart LR
  subgraph Before
    A[OrderHandler] --> B[OrderValidator]
    B -.leak.-> C[PricingClient]
  end
  subgraph After
    D[OrderModule] --> E[OrderRepo]
  end
```
````

---

### 2. <short title> [Worth exploring]

...

## Top Recommendation

**<candidate name>** — one sentence why.

```

### 4 — Create sub-issues

Per candidate, create separate GitHub issue:
- **Title:** `ICA: <candidate short title>`
- **Body:** `Part of **Architecture Review: <target-name>** (#N)` + full card from umbrella plus:
  - **Dependency category** (see below)
  - **Testing strategy** — what old tests become waste, what new tests look like
- **Labels:** same as umbrella (`architecture` + submodule name)

### 5 — Link, board, complete

1. Comment on umbrella with table linking all sub-issues
2. Add all issues to project board with status `Research` (use `gh project item-edit` or GraphQL)
3. Print all issue URLs

> Architecture review filed. Umbrella: **#N**. Sub-issues: **#A**, **#B**. Use `/issue-refinement <number>` on any candidate, then `/supervisor <number>` to implement.

## Dependency categories

When classifying candidate dependencies for sub-issue:

| Category | Meaning | Testing approach |
|----------|---------|-----------------|
| **In-process** | Pure computation, no I/O | Test through new interface directly. No adapter needed. |
| **Local-substitutable** | Dependencies with local stand-ins (PGLite, in-memory FS) | Test with stand-in. Seam internal; no port at external interface. |
| **Remote but owned (Ports & Adapters)** | Your own services across network | Define port at seam. In-memory adapter for tests, HTTP/gRPC for prod. |
| **True external (Mock)** | Third-party (Stripe, Twilio) | Injected port; mock adapter in tests. |

**Seam discipline:** One adapter = hypothetical seam. Two adapters = real seam. Don't introduce port unless ≥2 adapters justified.

**Testing strategy:** Replace, don't layer. Old unit tests on shallow modules become waste once tests at deepened interface exist — delete them.

## Diagram patterns

Pick the pattern that fits the candidate:

- **flowchart LR/TB** — call flow, dependency arrows, red dashed line for leaks
- **sequenceDiagram** — round-trip reduction
- **Cross-section** — layered shallowness (stack horizontal bands)
- **Call-graph collapse** — before/after subgraph nesting

Style: `classDef leak stroke:#dc2626,stroke-width:2px,stroke-dasharray:4 4;`

## Glossary

Use these terms exactly in every suggestion. No substitutions.

| Term | Definition |
|------|-----------|
| **Module** | Anything with an interface and an implementation |
| **Interface** | Everything a caller must know (types, invariants, error modes, ordering, config) |
| **Implementation** | The code inside |
| **Depth** | Leverage at the interface — much behaviour behind a small interface |
| **Seam** | Where an interface lives; a place behaviour can be altered without editing in place |
| **Adapter** | Concrete thing satisfying an interface at a seam |
| **Leverage** | What callers get from depth |
| **Locality** | What maintainers get from depth |
| **Deletion test** | Imagine deleting the module. If complexity vanishes it was a pass-through. If complexity reappears across callers, it earned its keep |

**Never use:** component, service, unit (for module) · API, signature (for interface) · boundary (for seam) · layer, wrapper (for module, when you mean module).

**Wins bullets** name gain in glossary terms. Write "locality: bugs concentrate in one module", not "easier to maintain".

## Tone

Lean editorial. No hedging, no throat-clearing, no "it's worth noting". Sentence → bullet if possible. Bullet → cut if possible.
```
