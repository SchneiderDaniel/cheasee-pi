//go:build integration

// Daemon-backed evidence for the credential-isolation contract (issue #2076).
// Nothing here runs under `go test ./cmd/cheasee-pi/` (no tag) — every
// daemon-free contract assertion lives in compose_credentials_test.go,
// auth_stamp_test.go, up_auth_gate_test.go, auth_drift_test.go and
// entrypoint_ghseed_test.go. This file adds the runtime proof the static tests
// cannot give: the mounted credential is READ-ONLY, the host file survives
// in-container writes, gh authenticates from the container-local seed, and no
// credential value reaches compose output, container env or image history.
//
// Run (requires a daemon; builds the agent image):
//
//	go test -tags integration ./cmd/cheasee-pi/ -run 'TestComposeCredentials_Integration' -count=1 -timeout 20m

package main

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// TestComposeCredentials_Integration brings the real stack up once and pins the
// runtime half of the credential-isolation contract.
func TestComposeCredentials_Integration(t *testing.T) {
	requireDockerDaemon(t)

	root := seedComposeHarnessWorkspace(t)
	t.Cleanup(func() { downComposeStack(t, root) })
	startComposeStack(t, root)

	authPath := os.Getenv(authFileEnv)
	if authPath == "" {
		t.Fatalf("%s must be set by the harness (it is what compose mounts as the credential secret)", authFileEnv)
	}
	hostBytes, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatalf("read host credential file %s: %v", authPath, err)
	}
	agent := containerName(root)

	t.Run("ReadOnly", func(t *testing.T) {
		mounts := dockerSecretMount(t, agent)
		if mounts == nil {
			t.Fatalf("%s:%s is not mounted — the credential secret did not reach the container", agent, authSecretMount)
		}
		if mounts.RW {
			t.Errorf("%s:%s must be mounted read-only, mounts entry: %+v", agent, authSecretMount, *mounts)
		}
		if out, err := dockerExecOutput(t, agent, "test", "-w", authSecretMount); err == nil {
			t.Errorf("`test -w %s` succeeded inside the agent container (%q) — the credential must not be writable", authSecretMount, out)
		}
	})

	t.Run("NoHostWrite", func(t *testing.T) {
		// gh still needs a WRITABLE config dir; it must be the container-local
		// tmpfs, never a host directory.
		ghDir := dockerOutput(t, "exec", agent, "printenv", "GH_CONFIG_DIR")
		if ghDir == "" {
			t.Fatal("GH_CONFIG_DIR must be set in the agent container")
		}
		if out, err := dockerExecOutput(t, agent, "sh", "-c", "printf 'hosts: %s\\n' probe >> "+ghDir+"/hosts.yml"); err != nil {
			t.Errorf("the gh config dir must stay writable (gh writes hosts.yml there), got %v\n%s", err, out)
		}
		// The host credential directory must not be reachable at all.
		if _, err := dockerExecOutput(t, agent, "test", "-e", "/home/agentuser/.config/cheasee-pi"); err == nil {
			t.Error("/home/agentuser/.config/cheasee-pi must not exist inside the agent container")
		}
		// The verified read-only mount is the whole write barrier: an
		// in-container write attempt may not change the host file's bytes.
		_, _ = dockerExecOutput(t, agent, "sh", "-c", "printf 'tampered' > "+authSecretMount+" 2>/dev/null || true")
		after, err := os.ReadFile(authPath)
		if err != nil {
			t.Fatalf("re-read host credential file: %v", err)
		}
		if string(after) != string(hostBytes) {
			t.Errorf("the host credential file changed after an in-container write attempt:\nbefore: %s\nafter:  %s", hostBytes, after)
		}
	})

	t.Run("GhAuth", func(t *testing.T) {
		// Proves the tmpfs seed: gh resolves the token the entrypoint imported
		// from the read-only secret. Without it, git push and every gh call in
		// the supervisor would silently fail.
		out, err := dockerExecOutput(t, agent, "gosu", "agentuser", "gh", "auth", "token")
		if err != nil {
			t.Fatalf("`gh auth token` inside the agent container failed: %v\n%s", err, out)
		}
		if out != FakeGitHubToken {
			t.Errorf("`gh auth token` = %q, want the token seeded from the read-only secret %q", out, FakeGitHubToken)
		}
	})

	t.Run("NoValueLeak", func(t *testing.T) {
		// The source PATH is expected in all three; the token value is not.
		cacheDir, err := ensureCacheDir(context.Background())
		if err != nil {
			t.Fatalf("cache dir: %v", err)
		}
		if err := NewExtractor().Extract(context.Background(), cacheDir); err != nil {
			t.Fatalf("extract compose files: %v", err)
		}
		rendered := dockerOutput(t, "compose", "-p", composeProjectName(root),
			"-f", cacheDir+"/docker-compose.yml", "config", "--format", "json")
		envDump := dockerOutput(t, "inspect", "--format", "{{json .Config.Env}}", agent)
		history := dockerOutput(t, "history", "--no-trunc", cheaseeImageRef(root))

		for name, blob := range map[string]string{
			"docker compose config": rendered,
			"docker inspect env":    envDump,
			"docker history":        history,
		} {
			if strings.Contains(blob, FakeGitHubToken) {
				t.Errorf("%s must never contain the credential value", name)
			}
		}
		// Sanity: the secret really is in the rendered model (path only).
		var doc struct {
			Services map[string]struct {
				Secrets []string `json:"secrets"`
			} `json:"services"`
		}
		if err := json.Unmarshal([]byte(rendered), &doc); err != nil {
			t.Fatalf("docker compose config --format json did not parse: %v", err)
		}
		svc, ok := doc.Services["cheasee-pi"]
		if !ok {
			t.Fatalf("rendered compose config has no cheasee-pi service: %v", rendered)
		}
		if !slices.Contains(svc.Secrets, authSecretName) {
			t.Errorf("rendered compose config must attach the %q secret to cheasee-pi, got %v", authSecretName, svc.Secrets)
		}
	})
}

// dockerSecretMount returns the agent container's credential mount entry, or
// nil when the secret is not mounted.
func dockerSecretMount(t *testing.T, agent string) *struct {
	Type        string
	Source      string
	Destination string
	RW          bool
} {
	t.Helper()
	out := dockerOutput(t, "inspect", "--format", "{{json .Mounts}}", agent)
	var mounts []struct {
		Type        string
		Source      string
		Destination string
		RW          bool
	}
	if err := json.Unmarshal([]byte(out), &mounts); err != nil {
		t.Fatalf("parse %s mounts %q: %v", agent, out, err)
	}
	for i, m := range mounts {
		if m.Destination == authSecretMount {
			return &mounts[i]
		}
	}
	return nil
}
