package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
)

// ──────────────────────────────────────────────
// Credential isolation (issue #2076)
//
// The agent and ui containers no longer bind-mount the host's credential
// DIRECTORIES. Compose mounts exactly one file — auth.json — as a read-only
// file-backed secret at /run/secrets/cheasee_auth, plus the CLI hands Compose
// the ABSOLUTE host path (CHEASEEPI_AUTH_FILE) and a stat-identity stamp
// (CHEASEEPI_AUTH_SPEC) it also uses for drift detection.
//
// The host file stays the single source of truth. That single-file mount is
// pinned to the inode resolved at container creation, so a credential change is
// invisible to file-backed consumers until the container is recreated — the CLI
// owns a drift signal (auth_drift.go), and `cheasee-pi auth` remains the only
// writer.
// ──────────────────────────────────────────────

const (
	// authSpecLabel is the compose label carrying the CLI-owned credential
	// stamp on the agent + ui containers. authSpecEnv is the env var
	// interpolated into it.
	authSpecLabel = "com.cheaseepi.auth-spec"
	authSpecEnv   = "CHEASEEPI_AUTH_SPEC"

	// authFileEnv carries the CLI-resolved absolute path of the host
	// credential file, interpolated into `secrets.cheasee_auth.file`. The path
	// travels; the value never does.
	authFileEnv = "CHEASEEPI_AUTH_FILE"

	// authRecoveryHint is the exact command that re-creates the containers from
	// the current credentials — printed with every drift warning (the issue's
	// warn-don't-act contract: start never surprise-recreates).
	authRecoveryHint = "apply with `cheasee-pi start --build`"
)

// authSpec is the credential file's identity stamp: sha256 over device, inode,
// size + mtime_ns — deliberately NOT the content, so the stamp can be printed
// compared without putting a credential value near stdout, a compose label or
// container metadata.
//
// Why identity rather than content: `cheasee-pi auth` writes through
// atomicWrite (temp file, then rename), which replaces the inode. That is
// exactly the change a single-file bind mount cannot see, so it is what the
// stamp must flip on. An in-place truncate-write changes size or mtime_ns and
// flips it too. Accepted limit: two files with identical inode/size/mtime_ns
// stamp identically even when their bytes differ — reaching that requires
// deliberately preserving the timestamp, at which point no content-free signal
// exists.
//
// A missing file is an error, never ("", nil): an absent credential must not
// look like a stampable state.
func authSpec(path string) (string, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	fmt.Fprintf(h, "id=%s\nsize=%d\nmtime=%d\n", authFileIdentity(fi), fi.Size(), fi.ModTime().UnixNano())
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ensureAuthFile is the start gate: Compose builds the credential mount with
// CreateMountpoint:false, so a missing source file makes `docker compose up`
// fail with an opaque bind error (or silently mount nothing, depending on the
// Compose version). Fail closed FIRST, with the recovery command.
//
// Existence + readability only — parsing belongs to the readers
// (fileRepository, the ui's auth.rs, the entrypoint's jq), each reporting its
// own parse error. A zero-byte or malformed auth.json must not be reported here
// as "run cheasee-pi auth".
func ensureAuthFile(path string) error {
	fi, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no provider/GitHub credentials at %s — run `cheasee-pi auth add <provider>` (or `cheasee-pi init --reauth` for the GitHub token) on the host, then `cheasee-pi start` again", path)
		}
		return fmt.Errorf("cannot read credential file %s: %w — run `cheasee-pi auth add <provider>` to rewrite it, then `cheasee-pi start` again", path, err)
	}
	if fi.IsDir() {
		return fmt.Errorf("credential path %s is a directory, not the auth.json file — remove it, then run `cheasee-pi auth add <provider>`", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("credential file %s is not readable: %w — the container could not read it either; run `cheasee-pi auth add <provider>` to rewrite it, then `cheasee-pi start` again", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close credential file %s: %w", path, err)
	}
	return nil
}

// authComposeEnv returns the two compose-env entries the credential secret
// needs: the absolute host path (the `secrets.cheasee_auth.file` source) plus
// the identity stamp (the `auth-spec` label). Exactly one entry of each is
// always produced — an absent file yields an EMPTY stamp so the compose `:-`
// default leaves the label unset instead of failing the run; the start gate
// reports the missing file itself.
func authComposeEnv() []string {
	path, err := (&fileRepository{}).Path()
	if err != nil {
		// Loud, not silent: without a path Compose cannot mount the credential
		// at all. The empty entries keep the compose model valid, so the gate's
		// own error is the one the user sees.
		fmt.Fprintf(os.Stderr, "  ⚠ Auth credential path: %v\n", err)
		return []string{authFileEnv + "=", authSpecEnv + "="}
	}
	spec, err := authSpec(path)
	if err != nil {
		// A missing file is the normal pre-`cheasee-pi auth` state (the start
		// gate explains it); any other stat failure is surfaced here.
		if !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "  ⚠ Auth credential stamp: %v\n", err)
		}
		spec = ""
	}
	return []string{authFileEnv + "=" + path, authSpecEnv + "=" + spec}
}
