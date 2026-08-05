package main

import (
	"math"
	"strings"
	"testing"
)

// This file is the single sanctioned home for every credential-shaped value
// used by the test suite. Values are deliberately prefix-free and
// low-entropy so no secret scanner (gitleaks default rules, entropy
// thresholds) can match them. The _test.go suffix guarantees they never
// compile into the production binary.

const FakeAPIKey = "fakevalue101" // gitleaks:allow

const FakeAPIKeyAlt = "fakevalue202" // gitleaks:allow

const FakeGitHubToken = "fakevalue303" // gitleaks:allow

const FakeUpAPIKey = "fakevalue404" // gitleaks:allow

// FakeKeyPrefixes lists key prefixes the auth-envvars shell output must
// never contain; it is the negative-match pattern for
// TestAuthEnvvars_noSecretValues.
var FakeKeyPrefixes = []string{"sk-", "sk-ant"} // gitleaks:allow

func TestFixtures_ValuesAreScannerSafe(t *testing.T) {
	prefixes := []string{"sk-", "gho_", "ghp_", "ghu_", "ghs_", "ghr_", "github_pat_"}
	values := map[string]string{
		"FakeAPIKey":      FakeAPIKey,
		"FakeAPIKeyAlt":   FakeAPIKeyAlt,
		"FakeGitHubToken": FakeGitHubToken,
		"FakeUpAPIKey":    FakeUpAPIKey,
	}
	for name, v := range values {
		if v == "" {
			t.Errorf("%s is empty", name)
		}
		for _, p := range prefixes {
			if strings.HasPrefix(v, p) {
				t.Errorf("%s = %q starts with scanner prefix %q", name, v, p)
			}
		}
		if strings.Contains(v, "T3BlbkFJ") {
			t.Errorf("%s contains the OpenAI base64 marker", name)
		}
		if e := shannonEntropy(v); e >= 3.5 {
			t.Errorf("%s entropy %.3f >= 3.5 (scanner-matchable)", name, e)
		}
	}
}

func TestFixtures_ValuesAreDistinct(t *testing.T) {
	values := map[string]string{
		"FakeAPIKey":      FakeAPIKey,
		"FakeAPIKeyAlt":   FakeAPIKeyAlt,
		"FakeGitHubToken": FakeGitHubToken,
		"FakeUpAPIKey":    FakeUpAPIKey,
	}
	for a, av := range values {
		for b, bv := range values {
			if a < b && av == bv {
				t.Errorf("%s == %s == %q; fixture values must be pairwise distinct", a, b, av)
			}
		}
	}
}

func TestFixtures_KeyPrefixesNonEmpty(t *testing.T) {
	if len(FakeKeyPrefixes) == 0 {
		t.Fatal("FakeKeyPrefixes must not be empty")
	}
	for _, p := range FakeKeyPrefixes {
		if p == "" {
			t.Error("FakeKeyPrefixes contains an empty element")
		}
	}
}

// shannonEntropy computes the Shannon entropy (bits per symbol) of s.
func shannonEntropy(s string) float64 {
	counts := make(map[rune]int, len(s))
	for _, r := range s {
		counts[r]++
	}
	h := 0.0
	n := float64(len(s))
	for _, c := range counts {
		p := float64(c) / n
		h -= p * math.Log2(p)
	}
	return h
}
