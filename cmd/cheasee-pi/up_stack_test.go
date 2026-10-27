package main

import (
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 1: stack identity table (entity)
// ──────────────────────────────────────────────

func TestStackServices_derivedIdentity(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")

	got := stackServices(root)
	want := []stackService{
		{"cheasee-pi", containerName(root), cheaseeImageRef(root)},
		{"codeflow", codeflowContainerName(root), codeflowImageRef(root)},
		{"ui", uiContainerName(root), uiImageRef(root)},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("stackServices = %v, want %v (order agent → codeflow → ui)", got, want)
	}
}

func TestStackServices_longSlugUsesProjectCap(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/"+strings.Repeat("a", 60)+".git")

	got := stackServices(root)
	project := composeProjectName(root)
	if got[1].image != project+"-codeflow" {
		t.Errorf("codeflow image = %q, want %q", got[1].image, project+"-codeflow")
	}
	if got[2].image != project+"-ui" {
		t.Errorf("ui image = %q, want %q", got[2].image, project+"-ui")
	}
	// Image refs carry the 43-char project cap, container names the 52/54-char
	// cap — an over-long slug must not make them collide by accident.
	if got[1].image == got[1].container {
		t.Errorf("codeflow image and container must differ, both %q", got[1].image)
	}
	if got[2].image == got[2].container {
		t.Errorf("ui image and container must differ, both %q", got[2].image)
	}
}

func TestStackServices_deterministic(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")

	if a, b := stackServices(root), stackServices(root); !slices.Equal(a, b) {
		t.Errorf("stackServices must be order-stable, got %v then %v", a, b)
	}
}

// ──────────────────────────────────────────────
// Phase 2: planner policy (pure, no docker)
// ──────────────────────────────────────────────

func TestPlanStack(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	services := stackServices(root)
	agent, codeflow, ui := services[0], services[1], services[2]

	allRunning := map[string]string{agent.container: "running", codeflow.container: "running", ui.container: "running"}
	present := map[string]bool{agent.image: true, codeflow.image: true, ui.image: true}

	cases := []struct {
		name       string
		states     map[string]string
		images     map[string]bool
		start      []stackService
		create     []stackService
		build      []stackService
		firstBuild bool
	}{
		{
			name:   "all running",
			states: allRunning,
			images: present,
		},
		{
			name:   "all stopped",
			states: map[string]string{agent.container: "exited", codeflow.container: "exited", ui.container: "exited"},
			images: present,
			start:  []stackService{agent, codeflow, ui},
		},
		{
			name:   "agent running, codeflow exited, ui missing with image present",
			states: map[string]string{agent.container: "running", codeflow.container: "exited"},
			images: map[string]bool{ui.image: true},
			start:  []stackService{codeflow},
			create: []stackService{ui},
		},
		{
			name:   "empty states create whole stack from present images",
			states: map[string]string{},
			images: present,
			create: []stackService{agent, codeflow, ui},
		},
		{
			name:       "nothing exists, no images",
			states:     nil,
			images:     nil,
			create:     []stackService{agent, codeflow, ui},
			build:      []stackService{agent, codeflow, ui},
			firstBuild: true,
		},
		{
			name:   "nothing exists, agent + codeflow images present",
			states: nil,
			images: map[string]bool{agent.image: true, codeflow.image: true},
			create: []stackService{agent, codeflow, ui},
			build:  []stackService{ui},
		},
		{
			name:   "nothing exists, all images present",
			states: nil,
			images: present,
			create: []stackService{agent, codeflow, ui},
		},
		{
			name:   "agent container present but agent image absent",
			states: allRunning,
			images: map[string]bool{},
		},
		{
			name:   "foreign container names are ignored",
			states: map[string]string{"cheasee-pi-other": "running", "codeflow-other": "exited", agent.container: "running", codeflow.container: "running", ui.container: "running"},
			images: present,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := planStack(services, tc.states, tc.images)
			if !slices.Equal(plan.start, tc.start) {
				t.Errorf("start = %v, want %v", plan.start, tc.start)
			}
			if !slices.Equal(plan.create, tc.create) {
				t.Errorf("create = %v, want %v", plan.create, tc.create)
			}
			if !slices.Equal(plan.build, tc.build) {
				t.Errorf("build = %v, want %v", plan.build, tc.build)
			}
			if plan.firstBuild != tc.firstBuild {
				t.Errorf("firstBuild = %v, want %v", plan.firstBuild, tc.firstBuild)
			}
			// An existing container is never created and vice versa.
			for _, s := range plan.create {
				if slices.ContainsFunc(plan.start, func(x stackService) bool { return x.container == s.container }) {
					t.Errorf("%s both started and created", s.container)
				}
			}
			// Only container creation builds: build ⊆ create.
			for _, s := range plan.build {
				if !slices.Contains(plan.create, s) {
					t.Errorf("build %s is not in create %v", s.service, plan.create)
				}
			}
		})
	}
}

func TestPlanStack_existingContainerStatesAlwaysStart(t *testing.T) {
	parent, root := mkWorkspace(t, `{}`)
	writeBareRemote(t, parent, "https://github.com/alice/foo.git")
	services := stackServices(root)

	for _, state := range []string{"created", "dead", "paused", "restarting", "exited", "stopped"} {
		plan := planStack(services, map[string]string{services[0].container: state}, nil)
		if !slices.Equal(plan.start, []stackService{services[0]}) {
			t.Errorf("state %q: start = %v, want the existing agent container", state, plan.start)
		}
		if len(plan.create) != 2 {
			t.Errorf("state %q: create = %v, want the 2 missing sidecars", state, plan.create)
		}
		for _, s := range plan.create {
			if s.container == services[0].container {
				t.Errorf("state %q: existing container must never be re-created", state)
			}
		}
	}
}
