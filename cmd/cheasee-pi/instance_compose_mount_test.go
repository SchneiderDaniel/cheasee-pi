package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6 (static): compose wiring for the snapshot
//
// Discovery reaches the sidecar without a docker socket and without a
// workspace-scoped mount: exactly one read-only snapshot bind on the `ui`
// service, and nothing on the agent/codeflow services.
// ──────────────────────────────────────────────

// snapshotMount returns the ui service's registry mount spec.
func snapshotMount(t *testing.T, content map[string]any) string {
	t.Helper()
	vols, ok := content["volumes"].([]any)
	if !ok {
		t.Fatalf("ui volumes missing, got %v", content["volumes"])
	}
	for _, vol := range vols {
		spec, _ := vol.(string)
		if strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
			return spec
		}
	}
	t.Fatalf("ui volumes must carry the instance snapshot mount, got %v", vols)
	return ""
}

func TestDiscovery_composeUIMountsReadOnlySnapshot(t *testing.T) {
	ui := composeService(t, readCompose(t), "ui")
	spec := snapshotMount(t, ui)
	if !strings.HasSuffix(spec, ":ro") {
		t.Errorf("snapshot mount %q must be read-only", spec)
	}
	source, _, _ := strings.Cut(spec, ":")
	if !strings.HasPrefix(source, "${CHEASEEPI_INSTANCE_SNAPSHOT") {
		t.Errorf("snapshot mount source = %q, want the CLI-resolved ${CHEASEEPI_INSTANCE_SNAPSHOT…} path", source)
	}
	registryMounts := 0
	for _, vol := range ui["volumes"].([]any) {
		if spec, _ := vol.(string); strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
			registryMounts++
		}
	}
	if registryMounts != 1 {
		t.Errorf("ui must carry exactly one snapshot mount, got %d (%v)", registryMounts, ui["volumes"])
	}
}

func TestDiscovery_composeOnlyUISeestheSnapshot(t *testing.T) {
	content := readCompose(t)
	for _, service := range []string{"cheasee-pi", "codeflow"} {
		vols, ok := composeService(t, content, service)["volumes"].([]any)
		if !ok {
			continue
		}
		for _, vol := range vols {
			if spec, _ := vol.(string); strings.Contains(spec, "CHEASEEPI_INSTANCE_SNAPSHOT") {
				t.Errorf("service %s must not mount the instance snapshot, got %v", service, spec)
			}
		}
	}
}

func TestDiscovery_composeSnapshotMountStaysUnprivileged(t *testing.T) {
	content := readCompose(t)
	spec := snapshotMount(t, composeService(t, content, "ui"))
	if strings.Contains(spec, "docker.sock") {
		t.Errorf("snapshot mount %q must not reach the docker socket", spec)
	}
	if strings.Contains(spec, "WORKSPACE_HOST_PATH") {
		t.Errorf("snapshot mount %q must not be workspace-scoped — peer discovery is host-wide", spec)
	}
	if strings.Contains(content, "/var/run/docker.sock") {
		t.Error("compose must never mount the docker socket (docs/security.md)")
	}
}

func TestDiscovery_applyComposeEnvCarriesSnapshotPath(t *testing.T) {
	cache := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")
	stubPortProbe(t, true)
	_, root := mkWorkspace(t, `{}`)
	want, err := instanceSnapshotPath()
	discoveryRequireNoErr(t, "instanceSnapshotPath", err)

	// No published snapshot yet → the env var stays unset so compose uses its
	// `:-` default instead of binding a path that does not exist.
	cmd := &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), t.TempDir())
	if got := composeEnvValue(cmd.env, instanceSnapshotEnv); got != "" {
		t.Errorf("%s = %q, want unset before the CLI published a snapshot", instanceSnapshotEnv, got)
	}

	discoveryRequireNoErr(t, "create state dir", os.MkdirAll(filepath.Dir(want), 0o755))
	discoveryRequireNoErr(t, "publish snapshot", os.WriteFile(want, []byte("[]\n"), 0o644))

	cmd = &mockCmd{}
	applyComposeEnv(cmd, root, containerName(root), t.TempDir())
	if got := composeEnvValue(cmd.env, instanceSnapshotEnv); got != want {
		t.Errorf("%s = %q, want %q", instanceSnapshotEnv, got, want)
	}
	if strings.Contains(composeEnvValue(cmd.env, instanceSnapshotEnv), root) {
		t.Errorf("snapshot env must not be workspace-scoped: %v", cmd.env)
	}
}
