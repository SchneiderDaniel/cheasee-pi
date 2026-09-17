package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// ──────────────────────────────────────────────
// remoteModelCatalog adapter
// ──────────────────────────────────────────────

func TestRemoteModelCatalog_ModelsSortedAndCacheWritten(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil) // serves catalogPlainMap

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want sorted %v", ids, catalogSorted)
	}
	if srv.reqs.Load() != 1 {
		t.Errorf("expected exactly 1 request, got %d", srv.reqs.Load())
	}
	if srv.lastURL != "/api/models/providers/opencode-go" {
		t.Errorf("request URL = %q, want /api/models/providers/opencode-go", srv.lastURL)
	}

	// Cache file written under the version-keyed CacheDir — never ~/.pi —
	// with the overlay shape, no .tmp residue.
	path := filepath.Join(cacheModelsDir(t), "opencode-go.json")
	if !strings.HasPrefix(path, filepath.Join(os.Getenv("XDG_CACHE_HOME"), "cheasee-pi", cliVersionKey)) {
		t.Errorf("cache file must live under the version-keyed CacheDir, got %q", path)
	}
	if strings.Contains(path, string(filepath.Separator)+".pi"+string(filepath.Separator)) {
		t.Errorf("cache file must never live under ~/.pi, got %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
	var entry modelCatalogCache
	if err := json.Unmarshal(data, &entry); err != nil {
		t.Fatalf("cache file malformed: %v", err)
	}
	if len(entry.Models) != 3 || entry.CheckedAt.IsZero() {
		t.Errorf("cache entry = %+v, want 3 models + checkedAt", entry)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Error("no .tmp residue after cache write")
	}
}

func TestRemoteModelCatalog_SecondCallWithinTTLServesCache(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil)

	cat := newTestCatalog(srv, 5*time.Second)
	ctx := context.Background()
	first, err := cat.Models(ctx, "opencode-go")
	if err != nil {
		t.Fatalf("first Models: %v", err)
	}
	second, err := cat.Models(ctx, "opencode-go")
	if err != nil {
		t.Fatalf("second Models: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Errorf("second call must return the cached list: %v vs %v", first, second)
	}
	if srv.reqs.Load() != 1 {
		t.Errorf("second call within TTL must serve the cache with zero HTTP requests, got %d", srv.reqs.Load())
	}
}

func TestRemoteModelCatalog_StaleCacheRefetchesConditionally(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	stale := fmt.Sprintf(`{"models":[{"id":"alpha-model","name":"Alpha"}],"checkedAt":%q,"etag":"v1"}`, time.Now().Add(-5*time.Hour).Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", stale)

	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != "v1" {
			t.Errorf("stale body must revalidate with If-None-Match, got %q", got)
		}
		w.Header().Set("ETag", "v2")
		fmt.Fprint(w, catalogPlainMap)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("stale refetch must return the fresh list, got %v", ids)
	}
	if srv.reqs.Load() != 1 {
		t.Errorf("stale cache must refetch exactly once, got %d", srv.reqs.Load())
	}
	data, _ := os.ReadFile(filepath.Join(cacheModelsDir(t), "opencode-go.json"))
	var entry modelCatalogCache
	if err := json.Unmarshal(data, &entry); err != nil {
		t.Fatal(err)
	}
	if entry.ETag != "v2" || len(entry.Models) != 3 || time.Since(entry.CheckedAt) > time.Minute {
		t.Errorf("cache must carry the fresh body + etag + checkedAt, got %+v", entry)
	}
}

func TestRemoteModelCatalog_NotModifiedKeepsListAdvancesFreshness(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	checkedAt := time.Now().Add(-5 * time.Hour)
	stale := fmt.Sprintf(`{"models":[{"id":"alpha-model","name":"Alpha"}],"checkedAt":%q,"etag":"v1"}`, checkedAt.Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", stale)

	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != "v1" {
			t.Errorf("If-None-Match = %q, want v1", got)
		}
		w.WriteHeader(http.StatusNotModified)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, []string{"alpha-model"}) {
		t.Errorf("304 must keep the last-known list, got %v", ids)
	}

	data, _ := os.ReadFile(filepath.Join(cacheModelsDir(t), "opencode-go.json"))
	var entry modelCatalogCache
	if err := json.Unmarshal(data, &entry); err != nil {
		t.Fatal(err)
	}
	if len(entry.Models) != 1 || entry.Models[0].ID != "alpha-model" {
		t.Errorf("304 must not overwrite the cached body, got %+v", entry.Models)
	}
	if !entry.CheckedAt.After(checkedAt) {
		t.Errorf("304 must advance checkedAt, got %v (was %v)", entry.CheckedAt, checkedAt)
	}
	if entry.ETag != "v1" {
		t.Errorf("304 keeps the etag, got %q", entry.ETag)
	}
}

func TestRemoteModelCatalog_IfNoneMatchOnlyWhenBodyExists(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// Metadata-only cache (etag, no models) — the conditional header must not
	// be sent, or a 304 would empty the list (pi's pitfall).
	stale := fmt.Sprintf(`{"models":[],"checkedAt":%q,"etag":"v1"}`, time.Now().Add(-5*time.Hour).Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", stale)

	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != "" {
			t.Errorf("If-None-Match = %q, want empty (no cached body)", got)
		}
		fmt.Fprint(w, catalogPlainMap)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want %v", ids, catalogSorted)
	}
}

func TestRemoteModelCatalog_GoneStatusesErrorWithoutRetry(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusNotImplemented} {
		t.Run(fmt.Sprintf("status %d", status), func(t *testing.T) {
			t.Setenv("XDG_CACHE_HOME", t.TempDir())
			srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))

			cat := newTestCatalog(srv, 5*time.Second)
			_, err := cat.Models(context.Background(), "opencode-go")
			if err == nil {
				t.Fatal("expected error for catalog-gone status")
			}
			if !strings.Contains(err.Error(), "opencode-go") {
				t.Errorf("error should name the provider: %v", err)
			}
			if srv.reqs.Load() != 1 {
				t.Errorf("404/501 must not retry, got %d requests", srv.reqs.Load())
			}
		})
	}
}

