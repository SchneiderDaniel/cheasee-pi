package main

import (
	"bytes"
	"context"
	"errors"
	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"reflect"
	"testing"
)

// ──────────────────────────────────────────────
// init API-key phase (runInitAPIKeys)
// ──────────────────────────────────────────────

func TestRunInitAPIKeys_MultiProviderLastWins(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, true, false} // configure keys? → yes; add another? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	providers := []string{"openai", "anthropic"}
	keys := []string{"key-openai", "key-anthropic"}
	picks := []string{"gpt-4o", "claude-sonnet-4-20250514"}
	var seenModels [][]string
	stubPromptProvider(t, func() (string, error) {
		next := providers[0]
		providers = providers[1:]
		return next, nil
	})
	stubPromptAPIKey(t, func(string) (string, error) {
		next := keys[0]
		keys = keys[1:]
		return next, nil
	})
	stubPromptModel(t, func(_ string, models []string) (string, error) {
		seenModels = append(seenModels, models)
		next := picks[0]
		picks = picks[1:]
		return next, nil
	})

	catalog := &mockModelCatalog{models: []string{"gpt-4o", "gpt-4o-mini", "claude-sonnet-4-20250514"}}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, catalog, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}

	// Both keys saved; the LAST provider's picked model becomes the default.
	authRaw := readAuthJSON(t)
	if got := providerKey(t, authRaw, "openai"); got != "key-openai" {
		t.Errorf("openai key = %q", got)
	}
	if got := providerKey(t, authRaw, "anthropic"); got != "key-anthropic" {
		t.Errorf("anthropic key = %q", got)
	}
	raw := testutil.ReadCheaseeSettingsRaw(t, workdir)
	if raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
		t.Errorf("cheasee-settings = %v, want last provider anthropic + its picked model", raw)
	}
	if raw := testutil.ReadSettingsRaw(t, workdir); raw["defaultProvider"] != "anthropic" || raw["defaultModel"] != "claude-sonnet-4-20250514" {
		t.Errorf(".pi/settings.json = %v, want anthropic + claude-sonnet-4-20250514", raw)
	}
	// Both pickers were fed the live catalog list.
	if len(seenModels) != 2 || !reflect.DeepEqual(seenModels[0], seenModels[1]) {
		t.Errorf("both pickers must receive the live list, got %v", seenModels)
	}
	if len(seenModels[0]) != 3 || seenModels[0][0] != "gpt-4o" {
		t.Errorf("picker list = %v, want the live catalog sorted list", seenModels[0])
	}
}

// TestRunInitAPIKeys_SingleCatalogConsultationPerProvider is the init half of
// the audit regression (init_auth.go consulted the catalog twice per provider
// — once for the default, once for the picker list — doubling the retry loop
// on a failing pi.dev request).
func TestRunInitAPIKeys_SingleCatalogConsultationPerProvider(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, false} // configure keys? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	stubPromptProvider(t, func() (string, error) { return "openai", nil })
	stubPromptAPIKey(t, func(string) (string, error) { return "key", nil })
	stubPromptModel(t, func(string, []string) (string, error) { return "", nil }) // keep catalog default

	cc := &countingModelCatalog{err: errors.New("offline")}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, cc, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}
	if cc.calls != 1 {
		t.Errorf("catalog consulted %d times, want exactly 1 per provider", cc.calls)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultModel"] != "gpt-4o" {
		t.Errorf("defaultModel = %v, want seed first entry gpt-4o", raw["defaultModel"])
	}
}

func TestRunInitAPIKeys_CatalogErrorSeedsPicker(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{"defaultProvider":"seed"}`)

	confirms := []bool{true, false} // configure keys? → yes; add another? → no
	confirmFn := func(string) (bool, error) {
		next := confirms[0]
		confirms = confirms[1:]
		return next, nil
	}
	stubPromptProvider(t, func() (string, error) { return "opencode-go", nil })
	stubPromptAPIKey(t, func(string) (string, error) { return "test-key", nil })
	var pickerList []string
	stubPromptModel(t, func(_ string, models []string) (string, error) {
		pickerList = models
		return "", nil // "" keeps the catalog/seed-derived default
	})

	catalog := &mockModelCatalog{err: errors.New("offline")}
	if err := runInitAPIKeys(context.Background(), &fileRepository{}, catalog, workdir, confirmFn); err != nil {
		t.Fatalf("runInitAPIKeys: %v", err)
	}
	// Offline: the picker was fed the pruned opencode-go seed and the default
	// written is the validated static override.
	want := KnownModels["opencode-go"]
	if !reflect.DeepEqual(pickerList, want) {
		t.Errorf("offline picker list = %v, want pruned seed %v", pickerList, want)
	}
	if raw := testutil.ReadCheaseeSettingsRaw(t, workdir); raw["defaultProvider"] != "opencode-go" || raw["defaultModel"] != "kimi-k2.6" {
		t.Errorf("cheasee-settings = %v, want opencode-go + kimi-k2.6 (static override)", raw)
	}
}

func TestRunInitAPIKeys_DeclinedSkipsEverything(t *testing.T) {
	testutil.RedirectConfigHome(t)
	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)
	seedAuth(t, map[string]string{"openai": "key-openai"})
	before := authJSONBytes(t)

	promptCalled := false
	stubPromptProvider(t, func() (string, error) { promptCalled = true; return "openai", nil })

	err := runInitAPIKeys(context.Background(), &fileRepository{}, &mockModelCatalog{}, workdir, mockConfirmFn(false, nil))
	if err != nil {
		t.Fatalf("declining must not error: %v", err)
	}
	if promptCalled {
		t.Error("declined confirmation must skip the provider loop")
	}
	if !bytes.Equal(before, authJSONBytes(t)) {
		t.Error("auth.json must be untouched when the phase is declined")
	}
}
