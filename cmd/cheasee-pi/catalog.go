package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// ModelCatalog resolves the model list for a provider. The remote pi.dev
// catalog is the primary source — the same endpoint pi itself fetches via
// its remote-catalog-provider — so the CLI picker and pi can never disagree.
// An error means "use the static KnownModels seed": callers never treat a
// catalog failure as fatal.
type ModelCatalog interface {
	Models(ctx context.Context, provider string) ([]string, error)
}

// Catalog constants mirror pi's remote-catalog-provider.ts: REMOTE_CATALOG_
// REFRESH_INTERVAL_MS (4h TTL), REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS (4s
// per-attempt timeout — a stalled fetch must not block the picker), and
// fetchWithRetry (bounded retry loop).
const (
	catalogTTL            = 4 * time.Hour
	catalogAttemptTimeout = 4 * time.Second
	catalogAttempts       = 2
)

// newModelCatalog is the package-var seam (newInitDeps precedent) tests
// replace with a stub to drive the picker call sites without a real fetch.
var newModelCatalog = func() ModelCatalog { return newRemoteModelCatalog() }

// remoteModelCatalog is the ModelCatalog adapter: GETs
// https://pi.dev/api/models/providers/<provider>, caches per provider in the
// version-keyed CacheDir with pi's 4h TTL + etag conditional semantics, and
// sorts ids deterministically (the response is a map). The adapter has only
// httpClient/baseURL/cacheDir fields — it never sees the prompted API key
// (the key belongs to the provider, not pi.dev), so a catalog request can
// never carry provider credentials.
type remoteModelCatalog struct {
	httpClient     *http.Client
	baseURL        string // seam for tests (https://pi.dev by default)
	cacheDir       string // empty → resolve via CacheDir() on first use
	attemptTimeout time.Duration
	warnf          func(format string, args ...any) // cache-write warnings; nil → silent
	flights        sync.Map                        // provider → *catalogFlight (singleflight)
}

func newRemoteModelCatalog() *remoteModelCatalog {
	return &remoteModelCatalog{
		httpClient:     http.DefaultClient,
		baseURL:        "https://pi.dev",
		attemptTimeout: catalogAttemptTimeout,
		warnf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "  ⚠ "+format+"\n", args...)
		},
	}
}

// catalogModel is the per-model metadata each catalog entry carries.
type catalogModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// modelCatalogCache is the on-disk cache shape — pi's models-store overlay
// shape, one file per provider under <CacheDir()>/models/ — so a cached list
// doubles as the etag-backed body for conditional revalidation.
type modelCatalogCache struct {
	Models       []catalogModel `json:"models"`
	CheckedAt    time.Time      `json:"checkedAt"`
	LastModified string         `json:"lastModified"`
	ETag         string         `json:"etag"`
}

// ids returns the model ids in lexicographic order — the port contract is
// deterministic output regardless of the response map order or a hand-edited
// cache file.
func (c modelCatalogCache) ids() []string {
	return sortedIDs(c.Models)
}

// sortedIDs extracts and sorts model ids.
func sortedIDs(models []catalogModel) []string {
	ids := make([]string, len(models))
	for i, m := range models {
		ids[i] = m.ID
	}
	sort.Strings(ids)
	return ids
}

// catalogFlight is one in-flight fetch shared by concurrent Models() calls
// for the same provider (singleflight — the endpoint sees one request).
type catalogFlight struct {
	done chan struct{}
	ids  []string
	err  error
}

