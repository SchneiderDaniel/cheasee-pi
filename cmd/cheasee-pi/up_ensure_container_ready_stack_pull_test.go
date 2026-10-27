package main

import (
	"context"
	"slices"
	"testing"
)

func TestEnsureStackUp_neverPullsAndEveryUpUsesPullNever(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.imageRefs = map[string]bool{}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	for _, args := range c.composeArgs {
		if slices.Contains(args, "pull") {
			t.Errorf("normal start must not run compose pull: %v", args)
		}
		if slices.Contains(args, "up") && (!slices.Contains(args, "--no-build") || !slices.Contains(args, "never")) {
			t.Errorf("create must use --no-build and --pull never: %v", args)
		}
	}
}
