---
name: extension-reinvention-issue-hunter
description: Systematic detection of pi built-in API reimplementations in extensions. Picks random extension, cross-references custom code against LIVE pi documentation, finds where extensions reinvent built-in dialogs, file-queue, truncation, state management, rendering, bash execution, compaction, and more. Creates GitHub issues with migration steps and LOC reduction estimates. Use before releases or when auditing extension quality.
metadata:
  detection-techniques: custom-ui-dialogs,file-mutation-queue,truncation-utilities,state-management,tool-rendering,bash-execution,tool-operations,keybinding-handling,syntax-highlighting,compaction-customization,session-management,provider-registration,editor-replacement,message-injection,autocomplete-provider
  proof-standard: cross-reference-three-sources
  confidence-levels: 100pct-certain,90pct-strong,70pct-likely
---

# Extension Reinvention Issue Hunter

Systematic detector for pi built-in API reinvention in extensions. **Find every case where custom code replaces a pi built-in feature.** Each invocation picks random extension, reads CURRENT pi documentation to build an API catalog, cross-references extension code against that catalog, validates with proof, then files ALL confirmed findings as individual GitHub issues with migration steps and LOC reduction estimates. If no reinvention found in selected extension, discard it and pick another. Repeat until all findings are filed or all extensions exhausted.

## Core Principle: Live Documentation Analysis

**This skill does NOT use a static reference file.** Pi docs change with every release. Instead, each invocation reads the currently installed pi documentation files to build a fresh API catalog. The docs are the source of truth — not a snapshot.

Pi docs location (installed with pi):
```
/usr/lib/node_modules/@earendil-works/pi-coding-agent/README.md
/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/*.md
```

Also check for examples:
```
/usr/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/*.ts
```

## How It Works

### Phase 1 — Random Selection + Hunt Loop

This is a **hunt loop**. Core instruction: **keep hunting until ALL valid findings are filed.**

```
loop:
  1. Pick random extension from .pi/extensions/ (skip previously picked)
  2. Create hunt session label (reinvention-<ext>-<YYYYMMDD>)
  3. Run Phase 1b (extension triage — score signal density, skip low-yield)
  4. If score below threshold → log reason, goto loop start
  5. Run Phase 1.5 (live docs analysis — targeted grep, not sequential read)
  6. Run Phase 2 (code understanding)
  7. Run Phase 3 (reinvention detection — conditional, extension-profile-driven)
  8. For each confirmed reinvention → file as GitHub issue (Phase 5)
  9. Cluster: write cross-references, add session label (Phase 5)
  10. If no reinvention found → log reason, goto loop start (pick next)
  11. After all findings filed OR all extensions exhausted → output report (Phase 6)
```

**Critical rule:** Do NOT lower proof standards. A finding without proof is not a finding. Skip ambiguous cases.

**Deterministic proof required:** All proof must come from reading extension source code + cross-referencing against live pi documentation. Use `ripgrep_search` for patterns, `read` to examine code, `read` on pi docs to confirm built-in API shape.

### Phase 1a — Random Selection

Pick one extension from `.pi/extensions/` using `bash ls`. Prefer subdirectory extensions (more surface area). Single-file `.ts` extensions also eligible. Do NOT pick same extension twice in a row within same invocation.

Selection method:

```bash
ls -d /home/miria/git/main/.pi/extensions/*/   # subdirectory extensions
ls /home/miria/git/main/.pi/extensions/*.ts     # single-file extensions
```

Pick randomly. Document which extension selected and why.

### Phase 1b — Extension Triage (Signal Score)

Before committing to full analysis, score extension complexity and reinvention surface.
Run quick signal scan, then skip if score too low for cost-effective hunt.

```bash
# Count reinvention signals: tool registrations, event handlers, fs ops, ui calls, module state
rg -c "registerTool|pi\.on\(|readFile|writeFile|execSync|exec\(|child_process|ctx\.ui\.|^let |^const .*= new |^const .*= \\[\\]" \
  /home/miria/git/main/.pi/extensions/<name>/index.ts

# Count file count (more files = more surface)
ls /home/miria/git/main/.pi/extensions/<name>/ | wc -l
```

**Scoring:**
- 0-3 signals + 1 file → **low yield**. Skip. Log: "Low signal density (X signals, Y files). Too expensive for expected return."
- 4-8 signals → **medium**. Proceed with full analysis but prioritize 100%-confidence techniques first.
- 9+ signals → **high**. Proceed with full analysis.

