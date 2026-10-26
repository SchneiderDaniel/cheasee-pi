package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// cheaseePiRepoURL is the upstream cloned into /opt/cheasee-pi by Dockerfile
// Layer 6b and probed for the baked-copy cache-bust commit (issue #2054).
const cheaseePiRepoURL = "https://github.com/SchneiderDaniel/cheasee-pi"

// cheaseeCommitProbeTimeout bounds the upstream commit probe so an unreachable
// remote cannot stall a build behind git's default connect timeout.
const cheaseeCommitProbeTimeout = 10 * time.Second

// cheaseeCommitCacheFile (in the version-keyed compose dir) records the commit
// and ref of the last SUCCESSFUL build of ONE image, so (a) an offline build
// keeps the clone layer's cache key unchanged instead of forcing a network
// clone and (b) `cheasee-pi about` can report the baked /opt/cheasee-pi
// revision. One record per image ref (cheaseeCommitCachePath): the compose dir
// is shared by every workspace on this CLI version, so a single record would
// let a build in workspace B overwrite what `about` reports for workspace A
// (issue #2054 audit).
const cheaseeCommitCacheFile = "cheasee-commit"

// cheaseeCommitCachePath is one image's baked-commit record. imageRef is a
// compose image name (sanitizeSlug charset only), so it is filename-safe.
func cheaseeCommitCachePath(composeDir, imageRef string) string {
	return filepath.Join(composeDir, cheaseeCommitCacheFile+"-"+imageRef)
}

// cheaseeCommitRecord is the last successful build's baked revision: the ref
// it was resolved from and the commit it baked. Storing the ref alongside the
// commit stops the offline fallback from reusing a commit produced by a
// DIFFERENT ref (issue #2054 audit) — a cross-ref fallback would hand the
// clone layer a cache key and HEAD guard for the wrong revision.
type cheaseeCommitRecord struct {
	ref    string
	commit string
}

// cheaseeRef is the ref the baked copy tracks: a user-supplied CHEASEE_REF or
// the compose/Dockerfile default main.
func cheaseeRef() string {
	if ref := os.Getenv("CHEASEE_REF"); ref != "" {
		return ref
	}
	return "main"
}

// resolveCheaseeCommit is the upstream-commit probe feeding CHEASEE_COMMIT —
// the clone layer's content-addressed cache-bust input. Injectable so unit
// tests never reach the network (helpers_stub_test.go stubs it).
var resolveCheaseeCommit = resolveCheaseeCommitFn

// resolveCheaseeCommitFn is the real probe: the SHA/refs pairs from
// `git ls-remote <repo> <ref>`, preferring an exact refs/heads/<ref> match and
// then an annotated tag's peeled commit (refs/tags/<ref>^{}).
func resolveCheaseeCommitFn(ctx context.Context, ref string) (string, error) {
	out, err := runCommandContext(ctx, "git", "ls-remote", cheaseePiRepoURL, ref).Output()
	if err != nil {
		return "", err
	}
	// An annotated tag is listed twice: the tag object and its peeled commit
	// (refs/tags/<ref>^{}). Only the peeled hash is a commit — `git clone
	// --branch <tag>` checks that out, and the clone layer compares HEAD
	// against it — so a peeled match must win over the first line.
	heads := "refs/heads/" + ref
	peeled := "refs/tags/" + ref + "^{}"
	var first, peeledCommit string
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if first == "" {
			first = f[0]
		}
		if f[1] == heads {
			return f[0], nil
		}
		if f[1] == peeled {
			peeledCommit = f[0]
		}
	}
	if peeledCommit != "" {
		return peeledCommit, nil
	}
	if first != "" {
		return first, nil
	}
	return "", fmt.Errorf("git ls-remote returned no commit for %q", ref)
}

