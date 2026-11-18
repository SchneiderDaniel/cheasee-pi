package main

import (
	"fmt"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// ──────────────────────────────────────────────
// Credential isolation — Compose mount policy (issue #2076)
//
// The agent container must never receive a writable handle on the host's
// credential directories: the whole-directory rw bind mounts let any
// in-container process rewrite the host's GitHub/provider credentials, handing
// the container far more host configuration than it needs. Compose owns that
// policy, so these tests read the compose file itself.
//
// Sentinel values (compose_credentials_novalues_test.go) are written to a temp
// auth.json only; they give the leak assertions something unambiguous to hunt.
// Prefix-free, low-entropy fixtures — no secret scanner can match them.
// ──────────────────────────────────────────────

const (
	// authSecretName is the top-level compose secret carrying auth.json.
	authSecretName = "cheasee_auth"

	// authSecretMount is where Compose mounts that secret in the containers.
	authSecretMount = "/run/secrets/" + authSecretName

	composeTokenSentinel = "sentinelvalue505" // gitleaks:allow
	composeKeySentinel   = "sentinelvalue606" // gitleaks:allow
)

// parseComposeDoc parses compose content into a generic YAML document.
func parseComposeDoc(t *testing.T, content string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(content), &doc); err != nil {
		t.Fatalf("docker-compose.yml must parse as valid YAML: %v", err)
	}
	return doc
}

// composeServices returns the document's services block.
func composeServices(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	services, ok := doc["services"].(map[string]any)
	if !ok {
		t.Fatalf("services section missing: %v", doc)
	}
	return services
}

// composeTopSecrets returns the document's top-level secrets block.
func composeTopSecrets(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	raw, ok := doc["secrets"]
	if !ok {
		t.Fatalf("compose must declare a top-level secrets block, got %v", doc)
	}
	secrets, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("top-level secrets must be a mapping, got %v", raw)
	}
	return secrets
}

// serviceSecretNames returns the secret names a service references, accepting
// both the short (string) and long (map with `source`) reference forms.
func serviceSecretNames(t *testing.T, svc map[string]any) []string {
	t.Helper()
	raw, ok := svc["secrets"].([]any)
	if !ok {
		if _, present := svc["secrets"]; !present {
			return nil
		}
		t.Fatalf("service secrets must be a list, got %v", svc["secrets"])
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		switch v := item.(type) {
		case string:
			out = append(out, v)
		case map[string]any:
			out = append(out, fmt.Sprint(v["source"]))
		default:
			t.Fatalf("unexpected secret reference shape %T", item)
		}
	}
	return out
}

// ──────────────────────────────────────────────
// Phase 1: Compose holds mount policy (static, no daemon)
// ──────────────────────────────────────────────

func TestComposeCredentials_SecretDeclared(t *testing.T) {
	secrets := composeTopSecrets(t, parseComposeDoc(t, readCompose(t)))
	if len(secrets) != 1 {
		t.Fatalf("exactly one top-level secret expected, got %v", secrets)
	}
	raw, ok := secrets[authSecretName]
	if !ok {
		t.Fatalf("top-level secrets must declare %q, got %v", authSecretName, secrets)
	}
	entry, ok := raw.(map[string]any)
	if !ok {
		t.Fatalf("secrets.%s must be a mapping, got %v", authSecretName, raw)
	}
	// file: is the only source that yields a read-only bind mount outside
	// Swarm. content:/environment: tar the value into the container's writable
	// layer; external:/driver:/template_driver: are hard errors.
	for _, banned := range []string{"content", "environment", "external", "driver", "template_driver"} {
		if _, present := entry[banned]; present {
			t.Errorf("secrets.%s must not use %q: outside Swarm that is a hard error or a writable container-side copy, never a read-only bind mount", authSecretName, banned)
		}
	}
	if _, present := entry["file"]; !present {
		t.Errorf("secrets.%s must be file-backed, got %v", authSecretName, entry)
	}
	if len(entry) != 1 {
		t.Errorf("secrets.%s must carry only the file source key, got %v", authSecretName, entry)
	}
}

func TestComposeCredentials_AgentServiceSecret(t *testing.T) {
	svc := composeService(t, readCompose(t), "cheasee-pi")
	names := serviceSecretNames(t, svc)
	if len(names) != 1 || names[0] != authSecretName {
		t.Errorf("cheasee-pi must reference exactly the %q secret, got %v", authSecretName, names)
	}
	env := serviceEnvMap(t, svc)
	if got := env["CHEASEE_AUTH_PATH"]; got != authSecretMount {
		t.Errorf("cheasee-pi CHEASEE_AUTH_PATH = %q, want %q", got, authSecretMount)
	}
}

func TestComposeCredentials_UIServiceSecret(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	names := serviceSecretNames(t, svc)
	if len(names) != 1 || names[0] != authSecretName {
		t.Errorf("ui must reference exactly the %q secret, got %v", authSecretName, names)
	}
	env := serviceEnvMap(t, svc)
	if got := env["CHEASEE_AUTH_PATH"]; got != authSecretMount {
		t.Errorf("ui CHEASEE_AUTH_PATH = %q, want %q", got, authSecretMount)
	}
}

func TestComposeCredentials_CodeflowNoCredentials(t *testing.T) {
	svc := composeService(t, readCompose(t), "codeflow")
	if names := serviceSecretNames(t, svc); len(names) != 0 {
		t.Errorf("codeflow must not receive credentials (least privilege), got %v", names)
	}
	for _, vol := range serviceVolumes(t, svc) {
		if strings.Contains(vol, "/.config/") {
			t.Errorf("codeflow must not mount host config, got %q", vol)
		}
	}
	if got := serviceEnvMap(t, svc)["CHEASEE_AUTH_PATH"]; got != "" {
		t.Errorf("codeflow must not receive CHEASEE_AUTH_PATH, got %q", got)
	}
}