func TestRemoteModelCatalog_TransientErrorsRetryThenFail(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// Pre-existing stale cache must survive the failed refresh untouched.
	stale := fmt.Sprintf(`{"models":[{"id":"alpha-model","name":"Alpha"}],"checkedAt":%q,"etag":"v1"}`, time.Now().Add(-5*time.Hour).Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", stale)
	cachePath := filepath.Join(cacheModelsDir(t), "opencode-go.json")
	before, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}

	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	_, err = cat.Models(context.Background(), "opencode-go")
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected transient-failure error, got %v", err)
	}
	if srv.reqs.Load() != catalogAttempts {
		t.Errorf("transient failure must retry %d times, got %d requests", catalogAttempts, srv.reqs.Load())
	}
	after, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Error("failed refresh must preserve the stale cache byte-identical")
	}
}

func TestRemoteModelCatalog_RetrySucceedsOnSecondAttempt(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	var srv *catalogServer
	srv = newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if srv.reqs.Load() == 1 { // first attempt fails, retry succeeds
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, catalogPlainMap)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models must succeed on retry: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want %v", ids, catalogSorted)
	}
	if srv.reqs.Load() != 2 {
		t.Errorf("expected first-attempt failure + retry, got %d requests", srv.reqs.Load())
	}
}

func TestRemoteModelCatalog_StalledRequestBoundsByAttemptTimeout(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// The handler never responds — the per-attempt timeout must abort each
	// attempt so the picker is not blocked by a stalled fetch.
	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))

	cat := newTestCatalog(srv, 50*time.Millisecond)
	start := time.Now()
	_, err := cat.Models(context.Background(), "opencode-go")
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("stalled fetch must abort per attempt (2×50ms + margin), took %v", elapsed)
	}
	if srv.reqs.Load() != catalogAttempts {
		t.Errorf("expected both attempts to hit the stall, got %d", srv.reqs.Load())
	}
}

func TestRemoteModelCatalog_ContextCancellationAbortsNoPartialCache(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()

	start := time.Now()
	_, err := cat.Models(ctx, "opencode-go")
	if err == nil {
		t.Fatal("expected error for cancelled context")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("cancellation must abort the in-flight request promptly, took %v", elapsed)
	}
	if _, statErr := os.Stat(filepath.Join(cacheModelsDir(t), "opencode-go.json")); !os.IsNotExist(statErr) {
		t.Error("no partial cache write on cancellation")
	}
}

