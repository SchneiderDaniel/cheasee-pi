package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 3: mount-source verification of reused containers
//
// The second half of the reported bug: `up` reused ANY existing container with
// the derived name and only ran `docker start`. A container created by another
// worktree is bound to THAT worktree's host path, so the new worktree's
// sessions were invisible. A reused container must prove it is bound to this
// workspace, or `up` must fail closed before it mutates anything.
// ──────────────────────────────────────────────

// mountFixture is one workspace plus its derived stack table.
func mountFixture(t *testing.T) (root string, services []stackService) {
	t.Helper()
	_, roots := discoverySiblings(t, 1, "https://github.com/alice/foo.git")
	root = roots[0]
	return root, stackServices(root)
}

// mountsFor maps every listed container onto source.
func mountsFor(services []stackService, source string) map[string]string {
	mounts := make(map[string]string, len(services))
	for _, s := range services {
		mounts[s.container] = source
	}
	return mounts
}

func TestDiscovery_planStackMatchingMountKeepsPlan(t *testing.T) {
	root, services := mountFixture(t)

	running := map[string]string{}
	for _, s := range services {
		running[s.container] = "running"
	}
	plan, err := planStack(services, running, mountsFor(services, root), nil)
	if err != nil {
		t.Fatalf("planStack with matching mounts: %v", err)
	}
	if len(plan.start) != 0 || len(plan.create) != 0 || len(plan.build) != 0 {
		t.Errorf("running stack must plan nothing, got %+v", plan)
	}

	stopped := map[string]string{}
	for _, s := range services {
		stopped[s.container] = "exited"
	}
	plan, err = planStack(services, stopped, mountsFor(services, root), nil)
	if err != nil {
		t.Fatalf("planStack with matching mounts: %v", err)
	}
	if !slices.Equal(plan.start, services) {
		t.Errorf("start = %v, want every stopped container in stack order", plan.start)
	}
	if len(plan.create) != 0 || len(plan.build) != 0 {
		t.Errorf("existing containers must never be created or built, got %+v", plan)
	}
}

func TestDiscovery_planStackMountMismatchFailsClosed(t *testing.T) {
	root, services := mountFixture(t)
	other := root + "-other-worktree"

	mounts := mountsFor(services, root)
	ui := services[2]
	mounts[ui.container] = other

	states := map[string]string{}
	for _, s := range services {
		states[s.container] = "running"
	}

	plan, err := planStack(services, states, mounts, nil)
	if err == nil {
		t.Fatalf("a container bound to %q must be refused for %q, got nil error", other, root)
	}
	if plan.start != nil || plan.create != nil || plan.build != nil || plan.firstBuild {
		t.Errorf("a failed plan must be zero-valued so nothing starts or is created, got %+v", plan)
	}
	for _, want := range []string{ui.container, root, other, "cheasee-pi down"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("mismatch error must name %q, got %q", want, err.Error())
		}
	}
}

func TestDiscovery_planStackUnverifiableMountFailsClosed(t *testing.T) {
	_, services := mountFixture(t)
	agent := services[0]

	// Present on the host, but the probe could not report its mount: "cannot
	// verify" must never read as "verified".
	plan, err := planStack(services, map[string]string{agent.container: "running"}, map[string]string{}, nil)
	if err == nil {
		t.Fatalf("an existing container with no reported mount must fail closed")
	}
	if plan.start != nil || plan.create != nil {
		t.Errorf("a failed plan must be zero-valued, got %+v", plan)
	}
	if !strings.Contains(err.Error(), agent.container) {
		t.Errorf("error must name the container %q, got %q", agent.container, err.Error())
	}
}

func TestDiscovery_planStackMountlessContainerFailsClosed(t *testing.T) {
	// A container that reports no workspace mount at all (created by hand, or by
	// a stack whose mount was renamed) is never a candidate for reuse.
	_, services := mountFixture(t)
	agent := services[0]

	plan, err := planStack(services, map[string]string{agent.container: "running"}, map[string]string{agent.container: ""}, nil)
	if err == nil {
		t.Fatal("a container without a workspace mount must fail closed")
	}
	if plan.start != nil || plan.create != nil {
		t.Errorf("a failed plan must be zero-valued, got %+v", plan)
	}
	for _, want := range []string{agent.container, workspaceMountTarget, "cheasee-pi down"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error must name %q, got %q", want, err.Error())
		}
	}
}

func TestDiscovery_planStackTrailingSlashMountIsEqual(t *testing.T) {
	root, services := mountFixture(t)
	states := map[string]string{}
	for _, s := range services {
		states[s.container] = "running"
	}
	if _, err := planStack(services, states, mountsFor(services, filepathSlash(root)), nil); err != nil {
		t.Errorf("a trailing-slash mount source must compare equal: %v", err)
	}
}

// filepathSlash spells dir with exactly one trailing separator.
func filepathSlash(dir string) string {
	return strings.TrimRight(dir, "/") + "/"
}

func TestDiscovery_planStackAbsentContainersNeedNoMount(t *testing.T) {
	_, services := mountFixture(t)
	plan, err := planStack(services, map[string]string{}, map[string]string{}, nil)
	if err != nil {
		t.Fatalf("absent containers must not be verified: %v", err)
	}
	if !slices.Equal(plan.create, services) {
		t.Errorf("create = %v, want the whole stack", plan.create)
	}
}

func TestDiscovery_planStackNilMapsDoNotPanic(t *testing.T) {
	_, services := mountFixture(t)
	plan, err := planStack(services, nil, nil, nil)
	if err != nil {
		t.Fatalf("nil maps must plan a fresh stack: %v", err)
	}
	if !slices.Equal(plan.create, services) {
		t.Errorf("create = %v, want the whole stack", plan.create)
	}
	if !plan.firstBuild {
		t.Error("nil images means nothing is present: the agent build is the first build")
	}
}

// ──────────────────────────────────────────────
// Adapter: ensureStackUp probe behaviour
// ──────────────────────────────────────────────

func TestDiscovery_ensureStackUpProbesMountsOnce(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = allStackStates(root, "running")

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
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
	for _, argv := range c.composeArgs {
		if slices.Contains(argv, "up") || slices.Contains(argv, "build") {
			t.Errorf("no compose up/build may run after a failed verification, got %v", argv)
		}
	}
	if !strings.Contains(err.Error(), "cheasee-pi down") {
		t.Errorf("error must tell the operator how to recover, got %q", err.Error())
	}
}

func TestDiscovery_ensureStackUpMountProbeErrorAborts(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.states = allStackStates(root, "running")
	c.mountErr = fmt.Errorf("daemon gone")

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failing mount probe must abort the start, got nil error")
	}
	if !strings.Contains(err.Error(), "docker inspect:") && !strings.Contains(err.Error(), "docker ps:") {
		t.Errorf("error must wrap the probe failure, got %q", err.Error())
	}
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

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	want := []string{services[0].container, services[1].container, services[2].container}
	if !slices.Equal(c.starts, want) {
		t.Errorf("starts = %v, want %v (exactly once per stopped service)", c.starts, want)
	}
}
