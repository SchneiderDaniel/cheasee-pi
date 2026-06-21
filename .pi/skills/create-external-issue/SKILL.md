---
name: create-external-issue
description: "Guides the agent to autonomously file high-quality issues on external public GitHub repos. Enforces a strict 5-step checklist: read repo guidelines, read issue templates, check for duplicates, write a professional issue body with neutral reproducible examples, and file via gh issue create."
metadata:
  steps: discover-template-deduplicate-compose-file
  scope: external-public-repos-only
  dependencies: gh-cli
---

# Create External Issue Skill

Structured guidance for filing high-quality issues on **external public GitHub repositories**. Follow the 5-step checklist sequentially. Do not skip steps.

## Trigger

Load this skill when the user asks to:

- "File a bug on [library/repo]"
- "File a feature request on [repo]"
- "Report an issue on [external project]"
- "Create an issue for [problem] on [repo]"
- Any task that involves filing an issue on a repo **not owned by us**

## Preconditions

### Authentication Check

Before any step, verify `gh` is authenticated:

```bash
gh auth status
```

- If exit code is **non-zero** → stop and tell the user: "`gh` CLI is not authenticated. Run `gh auth login` to authenticate."
- If exit code is **zero** → proceed.

### Scope Gating

Evaluate before step 1. If any of the following apply, **stop and explain**:

| Condition | Response |
|-----------|----------|
| Repo is `SchneiderDaniel/cheasee-pi` | "Issues on this repo are handled by other skills (bug-hunter, reinvention-hunter)." |
| Repo is private | "This skill supports public repos only." |
| Target is GitLab, Bitbucket, or other non-GitHub platform | "This skill supports GitHub repos only." |
| User asks for a pull request | "This skill creates issues only, not pull requests." |

### Parse Target Repo

Extract `OWNER/REPO` from the user's request. The format must be `OWNER/REPO` (e.g., `lodash/lodash`, `vercel/next.js`). If the user provides a full URL, extract the `OWNER/REPO` portion.

## 5-Step Checklist

Follow these steps **in order**. Do not skip or reorder.

---

### Step 1 — Read Repo Guidelines

Fetch the target repo's contributing guidelines and list available issue templates.

**A. Fetch CONTRIBUTING.md:**

```bash
gh api repos/OWNER/REPO/contents/CONTRIBUTING.md --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "NO_CONTRIBUTING"
```

- If the file exists, read it fully. Extract any issue-format requirements, expected sections, or filing instructions.
- If the file does not exist (command returns `NO_CONTRIBUTING` or `file not found`), note this for step 4.

**B. List issue template files:**

```bash
gh api repos/OWNER/REPO/contents/.github/ISSUE_TEMPLATE --jq '.[].name' 2>/dev/null || echo "NO_TEMPLATES"
```

- Record the list of template file names (e.g., `bug_report.md`, `feature_request.yml`).
- If the directory does not exist (returns `NO_TEMPLATES` or `Not Found`), note this for step 4.

**C. Check CONTRIBUTING.md for format requirements:**

If `CONTRIBUTING.md` exists but no template directory was found, extract any issue format requirements mentioned in `CONTRIBUTING.md`. Some repos describe their expected issue format directly in `CONTRIBUTING.md` rather than providing template files. Use those requirements when composing the body in step 4 — do **not** immediately fall back to the universal format.

---

### Step 2 — Read Issue Templates

Read the remote issue template(s) to understand the expected format. Handle both `.md` (YAML frontmatter) and `.yml` (GitHub form) formats.

**A. For `.md` templates (YAML frontmatter):**

```bash
gh api repos/OWNER/REPO/contents/.github/ISSUE_TEMPLATE/TEMPLATE_NAME.md --jq '.content' | base64 -d
```

- Read the full content.
- Strip the YAML frontmatter (everything between the first `---` and the closing `---`).
- Extract all `## Section Heading` names from the markdown body. These are the required sections.
- Record the order of sections.

