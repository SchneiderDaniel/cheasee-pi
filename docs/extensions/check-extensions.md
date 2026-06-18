---
layout: default
title: Check Extensions
parent: Extensions
nav_order: 16
---

# Check Extensions

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/check-extensions/README.md)

**Why.** Pi releases can break extensions silently — removed APIs, renamed hooks, deprecated signatures. Check Extensions automates auditing all `.pi/extensions/` against pi's CHANGELOG, detects breakage, and generates migration snippets with GitHub issues.

**How it works.** Triggered via `/check-extensions` (trust-gated). Pipeline runs: parses pi's CHANGELOG.md from node_modules for breaking change entries → walks `.pi/extensions/` and scans each extension with ast-grep AST analysis → cross-references extension API usage against changelog entries → scores each compatibility issue by severity (removed > renamed > deprecated) → generates structured GitHub issue per affected extension with affected files/lines and old→new migration code snippets.

**Location:** `.pi/extensions/check-extensions/`
