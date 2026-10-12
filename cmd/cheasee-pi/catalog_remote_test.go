package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

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