// composeBuildSpec parameterizes composeBuild: the caller owns the extra
// args, the label text, the optional pre-build notice, and the error wrap;
// composeBuild owns argv assembly, env, redirect and ordering.
type composeBuildSpec struct {
	// services scopes the build to the named compose services; nil/empty
	// builds every service (the --build/rebuild contract).
	services  []string
	extraArgs []string          // appended after `build`, e.g. --no-cache --pull
	label     string            // build label printed as "  ℹ <label>..."
	notice    string            // optional pre-build notice line (blank-line separated); "" → none
	wrapErr   func(error) error // nil → return the raw Run() error
}

// composeBuild runs `docker compose -f <composeDir>/docker-compose.yml build`
// with the caller's extra args, the compose env, and the notice-before-label
// ordering shared by start and build.
func composeBuild(ctx context.Context, composeDir, workspaceHostPath, containerName string, spec composeBuildSpec) error {
	// Fail fast before BuildKit starts writing: a data root without room for
	// the layers/export makes the daemon reclaim images and containers itself.
	// Undeterminable space fails open (see checkBuildDiskSpace).
	if err := checkBuildDiskSpace(ctx); err != nil {
		return err
	}

	composeFile := filepath.Join(composeDir, "docker-compose.yml")

	// The per-build cache-busting stamp rides the compose env (see
	// applyComposeEnv) and is declared on the agent service's build.args in
	// docker-compose.yml — never a global CLI --build-arg, which would reach
	// every service whose Dockerfile declares the ARG.
	args := []string{"compose", "-f", composeFile, "build"}
	args = append(args, spec.extraArgs...)
	args = append(args, spec.services...)

	build := runCommandContext(ctx, "docker", args...)
	build.SetDir(composeDir)
	build.SetStdout(os.Stderr)
	build.SetStderr(os.Stderr)
	// The record this build writes and the image it reads back are keyed by the
	// workspace's image ref, never by the shared compose dir alone.
	imageRef := cheaseeImageRef(workspaceHostPath)
	// Only the agent image bakes the /opt/cheasee-pi clone, so a sidecar-scoped
	// build neither resolves an upstream commit nor records one.
	buildsAgent := len(spec.services) == 0 || slices.Contains(spec.services, "cheasee-pi")
	// Resolved AFTER the disk gate so a refused build never probes the network.
	var extraEnv []string
	commit := ""
	if buildsAgent {
		commit = bakedCommitForBuild(ctx, composeDir, imageRef)
		extraEnv = append(extraEnv, "CHEASEE_COMMIT="+commit)
	}
	// compose validates every volume spec even for `build`, so
	// WORKSPACE_HOST_PATH/WORKSPACE_BARE_PATH must be set here too (memory/
	// cpus/git identity from settings.json ride along).
	applyComposeEnv(build, workspaceHostPath, containerName, composeDir, extraEnv...)
	if spec.notice != "" {
		// The notice precedes the build label with blank-line separation so
		// buildx tty inline rendering (compose build paints over preceding
		// lines in a terminal) cannot clobber it on exactly the run it
		// explains.
		fmt.Fprintf(os.Stderr, "\n  ℹ %s\n\n", spec.notice)
	}
	fmt.Fprintf(os.Stderr, "  ℹ %s...\n", spec.label)
	if err := build.Run(); err != nil {
		if spec.wrapErr != nil {
			return spec.wrapErr(err)
		}
		return err
	}
	if !buildsAgent {
		return nil
	}
	// Dockerfile Layer 6b writes the clone's HEAD to /opt/cheasee-pi/BUILD_COMMIT
	// and fails unless it equals CHEASEE_COMMIT, so a successful build bakes
	// exactly `commit` — except when the probe left it empty (offline build
	// with no record for this image yet), where the image's own BUILD_COMMIT is the
	// source of truth. Persisting the ACTUAL baked commit keeps `cheasee-pi
	// about` truthful even then (issue #2054 audit).
	baked := commit
	if baked == "" {
		captured, err := captureBakedCommit(ctx, imageRef)
		if err != nil {
			// Never silent: an unreadable baked commit after a successful build
			// leaves `about` reporting nothing, and the user must know why
			// (issue #2054 audit). The image itself is built, so the build stands.
			fmt.Fprintf(os.Stderr, "  \u26a0 baked cheasee-pi commit: %v — `cheasee-pi about` will not report one\n", err)
		}
		baked = captured
	}
	recordBakedCommit(composeDir, imageRef, cheaseeRef(), baked)
	return nil
}

