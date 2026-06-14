/**
 * Inline Python script that uses Scrapling's progressive fetching strategy.
 *
 * Volatile detail (Scrapling API surface) hidden behind string export.
 * Callers never see script content — import SCRAPLING_SCRIPT and pass to subprocess.
 *
 * Progressive Fetching Strategy:
 *   Tier 1: Lightweight zero-browser curl_cffi fetcher (~40MB RAM)
 *   Tier 2: Heavy Playwright StealthyFetcher (~800MB RAM) — only when blocked
 */

export const SCRAPLING_SCRIPT = `
import json
import sys
import signal
from urllib.parse import urljoin, urlparse
import markdownify


def _signal_handler(signum, frame):
    """Clean up browser on SIGTERM and exit."""
    try:
        from scrapling.fetchers import StealthyFetcher
        if hasattr(StealthyFetcher, '_browser') and StealthyFetcher._browser:
            try:
                StealthyFetcher._browser.close()
            except:
                pass
    except:
        pass
    sys.exit(1)


signal.signal(signal.SIGTERM, _signal_handler)

def fetch_page(url):
    from scrapling.fetchers import Fetcher, StealthyFetcher

    # Tier 1: Lightweight Zero-Browser Fetch (~40MB RAM)
    try:
        page = Fetcher.get(url, timeout=15)
        page_html = str(page.html_content)
        is_blocked = page.status in [403, 503] or "cloudflare" in page_html.lower() or "just a moment" in page_html.lower()

        if not is_blocked:
            return {"html": page_html, "method": "lightweight"}
    except Exception:
        pass  # Fall through to heavy fetcher on error

    # Tier 2: Heavy Headless Browser (~800MB RAM) - Only used if blocked
    StealthyFetcher.adaptive = True
    try:
        page = StealthyFetcher.fetch(
            url,
            headless=True,
            network_idle=True,
            solve_cloudflare=True,
        )
        return {"html": str(page.html_content), "method": "stealth"}
    except Exception as e:
        raise Exception(f"Stealth bypass failed: {str(e)}")
    finally:
        # Crucial: Ensure Playwright processes don't zombie
        if hasattr(StealthyFetcher, '_browser') and StealthyFetcher._browser:
            try:
                StealthyFetcher._browser.close()
            except:
                pass

def main():
    config = json.loads(sys.argv[1])
    url = config["url"]
    max_pages = min(max(1, config.get("maxPages", 1)), 10)

    results = []
    visited = set()
    queue = [url]

    while queue and len(visited) < max_pages:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)

        try:
            fetch_data = fetch_page(current)

            # Convert HTML to clean LLM-friendly Markdown
            md_text = markdownify.markdownify(
                fetch_data["html"],
                heading_style="ATX",
                strip=['script', 'style']
            ).strip()

            results.append({
                "url": current,
                "markdown": md_text,
                "method": fetch_data["method"],
                "success": True,
            })

            # Follow same-origin links safely
            if len(visited) < max_pages:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(fetch_data["html"], 'html.parser')
                for a_tag in soup.find_all('a', href=True):
                    # Fix: Resolve relative links
                    link = urljoin(current, a_tag['href'])
                    if link.startswith("http") and urlparse(link).netloc == urlparse(url).netloc:
                        if link not in visited and link not in queue:
                            queue.append(link)

        except Exception as e:
            results.append({"url": current, "error": str(e), "success": False})

    print(json.dumps({"ok": True, "results": results}))

if __name__ == "__main__":
    main()
`;