func TestRemoteModelCatalog_NeverSendsCredentials(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("Authorization header must never be sent, got %q", got)
		}
		if got := r.Header.Get("X-API-Key"); got != "" {
			t.Errorf("X-API-Key header must never be sent, got %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Errorf("Accept = %q, want application/json", got)
		}
		if got := r.Header.Get("User-Agent"); got != "cheasee-pi/"+cliVersionKey {
			t.Errorf("User-Agent = %q, want cheasee-pi/%s", got, cliVersionKey)
		}
		fmt.Fprint(w, catalogPlainMap)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	if _, err := cat.Models(context.Background(), "opencode-go"); err != nil {
		t.Fatalf("Models: %v", err)
	}
}

func TestRemoteModelCatalog_ShapeVariants(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	tests := []struct {
		name string
		body string
		want []string
	}{
		{"plain object map", catalogPlainMap, catalogSorted},
		{"array", `[{"id":"b-x","name":"B"},{"id":"a-x","name":"A"}]`, []string{"a-x", "b-x"}},
		{"wrapped in models key", `{"models":[{"id":"b-x","name":"B"},{"id":"a-x","name":"A"}]}`, []string{"a-x", "b-x"}},
		{"entries without id dropped", `{"a":{"id":"a-model"},"x":{"name":"no id"},"b":{"id":"b-model"}}`, []string{"a-model", "b-model"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("XDG_CACHE_HOME", t.TempDir()) // fresh cache per shape
			srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, tc.body)
			}))
			cat := newTestCatalog(srv, 5*time.Second)
			ids, err := cat.Models(context.Background(), "opencode-go")
			if err != nil {
				t.Fatalf("Models: %v", err)
			}
			if !reflect.DeepEqual(ids, tc.want) {
				t.Errorf("Models = %v, want %v", ids, tc.want)
			}
		})
	}
}

func TestRemoteModelCatalog_EmptyCatalogErrors(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	for _, body := range []string{`{}`, `[]`, `{"x":{"name":"no id"}}`} {
		t.Run(body, func(t *testing.T) {
			srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, body)
			}))
			cat := newTestCatalog(srv, 5*time.Second)
			if _, err := cat.Models(context.Background(), "opencode-go"); err == nil {
				t.Error("empty catalog must error (seed path), not silently return an empty list")
			}
		})
	}
}

func TestRemoteModelCatalog_MalformedCacheFileTreatedAsMiss(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	writeStaleCache(t, "opencode-go", "{not json")

	srv := newCatalogServer(t, nil)
	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want %v", ids, catalogSorted)
	}
	if srv.reqs.Load() != 1 {
		t.Errorf("malformed cache must refetch once, got %d", srv.reqs.Load())
	}
}

func TestRemoteModelCatalog_UnknownProviderIdResolves(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil)
	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "totally-unknown-provider")
	if err != nil {
		t.Fatalf("unknown provider id must resolve via the endpoint: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want %v", ids, catalogSorted)
	}
}

func TestRemoteModelCatalog_ProviderEscapedInURLAndCachePath(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil)
	cat := newTestCatalog(srv, 5*time.Second)

	provider := "opencode go/custom"
	if _, err := cat.Models(context.Background(), provider); err != nil {
		t.Fatalf("Models: %v", err)
	}
	escaped := url.PathEscape(provider)
	if !strings.Contains(srv.lastURL, escaped) {
		t.Errorf("request URL must escape the provider id (%q), got %q", escaped, srv.lastURL)
	}
	if _, err := os.Stat(filepath.Join(cacheModelsDir(t), escaped+".json")); err != nil {
		t.Errorf("cache file must use the escaped provider id: %v", err)
	}
}

