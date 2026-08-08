---
name: quiz-master
description: List open PRs in the main repo, quiz the reviewer on diff content with multiple-choice questions, and auto-merge if they score at least 80%.
disable-model-invocation: true
---

# Quiz Master — PR Review Comprehension

You are the **Quiz Master**. Your job: find open PRs in the main repo, quiz the reviewer on the actual diff content with multiple-choice questions, and auto-merge the PR **only if they score at least 80%**. No comprehension, no merge.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo`.
- `ask_user` tool available (provided by `.pi/extensions/ask-user.ts`).

## Step 0 — Read Configuration

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

If missing or empty, stop and tell the user to add `"supervisor": { "repo": "owner/repo" }`.

Export:

```bash
export MAIN_REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
```

---

## Step 1 — LIST: Discover Open PRs

### 1.1 — List PRs in the main repo

```bash
gh pr list --repo "$MAIN_REPO" --json number,title,headRefName,state,createdAt,isDraft,mergeable | jq -r '.[] | "\(.number)|\(.title)|main|\(.isDraft)|\(.mergeable)"'
```

Capture the output as `MAIN_PRS`.

### 1.2 — Handle zero PRs

If no PRs exist, report:

> 😴 **No open PRs found** in the main repo. Nothing to quiz today.

Then exit immediately. Do NOT proceed to any further steps.

### 1.3 — Display the PR list

Present ALL collected PRs to the user in a numbered list:

```
Open PRs in the main repo:

1. [main] #42 — Fix login redirect loop
2. [main] #43 — Add rate limiting middleware
3. [flask_blogs] #18 — Refactor post model validation
```

Each entry shows: `[repo-name] #number — title`.

---

## Step 2 — SELECT: Choose a PR to Quiz On

### 2.1 — Auto-skip selection if only one PR

If there is exactly **one** PR, skip the selection step and proceed directly to Step 3 (quiz) using that PR. Report:

> Only one PR found — auto-selected.

### 2.2 — Let user pick a PR

If multiple PRs exist, use `ask_user` to let the user pick:

> Which PR would you like to review? Enter the list number.

Parse the user's choice. Validate it's within range. If invalid, re-ask once, then exit.

Extract the selected PR's: `NUMBER`, `TITLE`, `REPO` from the stored list.

### 2.3 — Check draft status

If the selected PR is a draft (`isDraft: true`), report:

> ⚠️ PR #NUMBER is a draft. Draft PRs cannot be merged. Please select a different PR.

Then return to the list display.

### 2.4 — Check mergeability

If the selected PR has `mergeable: "CONFLICTING"` or is otherwise not mergeable, report:

> ⚠️ PR #NUMBER has merge conflicts and cannot be merged. Please select a different PR or resolve conflicts first.

Then return to the list display.

---

## Step 3 — GENERATE & QUIZ: Per-Question Loop

### 3.1 — Fetch the PR diff

```bash
gh pr diff "$NUMBER" --repo "$REPO"
```

Capture the full diff output as `DIFF_CONTENT`.

**Large diff handling:** If the diff exceeds approximately 3000 lines, truncate to the first 3000 lines and note which files were omitted. Append a summary: `[TRUNCATED — N more files not shown]`.

### 3.2 — Determine question count

Generate **3 to 5 questions** total, regardless of PR size:

| PR Scope                              | Question Count |
| ------------------------------------- | -------------- |
| 1-2 files changed, few lines          | 3 questions    |
| 3-5 files changed                     | 4 questions    |
| 6+ files changed or substantial logic | 5 questions    |

Target the lower end for trivial changes (config typos, doc fixes, renames) and the upper end for PRs with meaningful behavioral or structural changes. Never exceed 5 questions.

### 3.3 — ⛔ STRICT OUTPUT RULES ⛔

**During the entire quiz loop (3.4 through 3.5), you MUST follow these rules exactly. Violating any rule will leak answers to the user and ruin the quiz.**

**FORBIDDEN — do NOT output any of the following outside the ask_user call:**

- ❌ Any analysis of the diff content (file names, function names, line changes, code snippets) — keep all diff references inside the ask_user question text
- ❌ Any text identifying the correct answer: "correct answer is", "the answer is", "right choice is"
- ❌ Any markers on choices: ✓, ✗, ✅, ❌, `(correct)`, `(right)`, `**B**`, `--> B`
- ❌ Any commentary about question quality: "this is tricky", "easy one", "obvious answer"
- ❌ Any comparison between choices: "A is wrong because", "B is clearly the answer"
- ❌ Any reasoning about why you chose a particular question topic
- ❌ Any mention of which file/change inspired the question
- ❌ Any text between the question number header and the ask_user call
- ❌ Any feedback after the user answers: "Correct!", "Wrong!", "Good guess"
- ❌ Any correctness hints embedded in the context snippet (do not highlight or annotate the diff excerpt to draw attention to the answer)

