package main

import (
	"context"
	"strings"
	"testing"
)

// imageExists adapter tests: docker image inspect exit-code translation.
// ──────────────────────────────────────────────

func TestImageExists_presentExitZero(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("[]"), nil }}
	})
	exists, err := imageExists(context.Background(), "cheasee-pi-ws-cheasee-pi")
	if err != nil {
		t.Fatalf("imageExists: %v", err)
	}
	if !exists {
		t.Error("exit 0 must mean the image exists")
	}
}

func TestImageExists_missingExitOneIsNotAnError(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(1) }}
	})
	exists, err := imageExists(context.Background(), "cheasee-pi-ws-cheasee-pi")
	if err != nil {
		t.Fatalf("exit 1 (no such image) must translate to missing, not an error: %v", err)
	}
	if exists {
		t.Error("exit 1 must mean the image is missing")
	}
}

func TestImageExists_otherExitFailsClosed(t *testing.T) {
	// Any non-1 non-zero exit is a daemon failure, never "missing" — the
	// Phase-2 docker check already passed, so the error is real.
	for _, code := range []int{2, 125} {
		stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
			return &mockCmd{outputFn: func() ([]byte, error) { return nil, exitStatusError(code) }}
		})
		exists, err := imageExists(context.Background(), "cheasee-pi-ws-cheasee-pi")
		if exists {
			t.Errorf("non-1 exit (%d) must never report present", code)
		}
		if err == nil {
			t.Fatalf("non-1 exit (%d) must surface as an error (fail-closed)", code)
		}
		if !strings.Contains(err.Error(), "docker image inspect") {
			t.Errorf("error must wrap the command, got %v", err)
		}
	}
}

func TestImageExists_exactCommandFormRefVerbatim(t *testing.T) {
	ref := "cheasee-pi-ws-cheasee-pi"
	var gotName string
	var gotArgs []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		gotName, gotArgs = name, arg
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("[]"), nil }}
	})
	if _, err := imageExists(context.Background(), ref); err != nil {
		t.Fatalf("imageExists: %v", err)
	}
	if gotName != "docker" {
		t.Errorf("must invoke docker, got %q", gotName)
	}
	want := []string{"image", "inspect", ref}
	if strings.Join(gotArgs, " ") != strings.Join(want, " ") {
		t.Errorf("args = [%s], want [%s] — exact form, ref passed verbatim", strings.Join(gotArgs, " "), strings.Join(want, " "))
	}
}
