package main

import (
	"fmt"
	"os"
)

// printCodeFlowHint prints the CodeFlow URL plus a one-line description of
// what the service is, on stderr. Single source of truth for both start
// branches (codeflowBoundPort / codeflowHostPort) so the wording cannot
// drift. The URL line is byte-identical to the historic print; the trailer
// is the always-on npm-fund-style annotation (no disable switch exists today).
func printCodeFlowHint(port string) {
	fmt.Fprintf(os.Stderr, "  ℹ CodeFlow: http://localhost:%s/?repo=local/workspace&run=1\n", port)
	fmt.Fprintf(os.Stderr, "  ℹ Optional browser sidecar — see docs/daily-usage.md §CodeFlow\n")
}
