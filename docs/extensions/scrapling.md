---
layout: default
title: Web Crawl (scrapling)
parent: Extensions
nav_order: 3
---

# Web Crawl (scrapling)

{: .no_toc }

[📄 README](../../.pi/extensions/scrapling/README.md)

**Why.** Crawl web pages behind Cloudflare and extract content as Markdown. Progressive fetching — starts lightweight (`curl_cffi`), escalates to patchright stealth when blocked. Auto-installs Python venv on first call.

**How it works.** Registers `web_crawl` tool. On first call, creates `.pi/scrapling-venv/` with `scrapling[fetchers]` and `markdownify`. Validates URL, acquires concurrency semaphore (max 2 concurrent — protects 8GB RAM). Runs Python subprocess: lightweight curl_cffi fetch → patchright stealth on Cloudflare block. Extracts Markdown via `markdownify`, truncates by `maxTokens` parameter. Returns formatted `--- URL (via method) ---\ncontent`. Configurable via `config.json`.

**Troubleshooting:** A `web_crawl` failure naming a missing `chromium-<revision>` means the browser cache and the installed `patchright` disagree. The venv is fine — reinstalling it does not help. Rebuild the image (the pins live in `cmd/cheasee-pi/embedded/docker/scrapling-constraints.txt`), or, where the cache is writable:

```bash
.pi/scrapling-venv/bin/python -m patchright install chromium
```

**Location:** `.pi/extensions/scrapling/`

## Details

### Architecture

Port-based adapter pattern for progressive web crawling:

```
├── index.ts           # Entry: tool registration, URL validation, concurrency semaphore (max 2)
├── crawler-engine.ts  # CrawlerEngine interface + crawl() orchestration
├── python-adapter.ts  # PythonAdapter: subprocess orchestration via pi.exec
├── python-script.ts   # Inline Python crawler script using scrapling library
├── venv-setup.ts      # Auto-create .pi/scrapling-venv + pip install scrapling[fetchers] + markdownify
├── types.ts           # CrawlResult, CrawlPage types
├── mock-adapter.ts    # Mock adapter for testing (no network)
└── test/              # Unit + integration tests
```

### Progressive Fetch Strategy

```mermaid
flowchart TD
    A[Crawl URL] --> B[curl_cffi: lightweight fetch]
    B -- success --> C[Extract content]
    B -- Cloudflare block --> D[patchright stealth mode]
    D -- success --> C
    D -- failure --> E[Fallback: report error]
    C --> F[markdownify: HTML→Markdown]
    F --> G[Truncate by maxTokens]
    G --> H[Return result]
```

### Key Design Decisions

- **Concurrency semaphore (max 2)** — Protects 8GB RAM. `acquireCrawlLock()` uses polling loop (1000ms interval). Excessive for concurrent needs but safe for infrequent crawl calls.
- **Progressive escalation** — Starts with `curl_cffi` (lightweight, no browser). If Cloudflare blocks, escalates to patchright stealth. Never runs both.
- **Auto-installing venv** — On first call, creates `.pi/scrapling-venv/` and installs the pinned stack. The container entrypoint refreshes the copy when the baked venv changes or the copy is not agent-owned; a browser miss fails fast with the expected revision instead of reinstalling the venv.
- **maxPages cap at 10** — Hard upper bound prevents runaway crawling. Default 1.
- **maxTokens truncation** — Content truncated with notice. 0 = no limit.
- **URL validation via `new URL()`** — Rejects invalid URLs early. No protocol restriction (http/https/ftp/etc).
- **Python subprocess via `python-adapter.ts`** — Wraps `pi.exec` for subprocess orchestration. Handles `signal` cancellation for clean shutdown.

### Output Format

```markdown
--- https://example.com (via curl_cffi) ---
# Page Title

Content extracted as Markdown...
```

### Structured Output Contract

Alongside the model-facing markdown in `content`, `web_crawl` declares an `outputSchema` and returns a `structuredContent` payload for programmatic (codemode) callers. `index.ts` registers `outputSchema: crawlOutputSchema` (from `structured-output.ts`, the single source of truth) and projects each result with `toStructuredContent`.

Success branch (`ok: true`):

| key        | type     | meaning                              |
| ---------- | -------- | ------------------------------------ |
| ok         | true     | discriminator: success               |
| pages      | array    | per-page results                     |
| totalPages | number   | number of successfully crawled pages |
| attempted  | number   | pages the adapter attempted          |
| failed     | string[] | URLs that failed                     |
| truncated  | boolean  | any page hit the `maxTokens` cap     |

Each entry in `pages` carries `url`, `markdown`, `method` (`lightweight` or `stealth`), and its own per-page `truncated` flag.

Error branch (`ok: false`): the tool returns `{ ok: false, error: { url, reason } }` with `isError` signaling, so the model sees the failure while codemode callers still receive a typed payload.

### Tool Annotations

`index.ts` registers `annotations: { readOnlyHint: true, openWorldHint: true }`. Crawling reaches arbitrary network hosts, so `openWorldHint: true` marks the external egress, and `readOnlyHint: true` marks the crawl itself as a non-mutating external read — fetched pages are not modified and crawl results are not persisted. Caveat: the first call is not entirely side-effect-free locally. Environment setup creates `.pi/scrapling-venv/`, `pip`-installs scrapling, and (on stealth escalation) downloads Chromium, so permission tooling should treat the initial invocation as potentially writing local files as well as reaching the network. That setup is idempotent and cached on subsequent calls. This intentionally diverges from `web-search`, which leaves `readOnlyHint` unset for the same first-call pip-install side effect.

### Troubleshooting

Crawling failures are typed. `python -m pip`/venv errors mean the Python side; a message naming a missing
`chromium-<revision>` path means the browser cache and the installed `patchright` disagree — the venv is
healthy, so deleting it does not help. Rebuild the image (the pins live in
`cmd/cheasee-pi/embedded/docker/scrapling-constraints.txt`), or install the expected build where the cache
is writable:

```bash
.pi/scrapling-venv/bin/python -m patchright install chromium
```

### Testing

Tests cover:
- Mock adapter: returns predefined results without network
- Venv setup: creation, cache, re-creation on failure
- Python adapter: subprocess invocation, cancellation via signal
- Type validation: required fields, optional fields
- Progressive fetch logic: lightweight → stealth escalation sequence
