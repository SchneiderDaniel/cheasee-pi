package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

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
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("cheasee-pi-foo-bar\n"), nil }}
	})
	ok, err := containerRunning(context.Background(), "cheasee-pi-foo")
	if err != nil || ok {
		t.Errorf("cheasee-pi-foo must not count as running when only cheasee-pi-foo-bar exists: ok=%v err=%v", ok, err)
	}
}

func TestContainerRunning_multilineMatchesExact(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) {
			return []byte("cheasee-pi-foo\ncheasee-pi-foo-bar\n"), nil
		}}
	})
	ok, err := containerRunning(context.Background(), "cheasee-pi-foo")
	if err != nil || !ok {
		t.Errorf("exact line in multi-line output must count as running: ok=%v err=%v", ok, err)
	}
}

func TestContainerRunning_psFailureSurfaces(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon down") }}
	})
	if _, err := containerRunning(context.Background(), "cheasee-pi"); err == nil {
		t.Error("docker ps failure must surface")
	}
}

func TestProjectContainers_usesProjectLabel(t *testing.T) {
	var seenFilter string
	stubDockerPS(t, func(filter string) string {
		seenFilter = filter
		return "cheasee-pi-alice-foo\n"
	})
	got, err := projectContainers(context.Background(), "cheasee-pi-alice-foo")
	if err != nil || len(got) != 1 || got[0] != "cheasee-pi-alice-foo" {
		t.Errorf("projectContainers = %v, err %v", got, err)
	}
	if seenFilter != "label=com.docker.compose.project=cheasee-pi-alice-foo" {
		t.Errorf("projectContainers must filter by the compose project label, got %q", seenFilter)
	}
}

// TestListManagedContainers_uiByLabelNeverName (AC4) pins the documented
// invariant: clean enumerates by `label=com.cheaseepi.managed=true`, never by
// `--filter name=` (substring semantics). The ui sidecar must be reachable
// through the label pass alone.

func TestListManagedContainers_uiByLabelNeverName(t *testing.T) {
	var filters []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" || !slices.Contains(arg, "ps") {
			return &mockCmd{}
		}
		current := ""
		for i, a := range arg {
			if a == "--filter" && i+1 < len(arg) {
				current = arg[i+1]
				filters = append(filters, current)
			}
		}
		return &mockCmd{outputFn: func() ([]byte, error) {
			if current == "label="+managedLabel {
				return []byte("ui-repoA\n"), nil
			}
			return []byte(""), nil
		}}
	})

	got, err := listManagedContainers(context.Background())
	if err != nil {
		t.Fatalf("listManagedContainers: %v", err)
	}
	if !slices.Contains(got, "ui-repoA") {
		t.Errorf("ui container must be enumerated by the managed label, got %v", got)
	}
	if !slices.Contains(filters, "label="+managedLabel) {
		t.Errorf("enumeration must filter by the managed label, got %v", filters)
	}
	for _, f := range filters {
		if strings.Contains(f, "name=ui-") {
			t.Errorf("ui must never be enumerated by a name substring filter, got %q", f)
		}
	}
}
