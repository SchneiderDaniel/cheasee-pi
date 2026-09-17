package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestInitUseCase_HappyPathWithAPIKeyFlag(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err != nil {
		t.Fatalf("unexpected error on happy path: %v", err)
	}
	if !authJSONExists(t) {
		t.Error("Save should be called on happy path")
	}
	if got := providerKey(t, readAuthJSON(t), "opencode-go"); got != FakeAPIKey {
		t.Errorf("expected API key %q, got %q", FakeAPIKey, got)
	}
}

func TestInitUseCase_ConfigSaveError(t *testing.T) {
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	// Block the config dir path with a regular file so MkdirAll fails
	// deterministically (real file I/O, no mock error injection).
	dir := testutil.RedirectConfigHome(t)
	if err := os.WriteFile(filepath.Join(dir, "cheasee-pi"), []byte("block"), 0644); err != nil {
		t.Fatalf("block config dir: %v", err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error when Save fails")
	}
	if !strings.Contains(err.Error(), "save auth config") {
		t.Errorf("error should wrap with 'save auth config': %v", err)
	}
}

func TestInitUseCase_ContextCancelled(t *testing.T) {
	testutil.RedirectConfigHome(t)
	stubLookPath(t, func(_ string) (string, error) { return "/usr/bin/docker", nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	err := runInit(ctx, initDeps(t, func(d *InitDeps) {
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil {
		t.Fatal("expected error with cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("error should mention context cancellation: %v", err)
	}
}

func TestInitUseCase_PostCloneFailureCleansResidue(t *testing.T) {
	// A post-clone init failure (API-key phase) removes the freshly cloned
	// worktree + sibling .bare, announces the cleanup, and leaves the folder
	// empty — otherwise both init (non-empty probe) and start (WorkspaceRefuse)
	// would refuse the stranded folder.
	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)
	stubInitGit(t)

	deps := initDepsWithRepoURL(t, workdir, func(d *InitDeps) {
		d.ConfirmFn = mockConfirmFn(false, fmt.Errorf("declined"))
	})
	stderr := testutil.CaptureStderr(t, func() {
		err := runInit(context.Background(), deps)
		// The first post-clone prompt is now the skill-repo phase (Phase 6b,
		// before the API-key phase) — the failure surfaces there.
		if err == nil || !strings.Contains(err.Error(), "skill repo setup") {
			t.Fatalf("expected skill-repo setup failure, got %v", err)
		}
	})

	if !strings.Contains(stderr, "removing incomplete workspace residue") {
		t.Errorf("cleanup must be announced to stderr, got: %q", stderr)
	}
	// The worktree leaf and its sibling .bare are removed; the init folder
	// itself stays (empty).
	if _, statErr := os.Stat(filepath.Join(workdir, "main")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove the worktree: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("post-clone failure must remove .bare: %v", statErr)
	}
}

func TestInitUseCase_PreCloneFailureLeavesNoResidue(t *testing.T) {
	// Pre-clone failure (device-flow/auth error) → no cleanup call and no
	// .bare created (nothing to remove).
	testutil.RedirectConfigHome(t)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubDockerCheck(t, nil, "24.0.9", nil)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.InputFn = mockInputFn("owner/repo", nil)
		d.Ports = InitPorts{Auth: &mockAuthenticator{
			waitFunc: func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
				return nil, fmt.Errorf("device flow wait failed: user cancelled")
			},
		}, Catalog: &mockModelCatalog{}}
	})

	err := runInit(context.Background(), deps)
	if err == nil || !strings.Contains(err.Error(), "GitHub authentication failed") {
		t.Fatalf("expected auth failure, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("pre-clone failure must leave no .bare: %v", statErr)
	}
}

func TestInitUseCase_NonEmptyRefusesEvenWithNoInput(t *testing.T) {
	// The empty-folder contract is a hard refusal — --no-input does not bypass it.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workdir, "file.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil || !strings.Contains(err.Error(), "empty folder") {
		t.Fatalf("expected empty-folder refusal, got %v", err)
	}
	if authJSONExists(t) {
		t.Error("no auth must be saved when the folder is refused")
	}
}

func TestInitUseCase_SettingsPresentRefusesEvenWithNoInput(t *testing.T) {
	// cheasee-settings.json presence = initialized marker — init refuses,
	// --no-input or not (no re-apply flow).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	workdir := t.TempDir()
	testutil.WriteCheaseeSettingsFile(t, workdir, `{}`)

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoGitHub = true
		d.APIKey = FakeAPIKey
	}))
	if err == nil || !strings.Contains(err.Error(), "already initialized") {
		t.Fatalf("expected already-initialized refusal, got %v", err)
	}
}

