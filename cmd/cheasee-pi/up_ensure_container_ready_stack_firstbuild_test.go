package main

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
)

func TestEnsureStackUp_noImagesPrintsFirstBuildNoticeOnce(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	c.imageRefs = map[string]bool{}

	stderr := testutil.CaptureStderr(t, func() {
		if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
			t.Fatalf("ensureStackUp: %v", err)
		}
	})
	if got := c.composeArgs[0][len(c.composeArgs[0])-3:]; !slices.Equal(got, []string{"cheasee-pi", "codeflow", "ui"}) {
		t.Errorf("all absent images must build all services, got %v", got)
	}
	if strings.Count(stderr, "First start downloads") != 1 {
		t.Errorf("first-build notice should print once, got %q", stderr)
	}
}
