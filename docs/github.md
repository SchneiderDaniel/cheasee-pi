---
layout: default
title: GitHub
nav_order: 6
---

# GitHub

{: .no_toc }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Cheasee-Pi integrates deeply with GitHub for issue tracking, project management, code review, and CI/CD. The supervisor pipeline reads from GitHub Project boards, creates pull requests, and posts status updates — all automated.

---

## Git Worktrees

Cheasee-Pi uses [git worktrees](https://git-scm.com/docs/git-worktree) to give each issue its **own isolated working directory** with its own branch. This keeps `main` clean and prevents agents from interfering with each other.

### Key concepts

- A worktree is a separate checkout of the repo at a different path
- Each worktree has its own branch — changes never affect another worktree
- Worktrees share the same Git object store (no wasted disk space)
- The supervisor pipeline creates worktrees before dispatching the Developer agent
- Worktrees are cleaned up after the pipeline completes

### Lifecycle

```
1. Supervisor:  git worktree add -b <branch> ../<branch> main
2. Developer:   Works inside worktree, commits, pushes
3. Auditor:     Reviews diff via git diff main inside worktree
4. Supervisor:  git worktree remove --force ../<branch>
```

### Manual worktree usage

```bash
# Create a worktree
git worktree add -b feature/my-feature ../feature-my-feature main

# Work in it
cd ../feature-my-feature
git add -A && git commit -m "feat: my feature"
git push origin feature/my-feature

# Remove when done
cd /home/miria/git/main
git worktree remove --force ../feature-my-feature
git worktree prune
git branch -D feature/my-feature
```

### Why worktrees?

Switching branches in-place means committing or stashing unfinished work. Worktrees let you have multiple branches checked out simultaneously — switch between contexts instantly.

---

## GitHub Projects

Cheasee-Pi uses a **GitHub Project board** (v2) to orchestrate autonomous development. The pipeline reads from your project board, moves cards through status columns, and posts comments — all automated.

### Board statuses

Create a GitHub Project (v2) with these statuses:

```
Todo → Research → Architecture → TestDesign → Implementation → Audit → Done
```

### Configuration

Configure the project in `.pi/settings.json`:

```json
{
  "supervisor": {
    "repo": "SchneiderDaniel/cheasee-pi",
    "projectNumber": 3,
    "codeowners": ["SchneiderDaniel"],
    "statusMapping": {
      "Research": "researcher",
      "Architecture": "architect",
      "TestDesign": "test-designer",
      "Implementation": "developer",
      "Audit": "auditor"
    },
    "statusField": "Status",
    "maxRejections": 5,
    "agentTokenBudget": 300000,
    "maxToolCalls": 0,
    "bellOnComplete": false
  }
}
```

Use **Board** layout in GitHub, set **Group by** to `Workflow`.

### One-time setup

1. Create a GitHub Project (v2) with statuses matching `supervisor.statusMapping`
2. Configure the project number under `supervisor.projectNumber` in `.pi/settings.json`
3. Use **Board** layout with **Group by** set to `Workflow`

---

## Pipeline walkthrough

When you run `/supervisor 42`, here is how it interacts with GitHub:

1. **Fetch** — Supervisor reads settings, fetches issue #42 from GitHub, filters to trusted codeowners
2. **Researcher** — Crawls 3-5 web pages, posts `## Research Findings` comment on the issue, moves board card to Architecture
3. **Architect** — Analyzes codebase, proposes architecture following Clean Architecture + PEAA, posts `## Architecture Approach` comment
4. **TestDesigner** — Writes test plan, posts `## Test Plan` comment
5. **Developer** — Supervisor creates git worktree, Developer implements feature, commits, pushes to branch
6. **Quality Gates** — TSC + LSP checks pass locally, moves board card to Audit
7. **Auditor** — Reviews diff, approves or rejects. If approved, creates PR on GitHub with audit report as body, posts `## Audit` comment. If rejected, sends back to Implementation
8. **Post-pipeline** — Checks PR for merge conflicts, asks user to auto-fix if needed

### Agent deep dive

Each agent posts its findings as a GitHub issue comment:

| # | Agent | Entry Marker | GitHub Action |
|---|-------|-------------|--------------|
| 1 | **Researcher** | `Research` | Posts findings comment, moves board |
| 2 | **Architect** | `Architecture` | Posts architecture comment |
| 3 | **TestDesigner** | `TestDesign` | Posts test plan comment |
| 4 | **Developer** | `Implementation` | Commits + pushes to worktree branch |
| 5 | **Auditor** | `Audit` | Creates PR if approved |

---

## Submodule strategy

When the repo has submodules, the Developer works on **both repos simultaneously** using a **matched-branch pattern**:

```
Main repo (cheasee-pi)          Submodule (flask_blogs)
│                                │
├─ Branch: worktree-git-...     ├─ Branch: worktree-git-... (same name)
├─ Commit includes submodule    ├─ Actual code changes
│  pointer update (pinned SHA)  │
└───────────────────────────────┴───────────────────────────────
```

**Submodule must be pushed first** because the main repo commit records a specific submodule SHA. If that SHA only exists locally, teammates get `fatal: reference is not a tree`.

**PR creation order:**
1. Create submodule PR first (if submodule has changes)
2. Create main repo PR second (includes submodule pointer)

---

## GitHub CLI setup

Inside the Docker container, authenticate with GitHub:

```bash
gh auth login
```

Use **Login with a web browser** when prompted. The session persists across container restarts via the bind-mounted home directory.

---

## GitHub Pages

This documentation site is built with Jekyll + the Just the Docs theme and deployed via [GitHub Actions](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.github/workflows/pages.yml).

The workflow:
1. Triggers on pushes to `main` that touch `docs/**`
2. Checks out the repo without submodules (`submodules: false`)
3. Builds with `ruby/setup-ruby` and `bundler-cache`
4. Deploys to GitHub Pages

The Pages source setting must be **GitHub Actions** (not "Deploy from a branch") in repo Settings → Pages for the workflow to deploy.

Site URL: [https://schneiderdaniel.github.io/cheasee-pi/](https://schneiderdaniel.github.io/cheasee-pi/)