// Models returns the provider's sorted model ids: served from a fresh cache
// inside the TTL, else fetched (singleflight, etag-revalidated) and cached.
func (c *remoteModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	cacheDir, err := c.resolveCacheDir(ctx)
	if err != nil {
		return nil, err
	}
	cached, ok := c.readCache(cacheDir, provider)
	if ok && len(cached.Models) > 0 && time.Since(cached.CheckedAt) < catalogTTL {
		return cached.ids(), nil
	}

	// Singleflight: concurrent callers for the same provider share one fetch
	// instead of stampeding the endpoint; the shared atomicWrite cache write
	// stays torn-write safe (last-wins, both valid).
	if prev, loaded := c.flights.LoadOrStore(provider, &catalogFlight{done: make(chan struct{})}); loaded {
		f := prev.(*catalogFlight)
		select {
		case <-f.done:
			return f.ids, f.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	owner, _ := c.flights.Load(provider)
	defer c.flights.Delete(provider)

	ids, err := c.fetchWithRetry(ctx, cacheDir, provider, cached)
	f := owner.(*catalogFlight)
	f.ids, f.err = ids, err
	close(f.done)
	return ids, err
}

// resolveCacheDir returns the version-keyed cache dir, creating it on first
// use. Never ~/.pi — the host-side CLI must not mutate container runtime
// state; the version key means upgraded binaries never mix stale catalogs.
func (c *remoteModelCatalog) resolveCacheDir(ctx context.Context) (string, error) {
	if c.cacheDir != "" {
		return c.cacheDir, nil
	}
	return ensureCacheDir(ctx)
}

// cachePath names the per-provider cache file. The provider id is escaped
// (same escaping as the request URL) so a weird id cannot escape the models/
// dir or collide with a sibling.
func (c *remoteModelCatalog) cachePath(cacheDir, provider string) string {
	return filepath.Join(cacheDir, "models", url.PathEscape(provider)+".json")
}

// readCache loads the per-provider cache file. A missing or malformed file
// is a miss (refetch), never a hard error.
func (c *remoteModelCatalog) readCache(cacheDir, provider string) (modelCatalogCache, bool) {
	data, err := os.ReadFile(c.cachePath(cacheDir, provider))
	if err != nil {
		return modelCatalogCache{}, false
	}
	var entry modelCatalogCache
	if err := json.Unmarshal(data, &entry); err != nil {
		return modelCatalogCache{}, false
	}
	return entry, true
}

// writeCache persists the entry atomically (atomicWrite's .tmp+rename — a
// crash cannot leave a partial file behind). Best-effort: the fetched list is
// already the answer, so a cache-dir hiccup degrades the cache, never the
// result fed to the picker.
func (c *remoteModelCatalog) writeCache(cacheDir, provider string, entry modelCatalogCache) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return atomicWrite(c.cachePath(cacheDir, provider), data, 0644, false)
}

// fetchWithRetry runs the bounded fetch loop: transient failures (network,
// 5xx) retry up to catalogAttempts; 404/501 ("catalog gone") and ctx
// cancellation stop immediately. On 304 the cached body is kept and only
// freshness advances — a 304 can never leave the overlay empty. A failure
// leaves any stale cache file untouched (fetched-once semantics preserved).
func (c *remoteModelCatalog) fetchWithRetry(ctx context.Context, cacheDir, provider string, cached modelCatalogCache) ([]string, error) {
	var lastErr error
	for attempt := 1; attempt <= catalogAttempts; attempt++ {
		models, lastModified, etag, err := c.fetch(ctx, provider, cached)
		if err == nil {
			// Best-effort cache: the live list is already the answer, so a
			// cache-dir hiccup must not degrade an online fetch to the offline
			// seed — but it must not be silent either (an unwritable cache
			// would otherwise refetch every run without the user knowing why).
			if werr := c.writeCache(cacheDir, provider, modelCatalogCache{
				Models:       models,
				CheckedAt:    time.Now(),
				LastModified: lastModified,
				ETag:         etag,
			}); werr != nil && c.warnf != nil {
				c.warnf("model catalog cache write failed for %s: %v", provider, werr)
			}
			return sortedIDs(models), nil
		}
		lastErr = err
		if errors.Is(err, errCatalogGone) || ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

// errCatalogGone marks the permanent 404/501 "catalog gone" statuses — pi
// treats them as overlay-disabled (caller seeds), never retried.
var errCatalogGone = errors.New("model catalog unavailable for provider")

// fetch performs one HTTP attempt within a per-attempt timeout (pi's
// REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS). 200 → fresh body; 304 → the cached
// models stand, only headers refresh; 404/501 → permanent error; anything
// else → transient error.
func (c *remoteModelCatalog) fetch(ctx context.Context, provider string, cached modelCatalogCache) ([]catalogModel, string, string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, c.attemptTimeout)
	defer cancel()

	u := c.baseURL + "/api/models/providers/" + url.PathEscape(provider)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", "", err
	}
	// The same headers pi's remote-catalog-provider sends — and critically NO
	// credential header: the prompted API key belongs to the provider, never
	// to pi.dev.
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "cheasee-pi/"+cliVersionKey)
	if len(cached.Models) > 0 && cached.ETag != "" {
		// Conditional only when a cached body backs the validator — a 304
		// can never empty the list (pi's 304-with-no-body pitfall).
		req.Header.Set("If-None-Match", cached.ETag)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, "", "", err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, "", "", err
		}
		models, err := parseCatalog(data)
		if err != nil {
			return nil, "", "", err
		}
		if len(models) == 0 {
			return nil, "", "", errors.New("empty model catalog for provider")
		}
		return models, resp.Header.Get("Last-Modified"), resp.Header.Get("ETag"), nil
	case http.StatusNotModified:
		if len(cached.Models) == 0 {
			return nil, "", "", errors.New("304 without a cached body")
		}
		lastModified := resp.Header.Get("Last-Modified")
		if lastModified == "" {
			lastModified = cached.LastModified
		}
		return cached.Models, lastModified, cached.ETag, nil
	case http.StatusNotFound, http.StatusNotImplemented:
		return nil, "", "", fmt.Errorf("%w %q: HTTP %d", errCatalogGone, provider, resp.StatusCode)
	default:
		return nil, "", "", fmt.Errorf("model catalog request failed for %s: %s", provider, resp.Status)
	}
}

