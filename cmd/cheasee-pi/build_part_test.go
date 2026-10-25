package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

func TestBuildCmd_Registered(t *testing.T) {
	found := false
	for _, c := range rootCmd.Commands() {
		if c.Name() == "build" {
			found = true
			if c.RunE == nil {
				t.Error("buildCmd.RunE must be non-nil (use RunE, not Run)")
			}
		}
	}
	if !found {
		t.Error("buildCmd must be registered on rootCmd")
	}
}

func TestBuildCmd_NoNoCacheFlag(t *testing.T) {
	if buildCmd.Flags().Lookup("workdir") == nil {
		t.Error("build must expose --workdir")
	}
	if buildCmd.Flags().Lookup("no-docker-check") == nil {
		t.Error("build must expose --no-docker-check")
	}
	if buildCmd.Flags().Lookup("no-cache") != nil {
		t.Error("build must NOT expose --no-cache (rebuild is the no-cache path)")
	}
}

func TestBuildCmd_Help_NoAlias(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "build", "--help")
	if err != nil {
		t.Fatalf("build --help: %v", err)
	}
	if !strings.Contains(output, "cheasee-pi rebuild") {
		t.Errorf("build --help should point at 'cheasee-pi rebuild' for the full no-cache path\n--- output:\n%s", output)
	}
	for _, forbid := range []string{"--no-cache", "compatibility alias"} {
		if strings.Contains(output, forbid) {
			t.Errorf("build --help must not mention %q\n--- output:\n%s", forbid, output)
		}
	}
}

func TestBuildCmd_NoCacheFlagRejected(t *testing.T) {
	stub := &buildTestStub{}
	stub.install(t)
	_, err := testutil.RunCobra(t, rootCmd, "build", "--no-cache")
	if err == nil || !strings.Contains(err.Error(), "unknown flag: --no-cache") {
		t.Fatalf("build --no-cache must fail with 'unknown flag: --no-cache', got %v", err)
	}
	if len(stub.log) != 0 {
		t.Errorf("build --no-cache must invoke zero docker commands, got %v", stub.log)
	}
}

func TestRebuildCmd_Help(t *testing.T) {
	output, err := testutil.RunCobra(t, rootCmd, "rebuild", "--help")
	if err != nil {
		t.Fatalf("rebuild --help: %v", err)
	}
	for _, want := range []string{"--workdir", "--no-docker-check", "no-cache", "prune"} {
		if !strings.Contains(output, want) {
			t.Errorf("rebuild --help should mention %q\n--- output:\n%s", want, output)
		}
	}
	if strings.Contains(output, "--no-cache flag") {
		t.Errorf("rebuild --help must not list a --no-cache flag\n--- output:\n%s", output)
	}
}

// ──────────────────────────────────────────────
// Phase 2: build core arg construction
// ──────────────────────────────────────────────

func TestRunRebuildE_ArgsContainNoCacheAndPull(t *testing.T) {
	resetBuildState(t)
	buildNoDockerCheck = true
	xdg := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", xdg)
	root := buildWorkspaceFixture(t)
	chdir(t, root)

	stub := &buildTestStub{}
	stub.install(t)
	if err := runRebuildE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runRebuildE: %v", err)
	}
	if len(stub.compose) != 1 {
		t.Fatalf("expected exactly one compose build, got %d", len(stub.compose))
	}
	argv := stub.composeArgv()
	if len(argv) < 7 || argv[0] != "docker" || argv[1] != "compose" {
		t.Fatalf("unexpected compose argv: %v", argv)
	}
	wantFile := filepath.Join(xdg, "cheasee-pi", cliVersion(), "docker-compose.yml")
	if argv[2] != "-f" || argv[3] != wantFile {
		t.Fatalf("-f must point at the version-keyed cache compose file, got %v", argv)
	}
	if argv[4] != "build" {
		t.Fatalf("compose build missing, got %v", argv)
	}
	for _, a := range argv {
		if a == "--build-arg" || strings.HasPrefix(a, "PI_BUILD_STAMP=") {
			t.Fatalf("stamp must ride the compose env, not the argv, got %v", argv)
		}
	}
	if argv[5] != "--no-cache" || argv[6] != "--pull" {
		t.Fatalf("rebuild must pass --no-cache and --pull, got %v", argv)
	}
}
