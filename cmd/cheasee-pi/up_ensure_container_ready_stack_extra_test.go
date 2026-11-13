package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestEnsureStackUp_missingContainerImagePresentCreatesOnly(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{services[0].container: "running", services[1].container: "running"}
	c.imageRefs = map[string]bool{services[2].image: true}

	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if !slices.Equal(c.imageProbes, []string{services[2].image}) || len(c.composeArgs) != 1 {
		t.Fatalf("only missing ui image/container should be probed and created, probes=%v compose=%v", c.imageProbes, c.composeArgs)
	}
	got := c.composeArgs[0]
	if slices.Contains(got, "build") || slices.Contains(got, "--remove-orphans") || got[len(got)-1] != "ui" {
		t.Errorf("create must avoid builds/orphan deletion and target ui only, got %v", got)
	}
	if !slices.Contains(got, filepath.Join(cacheDir, "docker-compose.yml")) || !slices.Contains(c.composeCmds[0].env, "WORKSPACE_HOST_PATH="+root) {
		t.Errorf("create must use cache compose file and workspace env, argv=%v env=%v", got, c.composeCmds[0].env)
	}
}

func TestEnsureStackUp_missingImageBuildsScopedThenCreates(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	c.states = map[string]string{services[0].container: "running"}
	c.imageRefs = map[string]bool{services[1].image: false, services[2].image: true}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if len(c.composeArgs) != 2 {
		t.Fatalf("absent image + missing container must build then create, got %v", c.composeArgs)
	}
	build, create := c.composeArgs[0], c.composeArgs[1]
	if !slices.Contains(build, "build") || build[len(build)-1] != "codeflow" {
		t.Errorf("only missing codeflow image should be built, got %v", build)
	}
	if !slices.Equal(create[len(create)-2:], []string{"codeflow", "ui"}) || !slices.Contains(create, "up") {
		t.Errorf("create must target only missing services, got %v", create)
	}
	if strings.Contains(stderr, "First start downloads") {
		t.Errorf("agent image present must suppress first-build notice, got %q", stderr)
	}
}

func TestEnsureStackUp_buildFailureNeverCreates(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "build")
	}))
	c.states = nil
	c.imageRefs = map[string]bool{}

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failed build must surface")
	}
	if len(c.composeCmds) != 1 || !slices.Contains(c.composeArgs[0], "build") {
		t.Errorf("no create after a failed build, got %v", c.composeArgs)
	}
}

func TestEnsureStackUp_createFailureIsNotRetried(t *testing.T) {
	root, name, cacheDir, c := stackFixtureWith(t, failingDocker(func(arg []string) bool {
		return slices.Contains(arg, "up")
	}))
	services := stackServices(root)
	c.imageRefs = map[string]bool{services[0].image: true, services[1].image: true, services[2].image: true}

	err := ensureStackUp(context.Background(), cacheDir, root, name)
	if err == nil {
		t.Fatal("a failed create must surface")
	}
	if len(c.composeArgs) != 1 {
		t.Errorf("failed create must not be retried nor followed by a build, got %v", c.composeArgs)
	}
}
