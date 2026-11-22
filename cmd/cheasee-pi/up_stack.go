package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// stackService is one service of the cheasee-pi compose stack: the compose
// service key, the derived container name, the derived image ref and the host
// path the service must be bound to (`mount`, the workspace host path — the
// reuse guard compares it against the container's actual source).
type stackService struct {
	service   string
	container string
	image     string
	mount     string
}

// stackServices is the single ordered table of services the start flow
// manages: agent → codeflow → ui. Extending the stack is a row here, not a new
// call site. Container names carry the 52/54-char slug cap while image refs
// carry the 43-char compose-project cap, so the two are never interchangeable.
func codeflowImageRef(workspaceRoot string) string {
	return composeProjectName(workspaceRoot) + "-codeflow"
}

func uiImageRef(workspaceRoot string) string {
	return composeProjectName(workspaceRoot) + "-ui"
}

func stackServices(root string) []stackService {
	return []stackService{
		{"cheasee-pi", containerName(root), cheaseeImageRef(root), root},
		{"codeflow", codeflowContainerName(root), codeflowImageRef(root), root},
		{"ui", uiContainerName(root), uiImageRef(root), root},
	}
}

// stackPlan is the reconcile decision for one normal start: which existing
// containers to start, which missing containers to create, which absent images
// to build (always a subset of create) and whether the agent image is being
// built for the first time (drives the ~1GB download notice).
type stackPlan struct {
	start      []stackService
	create     []stackService
	build      []stackService
	firstBuild bool
}

// planStack classifies every service from the probed container states, the
// mount sources of the containers that already exist, and the presence of the
// images Compose would need to create a container. Existing containers are only
// ever started — stale Compose config is deliberately left alone
// (reconciliation is out of scope) — but a container that exists is reused ONLY
// when its workspace mount source is this workspace's path. A mismatch (another
// worktree's container) or an unverifiable mount fails closed with a
// zero-valued plan, so nothing is started, built or created before the operator
// recovers.
//
// Pure: no docker, no I/O.
func planStack(services []stackService, states, mounts map[string]string, images map[string]bool) (stackPlan, error) {
	var plan stackPlan
	for _, s := range services {
		if state, exists := states[s.container]; exists {
			found, verified := mounts[s.container]
			// "Cannot verify" must never read as "verified": a missing mount
			// entry means the probe could not report the source.
			if !verified {
				return stackPlan{}, fmt.Errorf("container %s exists but its workspace mount could not be verified — refusing to reuse it; run `cheasee-pi down` in this workspace and `cheasee-pi start` again", s.container)
			}
			if filepath.Clean(found) != filepath.Clean(s.mount) {
				if found == "" {
					return stackPlan{}, fmt.Errorf("container %s has no %s mount — refusing to reuse it; run `cheasee-pi down` in this workspace and `cheasee-pi start` again", s.container, workspaceMountTarget)
				}
				return stackPlan{}, fmt.Errorf("container %s belongs to another workspace: expected the workspace mount %s, found %s — run `cheasee-pi down` in that workspace first (its container name is derived from its path, so a stale name can only come from a pre-upgrade stack)", s.container, s.mount, found)
			}
			if state != "running" {
				plan.start = append(plan.start, s)
			}
			continue
		}
		plan.create = append(plan.create, s)
		if !images[s.image] {
			plan.build = append(plan.build, s)
			if s.service == "cheasee-pi" {
				plan.firstBuild = true
			}
		}
	}
	return plan, nil
}

// ensureStackUp is the normal-start executor: verify that every existing
// container is bound to THIS workspace, start them as they are, then — only for
// missing services — build absent images and let Compose create the missing
// containers. Fail-fast: the first docker error or mount mismatch is returned
// and never triggers a rebuild/recreate fallback.
func ensureStackUp(ctx context.Context, cacheDir, root, containerName string) error {
	services := stackServices(root)
	// --name overrides the derived agent container; the sidecars always derive.
	services[0].container = containerName

	names := make([]string, len(services))
	for i, s := range services {
		names[i] = s.container
	}
	states, err := containerStates(ctx, names)
	if err != nil {
		return fmt.Errorf("check container: %w", err)
	}
	// Mount sources are probed for the containers that already exist, in one
	// docker call: reusing a container created by another worktree is the bug
	// this check exists to prevent.
	existing := make([]string, 0, len(services))
	for _, s := range services {
		if _, exists := states[s.container]; exists {
			existing = append(existing, s.container)
		}
	}
	mounts, err := containerMountSources(ctx, existing)
	if err != nil {
		return fmt.Errorf("check container mount: %w", err)
	}
	// Image presence is probed only for services Compose must create: existing
	// containers need no build and a probe there would only add round trips.
	images := make(map[string]bool, len(services))
	for _, s := range services {
		if _, exists := states[s.container]; exists {
			continue
		}
		exists, err := imageExists(ctx, s.image)
		if err != nil {
			return err
		}
		images[s.image] = exists
	}

	plan, err := planStack(services, states, mounts, images)
	if err != nil {
		return err
	}
	for _, s := range plan.start {
		if _, err := runCommandContext(ctx, "docker", "start", s.container).CombinedOutput(); err != nil {
			return fmt.Errorf("start container %s: %w", s.container, err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Started container %s\n", s.container)
	}
	if len(plan.create) == 0 {
		return nil
	}
	if len(plan.build) > 0 {
		notice := ""
		if plan.firstBuild {
			notice = firstBuildNotice
		}
		if err := composeBuild(ctx, cacheDir, root, containerName, composeBuildSpec{
			services: serviceKeys(plan.build),
			label:    "Building container image",
			notice:   notice,
		}); err != nil {
			return fmt.Errorf("docker compose build: %w", err)
		}
	}
	return composeCreateServices(ctx, cacheDir, root, containerName, plan.create)
}

// serviceKeys maps a plan slice to compose service names in stack order.
func serviceKeys(services []stackService) []string {
	keys := make([]string, len(services))
	for i, s := range services {
		keys[i] = s.service
	}
	return keys
}
