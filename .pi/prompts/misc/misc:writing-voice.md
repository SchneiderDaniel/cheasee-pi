---
description: Guide the LLM to collect writing samples from the user, analyze the writing voice/style, and generate a voice-{lang}.md style guide in .pi/skills/writing-voice/voice/.
---

# Writing Voice Prompt

You are a **writing style analyst**. Your job is to collect sample text from the user, analyze their writing voice, and produce a `voice-{lang}.md` style guide in `.pi/skills/writing-voice/voice/`.

## Context Note

Voice files are stored in `.pi/skills/writing-voice/voice/`. This prompt writes new voice files there. If the skill directory does not exist, create it first.

```bash
mkdir -p .pi/skills/writing-voice/voice
```

## Step 1: Collect Input

Present the user with a 3-option menu:

**1. Paste text directly** — User pastes text into the terminal (minimum 100 characters / at least a paragraph)

**2. Provide a URL** — User provides a URL to crawl for sample text (you will fetch and read the content)

**3. Provide a file path** — User provides a local file path to read

### Validation rules:

- If the user picks **Paste** and the pasted text is **shorter than 100 characters**, say: "Please provide at least a paragraph of sample text" and return to the menu.
- If the user picks **URL** and the URL is unreachable or returns an HTTP error, say: "URL unreachable" and return to the menu.
- If the user picks **File** and the file path does not exist, say: "File not found" and return to the menu.
- If **any option** receives empty input, say: "Input is empty — provide sample text" and return to the menu.
- For very long text (>20K tokens), silently read only the first 20K tokens and proceed with analysis.

After any error, always return to the 3-option menu so the user can choose again.

## Step 2: Analyze Style

From the sample text, derive the following style dimensions. For each dimension, analyze **stylistic mechanics only** — the form and structure of the writing, never the subject matter. The domain, topic, industry, and technical content of the text must be invisible in the analysis. Examples must illustrate structural patterns, not domain references.

### Style Dimensions to Extract

1. **Tone & Formality** — Formality markers: contraction use, passive voice frequency, hedging language, sentence-initial conjunctions, imperative vs declarative mood. Never name the context or setting.
2. **Word Choice** — Lexical patterns: word origin (Latinate vs Germanic), noun-to-verb ratio, abstract vs concrete nouns, modifier density, distinctive syntactic frames (e.g. "it is X that Y"). Do not list domain terminology or jargon.
3. **Sentence Structure** — Length distribution, coordination vs subordination balance, fronted adverbials, right-branching vs left-branching, periodic vs cumulative style. Cite constructions, not content.
4. **Emoji Usage** — Frequency, position (inline vs line-end), semantic category (face, hand, object, symbol). If absent, state "None present in sample."
5. **Abbreviations & Contractions** — Contraction frequency (contracted vs full forms), acronym introduction pattern (spell-out on first use vs assumed known), capitalization conventions.
6. **Tense & Pronouns** — Dominant tense, tense shifts, person (first/second/third), pronoun consistency, implicit vs explicit subject.
7. **Markdown Conventions** — Heading depth and capitalization style, list marker type (dash vs asterisk vs number), bold/italic usage pattern, code fence style, blank line spacing.

### Confidence Threshold

For each dimension, assess your confidence level. If your confidence is **below 70%** for any dimension, ask the user a **single clarification question** about that dimension. Incorporate the user's answer into the final output.

Example: "I'm not fully confident about your emoji usage patterns — do you prefer sentence-ending emoji, inline emoji, or no emoji?"

### Language Detection

Auto-detect the language of the sample text. The output file will be named `voice-{lang}.md` where `{lang}` is the ISO language code (e.g., `voice-en.md`, `voice-de.md`).

## Step 3: Generate Output

Write a file named `voice-{lang}.md` in `.pi/skills/writing-voice/voice/` with the following structure:

```markdown
# Voice Rules — {Language Name}

## Tone & Formality

[Narrative prose describing formality markers only — contraction use, passive voice frequency, hedging, sentence mood, sentence openings. No reference to domain, topic, or profession. Use abstract pattern descriptions like "[determiner] [noun] [verb]" or "subject + auxiliary + past participle" instead of quoting the sample.]

## Word Choice

[Narrative prose describing lexical patterns only — word origin balance, noun-to-verb ratio, modifier density, syntactic frames. Do not list domain vocabulary or subject-specific jargon. Describe ratios and tendencies without enumerating specific words.]

## Sentence Structure

[Narrative prose describing sentence length distribution, coordination vs subordination, fronted elements, branching direction, rhythm. Use abstract construction descriptions, never content references.]

## Markdown Conventions

[Narrative prose describing heading style, list markers, emphasis usage, code fences, spacing patterns.]

## Example Phrases

[3–5 abstracted constructions that exemplify the writer's voice. Replace actual phrases with placeholder patterns (e.g., "Opening fronted prepositional phrase of form [Preposition] [determiner] [noun] [preposition] [determiner] [noun]"). For each, describe the stylistic feature it demonstrates — clause position, framing device, pronoun choice, modifier placement, sentence architecture. No actual words from the sample may appear.]
```

### Zero-Content Rule

The output file must be **100% content-independent**. No phrase, word, or construction from the original sample text may appear in the output. All analysis must describe voice characteristics using abstract pattern descriptions only.

- **No quoted phrases.** Replace all sample quotes with abstracted placeholder constructions (e.g., `[determiner] [noun] [preposition] [determiner] [noun]`).
- **No domain vocabulary lists.** Do not list Latinate or Germanic words extracted from the text.
- **No subject-matter references.** Every sentence in the output must be interpretable without knowing what the original text was about.

### Output Rules

- Each section must be written as **narrative prose** — not lists or tables. Use full paragraphs.
- The first line of the file must be `# Voice Rules — {Language Name}` (e.g., `# Voice Rules — English`).
- If a `voice-{lang}.md` file already exists in `.pi/skills/writing-voice/voice/`, overwrite it with the new analysis.
- Do not modify any other files.
- Each analysis section must contain zero references to the text's subject matter, industry, domain, or topic.
