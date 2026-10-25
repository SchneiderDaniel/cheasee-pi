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

Without a daemon, `bash scripts/measure-cold-build.sh` measures the transfer
half of the same build: it replays the Dockerfile's download steps against the
pinned base image, counts every byte at a local proxy and times each step. It
is a **lower bound**, not a substitute for the four commands above — it cannot
commit layers, pull the base image or run `dpkg`, and §Recorded numbers below
keeps the two measurements in separate rows for that reason.

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

**After — two measurements, kept apart on purpose.** A replay is not a Docker
build, so neither is quoted as the other:

- the table below is a _replay_: `scripts/measure-cold-build.sh` runs the
  Dockerfile's download steps — the same apt, pip, npm and curl layers, in the
  same order, against the same pinned base image — unprivileged, with a local
  proxy counting every byte that leaves the host and every step timed. Every
  byte and every second in it was observed, and it was not derived from
  advertised artifact sizes;
- the end-to-end cache-pruned `docker build` is a different measurement, run on
  a Docker host and recorded in its own subsection below the table. The replay
  is a lower bound on it, because a daemon additionally spends base-image pull,
  layer commit/snapshot and `dpkg` unpack+configure time.

One replay run on the container the change was developed in (Debian 12, amd64,
2026-10-25):

| Stage     | Step                                                                                                         | Observed transfer | Observed time |
| --------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ------------- |
| scrapling | base image `debian:12-slim` at the pinned digest (one layer, shared by both stages)                          | 28,368,487 B      | 13.2 s        |
| scrapling | apt: python3, python3-venv, ca-certificates (index + archives)                                               | 23,495,467 B      | 10.2 s        |
| scrapling | pip: scrapling[fetchers] + markdownify + beautifulsoup4 (constraints-pinned)                                 | 120,044,892 B     | 50.5 s        |
| scrapling | pip: ddgs + idna + anyio (web-search venv)                                                                   | 6,740,161 B       | 7.8 s         |
| scrapling | patchright install chromium (chromium + headless shell + ffmpeg)                                             | 316,396,702 B     | 115.2 s       |
| **stage** | **scrapling subtotal**                                                                                       | **495,045,709 B** | **196.9 s**   |
| agent     | apt: curl, gnupg, ca-certificates                                                                            | 14,972,525 B      | 6.7 s         |
| agent     | NodeSource setup_22.x + apt: nodejs                                                                          | 48,959,117 B      | 20.7 s        |
| agent     | apt: toolchain + Playwright system libraries (26 packages)                                                   | 74,272,204 B      | 25.6 s        |
| agent     | GitHub CLI keyring + apt: gh                                                                                 | 37,548,364 B      | 21.3 s        |
| agent     | npm globals: ast-grep, eslint, jscpd, prettier, pyright, shell-quote, typescript, typescript-language-server | 44,918,157 B      | 21.0 s        |
| agent     | rust-analyzer 2026-08-10.1                                                                                   | 14,856,284 B      | 5.6 s         |
| agent     | rtk 0.45.0 (install.sh + release asset)                                                                      | 4,603,892 B       | 3.1 s         |
| agent     | osv-scanner 2.4.0                                                                                            | 56,819,425 B      | 14.5 s        |
| agent     | Go 1.25.8 toolchain (download + unpack)                                                                      | 59,936,816 B      | 21.3 s        |
| agent     | cheasee-pi clone (depth 1) + npm ci                                                                          | 50,258,044 B      | 17.5 s        |
| agent     | @earendil-works/pi-coding-agent 1.0.2                                                                        | 12,501,756 B      | 18.8 s        |
| **stage** | **agent subtotal**                                                                                           | **419,646,584 B** | **176.1 s**   |
| **both**  | **cold build transfer (replay)**                                                                             | **914,692,293 B** | **373.0 s**   |

Every number in the table is a byte that was actually transferred and a wall
clock that was actually run, not a sum of advertised artifact sizes: one
command re-measures the whole table, and the total is what a cache-pruned build
has to fetch over the wire.
Byte counts are exact; the times move with mirror and network conditions, so
compare the shape of the table across runs, not the tenths. A second run on the
same host moved the total from 914,692,293 B to 914,698,787 B (+0.0007%) and
the elapsed time from 373.0 s to 317.9 s — the bytes are the contract, the
seconds are the network. It cross-checks the per-layer baseline above closely — Chromium 100.5 s
there, 115.2 s here; the scrapling venv 55.6 s there, 50.5 s here; apt
toolchain 55.9 s there, 25.6 s here on a faster mirror — and it lands on the
same order as the 9 min baseline.

Scope of the replay: it covers the network transfer and the interpreter work
around it. It does not cover Docker itself — base-image pull, layer
commit/snapshot time, and `dpkg` unpack+configure — because none of those can
run without a daemon and root. That is exactly why the replay is a lower bound
and not the cold-build number.

