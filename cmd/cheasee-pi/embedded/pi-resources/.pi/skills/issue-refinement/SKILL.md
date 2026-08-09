---
name: issue-refinement
description: Refine a GitHub issue by conducting a one-question-at-a-time Socratic interview, challenging the issue against the codebase, then replacing vague requirements with concrete acceptance criteria.
disable-model-invocation: true
---

# Issue Refinement — One-Question-at-a-Time Socratic Interview

⚠️ **YOU ARE AN INTERVIEWER. NOT A REPORT WRITER.** You ask ONE question at a time via the `ask_user` tool. You wait for the answer. You decide if the answer is sufficient, or if the topic needs follow-up. Only when that topic is fully understood do you move to the next topic. When ALL topics are exhausted, you immediately write the refined issue and update GitHub — no approval gates, no draft reviews.

Fetch GitHub issue #$1, **grill it against the codebase**, then **interview the user one question at a time** until every topic is mutually understood. Then write the refined issue and update GitHub immediately. No waiting for confirmation.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo`.
- `ask_user` tool available (provided by `.pi/extensions/ask-user.ts` — auto-loaded if present).

## Step 0 — Read Configuration

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

If missing or empty, stop and tell the user to add `"supervisor": { "repo": "owner/repo" }`.

Export:

```bash
export REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
export OWNER=$(echo $REPO | cut -d'/' -f1)
export REPO_NAME=$(echo $REPO | cut -d'/' -f2)
```

Verify:

```bash
gh repo view "$REPO" --json name --jq '.name'
```

---

## Core Principles

### One Question at a Time

You are a journalist conducting an interview. You ask ONE question. You listen to the answer. You probe that answer until it's concrete. Only then do you move to the next question. You NEVER present a list of questions.

### Use `ask_user` for Every Question

Never ask open-ended text questions. Instead, call the `ask_user` tool with:

- **question**: the question text (include enough context)
- **options**: at least 3 options, one marked `recommended: true`, plus "Other" is added automatically

The tool presents an interactive picker to the user. The user selects with arrow keys or types a custom answer if they pick "Other".

### Grill Against Reality

The issue is a proposal. The codebase is ground truth. Every claim must be verified against what actually exists.

### Replace, Don't Append

The refined issue **replaces** the original body entirely. No append-only sections.

### Sharpen, Don't Soften

Every vague answer gets a follow-up until it becomes concrete and testable.

---

## STATE DETECTION

Read the conversation history. Determine your state:

- **INITIAL**: First invocation of `/skill:issue-refinement` in this conversation. → Go to PHASE 0: INVESTIGATE.
- **INTERVIEWING**: Investigation done, interview in progress. → Go to PHASE 1: INTERVIEW.
- **FRONTEND_INTERVIEWING**: Core interview done, but `frontend_flag` is `true` and frontend refinement questions remain. → Go to PHASE 1.5: FRONTEND REFINEMENT.
- **COMPLETE**: All topics covered, understanding reached. → Go to PHASE 2: WRITE & UPDATE (write the refined issue and update GitHub in one shot, no approval).

---

## PHASE 0: INVESTIGATE (INITIAL state only)

Do your research silently. Then present a brief summary and ask the FIRST question.

### 0.1 — Fetch the Issue

```bash
gh issue view $1 --repo "$REPO" --json title,body,comments,labels,state
```

### 0.2 — Explore the Codebase

```bash
find . -maxdepth 4 -not -path './.pi/*' -not -path './node_modules/*' -not -path './.git/*' -iname '*<keyword>*' | head -60
```

Use `bash grep` to search for symbols mentioned. Read `CONTEXT.md` / `docs/adr/` if they exist. Trace relevant code paths with `bash grep`.

### 0.3 — Cross-Reference with Code

Identify:

- 🟢 What already exists (can be removed from scope)
- 🔴 Contradictions between issue claims and actual code
- 🟡 Vague language that needs sharpening

### 0.4 — Frontend Detection

Inspect the issue and codebase context to determine whether the change involves **new or modified HTML templates, CSS, or browser-rendered JavaScript**. You must reach one of three outcomes:

