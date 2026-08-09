/**
 * Inline Python script that uses ddgs for web search.
 *
 * Volatile detail (ddgs API surface) hidden behind string export.
 * Callers never see script content — import SEARCH_SCRIPT and pass to subprocess.
 *
 * The script:
 * 1. Reads config from a JSON file (path passed as sys.argv[1])
 * 2. Creates DDGS instance with optional proxy/timeout
 * 3. Calls DDGS().text(query, max_results=N, backend="auto")
 * 4. Prints SEARCH_OK delimiter, JSON results, SEARCH_DONE delimiter
 * 5. Catches exceptions and returns error JSON
 */

export const SEARCH_SCRIPT = `
import json
import sys
import signal

signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(130))

def main():
    with open(sys.argv[1]) as f:
        config = json.load(f)

    query = config["query"]
    max_results = config.get("max_results", 10)
    proxy = config.get("proxy")
    timeout = config.get("timeout", 5)

    kwargs = {}
    if proxy:
        kwargs["proxy"] = proxy
    if timeout:
        kwargs["timeout"] = timeout

    try:
        from ddgs import DDGS

        ddgs = DDGS(**kwargs) if kwargs else DDGS()
        results = list(ddgs.text(query, max_results=max_results, backend="auto"))

        out = []
        for r in results:
            out.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", ""),
            })

        print("SEARCH_OK")
        print(json.dumps({"ok": True, "results": out}))
        print("SEARCH_DONE")
    except Exception as e:
        print("SEARCH_OK")
        print(json.dumps({"ok": False, "error": str(e)}))
        print("SEARCH_DONE")

main()
`;
