package main

import (
	"context"
	"slices"
	"testing"
)

func TestPruneDanglingImages_GatedSkipsWhenEmpty(t *testing.T) {
	// Empty dangling list → the prune must not run (build/clean avoid a daemon
	// round-trip on every cached build).
	var recorded [][]string
	stubRunCommandContext(t, func(_ context.Context, name string, arg ...string) runner {
		if name != "docker" {
			return &mockCmd{}
		}
		recorded = append(recorded, append([]string(nil), arg...))
		return &mockCmd{} // docker images -q → empty
	})
	if err := pruneDanglingImages(context.Background(), true); err != nil {
		t.Fatalf("gated prune must swallow: %v", err)
	}
	if len(recorded) != 1 || !slices.Equal(recorded[0], []string{"images", "--filter", "dangling=true", "-q"}) {
		t.Errorf("gated prune with no dangling images must issue only the list query, got %v", recorded)
	}
}
