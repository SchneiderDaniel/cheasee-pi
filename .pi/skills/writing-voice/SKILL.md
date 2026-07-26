---
name: writing-voice
description: "Writing style guide for project documentation. Apply before any writing summaries, docs, READMEs, guides, or any user-facing text."
---

# Writing Voice Skill

Apply stored writing voice rules when generating text for users. Reads `voice-{lang}.md` files from `references/` folder in this skill directory.

## When to Trigger — MANDATORY

You MUST trigger this skill when the task involves writing **any user-facing text**:

- Documentation
- Summaries (e.g. project overview, feature recap)
- READMEs
- Guides and tutorials
- Explanations
- User messages and responses
- Reviews
- Reports
- **Any text where you produce sentences for the user to read**

**Rule:** If user asks you to write, describe, explain, or summarize in prose → load this skill first. No exceptions.

## Reference File Location

```
.pi/skills/writing-voice/references/
└── voice-{lang}.md    (e.g. voice-en.md, voice-de.md)
```

## How It Works

### Step 1 — Detect Target Language

Determine language from:
- Explicit user request ("write in German")
- File path hints (e.g. `docs/de/`)
- ISO language code in context
- Default: English if ambiguous

### Step 2 — Load Voice Rules

Check if voice file exists for detected language:

```bash
ls references/voice-{lang}.md
```

If found, read the file relative to this skill directory:

```
read references/voice-{lang}.md
```

Extract rules and apply them.
If not found: write in neutral/default style. Optionally suggest creating voice file via `/skill:voice-trainer`.

### Step 3 — Apply Rules When Writing

When generating output, follow these rules from the voice file:

1. **Tone & Formality** — Match formality markers, passive voice frequency, hedging patterns, declarative vs imperative mood
2. **Word Choice** — Match lexical patterns: Latinate vs Germanic balance, noun-to-verb ratio, modifier density
3. **Sentence Structure** — Match sentence length, coordination vs subordination, fronted elements, branching direction
4. **Emoji Usage** — Match frequency and placement (inline vs line-end), or omit if file says none
5. **Abbreviations & Contractions** — Match contraction frequency, acronym introduction patterns
6. **Tense & Pronouns** — Match dominant tense, person (first/second/third), pronoun consistency
7. **Markdown Conventions** — Match heading style, list markers, emphasis, code fences, spacing

### Step 4 — Self-Check Before Output

Before finalizing, verify the output against each dimension in the voice file. If any dimension deviates, revise.

## Creating New Voice Files

Use `/skill:voice-trainer` to analyze writing samples and generate new voice files.

The prompt:
1. Collects sample text (paste, URL, or file)
2. Analyzes 7 style dimensions
3. Writes `voice-{lang}.md` to the `references/` folder

## Example

```
Task: Write German documentation for new feature
Agent action:
  1. Detect lang=de
  2. Read `references/voice-de.md` (resolve relative to skill dir)
  3. Apply voice rules: formal academic register, passive constructions with "werden",
     first-person plural "wir", fronted prepositional phrases, Verb-Endstellung
  4. Write documentation matching voice profile
```

## Existing Voice Files

List available voice files:

```bash
ls references/
```

## Rules

1. **Always check voice file first** before writing user-facing text
2. **If voice file missing for language**, write neutral style, note absence
3. **Zero-content rule** from source analysis does not apply here — this skill **consumes** voice files, not creates them
4. **Do not modify voice files** during consumption. Voice files are read-only reference
5. **New voice files** created via `/skill:voice-trainer` only