func TestInitUseCase_UnparsableRepoURLErrorsBeforeGit(t *testing.T) {
	// An unparsable repo URL must fail before any git call (no partial clone).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}

	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.InputFn = mockInputFn("not-a-url", nil)
	}))
	if err == nil || !strings.Contains(err.Error(), "invalid repo URL") {
		t.Fatalf("expected invalid repo URL error, got %v", err)
	}
	if gitCalls != 0 {
		t.Errorf("no git call may run for an unparsable URL, got %d", gitCalls)
	}
	if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
		t.Errorf("no .bare may be created for an unparsable URL: %v", statErr)
	}
}

func TestInitUseCase_NoInputRequiresRepoURL(t *testing.T) {
	// --no-input without --repo-url and without --no-github errors before
	// any git call (there is no prompt to ask for the URL).
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	var gitCalls int
	saved := runCommandContext
	stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
		if name == "git" {
			gitCalls++
		}
		return saved(ctx, name, arg...)
	})

	workdir := t.TempDir()
	err := runInit(context.Background(), initDeps(t, func(d *InitDeps) { d.Workdir = workdir }))
	if err == nil || !strings.Contains(err.Error(), "--repo-url") {
		t.Fatalf("expected --repo-url requirement error, got %v", err)
	}
	if gitCalls != 0 {
		t.Errorf("no git call may run without a repo URL, got %d", gitCalls)
	}
}

func TestInitUseCase_InvalidWorkspaceFolderNameRejected(t *testing.T) {
	// A non-plain workspace folder name is a hard error before any git call:
	// the value names the worktree folder only (never a git branch), so
	// slashes and relative-name tricks must not reach the clone phase.
	for _, name := range []string{"a/b", ".", "..", `a\b`} {
		t.Run(name, func(t *testing.T) {
			testutil.RedirectConfigHome(t)
			stubDockerCheck(t, nil, "24.0.9", nil)
			testutil.SetGitConfig(t, testGitIdentityConfig)

			var gitCalls int
			saved := runCommandContext
			stubRunCommandContext(t, func(ctx context.Context, name string, arg ...string) runner {
				if name == "git" {
					gitCalls++
				}
				return saved(ctx, name, arg...)
			})

			parent := t.TempDir()
			workdir := filepath.Join(parent, "ws")
			if err := os.MkdirAll(workdir, 0755); err != nil {
				t.Fatal(err)
			}
			_, input := mockQueuePrompt(t, nil, []string{"owner/repo", name})
			err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
				d.Workdir = workdir
				d.NoInput = false
				d.InputFn = input
			}))
			if err == nil || !strings.Contains(err.Error(), "invalid workspace folder name") {
				t.Fatalf("expected invalid workspace folder name error, got %v", err)
			}
			if gitCalls != 0 {
				t.Errorf("no git call may run for an invalid folder name, got %d", gitCalls)
			}
			if _, statErr := os.Stat(filepath.Join(parent, ".bare")); !os.IsNotExist(statErr) {
				t.Errorf("no .bare may be created for an invalid folder name: %v", statErr)
			}
		})
	}
}

func TestInitUseCase_BlankWorkspaceFolderDefaultsToMain(t *testing.T) {
	// A blank (whitespace-only) folder-name input still defaults to the main
	// leaf — the boundary is preserved under the rename.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)
	stubInitGit(t)

	parent := t.TempDir()
	workdir := filepath.Join(parent, "ws")
	if err := os.MkdirAll(workdir, 0755); err != nil {
		t.Fatal(err)
	}
	deps := initDepsWithRepoURL(t, workdir, func(d *InitDeps) {
		_, input := mockQueuePrompt(t, nil, []string{"owner/repo", "   "})
		d.InputFn = input
	})
	if err := runInit(context.Background(), deps); err != nil {
		t.Fatalf("flow with blank folder name failed: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(workdir, "main", "cheasee-settings.json")); statErr != nil {
		t.Errorf("blank folder name must default to the main leaf: %v", statErr)
	}
}

func TestInitUseCase_PromptFailurePropagation(t *testing.T) {
	// InputFn errors stay wrapped with their prompt label ("repo URL prompt
	// failed" / "branch prompt failed") — the Contains-style contract
	// survives the title renames.
	testutil.RedirectConfigHome(t)
	stubDockerCheck(t, nil, "24.0.9", nil)
	testutil.SetGitConfig(t, testGitIdentityConfig)

	cases := []struct {
		name      string
		first     string // value for the first (repo URL) call
		errOn     int    // 1-based call number that returns an error
		wantError string
	}{
		{"repo URL prompt", "", 1, "repo URL prompt failed"},
		{"branch prompt", "owner/repo", 2, "branch prompt failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			workdir := t.TempDir()
			calls := 0
			err := runInit(context.Background(), initDeps(t, func(d *InitDeps) {
				d.Workdir = workdir
				d.NoInput = false
				d.InputFn = func(title, placeholder string) (string, error) {
					calls++
					if calls == tc.errOn {
						return "", fmt.Errorf("input interrupted")
					}
					return tc.first, nil
				}
			}))
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected %q wrap, got %v", tc.wantError, err)
			}
		})
	}
}
