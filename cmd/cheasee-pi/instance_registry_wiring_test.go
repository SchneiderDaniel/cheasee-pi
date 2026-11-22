package main

import (
	"context"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

// ──────────────────────────────────────────────
// Phase 5 (cont.): the start → registry wiring
//
// The registry unit tests above drive recordInstance with a container name the
// test names itself. This file pins the JOIN: what `cheasee-pi start` passes in.
// `--name` renames the agent container, so a run that registered the derived
// name would leave a live instance unprobeable by every sidecar on the host —
// the reported bug, one flag away (#2155 audit finding 2).
// ──────────────────────────────────────────────

// startAndRecord runs one non-dry-run start against a fully stubbed stack and
// returns the workspace root plus the agent container name the run recorded.
func startAndRecord(t *testing.T, name string) (root, agentContainer string) {
	t.Helper()
	_, root = mkWorkspace(t, `{}`)
	// setUpRunMode pins XDG_CACHE_HOME (the registry lives under it); stubUpFlow
	// stubs the docker seams and stubExecPIContainer keeps the final
	// `docker exec pi` off a real daemon.
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	stubUpFlow(t, root, true)

	testutil.CaptureStderr(t, func() {
		opts := startOptions{Workdir: root, Name: name}
		if err := startSession(context.Background(), opts); err != nil {
			t.Fatalf("startSession(%q): %v", name, err)
		}
	})

	reg, err := hostInstanceRegistry()
	discoveryRequireNoErr(t, "hostInstanceRegistry", err)
	records, err := reg.List()
	discoveryRequireNoErr(t, "List", err)
	if len(records) != 1 {
		t.Fatalf("registry = %+v, want exactly this workspace's record", records)
	}
	if records[0].Key != instanceKey(root) {
		t.Errorf("recorded key = %q, want this workspace's %q", records[0].Key, instanceKey(root))
	}
	return root, records[0].AgentContainer
}

// TestDiscovery_startRecordsTheExplicitContainerName is the `--name` case: the
// effective name, never the derived default.
func TestDiscovery_startRecordsTheExplicitContainerName(t *testing.T) {
	root, got := startAndRecord(t, "custom-agent")
	if got != "custom-agent" {
		t.Errorf("agentContainer = %q, want the name the run used (--name custom-agent), not the derived %q", got, containerName(root))
	}
}

// TestDiscovery_startRecordsTheDerivedContainerName is the default case: an
// unset --name must record the container the stack was actually given.
func TestDiscovery_startRecordsTheDerivedContainerName(t *testing.T) {
	root, got := startAndRecord(t, "")
	if want := containerName(root); got != want {
		t.Errorf("agentContainer = %q, want the derived default %q", got, want)
	}
}
