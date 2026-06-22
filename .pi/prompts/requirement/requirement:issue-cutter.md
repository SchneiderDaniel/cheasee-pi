---
description: Split a GitHub epic into smaller, ordered, independently testable sub-issues and create them on GitHub as children of the parent epic.
argument-hint: "<issue-number>"
---

# Issue Cutter

Split GitHub epic #$1 into small, ordered, independently testable sub-issues and create them on GitHub as **sub-issues (children) of the parent epic**.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo` (e.g. `SchneiderDaniel/agentcastle`).

## Step 0 — Read Configuration

Read `.pi/settings.json` and extract the `supervisor.repo` field. Parse it as `OWNER/REPO`:

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

If the field is missing or empty, stop and tell the user to add `"supervisor": { "repo": "owner/repo" }` to `.pi/settings.json`.

Export for reuse in later commands:

```bash
export REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
export OWNER=$(echo $REPO | cut -d'/' -f1)
export REPO_NAME=$(echo $REPO | cut -d'/' -f2)
```

Verify the repo exists:

```bash
gh repo view "$REPO" --json name --jq '.name'
```

---

## Core Principle: The Vertical Slice

Each sub-issue must be a **vertical slice** — self-contained, independently testable, with concrete acceptance criteria. Avoid horizontal slices (e.g. "do all DB changes first"). Each slice must include **step-by-step human validation instructions**.

---

## Workflow

### Step 1 — Fetch the Epic

⚠️ Save output to a **project-relative path** (e.g. `ignore/epic.json`). Do NOT use `/tmp/` — the bash tool blocks absolute paths outside the project directory.

```bash
gh issue view $1 --repo "$REPO" --json title,body,comments,labels > ignore/epic.json
```

Read the full output before proceeding (use `cat ignore/epic.json | jq '{title, body, labels: [.labels[].name]}'` for a readable summary).

### Step 1.5 — Refinement Gate

Check that the epic has the `refined` label. Extract labels from the JSON fetched in Step 1:

```bash
jq -r '.labels[].name' ignore/epic.json | grep -x 'refined'
```

If `grep` finds **no** match (empty output, exit code 1), **stop immediately** and tell the user:

> Issue #$1 is not refined yet. Please refine the issue first (add the `refined` label) before cutting it into sub-issues.

Do **not** proceed past this gate if the `refined` label is absent.

### Step 2 — Explore the Codebase

⚠️ **MANDATORY**: Explore the relevant codebase area before decomposing. Cutting issues without knowing current state leads to incorrect sub-issues.

Follow these steps in order. Record all findings in a **discovery map** — a structured list of `(file path, symbol, dependencies)` for every symbol found. This map will be injected into each sub-issue under "Files Touched" (Step 4).

---

#### 2.1 — Extract Keywords from the Epic

Read the epic title and body (from `ignore/epic.json` fetched in Step 1). Extract **up to 5 keywords** that are most likely to match code in the codebase. Prioritize:

- **Nouns** and **entity names** (e.g. "User", "Recipe", "Tag", "Profile")
- **Route paths** (e.g. `/api/users`, `/dashboard` — strip leading `/` and use as token: `api users`, `dashboard`)
- **File names** or **module names** mentioned in the issue body
- **Function/class names** explicitly called out

```bash
# Read a summary of the epic to extract keywords from
cat ignore/epic.json | jq '{title, body}'
```

**If 0 keywords can be extracted** (epic body too short or generic), skip to the **Greenfield Fallback** (2.5) immediately.

---

#### 2.2 — Search the Codebase

For each keyword, use `bash grep` to find matching files:

```bash
grep -rli "<keyword>" --include="*.py" --include="*.ts" --include="*.js" --include="*.java" --include="*.go" 2>/dev/null | head -20
```

**Cap results at the top 3 per keyword.** Record each result's file path.

---

#### 2.3 — Read Matching Code

For each result from 2.2, use `read` to examine the file and find relevant symbols:

```bash
# Read the file to find symbols matching the keyword
```

Record the file path and any matching symbols found.

---

#### 2.4 — Trace Dependencies

For each symbol discovered in 2.2–2.3, use `bash grep` to trace what it calls and what calls it:

```bash
grep -rn "<symbol_name>" --include="*.py" --include="*.ts" 2>/dev/null | head -20
```

Record the discovered dependencies alongside each symbol in the discovery map. Format:

```
Discovery Map:
- file: src/models/user.py | symbol: User | deps: [BaseModel, db.Column]
- file: src/routes/api.py | symbol: get_users | deps: [User.query, jsonify]
...
```

---

#### 2.5 — Greenfield Fallback

If no results were found across all keywords (no `grep` hits), record:

