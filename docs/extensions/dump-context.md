---
layout: default
title: Dump Context
parent: Extensions
nav_order: 20
---

# Dump Context

{: .no_toc }

[📄 Extension source](../../.pi/extensions/zzz-dump-context/index.ts)

**Why.** Captures the exact system prompt text sent to the LLM each turn and writes it to `ignore/` on demand. Console shows stats: bytes, estimated vs actual token count, tools, skills, context files, and active injections (caveman, ponytail, lessons).

**How it works.** Hooks `before_agent_start` and stores `event.systemPrompt` (the fully assembled string after all extensions have patched it). The `zzz-` prefix ensures alphabetical load order places this last, so the capture includes modifications from caveman and ponytail. On `/dump-context` command, writes the stored prompt and JSON-structured options to `ignore/`, then prints summary stats to terminal.

**Location:** `.pi/extensions/zzz-dump-context/`

## Why use it

The system prompt is assembled from many sources — pi's default prompt, the global `APPEND_SYSTEM.md` append (cheasee-pi operating instructions), AGENTS.md, skills XML, plus injections from caveman and ponytail. There's no built-in way to see the final string. This extension makes the full text inspectable and debuggable: verify what the model actually receives, audit token budget allocation, debug prompt injection conflicts.

## Commands

| Command | Effect |
|---------|--------|
| `/dump-context` | Writes `ignore/dump-context.txt` + `ignore/dump-context-options.json` and prints stats |

## Stats

The terminal output shows:

```
System prompt: 22,762 B  ·  context: 8,103 tok  ·  0.8%
~5,691 tok (est)  ·  API: 8,103 tok (+2,412)
11 tools (7 ext)  ·  14 skills  ·  1 ctx files  ·  27 guidelines  ·  13 sections
Injections: caveman, ponytail, lessons
→ ignore/dump-context.txt
→ ignore/dump-context-options.json
```

| Stat | Source |
|------|--------|
| `B` | `event.systemPrompt.length` (UTF-8 bytes) |
| `tok (est)` | `chars / 4` — rough heuristic (undercounts code/XML content) |
| `context` / `API` | `ctx.getContextUsage().tokens` — actual token count from provider |
| `tools (ext)` | `selectedTools` length, filtered by built-in set |
| `skills` | Counted from XML `<skill>` tags in prompt |
| `ctx files` | `contextFiles.length` — AGENTS.md files found |
| `guidelines` | `promptGuidelines.length` |
| `sections` | Markdown heading count (`##` / `###`) |
| Injections | Detected by substring match in prompt text |

## Section attribution

`dump-context.txt` labels each part of the assembled prompt with its source:

| Section | Source |
|---------|--------|
| `[1] Base system prompt` | pi built-in (no custom `system.md`) |
| `[2] System prompt append (APPEND_SYSTEM.md)` | `~/.pi/agent/APPEND_SYSTEM.md` — the global cheasee-pi operating instructions, appended by pi in every repo (split seam: the file's H1 anchor) |
| `[3] Project context` | `contextFiles` — AGENTS.md/CLAUDE.md files |
| `[4] Skills` | model-invocation-enabled skills |
| `[5] Working directory` | cwd line |
| `[6] Extension injections` | appended via `before_agent_start` (caveman, ponytail, lessons) |

## Details

### Architecture

```
before_agent_start (fires every turn)
  → capture event.systemPrompt (final, after all extensions)
  → capture event.systemPromptOptions (structured metadata)
  → return undefined (don't modify prompt)
         ↓
/dump-context command (on demand)
  → write ignore/dump-context.txt
  → write ignore/dump-context-options.json
  → print stats to terminal
  → notify file paths
```

### Why zzz- prefix

Extensions modify the system prompt in a chain — each `before_agent_start` handler receives the prompt as modified by all previous handlers:

```
caveman → ponytail → zzz-dump-context (captures final)
                                       ^
                                  runs last alphabetically
```

Without the `zzz-` prefix, the capture would miss later injections. The prefix ensures this handler sees the final string.

### Files written

| File | Content |
|------|---------|
| `ignore/dump-context.txt` | The exact system prompt text sent to the LLM |
| `ignore/dump-context-options.json` | `BuildSystemPromptOptions` — structured data: tools, skills, guidelines, context files |

Both files are overwritten each call. Saved to `ignore/` per project conventions (temp files go in `ignore/`).

### No session persistence

The extension does not use `pi.appendEntry()` — there's no need to persist dump state across sessions. The prompt is captured fresh each turn.
