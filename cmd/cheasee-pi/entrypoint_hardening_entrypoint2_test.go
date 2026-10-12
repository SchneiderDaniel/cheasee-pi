package main

import (
	"fmt"
	"os"
	"testing"
)

func TestEntrypoint_RemapUidGid_NumericProceeds(t *testing.T) {
	binDir, marker := remapStubs(t)
	body := fmt.Sprintf(`
cd %s
unset HOST_UID HOST_GID
PATH=%s HOST_UID=1234 HOST_GID=1234 remap_uid_gid
grep -q -- "-u 1234" %s || { echo "usermod -u 1234 not recorded"; exit 1; }
grep -q -- "-g 1234" %s || { echo "usermod -g 1234 not recorded"; exit 1; }
grep -q "groupmod -g 1234" %s || { echo "groupmod -g 1234 not recorded"; exit 1; }
echo OK
`, shq(t.TempDir()), shq(binDir+":"+os.Getenv("PATH")), shq(marker), shq(marker), shq(marker))
	out, err := runBashScript(t, funcScript(t, "remap_uid_gid", body))
	assertOK(t, out, err, "remap_uid_gid(1234/1234)")
}