func TestRemoteModelCatalog_ConcurrentCallsSingleFetch(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil)
	cat := newTestCatalog(srv, 5*time.Second)

	ctx := context.Background()
	const n = 2
	results := make([][]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = cat.Models(ctx, "opencode-go")
		}(i)
	}
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("call %d: %v", i, errs[i])
		}
		if !reflect.DeepEqual(results[i], catalogSorted) {
			t.Errorf("call %d = %v, want %v", i, results[i], catalogSorted)
		}
	}
	if srv.reqs.Load() != 1 {
		t.Errorf("concurrent calls must share one fetch, got %d requests", srv.reqs.Load())
	}
	// Cache file must be valid (torn-write guard) — readable as the overlay.
	data, err := os.ReadFile(filepath.Join(cacheModelsDir(t), "opencode-go.json"))
	if err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
	var entry modelCatalogCache
	if err := json.Unmarshal(data, &entry); err != nil {
		t.Fatalf("cache file malformed after concurrent write: %v", err)
	}
	if len(entry.Models) != 3 {
		t.Errorf("cache must carry the full list, got %d models", len(entry.Models))
	}
}

func TestRemoteModelCatalog_CacheWriteFailureWarnsKeepsResult(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	srv := newCatalogServer(t, nil)

	var warnings []string
	cat := newTestCatalog(srv, 5*time.Second)
	cat.warnf = func(format string, args ...any) {
		warnings = append(warnings, fmt.Sprintf(format, args...))
	}
	// Block the cache write for ANY test runner (root included): a regular
	// file where the cache dir must be created — MkdirAll fails with ENOTDIR
	// instead of an EACCES a root runner would sail past.
	blocked := filepath.Join(t.TempDir(), "blocked")
	if err := os.WriteFile(blocked, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	cat.cacheDir = filepath.Join(blocked, "cache")

	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("cache-write failure must not fail the online fetch: %v", err)
	}
	if !reflect.DeepEqual(ids, catalogSorted) {
		t.Errorf("Models = %v, want %v", ids, catalogSorted)
	}
	// The warning is surfaced (the live result preserved) — an unwritable
	// cache must not silently refetch every run.
	if len(warnings) != 1 || !strings.Contains(warnings[0], "opencode-go") {
		t.Errorf("expected one cache-write warning naming the provider, got %v", warnings)
	}
}

// ──────────────────────────────────────────────
// auth add call site (runAuthAddE)
// ──────────────────────────────────────────────

func TestRunAuthAddE_NoInputWritesValidDefault(t *testing.T) {
	t.Run("override provider: static default, no catalog consultation", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, []string{"glm-5.3", "kimi-k2.6"}, nil)
		stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
		promptCalled := false
		stubPromptModel(t, func(string, []string) (string, error) {
			promptCalled = true
			return "", nil
		})

		if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
			t.Fatalf("auth add: %v", err)
		}
		if promptCalled {
			t.Error("--no-input must skip the model picker entirely")
		}
		raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
		if raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
			t.Errorf("cheasee-settings = %v, want provider opencode-go + model kimi-k2.6", raw)
		}
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultModel"] != "kimi-k2.6" {
			t.Errorf(".pi/settings.json defaultModel = %v, want kimi-k2.6", raw["defaultModel"])
		}
		authRaw := readAuthJSON(t)
		if got := providerKey(t, authRaw, "opencode-go"); got != "test-key" {
			t.Errorf("auth.json key = %q, want test-key", got)
		}
	})

	t.Run("no override: sorted-first live id becomes default", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, []string{"gpt-4o-mini", "gpt-4o"}, nil)
		stubPromptAPIKey(t, func(string) (string, error) { return "key-openai", nil })

		if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
			t.Fatalf("auth add: %v", err)
		}
		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o-mini" {
			t.Errorf("defaultModel = %v, want gpt-4o-mini (sorted-first live id)", raw["defaultModel"])
		}
	})

	t.Run("catalog error falls back to static seed, command succeeds", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, nil, errors.New("offline"))
		stubPromptAPIKey(t, func(string) (string, error) { return "key-openai", nil })

		if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
			t.Fatalf("catalog error must not fail auth add: %v", err)
		}
		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
			t.Errorf("defaultModel = %v, want gpt-4o (seed first entry)", raw["defaultModel"])
		}
	})
}

