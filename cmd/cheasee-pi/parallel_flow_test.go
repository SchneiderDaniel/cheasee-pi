package main

import (
	"slices"
	"strconv"
	"testing"

	"github.com/spf13/cobra"
)

// TestRunUpE_parallelWorkspacesDoNotInterfere — two repos on one host start
// side by side: distinct compose projects and distinct container names, so
// ws2's up can never recreate ws1's container (the recreate-on-config-change
// path is label-scoped per project).
func TestRunUpE_parallelWorkspacesDoNotInterfere(t *testing.T) {
	parentA, rootA := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentA, "https://github.com/alice/repo-a.git")
	parentB, rootB := mkWorkspace(t, `{}`)
	writeBareRemote(t, parentB, "https://github.com/bob/repo-b.git")

	setUpRunMode(t, rootA, false)
	stubExecPIContainer(t)
	cA := stubUpFlow(t, rootA, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE ws1: %v", err)
	}

	setUpRunMode(t, rootB, false)
	stubExecPIContainer(t)
	cB := stubUpFlow(t, rootB, false)
	if err := runUpE(&cobra.Command{}, nil); err != nil {
		t.Fatalf("runUpE ws2: %v", err)
	}

	upEnvA := cA.composeCmds[1].env
	upEnvB := cB.composeCmds[1].env
	buildEnvA := cA.composeCmds[0].env
	buildEnvB := cB.composeCmds[0].env

	projectA := composeEnvValue(upEnvA, "COMPOSE_PROJECT_NAME")
	projectB := composeEnvValue(upEnvB, "COMPOSE_PROJECT_NAME")
	if projectA == "" || projectB == "" {
		t.Fatalf("compose project names missing: A=%q B=%q", projectA, projectB)
	}
	if projectA == projectB {
		t.Errorf("parallel workspaces must get distinct compose projects, both %q", projectA)
	}
	// Same project on build and up within one workspace (label scoping holds).
	if got := composeEnvValue(buildEnvA, "COMPOSE_PROJECT_NAME"); got != projectA {
		t.Errorf("ws1 build project %q != up project %q", got, projectA)
	}
	if got := composeEnvValue(buildEnvB, "COMPOSE_PROJECT_NAME"); got != projectB {
		t.Errorf("ws2 build project %q != up project %q", got, projectB)
	}
	// Distinct derived container names per workspace.
	if !slices.Contains(upEnvA, "CHEASEEPI_CONTAINER=cheasee-pi-alice-repo-a") {
		t.Errorf("ws1 env must carry its derived container, got %v", upEnvA)
	}
	if !slices.Contains(upEnvB, "CHEASEEPI_CONTAINER=cheasee-pi-bob-repo-b") {
		t.Errorf("ws2 env must carry its derived container, got %v", upEnvB)
	}
	// Both envs carry a numeric CodeFlow port in the derived range.
	for _, env := range [][]string{upEnvA, upEnvB} {
		p := composeEnvValue(env, "CODEFLOW_PORT")
		n, err := strconv.Atoi(p)
		if err != nil || n < codeflowPortBase || n >= codeflowPortBase+codeflowPortRange {
			t.Errorf("CODEFLOW_PORT must be numeric in [8470, 9493], got %q", p)
		}
	}
}
