#!/usr/bin/env bash
# scripts/net-bytes.sh
#
# Network-byte instrument for the cache-pruned build measurement of #2053.
# A Docker build's download volume can only be observed on the host that runs
# it, so the `docker` job in .github/workflows/tests.yml snapshots the NIC
# counters immediately before the cache-pruned build and diffs them right after
# it. The single labelled line it prints is what docs/development.md
# §End-to-end cache-pruned build records; the doc test asserts the label, so the
# recorded number stays traceable to the run that produced it.
#
# Loopback is excluded. The replay in scripts/measure-cold-build.sh counts its
# bytes at a local proxy over `lo`, so counting `lo` here would report the same
# transfer twice for a build the proxy observed.
#
# Usage:
#   scripts/net-bytes.sh snapshot [/proc/net/dev]   # "<rx> <tx>" totals, lo dropped
#   scripts/net-bytes.sh delta <before> <after>     # "build-cost wire rx=<n> B tx=<n> B"
#
# A counter that shrank (reboot, interface flap) is an error, not a zero delta:
# a silently truncated delta would read as a build that fetched nothing.

set -euo pipefail

label="build-cost wire"

die() { echo "net-bytes: $*" >&2; exit 1; }

# /proc/net/dev: "iface: rx_bytes rx_packets … | tx_bytes …" — field 2 is the
# interface name, rx_bytes is field 3 and tx_bytes is field 11.
totals() {
	[ -r "$1" ] || die "cannot read $1"
	# -s is not checked: /proc/net/dev reports size 0.
	awk -F '[:[:space:]]+' '
		$2 == "lo" { next }
		$2 ~ /^[a-zA-Z0-9_.-]+$/ && $3 ~ /^[0-9]+$/ { rx += $3; tx += $11; n++ }
		END {
			if (!n) { print "net-bytes: no interface counters in " FILENAME > "/dev/stderr"; exit 1 }
			printf "%.0f %.0f\n", rx, tx
		}
	' "$1"
}

# load_snapshot reads back what `snapshot` writes: one "<rx> <tx>" line, into
# snap_rx/snap_tx. delta diffs those files, so it must not re-parse them as
# /proc/net/dev — doing that rejected the CI job's own snapshots and left the
# end-to-end transfer uncaptured (#2053).
load_snapshot() {
	[ -r "$1" ] || die "cannot read $1"
	[ "$(awk 'END { print NR }' "$1")" = 1 ] || die "$1 is not a one-line byte snapshot"
	local rx tx rest
	read -r rx tx rest < "$1" || true
	case "$rx$tx" in '' | *[!0-9]*) die "$1 is not a byte snapshot: expected '<rx> <tx>'" ;; esac
	[ -z "$rest" ] || die "$1 is not a byte snapshot: expected '<rx> <tx>'"
	snap_rx=$rx
	snap_tx=$tx
}

case "${1:-}" in
	snapshot)
		totals "${2:-/proc/net/dev}"
		;;
	delta)
		[ $# -eq 3 ] || die "usage: net-bytes.sh delta <before> <after>"
		load_snapshot "$2"
		start_rx=$snap_rx start_tx=$snap_tx
		load_snapshot "$3"
		now_rx=$snap_rx now_tx=$snap_tx
		[ "$now_rx" -ge "$start_rx" ] || die "rx counter reset (${start_rx} -> ${now_rx}); re-run the measurement"
		[ "$now_tx" -ge "$start_tx" ] || die "tx counter reset (${start_tx} -> ${now_tx}); re-run the measurement"
		echo "$label rx=$((now_rx - start_rx)) B tx=$((now_tx - start_tx)) B"
		;;
	*)
		die "usage: net-bytes.sh snapshot [proc-net-dev] | delta <before> <after>"
		;;
esac
