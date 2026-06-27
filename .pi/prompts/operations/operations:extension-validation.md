---
description: Validate all extensions against pi documentation — check structure, API usage, best practices, and examples compliance. Files one GitHub issue per extension with severity-ranked violations.
---

# Extension Validation — Cross-Check Extensions Against Pi Docs

Iterate over every extension in `.pi/extensions/`. For each, read the relevant pi documentation sections and validate the extension code matches documented patterns, APIs, and best practices. File one GitHub issue per extension listing all violations with severity.

Requires: `gh` CLI authenticated.

## Validation sources

Read these dynamically each run:

| Source                 | Path                                                                                                     | What to extract                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Extensions guide**   | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`            | Extension structure, factory signature, event API, tool registration, commands, UI methods, error handling, state management                                                   |
| **Packages guide**     | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`              | Package manifest (`pi.extensions`), `peerDependencies`, npm/git packaging                                                                                                      |
| **SDK guide**          | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`                   | Subagent patterns, advanced API use                                                                                                                                            |
| **Examples README**    | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/README.md` | Key patterns: `StringEnum` for Google compat, state via `details`, tool rendering                                                                                              |
| **Example extensions** | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/*.ts`      | Concrete patterns — compare each extension against relevant examples (e.g., tool registration → compare with `hello.ts`, state management → `todo.ts`, custom UI → `snake.ts`) |

## Validation workflow

### Step 1 — Discover all extensions

```bash
ls -d .pi/extensions/*/
```

For each extension directory, read the entry file. If `package.json` exists, read it too. Determine which type:

- **Single file** — `<name>.ts` or `<name>/index.ts`
- **Directory with index.ts** — `<name>/index.ts` + helper modules
- **Package** — has `package.json` with `pi.extensions` field

### Step 2 — Read relevant docs

Read docs based on what the extension does:

- **All extensions**: `extensions.md` (structure, factory, tools, events)
- **If has package.json**: `packages.md` (manifest, deps)
- **If uses subagents**: `sdk.md`
- **If has custom rendering**: examples `todo.ts`, `message-renderer.ts`
- **If uses StringEnum**: examples README (Google compat pattern)
- **If registers tools**: `hello.ts`, `dynamic-tools.ts` examples
- **If manages state**: `todo.ts` example (details/session pattern)

### Step 3 — Validate against categories

For each extension, check these categories. Flag everything that deviates.

| #   | Category                             | What to check                                                                                                                                                                     | Severity if wrong            |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | **Factory export**                   | Default export function `(pi: ExtensionAPI)` or async variant. Must be named export default.                                                                                      | critical (won't load)        |
| 2   | **Imports**                          | Use `@earendil-works/pi-coding-agent` (types), `typebox` (schemas), `@earendil-works/pi-ai` (StringEnum), `@earendil-works/pi-tui` (TUI components). No wrong import paths.       | critical (wont load)         |
| 3   | **Tool registration**                | `pi.registerTool()` with `name`, `label`, `description`, `parameters` (Type.Object), `execute(toolCallId, params, signal, onUpdate, ctx)`                                         | critical (broken tool)       |
| 4   | **Tool parameters**                  | Use `Type.Object` from `typebox` for parameters. Use `StringEnum` from `@earendil-works/pi-ai` for string unions (Google compat). Not `Type.Union([Type.Literal(...)])`.          | major (Google incompatible)  |
| 5   | **Tool execute signature**           | Correct param order: `(toolCallId, params, signal, onUpdate, ctx)`. Matching examples.                                                                                            | critical (broken tool)       |
| 6   | **Tool return shape**                | Return `{ content: [{ type: "text", text: string }], details: {} }`. Details must be serializable.                                                                                | major (render/state issues)  |
| 7   | **Event handler signature**          | `pi.on("event_name", async (event, ctx) => {})` with correct event type and context. Proper return types per event (block, modify, etc.).                                         | major (broken handler)       |
| 8   | **Command registration**             | `pi.registerCommand("name", { description, handler: async (args, ctx) => {} })`                                                                                                   | major (broken command)       |
| 9   | **State persistence**                | If extension has mutable state, use `details` in tool return for session persistence. Reconstruct on `session_start`/`session_tree` by scanning `ctx.sessionManager.getBranch()`. | major (state lost on branch) |
| 10  | **Custom rendering**                 | `renderCall(args, theme, context)` and `renderResult(result, options, theme, context)` signatures match examples. Return `Text` from `@earendil-works/pi-tui`.                    | minor (display only)         |
| 11  | **promptSnippet / promptGuidelines** | Custom tools use `promptSnippet` for one-line entry. `promptGuidelines` bullets name the tool explicitly (e.g., "Use my_tool when...").                                           | minor (missing snippet)      |
| 12  | **isToolCallEventType**              | `tool_call` handlers use `isToolCallEventType("tool_name", event)` for typed access. Custom tools export their input type for consumers.                                          | minor (best practice)        |
| 13  | **UI methods**                       | Use `ctx.ui.notify()`, `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.custom()`. `ctx.ui.setStatus()` for footer, `ctx.ui.setWidget()` for editor widgets.                        | minor (UX only)              |
| 14  | **Signal handling**                  | `ctx.signal` used for abort-aware `fetch()` and async work inside event handlers.                                                                                                 | minor (resilience)           |
| 15  | **Error handling**                   | Tool execute returns error content on failure. Events that support blocking return `{ block: true, reason }` for invalid states.                                                  | major (edge cases)           |
| 16  | **Package manifest**                 | If `package.json` exists: must have `pi.extensions` array pointing to entry files. `peerDependencies` for `@earendil-works/*` and `typebox`. Third-party deps in `dependencies`.  | critical (wont load)         |
| 17  | **Location**                         | Extension lives in `.pi/extensions/` (project-local). Uses correct structure for its type (file vs dir vs package).                                                               | minor (organization)         |
| 18  | **Security**                         | No hardcoded secrets. No dangerous patterns not gated by user confirmation. Follows least-privilege for tools.                                                                    | critical (security)          |
| 19  | **Comments/doc**                     | Entry file has description comment (JSDoc block) explaining purpose. Complex extensions have README.                                                                              | minor (documentation)        |

### Step 4 — Classify severity

| Severity     | Meaning                                                                  | Action                       |
| ------------ | ------------------------------------------------------------------------ | ---------------------------- |
| **critical** | Extension won't load, tool always fails, security issue                  | Must fix before next release |
| **major**    | Breaks compatibility (Google API), state lost on branch, wrong API usage | Should fix                   |
| **minor**    | Best practice, missing docs, cosmetic                                    | Nice to have                 |

If no relevant doc section covers an extension's functionality, note "No matching docs found" in the issue body but do NOT flag as violation.

### Step 5 — File one issue per extension

Per extension with violations, create GitHub issue.

**Issue title:** `Extension Validation: <extension-name> — <YYYY-MM-DD>`

**Issue labels:** `extension-validation` + `<extension-name>` as label (create with `gh label create <name>` if absent; skip if label name is invalid).

**Issue body:**

```markdown
## Violations for `<extension-name>`

### Critical

1. **Title** — file.ts:L123
   > Excerpt of violating code
   > Doc says: ... (cite source with path)

### Major

1. **Title** — file.ts:L45
   > Excerpt

### Minor

1. **Title** — file.ts:L67
   > Excerpt

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | N     |
| Major    | N     |
| Minor    | N     |

## Doc sources checked

- `docs/extensions.md` — sections: [list checked sections]
- `examples/extensions/README.md` — key patterns
- `examples/extensions/<example>.ts` — relevant example
```

If zero violations for an extension: do NOT file an issue. Note it in final report.

### Step 6 — Report

After processing all extensions, print summary:

```
Extension Validation complete. Extensions checked: N.
Issues filed: M (list URLs).
Extensions clean: K (names).
```

## Tone

Technical, direct. Each violation cites the exact doc source with file path. Code excerpts are minimal — just the violating lines. No editorializing.
