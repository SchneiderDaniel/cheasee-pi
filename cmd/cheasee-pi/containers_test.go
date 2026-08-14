package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// stubDockerPS stubs the execCommand seam so docker ps returns psOutput
// (a function of the --filter value) for any enumeration.
func stubDockerPS(t *testing.T, psOutput func(filter string) string) {
	t.Helper()
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name != "docker" || !slices.Contains(arg, "ps") {
			return &mockCmd{}
		}
		filter := ""
		for i, a := range arg {
			if a == "--filter" && i+1 < len(arg) {
				filter = arg[i+1]
			}
		}
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte(psOutput(filter)), nil }}
	})
}

func TestManagedLabel_const(t *testing.T) {
	if managedLabel != "com.cheaseepi.managed=true" {
		t.Errorf("managedLabel = %q", managedLabel)
	}
}

func TestListManagedContainers_labelUnionLegacyDedup(t *testing.T) {
	stubDockerPS(t, func(filter string) string {
		switch filter {
		case "label=" + managedLabel:
			return "cheasee-pi-repoA\ncheasee-pi-repoB\n"
		case "name=cheasee-pi":
			// Substring filter also matches foreign containers — the Go
			// post-filter must reject them.
			return "cheasee-pi\ncheasee-pi-repoA\nmy-cheasee-pi\nnotcheasee-pi\nx-cheasee-pi-1\n"
		case "name=codeflow":
			return "codeflow\ncodeflow-repoA\nmy-codeflow\n"
		}
		return ""
	})

	got, err := listManagedContainers()
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	want := []string{"cheasee-pi-repoA", "cheasee-pi-repoB", "cheasee-pi", "codeflow", "codeflow-repoA"}
	if !slices.Equal(got, want) {
		t.Errorf("listManagedContainers = %v, want %v", got, want)
	}
}

func TestListManagedContainers_psFailureSurfaces(t *testing.T) {
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	if _, err := listManagedContainers(); err == nil {
		t.Fatal("docker ps failure must surface")
	}
}

func TestIsLegacyContainerName_postFilter(t *testing.T) {
	cases := map[string]bool{
		"cheasee-pi":      true,
		"cheasee-pi-repo": true,
		"codeflow":        true,
		"codeflow-repo":   true,
		"my-cheasee-pi":   false,
		"notcheasee-pi":   false,
		"x-cheasee-pi-1":  false,
		"my-codeflow":     false,
		"":                false,
	}
	for name, want := range cases {
		if got := isLegacyContainerName(name); got != want {
			t.Errorf("isLegacyContainerName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestContainerRunning_exactMatchNotSubstring(t *testing.T) {
	// `--filter name=cheasee-pi-foo` also matches cheasee-pi-foo-bar
	// (substring) — the line-exact compare must report false.
	stubExecCommand(t, func(_ string, _ ...string) cmdIface {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-foo-bar\n"), nil }}
	})
	ok, err := containerRunning("cheasee-pi-foo")
	if err != nil || ok {
		t.Errorf("cheasee-pi-foo must not count as running when only cheasee-pi-foo-bar exists: ok=%v err=%v", ok, err)
	}
}

func TestContainerRunning_multilineMatchesExact(t *testing.T) {
	stubExecCommand(t, func(_ string, _ ...string) cmdIface {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("cheasee-pi-foo\ncheasee-pi-foo-bar\n"), nil
		}}
	})
	ok, err := containerRunning("cheasee-pi-foo")
	if err != nil || !ok {
		t.Errorf("exact line in multi-line output must count as running: ok=%v err=%v", ok, err)
	}
}

func TestContainerRunning_psFailureSurfaces(t *testing.T) {
	stubExecCommand(t, func(_ string, _ ...string) cmdIface {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	if _, err := containerRunning("cheasee-pi"); err == nil {
		t.Error("docker ps failure must surface")
	}
}

func TestRemoveContainers_failsClosedNamingContainer(t *testing.T) {
	var removed []string
	stubExecCommand(t, func(name string, arg ...string) cmdIface {
		if name == "docker" && len(arg) > 0 && arg[0] == "rm" {
			removed = append(removed, arg[len(arg)-1])
			if arg[len(arg)-1] == "cheasee-pi-bad" {
				return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("container gone") }}
			}
		}
		return &mockCmd{}
	})

	testutil.CaptureStderr(t, func() {
		err := removeContainers([]string{"cheasee-pi-a", "cheasee-pi-bad", "cheasee-pi-c"})
		if err == nil || !strings.Contains(err.Error(), "cheasee-pi-bad") {
			t.Errorf("rm failure must surface naming the container, got %v", err)
		}
	})
	// Fail closed: no removals after the failure.
	if len(removed) != 2 {
		t.Errorf("removal must stop at the first failure, removed %v", removed)
	}
}

func TestProjectContainers_usesProjectLabel(t *testing.T) {
	var seenFilter string
	stubDockerPS(t, func(filter string) string {
		seenFilter = filter
		return "cheasee-pi-alice-foo\n"
	})
	got, err := projectContainers("cheasee-pi-alice-foo")
	if err != nil || len(got) != 1 || got[0] != "cheasee-pi-alice-foo" {
		t.Errorf("projectContainers = %v, err %v", got, err)
	}
	if seenFilter != "label=com.docker.compose.project=cheasee-pi-alice-foo" {
		t.Errorf("projectContainers must filter by the compose project label, got %q", seenFilter)
	}
}
