package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// dockerComposeUp builds and starts the container from the cache dir. The
// compose file lives at composeDir/docker-compose.yml; the workspace root
// (workspaceHostPath) is injected as WORKSPACE_HOST_PATH and its sibling bare
// repo as WORKSPACE_BARE_PATH — CLI-resolved absolute paths, never ${PWD}
// (macOS logical-vs-resolved path pitfall).
func dockerComposeUp(ctx context.Context, composeDir, workspaceHostPath, containerName string, firstBuild bool) error {
	composeFile := filepath.Join(composeDir, "docker-compose.yml")

	// Fail closed when the sibling bare repo is missing: the worktree's gitdir
	// points into <parent>/.bare, and a compose up would otherwise let Docker's
	// create_host_path auto-create a stray empty host dir that breaks the
	// mount/worktree-fix contract. Recovery hint instead of a silent stray dir.
	bareDir := filepath.Join(filepath.Dir(workspaceHostPath), ".bare")
	if _, err := os.Stat(bareDir); err != nil {
		return fmt.Errorf("workspace is corrupt: bare repository %s is missing (cheasee-settings.json present, no .bare sibling) — re-run `cheasee-pi init` in an empty folder and clone again", bareDir)
	}

	// Build with a per-build cache-busting stamp so the pi-coding-agent
	// layer always re-resolves @latest (Docker caches RUN layers on the
	// command text + ARG values; an unchanging ARG means a stale pi).
	// The pi layer sits after the clone/npm-ci layers, so the bust re-runs
	// only the pi install — clone + npm ci stay cached across builds.
	stamp := fmt.Sprintf("%d", time.Now().Unix())
	build := runCommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"build", "--build-arg", "PI_BUILD_STAMP="+stamp,
	)
	build.SetStdout(os.Stderr)
	build.SetStderr(os.Stderr)
	// compose validates every volume spec even for `build`, so
	// WORKSPACE_HOST_PATH/WORKSPACE_BARE_PATH must be set here too (memory/
	// cpus/git identity from settings.json ride along).
	applyComposeEnv(build, workspaceHostPath, containerName)
	if firstBuild {
		// First-build expectations: the notice precedes the build label with
		// blank-line separation so buildx tty inline rendering (compose build
		// paints over preceding lines in a terminal) cannot clobber it on
		// exactly the first run it explains. Static text — no measured size.
		fmt.Fprintf(os.Stderr, "\n  ℹ First start downloads ~1GB of build-time dependencies (Chromium, Node.js, Python toolchain); this can take several minutes on slower connections.\n\n")
	}
	fmt.Fprintf(os.Stderr, "  ℹ Building container image...\n")
	if err := build.Run(); err != nil {
		return err
	}

	cmd := runCommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans",
	)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, workspaceHostPath, containerName)
	fmt.Fprintf(os.Stderr, "  ℹ Starting container...\n")
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container started\n")
	return nil
}

// applyComposeEnv sets the compose-up environment: the CLI-resolved absolute
// workspace host path plus its sibling bare repo (<parent>/.bare) — two
// sibling bind mounts (folder→/workspaces/main, bare→/workspaces/.bare), never
// a single parent-of-folder mount — plus resource limits and git identity
// from cheasee-settings.json (replacing the old docker/.env file and the
// pi-coupled .pi/settings.json read), the per-repo compose project name (the
// isolation key — see composeProjectName) and the resolved CodeFlow host
// port. SELinux-enforcing hosts opt in to bind-mount relabeling via
// CHEASEEPI_SELINUX_RELABEL=1 (appends :Z to every bind mount — documented,
// not default: relabel cost).
func applyComposeEnv(cmd runner, workspaceHostPath, containerName string) {
	// Derived identity env is authoritative — strip inherited keys so
	// duplicate KEY= entries (nondeterministic resolution across libc/exec)
	// can never leak in. A user-set CODEFLOW_PORT is not clobbered: the
	// resolver returns it verbatim and it is re-appended as the single entry.
	env := stripEnvKeys(os.Environ(),
		"COMPOSE_PROJECT_NAME", "CODEFLOW_PORT",
		"CHEASEEPI_CONTAINER", "CODEFLOW_CONTAINER",
	)
	env = append(env,
		"WORKSPACE_HOST_PATH="+workspaceHostPath,
		"WORKSPACE_BARE_PATH="+filepath.Join(filepath.Dir(workspaceHostPath), ".bare"),
		// Container names carry the repo slug so distinct workspaces get
		// distinct containers (compose interpolates them into container_name).
		"CHEASEEPI_CONTAINER="+containerName,
		"CODEFLOW_CONTAINER="+codeflowContainerName(workspaceHostPath),
		// Per-repo compose project — compose precedence (-p > env > file
		// name: > dir basename) makes the env win over the file's fallback
		// name: cheasee-pi; the cache-dir basename (the CLI version key, e.g.
		// "0.50") is rejected by compose ≥v2.17 charset rules, so the file
		// name: is the only sane fallback for direct usage.
		"COMPOSE_PROJECT_NAME="+composeProjectName(workspaceHostPath),
	)
	// CodeFlow host port: settings docker.codeflowPort > process env
	// CODEFLOW_PORT (pass-through) > derived+probed. Resolution failure is
	// loud (stderr) and leaves the compose fallback (8470) to fail loudly on
	// its own if occupied.
	if port, err := codeflowHostPort(workspaceHostPath); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow port: %v\n", err)
	} else {
		env = append(env, "CODEFLOW_PORT="+port)
	}
	if os.Getenv("CHEASEEPI_SELINUX_RELABEL") == "1" {
		env = append(env, "VOLUME_RELABEL=:Z")
		fmt.Fprintf(os.Stderr, "  ℹ SELinux relabeling enabled: appending :Z to bind mounts\n")
	}
	if mem, ok := memoryLimitEnv(workspaceHostPath); ok {
		env = append(env, mem)
		fmt.Fprintf(os.Stderr, "  ℹ Using memory limit %s from cheasee-settings.json\n", envValue(mem))
	}
	if s, err := LoadCheaseeSettings(workspaceHostPath); err == nil {
		if s.Docker.CPUs != "" {
			env = append(env, "CHEASEEPI_CPUS="+s.Docker.CPUs)
		}
		if s.GitIdentity.Name != "" {
			env = append(env, "HOST_GIT_NAME="+s.GitIdentity.Name)
		}
		if s.GitIdentity.Email != "" {
			env = append(env, "HOST_GIT_EMAIL="+s.GitIdentity.Email)
		}
	}
	cmd.SetEnv(env)
}
