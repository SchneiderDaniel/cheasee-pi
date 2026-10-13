package main

import (
	"strings"
	"testing"
)

// Image-size trims: each removes payload no runtime path reads. These are
// Dockerfile string contracts, not runtime code, so a refactor could silently
// re-add the weight — guard them here.

func TestDockerfile_SizeTrimsPresent(t *testing.T) {
	content := readDockerfile(t)
	for _, want := range []string{
		"rm -rf /usr/include/node",
		"/opt/venvs/scrapling-venv/lib/python*/site-packages/playwright/driver",
		"/usr/lib/node_modules/@ast-grep/cli/node_modules",
		"/usr/lib/node_modules/jscpd/node_modules/jscpd-linux-*",
		"rm -rf /usr/local/go/test /usr/local/go/api /usr/local/go/doc /usr/local/go/misc",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("docker/Dockerfile must keep size trim %q", want)
		}
	}
}

func TestUIDockerfile_SizeTrimsPresent(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	if !strings.Contains(df, "rm -rf /usr/include/node") {
		t.Error("ui/Dockerfile must remove /usr/include/node (no native compile in the runtime sidecar)")
	}
	// npm stays: the spawned `pi` child installs configured packages with it.
	if strings.Contains(df, "rm -rf /usr/lib/node_modules/npm") {
		t.Error("ui/Dockerfile must keep npm — the spawned pi child installs packages through it")
	}
}