// TestRunAuthAddE_SingleCatalogConsultation is the audit regression: the
// default and the picker list must come from ONE catalog lookup per provider
// invocation. The pre-audit defaultModelFor + modelsFor pair consulted twice,
// running the fetch/retry loop twice on a cold cache with a failing pi.dev
// request (up to 4 attempts ≈ 16s per provider).
func TestRunAuthAddE_SingleCatalogConsultation(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false) // interactive = the double-fetch path
	cc := &countingModelCatalog{models: []string{"gpt-4o", "gpt-4o-mini"}}
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return cc }
	t.Cleanup(func() { newModelCatalog = saved })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil }) // keep catalog default

	if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want exactly 1 (default + picker list from one lookup)", cc.calls)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
		t.Errorf("defaultModel = %v, want sorted-first live id gpt-4o", raw["defaultModel"])
	}
}

// TestRunAuthAddE_StalledCatalogBoundsOneConsultation is the timeout half of
// the audit regression: a stalled catalog must delay interactive auth add by
// one consultation, not two (the double-fetch doubled the stall per provider).
func TestRunAuthAddE_StalledCatalogBoundsOneConsultation(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	cc := &slowModelCatalog{delay: 400 * time.Millisecond, err: errors.New("offline")}
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return cc }
	t.Cleanup(func() { newModelCatalog = saved })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil })

	start := time.Now()
	if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	elapsed := time.Since(start)
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want 1", cc.calls)
	}
	if elapsed >= 700*time.Millisecond {
		t.Errorf("stalled catalog delayed auth add by %v — want one consultation (~400ms), not two (~800ms)", elapsed)
	}
}

func TestRunAuthAddE_InteractivePickerGetsLiveList(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	live := []string{"glm-5.3", "kimi-k2.6", "qwen3.7-max"}
	stubModelCatalog(t, live, nil)
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(provider string, models []string) (string, error) {
		pickerList = models
		return "kimi-k2.6", nil
	})

	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runAuthAddE(&cobra.Command{}, []string{"opencode-go"})
	})
	if err != nil {
		t.Fatalf("auth add: %v", err)
	}

	// The picker receives the live sorted catalog list — and never the stale
	// cross-catalog entries this issue exists to eliminate.
	if !reflect.DeepEqual(pickerList, live) {
		t.Errorf("picker list = %v, want live catalog %v (no gpt-4o / claude-sonnet-4-20250514)", pickerList, live)
	}
	for _, m := range pickerList {
		if m == "gpt-4o" || m == "claude-sonnet-4-20250514" {
			t.Errorf("pruned cross-catalog entry %q must not reach the picker", m)
		}
	}
	// The picked model is written to all three settings files.
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf("cheasee-settings = %v, want opencode-go + kimi-k2.6", raw)
	}
	if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf(".pi/settings.json defaultModel = %v, want kimi-k2.6", raw["defaultModel"])
	}
	agent, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(agent), `"defaultProvider": "opencode-go"`) || strings.Contains(string(agent), "defaultModel") {
		t.Errorf("agent file stays provider-only, got: %s", agent)
	}
	if !strings.Contains(stderr, "✓ Set as default provider in workspace settings (model: kimi-k2.6)") {
		t.Errorf("stderr should name the picked default model, got:\n%s", stderr)
	}
}

func TestRunAuthAddE_InteractiveCatalogErrorFallsBackToPrunedSeed(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	stubModelCatalog(t, nil, errors.New("offline"))
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(provider string, models []string) (string, error) {
		pickerList = models
		return "deepseek-v4-flash", nil
	})

	if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	want := KnownModels["opencode-go"]
	if !reflect.DeepEqual(pickerList, want) {
		t.Errorf("offline picker list = %v, want pruned seed %v", pickerList, want)
	}
	if len(pickerList) != 2 || pickerList[0] != "deepseek-v4-flash" || pickerList[1] != "kimi-k2.6" {
		t.Fatalf("seed must be pruned to deepseek-v4-flash + kimi-k2.6, got %v", pickerList)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "deepseek-v4-flash" {
		t.Errorf("defaultModel = %v, want picked seed model deepseek-v4-flash", raw["defaultModel"])
	}
}

func TestRunAuthAddE_CustomPickerValueWrittenVerbatim(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	stubModelCatalog(t, []string{"kimi-k2.6", "glm-5.3"}, nil)
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	// The Custom hatch is inside the (real, TTY-bound) promptModel — the seam
	// stands in for it; whatever it returns must be written verbatim, never
	// replaced by a default.
	stubPromptModel(t, func(string, []string) (string, error) { return "my-custom-model", nil })

	if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "my-custom-model" {
		t.Errorf("custom model must be written verbatim, got %v", raw["defaultModel"])
	}
}

