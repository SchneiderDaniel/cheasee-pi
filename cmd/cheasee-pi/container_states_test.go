package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3: container state probe (adapter)
// ──────────────────────────────────────────────

// stubPSOnce installs a docker seam answering every call with output/err and
// recording the argv of each invocation.
func stubPSOnce(t *testing.T, output string, err error) *[][]string {
	t.Helper()
	calls := &[][]string{}
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		*calls = append(*calls, append([]string{name}, arg...))
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte(output), err }}
	})
	return calls
}

func TestContainerStates_singlePSProbe(t *testing.T) {
	calls := stubPSOnce(t, "", nil)

	if _, err := containerStates(context.Background(), []string{"cheasee-pi-a"}); err != nil {
		t.Fatalf("containerStates: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("state probe must be one docker call, got %d: %v", len(*calls), *calls)
	}
	got := (*calls)[0]
	want := []string{"docker", "ps", "-a", "--format", "{{.Names}}|{{.State}}"}
	if !slices.Equal(got, want) {
		t.Errorf("argv = %v, want %v (no --filter: the probe post-filters in Go)", got, want)
	}
}

func TestContainerStates_parsesRequestedNames(t *testing.T) {
	stubPSOnce(t, "cheasee-pi-a|running\ncodeflow-a|exited\nui-a|created\n", nil)

	got, err := containerStates(context.Background(), []string{"cheasee-pi-a", "codeflow-a"})
	if err != nil {
		t.Fatalf("containerStates: %v", err)
	}
	want := map[string]string{"cheasee-pi-a": "running", "codeflow-a": "exited"}
	if len(got) != len(want) {
		t.Fatalf("states = %v, want %v (ui-a was not requested)", got, want)
	}
	for name, state := range want {
		if got[name] != state {
			t.Errorf("state[%q] = %q, want %q", name, got[name], state)
		}
	}
}

func TestContainerStates_exactNameOnly(t *testing.T) {
	stubPSOnce(t, "cheasee-pi-ab|running\n", nil)

	got, err := containerStates(context.Background(), []string{"cheasee-pi-a"})
	if err != nil {
		t.Fatalf("containerStates: %v", err)
	}
	if _, ok := got["cheasee-pi-a"]; ok {
		t.Errorf("cheasee-pi-ab must never answer for cheasee-pi-a, got %v", got)
	}
}

func TestContainerStates_emptyOutputIsEmptyMap(t *testing.T) {
	stubPSOnce(t, "", nil)

	got, err := containerStates(context.Background(), []string{"cheasee-pi-a", "codeflow-a"})
	if err != nil {
		t.Fatalf("containerStates: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("no containers → empty map, got %v", got)
	}
}

func TestContainerStates_skipsMalformedAndKeepsLastDuplicate(t *testing.T) {
	stubPSOnce(t, "garbage-without-separator\ncheasee-pi-a|running\ncheasee-pi-a|exited\n\n", nil)

	got, err := containerStates(context.Background(), []string{"cheasee-pi-a"})
	if err != nil {
		t.Fatalf("containerStates: %v", err)
	}
	if len(got) != 1 || got["cheasee-pi-a"] != "exited" {
		t.Errorf("states = %v, want a single cheasee-pi-a=exited entry (last line wins)", got)
	}
}

func TestContainerStates_daemonErrorFailsClosed(t *testing.T) {
	stubPSOnce(t, "", fmt.Errorf("daemon gone"))

	got, err := containerStates(context.Background(), []string{"cheasee-pi-a"})
	if err == nil || !strings.Contains(err.Error(), "docker ps:") {
		t.Fatalf("probe error must wrap 'docker ps:', got %v", err)
	}
	if got != nil {
		t.Errorf("a failed probe must never read as all-missing, got %v", got)
	}
}
