package main

import (
	"context"
	"testing"
	"time"
)

func (m *mockModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	return m.models, m.err
}

// countingModelCatalog is a fixed-list ModelCatalog stub that counts
// consultations — the single-lookup regression tests assert exactly one
// consultation per provider invocation (the pre-audit code consulted twice,
// doubling the fetch/retry loop on a failing pi.dev request).

type countingModelCatalog struct {
	models []string
	err    error
	calls  int
}

func (c *countingModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	c.calls++
	return c.models, c.err
}

// slowModelCatalog is a stub whose consultation sleeps before failing — the
// call-site timeout regression asserts a stalled catalog delays auth/init by
// ONE consultation, not two.

type slowModelCatalog struct {
	delay time.Duration
	err   error
	calls int
}

func (c *slowModelCatalog) Models(ctx context.Context, provider string) ([]string, error) {
	c.calls++
	time.Sleep(c.delay)
	return nil, c.err
}

// stubModelCatalog replaces the newModelCatalog seam (newInitDeps precedent)
// for the duration of the test, so auth/init flows run without a real fetch.

func stubModelCatalog(t *testing.T, models []string, err error) {
	t.Helper()
	saved := newModelCatalog
	newModelCatalog = func() ModelCatalog { return &mockModelCatalog{models: models, err: err} }
	t.Cleanup(func() { newModelCatalog = saved })
}

// stubPromptProvider replaces the provider-picker seam for the duration of
// the test (huh TTY calls hang tests, same reason as runCommandContext).

func stubPromptProvider(t *testing.T, fn func() (string, error)) {
	t.Helper()
	saved := promptProvider
	promptProvider = fn
	t.Cleanup(func() { promptProvider = saved })
}

// stubPromptAPIKey replaces the API-key prompt seam for the duration of the
// test.

func stubPromptAPIKey(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	saved := promptAPIKeyForProvider
	promptAPIKeyForProvider = fn
	t.Cleanup(func() { promptAPIKeyForProvider = saved })
}

// stubPromptModel replaces the model-picker seam for the duration of the test.

func stubPromptModel(t *testing.T, fn func(string, []string) (string, error)) {
	t.Helper()
	saved := promptModel
	promptModel = fn
	t.Cleanup(func() { promptModel = saved })
}

// withAuthAddFlags pins the package-level auth add flags (workdir + --no-input)
// for the duration of the test, mirroring withAuthListWorkdir.

func withAuthAddFlags(t *testing.T, workdir string, noInput bool) {
	t.Helper()
	savedWorkdir, savedNoInput := authAddWorkdir, authAddNoInput
	authAddWorkdir, authAddNoInput = workdir, noInput
	t.Cleanup(func() { authAddWorkdir, authAddNoInput = savedWorkdir, savedNoInput })
}

// ──────────────────────────────────────────────
// Catalog fixtures (remoteModelCatalog adapter tests)
// ──────────────────────────────────────────────

// catalogPlainMap is a canned plain-object-map catalog response (the live
// endpoint's shape), keys deliberately unsorted to prove Models() returns
// deterministic lexicographic order.

const catalogPlainMap = `{
  "zebra-model": {"id": "zebra-model", "name": "Zebra"},
  "alpha-model": {"id": "alpha-model", "name": "Alpha"},
  "mike-model":  {"id": "mike-model",  "name": "Mike"}
}`
