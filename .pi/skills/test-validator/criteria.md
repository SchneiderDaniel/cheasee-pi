# Test-validator criteria

What makes one automated test worth keeping. The judge is given this file and
one test at a time; every verdict must cite criterion ids from this list, and a
`BAD` verdict must cite at least one of **C1**, **C2**, or **C3**.

A test is **BAD** only when the evidence clearly shows that it has no meaningful
project-specific regression or contract value. When the slice alone cannot
settle the question, the answer is `AMBIGUOUS` and the test stays undecided — it
is never guessed into `BAD`.

## C1 — Project-owned behaviour (BAD-qualifying)

The test exercises behaviour this repository owns: its domain rules, parsing,
validation, orchestration, adapters, or contract with an external system.

BAD when the test only verifies behaviour of the language, the runtime, a test
framework, or a third-party library. A test that asserts `Map.get` returns what
was just set, that `JSON.parse` round-trips a literal, or that an assertion
library throws on a false assertion is exercising someone else's contract.

## C2 — Meaningful observable assertion (BAD-qualifying)

The test asserts an observable outcome of the unit under test: a returned value,
a persisted state, an emitted event, or a documented error.

BAD when the only assertion restates an input literal (`assert.equal(1, 1)`),
asserts truthiness of something that cannot be false, asserts the mock it just
configured, or contains no assertion at all and cannot fail.

## C3 — Relevant behaviour or contract coverage (BAD-qualifying)

The test covers a behaviour that the project depends on: a documented contract,
a bug that was fixed, a branch that carries meaning, or a boundary the code
promises to honour.

BAD when the test covers nothing anyone relies on — for example it asserts an
implementation detail that no caller can observe, or it duplicates another
test's contract exactly while adding no case of its own.

## C4 — Clarity (never BAD-qualifying alone)

The test's purpose is readable from its name and body, and a failure points at
the broken behaviour. Unclear names, hidden helper logic, and opaque fixtures are
weaknesses worth reporting, but _style alone never makes a test bad_.

## C5 — Reliability appropriate to scope (never BAD-qualifying alone)

The test is deterministic for its size: no wall-clock dependence, no ordering
dependence between tests, no network in a unit test, no shared mutable state.
Flakiness and external dependencies are risks worth reporting, but an
integration test that legitimately uses a database or a file system is not bad
for that reason.

## C6 — Distinct regression signal (never BAD-qualifying alone)

The test would fail if the behaviour it describes broke, and no other test
already reports the same break in the same way. Overlap is normal in a large
suite; duplication is only a BAD-qualifying defect when the test contributes no
distinct case (C3) or asserts nothing of its own (C2).

## C7 — Appropriate observation level (never BAD-qualifying alone)

The test observes behaviour at a level that makes it stable: public API and
state rather than private methods and internal call order, with interaction
assertions only where the interaction _is_ the contract.

Testing a private helper directly, or asserting an exact sequence of internal
calls, is a brittleness smell — sufficient for a comment, not for `BAD`.

## Not grounds for BAD

Each of the following is at most a note, never a BAD verdict:

- Test style, naming, or formatting preferences.
- Low code coverage of the surrounding file.
- Overlap or duplication with another test, when this test still asserts a
  distinct observable outcome.
- Broad scope: an end-to-end or integration test is not bad for being broad.
- External dependencies: a database, a file system, a subprocess, or a local
  server used by a test that is legitimately at that level.
- Slow runtime, when the test's scope justifies it.
- The absence of mocks, or the presence of them.

## Evidence rules

A `BAD` verdict must quote the slice verbatim: at least one `evidence` entry
whose `quote` is an exact substring of the judged lines and whose `line` falls
inside the judged range. Confidence must be at least `badConfidenceThreshold`
(0.8 by default). Providing a criterion outside C1–C7, a quote that does not
match, or a quote from a neighbouring test leaves the verdict `PENDING`.

## Sources

These are the references the criteria are distilled from. Quotes are verbatim.

**Google, _Software Engineering at Google_, Chapter 12, "Unit Testing"**
(<https://abseil.io/resources/swe-book/html/ch12.html>)

> After preventing bugs, the most important purpose of a test is to improve
> engineers' productivity.

> … _the ideal test is unchanging_: after it's written, it never needs to change
> unless the requirements of the system under test change.

> By far the most important way to ensure this is to write tests that invoke the
> system being tested in the same way its users would; that is, make calls
> against its public API rather than its implementation details.

> A clear test is one whose purpose for existing and reason for failing is
> immediately clear to the engineer diagnosing a failure.

> A behavior is any guarantee that a system makes about how it will respond to a
> series of inputs while in a particular state.

**Google Testing Blog, "Test Sizes"**
(<https://testing.googleblog.com/2010/12/test-sizes.html>)

> Over time we've come to agree on a set of data-driven naming conventions for
> our tests. We call them "Small", "Medium" and "Large" tests.

The post's table classifies those sizes by what a test may touch — network
access is `No` for Small and allowed for Large — which is why C5 judges
reliability _relative to the test's scope_ instead of demanding isolation
everywhere.

**Microsoft Learn, "Unit testing best practices for .NET"**
(<https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices>)

> **Self-Checking**: The test should automatically detect if it passed or failed
> without any human interaction.

> The name of your test should consist of three parts: Name of the method being
> tested; Scenario under which the method is being tested; Expected behavior
> when the scenario is invoked

> A high code coverage percentage isn't an indicator of success, and it doesn't
> imply high code quality.

**Martin Fowler / Ham Vocke, "The Practical Test Pyramid"**
(<https://martinfowler.com/articles/practical-test-pyramid.html>)

> Don't reflect your internal code structure within your unit tests. Test for
> observable behaviour instead.

> You won't gain anything from testing simple _getters_ or _setters_ or other
> trivial implementations (e.g. without any conditional logic).

> Write tests with different granularity. The more high-level you get the fewer
> tests you should have.

Synthesis: C1/C2/C3 carry the three independent ways a test can be worthless —
it tests someone else's code, it asserts nothing observable, or it guards
nothing the project depends on. C4–C7 carry the maintainability advice
(clarity, reliability-for-size, distinctness, observation level) that shapes a
review comment but must not, on its own, delete a test.
