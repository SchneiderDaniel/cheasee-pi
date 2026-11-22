package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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

	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root, containerName(root)))
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

// stubPortProbeBound models a host where `bound` ports are already taken — the
// state a started stack leaves behind for its OWN sidecars.
func stubPortProbeBound(t *testing.T, bound ...string) *int {
	t.Helper()
	saved := portProbe
	probes := new(int)
	busy := make(map[string]bool, len(bound))
	for _, port := range bound {
		busy[port] = true
	}
	portProbe = func(port int) error {
		*probes++
		if busy[strconv.Itoa(port)] {
			return fmt.Errorf("address already in use: 127.0.0.1:%d", port)
		}
		return nil
	}
	t.Cleanup(func() { portProbe = saved })
	return probes
}

// stubPublishedPorts answers `docker port <container> <port>/tcp` with the host
// port that container published and delegates every other exec to the seam it
// wrapped — identity resolution reads the bare remote through `git`, so a blanket
// mock would silently change the workspace key mid-test.
func stubPublishedPorts(t *testing.T, published map[string]string) {
	t.Helper()
	outer := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name != "docker" || len(arg) < 3 || arg[0] != "port" {
			return outer(ctx, name, arg...)
		}
		port, ok := published[arg[1]]
		if !ok {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, errDaemonGone }}
		}
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("0.0.0.0:" + port + "\n"), nil
		}}
	})
}

// TestDiscovery_recordInstanceRecordsThePublishedPort pins finding 1 of the
// #2155 audit: registration happens AFTER the stack is up, so this workspace's
// own sidecars already hold their binds. The derive+probe chain treats those
// live binds as occupancy and would shift to the next free port — a record that
// links the operator at nothing. The record must carry the port the sidecar
// actually published.
func TestDiscovery_recordInstanceRecordsThePublishedPort(t *testing.T) {
	root := discoveryStartFixture(t, "https://github.com/alice/foo.git")
	publishedUI, err := uiHostPort(root)
	discoveryRequireNoErr(t, "uiHostPort", err)
	publishedCodeflow, err := codeflowHostPort(root)
	discoveryRequireNoErr(t, "codeflowHostPort", err)

	// The stack is up: exactly this workspace's two sidecar ports are bound, so
	// a probe-first resolver would move to the next free port in each band.
	stubPortProbeBound(t, publishedUI, publishedCodeflow)
	stubPublishedPorts(t, map[string]string{
		uiContainerName(root):       publishedUI,
		codeflowContainerName(root): publishedCodeflow,
	})

	reg := newFileInstanceRegistry(mustRegistryDir(t))
	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root, containerName(root)))
	rec := discoveryRequireRecordCount(t, reg, 1)[0]
	if rec.UIPort != publishedUI {
		t.Errorf("uiPort = %q, want the published %q (the probe would shift to the next free port)", rec.UIPort, publishedUI)
	}
	if rec.CodeflowPort != publishedCodeflow {
		t.Errorf("codeflowPort = %q, want the published %q", rec.CodeflowPort, publishedCodeflow)
	}
}

// TestDiscovery_recordInstancePersistsEffectiveAgentContainer pins finding 2 of
// the #2155 audit: `start --name <custom>` renames the agent container, so the
// key-derived name no longer identifies the instance. The record must carry the
// name the run actually used, or a custom-named instance is invisible to the
// snapshot.
func TestDiscovery_recordInstancePersistsEffectiveAgentContainer(t *testing.T) {
	root := discoveryStartFixture(t, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))

	discoveryRequireNoErr(t, "recordInstance", recordInstance(context.Background(), reg, root, "my-custom-agent"))
	rec := discoveryRequireRecordCount(t, reg, 1)[0]
	if rec.AgentContainer != "my-custom-agent" {
		t.Errorf("agentContainer = %q, want the name the run used (\"my-custom-agent\") — the key-derived %q does not exist for a --name stack", rec.AgentContainer, containerNameFromKey(rec.Key))
	}
}

func TestDiscovery_recordInstanceKeepsSiblingRecords(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)

	_, roots := discoverySiblings(t, 2, "https://github.com/alice/foo.git")
	reg := newFileInstanceRegistry(mustRegistryDir(t))

	discoveryRequireNoErr(t, "recordInstance(ws1)", recordInstance(context.Background(), reg, roots[0], containerName(roots[0])))
	first := discoveryRequireRecordCount(t, reg, 1)[0]
	discoveryRequireNoErr(t, "recordInstance(ws2)", recordInstance(context.Background(), reg, roots[1], containerName(roots[1])))

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

	err := recordInstance(context.Background(), newFileInstanceRegistry(mustRegistryDir(t)), root, containerName(root))
	if err == nil {
		t.Fatal("an unwritable registry must return an error, never skip silently")
	}
}