**Override:** Always proceed if extension has `package.json` with `"pi"` field (it's a distributed package with more surface).

### Phase 1.5 — Live Pi Documentation Analysis

**This is the critical phase that makes the skill future-proof.** Instead of using a static reference, you read the currently installed pi documentation and build an API catalog dynamically.

#### Step 1: Locate Pi Docs

```bash
ls /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/*.md
read /usr/lib/node_modules/@earendil-works/pi-coding-agent/README.md
```

#### Step 2: Read Core API Documentation

Read these documentation files. They define the built-in APIs that extensions might reinvent.

| Doc | What it covers | Priority |
|-----|---------------|----------|
| `docs/extensions.md` | Extension API: events, tools, ctx.ui, state, commands, providers | HIGH |
| `docs/tui.md` | TUI components, keybinding helpers, custom editors, overlays | HIGH |
| `docs/compaction.md` | Compaction hooks, serializeConversation, session_before_compact | MEDIUM |
| `docs/settings.md` | Settings config, project trust | LOW |

**How to read docs efficiently — targeted grep, not sequential scan:**

Do NOT read the full doc file line-by-line. Use `ripgrep_search` to locate relevant sections, then `read` only those sections. This cuts reading tokens by ~90%.

```bash
# 1. Locate built-in API sections via grep
ripgrep_search "truncateHead|truncateLine|formatSize|DEFAULT_MAX" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
ripgrep_search "ctx\.ui\.select|ctx\.ui\.confirm|ctx\.ui\.custom|addAutocompleteProvider" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
ripgrep_search "withFileMutationQueue|registerProvider|prepareArguments|highlightCode|keyHint" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
ripgrep_search "sendMessage|sendUserMessage|appendEntry|setStatus|setWidget|setFooter|setEditor|pasteTo" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
ripgrep_search "matchesKey|Key\.up|Key\.enter|CustomEditor|setEditorComponent|onHandle|overlay" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md
ripgrep_search "session_before_compact|serializeConversation|session_before_tree" \
  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/compaction.md

# 2. Each match shows file:line. Read only the sections you need.
# Example: "truncateLine" at extensions.md:1850
read /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md --offset 1840 --limit 50

# 3. Also check type definitions for exact API signatures
read /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.d.ts
```

#### Step 3: Build a Dynamic API Catalog

After reading the docs, construct a catalog object listing every built-in API that extensions commonly reinvent. Structure it by category:

```typescript
// Mental model — build this in your reasoning, not as a file
const catalog = {
  "custom-ui-dialogs": {
    apis: ["ctx.ui.select", "ctx.ui.confirm", "ctx.ui.input", "ctx.ui.editor", "ctx.ui.notify"],
    docSource: "docs/extensions.md > Custom UI > Dialogs",
    detectionHints: ["ctx.ui.custom", "SelectList", "handleInput", "render(width)"],
    notes: "Simple interaction patterns that need only 1-3 lines"
  },
  "file-mutation-queue": {
    apis: ["withFileMutationQueue"],
    docSource: "docs/extensions.md > Custom Tools > File Mutation Queue",
    detectionHints: ["readFile", "writeFile", "appendFile"],
    notes: "Required for correctness in parallel tool execution"
  },
  "output-truncation": {
    apis: ["truncateHead", "truncateTail", "truncateLine", "formatSize", "DEFAULT_MAX_BYTES", "DEFAULT_MAX_LINES"],
    docSource: "docs/extensions.md > Custom Tools > Output Truncation",
    detectionHints: [".slice(", ".substring(", "Buffer.byteLength", "maxBytes", "maxLines"],
    notes: "Manual truncation with ad-hoc logic"
  },
  "state-management": {
    apis: ["pi.appendEntry", "details field in tool result"],
    docSource: "docs/extensions.md > State Management",
    detectionHints: ["^let ", "^const .*= []", "^const .*= new Map", "readFile.*JSON", "writeFile.*JSON"],
    notes: "Module-level mutable state that accumulates across turns"
  },
  "tool-rendering": {
    apis: ["theme.fg", "theme.bg", "theme.bold", "highlightCode", "getLanguageFromPath", "getMarkdownTheme", "keyHint"],
    docSource: "docs/extensions.md > Custom Tools > Custom Rendering, docs/tui.md",
    detectionHints: ["\\x1b[", "\\033[", "\u001b[", "ANSI", "tokenize", "colorize"],
    notes: "Direct ANSI codes instead of theme functions; custom syntax highlighting"
  },
  "bash-execution": {
    apis: ["pi.exec", "createLocalBashOperations", "createBashTool"],
    docSource: "docs/extensions.md > ExtensionAPI Methods > pi.exec",
    detectionHints: ["child_process", "execSync", "spawn", "exec("],
    notes: "Direct child_process instead of pi.exec()"
  },
  "tool-operations": {
    apis: ["createReadTool", "createBashTool", "createWriteTool", "createEditTool",
           "ReadOperations", "BashOperations", "WriteOperations", "EditOperations",
           "LsOperations", "GrepOperations", "FindOperations", "createLocalBashOperations"],
    docSource: "docs/extensions.md > Custom Tools > Tool Operations",
    detectionHints: ["registerTool.*read", "registerTool.*bash", "registerTool.*write", "registerTool.*edit"],
    notes: "Full tool reimplementation when operations wrapper suffices"
  },
  "keybinding-handling": {
    apis: ["matchesKey", "Key.up", "Key.down", "Key.enter", "Key.escape", "Key.ctrl",
           "Key.shift", "Key.alt", "Key.ctrlShift", "Key.space", "Key.backspace",
           "Key.delete", "Key.home", "Key.end", "Key.tab"],
    docSource: "docs/tui.md > Keyboard Input",
    detectionHints: ["\\x1b[A", "\\x1b[B", "\\x1b[C", "\\x1b[D", "charCodeAt", "keyCode"],
    notes: "Raw escape sequences instead of matchesKey/Key.*"
  },
  "syntax-highlighting": {
    apis: ["highlightCode", "getLanguageFromPath"],
    docSource: "docs/extensions.md > Custom Tools > Custom Rendering",
    detectionHints: ["tokenize", "syntaxHighlight", "colorize", "codeHighlight"],
    notes: "Custom tokenizer + ANSI mapping instead of highlightCode()"
  },
  "compaction-customization": {
    apis: ["session_before_compact", "session_before_tree", "serializeConversation", "convertToLlm"],
    docSource: "docs/compaction.md > Custom Summarization via Extensions",
    detectionHints: ["getBranch", "getEntries", "summarize", "compact"],
    notes: "Manual session walking + cut point logic"
  },
  "session-management": {
    apis: ["ctx.newSession", "ctx.fork", "ctx.switchSession", "ctx.navigateTree", "ctx.reload"],
    docSource: "docs/extensions.md > ExtensionCommandContext",
    detectionHints: [".jsonl", "writeFile.*session", "SessionManager."],
    notes: "Direct JSONL file manipulation instead of session API"
  },
  "provider-registration": {
    apis: ["pi.registerProvider", "pi.unregisterProvider"],
    docSource: "docs/extensions.md > ExtensionAPI Methods > pi.registerProvider",
    detectionHints: ["registerProvider", "fetch.*models", "baseUrl", "apiKey"],
    notes: "Manual model discovery + fetch instead of registerProvider"
  },
  "editor-replacement": {
    apis: ["CustomEditor base class", "ctx.ui.setEditorComponent"],
    docSource: "docs/tui.md > Pattern 7: Custom Editor",
    detectionHints: ["class.*Editor", "extends.*Editor", "setEditorComponent"],
    notes: "Full editor from scratch instead of extending CustomEditor"
  },
  "message-injection": {
    apis: ["pi.sendMessage", "pi.sendUserMessage"],
    docSource: "docs/extensions.md > ExtensionAPI Methods",
    detectionHints: ["appendMessage", "sessionManager.*append"],
    notes: "Direct session manager manipulation instead of sendMessage/sendUserMessage"
  },
  "autocomplete-provider": {
    apis: ["ctx.ui.addAutocompleteProvider"],
    docSource: "docs/extensions.md > Custom UI > Autocomplete Providers",
    detectionHints: ["autocomplete", "autoComplete", "getSuggestions", "applyCompletion", "triggerCharacters"],
    notes: "Full autocomplete system instead of provider hook"
  },
  "widgets-status-footer": {
    apis: ["ctx.ui.setStatus", "ctx.ui.setWidget", "ctx.ui.setFooter", "ctx.ui.setWorkingIndicator", "ctx.ui.setTheme"],
    docSource: "docs/extensions.md > Custom UI > Widgets, Status, Footer",
    detectionHints: ["custom footer", "setWidget", "setStatus"],
    notes: "Custom rendering for what built-in methods handle"
  }
};
```

The catalog is NOT written to a file. It is built in your reasoning by reading the live docs. This guarantees freshness.

**Important:** If you find a built-in API in the docs that is not in the catalog template above, add it to your mental catalog. The catalog must reflect what is actually in the docs, not a predetermined list.

### Phase 2 — Code Understanding

Read the full extension before hunting. Use `read` to load all files.

For subdirectory extensions:

```bash
ls -la /home/miria/git/main/.pi/extensions/<name>/
read /home/miria/git/main/.pi/extensions/<name>/index.ts
read /home/miria/git/main/.pi/extensions/<name>/<other-files>.ts
# Also check package.json for dependencies
read /home/miria/git/main/.pi/extensions/<name>/package.json 2>/dev/null || true
```

For single-file extensions:

```bash
read /home/miria/git/main/.pi/extensions/<name>.ts
```

Understand:

- Purpose (what does it register? tool? command? event handler?)
- Every import from pi packages, node built-ins, npm packages
- Every `ctx.ui.*` call (custom, select, confirm, input, notify, setStatus, setWidget, setFooter)
- Every tool registration (name, parameters, execute)
- Every event handler (pi.on)
- Every state management pattern (module-level vars, pi.appendEntry, files)
- Every file operation (readFile, writeFile, withFileMutationQueue, or ad-hoc)
- Every bash/command execution (pi.exec, execSync, spawn, child_process)
- Every truncation or output formatting
- Every custom rendering (renderCall, renderResult, custom components)
- Every keybinding or terminal input handling
- Every session management (new, fork, switch, navigate)
- Every compaction or summarization hook
- Every editor or UI component replacement

**Cross-reference each pattern** against the catalog built in Phase 1.5. For each custom pattern found, check if a pi built-in API exists for it.

### Phase 3 — Reinvention Detection Techniques (Conditional)

**Do NOT loop through all 17+ techniques.** Select techniques based on extension profile from Phase 1b:

| If extension has... | Apply techniques... |
|---------------------|-------------------|
| `registerTool` | 2, 3, 5, 7, 17, 18, 22 |
| `ctx.ui.*` calls | 1, 15, 16 |
| `ctx.ui.custom()` | 1, 21 |
| `child_process` / `execSync` / `spawn` | 6 |
| `readFile` / `writeFile` (in tool execute) | 2 |
| `class.*Editor` / `extends` | 8, 13, 20 |
| `on(\"input\"` / `sessionManager` | 11, 14 |
| `session_before_compact` / `summarize` | 10 |
| `registerProvider` / `fetch.*/v1/models` | 12 |
| `autocomplete` / `getSuggestions` | 15 |
| Hardcoded key strings / ANSI codes | 8, 19 |

For each technique applied, document what you checked and whether found anything. Assign a **confidence level** and **LOC reduction estimate**.

**Confidence scale:**

| Confidence | Meaning | Typical for |
|-----------|---------|-------------|
| 100% | Certain — custom code directly replaces a pi built-in with identical semantics | Simple dialog replaceable by `ctx.ui.confirm` |
| 90% | Strong — custom code serves same purpose as pi built-in, minor behavioral differences | File mutation without queue, state via files |
| 70% | Likely — custom code overlaps significantly with pi built-in but has unique features | Custom UI component that could partially use built-in dialogs |

**Priority heuristic:** File findings with higher LOC reduction potential first. More saved lines = better issue.

---

#### Technique 1: Custom UI Dialogs / Selection

Detection: Extension implements its own interactive dialogs, selectors, confirmations, or text inputs using `ctx.ui.custom()` with manual keyboard handling, rendering, and state management.

**Cross-reference against live docs:** Read the "Dialogs" section of `docs/extensions.md`. Confirm the available APIs (`ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input`, `ctx.ui.editor`, `ctx.ui.notify`). Check if they support timeout and AbortSignal.

**Detection patterns:**

```bash
ripgrep_search "ctx\.ui\.custom" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "handleInput" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "SelectList|SettingsList" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- `ctx.ui.custom()` used where interaction is a simple pick/confirm/input
- Custom `handleInput()` with `Key.up`, `Key.down`, `Key.enter`, `Key.escape`
- Custom `render(width)` for what could be a one-liner dialog

**False positive check:** Skip if custom UI has features not in built-in dialogs (live search with real-time filtering, multi-select, inline editing, animated transitions, streaming content).

**Confidence:** 90% for simple select/confirm/input replacements. 70% for complex custom UI.

---

#### Technique 2: File Mutation Without Queue

Detection: Extension reads, modifies, and writes files using `fs.readFile`/`fs.writeFile` without wrapping in `withFileMutationQueue()`.

**Cross-reference against live docs:** Read the "File Mutation Queue" section in `docs/extensions.md`. Find the exact import path, function signature, and usage example.

**Detection patterns:**

```bash
ripgrep_search "readFile|writeFile|appendFile|unlink|rm" /home/miria/git/main/.pi/extensions/<name>/index.ts
ripgrep_search "withFileMutationQueue" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- `readFile` / `writeFile` in tool `execute()` without `withFileMutationQueue`
- Absence of `import { withFileMutationQueue }`

**Rule:** Any custom tool mutating a file that could run in parallel with built-in `edit`/`write` tools MUST use the queue.

**Confidence:** 100%.

---

#### Technique 3: Custom Output Truncation

Detection: Manual line counting, byte truncation, or output size limiting instead of pi's truncation utilities.

**Cross-reference against live docs:** Read the "Output Truncation" section in `docs/extensions.md`. Find `truncateHead`, `truncateTail`, `truncateLine`, `formatSize`, `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`.

**Detection patterns:**

```bash
ripgrep_search "\.slice\(0|\.substring\(|\.length.*>|maxBytes|maxLines" /home/miria/git/main/.pi/extensions/<name>/index.ts
ripgrep_search "Buffer\.byteLength|new TextEncoder" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "truncateHead|truncateTail|truncateLine|formatSize" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 4: Custom State Management

Detection: Module-level mutable state, files on disk, or environment variables instead of `pi.appendEntry()` and `details` field.

**Cross-reference against live docs:** Read the "State Management" section in `docs/extensions.md`. Note the pattern: `pi.appendEntry()` for persistence, `details` field in tool result for branching support, reconstruct from session entries on `session_start`.

**Detection patterns:**

```bash
ripgrep_search "^let |^const .*= \[\]|^const .*= new Map|^const .*= new Set" /home/miria/git/main/.pi/extensions/<name>/index.ts
ripgrep_search "writeFile.*JSON|readFile.*JSON|mkdir.*state|\.json" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "appendEntry" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 5: Custom Tool Rendering

Detection: Tool implements `renderCall`/`renderResult` with direct ANSI escape codes, custom Box, custom syntax highlighting, instead of using pi's theme functions and `highlightCode()`.

**Cross-reference against live docs:** Read the "Custom Rendering" section in `docs/extensions.md`. Find `theme.fg()`, `theme.bg()`, `theme.bold()`, `highlightCode()`, `getLanguageFromPath()`, `getMarkdownTheme()`, `keyHint()`. Read `docs/tui.md` for component API.

**Detection patterns:**

```bash
ripgrep_search "\\x1b\[|\\033\[|\u001b\[" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "highlightCode|getLanguageFromPath" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "new Box|paddingX|paddingY|bgFn" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 100% for direct ANSI codes. 90% for custom syntax highlighting.

---

#### Technique 6: Custom Bash Execution

Detection: Extension uses `execSync`, `spawn`, `exec` directly instead of `pi.exec()`.

**Cross-reference against live docs:** Read the `pi.exec()` section in `docs/extensions.md`. Note signature: `pi.exec(command, args[], options?)` returning `{ stdout, stderr, code, killed }`.

**Detection patterns:**

```bash
ripgrep_search "child_process|execSync|execFileSync|spawn|spawnSync|exec\(" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "pi\.exec\(" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 7: Custom Tool Operations

Detection: Full tool reimplementation when only a small operations wrapper is needed.

**Cross-reference against live docs:** Read the "Tool Operations" section in `docs/extensions.md`. Find `createReadTool`, `createBashTool`, `createLocalBashOperations`, `ReadOperations`, `BashOperations` etc.

**Detection patterns:**

```bash
ripgrep_search "createReadTool|createBashTool|createWriteTool|createEditTool|createLocalBashOperations" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "registerTool.*read|registerTool.*bash|registerTool.*write|registerTool.*edit" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 8: Custom Keybinding Handling

Detection: Raw terminal escape sequences for key detection instead of `matchesKey()` / `Key.*`.

**Cross-reference against live docs:** Read the "Keyboard Input" section in `docs/tui.md`. Find `matchesKey`, `Key.up`, `Key.enter`, `Key.ctrl("c")`, etc.

**Detection patterns:**

```bash
ripgrep_search "\\x1b\[A|\\x1b\[B|\\x1b\[C|\\x1b\[D|\\u001b\[|\\033\[" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "charCodeAt|\.codePointAt|keyCode|which" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "matchesKey" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 100%.

---

#### Technique 9: Custom Syntax Highlighting

Detection: Custom tokenizer, ANSI color mapping for code instead of `highlightCode()`.

**Cross-reference against live docs:** Read the "Custom Rendering" section in `docs/extensions.md` for `highlightCode` and `getLanguageFromPath`.

**Detection patterns:**

```bash
ripgrep_search "tokenize|syntax.*highlight|codeHighlight|colorize" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "\.endsWith\(|\.match\(\/.*\\..*ext|extname" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "highlightCode|getLanguageFromPath" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 10: Custom Compaction / Summarization

Detection: Manual session walking, token counting, cut point logic instead of `session_before_compact` event with `serializeConversation()` / `convertToLlm()`.

**Cross-reference against live docs:** Read the "Custom Summarization via Extensions" section in `docs/compaction.md`. Find `session_before_compact`, `serializeConversation`, `convertToLlm`, `session_before_tree`. Note the preparation object fields.

**Detection patterns:**

```bash
ripgrep_search "getBranch|getEntries|getLeafId|sessionManager" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "summarize|compact|compress" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "session_before_compact" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 70%.

---

#### Technique 11: Custom Session Management

Detection: Manual session file manipulation, JSONL construction instead of `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`.

**Cross-reference against live docs:** Read the "ExtensionCommandContext" section in `docs/extensions.md`. Find `newSession()`, `fork()`, `switchSession()`, `navigateTree()`, `reload()`.

**Detection patterns:**

```bash
ripgrep_search "\.jsonl|writeFile.*session|readFile.*session|SessionManager\." /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "newSession|fork\(|switchSession|navigateTree" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 12: Custom Provider Registration

Detection: Manual model fetch, response parsing, and provider config construction.

**Cross-reference against live docs:** Read the `pi.registerProvider()` section in `docs/extensions.md`. Find the provider config shape, `oauth`, `streamSimple`.

**Detection patterns:**

```bash
ripgrep_search "export default async function.*pi" /home/miria/git/main/.pi/extensions/<name>/index.ts
ripgrep_search "registerProvider" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 70%.

---

#### Technique 13: Custom Editor Implementation

Detection: Full editor from scratch instead of extending `CustomEditor`.

**Cross-reference against live docs:** Read the "Custom Editor" section in `docs/tui.md` (Pattern 7). Find `CustomEditor` base class, `setEditorComponent`, `getEditorComponent`.

**Detection patterns:**

```bash
ripgrep_search "setEditorComponent|CustomEditor" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "class.*Editor" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 14: Custom Message Injection

Detection: Direct session manager manipulation instead of `pi.sendMessage()` / `pi.sendUserMessage()`.

**Cross-reference against live docs:** Read the `pi.sendMessage()` and `pi.sendUserMessage()` sections in `docs/extensions.md`. Note `deliverAs`, `triggerTurn` options.

**Detection patterns:**

```bash
ripgrep_search "appendMessage|sessionManager.*append" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "sendMessage|sendUserMessage" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 100%.

---

#### Technique 15: Custom Autocomplete

Detection: Full autocomplete system instead of `addAutocompleteProvider`.

**Cross-reference against live docs:** Read the "Autocomplete Providers" section in `docs/extensions.md`. Find `addAutocompleteProvider`, `triggerCharacters`, `getSuggestions`, `applyCompletion`.

**Detection patterns:**

```bash
ripgrep_search "autocomplete|autoComplete|getSuggestions|applyCompletion|triggerCharacters" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "addAutocompleteProvider" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 16: Custom Theme / Widget / Footer

Detection: Manual theme management, footer rendering, widget rendering instead of built-in `setTheme`, `setFooter`, `setWidget`, `setStatus`.

**Cross-reference against live docs:** Read the "Widgets, Status, Footer" section in `docs/extensions.md`. Find `setStatus`, `setWidget`, `setFooter`, `setTheme`, `getAllThemes`, `setWorkingIndicator`.

**Detection patterns:**

```bash
ripgrep_search "theme.*json|\.pi/themes|setTheme|getTheme|getAllThemes" /home/miria/git/main/.pi/extensions/<name>/
```

**Confidence:** 90%.

---

#### Technique 17: Missing prepareArguments

Detection: Argument migration logic inside `execute()` or deprecated fields in parameters schema instead of `prepareArguments()` hook.

**Cross-reference against live docs:** Read the "Tool Definition" section in `docs/extensions.md`. Find `prepareArguments`.

**Detection patterns:**

```bash
ripgrep_search "prepareArguments" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- `execute()` starts with argument migration/compatibility shim
- Parameters schema includes deprecated fields with `Type.Optional()`

**Confidence:** 90%.

---

#### Technique 18: Missing onUpdate Streaming

Detection: Tool `execute()` builds full result in memory and returns at once instead of streaming progress via `onUpdate()`.

**Cross-reference against live docs:** Read the "Tool Definition" section of `docs/extensions.md`. Find `onUpdate` in the execute signature.

**Detection patterns:**

```bash
ripgrep_search "onUpdate" /home/miria/git/main/.pi/extensions/<name>/index.ts
ripgrep_search "accumulat|buffer|join|push.*result" /home/miria/git/main/.pi/extensions/<name>/index.ts
```

**What to look for:**
- Tool returns a single large content block without intermediate `onUpdate` calls
- Long-running operations (search, aggregation) that could show progress
- Accumulation pattern: `results.push(...)` then return all at once

**False positive check:** Skip if tool execution is trivially fast (<500ms) or streaming would add complexity without user benefit.

**Confidence:** 70%.

---

#### Technique 19: Hardcoded Keybinding Hints (Missing keyHint)

Detection: Tool `renderCall`/`renderResult` hardcodes key labels ("⌘K", "Ctrl+P", "↑/↓") instead of using `keyHint()`.

**Cross-reference against live docs:** Read "Custom Rendering" section of `docs/extensions.md`. Find `keyHint()`, `keyText()`, `rawKeyHint()`.

**Detection patterns:**

```bash
ripgrep_search "\\u2318|\\u2303|\\u21e7|\\u2325|Ctrl[+-]|Alt[+-]|Shift[+-]|Cmd[+-]|Meta[+-]|⌘|⌃|⇧|⌥" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "keyHint" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- `renderCall` / `renderResult` with hardcoded key labels in string literals
- No `keyHint()` usage despite showing keyboard shortcuts

**False positive check:** Skip if using `rawKeyHint()` which is also acceptable.

**Confidence:** 100%.

---

#### Technique 20: Manual Editor Text / Paste Reimplementation

Detection: Extension reimplements cursor management, paste handling, or editor text manipulation instead of using `ctx.ui.setEditorText()`, `ctx.ui.getEditorText()`, `ctx.ui.pasteToEditor()`.

**Cross-reference against live docs:** Read the "Custom Editor" section in `docs/extensions.md`. Find `setEditorText`, `getEditorText`, `pasteToEditor`.

**Detection patterns:**

```bash
ripgrep_search "setEditorText|getEditorText|pasteToEditor" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "selectionStart|selectionEnd|cursorPos|insertText|replaceSelection|clipboard|paste" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- Custom editor with manual cursor state, clipboard handling, paste parsing
- Text insertion logic that could use `pasteToEditor()`

**False positive check:** Only applies to extensions that register a `CustomEditor` subclass or call `setEditorComponent`.

**Confidence:** 90%.

---

#### Technique 21: Manual Overlay Implementation

Detection: Extension implements floating/modal UI on top of content using raw terminal escapes or manual positioning instead of `ctx.ui.custom(..., { overlay: true })` with `overlayOptions`.

**Cross-reference against live docs:** Read the "Custom Components" section in `docs/extensions.md`. Find `overlay`, `overlayOptions`, `onHandle`.

**Detection patterns:**

```bash
ripgrep_search "ctx\.ui\.custom" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "overlay|modal|float|popup|dialog" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- `ctx.ui.custom()` without `{ overlay: true }` that renders a floating/modal interface
- Manual ANSI positioning or save/restore cursor for overlay effects

**Confidence:** 70%.

---

#### Technique 22: Missing renderShell: "self"

Detection: Tool that needs full control over its visual shell uses the default `Box` wrapper instead of setting `renderShell: "self"`.

**Cross-reference against live docs:** Read the "Custom Rendering" section of `docs/extensions.md`. Find `renderShell: "self"`.

**Detection patterns:**

```bash
ripgrep_search "renderShell" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "new Box|paddingX|paddingY|bgFn" /home/miria/git/main/.pi/extensions/<name>/
```

**What to look for:**
- Tool with `renderCall`/`renderResult` that manually wraps in `new Box(...)` with custom padding/background
- Tool returning `Text` with padding args beyond (0,0) to compensate for Box default

**False positive check:** Skip if default Box styling is acceptable. Only flag if tool explicitly fights the Box (manual padding compensation, redundant background).

**Confidence:** 70%.

---

### Phase 4 — Finding Validation (Proof Requirement)

Every suspected reinvention finding MUST have deterministic proof. Rule: **"Cross-reference three sources"** — three independent confirmations before filing.

#### Proof Checklist

Each finding must include ALL of:

1. **Code evidence** — Exact lines showing custom implementation
   ```
   File: path/to/file.ts, line 42-55
   ```

2. **Pi documentation reference** — Direct quote from the LIVE docs you read in Phase 1.5
   ```
   Source: docs/extensions.md (section "Custom UI > Dialogs"), read during Phase 1.5
   Quote: "const choice = await ctx.ui.select('Pick one:', ['A', 'B', 'C']);"
   ```

3. **Why the built-in API fits** — Explanation of why the pi built-in is a direct replacement for the custom code, based on what you read in the docs.

4. **Migration steps** — Step-by-step replacement showing old code → new code, using the EXACT API signature you found in the docs.

5. **Confidence score** — Assign 70/90/100% with justification

6. **LOC reduction estimate** — Precise line count of custom code removed vs built-in code added
   ```
   LOC change: -42 lines (custom) + 3 lines (built-in) = -39 lines net
   ```

#### False Positive First Aid

Before filing, run through this checklist:

1. **Does the custom code do MORE than the pi built-in?** — If the custom implementation has features the built-in lacks, it's not a pure reinvention. Skip or flag at 70%.
2. **Is the built-in API actually unsuitable?** — Verify by re-reading the relevant doc section. Some cases legitimately need lower-level control.
3. **Is the extension older than the pi built-in?** — The extension may predate the API. Still valid to file with migration steps.
4. **Is it a performance-sensitive path?** — Direct child_process calls may be intentional for latency. Verify by reading the docs for `pi.exec()` to see if it has overhead.
5. **Is it cross-platform code?** — Some extensions work outside pi (standalone CLI tools) and can't depend on pi APIs. Skip.
6. **Is there a comment explaining why pi APIs aren't used?** — Respect documented decisions but verify the reasoning is still valid against current docs.

### Phase 5 — GitHub Issue Creation

Only create issue after proof is complete. Use `gh issue create` via `bash gh`.

#### Issue Template

Each issue body references the live documentation source with the doc file and section you read during Phase 1.5.

```
**Extension:** <name>
**Technique:** <technique name>
**Confidence:** <70%/90%/100%>
**Severity:** <P0/P1/P2/P3>
**Custom LOC:** <lines of custom code>
**Built-in LOC:** <lines after migration>
**Net LOC change:** <negative = reduction>
**Doc source:** <docs/xxx.md section, read during Phase 1.5>

## Description
<clear description of the reinvention pattern, which pi built-in is being reimplemented, and why migration is beneficial>

## Proof

### Code Evidence (Custom Implementation)
```

File: path/to/file.ts, line N-M
<code snippet showing custom implementation>

```

### Pi Documentation Reference

Source: `<path-to-docs>/docs/<file>.md`, section "<section name>"
Quote: `<direct quote showing built-in API>`
(Verified during Phase 1.5 live docs analysis)

### Why the Built-in API Fits
<explanation of why pi's API is a direct replacement>

### Migration Steps

1. Replace `<custom code>` with `<built-in API call>`
2. Remove imports no longer needed: `<list>`
3. Update type signatures if applicable

**Before (custom):**
```typescript
<current code>
```

**After (using pi built-in):**
```typescript
<migrated code>
```

### Confidence Assessment
<why this is 70/90/100%>

### LOC Impact
- Custom implementation: <N> lines
- Built-in replacement: <M> lines
- Net change: <+/-N> lines

## Suggested Fix
<optional: PR-ready code change>
```

#### Severity Guide

| Severity | Criteria |
|----------|----------|
| P0 | Bug-causing reinvention (missing `withFileMutationQueue` causes data loss) |
| P1 | Security or correctness issue (custom bash exec without signal handling) |
| P2 | Significant code bloat (50+ custom LOC replaceable by 5 LOC built-in) |
| P3 | Minor cleanup (<50 LOC, stylistic, or low-priority modernization) |

#### Issue Creation Command

```bash
# Write body to temp file
cat > ignore/reinvention-report-<ext-name>-<seq>.md << 'ISSUEOF'
<body content>
ISSUEOF

gh issue create \
  --repo "$(grep -o '"repo"[^,]*' /home/miria/git/main/.pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/')" \
  --title "Reinvention: <ext-name> - <short description>" \
  --label "reinvention" \
  --body-file ignore/reinvention-report-<ext-name>-<seq>.md
```

#### Labels

Always add `reinvention` label. Add severity label if exists. If `reinvention` label does not exist, use `enhancement` instead.

#### Existing Issues Check

```bash
gh issue list --repo <repo> --label reinvention --state open --json title --limit 30 \
  | grep -i "<keyword>"
```

#### Hunt Clustering

When filing multiple issues in one hunt session:

1. Create session label before first issue:
   ```bash
   gh label create "reinvention-<ext-name>-<YYYYMMDD>" --repo <repo> --color "#5319E7" --description "Reinvention findings from <ext-name> hunt on <date>" 2>/dev/null || true
   ```
2. File all issues, collect numbers
3. Update each issue body with `## Related Issues` section
4. Post tracking comment on first/root issue

### Phase 6 — Report

After all issues filed, output summary.

```
## Reinvention Hunt Report

**Extension:** <name>
**Session label:** reinvention-<ext-name>-<YYYYMMDD>
**Pi docs analyzed:**
  - docs/extensions.md (sections: Dialogs, File Mutation Queue, State Management, Custom Rendering, Output Truncation, Tool Operations, pi.exec, pi.sendMessage, Custom UI, Autocomplete Providers, Session Management, Provider Registration, prepareArguments)
  - docs/tui.md (sections: Keyboard Input, Built-in Components, Custom Editor)
  - docs/compaction.md (sections: Custom Summarization via Extensions)
**Files analyzed:** <count>
**Total lines:** <approximate>
**Techniques applied:** <list>

### Findings

| # | Technique | Confidence | Severity | Custom LOC | Net Change | Issue |
|---|-----------|------------|----------|-----------|------------|-------|
| 1 | custom-ui-dialogs | 90% | P2 | 42 | -39 | [#123](url) |
| 2 | file-mutation-queue | 100% | P0 | 8 | +5 | [#124](url) |

### Summary
<total findings, total filed, any skips with reason>
<total estimated LOC saved across all findings>

### LOC Impact Summary
| Metric | Value |
|--------|-------|
| Total custom LOC removed | <N> |
| Total built-in LOC added | <M> |
| **Net LOC reduction** | **<+/-N>** |

### Cluster
All issues share label \`reinvention-<ext-name>-<YYYYMMDD>\`:
\`\`\`bash
gh issue list --repo <repo> --label "reinvention-<ext-name>-<YYYYMMDD>" --state open
\`\`\`
```

## Rules

1. **Hunt until all filed** — Loop through extensions until ALL valid findings are filed or all exhausted.
2. **One finding per issue** — Each finding gets its own issue. No batching.
3. **Proof or skip** — No speculative findings. Ambiguous = skip.
4. **Cross-reference three sources** — code evidence + live pi doc quote + migration steps minimum.
5. **No duplicate** — Check existing open issues first.
6. **File cleanup** — Delete temp files after issue creation.
7. **Track picked extensions** — Never re-pick same extension within one invocation.
8. **LOC reduction is the quality metric** — The ultimate goal is fewer lines of code. Estimate precisely.
9. **Prefer 100% findings first** — File most certain findings with largest LOC reduction potential first.
10. **All exhausted = report** — If every extension checked and zero findings, output full report.
11. **Respect documented decisions** — If code has `// pi:skip-queue-reason: <reason>`, honor it.
12. **Live docs, not memory** — Re-read the relevant doc section for each finding. Do not rely on memory of what the API looks like. The docs are the authoritative source.
13. **Report doc freshness** — In the Phase 6 report, list which doc files and sections were read. This documents what was verified.
14. **Catalog is ephemeral** — The API catalog built in Phase 1.5 exists only during this hunt session. Next invocation rebuilds it from scratch.
