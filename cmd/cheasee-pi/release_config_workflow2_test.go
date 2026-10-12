package main

import (
	"os"
	"strings"
	"testing"
)

func TestWorkflow_ActionVersionsCurrent(t *testing.T) {
	data, err := os.ReadFile(workflowPath())
	if err != nil {
		t.Fatalf("reading release.yml: %v", err)
	}
	content := string(data)

	// actions/checkout should be @v4 or newer
	if strings.Contains(content, "actions/checkout@v3") || strings.Contains(content, "actions/checkout@v2") || strings.Contains(content, "actions/checkout@v1") {
		t.Error("actions/checkout version is too old; use @v4 or newer")
	}
	// actions/setup-go should be @v5 or newer
	if strings.Contains(content, "actions/setup-go@v4") || strings.Contains(content, "actions/setup-go@v3") || strings.Contains(content, "actions/setup-go@v2") || strings.Contains(content, "actions/setup-go@v1") {
		t.Error("actions/setup-go version is too old; use @v5 or newer")
	}
	// goreleaser-action should be @v7 or newer (required for version: 2 config compatibility)
	if strings.Contains(content, "goreleaser/goreleaser-action@v6") || strings.Contains(content, "goreleaser/goreleaser-action@v5") || strings.Contains(content, "goreleaser/goreleaser-action@v4") || strings.Contains(content, "goreleaser/goreleaser-action@v3") || strings.Contains(content, "goreleaser/goreleaser-action@v2") || strings.Contains(content, "goreleaser/goreleaser-action@v1") {
		t.Error("goreleaser/goreleaser-action must be @v7 or newer (v7 defaults to ~> v2, matching .goreleaser.yml version: 2)")
	}
}
