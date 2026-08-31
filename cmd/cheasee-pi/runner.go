package main

import (
	"context"
	"io"
	"os/exec"
	"time"
)

// runner is the subset of *exec.Cmd used by every subprocess site in the CLI:
// output capture plus Run and dir/env/stdin/stdout/stderr configuration. It is
// the single exec seam — cmdIface/execCommand and raw exec.Command call sites
// all route through runCommandContext, so tests substitute one fake
// (mockCmd) for every docker/git/gh/id/true invocation.
type runner interface {
	Output() ([]byte, error)
	CombinedOutput() ([]byte, error)
	Run() error
	SetDir(string)
	SetEnv([]string)
	SetStdin(io.Reader)
	SetStdout(io.Writer)
	SetStderr(io.Writer)
}

// execRunner adapts *exec.Cmd to runner (its config surface is field-based,
// not method-based).
type execRunner struct{ *exec.Cmd }

func (e execRunner) SetDir(d string)       { e.Cmd.Dir = d }
func (e execRunner) SetEnv(env []string)   { e.Cmd.Env = env }
func (e execRunner) SetStdin(r io.Reader)  { e.Cmd.Stdin = r }
func (e execRunner) SetStdout(w io.Writer) { e.Cmd.Stdout = w }
func (e execRunner) SetStderr(w io.Writer) { e.Cmd.Stderr = w }

// execWaitDelay bounds the post-exit drain of captured output pipes. Without
// it, a ctx-canceled docker exec kills only the docker client and a grandchild
// (the in-container bash) holding the pipes open can wedge CombinedOutput's
// Wait forever (exec.CommandContext leaves WaitDelay unset). With it, Wait
// errors out execWaitDelay after the direct child exits — the orphan reapers
// still clean the detached in-container pi later, but the CLI can't hang.
const execWaitDelay = 5 * time.Second

// runCommandContext is the single os/exec.Command wrapper, overridable in
// tests. It centralizes process construction and cancellation policy: the
// context variant sets WaitDelay on the wrapped command so every capture site
// is bounded after process exit.
//
// NOTE: the package has zero t.Parallel() tests; swapping this var is
// race-free only under that constraint. Do not add t.Parallel() without
// switching to a per-test registry.
var runCommandContext = func(ctx context.Context, name string, arg ...string) runner {
	cmd := exec.CommandContext(ctx, name, arg...)
	cmd.WaitDelay = execWaitDelay
	return execRunner{cmd}
}
