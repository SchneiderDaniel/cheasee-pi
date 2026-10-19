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
   the stage split this re-downloaded the Chromium bundle (~646 MB unpacked);
   now the venvs and the browser come from the unchanged `scrapling` stage.

Cache mounts (`RUN --mount=type=cache`) are only visible in the _re-run_ case:
bust one package layer (edit a version pin), rebuild with
`--progress=plain`, and confirm the apt/npm/pip step reports no downloads.
A cold build still fetches — the digest pins and the `scrapling` stage are what
keep that fetch out of the agent stage's dependency chain.

### Recorded numbers for issue #2053

**Baseline, measured on the maintainer host** before the stage split, cold
rebuild of the agent image with only one layer cache-hit: **~9 min and ~1.1 GB
transferred**. Per layer, from `--progress=plain`: `#12` NodeSource 97.9 s,
`#13` apt toolchain 55.9 s, `#14` GitHub CLI 17.4 s, `#15` npm globals 34.8 s,
`#16` rust-analyzer 10.0 s, `#17` rtk 4.1 s, `#18` web-search venv 18.8 s /
12 MB, `#29` scrapling venv 55.6 s / 113 MB, `#31` Chromium 100.5 s /
~646 MB, `#84` pi install 23.1 s.

**Post-change transfer volume, measured** by pulling the total size of every
artifact the two stages fetch at this commit. A one-byte range request reports
the full size in `content-range`, which works for the npm registry, GitHub
release assets, `cdn.playwright.dev` and `go.dev` alike; package sets come from
`apt-get --print-uris`. No daemon is involved, so the table reproduces on any
machine with network access:

```bash
# total bytes of one artifact, no daemon needed
curl -sSL -r 0-0 -D - -o /dev/null "$URL" | tr -d '\r' |
  awk 'tolower($1) == "content-range:" { sub(/.*\//, ""); print }'
```

| Stage     | Artifact                                            | Measured transfer |
| --------- | --------------------------------------------------- | ----------------- |
| scrapling | apt: python3, python3-venv, ca-certificates (50)    | 21,639,628 B      |
| scrapling | scrapling venv wheels (27)                          | 117,486,634 B     |
| scrapling | web-search venv wheels (15)                         | 12,221,184 B      |
| scrapling | Chromium 151.0.7922.34 + headless shell + ffmpeg    | 315,890,284 B     |
| agent     | apt: curl, gnupg, ca-certificates (90)              | 38,632,856 B      |
| agent     | NodeSource nodejs 22.x (46)                         | 56,992,352 B      |
| agent     | apt: toolchain + Playwright libs (153)              | 87,431,716 B      |
| agent     | GitHub CLI 2.102.0                                  | 15,392,446 B      |
| agent     | npm globals, Layer 5 (89 tarballs)                  | 48,092,224 B      |
| agent     | rust-analyzer 2026-08-10.1                          | 14,805,784 B      |
| agent     | rtk 0.45.0 tarball + checksums                      | 4,547,322 B       |
| agent     | osv-scanner 2.4.0                                   | 56,676,514 B      |
| agent     | Go 1.25.8 toolchain                                 | 59,786,528 B      |
| agent     | cheasee-pi clone, depth 1 (git pack)                | 3,241,906 B       |
| agent     | `npm ci` for the clone (100 tarballs)               | 26,310,517 B      |
| agent     | pi-coding-agent 1.0.2 (119 tarballs)                | 24,557,986 B      |
| **both**  | **cold build, both stages**                         | **903,705,881 B** |

The four apt rows are `--print-uris` against an *empty* package database, so
they bound the download from above: `debian:12-slim` already ships part of that
closure, and the real apt figure is smaller by however much of it the base
provides. The total therefore reads ~0.90 GB against the ~1.1 GB baseline —
same order, different host and different base-image date, so compare the
scenario split below, not the two totals.

The Chromium bundle the issue quotes as ~646 MB is the two zips *unpacked*; the
transfer is 316 MB, and it now sits entirely in the `scrapling` stage.

Two of those rows were also timed while they were measured, which gives a
like-for-like throughput reference for the venv work the split moved:
`pip download` of the scrapling wheels transferred 117,486,634 B in 38 s, and
the web-search wheels 12,221,184 B in 6 s. Those are transfer times on the
measuring host, not `docker build` step times — the rest of each layer is venv
creation and unpacking.

Scenario status after the split, using the measured rows above:

| Scenario                             | Before                                    | After                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully cold (`buildx prune -af`)      | 9 min / 1.1 GB (maintainer host, measured) | 0.90 GB of artifact transfer across both stages (measured rows above, apt as upper bounds); the build wall clock is labelled below                                      |
| Agent-layer invalidation (the point) | 9 min / 1.1 GB (maintainer host, measured) | 0.44 GB: the agent rows only. Chromium (0.32 GB) and the venv wheels (0.13 GB) are copied from the unchanged `scrapling` stage instead of re-fetched                  |
| Re-run of one busted package layer   | that layer's full fetch                   | archive reuse from the cache mounts, so the step re-runs without fetching — visible with `--progress=plain` on a busted pin                                             |

Two things are deliberately not in this table. The post-change **build wall
clock** is still owed: it needs a Docker host, and the pipeline container that
wrote this section has neither a daemon nor the user namespaces a rootless
builder needs, so it is marked `not measured` rather than derived from the
baseline. Cache-mount **effectiveness** likewise needs a real re-run of a
busted layer. Both close with the four commands at the top of this section, run
between a clean `buildx prune -af` and one edit to an early agent layer — and
the 0.44 GB row is a sum of the measured rows above, not a timed build.

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