// captureBakedCommit reads the commit the built image actually baked at
// /opt/cheasee-pi/BUILD_COMMIT. Only needed when the upstream probe left the
// cache-bust ARG empty: the image is then the source of truth, so `about`
// still reports the baked revision instead of nothing. The error is returned
// rather than swallowed — a failed read of an already-built image is abnormal,
// and an empty result is a missing commit, not a revision.
func captureBakedCommit(ctx context.Context, imageRef string) (string, error) {
	out, err := runCommandContext(ctx, "docker", "run", "--rm", "--entrypoint", "cat", imageRef, "/opt/cheasee-pi/BUILD_COMMIT").Output()
	if err != nil {
		return "", err
	}
	commit := strings.TrimSpace(string(out))
	if commit == "" {
		return "", fmt.Errorf("%s:/opt/cheasee-pi/BUILD_COMMIT is empty", imageRef)
	}
	return commit, nil
}

// recordBakedCommit persists the ref+commit a successful build of imageRef
// baked into /opt/cheasee-pi. An empty commit is not a known revision and is
// never recorded.
func recordBakedCommit(composeDir, imageRef, ref, commit string) {
	if commit == "" {
		return
	}
	if err := atomicWrite(cheaseeCommitCachePath(composeDir, imageRef), []byte(ref+" "+commit+"\n"), 0644, false); err != nil {
		fmt.Fprintf(os.Stderr, "  \u26a0 cheasee-pi commit cache: %v\n", err)
	}
}

// readBakedCommit returns the last recorded ref+commit of imageRef, or a zero
// record when none exists. Git refs contain no whitespace, so "<ref> <commit>"
// round-trips unambiguously; a record without the separator yields a zero
// record (conservative — no fallback, never a misattributed commit).
func readBakedCommit(composeDir, imageRef string) cheaseeCommitRecord {
	b, err := os.ReadFile(cheaseeCommitCachePath(composeDir, imageRef))
	if err != nil {
		return cheaseeCommitRecord{}
	}
	ref, commit, ok := strings.Cut(strings.TrimSpace(string(b)), " ")
	if !ok {
		return cheaseeCommitRecord{}
	}
	return cheaseeCommitRecord{ref: ref, commit: strings.TrimSpace(commit)}
}

// bakedCommitForBuild returns the clone layer's cache-bust input for one build
// of imageRef: the upstream commit of CHEASEE_REF, or — when the probe fails —
// the last commit that image baked from the SAME ref, so the layer's cache key
// (and thus the cached layer) stays unchanged instead of forcing a network
// clone. A commit recorded for a different ref is never reused: the cache key
// and HEAD guard must describe the ref actually being built (issue #2054
// audit).
func bakedCommitForBuild(ctx context.Context, composeDir, imageRef string) string {
	ref := cheaseeRef()
	probeCtx, cancel := context.WithTimeout(ctx, cheaseeCommitProbeTimeout)
	commit, err := resolveCheaseeCommit(probeCtx, ref)
	cancel()
	if err == nil && commit != "" {
		return commit
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "  \u26a0 cheasee-pi commit probe: %v\n", err)
	}
	if prior := readBakedCommit(composeDir, imageRef); prior.commit != "" && prior.ref == ref {
		fmt.Fprintf(os.Stderr, "  \u2139 reusing last baked cheasee-pi commit %s\n", prior.commit)
		return prior.commit
	}
	return ""
}

