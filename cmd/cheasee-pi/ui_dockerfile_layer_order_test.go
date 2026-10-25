package main

import (
	"strings"
	"testing"
)

func TestUIDockerfile_PiInstallAfterArtifactCopies(t *testing.T) {
	content := uiAsset(t, "Dockerfile")
	// Issue #2051: the pi install layer is re-run whenever PI_VERSION changes.
	// In the ui runtime stage it must therefore be the LAST
	// executable layer — after the expensive wasm-bundle COPYs and the
	// recursive chown — so a version bump re-runs only that layer.
	markers := []struct {
		name string
		text string
	}{
		{"ui binary COPY", "COPY --from=builder /build/target/server/release/cheasee-pi-ui"},
		{"hash.txt COPY", "COPY --from=builder /build/target/server/release/hash.txt"},
		{"site COPY", "COPY --from=builder /build/target/site"},
		{"chown", "RUN chown -R ui:ui /app"},
		{"ARG PI_VERSION", "ARG PI_VERSION="},
		{"pi install", "npm install -g --force @earendil-works/pi-coding-agent"},
		{"USER ui", "USER ui"},
	}
	idxs := make([]int, len(markers))
	for i, m := range markers {
		idx := strings.Index(content, m.text)
		if idx == -1 {
			t.Fatalf("ui/Dockerfile must contain %s marker %q (missing anchor — a reorder could silently pass)", m.name, m.text)
		}
		idxs[i] = idx
	}
	for i := 1; i < len(idxs); i++ {
		if idxs[i-1] > idxs[i] {
			t.Errorf("ui layer order broken: %s (offset %d) must precede %s (offset %d); the pi install must sit after the artifact COPYs and the chown", markers[i-1].name, idxs[i-1], markers[i].name, idxs[i])
		}
	}
	// A half-move that re-adds an early install would keep the expensive COPYs
	// busted — no `npm install -g` may appear before the ui binary COPY.
	if early := content[:idxs[0]]; strings.Contains(early, "npm install -g") {
		t.Error("no 'npm install -g' may appear before the cheasee-pi-ui COPY — it would re-layer every artifact layer on each build")
	}
	// Exactly one install and one version ARG: a moved copy must
	// replace, not duplicate, and the version regex must not see a stale default.
	for _, m := range []struct{ name, text string }{
		{"pi install", "npm install -g --force @earendil-works/pi-coding-agent"},
		{"ARG PI_VERSION", "ARG PI_VERSION="},
	} {
		if got := strings.Count(content, m.text); got != 1 {
			t.Errorf("exactly one %q required, got %d", m.name, got)
		}
	}
	// The install RUN keeps its /tmp scratch cleanup; 'npm cache clean --force'
	// is gone (issue #2053 — the npm cache is a BuildKit mount, so the cleanup
	// only wiped the cache). The #2052 stamp removal (pi_build_stamp_ui_test.go)
	// owns the absence of PI_BUILD_STAMP here.
	installIdx, userIdx := idxs[5], idxs[6]
	block := content[installIdx:userIdx]
	if !strings.Contains(block, "rm -rf /tmp/*") {
		t.Error("moved pi RUN must retain 'rm -rf /tmp/*'")
	}
	if strings.Contains(block, "npm cache clean") {
		t.Error("moved pi RUN must not run 'npm cache clean' — it empties the mounted npm cache")
	}
}
