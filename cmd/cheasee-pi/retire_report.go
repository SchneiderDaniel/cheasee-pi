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

// announceRetirePlan turns a plan into the report a caller prints, plus the
// warning every entry the plan left for explicit confirmation deserves. That
// warning is the audit trail: the operator has to learn the entry survived, and
// with which command to finish the job.
func announceRetirePlan(plan retirePlan) retireReport {
	var rep retireReport
	for _, entry := range plan.NeedsConfirm {
		rep.NeedsConfirmation = appendStringUnique(rep.NeedsConfirmation, entry.Source)
		fmt.Fprintf(os.Stderr, "  ⚠ %s is still registered and cannot be proven a harness leftover — run `%s` to remove it, or delete it yourself if you installed it.\n",
			entry.Source, confirmHint)
	}
	for _, entry := range plan.Auto {
		rep.Removed = appendStringUnique(rep.Removed, entry.Source)
	}
	return rep
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
