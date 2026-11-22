package main

import (
	"context"
	"slices"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3 (cont.): ensureStackUp probes and never mutates on a failed check
// ──────────────────────────────────────────────

func TestDiscovery_planStackNilMapsDoNotPanic(t *testing.T) {
	_, services := mountFixture(t)
	plan, err := planStack(services, nil, nil, nil)
	discoveryRequireNoErr(t, "nil maps must plan a fresh stack", err)
	if !slices.Equal(plan.create, services) {
		t.Errorf("create = %v, want the whole stack", plan.create)
	}
	if !plan.firstBuild {
		t.Error("nil images means nothing is present: the agent build is the first build")
	}
}

func TestDiscovery_ensureStackUpProbesMountsOnce(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = allStackStates(root, "running")

	discoveryRequireNoErr(t, "ensureStackUp", ensureStackUp(context.Background(), cacheDir, root, name))
	if c.mountProbes != 1 {
		t.Fatalf("mount probes = %d, want exactly 1", c.mountProbes)
	}
	argv := c.mountArgv[0]
	if !slices.Contains(argv, "inspect") {
		t.Errorf("mount probe must use docker inspect, got %v", argv)
	}
	if !slices.Contains(argv, containerMountProbeFormat) {
		t.Errorf("mount probe must ask for the workspace mount source, got %v", argv)
	}
	for _, s := range services {
		if !slices.Contains(argv, s.container) {
			t.Errorf("mount probe must include %q, got %v", s.container, argv)
		}
	}
	if len(c.starts) != 0 {
		t.Errorf("running containers must not be started, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("a running stack must not invoke compose, got %v", c.composeArgs)
	}
}

func TestDiscovery_ensureStackUpMountMismatchMutatesNothing(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = allStackStates(root, "exited")
	c.mounts = map[string]string{services[2].container: root + "-sibling"}

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a mismatched mount must abort the start, got nil error")
	}
	if len(c.starts) != 0 {
		t.Errorf("no container may be started after a failed verification, got %v", c.starts)
	}
	discoveryRequireNoComposeUp(t, c)
	discoveryRequireContains(t, "mismatch error", err.Error(), "cheasee-pi down")
}

// discoveryRequireNoComposeUp asserts no compose create/build ran after a
// failed verification.
func discoveryRequireNoComposeUp(t *testing.T, c *upCapture) {
	t.Helper()
	for _, argv := range c.composeArgs {
		if slices.Contains(argv, "up") || slices.Contains(argv, "build") {
			t.Errorf("no compose up/build may run after a failed verification, got %v", argv)
		}
	}
}

func TestDiscovery_ensureStackUpMountProbeErrorAborts(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.states = allStackStates(root, "running")
	c.mountErr = errDaemonGone

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failing mount probe must abort the start, got nil error")
	}
	discoveryRequireContains(t, "probe-failure error", err.Error(), "docker inspect:")
	if len(c.starts) != 0 {
		t.Errorf("no container may be started when liveness is unknown, got %v", c.starts)
	}
	if len(c.composeArgs) != 0 {
		t.Errorf("compose must not run when liveness is unknown, got %v", c.composeArgs)
	}
}

func TestDiscovery_ensureStackUpStoppedWithMatchingMountStartsOnce(t *testing.T) {
	// Regression guard: the mount check must not disable container reuse.
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = allStackStates(root, "exited")

	discoveryRequireNoErr(t, "ensureStackUp", ensureStackUp(context.Background(), cacheDir, root, name))
	want := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, want) {
		t.Errorf("starts = %v, want %v (exactly once per stopped service)", c.starts, want)
	}
}
