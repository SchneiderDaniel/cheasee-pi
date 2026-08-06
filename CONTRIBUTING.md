# Contributing to Cheasee-Pi

Cheasee-Pi is an open-source project, and every contribution strengthens the
harness for its users. Contributions of any form are welcome — bug reports,
feature requests, documentation improvements, and code changes alike. This
guide describes the process we follow for proposing and merging changes.

## Ways to contribute

- **Reporting bugs** — Open an issue using the
  [bug report template](https://github.com/SchneiderDaniel/cheasee-pi/issues/new?template=bug_report.md).
  Reproducible steps and environment details accelerate the diagnosis
  considerably.
- **Proposing features** — Open an issue using the
  [feature request template](https://github.com/SchneiderDaniel/cheasee-pi/issues/new?template=feature_request.md).
  A clear problem statement and a description of the proposed solution
  provide the maintainers with the context required for an assessment.
- **Asking questions** — Discussions and clarifying questions belong in the
  [AgentCastle Discussions](https://github.com/SchneiderDaniel/agentcastle/discussions).
- **Submitting pull requests** — Code changes follow the workflow described
  below.

Before starting substantial work, we recommend opening an issue first. This
practice aligns the implementation with the maintainers' intentions and
prevents the disappointment of a rejected pull request.

## Getting started

1. Fork the repository on GitHub.
2. Clone the fork locally:
   ```bash
   git clone https://github.com/<your-username>/cheasee-pi.git
   cd cheasee-pi
   ```
3. Add the upstream repository for synchronization:
   ```bash
   git remote add upstream https://github.com/SchneiderDaniel/cheasee-pi.git
   ```

## Development workflow

Cheasee-Pi uses [git worktrees](https://git-scm.com/docs/git-worktree) to give
each change its own isolated working directory. This practice keeps `main`
clean and prevents parallel changes from interfering with one another.

We recommend the same workflow for external contributions:

1. Create a feature worktree from a fresh `main`:
   ```bash
   git fetch upstream
   git worktree add -b feature/my-change ../cheasee-pi-my-change upstream/main
   cd ../cheasee-pi-my-change
   ```
2. Implement the change. Commit messages follow the
   [Conventional Commits](https://www.conventionalcommits.org/) specification:
   ```bash
   git add -A
   git commit -m "feat: add new capability"
   git commit -m "fix: resolve edge case in ..."
   ```
   Common prefixes are `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, and
   `chore:`.
3. Push the branch and open a pull request:
   ```bash
   git push origin feature/my-change
   ```
4. Remove the worktree once the pull request is merged:
   ```bash
   cd ../cheasee-pi
   git worktree remove --force ../cheasee-pi-my-change
   ```

## Building and testing

All tests run with the standard Node.js test runner:

```bash
npm test
```

TypeScript validation for the extension layer runs separately:

```bash
npm run tsc:extensions
```

The full test suite executes before every merge, so we ask that contributors
run both commands locally and confirm a clean result before opening a pull
request. New logic of non-trivial complexity is expected to arrive with
corresponding tests.

## Submitting a pull request

Each pull request should satisfy the following checklist:

- The description states clearly what changed and why.
- The description references the related issue, for example `Closes #123`.
- The commit messages follow Conventional Commits.
- `npm test` passes.
- `npm run tsc:extensions` passes.
- Tests cover the changes where applicable.
- No sensitive data is committed — no secrets, credentials, or tokens.

The repository provides a
[pull request template](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.github/PULL_REQUEST_TEMPLATE.md)
that mirrors this checklist.

## Review process

Maintainers aim to review pull requests within 2-3 business days. Review
feedback arrives as comments on the pull request, and we appreciate a
responsive iteration. The `main` branch is protected; all changes merge
through the pull request workflow after the automated checks pass.

## Reporting security issues

Security vulnerabilities are handled separately and confidentially. Please do
not open a public issue for a vulnerability. The responsible disclosure
process is described in the [security policy](docs/security.md).

## Code of conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). We expect every contributor to uphold
its standards; reports of unacceptable behavior are handled promptly by the
maintainers.
