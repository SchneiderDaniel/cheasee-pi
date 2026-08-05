---
layout: default
title: Acknowledgements
nav_order: 11
---

# Acknowledgements

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## The Pi project

Cheasee-Pi stands on the shoulders of the [Pi coding agent](https://pi.dev) — the extensible AI coding harness that makes all of this possible. Pi's extension API, prompt template system, and modular architecture are the foundation of this project.

## Runtime & tools

- **[scrapling](https://github.com/nicofirst/scrapling)** — Memory-optimized web scraper with progressive fetching
- **[rtk](https://github.com/rtk-ai/rtk)** — Token-saving CLI proxy that rewrites agent shell commands for 60-90% less output
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — GitHub API client powering issues, PRs, and releases
- **[Zed](https://zed.dev)** — The editor

## Communication & workflow

- **[Caveman](https://github.com/JuliusBrussee/caveman)** — Origin of the caveman communication style ("why use many token when few word do trick"). Cheasee-Pi ships an in-house multi-level caveman mode extension built on the same idea.
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** — Origin of the lazy senior dev mode (YAGNI, stdlib-first, minimal code). Installed as a package and extended with in-house audit, review, and debt skills.

## The cheasee-pi CLI

- **[Go](https://go.dev)** — Build language for the `cheasee-pi` binary
- **[Charmbracelet huh](https://github.com/charmbracelet/huh)** — Terminal UI forms for interactive prompts
- **[cobra](https://github.com/spf13/cobra)** — CLI framework
- **[go-git](https://github.com/go-git/go-git)** — Git repository operations
- **[cli/oauth](https://github.com/cli/oauth)** — Device-flow OAuth for GitHub authentication

## Security & pipeline

- **[osv-scanner](https://github.com/google/osv-scanner)** — Vulnerability scanning across lockfiles in the audit pipeline
- **[@octokit](https://github.com/octokit)** — GitHub API client used by the supervisor pipeline

## Open source tools

- **[ast-grep](https://ast-grep.github.io/)** — Structural code search engine via Tree-sitter AST
- **[ripgrep](https://github.com/BurntSushi/ripgrep)** — Ultra-fast literal/regex code search
- **[Jekyll](https://jekyllrb.com/)** — Static site generator
- **[Just the Docs](https://just-the-docs.com/)** — Documentation theme
- **[Docker](https://www.docker.com/)** — Container runtime
- **[Node.js](https://nodejs.org/)** — JavaScript runtime
- **[TypeScript](https://www.typescriptlang.org/)** — Type system and compiler
- **[Pi SDK & Extensions Documentation](https://pi.dev/docs/latest)** — Extension API, commands, hooks, theme system

## License

Cheasee-Pi is distributed under the [MIT License](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/LICENSE). Third-party components are used under their own licenses (see [SBOM](sbom)) — mostly OSI-approved permissive licenses, with GPL only in standard system tools (git, universal-ctags, wget). No AGPL.
