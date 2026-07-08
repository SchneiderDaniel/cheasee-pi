// ─── GitHub Module Entry ─────────────────────────────────────────
// Composition root: exports the GitHubPort interface and factory.
// Pipeline code depends only on GitHubPort — zero Octokit imports
// beyond the adapter.
// git.ts operations (commitAndPush) are re-exported for backward compat.

export { createGitHubPort } from "./ports.ts";
export { commitAndPush } from "./git.ts";
