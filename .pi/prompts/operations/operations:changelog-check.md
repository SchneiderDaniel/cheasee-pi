---
description: Check last two major pi releases for changes relevant to our extensions. File one GitHub issue per extension with improvement opportunities.
---

# Changelog Check — Cross-Reference Pi Releases Against Extensions

Read the last two **major** pi releases (x.0 — patch releases excluded), extract new features and API additions, then check every extension in `.pi/extensions/` for improvement opportunities. File one GitHub issue per extension listing actionable improvements.

Requires: `gh` CLI authenticated.

## Sources

| Source | Path | What to Extract |
|--------|------|-----------------|
| **CHANGELOG** | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md` | Last two major (x.0) release sections — New Features, Added, Changed items |
| **Releases page** | `https://github.com/earendil-works/pi/releases` | Supplemental details, linked docs |
| **Extensions guide** | `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` | API reference for cross-referencing new features |
| **Settings docs** | `.pi/settings.json` | `supervisor.repo` for GitHub issue target |

## Workflow

### Step 1 — Read Configuration

Read `.pi/settings.json`:

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

Export for reuse:

```bash
export REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
export OWNER=$(echo $REPO | cut -d'/' -f1)
export REPO_NAME=$(echo $REPO | cut -d'/' -f2)
```

Verify repo exists:

```bash
gh repo view "$REPO" --json name --jq '.name'
```

If missing or invalid, stop and report.

### Step 2 — Identify Last Two Major Releases

Read the CHANGELOG and identify the most recent **two x.0 releases** (e.g., `0.79.0`, `0.78.0`). Skip patch releases (0.79.1, 0.78.1, etc.).

Extract from each release:

- **New Features** — headline feature blocks (bold headings)
- **Added** — bullet points about new APIs, methods, events, exports
- **Changed** — breaking or behavioral changes that affect extensions

Read the CHANGELOG:

```bash
read /usr/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md
```

If needed, also check the GitHub releases page for any release notes not captured in CHANGELOG:

```bash
curl -s "https://api.github.com/repos/earendil-works/pi/releases/tags/v<VERSION>" | jq '{tag_name, body}'
```

### Step 3 — Build Change Inventory

Create a structured inventory of changes relevant to **extension authors**. Categorize each:

| Category | Examples |
|----------|----------|
| **New extension API** | New events, new ctx methods, new pi.register* methods, new exports |
| **New tool APIs** | Changes to tool registration, execution, rendering |
| **New UI APIs** | New ctx.ui methods, new widget types, new overlay types |
| **New event hooks** | New lifecycle events, new event payload fields |
| **Behavior changes** | Breaking or important behavioral shifts extensions must handle |
| **New features usable by extensions** | Features extensions can leverage (project trust, autocomplete triggers, etc.) |

Write to a temp file:

```bash
cat > ignore/changelog-inventory.json << 'EOF'
{
  "release": "0.79.0",
  "changes": [
    {
      "category": "New extension API",
      "item": "project_trust event - extensions can handle, decide, defer project trust",
      "docs": "docs/extensions.md#project_trust",
      "relevant_extensions": ["supervisor", "check-extensions"]
    }
  ]
}
EOF
```

Be thorough — **every** Added/Changed item that touches extension surfaces must be captured.

### Step 4 — Discover All Extensions

```bash
ls -d .pi/extensions/*/
```

For each extension, read its entry file(s) to understand:

- What it does
- What pi APIs it uses (events, tools, commands, ui, rendering)
- What state it manages
- What custom rendering it has

Read each extension's main entry:

```bash
read .pi/extensions/<name>/index.ts
```

If the extension has a README or package.json, read those too.

### Step 5 — Cross-Reference Changes Against Each Extension

For each change in the inventory (Step 3), check every extension for:

1. **Direct applicability** — The extension could use this new API
   - New event → extension registers similar events → can adopt the new one
   - New ctx method → extension does similar work manually → can simplify
   - New tool API → extension registers tools → can adopt new patterns

2. **Indirect benefit** — The extension's output/behavior could improve
   - Project trust → extension that handles sensitive data could integrate
   - New rendering → extension with custom UI could use it

3. **Required adaptation** — Behavior change that the extension must handle
   - Breaking change in event payload → extension must update handler
   - Deprecated API → extension must migrate

Skip changes with zero relevance to any extension.

### Step 6 — File One Issue Per Extension

For each extension with at least one actionable improvement, create a GitHub issue.

#### Issue Title

```
Changelog Check: <extension-name> — <YYYY-MM-DD>
```

#### Issue Labels

Create on demand if missing:

```bash
gh label create "changelog-check" --repo "$REPO" 2>/dev/null || true
gh label create "improvement" --repo "$REPO" 2>/dev/null || true
```

Apply: `changelog-check`, `improvement`, and `<extension-name>`.

#### Issue Body Template

```markdown
## Changelog Check: `<extension-name>`

Date: <YYYY-MM-DD>
Releases inspected: <v0.X.0, v0.Y.0>

### Improvement Opportunities

#### 1. **[Category] Title** — Short actionable description

**Relevant change:** v0.X.0 — `New Feature: feature name`
**Source:** CHANGELOG entry or doc link

**Current state:** What the extension does today (code excerpt optional)

**Improvement:** What the extension should do instead / additionally

**Effort:** small / medium / large

**Risk:** low / medium / high

---

#### 2. **[Category] Title**

...
```

### Step 7 — Report Summary

After filing all issues, print:

```
Changelog Check complete.
Releases inspected: v0.X.0, v0.Y.0
Extensions checked: N
Issues filed: M
  - <url>
  - <url>
Extensions skipped (no changes): K (names)
```

## Change Categories Reference

Use these to classify each improvement opportunity:

| Category | Description |
|----------|-------------|
| `New event` | Extension should listen for a new lifecycle event |
| `New ctx method` | Extension can replace manual logic with a new ctx method |
| `New tool API` | Extension's tool registration/execution can adopt new patterns |
| `New UI primitive` | Extension can use new ctx.ui or TUI components |
| `New export` | Extension can import from new public export |
| `Behavior change` | Extension must update handler for changed behavior |
| `Best practice` | Extension should follow new recommended pattern |
| `Simplification` | New feature allows removing boilerplate |

## Constraints

- **Title MUST NOT contain standalone `/`** — bash tool path validation blocks it
- Write issue body to file first, then create from file
- **One issue per extension** — do not batch multiple extensions into one issue
- **Skip extensions with zero improvements** — do not file empty issues
- Always verify the repo exists before creating issues
- Use `gh api graphql` for all GitHub mutations, not `gh issue create` with inline body

## Quality Checklist

- [ ] Last two major (x.0) releases identified, not patch releases
- [ ] Each change classified into extension-relevant category
- [ ] Each extension cross-referenced against all changes
- [ ] Each issue has actionable improvement, not just "consider using X"
- [ ] Each improvement has effort estimate (small/medium/large)
- [ ] Each improvement has risk rating (low/medium/high)
- [ ] Issues filed with correct labels
- [ ] Extensions with zero changes are noted, no empty issues filed
