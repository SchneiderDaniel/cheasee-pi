package main

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestKillSessionByMarker_ctxReachesSeam(t *testing.T) {
	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	var seen context.Context
	stubRunCommandContext(t, func(got context.Context, _ string, _ ...string) runner {
		seen = got
		return &mockCmd{combinedFn: func() ([]byte, error) { return []byte(""), nil }}
	})

	if err := killSessionByMarker(ctx, "cheasee-pi", "deadbeef"); err != nil {
		t.Fatalf("killSessionByMarker: %v", err)
	}
	if seen.Value(ctxKey("test")) != "marker" {
		t.Errorf("seam did not receive the caller's ctx")
	}
}

// ──────────────────────────────────────────────
// up.go ports — containerHealth / extractGHToken / execPIContainer
// ──────────────────────────────────────────────

func TestContainerHealth_healthy(t *testing.T) {
	ctx := context.WithValue(context.Background(), ctxKey("test"), "marker")
	var seenCtx context.Context
	var seenArgs []string
	stubRunCommandContext(t, func(got context.Context, name string, arg ...string) runner {
		seenCtx = got
		seenArgs = append([]string{name}, arg...)
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("healthy\n"), nil }}
	})

	status, err := containerHealth(ctx, "cheasee-pi")
	if err != nil {
		t.Fatalf("containerHealth: %v", err)
	}
	if status != "healthy" {
		t.Errorf("status = %q, want %q", status, "healthy")
	}
	if seenCtx.Value(ctxKey("test")) != "marker" {
		t.Errorf("seam must receive the caller's ctx")
	}
	want := []string{"docker", "inspect", "--format", "{{.State.Health.Status}}", "cheasee-pi"}
	if !slices.Equal(seenArgs, want) {
		t.Errorf("seam args = %v, want %v", seenArgs, want)
	}
}

func TestContainerHealth_outputErrorWraps(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("daemon gone") }}
	})

	_, err := containerHealth(context.Background(), "cheasee-pi")
	if err == nil || !strings.Contains(err.Error(), "docker inspect: daemon gone") {
		t.Fatalf("output error must wrap as 'docker inspect: ...', got %v", err)
	}
}

func TestExtractGHToken_trimsOutput(t *testing.T) {
	var seenArgs []string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		seenArgs = append([]string{name}, arg...)
		return &mockCmd{outputFn: func() ([]byte, error) { return []byte("gh_token_123\n"), nil }}
	})

	token, err := extractGHToken()
	if err != nil {
		t.Fatalf("extractGHToken: %v", err)
	}
	if token != "gh_token_123" {
		t.Errorf("token = %q, want trimmed %q", token, "gh_token_123")
	}
	want := []string{"gh", "auth", "token"}
	if !slices.Equal(seenArgs, want) {
		t.Errorf("seam args = %v, want %v", seenArgs, want)
	}
}

func TestExtractGHToken_errorPropagatesUnwrapped(t *testing.T) {
	stubRunCommandContext(t, func(_ context.Context, _ string, _ ...string) runner {
		return &mockCmd{outputFn: func() ([]byte, error) { return nil, fmt.Errorf("not logged in") }}
	})

	_, err := extractGHToken()
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("gh failure must propagate, got %v", err)
	}
}