// firstBuildNotice is the one-time download warning shown ahead of the first
// agent image build (both the --build path and a plain start that must build
// absent images).
const firstBuildNotice = "First start downloads ~1GB of build-time dependencies (Chromium, Node.js, Python toolchain); this can take several minutes on slower connections."

// requireWorkspaceBare fails closed when the sibling bare repo is missing: the
// worktree's gitdir points into <parent>/.bare, and a compose up would
// otherwise let Docker's create_host_path auto-create a stray empty host dir
// that breaks the mount/worktree-fix contract. Recovery hint instead of a
// silent stray dir.
func requireWorkspaceBare(workspaceHostPath string) error {
	bareDir := filepath.Join(filepath.Dir(workspaceHostPath), ".bare")
	if _, err := os.Stat(bareDir); err != nil {
		return fmt.Errorf("workspace is corrupt: bare repository %s is missing (cheasee-settings.json present, no .bare sibling) — re-run `cheasee-pi init` in an empty folder and clone again", bareDir)
	}
	return nil
}

// dockerComposeUp builds and starts the container from the cache dir. The
// compose file lives at composeDir/docker-compose.yml; the workspace root
// (workspaceHostPath) is injected as WORKSPACE_HOST_PATH and its sibling bare
// repo as WORKSPACE_BARE_PATH — CLI-resolved absolute paths, never ${PWD}
// (macOS logical-vs-resolved path pitfall).
func dockerComposeUp(ctx context.Context, composeDir, workspaceHostPath, containerName string, firstBuild bool) error {
	composeFile := filepath.Join(composeDir, "docker-compose.yml")

	if err := requireWorkspaceBare(workspaceHostPath); err != nil {
		return err
	}

	// First-build expectations: the notice rides ahead of the build label (see
	// composeBuild). Static text — no measured size.
	notice := ""
	if firstBuild {
		notice = firstBuildNotice
	}
	if err := composeBuild(ctx, composeDir, workspaceHostPath, containerName, composeBuildSpec{
		label:  "Building container image",
		notice: notice,
	}); err != nil {
		return err
	}

	cmd := runCommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans",
	)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, workspaceHostPath, containerName, composeDir)
	fmt.Fprintf(os.Stderr, "  ℹ Starting container...\n")
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "  ✓ Container started\n")
	return nil
}

