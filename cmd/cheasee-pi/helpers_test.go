package main

import (
	"context"
	"github.com/cli/oauth/api"
	"github.com/cli/oauth/device"
	"strings"
	"testing"
)

// ──────────────────────────────────────────────
// Mock: Authenticator
// ──────────────────────────────────────────────

// MockGitHubUser is the deterministic login the mock Authenticator.User stub
// returns by default — both init entry points share it, keeping the
// auto-init byte-identity contract deterministic.
const MockGitHubUser = "octocat"

type mockAuthenticator struct {
	requestCodeFunc func(ctx context.Context, scopes []string) (*device.CodeResponse, error)
	waitFunc        func(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error)
	userFunc        func(ctx context.Context, token string) (string, error)
}

func (m *mockAuthenticator) RequestCode(ctx context.Context, scopes []string) (*device.CodeResponse, error) {
	if m.requestCodeFunc != nil {
		return m.requestCodeFunc(ctx, scopes)
	}
	return &device.CodeResponse{
		UserCode:        "ABCD-1234",
		DeviceCode:      "test-device-code",
		VerificationURI: "https://github.com/login/device",
		Interval:        5,
		ExpiresIn:       900,
	}, nil
}

func (m *mockAuthenticator) Wait(ctx context.Context, code *device.CodeResponse) (*api.AccessToken, error) {
	if m.waitFunc != nil {
		return m.waitFunc(ctx, code)
	}
	return &api.AccessToken{Token: FakeGitHubToken}, nil
}

func (m *mockAuthenticator) User(ctx context.Context, token string) (string, error) {
	if m.userFunc != nil {
		return m.userFunc(ctx, token)
	}
	return MockGitHubUser, nil
}

// ──────────────────────────────────────────────
// Mock: ConfirmFn
// ──────────────────────────────────────────────

// mockConfirmFn returns a confirm function that returns the given result.
// mockConfirmFn creates a mock confirm function.
// If exceptions are provided, any question whose title contains one of the
// exception substrings returns !result instead of result.

func mockConfirmFn(result bool, err error, exceptions ...string) func(string) (bool, error) {
	return func(title string) (bool, error) {
		for _, exc := range exceptions {
			if strings.Contains(title, exc) {
				return !result, err
			}
		}
		return result, err
	}
}

// ──────────────────────────────────────────────
// Mock: InputFn
// ──────────────────────────────────────────────

// mockInputFn returns an input function that returns the given result.

func mockInputFn(result string, err error) func(title, placeholder string) (string, error) {
	return func(title, placeholder string) (string, error) {
		return result, err
	}
}

// promptCall records one InputFn invocation (title + placeholder) for the
// capturing-input mock below.

type promptCall struct {
	title       string
	placeholder string
}

// captureInputFn returns an input function that records every call's
// title+placeholder pair and yields the given results in order (queue
// exhaustion → "", nil). Used to lock the init prompt strings, which the
// other mocks ignore.

func captureInputFn(t *testing.T, results ...string) (func(string, string) (string, error), *[]promptCall) {
	t.Helper()
	calls := &[]promptCall{}
	i := 0
	return func(title, placeholder string) (string, error) {
		*calls = append(*calls, promptCall{title: title, placeholder: placeholder})
		if i >= len(results) {
			return "", nil
		}
		next := results[i]
		i++
		return next, nil
	}, calls
}

// ──────────────────────────────────────────────
// Custom skill repositories (init Phase 6b) flow helper
// ──────────────────────────────────────────────

// skillRepoFlowDeps builds the full interactive init deps with a queue-based
// prompt mock: the first InputFn call answers the repo URL prompt, remaining
// inputs feed the skill-repo loop; the first confirm answers "Add a custom
// skill repository?", a false terminates the loop, and the API-key confirm
// falls through to the exhausted-queue default (false → skip).

func skillRepoFlowDeps(t *testing.T, workdir string, confirms []bool, inputs []string) InitDeps {
	t.Helper()
	confirm, input := mockQueuePrompt(t, confirms, inputs)
	return initDeps(t, func(d *InitDeps) {
		d.Workdir = workdir
		d.NoInput = false
		d.ConfirmFn = confirm
		d.InputFn = input
	})
}

// ──────────────────────────────────────────────
// Mock: queue-based prompt (successive ConfirmFn/InputFn results)
// ──────────────────────────────────────────────

// mockQueuePrompt returns a confirm/input pair that yield successive results
// from the pre-filled queues — the skill-repo prompt loop alternates
// confirm/input (yes → spec → yes → spec → no), and each queue is exhausted
// to a safe default (false / "") so a loop that prompts one extra time
// terminates instead of hanging. Used by the runInitSkillRepos and full-flow
// tests.

func mockQueuePrompt(t *testing.T, confirms []bool, inputs []string) (func(string) (bool, error), func(string, string) (string, error)) {
	t.Helper()
	q := &queuePrompt{confirms: confirms, inputs: inputs}
	return q.confirm, q.input
}

type queuePrompt struct {
	confirms []bool
	inputs   []string
}

func (q *queuePrompt) confirm(string) (bool, error) {
	if len(q.confirms) == 0 {
		return false, nil
	}
	next := q.confirms[0]
	q.confirms = q.confirms[1:]
	return next, nil
}

func (q *queuePrompt) input(string, string) (string, error) {
	if len(q.inputs) == 0 {
		return "", nil
	}
	next := q.inputs[0]
	q.inputs = q.inputs[1:]
	return next, nil
}

// ──────────────────────────────────────────────
// Mock: ModelCatalog
// ──────────────────────────────────────────────

// mockModelCatalog is a fixed-list ModelCatalog stub. The zero value returns
// (nil, nil), which modelsFor/modelChoice treat as "no live list" → the
// KnownModels seed (the offline path).

type mockModelCatalog struct {
	models []string
	err    error
}
