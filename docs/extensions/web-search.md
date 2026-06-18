---
layout: default
title: Web Search
parent: Extensions
nav_order: 4
---

# Web Search

{: .no_toc }

[📄 README](https://github.com/SchneiderDaniel/cheasee-pi/blob/main/.pi/extensions/web-search/README.md)

**Why.** Web search via DuckDuckGo metasearch engine — returns ranked results with titles, URLs, snippets. Designed to discover URLs for follow-up crawling with `web_crawl`. Result cache with 5-minute TTL.

**How it works.** Registers `web_search` tool. On first call, auto-creates `.pi/web-search-venv/` and installs `ddgs` from `requirements.txt`. Each call writes Python script to per-call isolated temp directory (`ignore/web-search/search-<random>/`) — prevents file races under concurrent calls. Executes via `pi.exec` bash subprocess. Results parsed from `SEARCH_OK`/`SEARCH_DONE` delimiters. Cached in memory (5-min TTL). Errors propagate as thrown exceptions for proper `isError` signaling via the framework. SIGTERM handled — Python subprocess exits cleanly with code 130 on cancellation.

**Location:** `.pi/extensions/web-search/`
