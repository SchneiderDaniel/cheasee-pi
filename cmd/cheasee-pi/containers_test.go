package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// stubDockerPS stubs the single runCommandContext seam so docker ps returns
// psOutput (a function of the --filter value) for any enumeration.
func stubDockerPS(t *testing.T, psOutput func(filter string) string) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
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

	got, err := listManagedContainers(context.Background())
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	want := []string{"cheasee-pi-repoA", "cheasee-pi-repoB", "cheasee-pi", "codeflow", "codeflow-repoA"}
	if !slices.Equal(got, want) {
		t.Errorf("listManagedContainers = %v, want %v", got, want)
	}
}

func TestListManagedContainers_psFailureSurfaces(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "ps") {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
		}
		return &mockCmd{}
	})
	if _, err := listManagedContainers(context.Background()); err == nil {
		t.Fatal("docker ps failure must surface")
	}
}

func TestListManagedContainers_includesUI(t *testing.T) {
	// AC4: the `ui` sidecar is compose-managed (com.cheaseepi.managed=true), so
	// the managed-label pass must enumerate it — otherwise `clean` can never
	// reap its orphaned pi children and `down` misses one of the three services.
	stubDockerPS(t, func(filter string) string {
		switch filter {
		case "label=" + managedLabel:
			return "cheasee-pi-repoA\ncheasee-pi-repoA-codeflow\nui-repoA\n"
		}
		return ""
	})

	got, err := listManagedContainers(context.Background())
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	if !slices.Contains(got, "ui-repoA") {
		t.Errorf("listManagedContainers must enumerate the managed ui container, got %v", got)
	}
}

func TestRemoveContainers_failsClosedNamingContainer(t *testing.T) {
	var removed []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && len(arg) > 0 && arg[0] == "rm" {
			removed = append(removed, arg[len(arg)-1])
			if arg[len(arg)-1] == "cheasee-pi-bad" {
				return &mockCmd{combinedFn: func() ([]byte, error) { return nil, fmt.Errorf("container gone") }}
			}
		}
		return &mockCmd{}
	})

	testutil.CaptureStderr(t, func() {
		err := removeContainers(context.Background(), []string{"cheasee-pi-a", "cheasee-pi-bad", "cheasee-pi-c"})
		if err == nil || !strings.Contains(err.Error(), "cheasee-pi-bad") {
			t.Errorf("rm failure must surface naming the container, got %v", err)
		}
	})
	// Fail closed: no removals after the failure.
	if len(removed) != 2 {
		t.Errorf("removal must stop at the first failure, removed %v", removed)
	}
}