// composeCreateServices creates ONLY the given missing containers. `--no-build`
// keeps Compose from rebuilding, `--pull never` keeps it from reaching a
// registry for a missing image, and the explicit service list keeps it from
// touching any existing container — Compose only creates what does not exist,
// so no existing container is recreated and no config drift is reconciled.
func composeCreateServices(ctx context.Context, composeDir, workspaceHostPath, containerName string, create []stackService) error {
	if err := requireWorkspaceBare(workspaceHostPath); err != nil {
		return err
	}
	composeFile := filepath.Join(composeDir, "docker-compose.yml")
	args := []string{"compose", "-f", composeFile,
		"up", "-d", "--remove-orphans", "--no-build", "--pull", "never"}
	for _, s := range create {
		args = append(args, s.service)
	}
	cmd := runCommandContext(ctx, "docker", args...)
	cmd.SetStdout(os.Stderr)
	cmd.SetStderr(os.Stderr)
	applyComposeEnv(cmd, workspaceHostPath, containerName, composeDir)
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
// port. composeDir is the version-keyed cache dir the compose file lives in
// (the caller already holds it). SELinux-enforcing hosts opt in to
// bind-mount relabeling via CHEASEEPI_SELINUX_RELABEL=1 (appends :Z to every
// bind mount — documented, not default: relabel cost).
// extraEnv carries per-invocation entries the caller owns (e.g. the build
// path's resolved CHEASEE_COMMIT); they are appended after the derived env so
// a single entry always wins.
func applyComposeEnv(cmd runner, workspaceHostPath, containerName, composeDir string, extraEnv ...string) {
	// Derived identity env is authoritative — strip inherited keys so
	// duplicate KEY= entries (nondeterministic resolution across libc/exec)
	// can never leak in. A user-set CODEFLOW_PORT / PI_UI_PORT is not
	// clobbered: the resolver returns it verbatim and it is re-appended as the
	// single entry.
	env := stripEnvKeys(os.Environ(),
		"COMPOSE_PROJECT_NAME", "CODEFLOW_PORT",
		"CHEASEEPI_CONTAINER", "CODEFLOW_CONTAINER",
		"PI_UI_PORT", "PI_UI_CONTAINER",
		"PI_BUILD_STAMP", "CHEASEE_COMMIT",
		codeflowSpecEnv,
	)
	env = append(env,
		"WORKSPACE_HOST_PATH="+workspaceHostPath,
		"WORKSPACE_BARE_PATH="+filepath.Join(filepath.Dir(workspaceHostPath), ".bare"),
		// Per-build cache-busting stamp so the agent image's pi-coding-agent
		// layer always re-resolves the requested version: Docker caches RUN
		// layers on the command text + ARG values, and an unchanging ARG would
		// serve a stale pi from the layer cache. Never a constant. Scoped to
		// the agent service via docker-compose.yml build.args — a global
		// --build-arg would also bust the ui sidecar's pi layer. The pi layer
		// sits after the clone/npm-ci layers, so this bust re-runs only the pi
		// install; clone + npm ci stay cached across builds.
		"PI_BUILD_STAMP="+fmt.Sprintf("%d", time.Now().Unix()),
		// Container names carry the repo slug so distinct workspaces get
		// distinct containers (compose interpolates them into container_name).
		"CHEASEEPI_CONTAINER="+containerName,
		"CODEFLOW_CONTAINER="+codeflowContainerName(workspaceHostPath),
		"PI_UI_CONTAINER="+uiContainerName(workspaceHostPath),
		// Per-repo compose project — compose precedence (-p > env > file
		// name: > dir basename) makes the env win over the file's fallback
		// name: cheasee-pi; the cache-dir basename (the CLI version key, e.g.
		// "0.50") is rejected by compose ≥v2.17 charset rules, so the file
		// name: is the only sane fallback for direct usage.
		"COMPOSE_PROJECT_NAME="+composeProjectName(workspaceHostPath),
	)
	// CodeFlow spec stamp: the codeflow container carries the CLI-owned config
	// hash as a compose label at creation, so a later plain `start` can detect
	// sidecar drift without re-deriving Compose's own hash (unstable
	// across Compose versions). Missing extracted files → no stamp (the
	// compose `:-` default leaves the label unset); read errors are loud,
	// never silent — a silently changing stamp would read as drift on every
	// start.
	if spec, err := codeflowSpecHash(workspaceHostPath, composeDir); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow spec stamp: %v\n", err)
	} else if spec != "" {
		env = append(env, codeflowSpecEnv+"="+spec)
	}
	// CodeFlow host port: settings docker.codeflowPort > process env
	// CODEFLOW_PORT (pass-through) > derived+probed. Resolution failure is
	// loud (stderr) and leaves the compose fallback (8470) to fail loudly on
	// its own if occupied.
	if port, err := codeflowHostPort(workspaceHostPath); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow port: %v\n", err)
	} else {
		env = append(env, "CODEFLOW_PORT="+port)
	}
	// UI host port: settings docker.uiPort > process env PI_UI_PORT
	// (pass-through) > derived+probed. Resolution failure is loud (stderr) and
	// leaves the compose fallback (9500) to fail loudly on its own if occupied.
	if port, err := uiHostPort(workspaceHostPath); err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ UI port: %v\n", err)
	} else {
		env = append(env, "PI_UI_PORT="+port)
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
	env = append(env, extraEnv...)
	cmd.SetEnv(env)
}
