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

**Transfer volume of the layers the split moves out of the agent stage,
measured** by sending `HEAD` to the exact URLs patchright resolves. No Docker
daemon is involved, so this half of the number is reproducible anywhere:

```bash
# patchright 1.62.2 (scrapling-constraints.txt) → chromium rev 1234 / CfT 151.0.7922.34
for u in builds/cft/151.0.7922.34/linux64/chrome-linux64.zip \
         builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip \
         builds/ffmpeg/1011/ffmpeg-linux.zip; do
  curl -sSIL "https://cdn.playwright.dev/$u" | tr -d '\r' |
    awk 'tolower($1) == "content-length:" { print $2 }'
done
```

| Re-fetched on agent-layer invalidation, before | Transferred                | Wall clock |
| ---------------------------------------------- | -------------------------- | ---------- |
| `chromium` CfT 151.0.7922.34                   | 193,282,658 B              |            |
| `chromium-headless-shell` 151.0.7922.34        | 120,231,126 B              |            |
| `ffmpeg` 1011                                  | 2,376,500 B                |            |
| Chromium bundle (`#31`)                        | 315,890,284 B = 316 MB     | 100.5 s    |
| `scrapling` venv (`#29`)                       | 113 MB (baseline)          | 55.6 s     |
| `web-search` venv (`#18`)                      | 12,217,088 B (re-measured) | 18.8 s     |

The ~646 MB quoted for the browser in the issue is the layer the two zips
unpack to, not the bytes on the wire: the download is 316 MB. What the split
removes from agent-layer invalidation is therefore **~0.44 GB of transfer and
~175 s of wall clock**, not the 771 MB the first draft of this table subtracted.

Scenario status after the split:

| Scenario                             | Before                                           | After                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fully cold (`buildx prune -af`)      | 9 min / 1.1 GB (measured)                        | both stages run, so the volume is unchanged plus one cache-mounted apt layer for the `scrapling` stage, paid once — not measured                                |
| Agent-layer invalidation (the point) | 9 min / 1.1 GB (measured)                        | ~0.66 GB and ~6.1 min: the measured baseline minus the measured layers above. Transfer is measured per artifact; the wall clock is arithmetic, **not measured** |
| Re-run of one busted package layer   | that layer's full fetch (34.8 s npm, 55.6 s pip) | archive reuse from the cache mounts, so the step re-runs without fetching — confirm with `--progress=plain` on a busted pin                                     |

The wall clock in the second `After` cell is the one figure still owed: it needs
a Docker host, and the pipeline container that wrote this section has no daemon.
It is labelled rather than dropped so the gap stays visible — and so nobody
reads a derived number as a timed build. Closing it is the four commands at the
top of this section, run between a clean `buildx prune -af` and one edit to an
early agent layer.

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
