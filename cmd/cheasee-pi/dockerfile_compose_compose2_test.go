package main

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestCompose_UILoopbackOnly(t *testing.T) {
	content := readCompose(t)

	// The ui block must not carry a host-IP env seam or any all-interfaces
	// literal — loopback is a hard invariant here, unlike codeflow's opt-in.
	idx := strings.Index(content, "\n  ui:")
	if idx < 0 {
		t.Fatal("ui service block not found in compose file")
	}
	uiBlock := content[idx:]
	for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
		if strings.Contains(uiBlock, forbidden) {
			t.Errorf("ui block must not contain %q (loopback is a hard invariant)", forbidden)
		}
	}

	uiPort := func(rendered string) string {
		t.Helper()
		ports, ok := composeService(t, rendered, "ui")["ports"].([]any)
		if !ok || len(ports) != 1 {
			t.Fatalf("ui must declare exactly one port mapping, got %v", ports)
		}
		// 3-segment colon spec stays quoted (yaml base-60 float parse guard).
		return ports[0].(string)
	}

	// Defaults unset → host loopback, container side 3000 (acceptance criterion).
	t.Setenv("PI_UI_PORT", "")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9500:3000" {
		t.Errorf("ui ports must pin host side to 127.0.0.1 and container side to 3000 by default, got %q", got)
	}

	// Explicit PI_UI_PORT override survives the loopback pin.
	t.Setenv("PI_UI_PORT", "9000")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9000:3000" {
		t.Errorf("PI_UI_PORT override must survive the loopback pin, got %q", got)
	}

	// Boundary: empty string falls back to the `:-` default.
	t.Setenv("PI_UI_PORT", "")
	if got := uiPort(renderComposeInterpolation(t, content)); got != "127.0.0.1:9500:3000" {
		t.Errorf("empty PI_UI_PORT must fall back to the 9500 default, got %q", got)
	}
}

func TestCompose_UIManagedShape(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	if got := svc["container_name"]; got != "${PI_UI_CONTAINER:-ui}" {
		t.Errorf("ui container_name = %v, want ${PI_UI_CONTAINER:-ui}", got)
	}
	if got := svc["restart"]; got != "unless-stopped" {
		t.Errorf("ui restart = %v, want unless-stopped", got)
	}
	labels, ok := svc["labels"].([]any)
	if !ok || len(labels) != 1 || labels[0] != managedLabel {
		t.Errorf("ui labels must be exactly [%s] (no spec stamp), got %v", managedLabel, labels)
	}
}

func TestCompose_UIMounts(t *testing.T) {
	svc := composeService(t, readCompose(t), "ui")
	vols, ok := svc["volumes"].([]any)
	if !ok {
		t.Fatalf("ui volumes missing, got %v", svc["volumes"])
	}
	want := []string{
		"${WORKSPACE_HOST_PATH}:/workspaces/main${VOLUME_RELABEL:-}",
		"~/.config/gh:/home/agentuser/.config/gh:ro${VOLUME_RELABEL:-}",
		"~/.config/cheasee-pi:/home/agentuser/.config/cheasee-pi:ro${VOLUME_RELABEL:-}",
	}
	for _, w := range want {
		if !slices.Contains(vols, any(w)) {
			t.Errorf("ui volumes must contain %q, got %v", w, vols)
		}
	}
}

func TestCompose_UINoDockerSock(t *testing.T) {
	if strings.Contains(readCompose(t), "/var/run/docker.sock") {
		t.Error("compose must not mount the docker socket (epic hard constraint)")
	}
}

func TestCompose_UIHealthcheck(t *testing.T) {
	content := readCompose(t)
	svc := composeService(t, content, "ui")
	hc, ok := svc["healthcheck"].(map[string]any)
	if !ok {
		t.Fatalf("ui healthcheck block missing, got %v", svc["healthcheck"])
	}
	test, ok := hc["test"].([]any)
	if !ok || len(test) == 0 {
		t.Fatalf("ui healthcheck.test missing, got %v", hc["test"])
	}
	joined := fmt.Sprint(test...)
	if !strings.Contains(joined, "http://127.0.0.1:3000/health") {
		t.Errorf("ui healthcheck must probe http://127.0.0.1:3000/health, got %q", joined)
	}
	for _, key := range []string{"interval", "retries", "start_period"} {
		if _, ok := hc[key]; !ok {
			t.Errorf("ui healthcheck must set %q, got %v", key, hc)
		}
	}

	// The raw ui block must not carry the banned host-seam literals (the
	// string-scanning TestCompose_UILoopbackOnly depends on it).
	idx := strings.Index(content, "\n  ui:")
	if idx < 0 {
		t.Fatal("ui service block not found in compose file")
	}
	uiBlock := content[idx:]
	for _, forbidden := range []string{"PI_UI_HOST_IP", "0.0.0.0"} {
		if strings.Contains(uiBlock, forbidden) {
			t.Errorf("ui block must not contain %q even in the healthcheck", forbidden)
		}
	}
}
