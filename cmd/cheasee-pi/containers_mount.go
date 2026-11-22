package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// ──────────────────────────────────────────────
// Workspace mount verification
//
// The compose stack always binds this workspace's host folder onto one
// in-container path. That bind's HOST source is the only proof a container
// belongs to THIS workspace: a container created by another worktree carries
// that worktree's path, so starting it would silently hand this workspace
// someone else's files (docs/daily-usage.md).
// ──────────────────────────────────────────────

// workspaceMountTarget is the in-container path the compose stack always
// mounts this workspace's host folder at.
const workspaceMountTarget = "/workspaces/main"

// containerMountProbeFormat is the `docker inspect` template for the mount
// probe: one `<name>|<host source of the workspace mount>` line per container.
// Docker renders `.Name` with a leading slash (stripped by the parser).
const containerMountProbeFormat = `{{.Name}}|{{range .Mounts}}{{if eq .Destination "` + workspaceMountTarget + `"}}{{.Source}}{{end}}{{end}}`

// containerMountSources reports the host path each container binds onto
// /workspaces/main. ONE `docker inspect` answers every name (a per-container
// inspect would multiply daemon round trips on every start). A name absent from
// the result has no verifiable mount — the planner treats that as a failure,
// never as a match. A daemon failure is an error, never an empty map.
func containerMountSources(ctx context.Context, names []string) (map[string]string, error) {
	mounts := make(map[string]string, len(names))
	if len(names) == 0 {
		return mounts, nil
	}
	args := append([]string{"inspect", "--format", containerMountProbeFormat}, names...)
	out, err := runCommandContext(ctx, "docker", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("docker inspect: %w", err)
	}
	return parseMountProbe(string(out)), nil
}

// parseMountProbe decodes the probe output into a name → host-source map. A
// line without the separator carries no readable source and is dropped rather
// than guessed, so the planner sees "unverifiable", never a false match.
func parseMountProbe(out string) map[string]string {
	mounts := map[string]string{}
	for _, raw := range strings.Split(strings.TrimSpace(out), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		name, source, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		name = strings.TrimPrefix(strings.TrimSpace(name), "/")
		if name == "" {
			continue
		}
		mounts[name] = strings.TrimSpace(source)
	}
	return mounts
}

// verifyWorkspaceMount checks that an existing container is bound to this
// workspace's host path. A missing probe entry is a failure, never a pass:
// "cannot verify" must not read as "verified". Both errors name the recovery.
func verifyWorkspaceMount(service stackService, mounts map[string]string) error {
	found, verified := mounts[service.container]
	if !verified {
		return fmt.Errorf("container %s exists but its workspace mount could not be verified — refusing to reuse it; run `cheasee-pi down` in this workspace and `cheasee-pi start` again", service.container)
	}
	if filepath.Clean(found) == filepath.Clean(service.mount) {
		return nil
	}
	if found == "" {
		return fmt.Errorf("container %s has no %s mount — refusing to reuse it; run `cheasee-pi down` in this workspace and `cheasee-pi start` again", service.container, workspaceMountTarget)
	}
	return fmt.Errorf("container %s belongs to another workspace: expected the workspace mount %s, found %s — run `cheasee-pi down` in that workspace first (its container name is derived from its path, so a stale name can only come from a pre-upgrade stack)", service.container, service.mount, found)
}
