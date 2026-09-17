package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ──────────────────────────────────────────────
// CodeFlow sidecar drift detection
//
// `cheasee-pi start` skips `docker compose up` on an already-running
// container — locked in by TestRunUpE_containerRunningSkipsComposeUp, start
// must not surprise-rebuild. The sidecar can still drift from the current
// CLI/config: a newer CLI extracts a new version-keyed cache dir (new
// codeflow/config.json bind source), the workspace docker.codeflowPort can
// change, or config.json content can change in place. warnIfCodeflowDrift
// compares the LIVE sidecar (one docker inspect) against the freshly
// resolved expected state and warns on stderr with the exact recovery
// command — never auto-recreating and never invoking compose on the running
// path (the zero-compose contract).
//
// The composite stamp is CLI-owned (sha256 over the CLI version, cache-dir
// path, explicit port-or-sentinel, extracted config.json and compose bytes),
// stamped as a compose label at container creation — deliberately NOT
// Compose's internal config-hash, which is unstable across Compose versions
// (docker/compose#14001, available-image-digest embedding #9211): field
// compares (mount source, explicit port) are the primary vectors, the stamp
// catches same-path content edits.
// ──────────────────────────────────────────────

const (
	// codeflowSpecLabel is the compose label carrying the CLI-owned spec
	// stamp on the codeflow container; codeflowSpecEnv is the compose env
	// var interpolated into it.
	codeflowSpecLabel = "com.cheaseepi.codeflow-spec"
	codeflowSpecEnv   = "CHEASEEPI_CODEFLOW_SPEC"

	// codeflowConfigJSON is the sidecar config file inside the cache dir,
	// bind-mounted read-only into the container; codeflowConfigMountDest is
	// its in-container path (docker-compose.yml).
	codeflowConfigJSON     = "codeflow/config.json"
	codeflowConfigMountDest = "/opt/codeflow/config.json"

	// codeflowSpecSentinel replaces the derived/probed port in the stamp —
	// a derived port is runtime allocation, not configuration.
	codeflowSpecSentinel = "derived"
)

// codeflowRecoveryHint is the exact recovery command pair printed with every
// drift warning — the issue's preferred warn-don't-act contract.
const codeflowRecoveryHint = "apply with `cheasee-pi start --build` or `cheasee-pi down` + `cheasee-pi start`"

