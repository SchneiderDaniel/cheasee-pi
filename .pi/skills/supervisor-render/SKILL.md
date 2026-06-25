---
name: supervisor-render
description: >
  Renders the supervisor's chat messages with the REAL pi TUI — live theme
  proxy, Box, Markdown, actual ANSI render lines — so output is the bytes pi
  would draw, never hypothetical. Covers both synthetic fixtures (one per
  eventType) and full recorded-session workflow rendering (replay as-stored,
  convert old format to new eventType, or side-by-side diff). Use whenever
  you change `message-renderer.ts` or `handler.ts` event emission, or want
  to see, discuss, or iterate on what the supervisor's chat actually looks
  like. Triggers: "render supervisor", "supervisor render", "show supervisor
  output", "validate supervisor rendering", "supervisor workflow", "/supervisor-render".
---

# Supervisor Render Skill

Render supervisor messages with the real pi TUI and look at the bytes.
The whole point of this skill is to stop reasoning about rendering
hypothetically and inspect the actual ANSI lines pi would draw — for a
single event, or for an entire recorded workflow.

## When to use

- After editing `message-renderer.ts` (the `eventType` switch).
- After editing `handler.ts` event emission (`eventType` discriminator).
- Before claiming a supervisor rendering change is done.
- When the user asks to see, discuss, or improve supervisor rendering.
- When comparing the new renderer's output against a recorded run.

## Background — the two message formats

Supervisor progress is logged in `.pi/sessions/*.jsonl` as `type:
"custom_message"` records with `customType` starting with `supervisor`
(`supervisor` progress, `supervisor-warnings`, `supervisor-summary`).

There are two on-disk shapes:

