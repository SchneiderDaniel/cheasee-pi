package main

import (
	"maps"
	"testing"
)

// sessionEnv owns the per-run env: the provider keys buildEnvFlags produced
// plus the four keys a start resolves for itself. These tests pin the type
// contract only — no docker, no workspace.
// ──────────────────────────────────────────────

func TestSessionEnv_zeroValueIsNonNilAndEmpty(t *testing.T) {
	var env sessionEnv
	got := env.Map()
	if got == nil {
		t.Fatal("zero sessionEnv.Map() must be non-nil")
	}
	if len(got) != 0 {
		t.Errorf("zero sessionEnv.Map() = %v, want an empty map", got)
	}
}

func TestSessionEnv_typedSettersAddExactlyTheirKey(t *testing.T) {
	env := newSessionEnv(nil)
	steps := []struct {
		name string
		set  func()
		want map[string]string
	}{
		{"setCodeflowPort", func() { env.setCodeflowPort("8891") },
			map[string]string{"CODEFLOW_PORT": "8891"}},
		{"setSessionID", func() { env.setSessionID("sid-1") },
			map[string]string{"CODEFLOW_PORT": "8891", "CHEASEE_SESSION_ID": "sid-1"}},
		{"setUIPort", func() { env.setUIPort("9500") },
			map[string]string{"CODEFLOW_PORT": "8891", "CHEASEE_SESSION_ID": "sid-1",
				"PI_UI_PORT": "9500"}},
	}
	for _, step := range steps {
		step.set()
		if got := env.Map(); !maps.Equal(got, step.want) {
			t.Errorf("after %s: Map() = %v, want %v", step.name, got, step.want)
		}
	}
	if !maps.Equal(env.Map(), env.Map()) {
		t.Error("Map() must return equal maps on repeated calls")
	}
}

func TestSessionEnv_keepsProviderKeysAndHandsOutACopy(t *testing.T) {
	base := map[string]string{"ANTHROPIC_API_KEY": "session-key"}
	env := newSessionEnv(base)
	env.setSessionID("sid-1")

	want := map[string]string{
		"ANTHROPIC_API_KEY":  "session-key",
		"CHEASEE_SESSION_ID": "sid-1",
	}
	got := env.Map()
	if !maps.Equal(got, want) {
		t.Errorf("Map() = %v, want %v", got, want)
	}
	if len(base) != 1 {
		t.Errorf("sessionEnv must not write the run keys into the caller's map, got %v", base)
	}
	got["LEAK"] = "x"
	if _, ok := env.Map()["LEAK"]; ok {
		t.Error("Map() must hand out a copy, not the internal map")
	}
}

func TestSessionEnv_codeflowPortLastWriteWins(t *testing.T) {
	env := newSessionEnv(nil)
	env.setCodeflowPort("8891") // pre-start resolve
	env.setCodeflowPort("8893") // bound port after the container start
	got := env.Map()
	if len(got) != 1 || got["CODEFLOW_PORT"] != "8893" {
		t.Errorf("Map() = %v, want exactly CODEFLOW_PORT=8893", got)
	}
}

func TestSessionEnv_unresolvedUIOmitsThePortKey(t *testing.T) {
	env := newSessionEnv(nil)
	env.setUIPort("9500") // resolved first, then the resolution failed
	env.markUIUnresolved()

	got := env.Map()
	if _, ok := got["PI_UI_PORT"]; ok {
		t.Errorf("an unresolved UI port must never forward PI_UI_PORT, got %v", got)
	}
	if got["CHEASEE_UI_PORT_UNRESOLVED"] != "1" {
		t.Errorf("Map() = %v, want CHEASEE_UI_PORT_UNRESOLVED=1", got)
	}
}

func TestSessionEnv_resolvedUIClearsTheFailureMarker(t *testing.T) {
	env := newSessionEnv(nil)
	env.markUIUnresolved()
	env.setUIPort("9500")

	got := env.Map()
	if _, ok := got["CHEASEE_UI_PORT_UNRESOLVED"]; ok {
		t.Errorf("a resolved UI port must clear the failure marker, got %v", got)
	}
	if got["PI_UI_PORT"] != "9500" {
		t.Errorf("Map() = %v, want PI_UI_PORT=9500", got)
	}
}

func TestStartOptions_derivesTheNameAtTheSeam(t *testing.T) {
	root := t.TempDir()
	// A stale package global must not leak into the derivation.
	saved := upName
	upName = "stale-global"
	t.Cleanup(func() { upName = saved })

	if got, want := (startOptions{}).resolveName(root), containerName(root); got != want {
		t.Errorf("resolveName(root) with an empty Name = %q, want the derived %q", got, want)
	}
	if got := (startOptions{Name: "custom"}).resolveName(root); got != "custom" {
		t.Errorf("resolveName(root) with Name=custom = %q, want it verbatim", got)
	}
}