```
No existing code found — greenfield
```

Proceed to text-only cutting. The "Files Touched" section in each sub-issue will state: `No existing code — new files will be created`.

---

#### 2.6 — Handle Edge Cases

- **Referenced file not found by search**: Note it in the discovery map as `referenced but not found` and continue. Do not block cutting.
- **0 keywords extracted**: Skip directly to greenfield fallback (2.5).
- **>50 results per keyword**: Take top 3 only; ignore the rest.

---

**After Step 2**: You have a discovery map of existing code. Sub-issues must only describe work not yet done. The discovery map feeds into each sub-issue body under "Files Touched" (see Step 4 template).

### Step 3 — Analyze & Categorize

Map the epic across these layers (only those actually needed). Each layer corresponds to a GitHub label that must exist in the repo:

| #   | Layer          | Title / Examples                                               |
| --- | -------------- | -------------------------------------------------------------- |
| 1   | infrastructure | Project scaffolding, dependencies, directory structure, config |
| 2   | database       | Schema changes, migrations, seed data, persistence             |
| 3   | backend        | Service logic, API routes, validation, business rules          |
| 4   | frontend       | Templates, forms, JS interactions, CSS, dashboard UI           |
| 5   | i18n           | Translation strings, locale files                              |
| 6   | testing        | Integration, E2E, smoke tests                                  |
| 7   | documentation  | README, inline docs                                            |

Fetch available labels once and reuse:

```bash
gh label list --repo "$REPO" --json name | jq -r '.[].name' | sort
```

### Step 4 — Derive Ordered Sub-Issues

Ordering rules:

1. **Foundation first**: data model before services that use them
2. **Backend before frontend**: endpoint exists before UI that calls it
3. **Infrastructure before services**: config/env vars needed by code come first
4. **i18n strings before they are referenced in templates**
5. **Testing sub-issues** go last (unless embedded in the slice)

For each sub-issue define:

- **Order number** (1, 2, 3…) — in body, NOT in title
- **Title**: short, imperative, descriptive on its own. **MUST NOT contain `/`** (see Bash Tool Constraints below).
- **Body**: User Story + Acceptance Criteria (template below)
- **Layer label** — exactly one from the table in Step 3 (e.g. `database`, `backend`, `frontend`). Must exist as a GitHub label in the repo.

### Step 5 — Confirm with User

Present the proposed breakdown as a numbered list:

```
Proposed breakdown for issue #$1:
1. Add recipe_tag column to database schema    → labels: `refined`, `database`
2. Implement tag service and API endpoint       → labels: `refined`, `backend`
3. Build tag filter UI component                → labels: `refined`, `frontend`
…

Create these as GitHub sub-issues?
```

Wait for user confirmation before creating.

### Step 6 — Create and Link Sub-Issues on GitHub

⚠️ **MANDATORY: Every sub-issue MUST be linked as a child of the epic. Creation alone is incomplete. Do not skip 6b.**

#### Bash Tool Constraints (READ BEFORE CREATING ISSUES)

The bash tool blocks any command containing a `/` that looks like an **absolute path** (e.g. `/foo`, `/nonexistent`, `/usr/...`). Specifically, any `/` preceded by space, `(`, `'`, `"`, or at line-start triggers path validation and blocks the command.

**Rules for issue titles and bodies:**

- **Titles**: MUST NOT contain standalone `/`. Replace `GET /` with `GET root`, `POST /api/users` with `POST api users`, `/path/:id` with `path by id`.
- **Bodies**: `/` inside longer tokens (e.g. `data/visits.db`, `flask_app/app.py`, `http://...`) is fine — only standalone `/` (preceded by space or punctuation) triggers the block. Avoid phrases like `curl http://localhost:3000/api/users` where `/api/users` appears standalone. Rewrite as `curl localhost:3000/api/users` (no space before `/api`).

#### 6a — Resolve the epic node ID (ONCE, before the loop)

```bash
EPIC_ID=$(gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F num=$1 \
  -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) { id }
      }
    }' --jq '.data.repository.issue.id')

echo "$EPIC_ID" > ignore/epic_id.txt
echo "Epic ID: $EPIC_ID"
```

#### 6b — For EACH sub-issue (loop): write body to file → create → capture number → resolve child ID → link

Every sub-issue gets exactly two labels: `refined` and its **layer label** (e.g. `database`, `backend`, `frontend`, `infrastructure`, `testing`, `i18n`, `documentation`). Do **not** add a `sliced` label.

**Step-by-step for each sub-issue:**

**Step 1: Write the body to a file first.** This avoids inline escaping issues and path validation on multi-line content. Use project-relative paths like `ignore/sub<N>_body.md`.

