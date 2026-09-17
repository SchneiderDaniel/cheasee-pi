package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// DefaultModel / static seed semantics (provider.go + catalog.go)
// ──────────────────────────────────────────────

// TestKnownModels_opencodeGoPruned pins the cross-catalog copy-error guard:
// gpt-4o and claude-sonnet-4-20250514 are NOT opencode-go models (they
// belong to the openai/anthropic catalogs) and pi cannot resolve them under
// opencode-go — selecting either once wrote an invalid defaultModel.
func TestKnownModels_opencodeGoPruned(t *testing.T) {
	for _, m := range KnownModels["opencode-go"] {
		if m == "gpt-4o" || m == "claude-sonnet-4-20250514" {
			t.Errorf("pruned cross-catalog entry %q must not be in the opencode-go seed", m)
		}
	}
}

// TestDefaultModel_pinsOverrideAndSeed asserts the static override wins over
// the seed, the un-overridden seed keeps its first-entry semantics, and
// unknown/empty providers yield "".
func TestDefaultModel_pinsOverrideAndSeed(t *testing.T) {
	if got := DefaultModel("opencode-go"); got != "kimi-k2.6" {
		t.Errorf("DefaultModel(opencode-go) = %q, want kimi-k2.6 (static override)", got)
	}
	if got := DefaultModel("openai"); got != "gpt-4o" {
		t.Errorf("DefaultModel(openai) = %q, want gpt-4o (first seed entry)", got)
	}
	if got := DefaultModel("unknown-provider"); got != "" {
		t.Errorf("DefaultModel(unknown) = %q, want empty", got)
	}
}

// TestModelChoice pins the single-lookup resolution: the static override wins
// regardless of catalog state (and skips the fetch entirely when no picker
// list is needed — offline --no-input); with no override the default and the
// picker list share ONE catalog consultation (the audit-flagged double-fetch
// ran the retry loop twice); catalog errors fall back to the seed.
func TestModelChoice(t *testing.T) {
	ctx := context.Background()
	staticProvider := "opencode-go"

	t.Run("override wins regardless of catalog state", func(t *testing.T) {
		// Catalog down: the override must still hold (offline never flips).
		if def, _ := modelChoice(ctx, &mockModelCatalog{err: errSentinel}, staticProvider, false); def != "kimi-k2.6" {
			t.Errorf("catalog error: modelChoice def = %q, want kimi-k2.6", def)
		}
		// Catalog up with a different first id: the override still wins.
		if def, models := modelChoice(ctx, &mockModelCatalog{models: []string{"glm-5.3", "kimi-k2.6"}}, staticProvider, true); def != "kimi-k2.6" || !reflect.DeepEqual(models, []string{"glm-5.3", "kimi-k2.6"}) {
			t.Errorf("live list: def = %q, models = %v, want kimi-k2.6 + live list", def, models)
		}
	})

	t.Run("override + no list needed → zero catalog consultations", func(t *testing.T) {
		// --no-input for an override provider must stay fully offline.
		cc := &countingModelCatalog{models: []string{"glm-5.3", "kimi-k2.6"}}
		def, models := modelChoice(ctx, cc, staticProvider, false)
		if def != "kimi-k2.6" || models != nil || cc.calls != 0 {
			t.Errorf("no-list override: def=%q models=%v calls=%d, want kimi-k2.6 + nil + 0", def, models, cc.calls)
		}
	})

	t.Run("no override + live list → sorted-first def + live list, one consultation", func(t *testing.T) {
		cc := &countingModelCatalog{models: []string{"gpt-4o-mini", "gpt-4o"}}
		def, models := modelChoice(ctx, cc, "openai", false)
		if def != "gpt-4o-mini" || !reflect.DeepEqual(models, []string{"gpt-4o-mini", "gpt-4o"}) {
			t.Errorf("def=%q models=%v, want gpt-4o-mini + live list", def, models)
		}
		if cc.calls != 1 {
			t.Errorf("catalog consulted %d times, want exactly 1 (one lookup feeds both)", cc.calls)
		}
	})

	t.Run("catalog error + no override → seed first entry + seed list", func(t *testing.T) {
		def, models := modelChoice(ctx, &mockModelCatalog{err: errSentinel}, "openai", false)
		if def != "gpt-4o" || !reflect.DeepEqual(models, KnownModels["openai"]) {
			t.Errorf("def=%q models=%v, want gpt-4o + openai seed", def, models)
		}
	})
}

