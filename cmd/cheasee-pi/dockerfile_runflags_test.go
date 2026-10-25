package main

import (
	"os/exec"
	"strings"
	"testing"
)

// Instruction flags (`--mount=…`, `--network=…`) are Dockerfile syntax, not
// shell: left in the body, `sh -n -c "--mount=… apt-get …"` exits 2 with
// "Illegal option --". runInstructions must strip them before anything parses
// the body as shell.

func singleRun(t *testing.T, content string) runInstr {
	t.Helper()
	runs := runInstructions(content)
	if len(runs) != 1 {
		t.Fatalf("fixture must hold exactly one RUN instruction, got %d", len(runs))
	}
	return runs[0]
}

func parses(body string) bool {
	return exec.Command("sh", "-n", "-c", body).Run() == nil
}

func TestRunBodies_StripsMountFlag(t *testing.T) {
	r := singleRun(t, "RUN --mount=type=cache,target=/root/.npm npm ci\n")
	if strings.Contains(r.body, "--mount") {
		t.Errorf("body must not carry the mount flag, got %q", r.body)
	}
	if r.body != "npm ci" {
		t.Errorf("body must start at the shell command, got %q", r.body)
	}
	if len(r.flags) != 1 || r.flags[0] != "--mount=type=cache,target=/root/.npm" {
		t.Errorf("the flag must be reported separately, got %q", r.flags)
	}
}

func TestRunBodies_StripsAllFlagsAndJoinsContinuations(t *testing.T) {
	content := "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n" +
		"    --mount=type=cache,target=/var/lib/apt,sharing=locked \\\n" +
		"    --network=none \\\n" +
		"    apt-get update && \\\n" +
		"    apt-get install -y --no-install-recommends curl\n"
	r := singleRun(t, content)
	if len(r.flags) != 3 {
		t.Errorf("expected 3 stripped flags, got %d: %q", len(r.flags), r.flags)
	}
	if !strings.HasPrefix(r.body, "apt-get update &&") {
		t.Errorf("body must start at the shell command, got %q", r.body)
	}
	if !strings.Contains(r.body, "apt-get install -y --no-install-recommends curl") {
		t.Errorf("continuation lines must be joined into the body, got %q", r.body)
	}
	if !parses(r.body) {
		t.Errorf("stripped body must parse as shell:\n%s", r.body)
	}
}

func TestRunBodies_FlagValueWithCommasAndEqualsStrippedWhole(t *testing.T) {
	r := singleRun(t, "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked true\n")
	for _, residue := range []string{"--mount", "type=", "target=", "sharing", "locked"} {
		if strings.Contains(r.body, residue) {
			t.Errorf("flag residue %q left in body %q — the flag must be stripped whole", residue, r.body)
		}
	}
	if r.body != "true" {
		t.Errorf("expected body %q, got %q", "true", r.body)
	}
}

func TestRunBodies_NoFlagsUnchanged(t *testing.T) {
	content := "RUN apt-get update && \\\n    apt-get install -y curl\n"
	r := singleRun(t, content)
	if len(r.flags) != 0 {
		t.Errorf("no flags expected, got %q", r.flags)
	}
	want := "apt-get update && \\\n    apt-get install -y curl"
	if r.body != want {
		t.Errorf("flag-free body must be byte-identical to the old output:\nwant %q\ngot  %q", want, r.body)
	}
}

func TestRunBodies_FlagStrippingKeepsBrokenBodiesBroken(t *testing.T) {
	// Stripping must not swallow real shell errors: an unbalanced `if` still
	// fails `sh -n` after the flags are gone.
	r := singleRun(t, "RUN --mount=type=cache,target=/x if true; then\n")
	if parses(r.body) {
		t.Errorf("stripping must not rescue an unparsable body: %q", r.body)
	}
}

func TestRunBodies_SupportsAnyFlagValue(t *testing.T) {
	// Guard against a per-flag allowlist: any `--name=value` token is an
	// instruction flag, whatever the value contains.
	values := []string{
		"type=cache,target=/root/.npm",
		"source=/tmp/ctx,target=/mnt,ro",
		"type=bind,from=builder,target=/src",
	}
	for _, v := range values {
		r := singleRun(t, "RUN --mount="+v+" true\n")
		if r.body != "true" || len(r.flags) != 1 {
			t.Errorf("--mount=%s must strip whole: body %q flags %q", v, r.body, r.flags)
		}
	}
}

func TestRunBodies_OldFlagBodyFailsParsing(t *testing.T) {
	// The failure mode this harness fix removes, pinned so it cannot come back
	// silently: the raw instruction text does NOT parse, the stripped body does.
	content := "RUN --mount=type=cache,target=/root/.npm npm ci\n"
	raw := strings.TrimPrefix(strings.Split(content, "\n")[0], "RUN ")
	if parses(raw) {
		t.Fatalf("expected the flag-bearing text to fail `sh -n` (old failure mode): %q", raw)
	}
	if !parses(singleRun(t, content).body) {
		t.Errorf("stripped body must parse: %q", singleRun(t, content).body)
	}
}