// parseCatalog decodes the response shapes pi's parseCatalog accepts: a plain
// object map keyed by model id ({id: {id,name,...}} — the live endpoint's
// shape), a {models:[...]} wrapper, or a bare array. Entries without an id
// are dropped (pi drops them too).
func parseCatalog(data []byte) ([]catalogModel, error) {
	var models []catalogModel
	if err := json.Unmarshal(data, &models); err == nil {
		return dropIDless(models), nil
	}
	var wrapped struct {
		Models []catalogModel `json:"models"`
	}
	if err := json.Unmarshal(data, &wrapped); err == nil && wrapped.Models != nil {
		return dropIDless(wrapped.Models), nil
	}
	var byID map[string]catalogModel
	if err := json.Unmarshal(data, &byID); err != nil {
		return nil, fmt.Errorf("invalid catalog response: %w", err)
	}
	out := make([]catalogModel, 0, len(byID))
	for _, m := range byID {
		out = append(out, m)
	}
	return dropIDless(out), nil
}

// dropIDless filters entries without an id rather than inventing one from the
// map key — matching pi's parseCatalog exactly.
func dropIDless(models []catalogModel) []catalogModel {
	out := models[:0]
	for _, m := range models {
		if m.ID != "" {
			out = append(out, m)
		}
	}
	return out
}

// modelsFor returns the picker list for a provider: the live catalog's sorted
// ids when available, else the KnownModels seed (offline/error fallback).
// Providers with empty seeds (together, cerebras) gain a live picker for the
// first time — the catalog list gates the picker, not KnownModels.
func modelsFor(ctx context.Context, catalog ModelCatalog, provider string) []string {
	ids, err := catalog.Models(ctx, provider)
	if err == nil && len(ids) > 0 {
		return ids
	}
	return KnownModels[provider]
}

// modelChoice resolves a provider's default model and picker list from ONE
// catalog lookup. The previous defaultModelFor + modelsFor pair consulted the
// catalog independently, so a cold cache with a stalled/failing pi.dev request
// ran the fetch/retry loop twice (up to 4 attempts ≈ 16s per provider) to
// produce two results that one call could produce. The static override
// short-circuits the default before any fetch; needList is false exactly when
// the caller will not run the interactive picker (auth add --no-input), so an
// override provider stays fully offline without the list.
func modelChoice(ctx context.Context, catalog ModelCatalog, provider string, needList bool) (def string, models []string) {
	if m, ok := staticDefaultModel[provider]; ok {
		if !needList {
			return m, nil
		}
		return m, modelsFor(ctx, catalog, provider)
	}
	// No override: the default and the list share one result — sorted-first
	// live id (or the seed's first entry when the catalog failed).
	ids, err := catalog.Models(ctx, provider)
	if err == nil && len(ids) > 0 {
		return ids[0], ids
	}
	return DefaultModel(provider), KnownModels[provider]
}