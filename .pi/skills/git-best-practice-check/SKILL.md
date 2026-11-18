---
name: git-best-practice-check
description: Interactive, user-initiated audit of a GitHub repository against the git-best-practice-check list (branch protection, Dependabot / code / secret scanning, community standards) with per-practice remediation only after an explicit yes. User-initiated only — agents must never auto-invoke it.
disable-model-invocation: true
---

# Git Best-Practice Check

Audit a GitHub repository against the practices this project defines, print a
pass/fail table with the evidence behind every verdict, then walk the failures
one at a time and remediate only the ones the user approves.

**This skill is user-initiated and interactive.** It asks questions and waits
for answers, so it cannot run in an agent/automated context. Agents must never
auto-invoke it: `disable-model-invocation` is set, and no other skill or
pipeline may call it. The only valid trigger is the user, explicitly, with one
of these phrases (or the slash invocation):

- "git best practice"
- "best practice check"
- "repo health check"
- "check best practices"
- `/git-best-practice-check`

If the user asked for something else, stop: do not run an audit to fill the gap.

## Prerequisites

- `gh` installed and authenticated with admin rights on the target repository
  (branch protection and the security settings are admin-only).
- `jq` available (used for every JSON decision).
- `supervisor.repo` set in `.pi/settings.json`, or an explicit `owner/repo`
  argument. The repository is resolved in one place only, `scripts/lib/repo.sh`.

`gh` is never called directly. All transport goes through
`scripts/lib/gateway.sh`; all status rules live in `scripts/evaluate.jq`.
Never paste a REST call into this flow — delegate to the scripts so the
read-only guarantee and the consent gate stay intact.

## The checklist

The list below is the definition of "best practice" for this project. To add or
remove a practice, edit this table **and** the matching rule in
`scripts/evaluate.jq` — the contract test asserts the two stay in sync.

| Check id                          | Practice                                                             | Evidence                                                       |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| `branch-protection`               | Default branch protected: ≥1 approving review, admins not exempt     | branch protection endpoint plus effective rules for the branch |
| `dependabot-alerts`               | Dependabot alerts enabled                                            | vulnerability-alerts endpoint status                           |
| `code-scanning`                   | Code scanning enabled (default setup, with a completed analysis run) | code-scanning default setup plus analyses                      |
| `secret-scanning`                 | Secret scanning enabled                                              | `security_and_analysis.secret_scanning.status` on the repo     |
| `community-readme`                | Community standards: README                                          | community profile, then contents lookups (symlinks included)   |
| `community-code-of-conduct`       | Community standards: code of conduct                                 | community profile, then contents lookups                       |
| `community-contributing`          | Community standards: contributing guide                              | community profile, then contents lookups                       |
| `community-license`               | Community standards: license                                         | community profile, then contents lookups                       |
| `community-security-policy`       | Community standards: security policy (SECURITY.md)                   | contents lookups at the root, `.github/` and `docs/`           |
| `community-issue-templates`       | Community standards: issue templates                                 | community profile, then `.github/ISSUE_TEMPLATE`               |
| `community-pull-request-template` | Community standards: pull request template                           | community profile, then contents lookups                       |

## Status vocabulary

| Status        | Meaning                                                                          | Remediation offered? |
| ------------- | -------------------------------------------------------------------------------- | -------------------- |
| pass          | The practice is satisfied                                                        | no                   |
| fail          | The practice is not satisfied                                                    | yes                  |
| pending       | Requested, not effective yet (async GitHub work, or a pull request not merged)   | no                   |
| not-available | The API or the plan cannot express this practice — not the user's fault          | no                   |
| unknown       | The evidence could not be read (permission/API gap) — never treated as pass/fail | no                   |

`unknown` fails closed: the audit exits non-zero, the table is still printed, and
nothing is offered for remediation.

## Phase 1 — audit (read-only)

The audit issues GET requests only. Run it and read the rows:

```bash
bash .pi/skills/git-best-practice-check/scripts/audit.sh
```

Optional flags: `--json` (machine-readable array of
`{id, practice, status, evidence, remediable}`), `--check <id>` (one practice),
`--repo owner/repo` (override `supervisor.repo`), `--settings <path>`.

Present the result as a table with one row per practice and the evidence cell
intact — the evidence is what makes the verdict auditable:

1. Show every row, not just failures.
2. Quote the evidence for each `fail` row verbatim (for example
   `required_approving_review_count=0`, `vulnerability-alerts -> 404`,
   `SECURITY.md -> 404`). Never paraphrase it into "missing".
3. Group `not-available` rows separately and say they need a plan/licence
   change, not a repo change.
4. If any row is `unknown`, say so explicitly, name the permission gap, and stop
   — do not offer remediation for the run.

Do not modify the repository during this phase.

## Phase 2 — remediation (interactive, user-gated)

Iterate the `fail` rows in checklist order. For each one:

1. Ask exactly one question and wait for the answer:

   > Remediate `<practice>`? (y/n)

   Include the evidence and what the remediation will do (which settings or
   files change, and whether it lands directly or through a pull request).

2. Answer **no** → record the practice as skipped, tell the user it was skipped,
   and continue with the next failing practice. Never re-ask.
3. Answer **yes** → run exactly one remediation for that practice:

   ```bash
   bash .pi/skills/git-best-practice-check/scripts/remediate.sh <check-id> --consent
   ```

   Add `--fullname "<holder>"` when remediating `community-license` (ask for the
   copyright holder first — the licence template needs it).

4. Re-verify: the script re-audits before writing (refusing if the practice
   changed underneath it) and re-verifies after writing. Report the printed
   transition verbatim:
   - `fail → pass` — done.
   - `fail → pending` — explain what is still outstanding (first code-scanning
     run, or a pull request waiting for merge) and that re-running the audit
     confirms it.
   - a non-zero exit — report the failing step and the API status/body from
     stderr. Do not claim success.

Order matters: one practice per invocation, one write per practice. Community
files are always written to a feature branch and opened as a pull request —
never committed to the default branch, never via a bare contents write.

## Reporting back

Close with a compact summary: how many passed, how many were remediated
(`fail → pass`), how many are pending, how many are not available on the plan,
and which ones the user skipped. For skipped practices, state the reason the
user gave (or "no reason given") — silence is not an acceptable report.

## Guardrails

- Never remediate without an explicit yes for that specific practice. Consent
  for one practice is not consent for the next.
- Never remediate a `pass`, `pending`, `not-available` or `unknown` row.
- Never write to the default branch. Never force-push. Never disable a security
  feature (this skill only enables).
- Never edit the repository's own files to satisfy the audit by hand; use the
  remediation path so the change is reviewable.
- Never report a remediation as successful when the re-verification did not say
  so.

## Self-checks

The skill ships its own tests; run them after touching any script:

```bash
bash .pi/skills/git-best-practice-check/tests/evaluate.test.sh
bash .pi/skills/git-best-practice-check/tests/scripts.test.sh
node --experimental-strip-types --test .pi/skills/git-best-practice-check/tests/skill-md.test.mts
```

`tests/evaluate.test.sh` covers the pure status rules, `tests/scripts.test.sh`
covers repository resolution, the transport gateway, the read-only audit, the
consent gate and the maintainer journey, and `tests/skill-md.test.mts` asserts
this document's contract (frontmatter, user-invocation gate, checklist parity
with `scripts/evaluate.jq`).
