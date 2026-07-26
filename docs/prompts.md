---
layout: default
title: Prompts
nav_order: 6
---

# Prompts

{: .no_toc }

All prompts were converted to skills with `disable-model-invocation: true`. They no longer live in `.pi/prompts/` but in `.pi/skills/`, invocable via `/skill:<name>`. Agent does NOT load them automatically — manual invocation only.

> Only harness-dev prompts remain in `../private-pi/prompts/` (not installed in public builds).

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

All Cheasee-Pi prompts became skills. See [Skills](skills) for details.

## Template organization

```
.pi/prompts/ — empty (all converted to skills)

Internal prompts (not in public build): changelog-check, extension-validation, package-extension
```
