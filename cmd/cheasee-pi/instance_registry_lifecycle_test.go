package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ──────────────────────────────────────────────
// Phase 5: registry lifecycle on start
//
// `cheasee-pi start` records this workspace so peer sidecars can list and link
// it. A missing record reproduces the reported bug, so a registry fault must
// surface — never a silent skip.
// ──────────────────────────────────────────────

// discoveryStartFixture pins the cache home and a probing-free port band, then
// returns one workspace with its bare remote written.
func discoveryStartFixture(t *testing.T, url string) string {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, url)
	return root
}

func TestDiscovery_recordInstanceWritesDiscoverableRecord(t *testing.T) {
	root := discoveryStartFixture(t, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))

	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root))
	rec := discoveryRequireRecordCount(t, reg, 1)[0]
	if rec.Key != instanceKey(root) {
		t.Errorf("key = %q, want %q", rec.Key, instanceKey(root))
	}
	uiPortValue, err := uiHostPort(root)
	discoveryRequireNoErr(t, "uiHostPort", err)
	if rec.UIPort != uiPortValue {
		t.Errorf("uiPort = %q, want the freshly resolved %q", rec.UIPort, uiPortValue)
	}
	for _, want := range []string{repoSlug(root), filepath.Base(root)} {
		if !strings.Contains(rec.Label, want) {
			t.Errorf("label %q must contain %q", rec.Label, want)
		}
	}
	if strings.Contains(rec.Label, filepath.Dir(root)) {
		t.Errorf("label %q must not leak the host path %q", rec.Label, filepath.Dir(root))
	}
	if _, err := time.Parse(time.RFC3339, rec.StartedAt); err != nil {
		t.Errorf("startedAt %q must be RFC3339: %v", rec.StartedAt, err)
	}
}

func TestDiscovery_recordInstanceKeepsSiblingRecords(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	_, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))

	discoveryRequireNoErr(t, "recordInstance(ws1)", recordInstance(context.Background(), reg, roots[0]))
	first := discoveryRequireRecordCount(t, reg, 1)[0]
	discoveryRequireNoErr(t, "recordInstance(ws2)", recordInstance(context.Background(), reg, roots[1]))

	kept := false
	for _, rec := range discoveryRequireRecordCount(t, reg, 2) {
		if rec == first {
			kept = true
		}
	}
	if !kept {
		t.Errorf("ws1 record %+v missing or changed after ws2 registered", first)
	}
}

func TestDiscovery_recordInstanceSurfacesMissingStateDir(t *testing.T) {
	// A regular file where the state dir should be: MkdirAll fails, and a
	// missing record must surface — silently skipping it reproduces the bug.
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	blocker := filepath.Join(cache, "cheasee-pi")
	discoveryRequireNoErr(t, "write blocker", os.WriteFile(blocker, []byte("not a dir"), 0o644))
	_, root := mkWorkspace(t, `{}`)

	err := recordInstance(context.Background(), newFileInstanceRegistry(mustRegistryDir(t)), root)
	if err == nil {
		t.Fatal("an unwritable registry must return an error, never skip silently")
	}
}
