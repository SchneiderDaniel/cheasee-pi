package main

import (
	"context"
	"fmt"
	"github.com/go-git/go-git/v5/config"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 2: parseSubmoduleURLs tests
// ──────────────────────────────────────────────

func TestParseSubmoduleURLs_HappyPath(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"flask_blogs=https://github.com/user/flask_blogs"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(result))
	}
	if result["flask_blogs"] != "https://github.com/user/flask_blogs" {
		t.Errorf("expected URL, got %q", result["flask_blogs"])
	}
}

func TestParseSubmoduleURLs_SCPStyle(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"private-pi=git@github.com:user/private-pi.git"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result["private-pi"] != "git@github.com:user/private-pi.git" {
		t.Errorf("expected SCP URL, got %q", result["private-pi"])
	}
}

func TestParseSubmoduleURLs_Multiple(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{"a=https://a.com", "b=https://b.com"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result))
	}
	if result["a"] != "https://a.com" {
		t.Errorf("expected 'https://a.com', got %q", result["a"])
	}
	if result["b"] != "https://b.com" {
		t.Errorf("expected 'https://b.com', got %q", result["b"])
	}
}

func TestParseSubmoduleURLs_EmptyName(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"=url"})
	if err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestParseSubmoduleURLs_EmptyURL(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"name="})
	if err == nil {
		t.Fatal("expected error for empty URL")
	}
}

func TestParseSubmoduleURLs_MissingEquals(t *testing.T) {
	_, err := parseSubmoduleURLs([]string{"invalid"})
	if err == nil {
		t.Fatal("expected error for missing =")
	}
}

func TestParseSubmoduleURLs_EmptyInput(t *testing.T) {
	result, err := parseSubmoduleURLs([]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 0 {
		t.Fatalf("expected empty map, got %d entries", len(result))
	}
}

// ──────────────────────────────────────────────
// Phase 4: runInitSubmodule orchestrator tests
// ──────────────────────────────────────────────

func TestRunInitSubmodule_SkipAll(t *testing.T) {
	mc := &mockSubmoduleOps{}
	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, true, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.listSubmodulesCalled {
		t.Error("ListSubmodules should not be called when skipAll is true")
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called when skipAll is true")
	}
	if mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should not be called when skipAll is true")
	}
}

func TestRunInitSubmodule_NoOverridesNoPrompt(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.listSubmodulesCalled {
		t.Error("ListSubmodules should be called")
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with no overrides")
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_WithPromptReturnsEmpty(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return nil, nil // user accepted all defaults
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with no changes")
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_UrlOverridesOne(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should be called")
	}
	if mc.setSubmoduleURLName != "flask_blogs" {
		t.Errorf("expected flask_blogs, got %q", mc.setSubmoduleURLName)
	}
	if mc.setSubmoduleURLURL != "https://github.com/user/flask_blogs" {
		t.Errorf("expected URL, got %q", mc.setSubmoduleURLURL)
	}
	if !mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should be called")
	}
}

func TestRunInitSubmodule_UrlOverridesBoth(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return nil
		},
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
		"private-pi":  "https://github.com/user/private-pi.git",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Should have called SetSubmoduleURL for both
	if len(mc.setSubmoduleURLCalls) != 2 {
		t.Errorf("expected 2 SetSubmoduleURL calls, got %d", len(mc.setSubmoduleURLCalls))
	}
}

func TestRunInitSubmodule_PromptReturnsOverride(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
				{Name: "private-pi", Path: "private-pi", URL: "https://github.com/SchneiderDaniel/private-pi.git"},
			}, nil
		},
	}

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return map[string]string{
			"flask_blogs": "https://github.com/user/flask_blogs",
		}, nil
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should be called for the prompted override")
	}
	if mc.setSubmoduleURLName != "flask_blogs" {
		t.Errorf("expected flask_blogs, got %q", mc.setSubmoduleURLName)
	}
}

func TestRunInitSubmodule_OverridesPrecedePrompt(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	// Prompt returns one URL, but override wins
	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return map[string]string{
			"flask_blogs": "https://github.com/prompt/flask_blogs",
		}, nil
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/cli/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, promptFn, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLURL != "https://github.com/cli/flask_blogs" {
		t.Errorf("expected CLI override URL, got %q", mc.setSubmoduleURLURL)
	}
}

func TestRunInitSubmodule_ListSubmodulesError(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return nil, fmt.Errorf("repo not found")
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "repo not found") {
		t.Errorf("expected 'repo not found', got %v", err)
	}
}

func TestRunInitSubmodule_SetSubmoduleURLError(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return fmt.Errorf("invalid URL")
		},
	}

	urlOverrides := map[string]string{
		"flask_blogs": "https://github.com/user/flask_blogs",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "invalid URL") {
		t.Errorf("expected 'invalid URL', got %v", err)
	}
}

func TestRunInitSubmodule_InitAndUpdateError(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		initAndUpdateSubmodFunc: func(ctx context.Context, repoPath string) error {
			return fmt.Errorf("update failed")
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "update failed") {
		t.Errorf("expected 'update failed', got %v", err)
	}
}

func TestRunInitSubmodule_PromptError(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
	}

	promptFn := func(sms []config.Submodule) (map[string]string, error) {
		return nil, fmt.Errorf("user cancelled")
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, promptFn, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "user cancelled") {
		t.Errorf("expected 'user cancelled', got %v", err)
	}
}

func TestRunInitSubmodule_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return nil, ctx.Err()
		},
	}

	err := runInitSubmodule(ctx, mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestRunInitSubmodule_EmptySubmoduleList(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{}, nil
		},
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), nil, false, nil, false, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mc.setSubmoduleURLCalled {
		t.Error("SetSubmoduleURL should not be called with empty list")
	}
	if mc.initAndUpdateCalled {
		t.Error("InitAndUpdateSubmodules should not be called with empty list")
	}
}

func TestRunInitSubmodule_OverrideNonExistentSubmodule(t *testing.T) {
	mc := &mockSubmoduleOps{
		listSubmodulesFunc: func(ctx context.Context, repoPath string) ([]config.Submodule, error) {
			return []config.Submodule{
				{Name: "flask_blogs", Path: "flask_blogs", URL: "https://github.com/SchneiderDaniel/flask_blogs"},
			}, nil
		},
		setSubmoduleURLFunc: func(ctx context.Context, repoPath, name, url string) error {
			return fmt.Errorf("submodule %q not found in .gitmodules", name)
		},
	}

	urlOverrides := map[string]string{
		"nonexistent": "https://github.com/user/nonexistent",
	}

	err := runInitSubmodule(context.Background(), mc, t.TempDir(), urlOverrides, false, nil, false, nil, nil)
	if err == nil {
		t.Fatal("expected error for non-existent submodule")
	}
}
