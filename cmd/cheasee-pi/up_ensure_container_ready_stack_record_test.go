package main

import (
	"context"
	"os"
	"testing"
)

func TestEnsureStackUp_commitRecordOnlyForAgentBuild(t *testing.T) {
	root, name, cacheDir, c := stackFixture(t)
	services := stackServices(root)
	record := cheaseeCommitCachePath(cacheDir, cheaseeImageRef(root))
	c.states = map[string]string{services[0].container: "running"}
	c.imageRefs = map[string]bool{services[1].image: false, services[2].image: true}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Errorf("sidecar-only build must not record the agent commit, got %v", err)
	}

	c2 := stubReadyFlow(t, root, func(context.Context, []string) runner { return &mockCmd{} })
	c2.states = nil
	c2.imageRefs = map[string]bool{}
	if err := ensureStackUp(context.Background(), cacheDir, root, name); err != nil {
		t.Fatalf("ensureStackUp: %v", err)
	}
	if _, err := os.Stat(record); err != nil {
		t.Errorf("agent build must record the baked commit, got %v", err)
	}
}
