---
layout: default
title: Development Guide
nav_order: 12
---

# Development Guide

Cheasee-Pi combines a Go CLI, TypeScript Pi extensions, and an embedded Rust
control-center service. We use the commands and source map below to make
changes in the correct component and validate the affected behavior.

## Source map

| Path                                 | Component                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `cmd/cheasee-pi/`                    | Go CLI, command tests, and helpers.                                                        |
| `cmd/cheasee-pi/embedded/`           | Resources embedded into the CLI binary, including the Docker stack and workspace scaffold. |
| `cmd/cheasee-pi/embedded/docker/ui/` | Rust/Axum web control-center service and its tests.                                        |
| `.pi/extensions/<name>/`             | TypeScript Pi extension and extension-local tests.                                         |
| `.pi/extensions/lib/`                | Shared TypeScript extension helpers; this directory is not an extension.                   |
| `docs/`                              | Jekyll documentation site, with extension guides in `docs/extensions/`.                    |
| `test/`                              | Repository-level Node.js tests and documentation or workflow guards.                       |

Pi extensions are loaded from `.pi/extensions/`. Changes to embedded Docker
resources must also be tested through the Go CLI, because the CLI extracts
those resources from its compiled binary.

## Validation commands

The primary local checks are:

```bash
npm test
npm run tsc:extensions
go test ./cmd/cheasee-pi/ -count=1
```

`npm test` runs the extension and repository Node.js tests. The TypeScript
check validates extension types. The Go test suite covers CLI behavior and
includes documentation consistency checks for the command reference. CI also
runs shell and Python tests, plus a standalone Node.js test:

```bash
bash test/no-submodules.test.sh
bash test/uninstall-script.test.sh
python3 test/dependency-existence-check.test.py
python3 test/dependency-existence-check-refactor.test.py
node --experimental-strip-types --test docker/test/unbreak-worktrees.test.mts
```

The CLI build check is `go build ./cmd/cheasee-pi/` or `make build`. The
standard Go test command does not run Docker-backed integration tests. Those
tests require a working Docker Engine and use an explicit integration build
tag. The Rust UI service test suite runs during its Docker image build.

## Measuring image build cost

The image build is download-heavy, and a populated builder cache hides almost
all of it. Quote numbers only from a cold build:

```bash
docker buildx prune -af                      # drop the builder cache = the cold case
time cheasee-pi build                       # build time
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep cheasee-pi
docker system df -v                         # total data-root occupancy
```

Re-run the same four commands after a change and record both sides in the
issue. The build cache is per-builder and evictable, so `docker buildx prune`,
a builder switch, or a full data root all reproduce the cold case.

Two scenarios have to be recorded separately, because they answer different
questions:

1. **Fully cold** (`buildx prune -af`): every archive is fetched, so this
   number does not improve. `docker buildx du` right after the build reports
   the cache it populated — a pruned cache before means that total is what the
   build downloaded.
2. **Agent-layer invalidation** — the case this work is about: with a warm
   cache, change one early agent layer (add a package to an `apt-get install`
   line), then time `cheasee-pi build` and re-read `docker buildx du`. Before
   the stage split this re-downloaded the ~646 MB Chromium bundle; now the venvs
   and the browser come from the unchanged `scrapling` stage.

Cache mounts (`RUN --mount=type=cache`) are only visible in the *re-run* case:
bust one package layer (edit a version pin), rebuild with
`--progress=plain`, and confirm the apt/npm/pip step reports no downloads.
A cold build still fetches — the digest pins and the `scrapling` stage are what
keep that fetch out of the agent stage's dependency chain.

Baseline recorded for issue #2053 (maintainer host, cold rebuild of the agent
image, only one layer cache-hit): ~9 min and ~1.1 GB, of which the Chromium
bundle is ~646 MB / 100 s and the two pip venvs are 113 MB + 12 MB of wheels /
~56 s. Those two steps are what the `scrapling` stage now owns, so an agent
layer change re-fetches neither. Re-measure on a Docker host — a container
without a daemon cannot produce the wall clock — and record both sides in the
issue.

## Documentation changes

We keep user documentation alongside its implementation:

- CLI commands and flags belong in [CLI Reference](cli.md). Go tests check key
  command and behavior claims against the CLI.
- Workspace settings belong in [Configuration](configuration.md), while
  installation and operational workflows belong in [Installation](installation.md)
  and [Daily Usage](daily-usage.md).
- Extension behavior belongs in the extension-specific page under
  `docs/extensions/`; the inventory belongs in [Extensions](extensions.md).
- Contributor setup and pull-request policy belong in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).

The site source uses Jekyll and the Just the Docs theme. With the dependencies
from `docs/Gemfile` installed, a local preview is available with:

```bash
cd docs
bundle exec jekyll serve
```

## Pull requests

We keep changes isolated on a feature branch or worktree and submit them as a
pull request. Each pull request includes the reason for the change, relevant
tests, and documentation updates when user-visible behavior changes. The
repository's [contribution guide](../CONTRIBUTING.md) describes the review and
security-reporting process.
