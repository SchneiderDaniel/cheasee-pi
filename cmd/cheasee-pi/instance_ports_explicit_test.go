package main

import (
	"strconv"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 2 (cont.): explicit ports win, exhaustion fails closed
//
// An operator-set port (env var or cheasee-settings.json) is never probed, and a
// fully occupied band fails closed with an error naming the knob.
// ──────────────────────────────────────────────

func TestDiscovery_hostPortExplicitWins(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings string
		want     string
	}{
		{"env var", `{}`, "9700"},
		{"settings beat env", `{"docker":{"uiPort":"9800"}}`, "9800"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probes := stubPortProbe(t, true)
			_, root := mkWorkspace(t, tc.settings)
			t.Setenv("PI_UI_PORT", "9700")
			got, err := uiHostPort(root)
			discoveryRequireNoErr(t, "uiHostPort", err)
			if got != tc.want {
				t.Errorf("uiHostPort = %q, want %q", got, tc.want)
			}
			if *probes != 0 {
				t.Errorf("an explicit port must never probe, probed %d times", *probes)
			}
		})
	}
}

func TestDiscovery_hostPortRangeExhaustionFailsClosed(t *testing.T) {
	stubPortProbe(t, false)
	_, root := mkWorkspace(t, `{}`)
	t.Setenv("PI_UI_PORT", "")
	t.Setenv("CODEFLOW_PORT", "")

	for _, tc := range []struct {
		what, envVar string
		resolve      func(string) (string, error)
		band         int
	}{
		{"UI", "PI_UI_PORT", uiHostPort, uiPortBase},
		{"CodeFlow", "CODEFLOW_PORT", codeflowHostPort, codeflowPortBase},
	} {
		_, err := tc.resolve(root)
		if err == nil {
			t.Fatalf("an exhausted %s port band must fail closed, got nil error", tc.what)
		}
		want := []string{tc.envVar, strconv.Itoa(tc.band)}
		discoveryRequireContains(t, tc.what+" exhaustion error", err.Error(), want...)
	}
}
