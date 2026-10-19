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
| scrapling | apt index, one `apt-get update` (6 files)           | 9,393,000 B       |
| scrapling | apt: python3, python3-venv, ca-certificates (31)    | 14,065,242 B      |
| scrapling | scrapling venv wheels (27)                          | 117,486,634 B     |
| scrapling | web-search venv wheels (15)                         | 12,221,184 B      |
| scrapling | Chromium 151.0.7922.34 + headless shell + ffmpeg    | 315,890,284 B     |
| **stage** | **scrapling subtotal**                              | **469,056,344 B** |
| agent     | apt index, four `apt-get update` runs               | 32,137,000 B      |
| agent     | apt: curl, gnupg, ca-certificates (37)              | 14,939,280 B      |
| agent     | NodeSource setup script + nodejs 22.x (26)          | 48,809,256 B      |
| agent     | apt: toolchain + Playwright libs (117)              | 74,161,051 B      |
| agent     | gh keyring + gh (27)                                | 37,764,747 B      |
| agent     | npm globals, Layer 5 (89 tarballs)                  | 48,092,224 B      |
| agent     | rust-analyzer 2026-08-10.1                          | 14,805,784 B      |
| agent     | rtk 0.45.0 tarball + checksums                      | 4,547,322 B       |
| agent     | osv-scanner 2.4.0                                   | 56,676,514 B      |
| agent     | Go 1.25.8 toolchain                                 | 59,786,528 B      |
| agent     | cheasee-pi clone, depth 1 (git pack)                | 3,241,906 B       |
| agent     | `npm ci` for the clone (100 tarballs)               | 26,310,517 B      |
| agent     | pi-coding-agent 1.0.2 (119 tarballs)                | 24,557,986 B      |
| **stage** | **agent subtotal**                                  | **445,830,115 B** |
| **both**  | **cold build, both stages**                         | **914,886,459 B** |

The `apt-get install` and apt-index rows are resolved against the package set
the *pinned* base image already ships, not against an empty database, so they
are what apt fetches rather than an upper bound. The seed is the base image's
own `/var/lib/dpkg/status`, pulled from its digest through the registry API (no
daemon involved), and apt is then asked what it would still download on top of
it:

```bash
# 1. unpack var/lib/dpkg/status from the pinned debian:12-slim digest
#    (manifest list -> amd64 manifest -> layer tarball)
# 2. what would that package set still have to fetch?
apt-get -o Dir::State::status=/tmp/base/var/lib/dpkg/status \
        -o Dir::State::lists=/tmp/lists -o Dir::Cache=/tmp/cache \
        -y --print-uris --no-install-recommends install <packages from the RUN>
```

The apt-index rows are apt's own report (`Fetched 9393 kB`) for one
`apt-get update` against the base image's `debian.sources`. The agent stage runs
`apt-get update` once per apt layer, so a cold build pays the index in each of
the four; with `--mount=type=cache,target=/var/lib/apt` a re-run of a busted
layer reads it locally instead. Index bytes are not free, so they are listed
rather than folded into the package rows. That is what moves the total from the
903,705,881 B of the first pass to 914,886,459 B — the earlier figure carried
bounded apt rows and no index rows at all.

The total reads ~0.91 GB against the ~1.1 GB baseline — same order, different
host and different base-image date, so compare the scenario split below, not
the two totals.

The Chromium bundle the issue quotes as ~646 MB is the two zips *unpacked*; the
transfer is 316 MB, and it now sits entirely in the `scrapling` stage.

Two of those rows were also timed while they were measured, which gives a
like-for-like throughput reference for the venv work the split moved:
`pip download` of the scrapling wheels transferred 117,486,634 B in 38 s, and
the web-search wheels 12,221,184 B in 6 s. Those are transfer times on the
measuring host, not `docker build` step times — the rest of each layer is venv
creation and unpacking.

Scenario status after the split, using the measured rows above:

| Scenario                             | Before                                    | After                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully cold (`buildx prune -af`)      | 9 min / 1.1 GB (maintainer host, measured) | 914,886,459 B of transfer for both stages, summed from the rows above; the build wall clock is `not measured` (see below)                                             |
| Agent-layer invalidation (the point) | 9 min / 1.1 GB (maintainer host, measured) | 445,830,115 B: the agent rows only. Chromium (315,890,284 B) and the venv wheels (129,707,818 B) are copied from the unchanged `scrapling` stage instead of re-fetched |
| Re-run of one busted package layer   | that layer's full fetch                   | archive reuse from the cache mounts, so the step re-runs without fetching — visible with `--progress=plain` on a busted pin                                            |

One number is deliberately still missing from this table: the post-change
**build wall clock**, which needs a Docker daemon plus the user namespaces a
rootless builder needs. The container that wrote this section has neither — no
`/var/run/docker.sock`, `id -u` reports 1000, `grep CapEff /proc/self/status`
reports `0000000000000000`, and `unshare -Ur true` fails `Operation not
permitted` — so the cell says `not measured` instead of a figure derived from
the baseline. The download volume is the half that does not need a daemon, and
it is now measured end to end: every row above is a fetch that was actually
counted, so the two subtotals and the `both` total are sums of observed values,
not bounds. Closing the wall clock takes the four commands at the top of this
section, run between a clean `buildx prune -af` and one edit to an early agent
layer; put the resulting `time` output next to the two rows above in the issue.
Cache-mount **effectiveness** is the same kind of gap — it needs one busted
package layer re-run on a real builder before/after the mounts.

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
