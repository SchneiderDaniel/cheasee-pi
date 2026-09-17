package main

import (
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// start --name must not advertise a literal `cheasee-pi` default: the real
// container name is derived (cheasee-pi-<slug>) unless the flag is set. The
// `cheasee-pi` in docker-compose.yml is the compose project-name fallback,
// not the container name.
func TestStartNameFlag_helpHidesMisleadingDefault(t *testing.T) {
	out, err := testutil.RunCobra(t, rootCmd, "start", "--help")
	if err != nil {
		t.Fatalf("start --help: %v", err)
	}
	if strings.Contains(out, `(default "cheasee-pi")`) {
		t.Errorf("start --help must not render the misleading pflag default, got:\n%s", out)
	}
	if !strings.Contains(out, "--name") {
		t.Errorf("start --help must still document --name, got:\n%s", out)
	}
	// After the fix the free-text description is the ONLY default information;
	// cobra does not parse it, so it must be self-contained.
	if !strings.Contains(out, "derived") || !strings.Contains(out, "cheasee-pi-<slug>") {
		t.Errorf("--name description must carry the derived default, got:\n%s", out)
	}
}

func TestStartNameFlag_zeroDefaultAndChangedSemantics(t *testing.T) {
	// DefValue on the real registration is read-only; assert the mechanism —
	// pflag suppresses the (default ...) suffix only for zero-value defaults.
	if got := upCmd.Flags().Lookup("name").DefValue; got != "" {
		t.Errorf(`--name DefValue = %q, want "" (pflag suppresses the suffix only for zero defaults)`, got)
	}
	// Changed-boundary semantics on a FRESH command: pflag marks Changed on any
	// Set, including the empty string, so `--name ""` still skips derivation
	// exactly as it does today. A fresh command keeps this hermetic — mutating
	// the shared global upCmd would make the suite order- and
	// repetition-dependent (go test -count=2).
	fresh := &cobra.Command{Use: "start"}
	var freshName string
	fresh.Flags().StringVar(&freshName, "name", "", "Container name override")
	if fresh.Flags().Changed("name") {
		t.Error("--name must start unset")
	}
	if err := fresh.Flags().Set("name", ""); err != nil {
		t.Fatalf("set --name: %v", err)
	}
	if !fresh.Flags().Changed("name") {
		t.Error("explicitly setting --name (even empty) must mark it Changed")
	}
}

// clean --name keeps its real semantic default (single-container scope target)
// and is deliberately out of scope for this fix.
func TestCleanNameFlag_scopeBoundaryUntouched(t *testing.T) {
	if got := cleanCmd.Flags().Lookup("name").DefValue; got != "cheasee-pi" {
		t.Errorf(`clean --name DefValue = %q, want "cheasee-pi"`, got)
	}
	out, err := testutil.RunCobra(t, rootCmd, "clean", "--help")
	if err != nil {
		t.Fatalf("clean --help: %v", err)
	}
	if !strings.Contains(out, `(default "cheasee-pi")`) {
		t.Errorf("clean --help must keep its real default, got:\n%s", out)
	}
}