| Detection Outcome         | Action                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confident frontend**    | Set `frontend_flag=true`. Announce: PHASE 1.5 (frontend refinement) will run after PHASE 1.                                                                                                                                                                                |
| **Unsure**                | Call `ask_user` with exactly ONE confirmation question: _"Does this issue involve any UI changes (HTML, CSS, or browser-rendered JS)?"_ — Options: `"Yes, it involves UI changes"` / `"No, no UI changes"`. Set `frontend_flag` based on answer. Do NOT ask any follow-up. |
| **Confident no frontend** | Set `frontend_flag=false`. Skip silently — flow goes directly from PHASE 1 to PHASE 2 with no mention of a frontend phase.                                                                                                                                                 |

### 0.5 — Determine Interview Topics

Based on your investigation, identify which topics need discussion. The core topics are:

1. **Purpose & Value** — Why is this needed? For whom? What problem does it solve?
2. **Scope Boundaries** — What's exactly in scope? What's explicitly out?
3. **Requirements & Acceptance Criteria** — One topic per requirement. What must happen? How to verify?
4. **Constraints & Limits** — Max lengths, formats, uniqueness, required vs optional, case sensitivity
5. **Error Handling** — What happens when things go wrong?
6. **Edge Cases** — Boundary conditions, race conditions, unusual inputs
7. **Dependencies** — Blocks on other issues/PRs/infrastructure?
8. **Contradictions** (if any found) — Issue says X, code does Y. Which wins?

You don't need all topics for every issue. Pick the ones relevant to THIS issue.

### 0.6 — 🛑 Present Summary & Use `ask_user` for FIRST Question

Present the investigation summary, then immediately call the `ask_user` tool with the first question.

```
🔍 Issue #$1 — Investigation Complete

📋 [1 sentence what the issue asks for]

🟢 Already exists: [brief list, if any]
🔴 Contradictions: [brief list, if any]

---

Let's sharpen this together. I'll ask one question at a time.
```

Then immediately call `ask_user`:

```
question: "Why is this feature needed? For whom does it solve what problem?"
options:
  - label: "For end-users to do X faster"    value: "end_users_x"     recommended: true
  - label: "For admins to manage Y"          value: "admins_y"
  - label: "For automated system Z"          value: "system_z"
  - label: "Multiple audiences (explain)"    value: "multiple"
```

⚠️ HARD STOP. Call `ask_user` exactly ONCE. Do NOT proceed past the tool result. Wait for the answer.

---

## PHASE 1: INTERVIEW (INTERVIEWING state)

**You are in the middle of an interview.** Your last `ask_user` call returned an answer. Now:

### Step 1 — Evaluate the Answer

Does this answer fully resolve the current topic? Ask yourself:

- Is the answer concrete and testable? (Not "make it good" or "just work")
- Can I write an acceptance criterion from it? (Not "should be fast" but "loads in under 200ms")
- Does it have a clear "why" and "for whom"?
- Are constraints specified? (max, format, required/optional)
- Are error/edge cases addressed?

**If the answer is insufficient** → Call `ask_user` with a follow-up on the SAME topic:

```
question: "You mentioned X should be fast. What's the specific target?"
options:
  - label: "Under 200ms"      value: "lt_200ms"     recommended: true
  - label: "Under 1 second"   value: "lt_1s"
  - label: "Under 5 seconds"  value: "lt_5s"
```

⚠️ HARD STOP. One `ask_user` call at a time. Stay on this topic until it's solid.

**If the answer is sufficient** → Acknowledge, record the understanding, then call `ask_user` for the NEXT topic:

```
✅ Got it. [current topic]: [1-sentence summary of what was agreed].

Now, next topic → call ask_user:

question: "[ONE question on the next most important unresolved topic]"
options:
  - label: "..."  value: "..."  recommended: true
  - label: "..."  value: "..."
  - label: "..."  value: "..."
```

⚠️ HARD STOP. One new `ask_user` call at a time.

### Step 2 — Track Topics

Keep a mental (or explicit) list of which topics are resolved and which remain. Do NOT ask about resolved topics again unless the user's answer to a later topic contradicts something previously agreed.

**Resolved topics** (examples of what "resolved" looks like):

