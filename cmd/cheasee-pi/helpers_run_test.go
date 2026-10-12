package main

import (
	"context"
	"io"
	"testing"
)

func (m *mockCmd) Run() error {
	if m.runFn != nil {
		return m.runFn()
	}
	return nil
}

func (m *mockCmd) SetDir(d string) { m.dir = d }

func (m *mockCmd) SetEnv(e []string) { m.env = e }

func (m *mockCmd) SetStdin(r io.Reader) { m.stdin = r }

func (m *mockCmd) SetStdout(w io.Writer) { m.stdout = w }

func (m *mockCmd) SetStderr(w io.Writer) { m.stderr = w }

// ──────────────────────────────────────────────
// Seam stubs (docker/git CLI tests)
// ──────────────────────────────────────────────

// stubRunCommandContext replaces the runCommandContext seam — the ONLY exec
// seam — for the duration of the test. Serialized (no t.Parallel) — package-var
// swap is race-free only under serial execution.

func stubRunCommandContext(t *testing.T, fn func(context.Context, string, ...string) runner) {
	t.Helper()
	saved := runCommandContext
	runCommandContext = fn
	t.Cleanup(func() { runCommandContext = saved })
}

// stubLookPath replaces the lookPath seam for the duration of the test.

func stubLookPath(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := lookPath
	lookPath = fn
	t.Cleanup(func() { lookPath = saved })
}