// TestModelsFor pins the picker-list resolution: the live sorted list when
// the catalog answers, the pruned seed on error. Empty-seed providers gate
// the picker on the live list for the first time.
func TestModelsFor(t *testing.T) {
	ctx := context.Background()

	t.Run("live list when catalog OK", func(t *testing.T) {
		got := modelsFor(ctx, &mockModelCatalog{models: []string{"glm-5.3", "kimi-k2.6"}}, "opencode-go")
		if len(got) != 2 || got[0] != "glm-5.3" || got[1] != "kimi-k2.6" {
			t.Errorf("modelsFor = %v, want the live list", got)
		}
	})

	t.Run("pruned seed on catalog error", func(t *testing.T) {
		got := modelsFor(ctx, &mockModelCatalog{err: errSentinel}, "opencode-go")
		if len(got) != 2 || got[0] != "deepseek-v4-flash" || got[1] != "kimi-k2.6" {
			t.Fatalf("modelsFor = %v, want the pruned seed", got)
		}
		for _, m := range got {
			if m == "gpt-4o" || m == "claude-sonnet-4-20250514" {
				t.Errorf("offline seed must stay pruned, got %q", m)
			}
		}
	})

	t.Run("empty seed gates picker on the live list", func(t *testing.T) {
		// together/cerebras have empty seeds — the live list is the only
		// source for their pickers (offline they simply have no picker).
		got := modelsFor(ctx, &mockModelCatalog{models: []string{"meta-llama/Llama-3.3-70B-Instruct-Turbo"}}, "together")
		if len(got) != 1 || got[0] != "meta-llama/Llama-3.3-70B-Instruct-Turbo" {
			t.Errorf("modelsFor(together) = %v, want the live list", got)
		}
		if got := modelsFor(ctx, &mockModelCatalog{err: errSentinel}, "together"); len(got) != 0 {
			t.Errorf("offline together must yield no picker list, got %v", got)
		}
	})
}

// errSentinel is the shared stub catalog error for seed-fallback assertions.
var errSentinel = errors.New("offline")

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

	t.Run("null file is a hard error, not an empty schema", func(t *testing.T) {
		// null unmarshals cleanly into both the typed struct and the raw map
		// (leaving the map nil); it must surface as a hard error naming the
		// target — never be treated as valid and overwritten.
		files := []struct {
			name    string
			setup   func(string)
			wantErr string
		}{
			{"cheasee-settings.json",
				func(wd string) { testutil.WriteCheaseeSettingsFile(t, wd, `null`) },
				"cheasee-settings.json"},
			{".pi/settings.json",
				func(wd string) {
					testutil.WriteCheaseeSettingsFile(t, wd, `{}`)
					testutil.WriteSettingsFile(t, wd, `null`)
				},
				".pi/settings.json"},
			{".pi/agent/settings.json",
				func(wd string) {
					testutil.WriteCheaseeSettingsFile(t, wd, `{}`)
					agentPath := filepath.Join(wd, ".pi", "agent", "settings.json")
					os.MkdirAll(filepath.Dir(agentPath), 0755)
					os.WriteFile(agentPath, []byte(`null`), 0644)
				},
				".pi/agent/settings.json"},
		}
		for _, tc := range files {
			t.Run(tc.name, func(t *testing.T) {
				workdir := t.TempDir()
				tc.setup(workdir)
				sw := &SettingsWriter{Workdir: workdir}
				err := sw.WriteDefaultProvider("openai", "gpt-4o")
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected wrapped error mentioning %s, got %v", tc.wantErr, err)
				}
			})
		}
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
