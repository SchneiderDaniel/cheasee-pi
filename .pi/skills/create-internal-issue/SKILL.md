---
name: create-internal-issue
description: "Creates GitHub issues on the internal repo. Reads repo + project config from .pi/settings.json, loads proper template, checks duplicates, files via gh CLI, adds to project board with status. Use for any internal issue."
metadata:
  steps: read-config-read-template-check-duplicates-compose-file-add-project
  scope: internal-repo-only
  dependencies: gh-cli
---

# Create Internal Issue Skill

Files issues on the project's own GitHub repo. Auto-discovers repo + project config from `.pi/settings.json`, loads correct template, checks for duplicates, creates issue, adds to project board.

## Trigger

Load this skill when the user asks to:

- "Create an issue for [X]"
- "File a bug about [X]"
- "Write a feature request for [X]"
- "Create a GitHub issue about [X]"
- Any task involving creating an issue on **this project's repo**

Do **NOT** load for external repos (use `create-external-issue` skill).

## Preconditions

### Authentication

```bash
gh auth status
```

Exit non-zero → stop: "`gh` CLI not authenticated. Run `gh auth login`."

### Scope Gate

This skill works on the repo defined in `.pi/settings.json` → `supervisor.repo`. For repos outside this project → use `create-external-issue` skill.

---

## Step-by-Step

---

### Step 1 — Read Repo Config from .pi/settings.json

Read settings to get repo + project config:

```bash
read /home/miria/git/main/.pi/settings.json
```

Extract these values (parse manually from the file):

| Variable | JSON path | How to extract |
|----------|-----------|----------------|
| `REPO` | `supervisor.repo` | Find `"repo": "OWNER/REPO"` in file |
| `PROJECT_NUM` | `supervisor.projectNumber` | Find `"projectNumber": N` in file |
| `STATUS_FIELD` | `supervisor.statusField` | Find `"statusField": "Status"` in file |
| `STATUS_MAPPING` | `supervisor.statusMapping` | Find mapping object |

Set variables for later use:

```bash
REPO="<extracted value>"
PROJECT_NUM="<extracted value>"
```

Verify repo exists:

```bash
gh repo view "$REPO" --json name --jq '.name' > /dev/null
```

If fails → stop: "Repo `$REPO` not found or no access."

---

### Step 2 — Determine Issue Type & Read Template

#### 2a — Classify the Issue

Ask user or infer from request:

| Type | Template file | Default label |
|------|--------------|---------------|
| Bug | `.github/ISSUE_TEMPLATE/bug_report.md` | `bug` |
| Feature request | `.github/ISSUE_TEMPLATE/feature_request.md` | `enhancement` |
| Other (task, docs, etc.) | No template — use freeform | determine label |

If unclear, ask user: "Is this a bug report, feature request, or other?"

#### 2b — Read Template File

For bug or feature:

```bash
read /home/miria/git/main/.github/ISSUE_TEMPLATE/<template-name>.md
```

Parse the template:

1. Read YAML frontmatter (between `---` delimiters):
   - `name` — template name
   - `about` — description
   - `title` — title prefix (e.g., `[Bug] `, `[Feature] `)
   - `labels` — default labels
   - `assignees` — default assignees

2. Extract markdown sections (lines starting with `## ` after frontmatter):
   - Record each section heading and its order
   - These become the issue body structure

#### 2c — For "Other" Issues

Use freeform markdown body. No template to fill. Compose directly from user description.

---

### Step 3 — Check for Duplicates

Before composing, verify issue doesn't already exist.

#### Search open issues by keywords

Generate 3 keyword permutations from proposed title. Search each:

```bash
gh issue list \
  --repo "$REPO" \
  --state open \
  --json title,number,labels \
  --limit 30 \
  --search "<keyword-permutation>"
```

Run for each permutation. Collect results.

#### Evaluate

| Condition | Action |
|-----------|--------|
| Exact/near-exact title match | **Stop.** Tell user: "Duplicate of #N. Review before filing." |
| Same root cause, different wording | **Stop.** Tell user: "Likely duplicate of #N. Review before filing." |
| Related but different | Note them. Proceed with caution. |
| Clean — no matches | Proceed to step 4. |

---

### Step 4 — Compose Issue Body

#### 4a — Write to temp file

```bash
TEMP_FILE="ignore/issue-body-internal-$(date +%s).md"
```

#### 4b — For bug reports

Fill template sections:

```
## Describe the bug

<clear, concise description>

## To Reproduce

Steps to reproduce:

1. <step 1>
2. <step 2>
3. <step 3>

## Expected behavior

<what should happen>

## Screenshots/Logs

<if applicable>

## Environment

- OS: <e.g., Ubuntu 22.04, macOS 14.5>
- Pi version: `pi --version`

## Additional context

<optional>
```

Write:

```bash
cat > "$TEMP_FILE" << 'EOF'
<body content>
EOF
```

#### 4c — For feature requests

Fill template sections:

```
## Problem statement

<what problem does this solve>

## Proposed solution

<how it should work>

## Alternative solutions

<what else was considered>

## Impact

<who benefits, what code areas touched>

## Additional context

<optional>
```

Write same way.

#### 4d — For other issues

Compose freeform body with clear sections. Minimum:

```
## Description

<what this issue is about>

## Acceptance Criteria

- [ ] <criterion 1>
- [ ] <criterion 2>

## Additional context

<optional>
```

