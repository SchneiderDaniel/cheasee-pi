package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUIHint_singleSourceStatic(t *testing.T) {
	// The URL literal must live only in ui_hint.go; the two up_run.go branches
	// must not drift back to duplicated prints.
	upRun, err := os.ReadFile("up_run.go")
	if err != nil {
		t.Fatalf("read up_run.go: %v", err)
	}
	if strings.Contains(string(upRun), "http://127.0.0.1:") {
		t.Error("up_run.go must not contain the UI URL literal — call printUIHint instead")
	}
	if !strings.Contains(string(upRun), "PI_UI_PORT") {
		t.Error("up_run.go must forward the resolved UI port as PI_UI_PORT to the exec env")
	}
	hint, err := os.ReadFile("ui_hint.go")
	if err != nil {
		t.Fatalf("read ui_hint.go: %v", err)
	}
	if !strings.Contains(string(hint), "http://127.0.0.1:") {
		t.Error("ui_hint.go must own the UI URL literal")
	}
}

func TestDailyUsageDoc_uiHint(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "daily-usage.md"))
	if err != nil {
		t.Fatalf("reading docs/daily-usage.md: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "http://127.0.0.1:") {
		t.Error("daily-usage.md §UI must show the literal 127.0.0.1 URL")
	}
	for _, want := range []string{"9500", "10523", "docker.uiPort", "PI_UI_PORT", "UI · CodeFlow"} {
		if !strings.Contains(content, want) {
			t.Errorf("daily-usage.md §UI must mention %q", want)
		}
	}
	if !strings.Contains(content, "PI_UI_PORT") || !strings.Contains(content, "forwarded") {
		t.Error("daily-usage.md §UI must state that PI_UI_PORT is forwarded into the session")
	}
	// Click contract (audit finding): the footer group is a host-terminal OSC 8
	// hyperlink; the host terminal is the opener, pi does not intercept the
	// click, and the in-container network namespace is documented as a non-goal.
	// Pin the wording so the contract cannot silently drift.
	for _, want := range []string{"OSC 8", "host terminal", "does not intercept", "control characters"} {
		if !strings.Contains(strings.ToLower(content), strings.ToLower(want)) {
			t.Errorf("daily-usage.md §UI must document the OSC 8 host-terminal click contract (%q)", want)
		}
	}
	// Suppression contract (audit finding): on CLI resolution failure PI_UI_PORT
	// is omitted and the separate marker is set, so docker exec never sees a bare
	// PI_UI_PORT=; the footer drops the UI link, while an absent key (no CLI)
	// keeps the derived fallback.
	for _, want := range []string{"omits", "CHEASEE_UI_PORT_UNRESOLVED", "suppresses", "started outside the CLI", "no marker"} {
		if !strings.Contains(content, want) {
			t.Errorf("daily-usage.md §UI must document the resolution-failure suppression (%q)", want)
		}
	}
}
