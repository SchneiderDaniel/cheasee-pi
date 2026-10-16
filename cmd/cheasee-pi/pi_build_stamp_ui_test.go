package main

import (
	"strings"
	"testing"
)

// TestUI_DockerfileDropsBuildStamp: the cache-busting stamp is scoped to the
// agent image, so the sidecar declares neither the ARG nor its echo (a stamp
// ARG with no supplier is dead residue of the old global `--build-arg`).

func TestUI_DockerfileDropsBuildStamp(t *testing.T) {
	df := uiAsset(t, "Dockerfile")
	for _, gone := range []string{"ARG PI_BUILD_STAMP", "pi-build-stamp"} {
		if strings.Contains(df, gone) {
			t.Errorf("ui/Dockerfile must not contain %q (stamp scope is the agent image)", gone)
		}
	}
}