**B. For `.yml` form templates:**

```bash
gh api repos/OWNER/REPO/contents/.github/ISSUE_TEMPLATE/TEMPLATE_NAME.yml --jq '.content' | base64 -d
```

- Read the YAML content.
- Extract the `body` array — each entry has an `id` and a `label` field.
- Record all `id` and `label` values as the required form fields.

**C. If multiple templates exist:**

- If the user's request matches a specific template (e.g., "bug" matches `bug_report.md`), use that template.
- Otherwise, use the first `.md` template. If only `.yml` templates exist, use the first one.

---

### Step 3 — Check for Duplicates

Before writing the issue body, verify that the issue hasn't already been reported.

**A. Generate keyword permutations:**

Generate 3+ keyword permutations from the proposed issue title:

| Permutation | Example |
|-------------|---------|
| Original title | `"Crash when parsing empty array"` |
| Stripped keywords | `"crash parsing empty array"` |
| Core terms only | `"crash array parsing"` |
| Reordered | `"array empty parse crash"` |

**B. Search for each permutation:**

```bash
gh search issues "KEYWORD PERMUTATION" --repo OWNER/REPO --state open --match title --json title,number --limit 10
```

Run this for each of the 3+ keyword permutations.

**C. Evaluate results:**

For each search result, check if the title **semantically matches** the proposed issue:

- Exact match or near-exact match → **Likely duplicate**.
- Same root cause described with different wording → **Likely duplicate**.
- Addresses the same feature request → **Likely duplicate**.

**D. Action on duplicate:**

If any result looks like the same problem:

> ⚠ **Stop. Do NOT file.**
>
> Report to the user: "Likely duplicate of #N — title matches. Review before filing."

Provide the duplicate issue number and title so the user can verify.

**E. Low-confidence case:**

If results exist but no title semantically matches your issue, and your confidence is below a reasonable threshold:

> Report to the user: "Found N related issues but none match exactly. Please review before proceeding."

Do **not** file without user confirmation.

**F. No duplicates found (clean):**

Proceed to step 4.

---

### Step 4 — Write the Issue Body

Compose the issue body following the repo's conventions. Branch based on what was discovered in steps 1 and 2.

#### Case A: Repo has an issue template (from step 2)

Fill in all required sections from the template with relevant content.

- For `.md` templates: compose a body that includes each `## Section Heading` extracted in step 2A, populated with content appropriate to the issue.
- For `.yml` form templates: compose a body that addresses each `id`/`label` field extracted in step 2B.
- Follow the template's section order exactly.

#### Case B: No template and no CONTRIBUTING.md

Use the **Universal Fallback Format** (see section below).

#### Case C: CONTRIBUTING.md exists but no templates

Use the format described in `CONTRIBUTING.md`. Extract section requirements, expected fields, and formatting conventions from the contributing guide. Do **not** fall back to the universal format.

#### Writing Rules (apply to all cases)

1. **Neutral reproducible examples** — Every code example must use generic, neutral code:
   ```
   const arr = [1, 2, 3];
   arr.forEach(x => console.log(x));
   ```
   ```
   echo "hello" > file && cmd --flag input.txt
   ```
   Never reference types, functions, patterns, or identifiers from the cheasee-pi codebase.

2. **Tone** — Neutral third-person, factual. No opinions, no emotional language, no subjective judgments.

3. **Exact version numbers** — Cite exact version numbers, commit hashes, and environment details where relevant.

4. **Imperative steps** — Write steps to reproduce as clear, ordered imperatives.

