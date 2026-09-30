package main

import (
	"fmt"
	"os"
)

// printUIHint prints the web control-center URL on stderr. Single source of
// truth for both start branches (uiBoundPort / uiHostPort) so the wording
// cannot drift. The host literal is 127.0.0.1, never `localhost`: the compose
// mapping binds the *host* side to IPv4 loopback only, and on hosts where
// `localhost` resolves to ::1 first a `localhost` URL would not reach the
// published port.
func printUIHint(port string) {
	fmt.Fprintf(os.Stderr, "  ℹ UI: http://127.0.0.1:%s\n", port)
}