Write to temp file.

---

### Step 5 — Create the Issue

#### 5a — Construct the title

| Type | Title format |
|------|-------------|
| Bug | `[Bug] <short description>` |
| Feature | `[Feature] <short description>` |
| Other | `<short description>` |

#### 5b — Determine labels

Start with defaults from template frontmatter. Add more based on context:

| Context | Additional labels |
|---------|------------------|
| Affects specific area | Use area label if exists |
| Major impact | `major` |
| Good for new contributors | `good first issue` |

List available labels:

```bash
gh label list --repo "$REPO" --json name --jq '.[].name'
```

Pick labels that exist in the repo. Pass as comma-separated:

```bash
gh issue create \
  --repo "$REPO" \
  --title "<title>" \
  --label "<label1>,<label2>" \
  --body-file "$TEMP_FILE"
```

Capture output — returns issue URL.

#### 5c — Extract issue number

```bash
ISSUE_URL="<output from gh issue create>"
ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oP '/issues/\K\d+')
```

#### 5d — Clean up temp file

```bash
rm "$TEMP_FILE"
```

---

### Step 6 — Add to Project Board

After issue created, add it to the kanban board and set initial status.

#### 6a — Discover project board config

Discover the project owner:

- Read `REPO` as `OWNER/REPO_NAME`
- `OWNER` is the project owner (user or org)

Discover project field IDs via GraphQL:

Use this query to get project field + option IDs:

```bash
# Determine if owner is user or org
gh api repos/$REPO --jq '.owner.type'
# Returns "User" or "Organization"
```

Then query project fields (replace `OWNER_TYPE` with `user` or `organization`, `OWNER_LOGIN` with the owner login, `PROJECT_NUM` from step 1):

```bash
gh api graphql -f query='
query {
  OWNER_TYPE(login: "OWNER_LOGIN") {
    projectV2(number: PROJECT_NUM) {
      id
      field(name: "STATUS_FIELD_NAME") {
        ... on ProjectV2SingleSelectField {
          id
          options { id name }
        }
      }
    }
  }
}' --jq '.data.OWNER_TYPE.projectV2'
```

If `OWNER_TYPE` is `user`, the GraphQL field is `user`. If `organization`, it's `organization`.

Parse the output:

| Extract | Description |
|---------|-------------|
| `projectId` | Project node ID (e.g., `PVT_kw...`) |
| `statusFieldId` | Status field ID (e.g., `PVTSSF_...`) |
| `statusOptions` | Array of `{id, name}` for each status option |

Build a mapping of status name → option ID from the response.

#### 6b — Add issue to project

```bash
gh project item-add "$PROJECT_NUM" \
  --owner "$OWNER" \
  --url "$ISSUE_URL" \
  --format json > ignore/project-add-result.json
```

Capture item ID:

```bash
ITEM_ID=$(python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" < ignore/project-add-result.json)
rm ignore/project-add-result.json
```

#### 6c — Set initial status

Map from issue type to status:

| Issue type | Status |
|-----------|--------|
| Bug report | `Backlog` |
| Feature request | `Backlog` |
| Other / task | `Backlog` |
| User specifies explicit stage | Use that stage |

Find the option ID for the chosen status from the mapping discovered in 6a.

Set status:

```bash
gh project item-edit \
  --project-id "$PROJECT_ID" \
  --id "$ITEM_ID" \
  --field-id "$STATUS_FIELD_ID" \
  --single-select-option-id "<option-id>"
```

---

## Summary Output

After creation, report:

```
Issue created: $ISSUE_URL
Project board: added with status "<status-name>"
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| `gh auth status` fails | Stop. "Run `gh auth login` to authenticate." |
| Duplicate found in step 3 | Stop. Report duplicate #N. Do NOT file. |
| Template file missing | Fall back to freeform body composition |
| `gh repo view` fails in step 1 | Stop. "Repo from settings.json not found or no access." |
| `gh issue create` fails | Show error. Check labels exist, title not empty. |
| `gh project item-add` fails | Issue created but not on board. Report both. |
| `gh project item-edit` fails | Issue on board but status not set. Report partial success. |
| GraphQL query fails in 6a | Issue created but not added to board. Report. |
| Rate limited (403) | Stop. "GitHub API rate limited. Wait and retry." |

## Writing Rules

1. **Neutral tone** — Third-person, factual. No emotional language.
2. **Reproducible steps** — Clear imperatives, ordered sequence.
3. **Exact versions** — Cite pi version, OS, package versions where relevant.
4. **Template sections** — Follow template order exactly. Do not reorder.
5. **Markdown** — Use headings (`##`), code blocks (```` ``` ````), and lists only.
6. **Temp file** — Always use `--body-file`, never `--body` inline.
7. **Cleanup** — Delete temp files after use.

## Rules

1. **Steps 1→2→3→4→5→6** — Execute in order. Never skip.
2. **One issue per invocation** — Create one issue then stop.
3. **No duplicate filing** — Step 3 check is mandatory.
4. **Template priority** — Bug/feature templates > freeform.
5. **Labels match template** — Use template frontmatter labels as base.
6. **Project board always** — Always add to project board after creation.
7. **Cleanup temp files** — Delete after use.
8. **Report outcome** — Provide URL + project board status.
9. **No hardcoded repo names** — Everything reads from `.pi/settings.json` or API discovery.