// ──────────────────────────────────────────────
// init API-key phase (runInitAPIKeys)
// ──────────────────────────────────────────────

func TestRunInitAPIKeys_MultiProviderLastWins(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, true, false} // configure keys? → yes; add another? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	providers := []string{"openai", "anthropic"}
	keys := []string{"key-openai", "key-anthropic"}
	picks := []string{"gpt-4o", "claude-sonnet-4-20250514"}
	var seenModels [][]string
	stubPromptProvider(t, func() (string, error) {
		next := providers[0]
		providers = providers[1:]
		return next, nil
	})
	stubPromptAPIKey(t, func(string) (string, error) {
		next := keys[0]
		keys = keys[1:]
		return next, nil
	})
	stubPromptModel(t, func(_ string, models []string) (string, error) {
		seenModels = append(seenModels, models)
		next := picks[0]
		picks = picks[1:]
		return next, nil
	})

	catalog := &mockModelCatalog{models: []string{"gpt-4o", "gpt-4o-mini", "claude-sonnet-4-20250514"}}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, catalog, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}

	// Both keys saved; the LAST provider's picked model becomes the default.
	authRaw := readAuthJSON(t)
	if got := providerKey(t, authRaw, "openai"); got != "key-openai" {
		t.Errorf("openai key = %q", got)
	}
	if got := providerKey(t, authRaw, "anthropic"); got != "key-anthropic" {
		t.Errorf("anthropic key = %q", got)
	}
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
		t.Errorf("cheasee-settings = %v, want last provider anthropic + its picked model", raw)
	}
	if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
		t.Errorf(".pi/settings.json = %v, want anthropic + claude-sonnet-4-20250514", raw)
	}
	// Both pickers were fed the live catalog list.
	if len(seenModels) != 2 || !reflect.DeepEqual(seenModels[0], seenModels[1]) {
		t.Errorf("both pickers must receive the live list, got %v", seenModels)
	}
	if len(seenModels[0]) != 3 || seenModels[0][0] != "gpt-4o" {
		t.Errorf("picker list = %v, want the live catalog sorted list", seenModels[0])
	}
}

// TestRunInitAPIKeys_SingleCatalogConsultationPerProvider is the init half of
// the audit regression (init_auth.go consulted the catalog twice per provider
// — once for the default, once for the picker list — doubling the retry loop
// on a failing pi.dev request).
func TestRunInitAPIKeys_SingleCatalogConsultationPerProvider(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, false} // configure keys? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	stubPromptProvider(t, func() (string, error) { return "openai", nil })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil }) // keep catalog default

	cc := &countingModelCatalog{err: errors.New("offline")}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, cc, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want exactly 1 per provider", cc.calls)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
		t.Errorf("defaultModel = %v, want seed first entry gpt-4o", raw["defaultModel"])
	}
}

func TestRunInitAPIKeys_CatalogErrorSeedsPicker(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, false} // configure keys? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	stubPromptProvider(t, func() (string, error) { return "opencode-go", nil })
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(_ string, models []string) (string, error) {
		pickerList = models
		return "", nil // "" keeps the catalog/seed-derived default
	})

	catalog := &mockModelCatalog{err: errors.New("offline")}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, catalog, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}
	// Offline: the picker was fed the pruned opencode-go seed and the default
	// written is the validated static override.
	want := KnownModels["opencode-go"]
	if !reflect.DeepEqual(pickerList, want) {
		t.Errorf("offline picker list = %v, want pruned seed %v", pickerList, want)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf("cheasee-settings = %v, want opencode-go + kimi-k2.6 (static override)", raw)
	}
}

func TestRunInitAPIKeys_DeclinedSkipsEverything(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	promptCalled := false
	stubPromptProvider(t, func() (string, error) { promptCalled = true; return "openai", nil })

	err := runInitAPIKeys(context.Background(), &fileRepository{}, &mockModelCatalog{}, workdir, mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("declining must not error: %v", err)
	}
	if promptCalled {
		t.Error("declined confirmation must skip the provider loop")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when the phase is declined")
	}
}