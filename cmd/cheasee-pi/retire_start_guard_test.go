package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SchneiderDaniel/cheasee-pi/cmd/cheasee-pi/testutil"
	"github.com/spf13/cobra"
)

// The start-flow half of the no-follow contract: a normal `start` on a workspace
// whose checkout sits behind a symlinked parent must fail instead of deleting a
// directory outside the mount.

// TestRunUpE_retireSymlinkedParentAbortsStart is the reported scenario in
// miniature: `start` runs the migration, the owner directory above the checkout is
// a link to an external checkout, and the start must refuse before compose — with
// the external directory intact.
func TestRunUpE_retireSymlinkedParentAbortsStart(t *testing.T) {
	root := staleWorkspaceWith(t, stalePackageObject, `"`+keptSkillRepo+`"`)
	ownerDir := filepath.Join(root, cloneOwnerRel)
	if err := os.RemoveAll(ownerDir); err != nil {
		t.Fatalf("clear owner dir: %v", err)
	}
	target := seedExternalCheckout(t, "ponytail")
	if err := os.Symlink(target, ownerDir); err != nil {
		t.Fatalf("symlink owner dir: %v", err)
	}
	setUpRunMode(t, root, false)
	stubExecPIContainer(t)
	c := stubUpFlow(t, root, false)
	piBefore := readBytes(t, piSettingsFile(root))

	stderr := testutil.CaptureStderr(t, func() {
		if err := runUpE(&cobra.Command{}, nil); err == nil {
			t.Fatal("an unsafe checkout path must abort the start")
		} else if !strings.Contains(err.Error(), cloneOwnerRel) {
			t.Errorf("error must name the refused component, got %v", err)
		}
	})

	if len(c.composeArgs) != 0 {
		t.Errorf("the refusal must abort before compose, got %d: %v", len(c.composeArgs), c.composeArgs)
	}
	assertStillSymlink(t, ownerDir)
	assertExternalCheckoutIntact(t, target, "ponytail")
	assertBytesUnchanged(t, piSettingsFile(root), piBefore)
	if strings.Contains(stderr, "Removed") {
		t.Errorf("a refused start must not report a removal, got: %q", stderr)
	}
}
