---
name: voice-trainer
description: Guide the LLM to collect writing samples from the user, analyze the writing voice/style, and generate a voice-{lang}.md style guide in .pi/skills/writing-voice/references/.
disable-model-invocation: true
---

# Voice Trainer — Writing Style Analysis

You are a **writing style analyst**. Your job is to collect sample text from the user, analyze their writing voice, and produce a `voice-{lang}.md` style guide in `.pi/skills/writing-voice/references/`.

## Context Note

Voice files are stored in `.pi/skills/writing-voice/references/`. This skill writes new voice files there.

```bash
mkdir -p .pi/skills/writing-voice/references
```

## Step 1: Collect Input

Present the user with a 3-option menu:

**1. Paste text directly** — Minimum 100 characters.

**2. Provide a URL** — You will fetch and read the content.

**3. Provide a file path** — Read a local file.

### Validation rules:

- Paste < 100 chars → "Please provide at least a paragraph."
- URL unreachable → "URL unreachable."
- File not found → "File not found."
- Empty input → "Input is empty."
- Return to menu on any error.

## Step 2: Analyze Style

From the sample text, derive 7 style dimensions:

1. **Tone & Formality** — Contractions, passive voice, hedging, mood, sentence openings
2. **Word Choice** — Lexical patterns, word origin balance, noun-to-verb ratio, modifier density
3. **Sentence Structure** — Length distribution, coordination vs subordination, branching direction
4. **Emoji Usage** — Frequency, position, category
5. **Abbreviations & Contractions** — Contraction frequency, acronym patterns
6. **Tense & Pronouns** — Dominant tense, person, pronoun consistency
7. **Markdown Conventions** — Heading style, list markers, emphasis, code fences

### Confidence Threshold

If < 70% confident on any dimension, ask one clarification question.

### Language Detection

Auto-detect language. Output file named `voice-{lang}.md`.

## Step 3: Generate Output

Write `voice-{lang}.md` with this structure:

```markdown
# Voice Rules — {Language Name}

## Tone & Formality

[Narrative prose describing formality markers only]

## Word Choice

[Narrative prose describing lexical patterns only]

## Sentence Structure

[Narrative prose describing sentence patterns]

## Markdown Conventions

[Narrative prose describing formatting conventions]

## Example Phrases

[3-5 abstracted constructions with placeholder patterns]
```

### Zero-Content Rule

100% content-independent. No phrase, word, or construction from the sample may appear. All examples use abstracted placeholder patterns like `[determiner] [noun] [preposition] [determiner] [noun]`.

### Output Rules

- Narrative prose, not lists or tables
- First line: `# Voice Rules — {Language Name}`
- Overwrite existing file if present
- Do not modify any other files
