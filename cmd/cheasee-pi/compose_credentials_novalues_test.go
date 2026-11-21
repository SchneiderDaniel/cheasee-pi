package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Credential isolation — no value in compose configuration (issue #2076)
//
// Acceptance criterion: secret values never appear in Compose environment
// declarations or in the rendered Compose model. Compose strips secret *content*
// when marshalling by design, so a file: path is the strongest possible shape —
// these tests pin exactly that.
// ──────────────────────────────────────────────

// serviceEnvMap normalizes a service environment block (list or map form) into
// a key→value map.
func serviceEnvMap(t *testing.T, svc map[string]any) map[string]string {
	t.Helper()
	out := map[string]string{}
	switch env := svc["environment"].(type) {
	case nil:
	case []any:
		for _, item := range env {
			s, ok := item.(string)
			if !ok {
				t.Fatalf("environment list entry must be a string, got %v", item)
			}
			k, v, _ := strings.Cut(s, "=")
			out[k] = v
		}
	case map[string]any:
		for k, v := range env {
			out[k] = fmt.Sprint(v)
		}
	default:
		t.Fatalf("unexpected environment shape %T", svc["environment"])
	}
	return out
}

// serviceLabelValues returns every label entry of a service block.
func serviceLabelValues(t *testing.T, svc map[string]any) []string {
	t.Helper()
	switch labels := svc["labels"].(type) {
	case nil:
		return nil
	case []any:
		out := make([]string, 0, len(labels))
		for _, item := range labels {
			s, ok := item.(string)
			if !ok {
				t.Fatalf("label entry must be a string, got %v", item)
			}
			out = append(out, s)
		}
		return out
	case map[string]any:
		out := make([]string, 0, len(labels))
		for k, v := range labels {
			out = append(out, k+"="+fmt.Sprint(v))
		}
		return out
	default:
		t.Fatalf("unexpected labels shape %T", svc["labels"])
		return nil
	}
}

// writeSentinelAuthFile writes an auth.json carrying both sentinel values and
// returns its path (the config home is redirected, so nothing real is touched).
func writeSentinelAuthFile(t *testing.T) string {
	t.Helper()
	dir := testutil.RedirectConfigHome(t)
	path := filepath.Join(dir, "cheasee-pi", "auth.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	content := fmt.Sprintf(`{"github_token":%q,"anthropic":{"key":%q}}`, composeTokenSentinel, composeKeySentinel)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestComposeCredentials_EnvironmentNoValues(t *testing.T) {
	authPath := writeSentinelAuthFile(t)
	t.Setenv(authFileEnv, authPath)
	doc := parseComposeDoc(t, renderComposeInterpolation(t, readCompose(t)))
	for name, raw := range composeServices(t, doc) {
		svc := raw.(map[string]any)
		for key, value := range serviceEnvMap(t, svc) {
			for _, sentinel := range []string{composeTokenSentinel, composeKeySentinel} {
				if strings.Contains(value, sentinel) {
					t.Errorf("service %q environment %s carries the credential value %q — secrets never ride compose env", name, key, sentinel)
				}
			}
		}
	}
	// The credential reaches the container as a path, never as a value.
	if _, ok := serviceEnvMap(t, composeService(t, readCompose(t), "cheasee-pi"))["CHEASEE_AUTH_PATH"]; !ok {
		t.Error("cheasee-pi must name the credential path, not carry the credential")
	}
}

func TestComposeCredentials_SecretPathOnly(t *testing.T) {
	t.Setenv(authFileEnv, "")
	rendered := renderComposeInterpolation(t, readCompose(t))
	entry, ok := composeTopSecrets(t, parseComposeDoc(t, rendered))[authSecretName].(map[string]any)
	if !ok {
		t.Fatalf("rendered secrets.%s missing", authSecretName)
	}
	file := fmt.Sprint(entry["file"])
	if !strings.HasSuffix(file, "cheasee-pi/auth.json") {
		t.Errorf("secrets.%s.file = %q, want a path ending in cheasee-pi/auth.json", authSecretName, file)
	}
	if !strings.HasPrefix(file, "~") && !filepath.IsAbs(file) {
		t.Errorf("secrets.%s.file = %q, want an absolute or ~-anchored path", authSecretName, file)
	}
	for _, banned := range []string{"=", "{", "}", ":"} {
		if strings.Contains(file, banned) {
			t.Errorf("secrets.%s.file = %q must be a bare path (found %q)", authSecretName, file, banned)
		}
	}
}

func TestComposeCredentials_LabelsNoValues(t *testing.T) {
	authPath := writeSentinelAuthFile(t)
	t.Setenv(authFileEnv, authPath)
	doc := parseComposeDoc(t, renderComposeInterpolation(t, readCompose(t)))
	for name, raw := range composeServices(t, doc) {
		svc := raw.(map[string]any)
		for _, label := range serviceLabelValues(t, svc) {
			for _, sentinel := range []string{composeTokenSentinel, composeKeySentinel} {
				if strings.Contains(label, sentinel) {
					t.Errorf("service %q label %q carries the credential value %q", name, label, sentinel)
				}
			}
		}
	}
}
