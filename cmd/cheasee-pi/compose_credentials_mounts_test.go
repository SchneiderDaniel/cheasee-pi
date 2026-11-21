package main

import (
	"fmt"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Credential isolation — mounts the services must keep or lose (issue #2076)
// ──────────────────────────────────────────────

// serviceVolumes returns a service's volume entries as strings.
func serviceVolumes(t *testing.T, svc map[string]any) []string {
	t.Helper()
	raw, ok := svc["volumes"].([]any)
	if !ok {
		if _, present := svc["volumes"]; !present {
			return nil
		}
		t.Fatalf("volumes must be a list, got %v", svc["volumes"])
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		s, ok := item.(string)
		if !ok {
			t.Fatalf("volume entry must be a string spec, got %v", item)
		}
		out = append(out, s)
	}
	return out
}

// serviceTmpfs returns a service's tmpfs entries as strings.
func serviceTmpfs(t *testing.T, svc map[string]any) []string {
	t.Helper()
	raw, ok := svc["tmpfs"].([]any)
	if !ok {
		if _, present := svc["tmpfs"]; !present {
			return nil
		}
		t.Fatalf("tmpfs must be a list, got %v", svc["tmpfs"])
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		s, ok := item.(string)
		if !ok {
			t.Fatalf("tmpfs entry must be a string spec, got %v", item)
		}
		out = append(out, s)
	}
	return out
}

// containsString reports whether s contains want.
func containsString(s []string, want string) bool {
	for _, item := range s {
		if item == want {
			return true
		}
	}
	return false
}

func TestComposeCredentials_NoCredentialDirMounts(t *testing.T) {
	// Generic guard, not just the two historically mounted dirs: no service may
	// bind anything under a config directory — one mounted credential FILE is
	// the whole allowance.
	services := composeServices(t, parseComposeDoc(t, readCompose(t)))
	for name, raw := range services {
		svc, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("service %q must be a mapping, got %v", name, raw)
		}
		for _, vol := range serviceVolumes(t, svc) {
			src, _, ok := strings.Cut(vol, ":")
			if !ok {
				t.Fatalf("service %q volume %q is not a source:dest spec", name, vol)
			}
			if strings.HasPrefix(src, "~/.config") || strings.Contains(src, "/.config/") {
				t.Errorf("service %q must not bind host config path %q (offending volume %q)", name, src, vol)
			}
		}
	}
}

func TestComposeCredentials_GhConfigTmpfs(t *testing.T) {
	// gh still needs a WRITABLE config dir for hosts.yml; a container-local
	// tmpfs gives it one with no host write path. entrypoint.sh seeds it.
	svc := composeService(t, readCompose(t), "cheasee-pi")
	tmpfs := serviceTmpfs(t, svc)
	if len(tmpfs) != 1 {
		t.Fatalf("cheasee-pi must declare exactly one tmpfs entry, got %v", tmpfs)
	}
	want := "/home/agentuser/.config/gh:mode=0700"
	if tmpfs[0] != want {
		t.Errorf("cheasee-pi tmpfs = %q, want %q (memory-only gh config dir)", tmpfs[0], want)
	}
	for _, vol := range serviceVolumes(t, svc) {
		if _, dest, ok := strings.Cut(vol, ":"); ok && strings.HasPrefix(dest, "/home/agentuser/.config/gh") {
			t.Errorf("no volume may occupy the gh tmpfs destination, got %q", vol)
		}
	}
}

func TestComposeCredentials_AuthSpecLabels(t *testing.T) {
	doc := parseComposeDoc(t, readCompose(t))
	want := "com.cheaseepi.auth-spec=${" + authSpecEnv + ":-}"
	for _, name := range []string{"cheasee-pi", "ui"} {
		svc, ok := composeServices(t, doc)[name].(map[string]any)
		if !ok {
			t.Fatalf("service %q missing", name)
		}
		labels := serviceLabelValues(t, svc)
		if !containsString(labels, want) {
			t.Errorf("service %q must carry the credential stamp label %q, got %v", name, want, labels)
		}
	}
	codeflow, ok := composeServices(t, doc)["codeflow"].(map[string]any)
	if !ok {
		t.Fatal("service \"codeflow\" missing")
	}
	for _, label := range serviceLabelValues(t, codeflow) {
		if strings.HasPrefix(label, "com.cheaseepi.auth-spec") {
			t.Errorf("codeflow must not carry the credential stamp label, got %q", label)
		}
	}
}

func TestComposeCredentials_WorkspaceMountsRetained(t *testing.T) {
	svc := composeService(t, readCompose(t), "cheasee-pi")
	vols := serviceVolumes(t, svc)
	for _, want := range []string{
		"${WORKSPACE_HOST_PATH}:/workspaces/main${VOLUME_RELABEL:-}",
		"${WORKSPACE_BARE_PATH}:/workspaces/.bare${VOLUME_RELABEL:-}",
	} {
		if !containsString(vols, want) {
			t.Errorf("cheasee-pi must retain workspace mount %q, got %v", want, vols)
		}
	}
}

// ──────────────────────────────────────────────
// Phase 2: no credential values in compose or its rendered form
// ──────────────────────────────────────────────

func TestComposeCredentials_RenderedConfigNoValues(t *testing.T) {
	authPath := writeSentinelAuthFile(t)
	t.Setenv(authFileEnv, authPath)

	rendered := renderComposeInterpolation(t, readCompose(t))
	for _, sentinel := range []string{composeTokenSentinel, composeKeySentinel} {
		if strings.Contains(rendered, sentinel) {
			t.Errorf("rendered compose config must never contain the credential value %q", sentinel)
		}
	}
	// The secret still carries only a path — Compose strips secret content when
	// it marshals its model, so a file: path is the strongest possible assert.
	entry, ok := composeTopSecrets(t, parseComposeDoc(t, rendered))[authSecretName].(map[string]any)
	if !ok {
		t.Fatalf("rendered secrets.%s missing", authSecretName)
	}
	if got := fmt.Sprint(entry["file"]); got != authPath {
		t.Errorf("rendered secrets.%s.file = %q, want the credential path %q", authSecretName, got, authPath)
	}
	if len(entry) != 1 {
		t.Errorf("rendered secrets.%s must carry only the file key, got %v", authSecretName, entry)
	}
}
