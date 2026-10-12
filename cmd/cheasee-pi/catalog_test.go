package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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

func TestRemoteModelCatalog_StaleCacheRefetchesPlainGET(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// Legacy cache carrying etag/lastModified keys (written by a prior binary
	// version) plus a stale checkedAt: the plain-GET fetch must ignore the
	// validator — no conditional header — and the rewritten cache must drop
	// the legacy keys.
	stale := fmt.Sprintf(`{"models":[{"id":"alpha-model","name":"Alpha"}],"checkedAt":%q,"etag":"v1","lastModified":"old"}`, time.Now().Add(-5*time.Hour).Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", stale)

	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("If-None-Match"); got != "" {
			t.Errorf("plain GET must not send If-None-Match, got %q", got)
		}
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
	if len(entry.Models) != 3 || time.Since(entry.CheckedAt) > time.Minute {
		t.Errorf("cache must carry the fresh body + checkedAt, got %+v", entry)
	}
	if strings.Contains(string(data), "etag") || strings.Contains(string(data), "lastModified") {
		t.Errorf("rewritten cache must not carry etag/lastModified keys, got %s", data)
	}
}

func TestRemoteModelCatalog_LegacyEtagCacheStillDecodes(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// Old on-disk cache JSON containing etag/lastModified keys must still
	// decode (unknown-field tolerance) and its models/checkedAt honored while
	// fresh — zero HTTP requests.
	body := fmt.Sprintf(`{"models":[{"id":"alpha-model","name":"Alpha"}],"checkedAt":%q,"etag":"v1","lastModified":"old"}`, time.Now().Format(time.RFC3339Nano))
	writeStaleCache(t, "opencode-go", body)

	srv := newCatalogServer(t, nil)
	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err != nil {
		t.Fatalf("Models: %v", err)
	}
	if !reflect.DeepEqual(ids, []string{"alpha-model"}) {
		t.Errorf("fresh legacy cache must be honored verbatim, got %v", ids)
	}
	if srv.reqs.Load() != 0 {
		t.Errorf("fresh legacy cache must short-circuit with zero HTTP requests, got %d", srv.reqs.Load())
	}
}

func TestRemoteModelCatalog_NotModifiedRetriesAsTransientError(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	// A 304 to a plain GET is unexpected (we sent no validator): treated as a
	// transient failure, retried, and never allowed to empty the list.
	srv := newCatalogServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotModified)
	}))

	cat := newTestCatalog(srv, 5*time.Second)
	ids, err := cat.Models(context.Background(), "opencode-go")
	if err == nil {
		t.Fatal("304 to a plain GET must error (transient), never yield a list")
	}
	if len(ids) != 0 {
		t.Errorf("304 must never yield a partial list, got %v", ids)
	}
	if srv.reqs.Load() != catalogAttempts {
		t.Errorf("304 must be retried like a transient error (%d attempts), got %d requests", catalogAttempts, srv.reqs.Load())
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
