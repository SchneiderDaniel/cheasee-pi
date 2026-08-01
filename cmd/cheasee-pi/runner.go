package main

import (
	"context"
	"io"
	"os/exec"
)

// runner is the subset of *exec.Cmd used by the init CLI seams:
// output capture plus Run and dir/env/stdout/stderr configuration.
type runner interface {
	Output() ([]byte, error)
	CombinedOutput() ([]byte, error)
	Run() error
	SetDir(string)
	SetEnv([]string)
	SetStdout(io.Writer)
	SetStderr(io.Writer)
}

// execRunner adapts *exec.Cmd to runner (its config surface is field-based,
// not method-based).
type execRunner struct{ *exec.Cmd }

func (e execRunner) SetDir(d string)       { e.Cmd.Dir = d }
func (e execRunner) SetEnv(env []string)   { e.Cmd.Env = env }
func (e execRunner) SetStdout(w io.Writer) { e.Cmd.Stdout = w }
func (e execRunner) SetStderr(w io.Writer) { e.Cmd.Stderr = w }

// runCommand and runCommandContext are os/exec.Command wrappers, overridable
// in tests. They mirror orphan.go's execCommand var but add context support
// and the wider runner surface (Run/Dir/Env/Stdout/Stderr) needed by the
// docker/git call sites.
//
// NOTE: the package has zero t.Parallel() tests; swapping these vars is
// race-free only under that constraint. Do not add t.Parallel() without
// switching to a per-test registry.
var runCommand = func(name string, arg ...string) runner {
	return execRunner{exec.Command(name, arg...)}
}

var runCommandContext = func(ctx context.Context, name string, arg ...string) runner {
	return execRunner{exec.CommandContext(ctx, name, arg...)}
}