- Purpose: "Enable recipe authors to tag recipes for discoverability. No current tagging system exists."
- Scope: "Tag CRUD on recipes only. NOT tag management admin panel. NOT tag analytics."
- R1 ACs: "1) Author can add up to 5 tags when creating recipe. 2) Tags appear as chips on recipe card. 3) Clicking chip filters recipe list by that tag."
- Constraints: "Max 50 chars per tag, lowercase a-z and hyphens only, no duplicates on same recipe."
- Error handling: "Empty tag → rejected with 'Tag cannot be empty'. 6th tag → rejected with 'Max 5 tags'."
- Edge cases: "Deleting last tag → recipe has no tags, shows empty. Duplicate tag → silently ignored."
- Dependencies: "None. No other PRs needed."

### Step 3 — When All Topics Are Resolved

Present the completion summary, then ask ONE final question before writing.

```
✅ We've covered all topics for issue #$1. Here's what we agreed:

🎯 PURPOSE: [Why, for whom]
📏 SCOPE: IN → [...], OUT → [...]
📋 REQUIREMENTS:
   1. [R1]: AC1: [...] AC2: [...]
   2. [R2]: AC1: [...] AC2: [...]
🔢 CONSTRAINTS: [...]
❌ ERROR HANDLING: [...]
🧪 EDGE CASES: [...]
🔗 DEPENDENCIES: [...]
```

Then immediately call `ask_user` with the final question:

```
question: "After discussing all these topics — does anything else come to mind that you'd now like to add as a requirement?"
options:
  - label: "No, this covers everything"            value: "no_done"        recommended: true
  - label: "Yes, I want to add something (explain)"  value: "yes_add"
```

⚠️ HARD STOP. Wait for the answer.

- If user selects **"No"** → if `frontend_flag` is `true`, proceed to PHASE 1.5 (frontend refinement); otherwise proceed directly to PHASE 2 (write & update).
- If user selects **"Yes"** and types details → treat this as a new topic. Ask follow-up questions until it's concrete and resolved, then re-present the completion summary and ask the final question again.

---

## PHASE 1.5: FRONTEND REFINEMENT (conditional)

**Only execute this phase if `frontend_flag` is `true`.** When `frontend_flag` is `false`, skip this entire section and proceed directly to PHASE 2.

This phase runs between PHASE 1 (core interview) and PHASE 2 (write & update). Its purpose is to gather UI design decisions before writing the refined issue, so implementation does not need to re-ask design questions.

### Rules

- **One question at a time** via `ask_user`, same discipline as PHASE 1.
- **Cover all 5 aspects** in order:
  1. **Layout / Placement** — Where do elements go on the page? Above/below what? Sidebar, header, main content area?
  2. **Visual Style** — Colors, typography, spacing, existing design system to follow?
  3. **Interactions** — Hover, click, animations, transitions, loading states?
  4. **Responsive Behavior** — Mobile, tablet, desktop breakpoints? Stack vs side-by-side?
  5. **Accessibility** — ARIA labels, keyboard navigation, focus management, screen reader considerations?

- **Skip any aspect with a brief justification** (e.g., "No responsive concerns — desktop-only internal tool"). Record the skip reason.
- **On "I don't know" or "I don't care"**: pick a reasonable default, document it, and move on. Do NOT pressure the user.
- **Follow up on vague answers** until concrete (same discipline as core interview).
- **Exit** when all 5 aspects are considered and you are satisfied you know enough. There is no fixed question count.

### Protocol

1. Announce: "Now, let's cover UI design. I'll ask one question at a time about 5 aspects."
2. For each aspect, call `ask_user` with one question. Evaluate the answer.
3. If the answer is sufficient, record the decision and move to the next aspect.
4. If the answer is vague, follow up on the SAME aspect.
5. If the user says "I don't know" / "I don't care", pick a default, document it, proceed.
6. If you skip an aspect, record: "[Aspect]: SKIPPED — [brief justification]".
7. After all 5 aspects are addressed, announce completion and proceed to PHASE 2.

---

## PHASE 2: WRITE & UPDATE (COMPLETE state)

All topics resolved. Write the refined issue based on all agreed-upon topics, then immediately update GitHub and add the `refined` label. **No approval gate. No draft review.**

### 2.1 — Write the Refined Issue

**2.1a — Generate the Issue Title**

Before writing the body, generate an imperative verb-phrase title that summarizes the refined scope. The title must be:

- In imperative mood (e.g., "Add tag filtering to recipe search", not "Tag filtering added" or "Issue about tags")
- ≤72 characters
- Plain ASCII only — no quotes (`"`, `'`), backticks, `$`, emoji, or other shell-breaking characters
- Truncated or rephrased if length or character constraints are violated
- Always generated fresh, even if the current title already looks acceptable

