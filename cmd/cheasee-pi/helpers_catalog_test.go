package main

import (
	"fmt"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// catalogSorted is the lexicographically sorted id set of catalogPlainMap.

var catalogSorted = []string{"alpha-model", "mike-model", "zebra-model"}

// catalogServer is the httptest fixture for the remoteModelCatalog adapter
// tests: wraps every request with a counter + last-header/URL capture, then
// delegates to the per-test handler (nil → serve catalogPlainMap with 200).

type catalogServer struct {
	ts      *httptest.Server
	reqs    atomic.Int32
	lastHdr http.Header
	lastURL string
}

func newCatalogServer(t *testing.T, handler http.HandlerFunc) *catalogServer {
	t.Helper()
	s := &catalogServer{}
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, catalogPlainMap)
		}
	}
	var mu sync.Mutex
	s.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.reqs.Add(1)
		mu.Lock()
		s.lastHdr = r.Header.Clone()
		s.lastURL = r.URL.String()
		mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(s.ts.Close)
	return s
}

// cacheModelsDir resolves the per-provider cache dir the adapter writes to
// under the test's XDG_CACHE_HOME (version-keyed, mirroring CacheDir).

func cacheModelsDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(os.Getenv("XDG_CACHE_HOME"), "cheasee-pi", cliVersionKey, "models")
}

// newTestCatalog builds the adapter against a fixture server with an explicit
// attempt timeout (tests never rely on the 4s production default).

func newTestCatalog(srv *catalogServer, attemptTimeout time.Duration) *remoteModelCatalog {
	return &remoteModelCatalog{
		httpClient:     srv.ts.Client(),
		baseURL:        srv.ts.URL,
		attemptTimeout: attemptTimeout,
	}
}

// newAuthAddWorkdir scaffolds a cheasee-pi workspace (the marker file the
// SettingsWriter keys its missing-file policy on) so auth add's workspace
// half exercises all three settings files.

func newAuthAddWorkdir(t *testing.T) string {
	t.Helper()
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed","defaultModel":"seed-model"}`)
	return workdir
}

// writeStaleCache seeds a per-provider cache file with an old checkedAt and
// the given models body — the refetch/revalidation fixtures.

func writeStaleCache(t *testing.T, provider, body string) {
	t.Helper()
	if err := os.MkdirAll(cacheModelsDir(t), 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cacheModelsDir(t), url.PathEscape(provider)+".json")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

// ──────────────────────────────────────────────
// Compile-time interface checks
// ──────────────────────────────────────────────

var (
	_ Authenticator = (*mockAuthenticator)(nil)
	_ ModelCatalog  = (*mockModelCatalog)(nil)
)