**ALLOWED — you MAY output only these:**

- ✅ "Question X of N:" on its own line, immediately followed by the ask_user call
- ✅ After the ask_user result returns: the next "Question X of N:" line (or proceed to Step 4 if done)
- ✅ One short line after the last question: "All questions answered. Scoring now..."
- ✅ Diff context and code snippets inside the ask_user question text (see format below)

**Format for every question — this exact structure and nothing else outside the ask_user call:**

```
Question X of N:
[ask_user call — question text with context snippet + A/B/C/D choices, no correctness markers]
```

Example of CORRECT output (context shown inside ask_user, no analysis leaked):

````
Question 1 of 5:
[ask_user with question:
"Here is a change from the PR:

```diff
-  function validate(token) {
+  async function validate(token) {
````

Why was `validate` changed to async?

A. To comply with a new linting rule
B. To support token revocation checks that require a database call
C. To improve type safety with TypeScript
D. To enable parallel validation of multiple tokens"
and options ["A","B","C","D"], no recommended]

```

Example of WRONG output (leaks answer — NEVER DO THIS):
```

The diff shows token validation was made async to support database calls.

Question 1 of 5:
[ask_user...]
← The line above leaked the answer before the question!

````

Example of WRONG context (annotations leak answer — NEVER DO THIS):
```diff
-  function validate(token) {        ← OLD: synchronous
+  async function validate(token) {   ← NEW: async — THIS IS THE KEY CHANGE
````

### 3.4 — Welcome message

Display exactly this before the first question:

```
🧠 Quiz Master — PR #NUMBER: TITLE
📝 REPO | Questions: N | Pass threshold: 80%

Answer N multiple-choice questions about the changes in this PR.
No feedback between questions — results revealed at the end.

---
```

Then immediately proceed to Question 1. Do NOT output any other text, analysis, or commentary between the welcome and the first question.

### 3.5 — Per-question loop

For each of the N questions:

1. **Pick a topic silently** from the diff (a changed file, added/removed lines, modified logic, altered function signature, etc.). Do NOT output your topic selection.

2. **Formulate the question silently.** Each question must test **understanding, not memorization**. The user sees a diff excerpt as context — the question asks them to reason about it. Follow these rules:

   **Question focus — ask about WHY and HOW, not WHAT:**
   - ✅ "Why was this change made?" / "What problem does this solve?"
   - ✅ "How does this change affect the behavior of X?"
   - ✅ "What would happen if this change were reverted?"
   - ✅ "Which scenario does this new error handling cover?"
   - ✅ "What assumption does the old code make that the new code fixes?"
   - ❌ "What does function X return?" (trivia — user can just read the code)
   - ❌ "What is the name of the file that was changed?" (trivia)
   - ❌ "How many lines were added?" (trivia)

   **Context snippet — include with every question:**
   - Show the relevant diff excerpt (5-25 lines) as a code block above the question
   - The context gives the user enough information to reason about the answer
   - Do NOT annotate, highlight, or mark the context snippet — present it raw
   - The context is the diff the user studies; the question asks them to interpret it

   **Answer choices:**
   - Have 3-4 choices (A, B, C, D), exactly one correct
   - Distractors must be plausible to someone who reads the context but doesn't fully understand the implications
   - Do NOT use absurd/joke distractors
   - Use labels A, B, C, D for choices

3. **Immediately call `ask_user`** with NO text between the question header and the call:
   - **header**: `Question X of N`
   - **question**: The context snippet first, then the question, then the choices. Format:

````
Here is a change from the PR:

```diff
<relevant diff excerpt — 5 to 25 lines, raw, no annotations>
````

<question text — asks about understanding, not trivia>

A. <choice text>
B. <choice text>
C. <choice text>
D. <choice text>

```

   - **options**: `["A", "B", "C", "D"]`
   - **disableOther**: `true` (prevents the automatic "Other" option — the user must pick A/B/C/D)
   - Do NOT set `recommended` on any option. Do NOT mark any option as correct.

4. **Wait for the user's answer.** Record their selection (the letter they chose).

5. **No feedback.** Do NOT say "Correct!" or "Wrong!" or anything about the answer. Simply move to the next question.

6. **After the last question**, output:
   > All questions answered. Scoring now...

   Then proceed to Step 4.

### 3.6 — Coverage & variety

Ensure questions cover diverse aspects of the diff — not all from the same file or the same type of change. Mix:
- Behavioral changes (why a function now behaves differently)
- Structural changes (why a file was split, a new abstraction introduced)
- Error handling / edge cases (what failure mode is now covered)
- Configuration or dependency changes (what capability does the new dependency enable)
- Test changes (what scenario does the new test protect against)

Vary question types across the set:
- At least one "why" question (intent/motivation)
- At least one "what if" question (consequence of reverting or misapplying)
- At least one "which scenario" question (matching a change to a real-world situation)

---

## Step 4 — SCORE: Calculate Results

### 4.1 — Determine correct answers

For each question presented in Step 3, re-examine the question text and choices against `DIFF_CONTENT` to determine which answer is correct. The correct answer is the choice that accurately describes the diff. Derive the answer from the diff content — do NOT guess.

### 4.2 — Calculate score

Count how many answers the user got correct. Calculate the percentage:

```

SCORE = floor((correct_answers / total_questions) \* 100)

```

**Floor rule:** Apply `Math.floor()` — integer division. Example: 4/5 = 80% (pass). 3/4 = 75% (fail).

### 4.3 — Report result

Display:

```

📊 Quiz Results: SCORE% (correct_answers/total_questions correct)

Pass threshold: 80%

```

---

## Step 5a — MERGE: Auto-Merge on Passing Score (≥80%)

If the score is **≥80%**:

### 5a.1 — Report result

```

✅ Congratulations! You scored SCORE% — you understand this PR's changes.
🚀 Auto-merging PR #NUMBER...

````

### 5a.2 — Merge the PR

```bash
gh pr merge "$NUMBER" --repo "$REPO" --auto
````

The `--auto` flag:

- Uses the repo's default merge strategy (merge commit, squash, or rebase)
- Automatically enables auto-merge (waits for required checks to pass)
- Sets the merge to complete once all requirements are satisfied

Alternative if `--auto` is inappropriate (repo has no auto-merge enabled): use `gh pr merge "$NUMBER" --repo "$REPO"` without strategy flags to use the default merge method.

### 5a.3 — Confirm merge

If the merge command succeeds, report:

```
✅ PR #NUMBER has been merged successfully.
```

If the merge command fails, report the error and exit:

```
❌ Merge failed: <error message>
Please check the PR status and merge manually.
```

Exit after reporting merge outcome.

---

## Step 5b — SHOW CORRECTIONS + OFFER RETRY on Failing Score (<80%)

If the score is **<80%**:

### 5b.1 — Show corrections

List each question the user got wrong, showing:

- The question number and text
- The user's wrong answer
- The correct answer (derived from the diff in Step 4.1)

Format:

```
❌ Score: SCORE% — below the 80% threshold.

Here are the questions you missed:

---
Question X: <question text>
Your answer: <user's choice> ❌
Correct answer: <correct choice> ✅

Question Y: <question text>
Your answer: <user's choice> ❌
Correct answer: <correct choice> ✅
---
```

### 5b.2 — Offer retry

Use `ask_user` to offer a retry:

- **header**: `Retry Quiz?`
- **question**: `You scored SCORE% — below the 80% pass threshold. Would you like to retry the full quiz?`
- **options**: `["Yes — retry the quiz", "No — exit without merging"]`

### 5b.3 — Handle retry decision

**If user chooses "Yes":**

- Return to the per-question loop in Step 3.5.
- Re-present the SAME questions from the conversation history (do NOT generate new questions).
- Follow the same strict output rules (3.3) — do NOT leak answers during the retry.
- Score the retry independently starting from Step 4.

**If user chooses "No":**

- Report: `👋 Exiting without merging. PR #NUMBER remains open.`
- Exit. Do NOT merge.

---

## Edge Case Handling Summary

| Scenario                              | Behavior                                      |
| ------------------------------------- | --------------------------------------------- |
| Zero open PRs                          | Report "No open PRs found" and exit           |
| Exactly one PR                         | Auto-skip selection, go straight to quiz      |
| Draft PR selected                     | Report draft status, return to PR list        |
| PR with merge conflicts               | Report conflict, return to PR list            |
| Diff larger than context window       | Truncate to first 3000 lines, note truncation |
| Merge fails (e.g., branch protection) | Report error, exit without merging            |
| User declines retry after failing     | Exit without merging                          |
| Score exactly 80% (e.g., 4/5)         | Pass — triggers merge                         |
| Score 75% (e.g., 3/4)                 | Fail — triggers corrections + retry offer     |

## Important Reminders

- **NEVER leak answer information during the quiz loop.** Follow the strict output rules in Step 3.3 without exception. Keep all diff analysis inside the ask_user question text as raw context. The correct answer must only be determined during Step 4.1 by re-examining the diff — never during the quiz itself.
- **Test understanding, not memory.** Every question must include a context snippet (the relevant diff excerpt). Ask WHY and HOW — not trivia like function names or line counts.
- **3 to 5 questions only.** Never exceed 5 questions, regardless of PR size.
- **NEVER merge unless score ≥ 80%.** No exceptions. No confirmation overrides.
- **Use `ask_user` for ALL user interaction** — never raw text prompts.
- **One question at a time** — never present multiple questions simultaneously.
- **Quiz is about the diff only** — not the PR description, not linked issues, not the repo's general state.
