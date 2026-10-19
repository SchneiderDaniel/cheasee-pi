package main

import (
	"context"
	"slices"
	"testing"
)

// ──────────────────────────────────────────────
// Seams for the disk-space gate
// ──────────────────────────────────────────────

// stubDockerInfoRoot stubs the exec seam to answer the DockerRootDir probe
// (and only that). out is returned verbatim; err, when non-nil, replaces the
// probe output with a failure.
func stubDockerInfoRoot(t *testing.T, out string, err error) {
	t.Helper()
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			if err != nil {
				return &mockCmd{outputFn: func() ([]byte, error) { return nil, err }}
			}
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(out), nil }}
		}
		return &mockCmd{}
	})
}

// stubStatfs replaces the free-space probe seam for the duration of the test.
// Serialized like the other package-var seams.
func stubStatfs(t *testing.T, fn func(string) (uint64, error)) {
	t.Helper()
	saved := statfsFn
	statfsFn = fn
	t.Cleanup(func() { statfsFn = saved })
}

// stubStatfsAmple sets the probe above the build threshold so a build-running
// harness never trips the disk gate.
func stubStatfsAmple(t *testing.T) {
	t.Helper()
	stubStatfs(t, func(string) (uint64, error) { return uint64(minBuildFreeBytes + 1), nil })
}

func stubStatfsBytes(t *testing.T, n uint64) {
	t.Helper()
	stubStatfs(t, func(string) (uint64, error) { return n, nil })
}

// recordCompose stubs the docker seam: the data-root probe answers root,
// compose invocations are counted, everything else is a silent success.
func recordCompose(t *testing.T, root string) *int {
	t.Helper()
	n := 0
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name == "docker" && slices.Contains(arg, "{{.DockerRootDir}}") {
			return &mockCmd{outputFn: func() ([]byte, error) { return []byte(root + "\n"), nil }}
		}
		if name == "docker" && slices.Contains(arg, "compose") {
			n++
		}
		return &mockCmd{}
	})
	return &n
}
