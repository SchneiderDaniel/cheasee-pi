package main

import (
	"slices"
	"strings"
	"testing"
)

func TestAllEnvVarNames_distinctNonEmptyUnion(t *testing.T) {
	names := AllEnvVarNames()
	if len(names) == 0 {
		t.Fatal("AllEnvVarNames returned empty")
	}
	if !slices.IsSorted(names) {
		t.Errorf("AllEnvVarNames not sorted: %v", names)
	}

	seen := make(map[string]bool)
	for _, n := range names {
		if n == "" {
			t.Error("AllEnvVarNames contains an empty name")
		}
		if seen[n] {
			t.Errorf("AllEnvVarNames contains duplicate %q", n)
		}
		seen[n] = true
	}

	aliasVals := make(map[string]bool)
	for _, v := range ProviderEnvAliases() {
		if v != "" {
			aliasVals[v] = true
		}
	}
	for v := range aliasVals {
		if !seen[v] {
			t.Errorf("AllEnvVarNames missing provider env var %q", v)
		}
	}
	for _, n := range ProviderPassthroughNames {
		if !seen[n] {
			t.Errorf("AllEnvVarNames missing passthrough env var %q", n)
		}
	}
}

func TestProviderPassthroughNames_nonProviderOnly(t *testing.T) {
	want := []string{"GH_TOKEN", "CLOUDFLARE_ACCOUNT_ID"}
	if !slices.Equal(ProviderPassthroughNames, want) {
		t.Errorf("ProviderPassthroughNames = %v, want %v", ProviderPassthroughNames, want)
	}

	aliasVals := make(map[string]bool)
	for _, v := range ProviderEnvAliases() {
		aliasVals[v] = true
	}
	for _, n := range ProviderPassthroughNames {
		if aliasVals[n] {
			t.Errorf("passthrough name %q duplicates a provider env var", n)
		}
	}
}

func TestRedactSecret(t *testing.T) {
	if got := redactSecret("0123456789abc"); got != "0123...9abc" {
		t.Errorf("long value should be first4...last4, got %q", got)
	}
	if got := redactSecret("12345678"); got != "12345678" {
		t.Errorf("8-char value should print in full, got %q", got)
	}
	if got := redactSecret(""); got != "" {
		t.Errorf("empty value should print in full, got %q", got)
	}
}

func TestMaskKey(t *testing.T) {
	if got := maskKey("0123456789abc"); got != "0123...9abc" {
		t.Errorf("long key should be first4...last4, got %q", got)
	}
	if got := maskKey("12345678"); got != "****" {
		t.Errorf("8-char key must be fully masked, got %q", got)
	}
	if got := maskKey(""); got != "****" {
		t.Errorf("empty key must be fully masked, got %q", got)
	}
}

func TestTmpCleanFindArgs_whitelistOnlyMaxdepthOne(t *testing.T) {
	args := tmpCleanFindArgs()
	// maxdepth 1 + whitelist: the cleanup never recurses or sweeps mounts
	if args[0] != "-maxdepth" || args[1] != "1" {
		t.Fatalf("find args must start with -maxdepth 1, got %v", args[:2])
	}
	joined := strings.Join(args, " ")
	for _, p := range tmpCleanPatterns {
		if !strings.Contains(joined, "-name "+p) {
			t.Errorf("pattern %q missing from find args", p)
		}
	}
	if !strings.Contains(joined, "-exec rm -rf -- {} +") {
		t.Errorf("find args must use -exec rm -rf -- {} +, got: %s", joined)
	}
	// no bare "*" pattern: an unanchored glob would wipe unrelated /tmp files
	if strings.Contains(joined, "-name *") {
		t.Errorf("find args contain unanchored glob")
	}
	// `pi-session-*` holds LIVE supervisor subagent session dirs (created by
	// execute-agent.ts and passed to a running nested pi). Sweeping them on a
	// concurrent `cheasee-pi start` deletes the session file mid-run and the
	// agent dies with ENOENT. Guard the prefix explicitly, not just via the loop.
	for _, p := range tmpCleanPatterns {
		if strings.HasPrefix(p, "pi-session") {
			t.Errorf("tmpCleanPatterns must not include %q — it sweeps live subagent session dirs", p)
		}
	}
}
