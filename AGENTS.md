# Cheasee-Pi: The Pi (repository instructions)

> The cheasee-pi **global operating instructions** — system role, tool-routing
> matrix, prohibited operations, execution protocols, package-safety audit —
> are installed globally as `~/.pi/agent/APPEND_SYSTEM.md` (source:
> `APPEND_SYSTEM.md` at this repo root). Pi appends them to the system prompt
> in EVERY repository. This file holds only cheasee-pi-repo-specific policy.

<system_directives>
- TYPESCRIPT: The root `tsconfig.json` extends `.pi/tsconfig.json`. You MUST run `npm run tsc:extensions` or `tsc --noEmit` to validate type checks.
- GITHUB ISSUES: Always use the repository defined in `.pi/settings.json` (supervisor.repo). Never query the git remote directly.
- TEMPORARY FILES: All temporary files MUST be saved to the `ignore/` folder and deleted immediately after use.
</system_directives>

<CRITICAL_OVERRIDES>
- THE MAIN BRANCH IS LOCKED. You are strictly forbidden from committing directly to main. Create a worktree, push and create PR. Merge only by user. Agent never merge.
</CRITICAL_OVERRIDES>