// codeflowSpecHash hashes the CLI-owned inputs that define the sidecar's
// expected configuration: the CLI version (cache-dir key), the absolute
// cache-dir path (a newer CLI extracts a new dir → new config.json mount
// source), the explicit port or the derived sentinel, and the extracted
// codeflow/config.json + docker-compose.yml bytes. Missing files → no stamp,
// no error (pre-extraction fixtures); any non-NotExist read error surfaces —
// a silent stamp change would read as drift on every start.
func codeflowSpecHash(root, composeDir string) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "cli=%s\n", cliVersion())
	fmt.Fprintf(h, "cache=%s\n", filepath.Clean(composeDir))
	if port := explicitCodeflowPort(root); port != "" {
		fmt.Fprintf(h, "port=%s\n", port)
	} else {
		fmt.Fprintf(h, "port=%s\n", codeflowSpecSentinel)
	}
	for _, rel := range []string{codeflowConfigJSON, "docker-compose.yml"} {
		data, err := os.ReadFile(filepath.Join(composeDir, rel))
		if err != nil {
			if os.IsNotExist(err) {
				return "", nil
			}
			return "", fmt.Errorf("read %s: %w", rel, err)
		}
		fmt.Fprintf(h, "%s=%s\n", rel, data)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// codeflowLiveSpec is the slice of `docker inspect --format '{{json .}}'`
// output the drift check reads: labels, bind-mount sources, published host
// port and run state.
type codeflowLiveSpec struct {
	// Missing marks a "No such object" inspect result — the sidecar does
	// not exist (a distinct drift condition, not a parse failure).
	Missing bool `json:"-"`
	Config  struct {
		Labels map[string]string
	}
	HostConfig struct {
		PortBindings map[string][]struct{ HostPort string }
	}
	Mounts []struct {
		Source      string
		Destination string
	}
	State struct {
		Running bool
	}
}

// inspectCodeflowSpec reads the live sidecar spec via one `docker inspect
// --format '{{json .}}' codeflow-<slug>` and parses it Go-side — read-only,
// preserving the zero-compose contract on the running path. A "No such
// object" result is reported as the Missing drift condition, not a failure.
func inspectCodeflowSpec(ctx context.Context, root string) (*codeflowLiveSpec, error) {
	name := codeflowContainerName(root)
	out, err := runCommandContext(ctx, "docker", "inspect", "--format", "{{json .}}", name).CombinedOutput()
	if err != nil {
		if bytes.Contains(bytes.ToLower(out), []byte("no such object")) {
			return &codeflowLiveSpec{Missing: true}, nil
		}
		return nil, fmt.Errorf("docker inspect %s: %w", name, err)
	}
	var spec codeflowLiveSpec
	if err := json.Unmarshal(out, &spec); err != nil {
		return nil, fmt.Errorf("parse docker inspect %s: %w", name, err)
	}
	return &spec, nil
}

// codeflowConfigMountSource returns the host source of the sidecar's
// config.json bind mount.
func codeflowConfigMountSource(spec *codeflowLiveSpec) (string, bool) {
	for _, m := range spec.Mounts {
		if filepath.Clean(m.Destination) == codeflowConfigMountDest {
			return m.Source, true
		}
	}
	return "", false
}

// codeflowBoundHostPort returns the host port published for the sidecar's
// 8470/tcp binding ("" when absent).
func codeflowBoundHostPort(spec *codeflowLiveSpec) string {
	bindings, ok := spec.HostConfig.PortBindings["8470/tcp"]
	if !ok || len(bindings) == 0 {
		return ""
	}
	return bindings[0].HostPort
}

// warnIfCodeflowDrift compares the live sidecar against the freshly resolved
// expected state and warns on stderr when they differ, naming the exact
// recovery command. Best-effort and advisory: any failure degrades to a
// non-fatal "could not verify" warning (an unverifiable check is itself a
// signal, never silent) — start always proceeds with the running container.
func warnIfCodeflowDrift(ctx context.Context, root, cacheDir string) {
	expected, err := codeflowSpecHash(root, cacheDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow sidecar: could not compute the expected configuration (%v) — cannot verify it is current; %s\n", err, codeflowRecoveryHint)
		return
	}
	live, err := inspectCodeflowSpec(ctx, root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow sidecar: could not verify it matches the current CLI configuration (%v) — %s\n", err, codeflowRecoveryHint)
		return
	}
	name := codeflowContainerName(root)
	if live.Missing {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow sidecar %s does not exist while the main container runs — %s\n", name, codeflowRecoveryHint)
		return
	}
	if !live.State.Running {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow sidecar %s is stopped while the main container runs — %s\n", name, codeflowRecoveryHint)
		return
	}

	var diffs []string

	// Version-keyed config.json bind source: a newer CLI extracts a new
	// cache dir, so a running sidecar keeps mounting the old config.
	expectedMount := filepath.Clean(filepath.Join(cacheDir, codeflowConfigJSON))
	liveMount, found := codeflowConfigMountSource(live)
	switch {
	case !found:
		diffs = append(diffs, fmt.Sprintf("config.json bind mount is missing (expected %s)", expectedMount))
	case filepath.Clean(liveMount) != expectedMount:
		diffs = append(diffs, fmt.Sprintf("config.json bind mount resolves to %s (expected %s)", liveMount, expectedMount))
	}

	// Explicit port mapping: compared only when the port is explicit
	// (settings docker.codeflowPort > env CODEFLOW_PORT). A derived port is
	// runtime allocation — the probe shifts on occupancy with no config
	// change, so comparing it against the live bind would false-positive.
	if port := explicitCodeflowPort(root); port != "" {
		if livePort := codeflowBoundHostPort(live); livePort != port {
			if livePort == "" {
				diffs = append(diffs, fmt.Sprintf("no host port published (expected %s)", port))
			} else {
				diffs = append(diffs, fmt.Sprintf("host port mapping is %s (expected %s)", livePort, port))
			}
		}
	}

	// Composite stamp: label compare. Pre-upgrade containers without the
	// label skip this — the field compares above still apply.
	if expected != "" {
		if liveHash := live.Config.Labels[codeflowSpecLabel]; liveHash != "" && liveHash != expected {
			diffs = append(diffs, "configuration stamp mismatch (codeflow/config.json content or CLI version changed since the container was created)")
		}
	}

	if len(diffs) > 0 {
		fmt.Fprintf(os.Stderr, "  ⚠ CodeFlow sidecar %s is stale: %s — %s\n", name, strings.Join(diffs, "; "), codeflowRecoveryHint)
	}
}