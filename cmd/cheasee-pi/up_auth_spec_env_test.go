package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 4: compose env wiring for the credential secret
//
// The CLI owns the host credential file plus its resolved path: it stamps the
// identity for drift detection and hands Compose the absolute path to mount —
// never the value. Provider keys keep reaching pi through `docker exec -e`, so
// nothing credential-shaped rides the compose env.
// ──────────────────────────────────────────────

// envEntries returns every VALUE of key in a docker env list.
func envEntries(env []string, key string) []string {
	var out []string
	for _, e := range env {
		if k, v, ok := strings.Cut(e, "="); ok && k == key {
			out = append(out, v)
		}
	}
	return out
}

// envKeys returns every KEY in a docker env list.
func envKeys(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		k, _, _ := strings.Cut(e, "=")
		out = append(out, k)
	}
	return out
}

// writeHostAuthFile writes a host auth.json into the redirected config home and
// returns its path.
func writeHostAuthFile(t *testing.T) string {
	t.Helper()
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"github_token":"`+FakeGitHubToken+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestApplyComposeEnv_AuthSpecFromHostFile(t *testing.T) {
	path := writeHostAuthFile(t)
	want := liveAuthSpec(t, path)

	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), "cheasee-pi", t.TempDir())

	got := envEntries(cmd.env, authSpecEnv)
	if len(got) != 1 {
		t.Fatalf("exactly one %s entry expected, got %v", authSpecEnv, got)
	}
	if got[0] != want {
		t.Errorf("%s = %q, want the host file's stamp %q", authSpecEnv, got[0], want)
	}
}

func TestApplyComposeEnv_AuthSpecStripsInherited(t *testing.T) {
	// A stale inherited stamp must never reach Compose: duplicate KEY= entries
	// resolve nondeterministically across libc/exec implementations.
	t.Setenv(authSpecEnv, "stale")
	path := writeHostAuthFile(t)

	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), "cheasee-pi", t.TempDir())

	got := envEntries(cmd.env, authSpecEnv)
	if len(got) != 1 {
		t.Fatalf("inherited %s must be replaced (exactly 1 entry), got %v", authSpecEnv, got)
	}
	if got[0] != liveAuthSpec(t, path) {
		t.Errorf("%s = %q, want the derived stamp", authSpecEnv, got[0])
	}
}

func TestApplyComposeEnv_AuthSpecEmptyWhenMissing(t *testing.T) {
	// Pre-`cheasee-pi auth` host: the compose label must be empty (the `:-`
	// default leaves it unset) instead of a duplicated or panicking entry.
	testutil.RedirectConfigHome(t)

	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), "cheasee-pi", t.TempDir())

	got := envEntries(cmd.env, authSpecEnv)
	if len(got) != 1 {
		t.Fatalf("exactly one %s entry expected, got %v", authSpecEnv, got)
	}
	if got[0] != "" {
		t.Errorf("%s = %q, want empty when auth.json is absent", authSpecEnv, got[0])
	}
}

func TestApplyComposeEnv_AuthFileResolvedPath(t *testing.T) {
	// The compose secret source must be the CLI's own resolved path, not a
	// hardcoded ~/.config/cheasee-pi/auth.json — the two diverge on XDG-config
	// and macOS hosts, and Compose would then mount a file the CLI never writes.
	dir := testutil.RedirectConfigHome(t)
	want, err := (&fileRepository{}).Path()
	if err != nil {
		t.Fatalf("auth path: %v", err)
	}
	if !strings.HasPrefix(want, dir) {
		t.Fatalf("fixture precondition: %q must sit under the redirected config home %q", want, dir)
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), "cheasee-pi", t.TempDir())

	got := envEntries(cmd.env, authFileEnv)
	if len(got) != 1 {
		t.Fatalf("exactly one %s entry expected, got %v", authFileEnv, got)
	}
	if got[0] != want {
		t.Errorf("%s = %q, want the CLI-resolved path %q", authFileEnv, got[0], want)
	}
	if !filepath.IsAbs(got[0]) {
		t.Errorf("%s = %q must be absolute for the compose secret source", authFileEnv, got[0])
	}
}

func TestApplyComposeEnv_NoCredentialValues(t *testing.T) {
	// Provider keys reach pi through `docker exec -e` at session start (see
	// buildEnvFlags), never through the compose env — values in compose
	// configuration or container metadata are what this feature bans.
	writeSentinelAuthFile(t)
	// Ambient shell entries are pass-through (Compose injects only what the
	// compose file declares, and it declares no credential); the assertion here
	// covers entries THIS function derives.
	inherited := map[string]bool{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		inherited[key] = true
	}

	cmd := &mockCmd{}
	applyComposeEnv(cmd, t.TempDir(), "cheasee-pi", t.TempDir())

	for _, entry := range cmd.env {
		for _, sentinel := range []string{composeTokenSentinel, composeKeySentinel} {
			if strings.Contains(entry, sentinel) {
				t.Errorf("compose env entry must never carry a credential value, got %q", entry)
			}
		}
	}
	for _, banned := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"} {
		if inherited[banned] {
			continue // ambient pass-through, not derived here
		}
		if slices.Contains(envKeys(cmd.env), banned) {
			t.Errorf("compose env must not derive provider/GitHub token var %q (values would land in container metadata)", banned)
		}
	}
}
