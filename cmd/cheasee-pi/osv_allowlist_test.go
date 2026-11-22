package main

import (
	"strconv"
	"strings"
	"testing"
)

// The UI crate's two unmaintained-only advisories are accepted risk (docs/sbom.md).
// osv-scanner only honours an allowlist it can find next to the scanned lockfile,
// so the file position is the contract that makes the acceptance effective.
// ──────────────────────────────────────────────

func TestUIOsvAllowlist_NextToScannedLockfile(t *testing.T) {
	if _, ok := cargoLockVersions(t)["paste"]; !ok {
		t.Fatal("ui/Cargo.lock no longer lists paste — drop the RUSTSEC-2024-0436 allowlist entry")
	}
	if _, ok := cargoLockVersions(t)["proc-macro-error2"]; !ok {
		t.Fatal("ui/Cargo.lock no longer lists proc-macro-error2 — drop the RUSTSEC-2026-0173 allowlist entry")
	}
}

// cargoLockVersions maps crate name → version from the committed ui/Cargo.lock.
func cargoLockVersions(t *testing.T) map[string]string {
	t.Helper()
	versions := map[string]string{}
	var name string
	for _, line := range strings.Split(uiAsset(t, "Cargo.lock"), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "name = "); ok {
			name = strings.Trim(v, `"`)
			continue
		}
		if v, ok := strings.CutPrefix(line, "version = "); ok && name != "" {
			versions[name] = strings.Trim(v, `"`)
			name = ""
		}
	}
	return versions
}

func TestUIOsvAllowlist_EntriesCarryReasonAndExpiry(t *testing.T) {
	content := uiAsset(t, "osv-scanner.toml")
	blocks := strings.Split(content, "[[IgnoredVulns]]")[1:]
	if len(blocks) != 2 {
		t.Fatalf("expected the two accepted advisories in embedded/docker/ui/osv-scanner.toml, got %d entries", len(blocks))
	}
	for _, id := range []string{"RUSTSEC-2024-0436", "RUSTSEC-2026-0173"} {
		if !strings.Contains(content, `id = "`+id+`"`) {
			t.Errorf("allowlist lost %s — the finding returns to every scan", id)
		}
		if !strings.Contains(sbomDoc(t), id) {
			t.Errorf("docs/sbom.md does not document %s; the allowlist must stay traceable to the written acceptance", id)
		}
	}
	for _, block := range blocks {
		if !strings.Contains(block, "ignoreUntil = ") {
			t.Error("allowlist entry without ignoreUntil can never be re-reviewed")
		}
		if !strings.Contains(block, "reason = ") {
			t.Error("allowlist entry without reason is an unexplained suppression")
		}
	}
}

// `url` 2.5.8 (RUSTSEC-2026-0592: stack overflow in `Url::origin()` on nested
// `blob:` URLs) reached the lock through leptos_router and server_fn. The
// advisory HAS a patched release, unlike the two unmaintained crates above, so
// accepted risk is not the remedy: the lock must pin the fixed line and the
// allowlist must never carry a suppression for it.
func TestUIOsvAllowlist_UrlAdvisoryFixedInLockfile(t *testing.T) {
	version, ok := cargoLockVersions(t)["url"]
	if !ok {
		t.Fatal("ui/Cargo.lock no longer lists url — delete this guard with the dependency")
	}
	if cmp, ok := compareDottedVersions(version, "2.5.9"); !ok {
		t.Fatalf("url version %q is not dotted-numeric", version)
	} else if cmp < 0 {
		t.Errorf("ui/Cargo.lock pins url %s; RUSTSEC-2026-0592 is fixed in 2.5.9 (Url::origin on nested blob: URLs overflows the stack and aborts the process)", version)
	}
	if strings.Contains(uiAsset(t, "osv-scanner.toml"), "RUSTSEC-2026-0592") {
		t.Error("the url advisory has a patched release — bump the lock instead of accepting it in osv-scanner.toml")
	}
}

// compareDottedVersions compares two dotted-numeric versions ("2.5.9" vs
// "2.5.10") without pulling a semver library into the CLI. ok=false when either
// side carries a non-numeric component (a prerelease, which no lock here uses).
func compareDottedVersions(a, b string) (int, bool) {
	parse := func(v string) ([]int, bool) {
		parts := strings.Split(v, ".")
		out := make([]int, len(parts))
		for i, part := range parts {
			n, err := strconv.Atoi(part)
			if err != nil {
				return nil, false
			}
			out[i] = n
		}
		return out, true
	}
	left, okLeft := parse(a)
	right, okRight := parse(b)
	if !okLeft || !okRight {
		return 0, false
	}
	for len(left) < len(right) {
		left = append(left, 0)
	}
	for len(right) < len(left) {
		right = append(right, 0)
	}
	for i := range left {
		if left[i] != right[i] {
			if left[i] < right[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

// The allowlist is build-context noise if a COPY ever sweeps it into a layer.
func TestUIOsvAllowlist_NotCopiedIntoAnImage(t *testing.T) {
	for _, line := range strings.Split(dockerfileAt(t, "ui/Dockerfile"), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "COPY .") || strings.Contains(line, "osv-scanner.toml") {
			t.Errorf("ui/Dockerfile copies the allowlist into an image layer: %s", line)
		}
	}
}

func sbomDoc(t *testing.T) string {
	t.Helper()
	return readRepoFile(t, "docs/sbom.md")
}
