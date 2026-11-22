package main

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// managedLabel marks every container the CLI owns (stamped by the compose
// service labels). clean enumerates by label — exact by construction, immune
// to the substring semantics of `docker ps --filter name=` — plus a legacy
// name pass for pre-label containers.
const managedLabel = "com.cheaseepi.managed=true"

// containerRunning reports whether the named container is running. Docker's
// `--filter name=` matches substrings and emits one line per match, so the
// {{.Names}} listing is compared line-by-line: `cheasee-pi-foo` is never
// treated as running merely because `cheasee-pi-foo-bar` also matches the
// filter.
func containerRunning(ctx context.Context, name string) (bool, error) {
	out, err := runCommandContext(ctx, "docker", "ps", "--filter", fmt.Sprintf("name=%s", name), "--format", "{{.Names}}").Output()
	if err != nil {
		return false, fmt.Errorf("docker ps: %w", err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.TrimSpace(line) == name {
			return true, nil
		}
	}
	return false, nil
}

// workspaceMountTarget is the in-container path the compose stack always
// mounts this workspace's host folder at. The HOST source of that mount is the
// only thing that proves a running container belongs to this workspace: a
// container created by another worktree carries that worktree's path, so
// starting it would silently hand this workspace someone else's files.
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
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
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
	return mounts, nil
}

// containerExists reports whether the named container exists in any state —
// running, exited, created. `docker ps -a` is the only listing that sees a
// stopped container: such a container is started as-is, never recreated, so it
// keeps the configuration it was created with, credential mounts included.
func containerExists(ctx context.Context, name string) (bool, error) {
	states, err := containerStates(ctx, []string{name})
	if err != nil {
		return false, err
	}
	_, exists := states[name]
	return exists, nil
}

// containerStates reports the docker state (running, exited, created, …) of
// each requested container. A name absent from the map does not exist on the
// host; a docker failure is an error, never an all-missing map. One `docker ps
// -a` answers every name and the exact-name post-filter keeps the listing
// honest (same discipline as listManagedContainers).
func containerStates(ctx context.Context, names []string) (map[string]string, error) {
	out, err := runCommandContext(ctx, "docker", "ps", "-a", "--format", "{{.Names}}|{{.State}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	wanted := make(map[string]bool, len(names))
	for _, n := range names {
		wanted[n] = true
	}
	states := make(map[string]string, len(names))
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, state, ok := strings.Cut(strings.TrimSpace(line), "|")
		if ok && wanted[name] {
			states[name] = state
		}
	}
	return states, nil
}

// listManagedContainers enumerates every cheasee-pi container on the host
// (all repos, running or stopped): the managed-label pass (compose-started
// containers) union a legacy name pass covering pre-label containers
// (cheasee-pi / cheasee-pi-* and codeflow / codeflow-*), Go-side
// post-filtered so the substring name filter can never over-match foreign
// containers. Deduped, order-stable.
func listManagedContainers(ctx context.Context) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}

	names, err := dockerPS(ctx, "label="+managedLabel)
	if err != nil {
		return nil, err
	}
	for _, n := range names {
		add(n)
	}

	// Legacy sweep: pre-label containers are only findable by name, and the
	// name filter is substring-based — the Go post-filter keeps only names
	// that are actually ours.
	for _, prefix := range []string{"cheasee-pi", "codeflow"} {
		names, err := dockerPS(ctx, "name="+prefix)
		if err != nil {
			return nil, err
		}
		for _, n := range names {
			if isLegacyContainerName(n) {
				add(n)
			}
		}
	}
	return out, nil
}

// isLegacyContainerName reports whether a name from the substring name filter
// is actually one of ours: exact `cheasee-pi`/`codeflow` or a derived
// `cheasee-pi-*`/`codeflow-*` prefix match.
func isLegacyContainerName(name string) bool {
	return name == "cheasee-pi" || name == "codeflow" ||
		strings.HasPrefix(name, "cheasee-pi-") || strings.HasPrefix(name, "codeflow-")
}

// dockerPS runs `docker ps -a` with a filter and returns the trimmed
// {{.Names}} lines.
func dockerPS(ctx context.Context, filter string) ([]string, error) {
	out, err := runCommandContext(ctx, "docker", "ps", "-a", "--filter", filter, "--format", "{{.Names}}").Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w", err)
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	return names, nil
}

// removeContainers force-removes each container by name. A failed rm aborts
// with an error naming the container — never a silent partial clean.
func removeContainers(ctx context.Context, names []string) error {
	for _, name := range names {
		if _, err := runCommandContext(ctx, "docker", "rm", "-f", name).CombinedOutput(); err != nil {
			return fmt.Errorf("remove container %s: %w", name, err)
		}
		fmt.Fprintf(os.Stderr, "  ✓ Removed container %s\n", name)
	}
	return nil
}

// projectContainers lists the container names (all states) belonging to a
// compose project via its com.docker.compose.project label — the precise
// scope for `down` (label filters are exact-match, no prefix semantics).
func projectContainers(ctx context.Context, project string) ([]string, error) {
	return dockerPS(ctx, "label=com.docker.compose.project="+project)
}
