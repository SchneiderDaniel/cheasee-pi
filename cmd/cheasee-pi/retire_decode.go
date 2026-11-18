package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Decoding half of the retirement: pi's `packages` array is undecoded JSON, so
// classification needs one tolerant pass over it.

// decodeRetireElements decodes pi's `packages` array. An element that names no
// source (a number, an array, null, an object without `source`) is kept with an
// empty Source — it is preserved untouched. An object whose `source` is present
// but not a JSON string is a hard error: the element cannot be classified, and
// guessing which package it names risks deleting user data.
func decodeRetireElements(packages []json.RawMessage) ([]retireElement, error) {
	elems := make([]retireElement, 0, len(packages))
	for i, raw := range packages {
		trimmed := bytes.TrimSpace(raw)
		switch {
		case len(trimmed) == 0:
			elems = append(elems, retireElement{})
		case trimmed[0] == '"':
			var source string
			if err := json.Unmarshal(trimmed, &source); err != nil {
				return nil, fmt.Errorf("packages[%d]: %w", i, err)
			}
			elems = append(elems, retireElement{Source: source})
		case trimmed[0] == '{':
			elem, err := decodeRetireObject(trimmed)
			if err != nil {
				return nil, fmt.Errorf("packages[%d]: %w", i, err)
			}
			elems = append(elems, elem)
		default:
			elems = append(elems, retireElement{})
		}
	}
	return elems, nil
}

// decodeRetireObject decodes one object-form element. A non-string-list `skills`
// value simply yields no filter, which means the element never matches the
// fingerprint — the safe direction, since it is then left alone.
func decodeRetireObject(raw []byte) (retireElement, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return retireElement{}, err
	}
	rawSource, ok := fields["source"]
	if !ok {
		return retireElement{Object: true}, nil
	}
	var source string
	if err := json.Unmarshal(rawSource, &source); err != nil {
		return retireElement{}, fmt.Errorf("`source` is not a JSON string: %w", err)
	}
	var skills []string
	if rawSkills, hasSkills := fields["skills"]; hasSkills {
		_ = json.Unmarshal(rawSkills, &skills)
	}
	return retireElement{Source: source, Skills: skills, Object: true}, nil
}

// mustDecodeRetireElements is decodeRetireElements for the already-validated
// case: retirePackages decodes once for the plan, and the --confirm fold reuses
// that guarantee instead of propagating an error it has already handled.
func mustDecodeRetireElements(packages []json.RawMessage) []retireElement {
	elems, err := decodeRetireElements(packages)
	if err != nil {
		// Unreachable: planRetirement ran the same decode and returned the error.
		return nil
	}
	return elems
}

// normalizeRepoSource reduces a package spec to `host/owner/repo` so the
// variant spellings pi accepts compare equal: scheme plus `git:` prefix, a
// scp-style `git@host:path`, a trailing slash, a `@ref` pin on the final path
// segment, a `.git` suffix, host case, plus the `owner/repo` shorthand (which pi
// expands to GitHub). It only decides whether anything still resolves to the
// retired repository — matching for removal stays exact.
func normalizeRepoSource(spec string) string {
	s := strings.ToLower(strings.TrimSpace(spec))
	s = strings.TrimPrefix(s, "git:")
	for _, scheme := range []string{"https://", "http://", "ssh://", "git://"} {
		s = strings.TrimPrefix(s, scheme)
	}
	if rest, ok := strings.CutPrefix(s, "git@"); ok {
		if host, path, found := strings.Cut(rest, ":"); found {
			s = host + "/" + path
		} else {
			s = rest
		}
	}
	s = strings.TrimSuffix(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		// A ref pin lives on the final path segment (`repo@v1`).
		if segment, _, hasRef := strings.Cut(s[i+1:], "@"); hasRef {
			s = s[:i+1] + segment
		}
	} else if segment, _, hasRef := strings.Cut(s, "@"); hasRef {
		s = segment
	}
	s = strings.TrimSuffix(s, ".git")
	s = strings.TrimSuffix(s, "/")
	if strings.Count(s, "/") == 1 {
		s = "github.com/" + s
	}
	return s
}