### End-to-end cache-pruned build, measured on a Docker host

Recorded on GitHub Actions — `Tests` workflow, `docker` job, step "Prime
dogfooding test image" (`docker/build-push-action@v6` on the default buildx
driver) — [run 40186064094][run2053], commit `f718653b`, starting
2026-10-25T10:45:47Z. The same step re-measures it on any Docker host.

[run2053]: https://github.com/SchneiderDaniel/cheasee-pi/actions/runs/40186064094

The builder starts empty and the `type=gha` import matched nothing: every `RUN`
line now carries `--mount` flags and the stage split renumbered the layers, so
no step was a cache hit (`CACHED` appears 0 times in the `--progress=plain`
log), and the only pull was the pinned base image (`#7 … 28.25MB`). It is the
cache-pruned case the criterion asks for.

| Measurement | Environment                                                                                  | Transfer      | Elapsed |
| ----------- | -------------------------------------------------------------------------------------------- | ------------- | ------- |
| end-to-end  | ubuntu-latest + buildx, 0 cache hits; bytes from the counting-proxy replay of the same steps | 914,692,293 B | 135 s   |

135 s is what a user's `cheasee-pi build` pays there: 77 s of layer execution
(10:45:48 → 10:47:05, both stages in parallel) plus 58 s of image export and
`docker load` (`#36` 24.2 s exporting layers, `#37` 32.3 s importing). The step
wall clock is 242 s; the last 106 s is `#38`, the `type=gha,mode=max` cache
export, which only CI pays. The runner's log carries no wire byte totals, so
the transfer column is the counting-proxy figure for the same steps — bytes and
seconds come from two instruments, and neither was derived from advertised
sizes.

What this run shows that the replay could only assert:

- the `scrapling` stage is copied, not rebuilt: `#21`, `#22` and `#23`
  (`COPY --from=scrapling`) finished in 1.7 s, 0.6 s and 3.8 s;
- both stages' apt layers mount the same `/var/cache/apt` target with
  `sharing=locked`, so `#8` (6.4 s) and `#9` (11.5 s) ran one after the other
  instead of concurrently — the lock is what serializes them, and it is the
  price of the archive reuse below.

Those seconds are not comparable with the 9 min baseline: this runner's network
is an order of magnitude faster (Chromium `#14` 14.8 s here, 100.5 s there),
which is why the transfer column is quoted from the counting proxy and the
per-layer table above is measured on the development host. A host-matched
before/after delta, and cache-mount effectiveness, still need the four commands
at the top of this section on the maintainer host.

The Chromium bundle the issue quotes as ~646 MB is the archives _unpacked_; the
transfer is 316,396,702 B, and it now sits entirely in the `scrapling` stage.

Two things the table says about the change:

- Chromium is 64% of the scrapling stage's 495 MB. That is the transfer a
  change to any agent-stage layer used to pull again, and the stage split is
  what stops it — the agent stage's own rows are 419,646,584 B.
- The four agent apt rows and their indexes are 175,752,210 B (42% of the agent
  stage). Those are the rows the `--mount=type=cache` flags serve on a re-run:
  apt reads the archives and the `Packages` indexes back from the mounted
  `/var/cache/apt` and `/var/lib/apt` instead of the network. `apt-get update`
  runs once per apt layer, so a cold build pays an index in each of the four;
  that cost is inside the step times above.

Scenario status after the split. The cold rows pair the observed end-to-end run
above with the _replay_ totals; they are labelled with the instrument that
produced them, because only the replay resolves a per-stage split:

| Scenario                             | Before                                     | After                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully cold (`buildx prune -af`)      | 9 min / 1.1 GB (maintainer host, observed) | 135 s to a runnable image, 0 cache hits (GitHub runner); 914,692,293 B fetched, counting proxy. ~0.91 GB is the baseline's volume, as it must be — a cold build still fetches everything |
| Agent-layer invalidation (the point) | 9 min / 1.1 GB (maintainer host, observed) | 419,646,584 B: the agent rows only. The 495,045,709 B scrapling subtotal — Chromium included — is copied from the unchanged stage instead of re-fetched                                  |
| Re-run of one busted package layer   | that layer's full fetch                    | archive reuse from the cache mounts, so the step re-runs without fetching — visible with `--progress=plain` on a busted pin                                                              |

The remaining gap is cache-mount **effectiveness** on a real builder: bust one
package layer (edit a version pin), rebuild with `--progress=plain`, and
confirm the apt/pip/npm step reports no downloads. That check needs a daemon
and one busted layer, and the mounts are only visible there — a cold build
fetches everything by definition, so the mounts cannot move that number.

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
