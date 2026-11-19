package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// ──────────────────────────────────────────────
// Credential drift detection (issue #2076)
//
// `cheasee-pi start` skips `docker compose up` entirely when the whole stack is
// already up (zero-compose on the running path), yet the credential secret is a
// single-file bind mount pinned to the inode resolved at container creation. So
// a credential change made after the container was created is invisible to the
// file-backed readers (the ui child env, the gh tmpfs seed, the supervisor's
// auth.json fallback) until the container is recreated.
//
// warnIfAuthDrift compares the LIVE container's CLI-owned stamp against a
// freshly computed one via one read-only `docker inspect` — never compose, never
// a recreate — and names the recovery command. Advisory only: an unverifiable
// check degrades to a visible warning, never a start failure.
// ──────────────────────────────────────────────

// authLiveSpec is the slice of `docker inspect --format '{{json .}}'` output the
// credential drift check reads.
type authLiveSpec struct {
	// Missing marks a "No such object" inspect result — the container does not
	// exist (a distinct condition, not a parse failure).
	Missing bool `json:"-"`
	Config  struct {
		Labels map[string]string
	}
}

// inspectAuthLive reads the live agent container's labels via one read-only
// `docker inspect`. A "No such object" result is reported as the Missing
// condition, never as a failure. No compose invocation — the running path keeps
// its zero-compose contract.
func inspectAuthLive(ctx context.Context, root string) (*authLiveSpec, error) {
	name := containerName(root)
	out, err := runCommandContext(ctx, "docker", "inspect", "--format", "{{json .}}", name).CombinedOutput()
	if err != nil {
		if bytes.Contains(bytes.ToLower(out), []byte("no such object")) {
			return &authLiveSpec{Missing: true}, nil
		}
		return nil, fmt.Errorf("docker inspect %s: %w", name, err)
	}
	var spec authLiveSpec
	if err := json.Unmarshal(out, &spec); err != nil {
		return nil, fmt.Errorf("parse docker inspect %s: %w", name, err)
	}
	return &spec, nil
}

// currentAuthSpec stamps the host credential file the CLI resolves, returning a
// descriptive error (never an empty stamp) when the path or file is unusable.
func currentAuthSpec() (string, error) {
	path, err := (&fileRepository{}).Path()
	if err != nil {
		return "", fmt.Errorf("resolve auth.json path: %w", err)
	}
	spec, err := authSpec(path)
	if err != nil {
		return "", fmt.Errorf("stamp %s: %w", path, err)
	}
	return spec, nil
}

// warnIfAuthDrift compares the running container's credential stamp against a
// freshly computed one and warns on stderr with the recovery command when they
// differ. Best-effort: any failure degrades to a non-fatal "could not verify"
// warning (an unverifiable check is itself a signal, never silent). A missing
// label is the pre-change container — its credential directories are still
// bind-mounted read-write, which is exactly what this feature removes.
func warnIfAuthDrift(ctx context.Context, root string) {
	name := containerName(root)
	expected, err := currentAuthSpec()
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ Credentials: could not verify %s reads your current auth.json (%v) — %s\n", name, err, authRecoveryHint)
		return
	}
	live, err := inspectAuthLive(ctx, root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  ⚠ Credentials: could not verify %s reads your current auth.json (%v) — %s\n", name, err, authRecoveryHint)
		return
	}
	if live.Missing {
		fmt.Fprintf(os.Stderr, "  ⚠ Credentials: container %s does not exist while pi runs — %s\n", name, authRecoveryHint)
		return
	}
	// No running-state gate: the stamp is a creation-time label, readable on a
	// stopped container too — and a stopped container is exactly the one a start
	// reuses as-is, so its stale mount policy matters most (issue #2076 audit).
	stamp := live.Config.Labels[authSpecLabel]
	if stamp == "" {
		fmt.Fprintf(os.Stderr, "  ⚠ Credentials: %s predates the read-only credential mount (its host config dirs are still writable mounts) — %s\n", name, authRecoveryHint)
		return
	}
	if stamp != expected {
		fmt.Fprintf(os.Stderr, "  ⚠ Credentials: %s was created from an older auth.json than the one on this host, so gh, the UI child env and the supervisor read stale credentials — %s\n", name, authRecoveryHint)
	}
}
