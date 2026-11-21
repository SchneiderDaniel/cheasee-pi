package main

import (
	"os"
	"path/filepath"
	"testing"
)

// ──────────────────────────────────────────────
// Phase 6 harness: a temp PATH with stubbed jq/gosu/chown/gh
//
// The entrypoint's gh seed is verified by extracting the PRODUCTION function and
// executing it (entrypoint_ghseed_test.go), so the only things faked here are
// its external commands.
// ──────────────────────────────────────────────

// jqStub implements exactly the one production query the seed uses
// (`jq -r '.github_token // empty' FILE`), so the tests need no real jq.
const jqStub = `#!/bin/sh
file=""
for arg in "$@"; do file="$arg"; done
sed -n 's/.*"github_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1
`

// writeStubScript writes an executable /bin/sh stub.
func writeStubScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", name, err)
	}
	return path
}

// ghSeedHarness builds a temp PATH with jq/gosu/chown/gh stubs. ghExit is the
// gh exit status; the gh stub records its argv in the returned log and, for
// `auth login`, captures stdin in the returned file — the value the seed pipes
// must be exactly the credential.
func ghSeedHarness(t *testing.T, ghExit string) (binDir, logPath, stdinPath string) {
	t.Helper()
	binDir = t.TempDir()
	logPath = filepath.Join(t.TempDir(), "calls.log")
	stdinPath = filepath.Join(t.TempDir(), "gh.stdin")
	writeStubScript(t, binDir, "jq", jqStub)
	writeStubScript(t, binDir, "chown", "#!/bin/sh\necho \"chown $@\" >> '"+logPath+"'\nexit 0\n")
	writeStubScript(t, binDir, "gosu", "#!/bin/sh\necho \"gosu $@\" >> '"+logPath+"'\nshift\nexec \"$@\"\n")
	writeStubScript(t, binDir, "gh", "#!/bin/sh\necho \"gh $@\" >> '"+logPath+"'\n"+
		"case \"$2\" in login) cat > '"+stdinPath+"' ;; esac\n"+
		"exit "+ghExit+"\n")
	return binDir, logPath, stdinPath
}

// writeSecretFile writes an auth.json-shaped file into a temp dir.
func writeSecretFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cheasee_auth")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

// seedBody builds the extracted-function body: a stubbed PATH plus the env the
// compose secret and the GH_CONFIG_DIR seam provide.
func seedBody(binDir, authPath, configDir string) string {
	return "export PATH=" + shq(binDir) + ":$PATH\n" +
		"export CHEASEE_AUTH_PATH=" + shq(authPath) + "\n" +
		"export GH_CONFIG_DIR=" + shq(configDir) + "\n" +
		"seed_gh_config\n"
}

// readIfExists returns a file's content ("" when absent).
func readIfExists(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