Store the generated title in a variable for the CLI step:

```bash
export TITLE='<generated imperative title>'
```

**2.1b — Write the Refined Body**

Use this exact template:

```markdown
## Summary

_1–3 sentences: what this issue asks for, in precise language._

## Context

_Why this change matters. What problem it solves. Who it serves._

**Current state** (verified in code):

- <what exists>
- <what exists>

**What's missing:**

- <what to build>
- <what to build>

## Requirements

### R1: <Short imperative title>

As a [role], I want [feature], so that [benefit].

**Acceptance Criteria:**

- [ ] AC1: <specific, testable condition>
- [ ] AC2: <specific, testable condition>

### R2: <Short imperative title>

...

## UI Design Decisions

_If and only if the frontend refinement phase ran._ Omit this entire section when the frontend phase was skipped.

- **Layout / Placement**: <decision or "SKIPPED — justification">
- **Visual Style**: <decision or "SKIPPED — justification">
- **Interactions**: <decision or "SKIPPED — justification">
- **Responsive Behavior**: <decision or "SKIPPED — justification">
- **Accessibility**: <decision or "SKIPPED — justification">

_Where the LLM chose a default (due to "I don't know"), note it: "DEFAULT: Follow existing project style."_

## How to Validate (Human Tester)

_Step-by-step instructions executable without reading code._

1. <setup>
2. <action>
3. <expected result>

**Edge cases:**

- <scenario>: <expected behaviour>
- <scenario>: <expected behaviour>

## Out of Scope

- <thing intentionally excluded>

## Dependencies

- <dependency>

## Technical Direction

_Optional: key files, patterns._

- <file/path> — <role in this change>
```

### 2.2 — Update the Issue on GitHub

First, update the title with retry-on-failure:

```bash
gh issue edit $1 --repo "$REPO" --title "$TITLE" || {
  echo "⚠️ Title update failed. Retrying..."
  sleep 2
  gh issue edit $1 --repo "$REPO" --title "$TITLE" || {
    echo "⚠️ Title update failed after retry. Body will still be updated."
  }
}
```

Then update the body (always runs regardless of title outcome):

```bash
gh issue edit $1 \
  --repo "$REPO" \
  --body '…refined body content…'
```

### 2.3 — Add the `refined` Label

```bash
gh label list --repo "$REPO" --search "refined" --json name --jq '.[].name'
```

Create if missing:

```bash
gh label create "refined" \
  --repo "$REPO" \
  --color "1D76DB" \
  --description "Issue has been refined with concrete acceptance criteria"
```

Apply:

```bash
gh issue edit $1 --repo "$REPO" --add-label "refined"
```

### 2.4 — Confirm

```
✅ Issue #$1 refined and updated.
   Label: refined added.
   View: https://github.com/$REPO/issues/$1
```

### 2.5 — Ask About Cutting (via `ask_user`)

Immediately after confirming the update, call `ask_user`:

```
question: "Issue #$1 is refined. What's next?"
options:
  - label: "Call issue-cutter to split into sub-issues"    value: "cut"      recommended: true
  - label: "Done — no further action"                      value: "done"
  - label: "Other (type your answer)"                      value: "other"
```

- If user selects **"cut"** → immediately load and follow `.pi/skills/issue-cutter/SKILL.md` for issue #$1.
- If user selects **"done"** or **"other"** → acknowledge and end.

---

## Quality Checklist (Phase 2 only)

- [ ] Every claim checked against codebase
- [ ] Vague language replaced with concrete, testable requirements
- [ ] Every requirement has ≥2 acceptance criteria
- [ ] ACs testable by human without reading code
- [ ] "How to Validate" covers happy path + edge cases
- [ ] "Out of Scope" explicit
- [ ] Terminology matches CONTEXT.md if one exists
- [ ] Work does NOT already exist in codebase
- [ ] Dependencies identified
- [ ] Refined body is complete replacement

## Safety & Constraints

- **Never close the issue.**
- **Never delete comments.**
- **Refined body replaces original.** No append-only updates.
- **Auto-apply generated title** during Phase 2. No user confirmation prompt. Title is always generated and applied.
- **Use `--jq`** with `gh api`, not `ConvertFrom-Json`.
- **Fetch the issue once.**
