package main

import (
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

// statesFor maps every listed container onto state.
func statesFor(services []stackService, state string) map[string]string {
	return mountsFor(services, state)
}

// discoveryRequireZeroPlan asserts a failed plan carries nothing to act on.
func discoveryRequireZeroPlan(t *testing.T, plan stackPlan) {
	t.Helper()
	if plan.start != nil || plan.create != nil || plan.build != nil || plan.firstBuild {
		t.Errorf("a failed plan must be zero-valued so nothing starts or is created, got %+v", plan)
	}
}

func TestDiscovery_planStackMatchingMountKeepsPlan(t *testing.T) {
	root, services := mountFixture(t)

	plan, err := planStack(services, statesFor(services, "running"), mountsFor(services, root), nil)
	discoveryRequireNoErr(t, "planStack with matching mounts", err)
	if len(plan.start) != 0 || len(plan.create) != 0 || len(plan.build) != 0 {
		t.Errorf("running stack must plan nothing, got %+v", plan)
	}

	plan, err = planStack(services, statesFor(services, "exited"), mountsFor(services, root), nil)
	discoveryRequireNoErr(t, "planStack with matching mounts", err)
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
	ui := services[2]
	mounts := mountsFor(services, root)
	mounts[ui.container] = other

	plan, err := planStack(services, statesFor(services, "running"), mounts, nil)
	if err == nil {
		t.Fatalf("a container bound to %q must be refused for %q, got nil error", other, root)
	}
	discoveryRequireZeroPlan(t, plan)
	discoveryRequireContains(t, "mismatch error", err.Error(), ui.container, root, other, "cheasee-pi down")
}

func TestDiscovery_planStackUnverifiableMountFailsClosed(t *testing.T) {
	_, services := mountFixture(t)
	agent := services[0]

	// Present on the host, but the probe could not report its mount: "cannot
	// verify" must never read as "verified".
	plan, err := planStack(services, map[string]string{agent.container: "running"}, map[string]string{}, nil)
	if err == nil {
		t.Fatal("an existing container with no reported mount must fail closed")
	}
	discoveryRequireZeroPlan(t, plan)
	discoveryRequireContains(t, "unverifiable-mount error", err.Error(), agent.container)
}

func TestDiscovery_planStackMountlessContainerFailsClosed(t *testing.T) {
	// A container that reports no workspace mount at all (created by hand, or by
	// a stack whose mount was renamed) is never a candidate for reuse.
	_, services := mountFixture(t)
	agent := services[0]

	plan, err := planStack(services, map[string]string{agent.container: "running"},
		map[string]string{agent.container: ""}, nil)
	if err == nil {
		t.Fatal("a container without a workspace mount must fail closed")
	}
	discoveryRequireZeroPlan(t, plan)
	discoveryRequireContains(t, "mountless-container error", err.Error(), agent.container, workspaceMountTarget, "cheasee-pi down")
}

func TestDiscovery_planStackTrailingSlashMountIsEqual(t *testing.T) {
	root, services := mountFixture(t)
	states := statesFor(services, "running")
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
	discoveryRequireNoErr(t, "absent containers must not be verified", err)
	if !slices.Equal(plan.create, services) {
		t.Errorf("create = %v, want the whole stack", plan.create)
	}
}