**Step 2: Create the issue, reading body from file.**

```bash
BODY=$(cat ignore/sub1_body.md)
CHILD_URL=$(gh issue create \
  --repo "$REPO" \
  --title "Your slash-free title here" \
  --body "$BODY" \
  --label "refined,database")
echo "Created: $CHILD_URL"
```

**Step 3: Extract the issue number from the URL.**

```bash
CHILD_NUM=$(echo "$CHILD_URL" | grep -oP '/issues/\K\d+')
echo "Child number: $CHILD_NUM"
```

**Step 4: Resolve the child issue's GraphQL node ID.**

```bash
CHILD_ID=$(gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F num="$CHILD_NUM" \
  -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) { id }
      }
    }' --jq '.data.repository.issue.id')
echo "Child ID: $CHILD_ID"
```

**Step 5: Link child as sub-issue via GraphQL (this creates the real parent-child relationship, NOT a comment or body mention).**

```bash
EPIC_ID=$(cat ignore/epic_id.txt)
RESULT=$(gh api graphql \
  -F issueId="$EPIC_ID" \
  -F subIssueId="$CHILD_ID" \
  -f query='
    mutation($issueId:ID!, $subIssueId:ID!) {
      addSubIssue(input:{issueId:$issueId, subIssueId:$subIssueId}) {
        issue { number }
        subIssue { number }
      }
    }' --jq '.')

# Verify no GraphQL errors
if echo "$RESULT" | jq -e '.errors' > /dev/null 2>&1; then
  echo "ERROR: addSubIssue mutation failed"
  echo "$RESULT" | jq '.errors'
  echo "Sub-issue #$CHILD_NUM was CREATED but NOT linked as child of Epic #$1."
  echo "Stopping: remaining sub-issues will NOT be created."
  exit 1
fi
echo "Sub-issue #$CHILD_NUM linked as child of Epic #$1 (GraphQL parent-child, not comment)"
```

**Step 6: Set dependency chain**

> **If only 1 sub-issue was created (N ≤ 1), skip the dependency wiring step entirely.** No `addBlockedBy` call is needed for a single sub-issue.

Sub-issues form a linear chain: sub-issue N is blocked by sub-issue N−1 (for N > 1). The first sub-issue has no blocker. The chain is stored via `ignore/prev_child_id.txt`.

**For the first sub-issue (N=1):** save its node ID as the blocker for the next sub-issue. No mutation call.

```bash
echo "$CHILD_ID" > ignore/prev_child_id.txt
```

**For each subsequent sub-issue (N > 1):** read the previous sub-issue ID, set the `blockedBy` relationship, then overwrite the file with its own ID for the next iteration.

```bash
PREV_CHILD_ID=$(cat ignore/prev_child_id.txt)
gh api graphql \
  -F issueId="$CHILD_ID" \
  -F blockingIssueId="$PREV_CHILD_ID" \
  -f query='
    mutation($issueId:ID!, $blockingIssueId:ID!) {
      addBlockedBy(input:{issueId:$issueId, blockingIssueId:$blockingIssueId}) {
        clientMutationId
      }
    }'
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to set dependency for sub-issue N=<N>"
  echo "  issueId: $CHILD_ID"
  echo "  blockingIssueId: $PREV_CHILD_ID"
  echo "  Raw GraphQL error above"
  echo "  Stopping: remaining sub-issues will NOT be created."
  exit 1
fi
echo "🔗 Blocked #$CHILD_NUM by previous sub-issue"
# Save current child ID as the blocker for the next sub-issue
echo "$CHILD_ID" > ignore/prev_child_id.txt
```

⚠️ **Do ALL SIX steps for each sub-issue before moving to the next one. Do NOT batch all creations and then try to link afterward. Stop immediately on any failure — remaining sub-issues must NOT be created.**

**Save each sub-issue number** for dependency references in later sub-issues:

```bash
echo "$CHILD_NUM" > ignore/sub<N>_num.txt
```

**Tip:** You can combine steps 2–6 into one chained command per sub-issue (using `&&`), but keep steps 1 (file write) separate since the body file won't change within a chained command after writing.

#### 6c — Print summary

```
✅ Sub-issues created and linked AS CHILDREN (sub-issues, not comments) under Epic #$1:
  #101  [database]  (1) Add recipe_tag column to database schema
  #102  [backend]   (2) Implement tag service and API endpoint  🔗 blocked by #101
  #103  [frontend]  (3) Build tag filter UI component           🔗 blocked by #102
  …
```

Verify epic linkage:

