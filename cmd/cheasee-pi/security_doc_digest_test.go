package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func securityDocSection(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "security.md"))
	if err != nil {
		t.Fatalf("reading docs/security.md: %v", err)
	}
	section, ok := markdownSection(string(data), "## Docker security")
	if !ok {
		t.Fatal("docs/security.md must contain a `## Docker security` section")
	}
	return section
}

func TestSecurityDoc_BaseImageDigestRotation(t *testing.T) {
	// The digest pins opt out of automatic base-image updates: without a stated
	// rotation procedure the images quietly age out of security fixes.
	section := securityDocSection(t)
	for _, want := range []string{
		"@sha256",
		"docker buildx imagetools inspect",
		"quarterly",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("docs/security.md §Docker security must document %q", want)
		}
	}
}

func TestSecurityDoc_CacheMountCaveat(t *testing.T) {
	// Cache mounts are per-builder and evictable: claiming they fix a cold
	// build would be wrong (they only cheapen a re-run of the same layer).
	section := securityDocSection(t)
	for _, want := range []string{"cache mount", "per-builder", "evict"} {
		if !strings.Contains(strings.ToLower(section), want) {
			t.Errorf("docs/security.md §Docker security must state %q", want)
		}
	}
}

func TestMarkdownSection_SlicesToNextHeading(t *testing.T) {
	doc := "# T\n\n## One\nalpha\n\n## Two\nbeta\n"
	got, ok := markdownSection(doc, "## One")
	if !ok || !strings.Contains(got, "alpha") || strings.Contains(got, "beta") {
		t.Errorf("section must stop at the next heading, got %q (ok=%v)", got, ok)
	}
	if _, ok := markdownSection(doc, "## Missing"); ok {
		t.Error("a missing heading must report ok=false")
	}
	tail, ok := markdownSection(doc, "## Two")
	if !ok || !strings.HasSuffix(tail, "beta\n") {
		t.Errorf("a trailing section must run to EOF, got %q (ok=%v)", tail, ok)
	}
}
