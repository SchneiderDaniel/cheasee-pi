---
layout: default
title: Check Extensions
parent: Extensions
nav_order: 16
---

# Check Extensions

{: .no_toc }

[📄 README](../../.pi/extensions/check-extensions/README.md)

**Why.** Pi releases can break extensions silently — removed APIs, renamed hooks, deprecated signatures. Check Extensions automates auditing all `.pi/extensions/` against pi's CHANGELOG, detects breakage, and generates migration snippets.

**How it works.** Triggered via `/check-extensions` (trust-gated). Pipeline runs: parses pi's CHANGELOG.md from node_modules for breaking change entries → walks `.pi/extensions/` and scans each extension with ast-grep AST analysis → cross-references extension API usage against changelog entries → scores each compatibility issue by severity (removed > renamed > deprecated) → sends structured findings to the in-session LLM for evaluation. The LLM decides which findings warrant GitHub issues and creates them.

**Location:** `.pi/extensions/check-extensions/`

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Pipeline Architecture](#pipeline-architecture)
- [Why This Is an Extension, Not a Prompt](#why-this-is-an-extension-not-a-prompt)
- [Key Design Decisions](#key-design-decisions)
- [Module Reference](#module-reference)
- [Testing](#testing)

---

## Overview

Pi releases introduce breaking changes. An extension using `ctx.ui.setFooter` that functions correctly in version 0.78.0 might fail silently in version 0.79.0. Manually auditing seventeen or more extensions after each pi update is impractical. The Check Extensions extension automates this audit as a single command: `/check-extensions`.

The extension registers a TUI command, parses pi's CHANGELOG.md, scans every extension directory with AST-level precision via ast-grep, cross-references usage against documented breaking changes, scores impact by severity, and presents findings to the current session's LLM for evaluation. The LLM decides which findings warrant tracking issues and creates them.

---

## How It Works

1. **Trigger** — The user runs `/check-extensions` in the pi TUI. A trust gate prevents execution when the project is untrusted.
2. **Changelog Parsing** — The extension reads pi's `CHANGELOG.md` from `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` and extracts breaking-change entries with affected API names and version transitions. Only the latest major.minor stream is scanned.
3. **Extension Scanning** — The extension walks `.pi/extensions/`, reads each extension's source files, and performs AST analysis via ast-grep to identify all pi API imports and usage sites. Findings are classified as runtime-call, import-type, or import-value.
4. **Cross-Referencing** — Each extension's API usage is matched against the changelog's breaking changes. A relevance resolver eliminates false positives by comparing structured change signatures with call-site arguments.
5. **Impact Scoring** — Each compatibility issue receives a score based on severity: removed APIs score highest, followed by renamed, deprecated, and changed signatures. Extensions with all findings marked non-applicable are filtered out.
6. **LLM Evaluation** — Findings are sent to the in-session LLM (the current pi agent) via `pi.sendUserMessage()`. The LLM evaluates each extension's findings against criteria and decides which warrant GitHub issues.
7. **Issue Creation** — The LLM creates issues for approved extensions using `gh issue create`.

---

## Pipeline Architecture

The extension implements a multi-phase pipeline. Each phase is a method on the `ChangelogPipeline` class, making every stage independently testable.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        /check-extensions                             │
│                         Trust Gate                                   │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 0: validatePhase                                              │
│  Check that pi CHANGELOG.md exists at the expected path              │
│  Return null on failure with error notification                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 1: parsePhase                                                 │
│  parseChangelog() → ChangeEntry[]                                    │
│  Extract latest version, collect affected API patterns               │
│  Filter to latest major.minor stream                                 │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 2: scanPhase                                                  │
│  scanExtensionsAST() → ASTFinding[]                                  │
│  Walk .pi/extensions/, run ast-grep on each .ts file                 │
│  Classify findings: runtime-call, import-type, import-value          │
│  Group findings by extension name                                    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 2.5: crossRefPhase                                            │
│  resolveRelevance() → eliminate false positives                      │
│  computeImpactScore() → severity weight per finding                  │
│  generateMigrationSnippet() → old→new code transformation            │
│  Filter out extensions where all findings are non-applicable         │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 3: issuePhase                                                 │
│  Build structured evaluation request                                 │
│  Send to in-session LLM via pi.sendUserMessage()                     │
│  LLM evaluates findings and creates issues for approved ones         │
└──────────────────────────────────────────────────────────────────────┘
```

### Pipeline Flow (Mermaid)

```mermaid
flowchart TD
    A[/check-extensions] --> B{Project trusted?}
    B -- no --> C[Notify: cannot scan]
    B -- yes --> D[Phase 1: Parse CHANGELOG.md]
    D --> E[Extract breaking changes: removed, renamed, deprecated]
    E --> F[Phase 2: Walk .pi/extensions/]
    F --> G[manifest-reader: read package.json + README]
    G --> H[ast-scanner: ast-grep scan for API usage]
    H --> I[Phase 3: Cross-reference]
    I --> J[change-resolver: match usage to changelog]
    J --> K[Phase 4: Score by severity]
    K --> L[impact-scorer: removed > renamed > deprecated]
    L --> M[Phase 5: Generate migration snippets]
    M --> N[Phase 6: Present to LLM for evaluation]
    N --> O[LLM decides: create issues for worthy findings]
```

---

## Why This Is an Extension, Not a Prompt

A persistent question about Check Extensions is why it resides in `.pi/extensions/` as compiled TypeScript rather than in `.pi/prompts/` as a markdown template. The distinction is fundamental to the pi platform and reflects two entirely different capabilities.

### Prompts Are Passive Context

Files in `.pi/prompts/` are static markdown documents injected into the system prompt. They guide the LLM's reasoning by providing instructions, context, and behavioral constraints. A prompt cannot perform I/O, spawn subprocesses, execute conditional logic, or produce deterministic output. Its effects depend entirely on the LLM interpreting and acting upon its text.

A prompt telling the LLM to "check extensions against the changelog" would require the LLM to:
- Decide how to parse pi's CHANGELOG.md, whose format varies across sections
- Guess which APIs are relevant to each extension
- Read every extension file, potentially hallucinating or missing usage sites
- Produce non-deterministic output — the same input yields different results across runs
- Create GitHub issues through an indirect chain of bash commands, parsing their output and handling errors ad hoc

### Extensions Are Active Code

Files in `.pi/extensions/` are TypeScript modules registered with pi's runtime. They declare commands, receive callbacks, and execute arbitrary code with full access to the filesystem, subprocess spawning, and pi's API surface. They produce deterministic, reproducible results.

Check Extensions requires capabilities that prompts do not possess:

| Capability | Prompt | Extension |
|---|---|---|
| Register a `/command` in pi TUI | Not possible | `pi.registerCommand("check-extensions", handler)` |
| Read files from arbitrary disk paths | Not possible (LLM reads through tool calls) | `readFileSync(PI_CHANGELOG_PATH)` |
| Walk directories programmatically | Not possible | `readdirSync`, `existsSync`, recursive traversal |
| Spawn external binaries | Not possible | `pi.exec("ast-grep", [...])` |
| Produce deterministic output | Not possible (LLM variability) | Guaranteed by compiled TypeScript |
| Send typed UI notifications | Not possible | `ctx.ui.notify(msg, "error" / "info" / "warning")` |
| Execute multi-phase pipeline with conditional branching | Not possible | `ChangelogPipeline` class, six phases |
| Perform AST-level code analysis | Only through indirect bash/sed | `ast-grep` integration with structured output |

### The Practical Distinction

A prompt says "consider these guidelines when responding." An extension says "execute this operation now with these inputs and produce this output."

Check Extensions reads a changelog from a specific path in `npm-global`, spawns ast-grep to perform AST analysis across every TypeScript file in `.pi/extensions/`, resolves relevance by comparing structured change signatures against call-site arguments, computes numeric severity scores, and presents findings for LLM evaluation — all operations that require filesystem access, subprocess spawning, and deterministic execution. These operations fall outside the domain of prompt templates entirely.

The severity scoring system illustrates the point concretely. Consider a changelog entry that deprecates `pi.on("tool_call")` in favor of `pi.on("tool_before_call")`. An extension that calls `pi.on("session_start")` uses the same pi method but is unaffected by this particular change. The extension's `resolveRelevance` function detects this mismatch by comparing the changelog's affected event type (`tool_call`) against the call-site argument (`session_start`) and marks the finding as non-applicable. A prompt-based approach could not perform this comparison because it requires parsing the changelog entry into a structured representation, extracting the affected event type, and matching it against an AST-extracted argument — all operations that demand code execution, not textual instruction.

---

## Key Design Decisions

### CHANGELOG-Based Detection

The extension parses pi's `CHANGELOG.md` from `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`. Breaking changes are marked with `!` in version headings. This approach means the extension does not require a separate API compatibility database — the canonical source of truth already exists in the pi repository.

### Version Scope

The pipeline filters changelog entries to only the latest major.minor stream. If the most recent pi version is `0.79.1`, only entries from `0.79.x` are scanned. Older entries are excluded because extensions cannot be broken by APIs removed or renamed before the earliest version compatible with current pi. A `--since` flag can be added if broader historical scanning is needed.

This filtering is applied in `parsePhase()` within `pipeline.ts`.

### AST-grep for Usage Scanning

The extension uses ast-grep rather than text search (grep) for scanning extension source files. AST analysis distinguishes actual API calls and imports from false positives in comments, string literals, and dead code paths. This eliminates the class of false positives that text-based scanning cannot avoid.

### Relevance Resolution

The `change-resolver.ts` module compares structured changelog change signatures against AST-extracted call-site arguments. When a changelog entry specifies a particular event type (for example, `tool_call`) but an extension calls the same method with a different event type (for example, `session_start`), the resolver marks the finding as non-applicable. This prevents one changelog entry from generating spurious issues for unrelated usage sites.

### LLM-Driven Issue Creation

Instead of automatically creating GitHub issues for every extension with findings, the extension presents structured findings to the in-session LLM. The LLM evaluates each extension's findings against criteria (breaking changes warrant issues, import-only findings do not) and decides what to create. This reduces noise and leverages the LLM's contextual understanding of the codebase.

### Trust Gate

The pipeline only executes when the project is trusted (verified via `ctx.isProjectTrusted()`). This prevents the extension from scanning and creating issues in untrusted projects.

### Mode-Adaptive Output

In TUI and RPC modes, the extension uses `ctx.ui.notify()` for transient notifications. In JSON and print modes, it falls back to `pi.sendMessage()` with a structured custom type. This ensures the extension functions correctly regardless of the communication channel.

### Impact Scoring

| Severity | Weight | Example |
|----------|--------|---------|
| `removed` | 100 | API no longer exists in pi |
| `renamed` | 50 | API renamed with new signature |
| `deprecated` | 25 | API deprecated with documented alternative |
| `changed` | 10 | Signature changed without rename |

The overall score for an extension is the sum of all severity weights across its relevant findings. This score is included in the evaluation request sent to the LLM.

---

## Module Reference

| Module | Responsibility |
|---|---|
| `index.ts` | Entry point; registers `/check-extensions` command, parses arguments, delegates to pipeline |
| `pipeline.ts` | `ChangelogPipeline` class; orchestrates all phases including LLM evaluation |
| `changelog-parser.ts` | Parses pi CHANGELOG.md into structured `ChangeEntry[]` with version, category, API names, and breaking status |
| `ast-scanner.ts` | AST analysis of extension source files via ast-grep; classifies findings into runtime-call, import-type, import-value |
| `manifest-reader.ts` | Reads extension package.json and pi manifest for metadata |
| `change-resolver.ts` | Cross-references AST findings against changelog entries; eliminates false positives via structured change signature matching |
| `impact-scorer.ts` | Scores compatibility issues by severity weight (removed > renamed > deprecated > changed) |
| `migration-generator.ts` | Generates old-to-new migration code snippets from structured change patterns |
| `issue-builder.ts` | Builds GitHub issue title and body; checks authentication, ensures labels, deduplicates, and creates issues |
| `resolve-astgrep.ts` | Resolves the ast-grep binary path from environment and PATH |
| `constants.ts` | API pattern mappings, changelog path resolution |
| `test/` | Pipeline and parser test suite |

---

## Testing

Tests cover:
- CHANGELOG parsing: markdown headings, severity markers, version extraction
- AST scanning: API usage detection, import resolution, multi-file extensions
- Change resolution: exact match, fuzzy match, no-match edge cases
- Impact scoring: severity weights, threshold gating, cumulative scoring
- Migration generation: simple rename, signature change, complex migration
- Issue building: markdown formatting, file references, code snippets
- Pipeline integration: full end-to-end with mock changelog + mock extension

## Requirements

- Pi Coding Agent version 0.78.0 or higher
- ast-grep installed globally (`npm i -g @ast-grep/cli`)
- Project must be trusted (`/trust` or `pi trust`)

## Related Documentation

- `.pi/extensions/check-extensions/README.md` — Original extension README with quick-start information
- `.pi/extensions/check-extensions/pipeline.ts` — Pipeline orchestration and phase definitions
- `issues/check-extensions.md` — FAQ and common issues