```bash
gh api graphql \
  -F owner="$OWNER" -F repo="$REPO_NAME" -F num=$1 \
  -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){title subIssues(first:20){nodes{number title}}}}}' \
  --jq '.data.repository.issue | {title, children: [.subIssues.nodes[] | {number, title}]}'
```

Verify dependency chain (run for each sub-issue starting from N=2):

```bash
gh api graphql \
  -F owner="$OWNER" -F repo="$REPO_NAME" -F num=<CHILD_NUM> \
  -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number title blockedBy(first:5){nodes{number title}}}}}' \
  --jq '.data.repository.issue | {number, title, blockedBy: [.blockedBy.nodes[] | {number, title}]}'
```

---

## Sub-Issue Body Template

Every sub-issue body follows this exact format:

```markdown
## Context

_Why this piece exists and how it relates to the parent epic._
Parent epic: #$1
Linked: Sub-issue (GraphQL `addSubIssue`). Not just body text or comment — Step 6b creates real parent-child relationship on GitHub.
Implementation order: <N> of <total>

## User Story

As a [role], I want [feature], so that [benefit].

## Acceptance Criteria

- [ ] AC1: <specific, testable condition>
- [ ] AC2: <specific, testable condition>

## How to Validate (Human Tester)

_Step-by-step instructions executable without reading any code._

1. <setup step>
2. <navigation step>
3. <action step>
4. <expected result>
5. <edge case / negative test>

## Files Touched

_Discovered during Step 2 codebase exploration._

- **Existing files/symbols**: <list file paths and symbols from discovery map relevant to this sub-issue>
- **New files to create**: <list paths for files this sub-issue will create, if any>
- **Greenfield**: No existing code — new files will be created

## Technical Notes

_Optional: key files, services, patterns. Keep brief._

## Dependencies

_Optional: sub-issues that must be completed before this one._
```

---

## Safety & Constraints

- **Never close the original epic** — only the human reviewer may close issues.
- **No artificial cap on sub-issues** — use as many as needed for clarity.
- **Each sub-issue must have at least 2 Acceptance Criteria.**
- **Labels**: only use labels that exist (`gh label list --repo "$REPO"`).
- **Fetch the epic once** — do not re-fetch in a loop.
- **Use `--jq`** with `gh api` for JSON extraction, not `ConvertFrom-Json`.
- **Bash tool path validation**: titles must not contain standalone `/`. Bodies must avoid standalone `/` paths. Use project-relative paths for all file I/O (not `/tmp/`).
- **Write bodies to files first**, then create issues from files. Never inline multi-line bodies in the `gh issue create` command.

## Quality Checklist

Before creating any sub-issue, verify mentally:

- [ ] Work is **not already implemented** (verified in Step 2)
- [ ] Describes **one** coherent unit of work
- [ ] Has at least **2** concrete, testable acceptance criteria
- [ ] Developer could start **today** without waiting for unclear decisions
- [ ] Does not duplicate work in another sub-issue
- [ ] Order number reflects valid implementation sequence
- [ ] **How to Validate** section has step-by-step instructions executable without reading code
- [ ] **Every created sub-issue is linked** to the parent epic (Step 6b completed for each)
- [ ] Title contains no standalone `/` characters

## Troubleshooting

| Symptom                                                 | Likely Cause                                                      | Fix                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Blocked: absolute path "/..."`                         | Command contains a standalone `/` (in title, body, or file path). | Remove `/` from issue titles. Replace standalone `/paths` in body with inline equivalents. Use project-relative file paths. |
| Body not appearing in created issue                     | Inline body in single quotes contains unescaped characters.       | Always write body to file first (`ignore/sub<N>_body.md`), then read via `BODY=$(cat file)`.                                   |
| `gh issue create` fails with "422 Unprocessable Entity" | Label does not exist in the repo.                                 | Run `gh label list --repo "$REPO"` to verify labels exist.                                                                  |
| Sub-issues not appearing under epic                     | Step 5 (link) was skipped or failed silently.                     | Run the verification GraphQL query from Step 6c. Re-link any unlinked sub-issues manually.                                  |
| `addBlockedBy` mutation fails with error in JSON        | `issueId` or `blockingIssueId` is not a valid node ID.            | Verify both IDs are GraphQL node IDs (format `I_xxx`), not plain issue numbers. Use Step 4 to resolve node IDs correctly.   |
| `addBlockedBy` returns HTTP 403/429                     | GraphQL rate limit or permission error.                           | Check token scopes (`repo` write access required). Wait for rate limit window to reset. Remaining sub-issues NOT created.   |
| Dependency not showing in GitHub UI                     | Mutation returned HTTP 200 but contained GraphQL errors.          | Re-run the `addBlockedBy` mutation. Check raw response for `errors` array in JSON body.                                     |