**OLD format (pre-#1071 sessions)** — no `eventType`, dispatched by the
removed parallel branches:
- `details._progressUpdate: true` → phase-change header (`**⚙ agent** — Phase`)
- `details.toolCallResult: { name, args, isError, resultText, thinking, … }`
  → one-line tool summary (`tool \`args\``); `resultText` + `thinking` were
  stored but NOT rendered.
- `details._subagentResult: { content, details }` → rich subagent block.
- no details → raw `content` markdown.

**NEW format (#1071 onward)** — single `details.eventType` discriminator
(see `supervisor-events.ts`): `phase-change` | `tool-start` | `tool-complete`
| `thinking` | `error` | `budget-exceeded` | `compaction` |
`subagent-result`. The renderer switches on `eventType`; old-format
messages fall through to the default case, which renders `content` as
Markdown (so old sessions replay byte-identically).

## How to use

Run from the repo root (`node_modules/.../@earendil-works/pi-coding-agent`
must be reachable by walking up from the skill dir).

### Mode 1 — canonical fixtures (no session arg)

```bash
node --experimental-strip-types .pi/skills/supervisor-render/render.mts
```

Renders one example of every `eventType` case plus the no-eventType
fallback. Use to sanity-check the renderer after edits.

### Mode 2 — replay a recorded session as-stored

```bash
node --experimental-strip-types .pi/skills/supervisor-render/render.mts <session.jsonl>
```

Feeds every supervisor `custom_message` through the current renderer
WITHOUT converting old format. Old-format messages hit the default
Markdown fallback and MUST reproduce their stored `content`
byte-for-byte. Catches regressions on old sessions. Each message is
prefixed `── #<i> [shape] ──` where `shape` is the sorted `details` keys
(`toolCallResult` / `_subagentResult` / `_progressUpdate` / `none`).

### Mode 3 — render a session converted to the new eventType format

```bash
node --experimental-strip-types .pi/skills/supervisor-render/render.mts <session.jsonl> --convert
```

Maps OLD details shapes to the `eventType` discriminator
(`_progressUpdate`→`phase-change`, `toolCallResult`→`tool-complete`
with `name`→`toolName`, `_subagentResult`→`subagent-result`) and renders.
Shows what a NEW run of the same workflow looks like with the current
renderer — the view for discussing/iterating on rendering.

### Mode 4 — side-by-side OLD vs NEW diff of a session

```bash
node --experimental-strip-types .pi/skills/supervisor-render/render.mts <session.jsonl> --both
```

Writes `sup-<stem>.old.txt` (recorded run) and `sup-<stem>.new.txt`
(converted + rendered, ANSI stripped) to the cwd and prints the diff
command. Diff them to see exactly what the new rendering changes.

### Options (any order)

- `--strip` — strip ANSI escape codes (default: keep color)
- `--max <N>` — render only the first N supervisor messages
- `--width <W>` — render width in columns (default 90)

### Useful sessions

Any `.pi/sessions/*.jsonl` works. Pick one rich in supervisor activity:

```bash
# list sessions by supervisor-message count
for f in .pi/sessions/*.jsonl; do
  c=$(grep -c '"customType":"supervisor' "$f" 2>/dev/null || echo 0); echo "$c $f"
done | sort -rn | head
```

## Validation checklist

### Renderer correctness (Modes 1 & 3)

Read the output and confirm each against the pi-native style:

1. **tool-complete** — `Box(1,1,bgFn)` with `toolSuccessBg`/`toolErrorBg`,
   single leading space (Box padding), `✓`/`✗` icon + `toolTitle` header,
   muted stats line (`#idx · (dur) · n/max tools · tok/max tok tok` [+ `k err`]
   [+ `⚠ compacted`]), `resultText` colored `toolOutput` (match-count lines
   `success`, `file:line` rows `dim`+`accent`), `── Thinking ──` block with
   italic `thinkingText`, error reason line on errors.
2. **thinking** — Markdown with italic `thinkingText` color, no Box.
3. **subagent-result** — collapsed: 3-line Text (icon · agent — STATUS ·
   stats · summary); expanded: Container with `── Task ──`, `── Tools ──`,
   `── Output ──`, `── Thinking ──` sections + footer stats line
   (`turns · ↑in ↓out · Rcache · $cost · model · duration`).
4. **phase-change / error / budget-exceeded / compaction** — single Text,
   accent / error / warning / muted respectively.
5. **No backward-compat** — a message with `toolCallResult`/`_subagentResult`
   but no `eventType` MUST fall through to Markdown-on-content (or
   `(unhandled supervisor message)` if content is empty). If it renders the
   old rich way, the default case regressed.
6. **No exceptions, no empty renders** for any case.

### Replay safety (Mode 2)

Old-format session messages replayed as-stored MUST be byte-identical to
their stored `content` (after ANSI strip). Any difference = regression on
old sessions. To verify programmatically, compare the stripped default-case
output of each message against its stored `content`.

### Workflow comparison (Mode 4)

The new `tool-complete` route inlines full `resultText` + per-tool
`thinking`, where the old renderer showed a one-line summary. A converted
workflow is therefore far more verbose than the recorded run (observed
22× line count on a research session). This is the expected, intended
trade-off toward pi-native tool visibility — but it is the main thing to
discuss when iterating: if compactness is wanted, cap `resultText` and
gate per-tool `thinking` behind a flag.

## Known findings (from the 2026-06-23 comparison)

- Old sessions replay byte-identically through the Markdown fallback: 0
  regressions.
- New-render of the same workflow is ~22× longer, almost entirely from
  `tool-complete` inlining full `resultText` (avg ~1k chars/tool for
  `read`) + full per-tool `thinking` (avg ~250 chars), which the old
  renderer suppressed.
- Subagent-result, phase-change, thinking, error, budget, compaction all
  render correctly under the new discriminator.
- Full report + artifacts: `ignore/supervisor-render-comparison.md`.

## Files

- `render.mts` — the harness. Imports the live renderer from
  `../../extensions/supervisor/session/message-renderer.ts`, resolves the
  pi dist `theme` proxy at runtime (not re-exported by the main package,
  so it walks `import.meta.url` up to find `node_modules`), calls
  `initTheme()`, and renders at width 90 by default. Four modes, three
  flags. Outputs for `--both` go to cwd as `sup-<stem>.{old,new}.txt`.

## References

- Event contract: `.pi/extensions/supervisor/session/supervisor-events.ts`
  (the `eventType` discriminated union — single source of truth).
- Renderer: `.pi/extensions/supervisor/session/message-renderer.ts`
  (the `switch(details.eventType)`).
- Event producer: `.pi/extensions/supervisor/pipeline/handler.ts`
  (`onUpdate` emits the events).
- Pi native tool execution:
  `pi-coding-agent/dist/modes/interactive/components/tool-execution.js`
  (Box with `toolSuccessBg`/`toolErrorBg`/`toolPendingBg`).
- Pi native thinking:
  `pi-coding-agent/dist/modes/interactive/components/assistant-message.js`
  (Markdown with `thinkingText` color + italic).
- Render helpers: `.pi/extensions/supervisor/lib/render-helpers.ts`
  (`renderThinkingBlock`, `renderTextLines`).

## Notes

- The harness renders in-process and prints; no temp files of its own.
  `--both` writes two `.txt` files to the cwd — safe to delete after.
- If the theme module can't be located, pi is not installed in this
  workspace; install `@earendil-works/pi-coding-agent` first.
- Run from the repo root so the relative import of `message-renderer.ts`
  resolves.
- `supervisor-warnings` / `supervisor-summary` messages have no details
  and render via the default Markdown fallback — included in session modes
  because they start with `supervisor`.