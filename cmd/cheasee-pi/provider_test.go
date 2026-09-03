package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// WriteDefaultProvider (provider.go) — one write helper, three targets
// ──────────────────────────────────────────────

// TestWriteDefaultProvider_roundTrip replaces the per-updater writer tests:
// one round trip over a temp workspace asserting (a) all three files carry
// the provider, (b) unknown top-level keys in each file survive the write,
// (c) the three missing-file policies behave as documented.
func TestWriteDefaultProvider_roundTrip(t *testing.T) {
	t.Run("three files carry provider and model", func(t *testing.T) {
		workdir := t.TempDir()
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4-flash"}`)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("anthropic", "claude-sonnet-4-20250514"); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
			t.Errorf("cheasee-settings.json must carry provider+model, got %v", raw)
		}
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
			t.Errorf(".pi/settings.json must carry provider+model, got %v", raw)
		}
		// Agent file is created/updated provider-only — it never receives the
		// model on first write (created-content asymmetry now explicit).
		data, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"defaultProvider": "anthropic"`) {
			t.Errorf("agent file missing defaultProvider, got: %s", data)
		}
		if strings.Contains(string(data), "defaultModel") {
			t.Errorf("agent file must never carry defaultModel, got: %s", data)
		}
	})

	t.Run("unknown top-level keys survive all three files", func(t *testing.T) {
		workdir := t.TempDir()
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","theme":"dark","futureKey":42}`)
		testutil.WriteSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","futureKey":"pi-extra"}`)
		agentPath := filepath.Join(workdir, ".pi", "agent", "settings.json")
		os.MkdirAll(filepath.Dir(agentPath), 0755)
		os.WriteFile(agentPath, []byte(`{"defaultProvider":"opencode-go","futureKey":"agent-extra"}`), 0644)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("anthropic", "claude-sonnet-4-20250514"); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["theme"] == nil || raw["futureKey"] == nil {
			t.Errorf("cheasee-settings.json lost unknown keys (theme/futureKey): %v", raw)
		}
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["futureKey"] != "pi-extra" {
			t.Errorf(".pi/settings.json lost unknown key futureKey: %v", raw)
		}
		data, err := os.ReadFile(agentPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "agent-extra") {
			t.Errorf(".pi/agent/settings.json lost unknown key futureKey: %s", data)
		}
	})

	t.Run("missing-policy: no settings files", func(t *testing.T) {
		// Not a cheasee-pi workspace: cheasee (skipIfMissing) and
		// .pi/settings.json (createIfInitialized gated on the marker) are not
		// created; the agent file (alwaysCreate) is, provider-only.
		workdir := t.TempDir()
		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("openai", "gpt-4o"); err != nil {
			t.Fatalf("missing settings files must be skipped, got %v", err)
		}
		for _, p := range []string{"cheasee-settings.json", ".pi/settings.json"} {
			if _, err := os.Stat(filepath.Join(workdir, p)); !os.IsNotExist(err) {
				t.Errorf("missing %s must not be created", p)
			}
		}
		data, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
		if err != nil {
			t.Fatalf("agent file must always be created: %v", err)
		}
		if !strings.Contains(string(data), `"defaultProvider": "openai"`) || strings.Contains(string(data), "defaultModel") {
			t.Errorf("agent file must be created provider-only, got: %s", data)
		}
	})

	t.Run("missing-policy: cheasee present only", func(t *testing.T) {
		workdir := t.TempDir()
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4-flash"}`)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("anthropic", "claude-sonnet-4-20250514"); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		// Initialized workspace → .pi/settings.json created with the model.
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
			t.Errorf(".pi/settings.json must be created with provider+model, got %v", raw)
		}
		data, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"defaultProvider": "anthropic"`) {
			t.Errorf("agent file missing defaultProvider, got: %s", data)
		}
	})

	t.Run("missing-policy: all present, agent model preserved on update", func(t *testing.T) {
		workdir := t.TempDir()
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)
		testutil.WriteSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","defaultModel":"old-model"}`)
		agentPath := filepath.Join(workdir, ".pi", "agent", "settings.json")
		os.MkdirAll(filepath.Dir(agentPath), 0755)
		os.WriteFile(agentPath, []byte(`{"defaultProvider":"opencode-go","defaultModel":"stale-model"}`), 0644)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("anthropic", "claude-sonnet-4-20250514"); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		data, err := os.ReadFile(agentPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"defaultProvider": "anthropic"`) || !strings.Contains(string(data), `"defaultModel": "stale-model"`) {
			t.Errorf("agent provider must update and pre-existing defaultModel must stay untouched, got: %s", data)
		}
	})

	t.Run("empty model preserves existing model", func(t *testing.T) {
		workdir := t.TempDir()
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4-flash"}`)
		testutil.WriteSettingsFile(t, workdir, `{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4-flash"}`)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("openai", ""); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultProvider"] != "openai" || raw["defaultModel"] != "deepseek-v4-flash" {
			t.Errorf("cheasee: empty model must preserve existing defaultModel, got %v", raw)
		}
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "openai" || raw["defaultModel"] != "deepseek-v4-flash" {
			t.Errorf("pi: empty model must preserve existing defaultModel, got %v", raw)
		}
		data, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"defaultProvider": "openai"`) || strings.Contains(string(data), "defaultModel") {
			t.Errorf("agent stays provider-only, got: %s", data)
		}
	})

	t.Run("corrupt file errors name the target", func(t *testing.T) {
		t.Run("cheasee-settings.json", func(t *testing.T) {
			workdir := t.TempDir()
			testutil.WriteCheaseeSettingsFile(t, workdir, "{nope")
			sw := &SettingsWriter{Workdir: workdir}
			err := sw.WriteDefaultProvider("openai", "gpt-4o")
			if err == nil || !strings.Contains(err.Error(), "cheasee-settings.json") {
				t.Fatalf("expected wrapped error mentioning cheasee-settings.json, got %v", err)
			}
		})
		t.Run(".pi/settings.json", func(t *testing.T) {
			workdir := t.TempDir()
			testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)
			testutil.WriteSettingsFile(t, workdir, "{nope")
			sw := &SettingsWriter{Workdir: workdir}
			err := sw.WriteDefaultProvider("openai", "gpt-4o")
			if err == nil || !strings.Contains(err.Error(), ".pi/settings.json") {
				t.Fatalf("expected wrapped error mentioning .pi/settings.json, got %v", err)
			}
		})
		t.Run(".pi/agent/settings.json", func(t *testing.T) {
			workdir := t.TempDir()
			testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)
			testutil.WriteSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)
			agentPath := filepath.Join(workdir, ".pi", "agent", "settings.json")
			os.MkdirAll(filepath.Dir(agentPath), 0755)
			os.WriteFile(agentPath, []byte("{nope"), 0644)
			sw := &SettingsWriter{Workdir: workdir}
			err := sw.WriteDefaultProvider("openai", "gpt-4o")
			if err == nil || !strings.Contains(err.Error(), ".pi/agent/settings.json") {
				t.Fatalf("expected wrapped error mentioning .pi/agent/settings.json, got %v", err)
			}
		})
	})

	t.Run("no tmp residue and chmod'd mode preserved", func(t *testing.T) {
		workdir := t.TempDir()
		cheaseePath := filepath.Join(workdir, "cheasee-settings.json")
		testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)
		if err := os.Chmod(cheaseePath, 0600); err != nil {
			t.Fatal(err)
		}
		testutil.WriteSettingsFile(t, workdir, `{"defaultProvider":"opencode-go"}`)

		sw := &SettingsWriter{Workdir: workdir}
		if err := sw.WriteDefaultProvider("anthropic", "claude-sonnet-4-20250514"); err != nil {
			t.Fatalf("WriteDefaultProvider: %v", err)
		}

		for _, p := range []string{
			cheaseePath,
			filepath.Join(workdir, ".pi", "settings.json"),
			filepath.Join(workdir, ".pi", "agent", "settings.json"),
		} {
			if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
				t.Errorf("no .tmp residue after WriteDefaultProvider: %s", p+".tmp")
			}
		}
		fi, err := os.Stat(cheaseePath)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0600 {
			t.Errorf("0600 cheasee-settings.json must keep 0600 through WriteDefaultProvider, got %v", fi.Mode().Perm())
		}
	})
}
