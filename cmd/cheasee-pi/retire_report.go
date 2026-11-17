package main

import (
	"fmt"
	"os"
)

// Presentation half of the retirement: the report a converged workspace keeps
// silent and a dry run prints in the indicative.

// appendStringUnique appends value unless it is already listed, so a report
// names a removed source once even when both settings files carried it.
func appendStringUnique(list []string, value string) []string {
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}

// printRetireReport renders one run to stderr. A converged workspace prints
// nothing, so a normal start stays silent; a dry run says what it would do
// instead of what it did.
func printRetireReport(rep retireReport, dryRun bool) {
	verb, marker := "Removed", "✓"
	if dryRun {
		verb, marker = "Would remove", "ℹ"
	}
	for _, source := range rep.Removed {
		fmt.Fprintf(os.Stderr, "  %s %s retired package %s\n", marker, verb, source)
	}
	for _, clone := range rep.CloneRemoved {
		fmt.Fprintf(os.Stderr, "  %s %s clone %s\n", marker, verb, clone)
	}
	if dryRun && len(rep.Removed) == 0 && len(rep.CloneRemoved) == 0 && len(rep.NeedsConfirmation) == 0 {
		fmt.Fprintf(os.Stderr, "  ℹ Nothing to migrate\n")
	}
}