5. **Markdown formatting** — Use only headings (`##`, `###`) and fenced code blocks (```` ``` ````). No bold, italic, lists, blockquotes, tables, or other extended markdown.

6. **Do NOT include**:
   - Personal opinions ("This is annoying", "It would be great if")
   - References to cheasee-pi internals
   - Suggestions for implementation (unless the template explicitly asks)
   - Markdown beyond headings and code blocks

#### Write to temp file

Write the composed body to a temporary file for step 5:

```bash
cat > /tmp/issue-body-OWNER-REPO-$(date +%s).md << 'EOF'
<body content>
EOF
```

Use `$(date +%s)` to ensure uniqueness and avoid concurrent-invocation collisions.

---

### Step 5 — File the Issue

Create the issue on the target repo using `gh issue create` with the `--body-file` flag (avoids shell escaping issues with multi-line markdown):

```bash
gh issue create \
  --repo OWNER/REPO \
  --title "ISSUE TITLE" \
  --body-file /tmp/issue-body-OWNER-REPO-$(date +%s).md
```

**After creation:**

1. Capture the output URL (e.g., `https://github.com/OWNER/REPO/issues/123`).
2. Clean up the temp file:
   ```bash
   rm /tmp/issue-body-OWNER-REPO-$(date +%s).md
   ```
3. Report the result to the user: "Issue filed: https://github.com/OWNER/REPO/issues/N"

---

## Universal Fallback Format

Use this format **only** when the repo has **no** issue templates **and** no `CONTRIBUTING.md`.

```
## Description

<clear, concise description of the bug or feature request>

## Steps to Reproduce

1. <step 1>
2. <step 2>
3. <step 3>

## Expected vs Actual Behavior

Expected: <what should happen>
Actual:   <what actually happens>

## Environment

- OS: <e.g., macOS 14.5, Ubuntu 22.04>
- Package version: <e.g., 4.2.1>
- Commit hash: <e.g., a1b2c3d>
- Runtime: <e.g., Node.js 20.11.0>

## Additional Context

<optional: logs, screenshots, related issues, workarounds tried>
```

Each section heading uses exactly `## Section Name`. Content follows the Writing Rules above.

## Error Handling

| Scenario | Action |
|----------|--------|
| `gh auth status` fails | Stop. Tell user: "Run `gh auth login` to authenticate." |
| Duplicate issue found in step 3 | Stop. Report to user: "Likely duplicate of #N — title matches. Review before filing." Do NOT file. |
| No CONTRIBUTING.md and no templates | Use Universal Fallback Format (do NOT abort). |
| CONTRIBUTING.md exists but no templates | Extract format from CONTRIBUTING.md (do NOT fall back to universal format immediately). |
| Duplicate check confidence < threshold | Report related issues to user for manual review. Do NOT file without confirmation. |
| `gh api` returns 404 for repo | Stop. Tell user: "Repo OWNER/REPO not found. Verify the repository name." |
| `gh api` returns 403 (rate limited) | Stop. Tell user: "Rate limited by GitHub API. Wait and retry." |

## Scope Boundaries

This skill has explicit boundaries. It does **NOT**:

- **Create pull requests** — Issues only. PRs require a separate skill.
- **File issues on `SchneiderDaniel/cheasee-pi`** — Handled by other skills (extension-bug-hunter, extension-reinvention-issue-hunter).
- **Target private repos** — Public GitHub repos only.
- **Support non-GitHub platforms** — GitLab, Bitbucket, and other platforms are excluded.
- **Require additional tools** — Only `gh` CLI is needed. No `jq`, no `curl`, no other dependencies.

## Rules

1. **Sequential** — Execute steps 1–5 in order. Never skip a step.
2. **Do not file duplicates** — If step 3 finds a match, stop and report. Do not file.
3. **Neutral code only** — All reproducible examples must use generic code. Never reference cheasee-pi.
4. **Template priority** — Repo template > CONTRIBUTING.md format > Universal Fallback Format.
5. **Temp file cleanup** — Delete temp files after issue creation.
6. **Unique temp paths** — Use `/tmp/issue-body-OWNER-REPO-$(date +%s).md` to avoid collisions.
7. **`--body-file` required** — Always use `--body-file` for issue creation. Never use `--body` inline.
8. **Report outcome** — After filing, provide the issue URL to the user.
9. **One issue per invocation** — This skill handles one issue at a time.
