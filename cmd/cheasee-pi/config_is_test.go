package main

import (
	"testing"
)

func TestIsReservedAuthKey(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"github_token", true},
		{"github_user", true},
		{"repo_path", true},
		{"api_key", true},
		{"openai", false},
		{"opencode-go", false},
		{"GitHub_Token", false}, // reserved set is case-sensitive
		{"", false},
	}
	for _, tc := range cases {
		if got := isReservedAuthKey(tc.key); got != tc.want {
			t.Errorf("isReservedAuthKey(%q) = %v, want %v", tc.key, got, tc.want)
		}
	}
}
