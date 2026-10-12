package main

import "io"

// ──────────────────────────────────────────────
// Mock: runner (single exec seam)
// ──────────────────────────────────────────────

type mockCmd struct {
	outputFn   func() ([]byte, error)
	combinedFn func() ([]byte, error)
	runFn      func() error
	// Captured Set* config, for callers that configure the command
	dir    string
	env    []string
	stdin  io.Reader
	stdout interface{ Write([]byte) (int, error) }
	stderr interface{ Write([]byte) (int, error) }
}

var _ runner = (*mockCmd)(nil)

func (m *mockCmd) Output() ([]byte, error) {
	if m.outputFn != nil {
		return m.outputFn()
	}
	return nil, nil
}

func (m *mockCmd) CombinedOutput() ([]byte, error) {
	if m.combinedFn != nil {
		return m.combinedFn()
	}
	return nil, nil
}
