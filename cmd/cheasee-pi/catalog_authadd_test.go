package main

import (
	"errors"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// ──────────────────────────────────────────────
// auth add call site (runAuthAddE)
// ──────────────────────────────────────────────

func TestRunAuthAddE_NoInputWritesValidDefault(t *testing.T) {
	t.Run("override provider: static default, no catalog consultation", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, []string{"glm-5.3", "kimi-k2.6"}, nil)
		stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
		promptCalled := false
		stubPromptModel(t, func(string, []string) (string, error) {
			promptCalled = true
			return "", nil
		})

		if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
			t.Fatalf("auth add: %v", err)
		}
		if promptCalled {
			t.Error("--no-input must skip the model picker entirely")
		}
		raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
		if raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
			t.Errorf("cheasee-settings = %v, want provider opencode-go + model kimi-k2.6", raw)
		}
		if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultModel"] != "kimi-k2.6" {
			t.Errorf(".pi/settings.json defaultModel = %v, want kimi-k2.6", raw["defaultModel"])
		}
		authRaw := readAuthJSON(t)
		if got := providerKey(t, authRaw, "opencode-go"); got != "test-key" {
			t.Errorf("auth.json key = %q, want test-key", got)
		}
	})

	t.Run("no override: sorted-first live id becomes default", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, []string{"gpt-4o-mini", "gpt-4o"}, nil)
		stubPromptAPIKey(t, func(string) (string, error) { return "key-openai", nil })

		if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
			t.Fatalf("auth add: %v", err)
		}
		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o-mini" {
			t.Errorf("defaultModel = %v, want gpt-4o-mini (sorted-first live id)", raw["defaultModel"])
		}
	})

	t.Run("catalog error falls back to static seed, command succeeds", func(t *testing.T) {
		testutil.RedirectConfigHome(t)
		workdir := newAuthAddWorkdir(t)
		withAuthAddFlags(t, workdir, true)
		stubModelCatalog(t, nil, errors.New("offline"))
		stubPromptAPIKey(t, func(string) (string, error) { return "key-openai", nil })

		if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
			t.Fatalf("catalog error must not fail auth add: %v", err)
		}
		if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
			t.Errorf("defaultModel = %v, want gpt-4o (seed first entry)", raw["defaultModel"])
		}
	})
}

// TestRunAuthAddE_SingleCatalogConsultation is the audit regression: the
// default and the picker list must come from ONE catalog lookup per provider
// invocation. The pre-audit defaultModelFor + modelsFor pair consulted twice,
// running the fetch/retry loop twice on a cold cache with a failing pi.dev
// request (up to 4 attempts ≈ 16s per provider).
func TestRunAuthAddE_SingleCatalogConsultation(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false) // interactive = the double-fetch path
	cc := &countingModelCatalog{models: []string{"gpt-4o", "gpt-4o-mini"}}
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return cc }
	t.Cleanup(func() { newModelCatalog = saved })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil }) // keep catalog default

	if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want exactly 1 (default + picker list from one lookup)", cc.calls)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
		t.Errorf("defaultModel = %v, want sorted-first live id gpt-4o", raw["defaultModel"])
	}
}

// TestRunAuthAddE_StalledCatalogBoundsOneConsultation is the timeout half of
// the audit regression: a stalled catalog must delay interactive auth add by
// one consultation, not two (the double-fetch doubled the stall per provider).
func TestRunAuthAddE_StalledCatalogBoundsOneConsultation(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	cc := &slowModelCatalog{delay: 400 * time.Millisecond, err: errors.New("offline")}
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return cc }
	t.Cleanup(func() { newModelCatalog = saved })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil })

	if err := runAuthAddE(&cobra.Command{}, []string{"openai"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	// The consultation count is the real invariant: the pre-fix code consulted
	// the catalog twice, doubling the stall. A wall-clock bound here was
	// redundant and flaked on loaded CI runners (400ms sleep + scheduler
	// jitter), so assert the count only.
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want 1", cc.calls)
	}
}

func TestRunAuthAddE_InteractivePickerGetsLiveList(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	live := []string{"glm-5.3", "kimi-k2.6", "qwen3.7-max"}
	stubModelCatalog(t, live, nil)
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(provider string, models []string) (string, error) {
		pickerList = models
		return "kimi-k2.6", nil
	})

	var err error
	stderr := testutil.CaptureStderr(t, func() {
		err = runAuthAddE(&cobra.Command{}, []string{"opencode-go"})
	})
	if err != nil {
		t.Fatalf("auth add: %v", err)
	}

	// The picker receives the live sorted catalog list — and never the stale
	// cross-catalog entries this issue exists to eliminate.
	if !reflect.DeepEqual(pickerList, live) {
		t.Errorf("picker list = %v, want live catalog %v (no gpt-4o / claude-sonnet-4-20250514)", pickerList, live)
	}
	for _, m := range pickerList {
		if m == "gpt-4o" || m == "claude-sonnet-4-20250514" {
			t.Errorf("pruned cross-catalog entry %q must not reach the picker", m)
		}
	}
	// The picked model is written to all three settings files.
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf("cheasee-settings = %v, want opencode-go + kimi-k2.6", raw)
	}
	if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf(".pi/settings.json defaultModel = %v, want kimi-k2.6", raw["defaultModel"])
	}
	agent, err := os.ReadFile(filepath.Join(workdir, ".pi", "agent", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(agent), `"defaultProvider": "opencode-go"`) || strings.Contains(string(agent), "defaultModel") {
		t.Errorf("agent file stays provider-only, got: %s", agent)
	}
	if !strings.Contains(stderr, "✓ Set as default provider in workspace settings (model: kimi-k2.6)") {
		t.Errorf("stderr should name the picked default model, got:\n%s", stderr)
	}
}

func TestRunAuthAddE_InteractiveCatalogErrorFallsBackToPrunedSeed(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	stubModelCatalog(t, nil, errors.New("offline"))
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(provider string, models []string) (string, error) {
		pickerList = models
		return "deepseek-v4-flash", nil
	})

	if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	want := KnownModels["opencode-go"]
	if !reflect.DeepEqual(pickerList, want) {
		t.Errorf("offline picker list = %v, want pruned seed %v", pickerList, want)
	}
	if len(pickerList) != 2 || pickerList[0] != "deepseek-v4-flash" || pickerList[1] != "kimi-k2.6" {
		t.Fatalf("seed must be pruned to deepseek-v4-flash + kimi-k2.6, got %v", pickerList)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "deepseek-v4-flash" {
		t.Errorf("defaultModel = %v, want picked seed model deepseek-v4-flash", raw["defaultModel"])
	}
}

func TestRunAuthAddE_CustomPickerValueWrittenVerbatim(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := newAuthAddWorkdir(t)
	withAuthAddFlags(t, workdir, false)
	stubModelCatalog(t, []string{"kimi-k2.6", "glm-5.3"}, nil)
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	// The Custom hatch is inside the (real, TTY-bound) promptModel — the seam
	// stands in for it; whatever it returns must be written verbatim, never
	// replaced by a default.
	stubPromptModel(t, func(string, []string) (string, error) { return "my-custom-model", nil })

	if err := runAuthAddE(&cobra.Command{}, []string{"opencode-go"}); err != nil {
		t.Fatalf("auth add: %v", err)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "my-custom-model" {
		t.Errorf("custom model must be written verbatim, got %v", raw["defaultModel"])
	}
}
