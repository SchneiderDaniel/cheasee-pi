package main

import (
	"strings"
	"testing"
)

func TestDockerfile_PiLayerAfterCloneBeforeEntrypoint(t *testing.T) {
	content := readDockerfile(t)
	// Issue #1603: the pi-coding-agent install is the one layer busted on
	// every build (PI_BUILD_STAMP cache-busting contract), so it must sit
	// AFTER the expensive clone/npm-ci/symlink layers (6b) and BEFORE the
	// entrypoint COPY (7) — otherwise a pi bump re-runs the whole clone +
	// npm ci. The byte-offset chain pins the order: clone < npm ci < symlink
	// wiring < pi install < entrypoint COPY.
	markers := []struct {
		name string
		text string
	}{
		{"clone (6b)", "git clone --depth 1 --branch ${CHEASEE_REF} https://github.com/SchneiderDaniel/cheasee-pi /opt/cheasee-pi"},
		{"npm ci (6b)", "npm ci --no-audit --no-fund"},
		{"symlink wiring (6b)", "chown -R agentuser:agentuser /home/agentuser/.pi"},
		{"pi install (6c)", "npm install -g --force @earendil-works/pi-coding-agent"},
		{"entrypoint COPY (7)", "COPY entrypoint.sh /usr/local/bin/entrypoint.sh"},
	}
	idxs := make([]int, len(markers))
	for i, m := range markers {
		idx := strings.Index(content, m.text)
		if idx == -1 {
			t.Fatalf("Dockerfile must contain %s marker %q (missing anchor — a reorder could silently pass)", m.name, m.text)
		}
		idxs[i] = idx
	}
	for i := 1; i < len(idxs); i++ {
		if idxs[i-1] > idxs[i] {
			t.Errorf("layer order broken: %s (offset %d) must precede %s (offset %d); the pi layer must sit after the 6b clone/npm-ci/symlink layers and before Layer 7's COPY", markers[i-1].name, idxs[i-1], markers[i].name, idxs[i])
		}
	}
	// Renumered 5h -> 6c: the new header must be present and the old one gone
	// (grep confirms "5h" appears nowhere else in the repo — renumber is safe).
	if !strings.Contains(content, "Layer 6c: pi-coding-agent") {
		t.Error("moved pi layer must be renumbered 'Layer 6c: pi-coding-agent'")
	}
	if strings.Contains(content, "Layer 5h") {
		t.Error("old 'Layer 5h' header must be gone (pi layer renumbered to 6c)")
	}
	// Stamp contract stays inside the moved RUN (AC4): exactly one ARG and one
	// echo, with the echo strictly between the install line and the Layer 7
	// header — it cannot drift out of the RUN block.
	if got := strings.Count(content, "ARG PI_BUILD_STAMP"); got != 1 {
		t.Errorf("exactly one 'ARG PI_BUILD_STAMP' required (cache-busting contract), got %d", got)
	}
	echoLine := `echo "${PI_BUILD_STAMP}" >/var/lib/pi-build-stamp`
	if got := strings.Count(content, echoLine); got != 1 {
		t.Errorf("exactly one stamp echo (%q) required, got %d", echoLine, got)
	}
	installIdx := strings.Index(content, "npm install -g --force @earendil-works/pi-coding-agent")
	layer7Idx := strings.Index(content, "# Layer 7:")
	if installIdx == -1 || layer7Idx == -1 {
		t.Fatal("pi install line or Layer 7 header missing")
	}
	echoIdx := strings.Index(content, echoLine)
	if !(installIdx < echoIdx && echoIdx < layer7Idx) {
		t.Errorf("stamp echo (offset %d) must sit inside the pi RUN: after the install line (offset %d) and before the Layer 7 header (offset %d)", echoIdx, installIdx, layer7Idx)
	}
	// No duplicate install; the /tmp scratch cleanup stays in the moved block.
	// 'npm cache clean --force' is gone (issue #2053): the cache is a BuildKit
	// mount now, so the cleanup wiped the cache it was meant to keep.
	if got := strings.Count(content, "npm install -g --force @earendil-works/pi-coding-agent"); got != 1 {
		t.Errorf("exactly one pi install line required, got %d", got)
	}
	block := content[installIdx:layer7Idx]
	if !strings.Contains(block, "rm -rf /tmp/*") {
		t.Error("moved pi RUN must retain 'rm -rf /tmp/*'")
	}
	if strings.Contains(block, "npm cache clean") {
		t.Error("moved pi RUN must not run 'npm cache clean' — it empties the mounted npm cache")
	}
}
